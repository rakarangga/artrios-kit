// Read-only task bridge (PRD AIOS-61 v2.1 S12 M1): shows tasks from an outside task tool on the board while that tool
// stays the only writer. The kit knows no task tool; config.taskBridge names one fixed command (no shell) that prints
// one JSON document:
//   { "source": "tracker", "projects": [{ "key", "name", "client"?, "hat"? }],
//     "tasks": [{ "key", "project", "title", "status", "cancelled", "priority", "due", "parent", "labels",
//                 "created", "updated", "body", "notes": [{ "date", "text" }], "client"?, "hat"? }] }
// config: { "taskBridge": { "command": ["python", "scripts/tracker.py", "export"], "cwd": "...", "label": "Tracker",
//           "ttlSeconds": 60, "writeHint": "python scripts/tracker.py ..." } }
// Every write to a bridged card is refused with code read_only (AC 28); the UI shows the reason.
import { execFile } from 'node:child_process';
import { STATUSES, PRIORITIES } from './card.js';
import { TaskError } from './task-service.js';

const PROJECT_RE = /^[A-Z][A-Z0-9]{0,15}$/;
const KEY_RE = /^([A-Z][A-Z0-9]{0,15})-([1-9]\d*)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const okArgv = (a) => Array.isArray(a) && a.length > 0 && a.every((x) => typeof x === 'string');
const str = (v) => (typeof v === 'string' ? v : '');

// One task from the tool -> card shape (same fields as a file card, plus bridge marks). Bad rows are reported.
export function toBridgeCard(t, source) {
  const m = KEY_RE.exec(t?.key ?? '');
  if (!m) throw new Error(`bad key: ${t?.key}`);
  if (t.project && t.project !== m[1]) throw new Error(`${t.key}: project ${t.project} does not match key`);
  if (!str(t.title).trim()) throw new Error(`${t.key}: empty title`);
  const status = STATUSES.includes(t.status) ? t.status : null;
  if (!status) throw new Error(`${t.key}: unknown status ${t.status}`);
  const notes = Array.isArray(t.notes) ? t.notes.filter((n) => n && DATE_RE.test(n.date)) : [];
  let body = str(t.body).replace(/\s+$/, '');
  if (notes.length) body = `${body ? `${body}\n\n` : ''}## Catatan\n${notes.map((n) => `- ${n.date}: ${str(n.text)}`).join('\n')}`;
  return {
    key: t.key,
    project: m[1],
    client: str(t.client),
    hat: str(t.hat),
    kind: 'task',
    title: str(t.title).trim(),
    status,
    cancelled: t.cancelled === true,
    priority: PRIORITIES.includes(t.priority) ? t.priority : 'none',
    due: DATE_RE.test(str(t.due)) ? t.due : '',
    parent: KEY_RE.test(str(t.parent)) ? t.parent : '',
    labels: Array.isArray(t.labels) ? t.labels.map(String) : [],
    created: str(t.created),
    updated: str(t.updated),
    schema: 1,
    body: body ? `${body}\n` : '',
    bridge: source,
    readOnly: true,
  };
}

export function parseBridgeOutput(text, source = 'bridge') {
  const doc = JSON.parse(text);
  const projects = new Map();
  for (const p of Array.isArray(doc.projects) ? doc.projects : []) {
    if (PROJECT_RE.test(p?.key ?? '')) projects.set(p.key, { key: p.key, name: str(p.name) || p.key, client: str(p.client), hat: str(p.hat) });
  }
  const cards = new Map();
  const bad = [];
  for (const t of Array.isArray(doc.tasks) ? doc.tasks : []) {
    try {
      const c = toBridgeCard(t, source);
      if (cards.has(c.key)) throw new Error(`${c.key}: duplicate key`);
      cards.set(c.key, c);
      if (!projects.has(c.project)) projects.set(c.project, { key: c.project, name: c.project, client: c.client, hat: c.hat });
    } catch (e) {
      bad.push({ file: `${source}:${t?.key ?? '?'}`, error: e.message, project: str(t?.project) || KEY_RE.exec(str(t?.key))?.[1] || '' });
    }
  }
  return { source: str(doc.source) || source, projects, cards, bad };
}

