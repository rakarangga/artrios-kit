import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';
import { createExtras } from '../server/extras.js';
import { parseIdeas } from '../server/ideation.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude.js');
let TOKEN;
let dir;
let proj;
let port;
let app;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 20 s: jobs spawn real processes, and a busy machine (another suite, a build) can make them slow; a hang still fails.
async function waitFor(fn, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await sleep(25);
  }
}
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const config = () => ({ claudePath: process.execPath, claudeBaseArgs: [FAKE], maxJobs: 2, jobTimeoutMs: 20000, skills: { ok: { allowedTools: ['Read'] } } });
const git = (...args) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { cwd: proj });

function api(method, url, body) {
  return new Promise((resolve, reject) => {
    const h = { host: `127.0.0.1:${port}`, cookie: `artrios_s=${TOKEN}` };
    let payload;
    if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] = 'application/json'; }
    const r = http.request({ host: '127.0.0.1', port, method, path: url, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch { /* not json */ }
        resolve({ status: res.statusCode, json, buf, type: res.headers['content-type'] });
      });
    });
    r.on('error', reject);
    r.end(payload);
  });
}
const P = '/api/projects/EXT';

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artrios-extras-'));
  proj = path.join(dir, 'proj');
  fs.mkdirSync(path.join(dir, 'data'));
  fs.mkdirSync(proj);
  execFileSync('git', ['init', '-q'], { cwd: proj });
  fs.writeFileSync(path.join(proj, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(proj, 'CLAUDE.md'), '# Rules\npassword=hunter2hunter2\n');
  fs.writeFileSync(path.join(proj, '.env'), 'SECRET=never-listed\n');
  fs.writeFileSync(path.join(proj, '.gitignore'), '.env\n.artrios\n');
  git('add', '.');
  git('commit', '-qm', 'first commit');
  fs.writeFileSync(path.join(dir, 'data', 'projects.json'), JSON.stringify({ projects: [{ key: 'EXT', name: 'Extras', hat: 'self', path: proj }] }));
  port = await freePort();
  app = createApp({ config: config(), dataDir: path.join(dir, 'data'), port, clientDir: null });
  TOKEN = app.auth.openSession();
  await new Promise((r) => app.server.listen(port, '127.0.0.1', r));
});

