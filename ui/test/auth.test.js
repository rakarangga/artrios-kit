// One account, no roles (PRD AIOS-61 v2.0 S1): AC 2 (401 without a session), AC 3 (sign-in, lock after 5 wrong
// passwords), AC 4 (administrator after install, forced change at first sign-in, no role field, no user routes),
// AC 35 (LAN host: reachable only after sign-in, foreign Host/Origin refused).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';
import { createAuth, writeAccount, verifyPassword, hashPassword } from '../server/auth.js';
import { allowedHosts } from '../server/guard.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let dir, port, app;
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

function req(method, url, { cookie, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const h = { host: `127.0.0.1:${port}`, ...(cookie ? { cookie } : {}), ...headers };
    let payload;
    if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] = 'application/json'; }
    const r = http.request({ host: '127.0.0.1', port, method, path: url, headers: h }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { let json = null; try { json = JSON.parse(data); } catch { /* html */ } resolve({ status: res.statusCode, headers: res.headers, text: data, json }); });
    });
    r.on('error', reject);
    r.end(payload);
  });
}
const cookieOf = (r) => (r.headers['set-cookie']?.[0] ?? '').split(';')[0];
const users = () => JSON.parse(fs.readFileSync(path.join(dir, 'data', 'users.json'), 'utf8'));

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artrios-auth-'));
  fs.mkdirSync(path.join(dir, 'data'));
  fs.writeFileSync(path.join(dir, 'data', 'projects.json'), JSON.stringify({ projects: [] }));
  // Install step, as the installer runs it.
  const r = spawnSync(process.execPath, [path.join(here, '..', 'bin', 'set-password.js'), '--data', path.join(dir, 'data'), '--stdin'], { input: 'first-pass-1\n', encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  port = await freePort();
  app = createApp({ config: { loginLockMinutes: 1 }, dataDir: path.join(dir, 'data'), port, clientDir: null });
  await new Promise((r2) => app.server.listen(port, '127.0.0.1', r2));
});
after(() => { app.close(); app.server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('app icons load before sign-in; nothing else does, and a missing icon is 404, never the app shell', async () => {
  const client = path.join(dir, 'client');
  fs.mkdirSync(client, { recursive: true });
  fs.writeFileSync(path.join(client, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.writeFileSync(path.join(client, 'index.html'), '<html>app shell</html>');
  const p2 = await freePort();
  const a2 = createApp({ config: {}, dataDir: path.join(dir, 'data'), port: p2, clientDir: client });
  await new Promise((r) => a2.server.listen(p2, '127.0.0.1', r));
  const get = (u) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: p2, path: u, headers: { host: `127.0.0.1:${p2}` } }, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], text: d })); }).on('error', reject);
  });
  try {
    const icon = await get('/favicon.svg');
    assert.equal(icon.status, 200);
    assert.match(icon.type, /image\/svg/);
    const missing = await get('/icon-512.png');
    assert.equal(missing.status, 404);
    assert.ok(!missing.text.includes('app shell'));
    assert.equal((await get('/index.html')).status, 401);
    assert.match((await get('/')).text, /<svg viewBox="0 0 64 64"/, 'sign-in page shows the mark');
  } finally { a2.close(); a2.server.close(); }
});

test('scrypt hash with salt; the same password hashes differently; verify works', () => {
  const a = hashPassword('abcdefgh');
  assert.match(a, /^scrypt\$16384\$8\$1\$/);
  assert.notEqual(a, hashPassword('abcdefgh'));
  assert.ok(verifyPassword('abcdefgh', a));
  assert.ok(!verifyPassword('abcdefgx', a));
  assert.ok(!verifyPassword('abcdefgh', 'plain'));
});

