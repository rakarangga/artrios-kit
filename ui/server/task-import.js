// Import of an outside task tool's snapshot into card files (PRD AIOS-61 v2.1 S12 M3 mapping, M4 dry run, M5 cutover).
// Input: the same JSON document the read bridge reads (see task-bridge.js). Output: tasks/<KEY>/<KEY-N>.md cards with
// `client` (empty = owner's own) and no `hat`; the tool's parent split (work/self) is not carried over.
// Pure library: the CLI is bin/import-tasks.js. Never deletes; an existing card with different content is reported,
// not overwritten, unless `overwrite` is set (idempotent: a second run over the same snapshot changes nothing).
import fs from 'node:fs';
import path from 'node:path';
import { parseBridgeOutput } from './task-bridge.js';
import { parseCard, serializeCard, STATUSES, PRIORITIES } from './card.js';
import { atomicWrite } from './lock.js';

const KEY_RE = /^([A-Z][A-Z0-9]{0,15})-([1-9]\d*)$/;
const PROJECT_RE = /^[A-Z][A-Z0-9]{0,15}$/;
const indexOf = (key) => Number(KEY_RE.exec(key)[2]);
const CARD_FIELDS = ['key', 'project', 'client', 'kind', 'title', 'status', 'cancelled', 'priority', 'due', 'parent', 'labels', 'created', 'updated', 'schema'];

// Bridge card -> file card { meta, body }. `client` comes from the task, else its project; a legacy hat maps
// work -> clientOfWork, anything else -> '' (PRD S12: hat is not a field any more).
export function toImportCard(c, project, { clientOfWork = '' } = {}) {
  let client = c.client || project?.client || '';
  if (!client && (c.hat || project?.hat) === 'work') client = clientOfWork;
  const meta = {};
  for (const f of CARD_FIELDS) meta[f] = f === 'client' ? client : c[f];
  return { meta, body: c.body };
}

// Every card file below `root` (any depth up to 3: tasks/<KEY>/ and the old tasks/<hat>/<KEY>/), keyed by card key.
export function scanCards(root) {
  const found = [];
  if (!root || !fs.existsSync(root)) return found;
  const walk = (dir, depth) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3 && !e.name.startsWith('.')) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.md') && KEY_RE.test(e.name.slice(0, -3))) {
        let title = '';
        try { title = parseCard(fs.readFileSync(p, 'utf8')).meta.title ?? ''; } catch { title = '(rusak)'; }
        found.push({ key: e.name.slice(0, -3), file: p, title });
      }
    }
  };
  walk(root, 0);
  return found;
}

// Check one written card the way the task service will read it after cutover (client instead of hat).
export function checkCardFile(file) {
  const { meta } = parseCard(fs.readFileSync(file, 'utf8'));
  const problems = [];
  if (meta.key !== path.basename(file, '.md')) problems.push(`key ${meta.key} != file name`);
  if (!KEY_RE.test(meta.key) || KEY_RE.exec(meta.key)[1] !== meta.project) problems.push(`project ${meta.project} does not match key`);
  if (!STATUSES.includes(meta.status)) problems.push(`status ${meta.status}`);
  if (!PRIORITIES.includes(meta.priority)) problems.push(`priority ${meta.priority}`);
  if (typeof meta.client !== 'string') problems.push('client missing');
  if ('hat' in meta) problems.push('hat still present');
  if (meta.cancelled === true && meta.status !== 'done') problems.push('cancelled but not done');
  if (!String(meta.title ?? '').trim()) problems.push('empty title');
  return { meta, problems };
}

const tally = (rows) => {
  const out = {};
  for (const r of rows) {
    const p = (out[r.project] ??= { total: 0, cancelled: 0 });
    p.total++;
    p[r.status] = (p[r.status] ?? 0) + 1;
    if (r.cancelled) p.cancelled++;
  }
  return out;
};