after(() => {
  app.close();
  app.server.closeAllConnections();
  app.server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('archive: a card can be archived and restored, and the archive is a status of its own', async () => {
  const c = (await api('POST', `${P}/cards`, { title: 'Old work', status: 'done' })).json;
  const m = await api('POST', `${P}/cards/${c.key}/move`, { status: 'archived' });
  assert.equal(m.status, 200);
  assert.equal(m.json.status, 'archived');
  assert.equal((await api('POST', `${P}/cards/${c.key}/move`, { status: 'done' })).json.status, 'done');
});

test('review: branch, changed files with counts, and recent commits', async () => {
  fs.appendFileSync(path.join(proj, 'a.txt'), 'two\nthree\n');
  fs.writeFileSync(path.join(proj, 'new.txt'), 'x');
  const r = (await api('GET', `${P}/review`)).json;
  assert.equal(r.git, true);
  assert.ok(r.branch.length > 0);
  const a = r.files.find((f) => f.path === 'a.txt');
  assert.equal(a.added, 2);
  assert.equal(a.deleted, 0);
  assert.ok(r.files.some((f) => f.path === 'new.txt' && f.code === '?'));
  assert.equal(r.totals.files, r.files.length);
  assert.equal(r.commits[0].subject, 'first commit');
  git('checkout', '--', 'a.txt');
  fs.rmSync(path.join(proj, 'new.txt'));
});

test('review: Artrios own state files under .artrios are not listed as changes', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'artrios-review-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: repo });
    fs.mkdirSync(path.join(repo, '.artrios'));
    fs.writeFileSync(path.join(repo, '.artrios', 'activity.jsonl'), '{}');
    fs.writeFileSync(path.join(repo, 'real.txt'), 'x');
    const r = await createExtras({}).review({ key: 'R', path: repo });
    assert.deepEqual(r.files.map((f) => f.path), ['real.txt']);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

// Fake launcher: emits no event, so openIn resolves after its ~1.5 s "still running" window.
const okChild = () => { const h = {}; return { once() {}, unref() {}, on: () => h }; };
test('open: VS Code and folder go through quoted spawn; unsafe paths and unknown targets are refused', async () => {
  const calls = [];
  const fakeSpawn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return okChild(); };
  const ex = createExtras({ spawn: fakeSpawn });
  const project = { key: 'X', path: proj };
  await ex.openIn(project, 'vscode');
  assert.ok(calls[0].cmd.includes(proj) || calls[0].args.includes(proj));
  await ex.openIn(project, 'folder');
  assert.equal(calls.length, 2);
  await assert.rejects(ex.openIn(project, 'rm'), (e) => e.code === 'invalid');
  await assert.rejects(ex.openIn({ key: 'X', path: path.join(dir, 'a&b') }, 'vscode'), (e) => e.code === 'invalid');
  await assert.rejects(ex.openIn({ key: 'X', path: path.join(dir, 'missing') }, 'folder'), (e) => e.code === 'not_found');
});

test('open: a launcher that fails is reported as unavailable, not as ok', async () => {
  const failing = () => { const h = {}; return { once(ev, fn) { h[ev] = fn; if (ev === 'error') setImmediate(() => fn(new Error('spawn code ENOENT'))); }, unref() {} }; };
  const ex = createExtras({ spawn: () => failing() });
  await assert.rejects(ex.openIn({ key: 'X', path: proj }, 'vscode'), (e) => e.code === 'unavailable' && /code/.test(e.message));
});

test('open: an unknown worktree path is refused before anything is spawned', async () => {
  const r = await api('POST', `${P}/open`, { target: 'folder', worktree: path.join(dir, 'elsewhere') });
  assert.equal(r.status, 404); // git-service.find: not a worktree of this project
  assert.match(r.json.error, /not a worktree/);
});

test('changelog: recent commits and finished cards', async () => {
  await api('POST', `${P}/cards`, { title: 'Shipped thing', status: 'done' });
  const r = (await api('GET', `${P}/changelog`)).json;
  assert.ok(r.commits.some((c) => c.subject === 'first commit'));
  assert.ok(r.done.some((c) => c.title === 'Shipped thing'));
});

test('context: only the fixed file list, secrets masked, .env never listed', async () => {
  const r = (await api('GET', `${P}/context`)).json;
  const names = r.files.map((f) => f.name);
  assert.ok(names.includes('CLAUDE.md'));
  assert.ok(!names.some((n) => n.includes('.env')));
  const claude = r.files.find((f) => f.name === 'CLAUDE.md');
  assert.ok(!claude.text.includes('hunter2'));
});

test('roadmap: template when missing, save and read back, oversize refused', async () => {
  const first = (await api('GET', `${P}/roadmap`)).json;
  assert.equal(first.exists, false);
  assert.match(first.text, /# Roadmap/);
  assert.equal((await api('PUT', `${P}/roadmap`, { text: '# Roadmap\n\n- [x] shipped' })).status, 200);
  const back = (await api('GET', `${P}/roadmap`)).json;
  assert.equal(back.exists, true);
  assert.match(back.text, /shipped/);
  assert.equal((await api('PUT', `${P}/roadmap`, { text: 'x'.repeat(200001) })).status, 400);
});

test('mcp: names, kind and host only; env and headers are never returned', async () => {
  fs.writeFileSync(path.join(proj, '.mcp.json'), JSON.stringify({ mcpServers: {
    local: { command: 'C:/tools/npx.cmd', args: ['-y', 'thing'], env: { TOKEN: 'ghp_abcdefghijklmnopqrstuvwx' } },
    remote: { type: 'http', url: 'https://mcp.example.com/path?key=secretkey', headers: { Authorization: 'Bearer abc' } },
  } }));
  const r = (await api('GET', `${P}/mcp`)).json;
  assert.equal(r.file, true);
  assert.deepEqual(r.servers.map((s) => [s.name, s.type, s.where]), [['local', 'stdio', 'npx.cmd'], ['remote', 'http', 'mcp.example.com']]);
  assert.ok(!JSON.stringify(r).includes('ghp_') && !JSON.stringify(r).includes('secretkey') && !JSON.stringify(r).includes('Bearer'));
  fs.rmSync(path.join(proj, '.mcp.json'));
});

test('worktrees: the main worktree is listed with its branch', async () => {
  const r = (await api('GET', `${P}/worktrees`)).json;
  assert.equal(r.git, true);
  assert.equal(r.worktrees.length, 1);
  assert.ok(r.worktrees[0].branch.length > 0);
  assert.equal(r.worktrees[0].changes, 0);
});

test('files: search tracked files, never ignored ones', async () => {
  const r = (await api('GET', `${P}/files?q=a.t`)).json;
  assert.ok(r.files.includes('a.txt'));
  const all = (await api('GET', `${P}/files`)).json.files;
  assert.ok(!all.includes('.env'));
});

test('attachments: png saved and served; other types, empty data and odd names are refused', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const saved = await api('POST', `${P}/attachments`, { type: 'image/png', data: png.toString('base64') });
  assert.equal(saved.status, 201);
  assert.match(saved.json.path, /^\.artrios\/attachments\/a-[a-z0-9]+-[0-9a-f]{6}\.png$/);
  const got = await api('GET', `${P}/attachments/${saved.json.name}`);
  assert.equal(got.status, 200);
  assert.equal(got.type, 'image/png');
  assert.deepEqual(got.buf, png);
  assert.equal((await api('POST', `${P}/attachments`, { type: 'text/html', data: 'PGI+' })).status, 400);
  assert.equal((await api('POST', `${P}/attachments`, { type: 'image/png', data: '' })).status, 400);
  assert.equal((await api('GET', `${P}/attachments/..%2F..%2Fx.png`)).status, 400);
});

test('status: reports the Claude Code version from the configured binary', async () => {
  const r = (await api('GET', '/api/status')).json;
  assert.equal(r.claude.ok, true);
  assert.match(r.claude.version, /9\.9\.9/);
});

test('jobs: a model can be chosen per run; a bad model name is refused', async () => {
  const d = path.join(proj, '.claude', 'skills', 'ok');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'SKILL.md'), '---\nname: ok\ndescription: t\n---\n\nSay hi $ARGUMENTS\n');
  const bad = await api('POST', `${P}/jobs`, { skill: 'ok', model: 'x; rm -rf' });
  assert.equal(bad.status, 400);
  const good = await api('POST', `${P}/jobs`, { skill: 'ok', args: 'a', model: 'sonnet' });
  assert.equal(good.status, 201);
  assert.equal(good.json.model, 'sonnet');
  await waitFor(() => app.jobs.activeCount() === 0);
});

