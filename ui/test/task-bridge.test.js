// Read-only task bridge (PRD AIOS-61 v2.1 S12 M1, AC 28): an outside task tool's tasks on the board, every write
// refused with the reason. The tool is a fake command printing a fixed JSON document.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApp } from '../server/app.js';
import { createTaskBridge, parseBridgeOutput } from '../server/task-bridge.js';
import { serializeCard } from '../server/card.js';

const DOC = {
  source: 'tracker',
  projects: [
    { key: 'WEB', name: 'Web', hat: 'work', client: 'Client A' },
    { key: 'ONLY', name: 'Tool only', hat: 'self', client: '' },
  ],
  tasks: [
    { key: 'WEB-1', project: 'WEB', title: 'Test card collides', status: 'done', cancelled: false, priority: 'none', due: '', parent: '', labels: [], created: '2026-11-01T09:00+07:00', updated: '2026-11-02T09:00+07:00', body: 'Old', notes: [], client: 'Client A', hat: 'work' },
    { key: 'WEB-2', project: 'WEB', title: 'Open task', status: 'in_progress', cancelled: false, priority: 'high', due: '2026-11-20', parent: 'WEB-1', labels: ['ai'], created: '2026-11-03T09:00+07:00', updated: '2026-11-04T09:00+07:00', body: 'Do it', notes: [{ date: '2026-11-05', text: 'started' }], client: 'Client A', hat: 'work' },
    { key: 'WEB-3', project: 'WEB', title: 'Dropped', status: 'done', cancelled: true, priority: 'low', due: '', parent: '', labels: [], created: '', updated: '', body: '', notes: [] },
    { key: 'ONLY-1', project: 'ONLY', title: 'Own task', status: 'backlog', cancelled: false, priority: 'none', due: '', parent: '', labels: [], created: '', updated: '', body: '', notes: [] },
    { key: 'bad', project: 'WEB', title: 'x', status: 'done' },
    { key: 'WEB-4', project: 'WEB', title: 'Odd', status: 'weird' },
  ],
};

test('parse: tasks become read-only cards, notes go under ## Catatan, bad rows are reported', () => {
  const s = parseBridgeOutput(JSON.stringify(DOC), 'Tracker');
  assert.equal(s.cards.size, 4);
  const c = s.cards.get('WEB-2');
  assert.equal(c.readOnly, true);
  assert.equal(c.bridge, 'Tracker');
  assert.equal(c.client, 'Client A');
  assert.equal(c.parent, 'WEB-1');
  assert.equal(c.body, 'Do it\n\n## Catatan\n- 2026-11-05: started\n');
  assert.equal(s.cards.get('WEB-3').cancelled, true);
  assert.deepEqual(s.bad.map((b) => b.file), ['Tracker:bad', 'Tracker:WEB-4']);
});

test('snapshot is cached, stale data is kept when the tool fails, and a refresh can be forced', async () => {
  let calls = 0;
  let fail = false;
  let t = 0;
  const b = createTaskBridge({
    config: { taskBridge: { command: ['x'], label: 'Tracker', ttlSeconds: 10 } },
    run: async () => { calls += 1; if (fail) throw new Error('down'); return JSON.stringify(DOC); },
    now: () => t,
  });
  assert.equal((await b.snapshot()).cards.size, 4);
  await b.snapshot();
  assert.equal(calls, 1, 'second read within ttl uses the cache');
  fail = true;
  t = 20000;
  assert.equal((await b.snapshot({ force: true })).cards.size, 4, 'failure keeps the old copy');
  assert.match(b.info().error, /down/);
  assert.equal(createTaskBridge({ config: {} }).enabled, false);
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artrios-bridge-'));
const dataDir = path.join(dir, 'data');
const proj = path.join(dir, 'web');
const tasksRoot = path.join(dir, 'tasks');
let port;
let app;
let TOKEN;

const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
function api(method, url, body) {
  return new Promise((resolve, reject) => {
    const h = { host: `127.0.0.1:${port}`, cookie: `artrios_s=${TOKEN}` };
    let payload;
    if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] = 'application/json'; }
    const r = http.request({ host: '127.0.0.1', port, method, path: url, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not json */ } resolve({ status: res.statusCode, json }); });
    });
    r.on('error', reject);
    r.end(payload);
  });
}

