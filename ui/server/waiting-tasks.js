// "Your tasks" in Routines > Today > Waiting for you: tasks that need the owner's own hands, from the instance's task
// tool, with a Done button. The kit knows no task tool; config.waitingTasks names two fixed commands (no shell):
//   { "list": ["node", "bin/artrios-task.js", "list", "--label", "owner", "--format", "tracker"],
//     "done": ["node", "bin/artrios-task.js", "done", "{key}"], "cwd": "/path/to/instance" }
// list prints one task per line: "[<hat>\t]<KEY-1> [<state>|<priority>] <title>[ (due YYYY-MM-DD)]".
import { execFile } from 'node:child_process';
import { TaskError } from './task-service.js';

const LINE = /^(?:([\w-]+)\t)?([A-Z][A-Z0-9]*-\d+) \[([^|\]]+)(?:\|([^\]]+))?\] (.+?)(?: \(due (\d{4}-\d{2}-\d{2})\))?$/;
const KEY_RE = /^[A-Z][A-Z0-9]*-\d+$/;
const HAT_RE = /^[\w-]{1,20}$/;

export function parseTaskLines(text) {
  return String(text).split(/\r?\n/).flatMap((l) => {
    const m = LINE.exec(l.trim());
    return m ? [{ hat: m[1] ?? '', key: m[2], state: m[3], priority: m[4] ?? '', title: m[5], due: m[6] ?? null }] : [];
  });
}

const okArgv = (a) => Array.isArray(a) && a.length > 0 && a.every((x) => typeof x === 'string');

export function createWaitingTasks({ config }) {
  const c = config.waitingTasks;
  const enabled = !!c && okArgv(c.list);
  const run = (argv) => new Promise((resolve, reject) => {
    execFile(argv[0], argv.slice(1), { cwd: c.cwd || undefined, timeout: 20000, windowsHide: true, encoding: 'utf8' }, (err, out, errOut) => {
      if (err) reject(new TaskError('unavailable', `${argv.slice(0, 3).join(' ')} failed: ${String(errOut || err.message).trim().slice(0, 300)}`));
      else resolve(out);
    });
  });

  async function list() {
    if (!enabled) return { enabled: false, tasks: [] };
    try { return { enabled: true, canDone: okArgv(c.done), tasks: parseTaskLines(await run(c.list)) }; }
    catch (e) { return { enabled: true, canDone: false, tasks: [], error: e.message }; }
  }

  async function done(key, hat = '') {
    if (!enabled || !okArgv(c.done)) throw new TaskError('conflict', 'no done command in config.waitingTasks');
    if (!KEY_RE.test(key ?? '')) throw new TaskError('invalid', `bad task key: ${key}`);
    if (hat && !HAT_RE.test(hat)) throw new TaskError('invalid', `bad hat: ${hat}`);
    // Only a task the list shows can be closed from here.
    const cur = (await list()).tasks.find((t) => t.key === key);
    if (!cur) throw new TaskError('not_found', `${key} is not in the waiting list`);
    const argv = c.done.map((a) => a.replaceAll('{key}', key).replaceAll('{hat}', cur.hat || hat));
    const out = await run(argv);
    return { key, done: true, output: out.trim().slice(0, 300) };
  }

  return { enabled, list, done };
}
