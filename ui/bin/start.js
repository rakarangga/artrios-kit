#!/usr/bin/env node
// Launcher (PRD AIOS-61 v2.0 S2, AC 6): `npm start` runs the UI and the scheduler as two processes.
//   Stopping the launcher (Ctrl+C, or closing it) stops both. The UI stopping on its own leaves the scheduler and its
//   jobs running; the scheduler stopping on its own leaves the UI running. Options pass through: --data DIR, --port N.
// Run one alone with `npm run ui` or `npm run scheduler`.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { killTree } from '../server/engine.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const pass = (names) => {
  const out = [];
  for (let i = 0; i < args.length; i++) if (names.includes(args[i]) && args[i + 1] !== undefined) out.push(args[i], args[++i]);
  return out;
};
const log = (line) => console.log(`[start] ${line}`);

const children = new Map();
let stopping = false;

function launch(name, script, extra, { stdinStop = false } = {}) {
  const child = spawn(process.execPath, [path.join(root, 'server', script), ...extra], {
    cwd: root,
    stdio: [stdinStop ? 'pipe' : 'ignore', 'inherit', 'inherit'],
    env: { ...process.env, ...(stdinStop ? { ARTRIOS_STOP_ON_STDIN_END: '1' } : {}) },
    windowsHide: true,
  });
  children.set(name, child);
  child.on('exit', (code, signal) => {
    children.delete(name);
    if (!stopping) {
      log(`${name} stopped (${signal ?? `exit ${code}`}); ${children.size ? `${[...children.keys()].join(' and ')} keeps running. Ctrl+C stops it.` : 'nothing left to run.'}`);
    }
    if (!children.size) process.exit(code ?? 0);
  });
  return child;
}

const ui = launch('UI', 'index.js', pass(['--data', '--port']));
const sched = launch('scheduler', 'scheduler-main.js', pass(['--data', '--tick-ms']), { stdinStop: true });
log(`UI pid ${ui.pid}, scheduler pid ${sched.pid}, launcher pid ${process.pid}. Ctrl+C stops both.`);

function stopAll() {
  if (stopping) return;
  stopping = true;
  log('stopping UI and scheduler ...');
  const sched = children.get('scheduler');
  try { sched?.stdin?.end(); } catch { /* already closed */ } // graceful: the scheduler stops its jobs first
  const ui = children.get('UI');
  if (ui) { if (process.platform === 'win32') killTree(ui.pid); else ui.kill('SIGTERM'); }
  // Whatever is still alive after 5 s goes with its whole tree (claude jobs included).
  setTimeout(() => { for (const c of children.values()) killTree(c.pid); setTimeout(() => process.exit(0), 300); }, 5000).unref();
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(sig, stopAll);
// install.py --service stop: a file appears at ARTRIOS_STOP_FILE (no signal reaches a detached process on Windows).
if (process.env.ARTRIOS_STOP_FILE) {
  const poll = setInterval(() => { if (fs.existsSync(process.env.ARTRIOS_STOP_FILE)) { clearInterval(poll); stopAll(); } }, 500);
  poll.unref();
}
// A supervisor (or a test) on Windows cannot send a signal: with ARTRIOS_START_STOP_ON_STDIN_END=1, closing stdin stops both.
if (process.env.ARTRIOS_START_STOP_ON_STDIN_END === '1') { process.stdin.resume(); process.stdin.on('end', stopAll); }