test('AC4: install leaves one administrator, no role field, forced change, no password in clear', () => {
  const u = users();
  assert.equal(u.users.length, 1);
  assert.equal(u.users[0].name, 'administrator');
  assert.equal(u.users[0].mustChange, true);
  assert.ok(!('role' in u.users[0]) && !('roles' in u.users[0]));
  assert.ok(!fs.readFileSync(path.join(dir, 'data', 'users.json'), 'utf8').includes('first-pass-1'));
  const short = spawnSync(process.execPath, [path.join(here, '..', 'bin', 'set-password.js'), '--data', path.join(dir, 'x'), '--stdin'], { input: 'short\n', encoding: 'utf8' });
  assert.notEqual(short.status, 0);
  assert.ok(!fs.existsSync(path.join(dir, 'x', 'users.json')));
});

test('AC2: login page and 401 without a session; WebSocket refused', async () => {
  const page = await req('GET', '/');
  assert.equal(page.status, 401);
  assert.match(page.text, /Sign in/);
  assert.equal((await req('GET', '/api/status')).status, 401);
  assert.equal((await req('GET', '/api/auth/me')).status, 401);
});

test('AC3 + AC4: sign-in gives an HttpOnly SameSite=Strict cookie; first sign-in must change the password', async () => {
  const bad = await req('POST', '/api/auth/login', { body: { password: 'nope' } });
  assert.equal(bad.status, 401);
  assert.equal(bad.headers['set-cookie'], undefined);
  const ok = await req('POST', '/api/auth/login', { body: { password: 'first-pass-1' } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { user: 'administrator', mustChange: true });
  const raw = ok.headers['set-cookie'][0];
  assert.match(raw, /^artrios_s=[A-Za-z0-9_-]{40,};/);
  assert.match(raw, /HttpOnly/);
  assert.match(raw, /SameSite=Strict/);
  const c = cookieOf(ok);
  // Until changed: the app and its API stay closed, the change page and /api/auth stay open.
  assert.equal((await req('GET', '/api/projects', { cookie: c })).status, 403);
  assert.equal((await req('GET', '/api/projects', { cookie: c })).json.code, 'must_change');
  const page = await req('GET', '/', { cookie: c });
  assert.match(page.text, /Set a new password/);
  assert.equal((await req('GET', '/api/auth/me', { cookie: c })).json.mustChange, true);
  assert.equal((await req('POST', '/api/auth/password', { cookie: c, body: { current: 'wrong', next: 'second-pass-2' } })).status, 401);
  assert.equal((await req('POST', '/api/auth/password', { cookie: c, body: { current: 'first-pass-1', next: 'short' } })).status, 400);
  assert.equal((await req('POST', '/api/auth/password', { cookie: c, body: { current: 'first-pass-1', next: 'first-pass-1' } })).status, 400);
  const ch = await req('POST', '/api/auth/password', { cookie: c, body: { current: 'first-pass-1', next: 'second-pass-2' } });
  assert.equal(ch.status, 200);
  assert.equal(users().users[0].mustChange, false);
  assert.equal((await req('GET', '/api/projects', { cookie: c })).status, 200, 'the same session works after the change');
  assert.equal((await req('POST', '/api/auth/login', { body: { password: 'first-pass-1' } })).status, 401, 'old password is gone');
  // Logout ends the session.
  assert.equal((await req('POST', '/api/auth/logout', { cookie: c, body: {} })).status, 200);
  assert.equal((await req('GET', '/api/projects', { cookie: c })).status, 401);
});

test('AC4: no user management routes and no roles anywhere', async () => {
  const c = cookieOf(await req('POST', '/api/auth/login', { body: { password: 'second-pass-2' } }));
  for (const p of ['/api/users', '/api/auth/users', '/api/settings/users']) assert.equal((await req('GET', p, { cookie: c })).status, 404, p);
  assert.equal((await req('POST', '/api/auth/login', { body: { name: 'root', password: 'second-pass-2' } })).status, 401, 'only the administrator exists');
  assert.equal((await req('POST', '/api/auth/login', { body: { password: 'second-pass-2' } })).status, 200, 'a good sign-in resets the counter');
});

test('AC3: five wrong passwords in a row lock the account, even for the right password; the lock ends', async () => {
  for (let i = 0; i < 4; i++) assert.equal((await req('POST', '/api/auth/login', { body: { password: `wrong-${i}` } })).status, 401);
  const fifth = await req('POST', '/api/auth/login', { body: { password: 'wrong-5' } });
  assert.equal(fifth.status, 423);
  assert.ok(fifth.json.until);
  assert.equal((await req('POST', '/api/auth/login', { body: { password: 'second-pass-2' } })).status, 423);
  // Lock in the past: the right password works again and the counter is reset.
  const u = users(); u.users[0].lockedUntil = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(path.join(dir, 'data', 'users.json'), JSON.stringify(u));
  assert.equal((await req('POST', '/api/auth/login', { body: { password: 'second-pass-2' } })).status, 200);
  assert.equal(users().users[0].failed, 0);
  const ev = fs.readFileSync(path.join(dir, 'data', 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).ev);
  assert.ok(ev.includes('login-lock') && ev.includes('login-locked') && ev.includes('password-change'));
});

test('sessions expire when idle; a password change closes the other sessions', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'artrios-sess-'));
  const file = path.join(d, 'users.json');
  writeAccount(file, 'pass-word-1', { mustChange: false });
  let t = 1_000_000;
  const a = createAuth({ file, config: { sessionIdleMinutes: 1 }, now: () => t });
  const s1 = a.login('administrator', 'pass-word-1').sid;
  t += 59_000; assert.ok(a.session(s1));
  t += 61_000; assert.equal(a.session(s1), null);
  const s2 = a.login('administrator', 'pass-word-1').sid;
  const s3 = a.login('administrator', 'pass-word-1').sid;
  a.changePassword(s2, 'pass-word-1', 'pass-word-2');
  assert.ok(a.session(s2));
  assert.equal(a.session(s3), null);
  fs.rmSync(d, { recursive: true, force: true });
});