/**
 * Import a snapshot into `tasksRoot`.
 * @param {object} o
 * @param {string} o.snapshotText  bridge JSON document
 * @param {string} o.tasksRoot     target root; cards go to <tasksRoot>/<KEY>/<KEY-N>.md
 * @param {string[]} [o.existingRoots] roots holding card files today (scanned for key clashes, never written)
 * @param {string} [o.clientOfWork] client name for legacy hat "work" without a client
 * @param {boolean} [o.overwrite]  rewrite cards whose content differs (cutover re-run after a fresh snapshot)
 */
export function importSnapshot({ snapshotText, tasksRoot, existingRoots = [], clientOfWork = '', overwrite = false }) {
  const raw = JSON.parse(snapshotText);
  const snap = parseBridgeOutput(snapshotText, raw.source || 'import');
  const root = path.resolve(tasksRoot);
  const projects = new Map([...snap.projects].map(([k, p]) => [k, p]));
  const result = { source: snap.source, tasksRoot: root, written: [], unchanged: [], differs: [], broken: [], bad: snap.bad, unmapped: [], clashes: [] };

  // Unmapped fields reported per task by the exporter (comments, attachments, reminders, ...): listed, not dropped silently.
  for (const t of Array.isArray(raw.tasks) ? raw.tasks : []) {
    if (Array.isArray(t.unmapped) && t.unmapped.length) result.unmapped.push({ key: t.key, fields: t.unmapped });
  }

  const nextIndex = {};
  for (const c of snap.cards.values()) nextIndex[c.project] = Math.max(nextIndex[c.project] ?? 1, indexOf(c.key) + 1);

  // Key clashes with cards that already exist as files outside the target: the tool's key wins (PRD M4); the file card
  // is proposed a new key after nextIndex. Nothing is moved here; the report says what to do.
  const proposed = { ...nextIndex };
  for (const r of existingRoots) {
    for (const f of scanCards(r)) {
      if (path.resolve(f.file).startsWith(root + path.sep)) continue;
      const owner = snap.cards.get(f.key);
      if (!owner) continue;
      const project = KEY_RE.exec(f.key)[1];
      const newKey = `${project}-${proposed[project]++}`;
      result.clashes.push({ key: f.key, file: f.file, fileTitle: f.title, toolTitle: owner.title, toolStatus: owner.cancelled ? 'cancelled' : owner.status, proposedKey: newKey });
    }
  }

  for (const c of snap.cards.values()) {
    const card = toImportCard(c, projects.get(c.project), { clientOfWork });
    const file = path.join(root, c.project, `${c.key}.md`);
    const text = serializeCard(card);
    if (fs.existsSync(file)) {
      const old = fs.readFileSync(file, 'utf8');
      if (old === text) { result.unchanged.push(c.key); continue; }
      if (!overwrite) { result.differs.push(c.key); continue; }
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    atomicWrite(file, text);
    result.written.push(c.key);
  }

  // Read back every card under the target and compare counts with the snapshot.
  const fileRows = [];
  for (const f of scanCards(root)) {
    try {
      const { meta, problems } = checkCardFile(f.file);
      if (problems.length) result.broken.push({ key: f.key, problems });
      fileRows.push({ project: meta.project, status: meta.status, cancelled: meta.cancelled === true, client: meta.client });
    } catch (e) {
      result.broken.push({ key: f.key, problems: [e.message] });
    }
  }
  const toolRows = [...snap.cards.values()].map((c) => ({ project: c.project, status: c.status, cancelled: c.cancelled }));
  const tool = tally(toolRows);
  const files = tally(fileRows);
  const keys = [...new Set([...Object.keys(tool), ...Object.keys(files)])].sort();
  result.counts = keys.map((k) => ({ project: k, client: projects.get(k)?.client ?? '', tool: tool[k] ?? { total: 0, cancelled: 0 }, files: files[k] ?? { total: 0, cancelled: 0 }, nextIndex: nextIndex[k] ?? 1 }));
  result.mismatch = result.counts.filter((r) => JSON.stringify(sortObj(r.tool)) !== JSON.stringify(sortObj(r.files))).map((r) => r.project);
  result.projectsWithoutTasks = [...projects.keys()].filter((k) => !tool[k]);
  result.legacyFolders = fs.existsSync(root) ? fs.readdirSync(root).filter((d) => !PROJECT_RE.test(d) && fs.statSync(path.join(root, d)).isDirectory()) : [];
  result.totals = { tool: toolRows.length, files: fileRows.length, cancelledTool: toolRows.filter((r) => r.cancelled).length, cancelledFiles: fileRows.filter((r) => r.cancelled).length };
  return result;
}

const sortObj = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

const STATUS_COLS = ['backlog', 'todo', 'in_progress', 'done'];

export function reportMarkdown(r, { title = 'Uji kering migrasi tugas', snapshot = '' } = {}) {
  const L = [];
  const st = (o) => STATUS_COLS.map((s) => o[s] ?? 0).join(' / ');
  L.push(`# ${title}`, '');
  if (snapshot) L.push(`- Snapshot: \`${snapshot}\``);
  L.push(`- Sumber: ${r.source}; target: \`${r.tasksRoot}\``);
  L.push(`- Tugas di snapshot: ${r.totals.tool}; kartu berkas: ${r.totals.files}; cancelled: ${r.totals.cancelledTool} vs ${r.totals.cancelledFiles}`);
  L.push(`- Ditulis ${r.written.length}, sama ${r.unchanged.length}, beda (tidak ditimpa) ${r.differs.length}`);
  L.push(`- Jumlah per proyek dan status: ${r.mismatch.length ? `**TIDAK SAMA: ${r.mismatch.join(', ')}**` : 'sama semua'}`);
  L.push(`- Kartu cacat: ${r.broken.length}; baris snapshot ditolak: ${r.bad.length}; folder bukan kunci proyek di target: ${r.legacyFolders.length ? r.legacyFolders.join(', ') : 'tidak ada'}`);
  L.push(`- Bentrok kunci dengan kartu berkas yang ada: ${r.clashes.length ? r.clashes.map((c) => c.key).join(', ') : 'tidak ada'}`, '');
  L.push('## Jumlah per proyek', '', '| Proyek | Client | Snapshot total | Berkas total | backlog / todo / in_progress / done (snapshot) | (berkas) | cancelled | nextIndex |', '|---|---|---|---|---|---|---|---|');
  for (const c of r.counts) L.push(`| ${c.project} | ${c.client || '(kosong)'} | ${c.tool.total} | ${c.files.total} | ${st(c.tool)} | ${st(c.files)} | ${c.tool.cancelled} / ${c.files.cancelled} | ${c.nextIndex} |`);
  if (r.projectsWithoutTasks.length) L.push('', `Proyek tanpa tugas (tidak ada folder dibuat): ${r.projectsWithoutTasks.join(', ')}`);
  L.push('', '## Bentrok kunci', '');
  if (!r.clashes.length) L.push('Tidak ada.');
  for (const c of r.clashes) L.push(`- **${c.key}**: berkas \`${c.file}\` ("${c.fileTitle}") vs ${r.source} "${c.toolTitle}" (${c.toolStatus}). Kunci milik ${r.source}; kartu berkas dihapus bila kartu uji, atau diberi kunci baru ${c.proposedKey}.`);
  L.push('', '## Kartu cacat dan baris ditolak', '');
  if (!r.broken.length && !r.bad.length) L.push('Tidak ada.');
  for (const b of r.broken) L.push(`- ${b.key}: ${b.problems.join('; ')}`);
  for (const b of r.bad) L.push(`- ${b.file}: ${b.error}`);
  if (r.differs.length) L.push('', '## Kartu yang sudah ada dengan isi berbeda (tidak ditimpa)', '', r.differs.join(', '));
  L.push('', '## Kolom tak terpetakan', '');
  if (!r.unmapped.length) L.push('Tidak ada.');
  for (const u of r.unmapped) L.push(`- ${u.key}: ${u.fields.join(', ')}`);
  return `${L.join('\n')}\n`;
}