before(async () => {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(proj);
  fs.mkdirSync(path.join(tasksRoot, 'WEB'), { recursive: true });
  // A file card with a key the tool also owns (like the EPROG-1 test card): hidden and reported.
  fs.writeFileSync(path.join(tasksRoot, 'WEB', 'WEB-1.md'), serializeCard({ meta: { key: 'WEB-1', project: 'WEB', hat: 'work', kind: 'task', title: 'tes', status: 'backlog', cancelled: false, priority: 'none', due: '', parent: '', labels: [], created: '2026-11-05T10:00+07:00', updated: '2026-11-05T10:00+07:00', schema: 1 }, body: '' }));
  fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify({ projects: [{ key: 'WEB', name: 'Web', hat: 'work', path: proj }] }));
  const cfg = { tasksRoot, taskBridge: { command: ['x'], label: 'Tracker', writeHint: 'python scripts/tracker.py' } };
  const taskBridge = createTaskBridge({ config: cfg, run: async () => JSON.stringify(DOC) });
  port = await freePort();
  app = createApp({ config: cfg, dataDir, port, clientDir: null, taskBridge });
  TOKEN = app.auth.openSession();
  await new Promise((r) => app.server.listen(port, '127.0.0.1', r));
});

after(() => {
  app.close();
  app.server.closeAllConnections();
  app.server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('AC 28: bridged tasks show on the board; the colliding file card is hidden and reported', async () => {
  const list = await api('GET', '/api/projects');
  assert.equal(list.status, 200);
  const web = list.json.projects.find((p) => p.key === 'WEB');
  assert.equal(web.bridged, true);
  assert.equal(web.counts.done, 2);
  assert.equal(web.counts.in_progress, 1);
  assert.equal(web.counts.backlog, 0, 'the file card WEB-1 is not counted twice');
  const only = list.json.projects.find((p) => p.key === 'ONLY');
  assert.equal(only.bridgeOnly, true);
  assert.equal(only.counts.backlog, 1);
  assert.equal(list.json.bridge.label, 'Tracker');

  const cards = await api('GET', '/api/projects/WEB/cards');
  assert.deepEqual(cards.json.cards.map((c) => c.key), ['WEB-1', 'WEB-2', 'WEB-3']);
  assert.equal(cards.json.cards[0].title, 'Test card collides', 'the tool owns the key');
  assert.deepEqual(cards.json.bridge.conflicts, ['WEB-1']);
  assert.equal(cards.json.broken.length, 2);
  assert.equal((await api('GET', '/api/projects/WEB/cards/WEB-2')).json.readOnly, true);
});

test('AC 28: every write to a bridged card or project is refused with the reason, files untouched', async () => {
  const before = fs.readFileSync(path.join(tasksRoot, 'WEB', 'WEB-1.md'), 'utf8');
  const tries = [
    ['PATCH', '/api/projects/WEB/cards/WEB-2', { title: 'x' }],
    ['POST', '/api/projects/WEB/cards/WEB-2/move', { status: 'done' }],
    ['POST', '/api/projects/WEB/cards/WEB-2/note', { text: 'hi' }],
    ['POST', '/api/projects/WEB/cards/WEB-1/move', { status: 'done' }],
    ['POST', '/api/projects/WEB/cards', { title: 'new' }],
    ['POST', '/api/projects/WEB/jobs', { skill: 'gl', card: 'WEB-2' }],
    ['POST', '/api/projects/ONLY/cards', { title: 'new' }],
    ['POST', '/api/projects/ONLY/cards/ONLY-1/move', { status: 'done' }],
    ['GET', '/api/projects/ONLY/worktrees'],
  ];
  for (const [m, u, b] of tries) {
    const r = await api(m, u, b);
    assert.equal(r.status, 409, `${m} ${u}`);
    assert.equal(r.json.code, 'read_only');
    assert.match(r.json.error, /Tracker \(jembatan baca saja\)/);
  }
  assert.equal(fs.readFileSync(path.join(tasksRoot, 'WEB', 'WEB-1.md'), 'utf8'), before);
  assert.deepEqual(fs.readdirSync(path.join(tasksRoot, 'WEB')), ['WEB-1.md']);
  assert.ok(!fs.existsSync(path.join(tasksRoot, 'ONLY')));
  // A tool-only project still answers the board's other reads with empty lists.
  assert.deepEqual((await api('GET', '/api/projects/ONLY/activity')).json, { events: [] });
  assert.deepEqual((await api('GET', '/api/projects/ONLY/jobs')).json, { jobs: [] });
  assert.equal((await api('GET', '/api/projects/ONLY/cards')).json.cards[0].key, 'ONLY-1');
});
