// One account, no roles (PRD AIOS-61 v2.0 S1, AC 2-4): users.json holds the administrator's scrypt hash, sessions
// live in memory behind an HttpOnly SameSite=Strict cookie. Five wrong passwords in a row lock the account for a while.
// Restarting the server logs everyone out; that is on purpose (no session file to steal).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const USER = 'administrator';
export const COOKIE = 'artrios_s';
export const MIN_PASSWORD = 8;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export class AuthError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [kind, N, r, p, salt, hash] = String(stored ?? '').split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const got = crypto.scryptSync(String(password), Buffer.from(salt, 'base64'), want.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: 256 * 1024 * 1024 });
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function checkNew(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) throw new AuthError('invalid', `password must have at least ${MIN_PASSWORD} characters`);
  if (password.length > 200) throw new AuthError('invalid', 'password is too long');
}

function writePrivate(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* Windows: ACLs, not modes */ }
}

// Install step (bin/set-password.js): writes the one account. mustChange forces a new password at first login (AC 4).
export function writeAccount(file, password, { mustChange = true } = {}) {
  checkNew(password);
  const user = { name: USER, hash: hashPassword(password), mustChange, failed: 0, lockedUntil: null, changedAt: new Date().toISOString() };
  writePrivate(file, { schema: 1, users: [user] });
  return { name: USER, mustChange };
}

export function createAuth({ file, config = {}, audit = () => {}, now = () => Date.now() }) {
  const maxFailed = config.loginMaxFailed ?? 5;
  const lockMs = (config.loginLockMinutes ?? 15) * 60_000;
  const idleMs = (config.sessionIdleMinutes ?? 720) * 60_000;
  const maxMs = (config.sessionMaxHours ?? 168) * 3_600_000;
  const sessions = new Map(); // sid -> { user, created, seen }

  const exists = () => fs.existsSync(file);
  function read() {
    if (!exists()) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const user = (data.users ?? []).find((u) => u.name === USER);
    return user ? { data, user } : null;
  }
  function save(data) { writePrivate(file, data); }

  function openSession(user = USER) {
    const sid = crypto.randomBytes(32).toString('base64url');
    sessions.set(sid, { user, created: now(), seen: now() });
    return sid;
  }

  // The live session of a request, or null. Touching it keeps an active browser signed in.
  function session(sid) {
    if (!sid) return null;
    const s = sessions.get(sid);
    if (!s) return null;
    const t = now();
    if (t - s.seen > idleMs || t - s.created > maxMs) { sessions.delete(sid); return null; }
    s.seen = t;
    const acc = read();
    return { sid, user: s.user, mustChange: Boolean(acc?.user.mustChange) };
  }

  function login(name, password, meta = {}) {
    const acc = read();
    if (!acc) throw new AuthError('unavailable', 'no account yet: run "npm run password" in the UI folder');
    const { data, user } = acc;
    const t = now();
    if (user.lockedUntil && Date.parse(user.lockedUntil) > t) {
      audit({ ev: 'login-locked', ...meta });
      throw new AuthError('locked', 'account is locked after too many wrong passwords; try again later', { until: user.lockedUntil });
    }
    const nameOk = (name ?? USER) === USER;
    const passOk = typeof password === 'string' && password.length <= 200 && verifyPassword(password, user.hash);
    if (!nameOk || !passOk) {
      user.failed = (user.lockedUntil && Date.parse(user.lockedUntil) <= t ? 0 : user.failed ?? 0) + 1;
      user.lockedUntil = null;
      if (user.failed >= maxFailed) { user.lockedUntil = new Date(t + lockMs).toISOString(); user.failed = 0; }
      save(data);
      audit({ ev: user.lockedUntil ? 'login-lock' : 'login-fail', ...meta });
      if (user.lockedUntil) throw new AuthError('locked', 'account is locked after too many wrong passwords; try again later', { until: user.lockedUntil });
      throw new AuthError('unauthorized', 'wrong user name or password');
    }
    if (user.failed || user.lockedUntil) { user.failed = 0; user.lockedUntil = null; save(data); }
    audit({ ev: 'login', ...meta });
    return { sid: openSession(USER), user: USER, mustChange: Boolean(user.mustChange) };
  }

  function logout(sid) { if (sid) sessions.delete(sid); }

  // Change needs the current password even inside a session; every other session of the account is closed.
  function changePassword(sid, current, next, meta = {}) {
    const acc = read();
    if (!acc) throw new AuthError('unavailable', 'no account yet');
    if (typeof current !== 'string' || !verifyPassword(current, acc.user.hash)) {
      audit({ ev: 'password-change-fail', ...meta });
      throw new AuthError('unauthorized', 'current password is wrong');
    }
    checkNew(next);
    if (next === current) throw new AuthError('invalid', 'the new password must differ from the current one');
    Object.assign(acc.user, { hash: hashPassword(next), mustChange: false, failed: 0, lockedUntil: null, changedAt: new Date(now()).toISOString() });
    save(acc.data);
    for (const k of [...sessions.keys()]) if (k !== sid) sessions.delete(k);
    audit({ ev: 'password-change', ...meta });
    return { user: USER, mustChange: false };
  }

  const cookieHeader = (sid) => `${COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=/`;
  const clearCookie = () => `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
  return { exists, openSession, session, login, logout, changePassword, cookieHeader, clearCookie, sessionCount: () => sessions.size };
}
