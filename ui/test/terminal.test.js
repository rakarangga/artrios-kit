import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { WebSocket } from 'ws';
import { createApp } from '../server/app.js';
import { createTerminalManager, resolveCommand, TerminalError } from '../server/terminal.js';

let TOKEN;
let dir;
let proj;
let port;
let app;
const spawned = [];

// In-memory pty: echoes input as "got:<data>", records resize and kill. No native module, no console needed.
const fakePty = {
  spawn(file, args, opts) {
    let dataCb = () => {};
    let exitCb = () => {};
    const p = {
      file, args, opts, killed: false, sizes: [], written: [],
      onData: (cb) => { dataCb = cb; },
      onExit: (cb) => { exitCb = cb; },
      write(d) { p.written.push(d); dataCb(`got:${d}`); },
      resize(c, r) { p.sizes.push([c, r]); },
      kill() { if (p.killed) return; p.killed = true; exitCb({ exitCode: 0 }); },
      emit(d) { dataCb(d); },
      die(code) { p.killed = true; exitCb({ exitCode: code }); },
    };
    spawned.push(p);
    return p;
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await sleep(20);
  }
}
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

function api(method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const h = { host: `127.0.0.1:${port}`, cookie: `artrios_s=${TOKEN}`, ...headers };
    let payload;
    if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] = 'application/json'; }
    const r = http.request({ host: '127.0.0.1', port, method, path: url, headers: h }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { let json = null; try { json = JSON.parse(d); } catch { /* not json */ } resolve({ status: res.statusCode, json }); });
    });
    r.on('error', reject);
    r.end(payload);
  });
}