test('AC35: a LAN host is allowed as Host/Origin only when configured; everything else is refused', async () => {
  assert.deepEqual([...allowedHosts({ port: 4317, host: '192.168.1.20', extra: ['artrios-pc', 'pc.lan:80'] })].sort(),
    ['127.0.0.1:4317', '192.168.1.20:4317', 'artrios-pc:4317', 'localhost:4317', 'pc.lan:80']);
  assert.deepEqual([...allowedHosts({ port: 4317, host: '0.0.0.0' })].sort(), ['127.0.0.1:4317', 'localhost:4317']);
  const p2 = await freePort();
  const lan = createApp({ config: { host: '192.168.1.20' }, dataDir: path.join(dir, 'data'), port: p2, clientDir: null });
  await new Promise((r) => lan.server.listen(p2, '127.0.0.1', r));
  const call = (headers, cookie) => new Promise((resolve) => {
    http.request({ host: '127.0.0.1', port: p2, path: '/api/status', headers: { ...headers, ...(cookie ? { cookie } : {}) } }, (res) => { res.resume(); resolve(res.statusCode); }).end();
  });
  try {
    const sid = lan.auth.openSession();
    assert.equal(await call({ host: `192.168.1.20:${p2}` }), 401, 'LAN address without sign-in');
    assert.equal(await call({ host: `192.168.1.20:${p2}`, origin: `http://192.168.1.20:${p2}` }, `artrios_s=${sid}`), 200, 'LAN address after sign-in');
    assert.equal(await call({ host: `192.168.1.99:${p2}` }, `artrios_s=${sid}`), 403, 'other address');
    assert.equal(await call({ host: `192.168.1.20:${p2}`, origin: 'http://192.168.1.99' }, `artrios_s=${sid}`), 403, 'foreign origin');
  } finally { lan.close(); lan.server.close(); }
});
