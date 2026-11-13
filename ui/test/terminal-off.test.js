// Terminal off by default (PRD AIOS-61 v2.0 S6, AC 5): Agent Terminals hidden and its API refused; Settings switches it
// on with the change written to data/config.json, and the switch and the terminal sessions land in the audit log.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';

let dir, port, app, sid;
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const call = (method, p, body) => fetch(`http://127.0.0.1:${port}/api${p}`, {
  method,
  headers: { cookie: `artrios_s=${sid}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});
const auditEvents = () => fs.readFileSync(path.join(dir, 'data', 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).ev);

// A pty stand-in: enough for open and close.
const fakePty = { spawn: () => ({ pid: 1, onData() {}, onExit() {}, write() {}, resize() {}, kill() {} }) };

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'term-off-'));
  const ws = path.join(dir, 'ws');
  fs.mkdirSync(path.join(ws, '.artrios'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'projects.json'), JSON.stringify({ projects: [{ key: 'W', name: 'W', path: ws }] }));
  fs.writeFileSync(path.join(dir, 'data', 'config.json'), JSON.stringify({ port: 1, keep: 'me' }));
  port = await freePort();
  // No "terminal" key at all: the default must be off.
  app = createApp({ config: { terminalCommand: process.execPath }, dataDir: path.join(dir, 'data'), port, clientDir: null, ptyLib: fakePty });
  sid = app.auth.openSession();
  await new Promise((r) => app.server.listen(port, '127.0.0.1', r));
});
after(() => { app.close(); app.server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('AC5: by default status reports the terminal off and the terminal API answers 403', async () => {
  assert.equal((await (await call('GET', '/status')).json()).terminal, false);
  assert.equal((await (await call('GET', '/settings/general')).json()).terminal, false);
  const r = await call('GET', '/projects/W/terminals');
  assert.equal(r.status, 403);
  assert.match((await r.json()).error, /turned off/);
});

test('AC5: switched on from Settings the terminal works, the switch is saved and audited; off closes it again', async () => {
  assert.equal((await call('PUT', '/settings/general', { terminal: 'yes' })).status, 400);
  const on = await call('PUT', '/settings/general', { terminal: true });
  assert.equal(on.status, 200);
  assert.equal((await on.json()).terminal, true);
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'config.json'), 'utf8'));
  assert.equal(cfg.terminal, true);
  assert.equal(cfg.keep, 'me', 'other config keys stay');
  assert.equal((await call('GET', '/projects/W/terminals')).status, 200);
  const t = await (await call('POST', '/projects/W/terminals', {})).json();
  assert.match(t.id, /^t-/);
  assert.equal((await call('DELETE', `/projects/W/terminals/${t.id}`)).status, 200);
  assert.equal((await call('PUT', '/settings/general', { terminal: false })).status, 200);
  assert.equal((await call('GET', '/projects/W/terminals')).status, 403);
  assert.deepEqual(auditEvents(), ['terminal-enable', 'terminal-open', 'terminal-close', 'terminal-disable']);
});
