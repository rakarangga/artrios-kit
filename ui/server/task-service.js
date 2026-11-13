// Task service: the single writer of card files (PRD AIOS-55 v3, sections 8 and 8a).
// Pure library: no HTTP, no globals. Context (actor) comes in as a parameter, events go out through `emit`.
import fs from 'node:fs';
import path from 'node:path';
import { parseCard, serializeCard, CardError, STATUSES, PRIORITIES, LEGACY_HATS, KINDS, ownerClient, cleanClient } from './card.js';
import { withLock, atomicWrite } from './lock.js';

const PROJECT_RE = /^[A-Z][A-Z0-9]{0,15}$/;
const KEY_RE = /^([A-Z][A-Z0-9]{0,15})-([1-9]\d*)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NOTES_HEADING = '## Catatan';

export class TaskError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // invalid | not_found | broken
  }
}

const pad = (n) => String(n).padStart(2, '0');

export function localTimestamp(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

function oneOf(name, v, allowed) {
  if (!allowed.includes(v)) throw new TaskError('invalid', `${name} must be one of ${allowed.join(', ')} (got ${v})`);
  return v;
}

function checkDue(v) {
  if (v && !DATE_RE.test(v)) throw new TaskError('invalid', `due must be YYYY-MM-DD (got ${v})`);
  return v ?? '';
}

function checkKey(key) {
  const m = KEY_RE.exec(key ?? '');
  if (!m) throw new TaskError('invalid', `bad task key: ${key}`);
  return { project: m[1], n: Number(m[2]) };
}

function singleLine(name, v) {
  const s = String(v ?? '').trim();
  if (!s || /[\r\n]/.test(s)) throw new TaskError('invalid', `${name} must be a non-empty single line`);
  return s;
}

const normBody = (b) => (b ? `${String(b).replace(/\s+$/, '')}\n` : '');

// client: default owner for new cards (empty = the owner's own). hat: legacy default, mapped through workClient.
export function createTaskService({ tasksRoot, projectDir = null, client = null, hat = null, workClient = undefined, emit = () => {}, now = () => new Date() }) {
  if (!tasksRoot) throw new Error('tasksRoot is required');
  const root = path.resolve(tasksRoot);
  const projectJson = projectDir ? path.join(projectDir, '.artrios', 'project.json') : null;

  const dirOf = (project) => path.join(root, project);
  const fileOf = (key) => path.join(dirOf(checkKey(key).project), `${key}.md`);

  function load(file) {
    try {
      const { meta, body } = parseCard(fs.readFileSync(file, 'utf8'));
      const expected = path.basename(file, '.md');
      if (meta.key !== expected) throw new CardError(`key ${meta.key} does not match file name ${expected}`);
      for (const [f, allowed] of [['status', STATUSES], ['priority', PRIORITIES]]) {
        if (!allowed.includes(meta[f])) throw new CardError(`invalid ${f}: ${meta[f]}`);
      }
      if ('hat' in meta && !LEGACY_HATS.includes(meta.hat)) throw new CardError(`invalid hat: ${meta.hat}`);
      if ('client' in meta && (typeof meta.client !== 'string' || cleanClient(meta.client) === null)) throw new CardError(`invalid client: ${meta.client}`);
      return { meta, body, file };
    } catch (e) {
      if (e instanceof CardError) throw new TaskError('broken', `${path.basename(file)}: ${e.message}`);
      throw e;
    }
  }

  function loadKey(key) {
    const file = fileOf(key);
    if (!fs.existsSync(file)) throw new TaskError('not_found', `no such card: ${key}`);
    return load(file);
  }

  // Cards are always shown with `client`; a legacy `hat` is read through ownerClient and never shown.
  const toCard = ({ meta, body, file }) => {
    const { hat: _legacy, ...rest } = meta;
    return { ...rest, client: ownerClient(meta, workClient), body, file };
  };
  const clientArg = (v) => {
    const c = cleanClient(v);
    if (c === null) throw new TaskError('invalid', 'client must be a single line of at most 80 characters');
    return c;
  };
  const fromHat = (h) => ownerClient({ hat: oneOf('hat', h, LEGACY_HATS) }, workClient);
  const projectClient = (project) => {
    const m = readMeta(project);
    return m ? ownerClient(m, workClient) : null;
  };

  function save(card, ctx, type, detail) {
    // Rewrite a legacy card with `client` (PRD S12, AC 30a): only when it is changed anyway.
    if ('hat' in card.meta) {
      card.meta.client = ownerClient(card.meta, workClient);
      delete card.meta.hat;
    }
    card.meta.updated = localTimestamp(now());
    atomicWrite(card.file, serializeCard(card));
    emit({ ts: card.meta.updated, type, ref: card.meta.key, by: ctx.by ?? 'skill', detail });
    return toCard(card);
  }

  function projectFiles(project) {
    const dir = dirOf(project);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f.startsWith(`${project}-`) && KEY_RE.test(f.slice(0, -3)));
  }

  // project.json of projectDir; with `forProject` it is ignored when it belongs to another key (a CLI run from
  // one workspace folder may add a card to another project in a central tasks root).
  function readMeta(forProject) {
    if (!projectJson || !fs.existsSync(projectJson)) return null;
    let m;
    try { m = JSON.parse(fs.readFileSync(projectJson, 'utf8')); } catch { return null; }
    return forProject && m?.key && m.key !== forProject ? null : m;
  }

  // client filter: a name, or '' for the owner's own cards; undefined = all. hat is the legacy filter.
  function list({ project, status, client: clientFilter, hat: hatFilter } = {}) {
    const want = clientFilter != null ? String(clientFilter).trim() : hatFilter ? hatFilter : null;
    const match = (c) => want === null || (clientFilter != null ? c.client === want : (want === 'work') === (c.client !== ''));
    let projects;
    if (project) {
      if (!PROJECT_RE.test(project)) throw new TaskError('invalid', `bad project key: ${project}`);
      projects = [project];
    } else {
      projects = fs.existsSync(root) ? fs.readdirSync(root).filter((d) => PROJECT_RE.test(d) && fs.statSync(path.join(root, d)).isDirectory()) : [];
    }
    const cards = [];
    const broken = [];
    for (const p of projects) {
      for (const f of projectFiles(p)) {
        const file = path.join(dirOf(p), f);
        try {
          const c = toCard(load(file));
          if ((!status || c.status === status) && match(c)) cards.push(c);
        } catch (e) {
          if (e instanceof TaskError && e.code === 'broken') broken.push({ file, error: e.message });
          else throw e;
        }
      }
    }
    cards.sort((a, b) => a.project.localeCompare(b.project) || checkKey(a.key).n - checkKey(b.key).n);
    return { cards, broken };
  }

  const show = (key) => toCard(loadKey(key));

  function create(input, ctx = {}) {
    const project = input.project;
    if (!PROJECT_RE.test(project ?? '')) throw new TaskError('invalid', `bad project key: ${project}`);
    const meta = {
      project,
      client: input.client != null ? clientArg(input.client)
        : input.hat != null ? fromHat(input.hat)
        : client != null ? clientArg(client)
        : hat != null ? fromHat(hat)
        : projectClient(project) ?? '',
      kind: oneOf('kind', input.kind ?? 'task', KINDS),
      title: singleLine('title', input.title),
      status: oneOf('status', input.status ?? 'backlog', STATUSES),
      cancelled: false,
      priority: oneOf('priority', input.priority ?? 'none', PRIORITIES),
      due: checkDue(input.due),
      parent: input.parent ? (checkKey(input.parent), input.parent) : '',
      labels: Array.isArray(input.labels) ? input.labels.map(String) : [],
    };
    return withLock(dirOf(project), () => {
      const stored = readMeta(project);
      const maxFile = Math.max(0, ...projectFiles(project).map((f) => checkKey(f.slice(0, -3)).n));
      const n = Math.max(stored?.nextIndex ?? 1, maxFile + 1);
      const key = `${project}-${n}`;
      const stamp = localTimestamp(now());
      const card = { file: fileOf(key), body: normBody(input.body), meta: { key, ...meta, created: stamp, updated: stamp, schema: 1 } };
      atomicWrite(card.file, serializeCard(card));
      if (stored) atomicWrite(projectJson, `${JSON.stringify({ ...stored, nextIndex: n + 1 }, null, 2)}\n`);
      emit({ ts: stamp, type: 'card.created', ref: key, by: ctx.by ?? 'skill', detail: meta.title });
      return toCard(card);
    });
  }

  function update(key, patch, ctx = {}) {
    const { project } = checkKey(key);
    return withLock(dirOf(project), () => {
      const card = loadKey(key);
      const m = card.meta;
      const changed = [];
      const set = (field, value) => {
        if (JSON.stringify(m[field]) !== JSON.stringify(value)) { m[field] = value; changed.push(field); }
      };
      if ('title' in patch) set('title', singleLine('title', patch.title));
      if ('priority' in patch) set('priority', oneOf('priority', patch.priority, PRIORITIES));
      if ('due' in patch) set('due', checkDue(patch.due));
      if ('parent' in patch) set('parent', patch.parent ? (checkKey(patch.parent), patch.parent) : '');
      if ('labels' in patch) set('labels', patch.labels.map(String));
      if ('client' in patch) set('client', clientArg(patch.client));
      else if ('hat' in patch) set('client', fromHat(patch.hat));
      // Worktree of the card (PRD AIOS-61 v2.1 S11): branch name and path relative to the repo, set by "run in worktree".
      if ('branch' in patch) set('branch', patch.branch ? singleLine('branch', patch.branch) : '');
      if ('worktree' in patch) set('worktree', patch.worktree ? singleLine('worktree', patch.worktree) : '');
      if ('status' in patch) {
        set('status', oneOf('status', patch.status, STATUSES));
        if (m.status !== 'done') set('cancelled', false);
      }
      if ('cancelled' in patch) {
        set('cancelled', Boolean(patch.cancelled));
        if (m.cancelled) set('status', 'done');
      }
      if ('body' in patch) {
        const body = normBody(patch.body);
        if (body !== card.body) { card.body = body; changed.push('body'); }
      }
      if (!changed.length) return toCard(card);
      const moved = changed.length === 1 && changed[0] === 'status';
      return save(card, ctx, moved ? 'card.moved' : 'card.updated', moved ? m.status : changed.join(','));
    });
  }

  const move = (key, status, ctx) => update(key, { status }, ctx);

  function note(key, text, ctx = {}) {
    const line = `- ${localTimestamp(now()).slice(0, 10)}: ${singleLine('note', text)}`;
    const { project } = checkKey(key);
    return withLock(dirOf(project), () => {
      const card = loadKey(key);
      const lines = card.body.replace(/\n+$/, '').split('\n');
      if (lines.length === 1 && lines[0] === '') lines.length = 0;
      const at = lines.findIndex((l) => l.trim() === NOTES_HEADING);
      if (at < 0) {
        if (lines.length) lines.push('');
        lines.push(NOTES_HEADING, line);
      } else {
        let end = lines.findIndex((l, i) => i > at && /^## /.test(l));
        if (end < 0) end = lines.length;
        while (end > at + 1 && lines[end - 1].trim() === '') end--;
        lines.splice(end, 0, line);
      }
      card.body = `${lines.join('\n')}\n`;
      return save(card, ctx, 'card.updated', 'note');
    });
  }

  return { list, show, create, update, move, note, tasksRoot: root };
}