export function createTaskBridge({ config = {}, run = null, now = () => Date.now() } = {}) {
  const c = config.taskBridge;
  const enabled = !!c && okArgv(c.command);
  const label = (c && str(c.label)) || 'bridge';
  const ttl = Math.max(5, Number(c?.ttlSeconds) || 60) * 1000;
  const exec = run ?? ((argv) => new Promise((resolve, reject) => {
    execFile(argv[0], argv.slice(1), { cwd: c.cwd || undefined, timeout: 60000, windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (err, out, errOut) => {
      if (err) reject(new Error(`${argv.slice(0, 3).join(' ')} failed: ${String(errOut || err.message).trim().slice(0, 300)}`));
      else resolve(out);
    });
  }));

  let cache = null; // { at, data }
  let inflight = null;
  let lastError = '';

  // Stale-while-revalidate: a stale cache is returned at once and refreshed in the background, so a board request
  // waits for the tool only when there is no data yet (or on an explicit refresh).
  async function snapshot({ force = false } = {}) {
    if (!enabled) return null;
    if (!force && cache && now() - cache.at < ttl) return cache.data;
    if (!force && cache) {
      if (!inflight) refresh();
      return cache.data;
    }
    if (!inflight) refresh();
    await inflight;
    return cache?.data ?? null; // stale data beats an empty board when the tool is briefly down
  }

  function refresh() {
    inflight = exec(c.command)
      .then((out) => {
        cache = { at: now(), data: parseBridgeOutput(out, label) };
        lastError = '';
      })
      .catch((e) => { lastError = e.message; })
      .finally(() => { inflight = null; });
    return inflight;
  }

  const info = () => ({ enabled, label, at: cache ? new Date(cache.at).toISOString() : null, error: lastError || null });

  const refuse = (what) => new TaskError('read_only',
    `${what} berasal dari ${label} (jembatan baca saja); ubah lewat ${label} sampai cutover.${c?.writeHint ? ` Perintah: ${c.writeHint}` : ''}`);

  // Task service of one project with the bridge laid over it. Bridged cards are listed and shown, never written; a
  // file card whose key the tool also has is hidden and reported (the tool owns the key until cutover, PRD M4).
  function wrap(svc, projectKey, snap) {
    if (!snap || !snap.projects.has(projectKey)) return svc;
    const mine = [...snap.cards.values()].filter((c) => c.project === projectKey);
    const owned = new Set(mine.map((c) => c.key));
    const guard = (key) => { if (owned.has(key)) throw refuse(key); };
    return {
      ...svc,
      bridged: true,
      list(opts = {}) {
        const r = svc.list({ ...opts, project: projectKey });
        const conflicts = r.cards.filter((c) => owned.has(c.key)).map((c) => c.key);
        const files = r.cards.filter((c) => !owned.has(c.key));
        const extra = mine.filter((c) => !opts.status || c.status === opts.status);
        const cards = [...files, ...extra].sort((a, b) => Number(KEY_RE.exec(a.key)[2]) - Number(KEY_RE.exec(b.key)[2]));
        return { cards, broken: [...r.broken, ...snap.bad.filter((b) => b.project === projectKey).map(({ file, error }) => ({ file, error }))], bridge: { ...info(), conflicts } };
      },
      show: (key) => (owned.has(key) ? snap.cards.get(key) : svc.show(key)),
      create() { throw refuse(`Proyek ${projectKey}`); },
      update(key, ...rest) { guard(key); return svc.update(key, ...rest); },
      move(key, ...rest) { guard(key); return svc.move(key, ...rest); },
      note(key, ...rest) { guard(key); return svc.note(key, ...rest); },
      isBridged: (key) => owned.has(key),
    };
  }

  // A project only the tool knows (no workspace folder): its board, read-only, and nothing else.
  function virtualProject(key, snap) {
    const p = snap?.projects.get(key);
    return p ? { key: p.key, name: p.name, client: p.client, hat: p.hat, path: null, bridgeOnly: true } : null;
  }

  const emptySvc = (projectKey) => ({
    list: () => ({ cards: [], broken: [] }),
    show: (key) => { throw new TaskError('not_found', `no such card: ${key}`); },
    create: () => { throw refuse(`Proyek ${projectKey}`); },
    update: (key) => { throw refuse(key); },
    move: (key) => { throw refuse(key); },
    note: (key) => { throw refuse(key); },
    tasksRoot: null,
  });

  return { enabled, label, snapshot, info, refuse, wrap, virtualProject, emptySvc };
}