function openSocket(id, headers = { cookie: `artrios_s=${TOKEN}` }) {
  return new Promise((resolve, reject) => {
    const msgs = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/term/${id}`, { headers });
    ws.on('message', (m) => msgs.push(JSON.parse(m.toString())));
    ws.on('open', () => resolve({ ws, msgs }));
    ws.on('error', reject);
    ws.on('unexpected-response', (_req, res) => reject(Object.assign(new Error('rejected'), { status: res.statusCode })));
  });
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artrios-term-'));
  proj = path.join(dir, 'proj');
  fs.mkdirSync(path.join(dir, 'data'));
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(dir, 'data', 'projects.json'), JSON.stringify({ projects: [
    { key: 'TRM', name: 'Term', hat: 'self', path: proj },
    { key: 'TR2', name: 'Term two', hat: 'self', path: proj },
  ] }));
  port = await freePort();
  app = createApp({ config: { terminalCommand: process.execPath, terminalArgs: ['--fake'], maxTerminals: 3, terminal: true }, dataDir: path.join(dir, 'data'), port, clientDir: null, ptyLib: fakePty });
  TOKEN = app.auth.openSession();
  await new Promise((r) => app.server.listen(port, '127.0.0.1', r));
});

after(() => {
  app.close();
  app.server.closeAllConnections();
  app.server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('resolveCommand: absolute existing path is returned, unknown name gives null', () => {
  assert.equal(resolveCommand(process.execPath), process.execPath);
  assert.equal(resolveCommand('definitely-not-a-real-command-xyz'), null);
});

test('AC7: a tab opens the command in the project folder; two tabs are separate processes', async () => {
  const a = await api('POST', '/api/projects/TRM/terminals', { cols: 90, rows: 24 });
  const b = await api('POST', '/api/projects/TRM/terminals', {});
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.notEqual(a.json.id, b.json.id);
  assert.deepEqual([a.json.title, b.json.title], ['claude 1', 'claude 2']);
  const [pa, pb] = spawned.slice(-2);
  assert.equal(pa.opts.cwd, proj);
  assert.equal(pa.opts.cols, 90);
  assert.equal(pa.opts.rows, 24);
  assert.equal(pa.file, process.execPath);
  assert.notEqual(pa, pb);
  const sa = await openSocket(a.json.id);
  const sb = await openSocket(b.json.id);
  sa.ws.send(JSON.stringify({ type: 'input', data: 'hello-A' }));
  await waitFor(() => sa.msgs.some((m) => m.type === 'output' && m.data === 'got:hello-A'));
  assert.ok(!sb.msgs.some((m) => m.type === 'output' && m.data.includes('hello-A')), 'tab B does not see tab A input');
  assert.deepEqual(pa.written, ['hello-A']);
  assert.deepEqual(pb.written, []);
  sa.ws.close(); sb.ws.close();
  await api('DELETE', `/api/projects/TRM/terminals/${a.json.id}`);
  await api('DELETE', `/api/projects/TRM/terminals/${b.json.id}`);
});

test('AC7: closing a tab ends its process and frees the slot; the tab list reflects it', async () => {
  const t = (await api('POST', '/api/projects/TRM/terminals', {})).json;
  const p = spawned.at(-1);
  assert.equal(p.killed, false);
  const sock = await openSocket(t.id);
  const closed = await api('DELETE', `/api/projects/TRM/terminals/${t.id}`);
  assert.equal(closed.status, 200);
  assert.equal(p.killed, true);
  await waitFor(() => sock.msgs.some((m) => m.type === 'exit'));
  assert.equal((await api('GET', '/api/projects/TRM/terminals')).json.terminals.length, 0);
  assert.equal((await api('DELETE', `/api/projects/TRM/terminals/${t.id}`)).status, 404);
  sock.ws.close();
});

test('AC15: the fourth tab (limit 3 here) is refused with 429 and a clear message, not a system error', async () => {
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await api('POST', '/api/projects/TRM/terminals', {})).json.id);
  const over = await api('POST', '/api/projects/TR2/terminals', {});
  assert.equal(over.status, 429);
  assert.match(over.json.error, /at most 3 terminals/);
  assert.equal((await api('GET', '/api/projects/TRM/terminals')).json.max, 3);
  await api('DELETE', `/api/projects/TRM/terminals/${ids[0]}`);
  assert.equal((await api('POST', '/api/projects/TRM/terminals', {})).status, 201, 'a freed slot can be used again');
  app.terminals.closeAll();
  assert.equal(app.terminals.count(), 0);
});

test('parallel opens never step over the limit', async () => {
  const r = await Promise.all(Array.from({ length: 6 }, () => api('POST', '/api/projects/TRM/terminals', {})));
  assert.equal(r.filter((x) => x.status === 201).length, 3);
  assert.equal(r.filter((x) => x.status === 429).length, 3);
  app.terminals.closeAll();
});

test('reattach: a new socket gets the scrollback first, then live output; resize reaches the pty', async () => {
  const t = (await api('POST', '/api/projects/TRM/terminals', {})).json;
  const p = spawned.at(-1);
  p.emit('before-reload ');
  const s = await openSocket(t.id);
  await waitFor(() => s.msgs.some((m) => m.type === 'replay'));
  assert.equal(s.msgs[0].type, 'replay');
  assert.equal(s.msgs[0].data, 'before-reload ');
  p.emit('after');
  await waitFor(() => s.msgs.some((m) => m.type === 'output' && m.data === 'after'));
  s.ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
  await waitFor(() => p.sizes.length === 1);
  assert.deepEqual(p.sizes[0], [120, 40]);
  s.ws.send('not json');
  s.ws.send(JSON.stringify({ type: 'resize', cols: 'x', rows: 1 }));
  await sleep(100);
  assert.equal(p.sizes.length, 1, 'bad resize ignored, socket still alive');
  s.ws.close();
  app.terminals.closeAll();
});

test('a process that exits on its own tells the client and keeps the tab until it is closed', async () => {
  const t = (await api('POST', '/api/projects/TRM/terminals', {})).json;
  const p = spawned.at(-1);
  const s = await openSocket(t.id);
  p.die(7);
  await waitFor(() => s.msgs.some((m) => m.type === 'exit' && m.code === 7));
  const listed = (await api('GET', '/api/projects/TRM/terminals')).json.terminals;
  assert.equal(listed[0].alive, false);
  assert.equal(listed[0].exitCode, 7);
  const again = await openSocket(t.id);
  await waitFor(() => again.msgs.some((m) => m.type === 'exit'));
  s.ws.close(); again.ws.close();
  await api('DELETE', `/api/projects/TRM/terminals/${t.id}`);
});

test('AC2: terminal sockets and endpoints need the token and a local Origin; unknown terminal is 404', async () => {
  const t = (await api('POST', '/api/projects/TRM/terminals', {})).json;
  await assert.rejects(openSocket(t.id, {}), (e) => e.status === 401);
  await assert.rejects(openSocket(t.id, { cookie: `artrios_s=${TOKEN}`, origin: 'http://evil.example' }), (e) => e.status === 403);
  await assert.rejects(openSocket(t.id, { cookie: 'artrios_s=wrong' }), (e) => e.status === 401);
  await assert.rejects(openSocket('t-000000000000'), (e) => e.status === 404);
  assert.equal((await api('POST', '/api/projects/TRM/terminals', {}, { cookie: '' })).status, 401);
  assert.equal((await api('DELETE', `/api/projects/TRM/terminals/${t.id}`, undefined, { cookie: '' })).status, 401);
  assert.equal((await api('DELETE', `/api/projects/TR2/terminals/${t.id}`)).status, 404, 'a terminal cannot be closed through another project');
  const ok = await openSocket(t.id);
  ok.ws.close();
  await api('DELETE', `/api/projects/TRM/terminals/${t.id}`);
});

test('AC7: closing the server kills every terminal process (no orphans)', async () => {
  const mgr = createTerminalManager({ config: { terminalCommand: process.execPath }, ptyLib: fakePty });
  const project = { key: 'X', path: proj };
  await mgr.open(project);
  await mgr.open(project);
  const [p1, p2] = spawned.slice(-2);
  mgr.closeAll();
  assert.equal(p1.killed && p2.killed, true);
  assert.equal(mgr.count(), 0);
});

test('missing claude executable gives an actionable 503-type error, not a crash', async () => {
  const mgr = createTerminalManager({ config: { terminalCommand: 'no-such-claude-binary-xyz' }, ptyLib: fakePty });
  await assert.rejects(mgr.open({ key: 'X', path: proj }), (e) => e instanceof TerminalError && e.code === 'unavailable' && /terminalCommand/.test(e.message));
});

test('input guards: oversized input is rejected, unknown id is not_found', async () => {
  const mgr = createTerminalManager({ config: { terminalCommand: process.execPath }, ptyLib: fakePty });
  const t = await mgr.open({ key: 'X', path: proj });
  assert.throws(() => mgr.write(t.id, 'x'.repeat(70000)), (e) => e.code === 'invalid');
  assert.throws(() => mgr.write('t-nope', 'x'), (e) => e.code === 'not_found');
  mgr.closeAll();
});
