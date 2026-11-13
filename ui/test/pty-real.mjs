// Real node-pty smoke test (not part of `npm test`): must run in a real console window, see spike-a1-a2.md.
// Usage: node test/pty-real.mjs <result.json>   Uses cmd.exe as the terminal command, so it costs nothing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { WebSocket } from 'ws';
import { createApp } from '../server/app.js';

const out = { node: process.version, checks: [] };
const check = (name, ok, detail = '') => { out.checks.push({ name, ok: !!ok, detail: String(detail) }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
let TOKEN;

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artrios-ptyreal-'));
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(path.join(dir, 'data')); fs.mkdirSync(proj);
  fs.writeFileSync(path.join(dir, 'data', 'projects.json'), JSON.stringify({ projects: [{ key: 'PTY', name: 'Pty', hat: 'self', path: proj }] }));
  const port = await freePort();
  const app = createApp({ config: { terminalCommand: 'cmd.exe', maxTerminals: 12, terminal: true }, dataDir: path.join(dir, 'data'), port, clientDir: null });
  TOKEN = app.auth.openSession();
  await new Promise((r) => app.server.listen(port, '127.0.0.1', r));
  const call = async (method, url, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { cookie: `artrios_s=${TOKEN}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => null) };
  };

  // 12 real tabs, the 13th refused
  const tabs = [];
  for (let i = 0; i < 12; i++) { const r = await call('POST', '/api/projects/PTY/terminals', { cols: 100, rows: 30 }); if (r.status === 201) tabs.push(r.json); }
  check('12 tabs open', tabs.length === 12, tabs.length);
  const over = await call('POST', '/api/projects/PTY/terminals', {});
  check('13th tab refused with 429', over.status === 429 && /at most 12/.test(over.json?.error ?? ''), `${over.status} ${over.json?.error}`);
  check('12 distinct live pids', new Set(tabs.map((t) => t.pid)).size === 12 && tabs.every((t) => alive(t.pid)));

  // type into tab 1 and read the echo
  const ws = new WebSocket(`ws://127.0.0.1:${port}/term/${tabs[0].id}`, { headers: { cookie: `artrios_s=${TOKEN}` } });
  let text = '';
  ws.on('message', (m) => { const j = JSON.parse(m.toString()); if (j.type === 'replay' || j.type === 'output') text += j.data; });
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  await sleep(800);
  ws.send(JSON.stringify({ type: 'input', data: 'echo artrios-real-pty-ok\r' }));
  for (let i = 0; i < 40 && !/artrios-real-pty-ok\s*[\r\n]/.test(text.split('echo artrios-real-pty-ok').slice(1).join('')); i++) await sleep(150);
  check('typed command echoed back from a real pty', /artrios-real-pty-ok/.test(text.replace('echo artrios-real-pty-ok', '')), text.slice(-120));
  ws.send(JSON.stringify({ type: 'resize', cols: 140, rows: 40 }));
  await sleep(300);
  check('resize accepted without error', alive(tabs[0].pid));

  // reattach gets scrollback
  const ws2 = new WebSocket(`ws://127.0.0.1:${port}/term/${tabs[0].id}`, { headers: { cookie: `artrios_s=${TOKEN}` } });
  let replay = '';
  ws2.on('message', (m) => { const j = JSON.parse(m.toString()); if (j.type === 'replay') replay = j.data; });
  await new Promise((r, j) => { ws2.on('open', r); ws2.on('error', j); });
  await sleep(500);
  check('reattach replays scrollback', /artrios-real-pty-ok/.test(replay));
  ws.close(); ws2.close();

  // close one tab: its process dies, others live
  await call('DELETE', `/api/projects/PTY/terminals/${tabs[1].id}`);
  await sleep(1200);
  check('closing a tab ends its process', !alive(tabs[1].pid));
  check('other tabs unaffected', alive(tabs[2].pid));

  // close the server: no orphans
  const pids = tabs.map((t) => t.pid);
  app.close();
  await sleep(2500);
  check('server close leaves no orphan processes', pids.every((p) => !alive(p)), pids.filter(alive).join(','));
  app.server.closeAllConnections(); app.server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

const done = (code) => { fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 2)); process.exit(code); };
main().then(() => done(out.checks.every((c) => c.ok) ? 0 : 1)).catch((e) => { check('script error', false, e.stack); done(1); });
setTimeout(() => { check('timeout', false, '60s'); done(2); }, 60000);