test('ideation: parse tolerates prose and fences, drops empty titles, repairs bad category and effort', () => {
  const ideas = parseIdeas('Sure!\n```json\n[{"category":"nope","title":"A","effort":"huge"},{"title":""},{"category":"ui","title":"B"}]\n```');
  assert.deepEqual(ideas.map((i) => [i.title, i.category, i.effort]), [['A', 'code', 'small'], ['B', 'ui', 'small']]);
  assert.throws(() => parseIdeas('no list here'), (e) => e.code === 'invalid');
  assert.throws(() => parseIdeas('[not json]'), (e) => e.code === 'invalid');
});

test('ideation: generate, list, dismiss, convert to a card once, never twice', async () => {
  const g = await api('POST', `${P}/ideation/generate`, {});
  assert.equal(g.status, 200);
  assert.equal(g.json.added, 2);
  const list = (await api('GET', `${P}/ideation`)).json;
  assert.equal(list.running, false);
  assert.deepEqual(list.ideas.map((i) => i.title), ['Pin dependencies', 'Add tests']);
  const [first, second] = list.ideas;
  assert.equal((await api('PATCH', `${P}/ideation/${second.id}`, { status: 'dismissed' })).json.status, 'dismissed');
  const conv = await api('POST', `${P}/ideation/${first.id}/convert`);
  assert.equal(conv.status, 201);
  assert.equal(conv.json.card.status, 'backlog');
  assert.deepEqual(conv.json.card.labels, ['security']);
  assert.match(conv.json.card.body, /Rationale/);
  assert.equal((await api('POST', `${P}/ideation/${first.id}/convert`)).status, 409);
  assert.equal((await api('PATCH', `${P}/ideation/${first.id}`, { status: 'dismissed' })).status, 409);
  assert.equal((await api('POST', `${P}/ideation/generate`, { category: 'nonsense' })).status, 400);
  const again = (await api('POST', `${P}/ideation/generate`, { category: 'security' })).json;
  assert.equal(again.ideas.length, 4);
});
