// Pulse panels (MAPS tahap 5): Hari ini, Waiting for you, routine board, skill deck. Read-only toward the Artrios home,
// except enqueue(), which only drops a request file in artrios/queue/ for the runner on the routine's host.
import fs from 'node:fs';
import path from 'node:path';
import { listSkills } from './skills.js';
import { TaskError } from './task-service.js';

const STALE_HOURS = 36;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function parseRoutines(text) {
  const items = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trimStart().startsWith('#')) continue;
    const line = raw.split(' #')[0].replace(/\s+$/, '');
    if (!line.trim()) continue;
    let m = /^- (\w+):\s*(.*)$/.exec(line);
    if (m) { cur = { [m[1]]: m[2].trim() }; items.push(cur); continue; }
    m = /^\s+(\w+):\s*(.*)$/.exec(line);
    if (m && cur) cur[m[1]] = m[2].trim();
  }
  return items.filter((i) => i.name);
}

export function parseLog(text, host) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const c = line.split('\t');
    if (c.length >= 6) rows.push({ t: c[0], host, name: c[1], model: c[2], status: c[5], detail: c[6] ?? '' });
  }
  return rows;
}

export function createPulse({ config = {}, now = () => Date.now() } = {}) {
  const root = path.resolve(config.artriosRoot ?? path.dirname(path.dirname(config.projectLayerFile ?? 'artrios/project.md')));
  const read = (...p) => { try { return fs.readFileSync(path.join(root, ...p), 'utf8'); } catch { return null; } };
  const stat = (...p) => { try { return fs.statSync(path.join(root, ...p)); } catch { return null; } };
  const stale = (ms) => (now() - ms) / 36e5 > STALE_HOURS;

  function today() {
    let files = [];
    try { files = fs.readdirSync(path.join(root, 'artrios', 'digest')).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort(); } catch { /* none yet */ }
    const last = files.at(-1);
    if (!last) return { date: null, markdown: '', builtAt: null, stale: true };
    const st = stat('artrios', 'digest', last);
    return { date: last.slice(0, 10), markdown: read('artrios', 'digest', last) ?? '', builtAt: st.mtime.toISOString(), stale: stale(st.mtimeMs) };
  }

  // Only the unsorted inbox count. The items themselves (decisions, tasks for the owner) come from the real queues in app.js;
  // the old guess from ""menunggu"" in activity.md is gone (2026-11-11: text without an action).
  function waiting() {
    const inbox = (read('artrios', 'inbox.md') ?? '').split(/\r?\n/).filter((l) => /^\s*[-*] \S/.test(l) && !/^\s*[-*] \(/.test(l));
    return { items: [], inbox: inbox.length, builtAt: new Date(now()).toISOString(), stale: false };
  }

  function routines() {
    const defs = parseRoutines(read('artrios', 'routines.yaml') ?? '').filter((r) => !r.limits);
    const logDir = path.join(root, 'logs');
    let logs = [];
    try { logs = fs.readdirSync(logDir).filter((f) => /^routines\..+\.log$/.test(f)); } catch { /* none */ }
    const runs = logs.flatMap((f) => parseLog(fs.readFileSync(path.join(logDir, f), 'utf8'), f.slice(9, -4)));
    const board = defs.map((r) => {
      const mine = runs.filter((x) => x.name === r.name && x.host === r.host);
      const last = mine.at(-1) ?? null;
      return { name: r.name, host: r.host, schedule: r.schedule, model: r.model, hat: r.hat || '', output: r.output ?? '',
        last, state: last ? last.status : 'never' };
    });
    const logTimes = logs.map((f) => ({ host: f.slice(9, -4), mtime: stat('logs', f)?.mtimeMs ?? 0 }));
    return {
      board,
      recent: runs.sort((a, b) => b.t.localeCompare(a.t)).slice(0, 15),
      hosts: logTimes.map((h) => ({ host: h.host, builtAt: new Date(h.mtime).toISOString(), stale: stale(h.mtime) })),
    };
  }

  function skills() {
    return listSkills({ path: root }, { skillDirs: ['.claude/skills'] });
  }

  // The UI never runs anything: the runner on the routine's host picks the request up and applies its own limits.
  function enqueue(name) {
    if (!NAME_RE.test(String(name ?? ''))) throw new TaskError('invalid', 'bad routine name');
    const r = routines().board.find((x) => x.name === name);
    if (!r) throw new TaskError('not_found', 'unknown routine');
    if ((r.model || 'none') !== 'none') throw new TaskError('forbidden', 'model routines are not enabled');
    const dir = path.join(root, 'artrios', 'queue');
    fs.mkdirSync(dir, { recursive: true });
    const id = `${r.host}__${name}__${new Date(now()).toISOString().replace(/[:.]/g, '-')}.req`;
    fs.writeFileSync(path.join(dir, id), JSON.stringify({ name, host: r.host, requestedAt: new Date(now()).toISOString() }) + '\n', { flag: 'wx' });
    return { queued: id, host: r.host };
  }

  return { today, waiting, routines, skills, enqueue, overview: () => ({ today: today(), waiting: waiting(), routines: routines(), skills: skills(), builtAt: new Date(now()).toISOString() }) };
}
