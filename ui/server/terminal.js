// Terminal manager (F4, PRD sections 5, 8, AC 7, AC 15). Pure library: no HTTP. One pty per tab, `claude` interactive
// in the project folder. Output is kept in a bounded scrollback so a reloaded browser can reattach to a live terminal.
// Spike A2 (2026-11-05): node-pty needs a real console on the host and a full executable path (see spike-a1-a2.md).
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { childEnv } from './child-env.js';

const SCROLLBACK_MAX = 200 * 1024; // characters kept per terminal for reattach
const DEFAULT_MAX = 12;

export class TerminalError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // invalid | not_found | busy | unavailable
  }
}

// Full path of the claude executable: pty.spawn does not search PATH on Windows.
export function resolveCommand(name = 'claude') {
  if (path.isAbsolute(name) && fs.existsSync(name)) return name;
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(finder, [name], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return null;
  const lines = r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const exe = lines.find((l) => /\.exe$/i.test(l)) ?? lines[0];
  return exe || null;
}

// node-pty is loaded on first use, so the rest of the server (and its tests) never needs the native module.
async function loadPty() {
  try {
    const m = await import('node-pty');
    return m.default ?? m;
  } catch (e) {
    throw new TerminalError('unavailable', `terminal support is not installed (node-pty): ${e.message}`);
  }
}

const clampInt = (n, lo, hi, dflt) => (Number.isInteger(n) ? Math.min(hi, Math.max(lo, n)) : dflt);

export function createTerminalManager({ config = {}, ptyLib = null, env = process.env, onEvent = () => {} } = {}) {
  const max = config.maxTerminals ?? DEFAULT_MAX;
  const terms = new Map(); // id -> { id, project, title, pty, scrollback, listeners, exited, exitCode, created }
  const counters = new Map(); // project key -> next tab number

  const info = (t) => ({ id: t.id, project: t.project, title: t.title, worktree: t.worktree ?? null, pid: t.pty.pid ?? null, created: t.created, alive: !t.exited, exitCode: t.exitCode });

  // worktree: { path, branch } of a worktree of the project (S11): the tab runs there and carries its label (AC 27).
  async function open(project, { cols, rows, worktree = null } = {}) {
    if ([...terms.values()].filter((t) => !t.exited).length >= max) {
      throw new TerminalError('busy', `at most ${max} terminals can be open at once; close one first`);
    }
    const command = config.terminalCommand ? resolveCommand(config.terminalCommand) : resolveCommand('claude');
    if (!command) throw new TerminalError('unavailable', 'claude executable not found on PATH (set "terminalCommand" in config.json to its full path)');
    const lib = ptyLib ?? (await loadPty());
    // Re-check after the awaits: parallel opens must not step over the limit.
    if ([...terms.values()].filter((t) => !t.exited).length >= max) {
      throw new TerminalError('busy', `at most ${max} terminals can be open at once; close one first`);
    }
    let p;
    try {
      p = lib.spawn(command, config.terminalArgs ?? [], {
        name: 'xterm-256color',
        cols: clampInt(cols, 20, 500, 100),
        rows: clampInt(rows, 5, 200, 30),
        cwd: worktree?.path ?? project.path,
        env: childEnv(env),
      });
    } catch (e) {
      throw new TerminalError('unavailable', `could not start the terminal: ${e.message}`);
    }
    const n = (counters.get(project.key) ?? 0) + 1;
    counters.set(project.key, n);
    const id = `t-${crypto.randomBytes(6).toString('hex')}`;
    const t = { id, project: project.key, title: `claude ${n}`, worktree: worktree ? { path: worktree.path, branch: worktree.branch || null } : null, pty: p, scrollback: '', listeners: new Set(), exited: false, exitCode: null, created: new Date().toISOString() };
    terms.set(id, t);
    p.onData((data) => {
      t.scrollback = (t.scrollback + data).slice(-SCROLLBACK_MAX);
      for (const l of t.listeners) l({ type: 'output', data });
    });
    p.onExit(({ exitCode }) => {
      t.exited = true;
      t.exitCode = exitCode ?? 0;
      for (const l of t.listeners) l({ type: 'exit', code: t.exitCode });
      onEvent({ type: 'terminal.exit', project: t.project, terminalId: id, code: t.exitCode });
    });
    onEvent({ type: 'terminal.open', project: project.key, terminalId: id, title: t.title, worktree: t.worktree?.branch ?? null });
    return info(t);
  }

  const get = (id) => {
    const t = terms.get(id);
    if (!t) throw new TerminalError('not_found', `unknown terminal: ${id}`);
    return t;
  };

  const list = (project = null) => [...terms.values()].filter((t) => !project || t.project === project.key).map(info);

  // Attach a listener (a WebSocket). Returns { replay, detach }. replay = what was already printed.
  function attach(id, listener) {
    const t = get(id);
    t.listeners.add(listener);
    return { replay: t.scrollback, exited: t.exited, exitCode: t.exitCode, detach: () => t.listeners.delete(listener) };
  }

  function write(id, data) {
    const t = get(id);
    if (t.exited) return;
    if (typeof data !== 'string' || data.length > 64 * 1024) throw new TerminalError('invalid', 'input must be a string of at most 64 KB');
    t.pty.write(data);
  }

  function resize(id, cols, rows) {
    const t = get(id);
    if (t.exited) return;
    if (!Number.isInteger(cols) || !Number.isInteger(rows)) throw new TerminalError('invalid', 'cols and rows must be integers');
    try { t.pty.resize(clampInt(cols, 20, 500, 100), clampInt(rows, 5, 200, 30)); } catch { /* pty already gone */ }
  }

  // Closing a tab ends its process (AC 7). The entry is dropped so the slot frees up at once.
  function close(id) {
    const t = get(id);
    if (!t.exited) { try { t.pty.kill(); } catch { /* already gone */ } }
    for (const l of t.listeners) l({ type: 'exit', code: t.exitCode ?? -1 });
    terms.delete(id);
    onEvent({ type: 'terminal.close', project: t.project, terminalId: id });
    return { id, closed: true };
  }

  // Server shutdown: no orphan claude processes (AC 7).
  function closeAll() {
    for (const id of [...terms.keys()]) { try { close(id); } catch { /* keep closing the rest */ } }
  }

  return { open, list, get: (id) => info(get(id)), attach, write, resize, close, closeAll, count: () => terms.size };
}
