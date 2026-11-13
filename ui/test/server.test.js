import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApp } from '../server/app.js';

let TOKEN;
let port;
let dir;
let server;
let projA;

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

function req(method, url, { headers = {}, body, auth = true } = {}) {
  return new Promise((resolve, reject) => {
    const h = { host: `127.0.0.1:${port}`, ...(auth ? { cookie: `artrios_s=${TOKEN}` } : {}), ...headers };
    let payload;
    if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] ??= 'application/json'; }
    const r = http.request({ host: '127.0.0.1', port, method, path: url, headers: h }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, text: data, json });
      });
    });
    r.on('error', reject);
    r.end(payload);
  });
}

before(async () => {
  port = await freePort();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artrios-ui-'));
  projA = path.join(dir, 'proj-a');
  fs.mkdirSync(projA);
  fs.mkdirSync(path.join(dir, 'data'));
  fs.writeFileSync(path.join(dir, 'data', 'projects.json'), JSON.stringify({ projects: [
    { key: 'AAA', name: 'Alpha', hat: 'work', path: projA },
    { key: 'BBB', name: 'Beta', hat: 'self', path: path.join(dir, 'proj-b') },
  ] }));
  fs.mkdirSync(path.join(dir, 'notes', 'wiki'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'notes', 'wiki', 'b.md'), '# B isi');
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'rahasia');
  fs.writeFileSync(path.join(dir, 'hook.js'), "require('fs').appendFileSync(process.argv[2], 'x');");
  const app = createApp({ config: { inboxPreviewRoots: [path.join(dir, 'notes')], inboxOnDecide: [process.execPath, path.join(dir, 'hook.js'), path.join(dir, 'hook.out')] }, dataDir: path.join(dir, 'data'), port, clientDir: null });
  server = app.server;
  TOKEN = app.auth.openSession();
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
});

after(() => new Promise((r) => server.close(r)));

test('AC2: binds loopback only', () => {
  assert.equal(server.address().address, '127.0.0.1');
});

test('AC2: no session, wrong session, or a session id in the URL is 401 without content; bad host, foreign origin 403', async () => {
  for (const r of [
    await req('GET', '/api/projects', { auth: false }),
    await req('GET', '/api/projects', { auth: false, headers: { cookie: 'artrios_s=nope' } }),
    await req('GET', `/api/projects?t=${TOKEN}`, { auth: false }),
    await req('GET', '/api/inbox', { auth: false }),
    await req('POST', '/api/projects/AAA/cards', { auth: false, body: { title: 'x' } }),
  ]) {
    assert.equal(r.status, 401);
    assert.deepEqual(Object.keys(r.json), ['error', 'code']);
  }
  assert.equal((await req('GET', '/api/projects', { headers: { host: 'evil.example' } })).status, 403);
  assert.equal((await req('GET', '/api/projects', { headers: { host: `127.0.0.1.evil.example:${port}` } })).status, 403);
  assert.equal((await req('GET', '/api/projects', { headers: { origin: 'http://evil.example' } })).status, 403);
  assert.equal((await req('GET', '/api/projects', { headers: { origin: `http://127.0.0.1:${port}` } })).status, 200);
  assert.equal((await req('GET', '/api/projects', { headers: { origin: 'null' } })).status, 403);
});

test('AC2: without a session every page is the sign-in page (401), never the app; ?t= opens nothing', async () => {
  for (const p of ['/', `/?t=${TOKEN}`, '/assets/index.js', '/cognition']) {
    const r = await req('GET', p, { auth: false });
    assert.equal(r.status, 401, p);
    assert.match(r.text, /Sign in/);
    assert.doesNotMatch(r.text, /Client not built/);
    assert.equal(r.headers['set-cookie'], undefined);
  }
});

test('AC2: WebSocket upgrade without a valid session or with a foreign origin is refused', async () => {
  const attempt = (headers) => new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => {
      const h = { Host: `127.0.0.1:${port}`, Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13', ...headers };
      s.write(`GET /ws HTTP/1.1\r\n${Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
    });
    let data = '';
    s.on('data', (d) => { data += d; if (data.includes('\r\n\r\n')) s.destroy(); });
    s.on('close', () => resolve(data));
  });
  assert.match(await attempt({}), /^HTTP\/1.1 401/);
  assert.match(await attempt({ Cookie: 'artrios_s=wrong' }), /^HTTP\/1.1 401/);
  assert.match(await attempt({ Cookie: `artrios_s=${TOKEN}`, Origin: 'http://evil.example' }), /^HTTP\/1.1 403/);
  assert.match(await attempt({ Cookie: `artrios_s=${TOKEN}` }), /^HTTP\/1.1 101/);
});

test('static: fallback page served, path traversal impossible', async () => {
  const r = await req('GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.text, /Client not built yet/);
  const t = await req('GET', '/..%2f..%2fpackage.json');
  assert.ok(![200].includes(t.status) || /Client not built/.test(t.text));
});

test('AC3 + AC 30b: project list has client (legacy hat mapped) and per-column counts', async () => {
  const r = await req('GET', '/api/projects');
  assert.equal(r.status, 200);
  const [a, b] = r.json.projects;
  assert.deepEqual([a.key, a.client, b.key, b.client], ['AAA', 'work', 'BBB', '']);
  assert.equal(a.counts.backlog, 0);
  assert.equal(Object.keys(a.counts).length, 9);
});

test('cards: create, list, patch, move, note via API, with project key forced from the URL', async () => {
  const c = await req('POST', '/api/projects/AAA/cards', { body: { title: 'first', project: 'EVIL', priority: 'high' } });
  assert.equal(c.status, 201);
  assert.equal(c.json.key, 'AAA-1');
  assert.equal(c.json.client, 'work');
  assert.equal('hat' in c.json, false);
  assert.equal((await req('PATCH', '/api/projects/AAA/cards/AAA-1', { body: { title: 'renamed', due: '2026-11-07' } })).json.title, 'renamed');
  assert.equal((await req('POST', '/api/projects/AAA/cards/AAA-1/move', { body: { status: 'todo' } })).json.status, 'todo');
  assert.match((await req('POST', '/api/projects/AAA/cards/AAA-1/note', { body: { text: 'hi' } })).json.body, /## Catatan\n- \d{4}-\d{2}-\d{2}: hi/);
  const list = await req('GET', '/api/projects/AAA/cards');
  assert.equal(list.json.cards.length, 1);
  const proj = (await req('GET', '/api/projects')).json.projects[0];
  assert.equal(proj.counts.todo, 1);
  assert.ok(fs.existsSync(path.join(projA, '.artrios', 'tasks', 'AAA', 'AAA-1.md')));
});

test('activity: every line has project, and the feed endpoint returns newest first', async () => {
  const lines = fs.readFileSync(path.join(projA, '.artrios', 'activity.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.length >= 4);
  assert.ok(lines.every((l) => l.project === 'AAA' && l.by === 'ui'));
  const feed = await req('GET', '/api/projects/AAA/activity');
  assert.equal(feed.json.events[0].type, 'card.updated');
  assert.equal(feed.json.events.at(-1).type, 'card.created');
});

test('errors: unknown project 404, bad input 400, wrong content-type 400, broken card 422 and untouched', async () => {
  assert.equal((await req('GET', '/api/projects/ZZZ/cards')).status, 404);
  assert.equal((await req('POST', '/api/projects/AAA/cards', { body: { title: '' } })).status, 400);
  assert.equal((await req('POST', '/api/projects/AAA/cards', { body: { title: 'x' }, headers: { 'content-type': 'text/plain' } })).status, 400);
  assert.equal((await req('GET', '/api/projects/AAA/cards/AAA-99')).status, 404);
  const bad = path.join(projA, '.artrios', 'tasks', 'AAA', 'AAA-7.md');
  fs.writeFileSync(bad, '---\nkey: AAA-7\n  broken: [\n---\n');
  const before = fs.readFileSync(bad, 'utf8');
  assert.equal((await req('PATCH', '/api/projects/AAA/cards/AAA-7', { body: { title: 'x' } })).status, 422);
  assert.equal(fs.readFileSync(bad, 'utf8'), before);
  const list = await req('GET', '/api/projects/AAA/cards');
  assert.equal(list.json.broken.length, 1);
  assert.equal((await req('GET', '/api/projects')).json.projects[0].broken, 1);
});

test('F6 API: plan writes nothing, apply needs the approved planId, new project shows in the list', async () => {
  const d = path.join(dir, 'added');
  fs.mkdirSync(d);
  const body = { path: d, mode: 'existing', hat: 'work', key: 'ADDD', name: 'Added' };
  const nop = await req('POST', '/api/projects/plan', { auth: false, body });
  assert.equal(nop.status, 401);
  const plan = await req('POST', '/api/projects/plan', { body });
  assert.equal(plan.status, 200);
  assert.equal(fs.existsSync(path.join(d, '.artrios')), false);
  assert.ok(plan.json.planId);
  const wrong = await req('POST', '/api/projects', { body: { ...body, planId: 'nope' } });
  assert.equal(wrong.status, 409);
  const bad = await req('POST', '/api/projects/plan', { body: { ...body, key: 'x' } });
  assert.equal(bad.status, 400);
  const ok = await req('POST', '/api/projects', { body: { ...body, planId: plan.json.planId } });
  assert.equal(ok.status, 201);
  const list = await req('GET', '/api/projects');
  assert.ok(list.json.projects.some((p) => p.key === 'ADDD'));
});

test('AIOS-94: inbox API creates, lists, decides once, and rejects bad input', async () => {
  const c = await req('POST', '/api/inbox', { body: { kind: 'putusan', from: 'claude', question: 'Terapkan draft X?', options: ['ok', 'revisi', 'hapus'], links: ['brainstorms/x.md'] } });
  assert.equal(c.status, 201);
  const id = c.json.id;
  let l = await req('GET', '/api/inbox?status=pending');
  assert.equal(l.json.pending, 1);
  assert.equal(l.json.items[0].id, id);
  assert.equal((await req('POST', `/api/inbox/${id}/decide`, { body: { decision: 'nope' } })).status, 400);
  const d = await req('POST', `/api/inbox/${id}/decide`, { body: { decision: 'ok' } });
  assert.equal(d.status, 200);
  assert.equal(d.json.by, 'administrator');
  assert.equal((await req('POST', `/api/inbox/${id}/decide`, { body: { decision: 'ok' } })).status, 409);
  l = await req('GET', '/api/inbox?status=pending');
  assert.equal(l.json.pending, 0);
  assert.equal((await req('GET', `/api/inbox/${id}`)).json.status, 'decided');
  assert.equal((await req('GET', '/api/inbox', { auth: false })).status, 401);
  assert.equal((await req('POST', '/api/inbox', { body: { kind: 'putusan', from: 'claude', question: '', options: ['ok'] } })).status, 400);
});

test('AIOS-94: inbox items keep display meta; preview is refused without an allowed folder', async () => {
  const c = await req('POST', '/api/inbox', { body: { kind: 'putusan', from: 'skrip', question: 'q', options: ['ok'], links: ['wiki/a.md'], meta: { title: 'a.md', description: 'd', related: 'r', suggestion: 's' } } });
  assert.equal(c.status, 201);
  assert.equal((await req('GET', `/api/inbox/${c.json.id}`)).json.meta.suggestion, 's');
  assert.equal((await req('GET', `/api/inbox/${c.json.id}/preview`)).status, 404);
  assert.equal((await req('POST', '/api/inbox', { body: { kind: 'putusan', from: 'skrip', question: 'q', options: ['ok'], meta: { title: 5 } } })).status, 400);
});

test('AIOS-94: preview reads a file inside the allowed folder and refuses paths that leave it', async () => {
  const mk = (link) => req('POST', '/api/inbox', { body: { kind: 'putusan', from: 'skrip', question: 'q', options: ['ok'], links: [link] } });
  const ok = await mk('wiki/b.md');
  const p = await req('GET', `/api/inbox/${ok.json.id}/preview`);
  assert.equal(p.status, 200);
  assert.match(p.json.text, /isi/);
  const bad = await mk('../secret.txt');
  assert.equal((await req('GET', `/api/inbox/${bad.json.id}/preview`)).status, 404);
});

test('AIOS-94: the apply hook runs after a decision, and not after a refused one', async () => {
  // The hook is shared by every test in this file. Exactly one earlier decision succeeds (the "decides once" test),
  // and its hook run may still be starting on a busy machine: wait for that mark, then count only what this test adds.
  const out = path.join(dir, 'hook.out');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const marks = () => (fs.existsSync(out) ? fs.readFileSync(out, 'utf8').length : 0);
  const EARLIER = 1;
  for (let i = 0; i < 100 && marks() < EARLIER; i++) await sleep(100);
  const before = marks();
  assert.equal(before, EARLIER, 'the earlier decision ran the hook once');
  const c = await req('POST', '/api/inbox', { body: { kind: 'putusan', from: 'skrip', question: 'q', options: ['ok'] } });
  assert.equal((await req('POST', `/api/inbox/${c.json.id}/decide`, { body: { decision: 'bukan' } })).status, 400);
  await sleep(500);
  assert.equal(marks(), before, 'a refused decision must not run the hook');
  assert.equal((await req('POST', `/api/inbox/${c.json.id}/decide`, { body: { decision: 'ok' } })).status, 200);
  for (let i = 0; i < 100 && marks() === before; i++) await sleep(100);
  await sleep(300); // a second, unexpected run would show up here
  assert.equal(marks(), before + 1, 'one decision runs the hook exactly once');
});
