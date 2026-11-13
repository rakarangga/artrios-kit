// Agent profiles (PRD AIOS-61 v2.1 S3): who runs, not when. One Markdown file per agent, agents/<id>.md:
// frontmatter (name, engine, model, allowedTools, approval, budget, default location) + instructions (the role).
// A schedule (schedules.js) calls an agent; an agent has no schedule of its own.
// Pure library: no HTTP. The UI writes only through create/update/remove, so a file is always rewritten whole and
// checked first (R4). A broken file is reported, never fatal (AC 14).
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite, withLock } from './lock.js';

export const APPROVALS = ['report-only', 'ask-before-write', 'ask-before-run', 'auto'];
export const ARTRIOS = 'artrios'; // location = the Artrios home folder (config.cognitionHome), not a workspace
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const LOC_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TOOL_RE = /^[A-Za-z][\w]*(\([^()\n]{0,200}\))?$/;
const MODEL_RE = /^[A-Za-z0-9._\[\]-]{1,60}$/;

export class AgentError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // invalid | not_found | conflict
  }
}

// --- tiny frontmatter reader: scalars, "quoted", [flow, list], { flow: map } -------------------------------------

function splitTop(s) {
  const out = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (const ch of s) {
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if ('([{'.includes(ch)) depth += 1;
    if (')]}'.includes(ch)) depth -= 1;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

function scalar(raw) {
  const s = raw.trim();
  if (/^".*"$/.test(s)) { try { return JSON.parse(s); } catch { return s.slice(1, -1); } }
  if (/^'.*'$/.test(s)) return s.slice(1, -1);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~' || s === '') return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s.startsWith('[') && s.endsWith(']')) return splitTop(s.slice(1, -1)).map(scalar);
  if (s.startsWith('{') && s.endsWith('}')) {
    const o = {};
    for (const kv of splitTop(s.slice(1, -1))) {
      const m = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(kv);
      if (!m) throw new AgentError('invalid', `bad map entry: ${kv}`);
      o[m[1]] = scalar(m[2]);
    }
    return o;
  }
  return s;
}

// Frontmatter + body. A "# comment" is stripped only outside quotes.
export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) throw new AgentError('invalid', 'no frontmatter (--- ... ---) at the top');
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const k = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!k) throw new AgentError('invalid', `cannot read line: ${line.trim()}`);
    let v = k[2];
    if (!/^["']/.test(v.trim())) v = v.replace(/\s+#.*$/, '');
    meta[k[1]] = scalar(v);
  }
  return { meta, body: text.slice(m[0].length).trim() };
}
export const parseAgentText = parseFrontmatter;

export const q = (s) => (/^[\w./@-]+$/.test(String(s)) ? String(s) : JSON.stringify(String(s)));

export function checkLocation(v, bad) {
  const loc = v == null || v === '' ? ARTRIOS : String(v);
  if (!LOC_RE.test(loc)) bad(`location must be "${ARTRIOS}" or a workspace key`);
  return loc;
}

export function checkBudget(budget, bad) {
  const b = budget ?? {};
  if (typeof b !== 'object' || Array.isArray(b)) bad('budget must be a map, e.g. { maxUsd: 0.5, maxMinutes: 10 }');
  for (const k of Object.keys(b)) if (!['maxUsd', 'maxMinutes'].includes(k)) bad(`budget has an unknown key: ${k}`);
  const num = (k, max) => {
    const v = b[k];
    if (v == null || v === '') return null;
    if (typeof v !== 'number' || !(v > 0) || v > max) bad(`budget.${k} must be a number above 0 and at most ${max}`);
    return v;
  };
  return { maxUsd: num('maxUsd', 100), maxMinutes: num('maxMinutes', 24 * 60) };
}

// Checks one profile and returns it normalized. Throws AgentError('invalid') with a plain message.
// Keys from the first draft (schedule, skill, project, enabled) are ignored: schedules own those now.
export function validateAgent(meta, body = '', { id: fileId } = {}) {
  const bad = (msg) => { throw new AgentError('invalid', msg); };
  const id = String(meta.id ?? fileId ?? '');
  if (!ID_RE.test(id)) bad(`id must be lowercase letters, digits, and dashes (got "${id}")`);
  if (fileId && id !== fileId) bad(`id "${id}" does not match the file name "${fileId}.md"`);
  const approval = meta.approval ?? 'report-only';
  if (!APPROVALS.includes(approval)) bad(`approval must be one of ${APPROVALS.join(', ')}`);
  const tools = meta.allowedTools ?? [];
  if (!Array.isArray(tools) || tools.some((t) => typeof t !== 'string' || !TOOL_RE.test(t))) bad('allowedTools must be a list of tool names, e.g. [Read, Grep]');
  if (meta.model != null && meta.model !== '' && !MODEL_RE.test(String(meta.model))) bad('bad model name');
  if (meta.engine != null && meta.engine !== '' && !/^[A-Za-z0-9._-]{1,40}$/.test(String(meta.engine))) bad('bad engine name');
  return {
    id, name: meta.name ? String(meta.name).slice(0, 80) : id, description: meta.description ? String(meta.description).slice(0, 300) : '',
    engine: meta.engine || null, model: meta.model || null, allowedTools: tools, approval,
    budget: checkBudget(meta.budget, bad), location: checkLocation(meta.location, bad), instructions: body.trim(), schema: 2,
  };
}

export function renderAgent(a) {
  const lines = ['---', `id: ${a.id}`, `name: ${JSON.stringify(a.name ?? a.id)}`];
  if (a.description) lines.push(`description: ${JSON.stringify(a.description)}`);
  if (a.engine) lines.push(`engine: ${q(a.engine)}`);
  if (a.model) lines.push(`model: ${q(a.model)}`);
  lines.push(`allowedTools: [${(a.allowedTools ?? []).join(', ')}]`, `approval: ${a.approval}`);
  const b = Object.entries(a.budget ?? {}).filter(([, v]) => v != null);
  if (b.length) lines.push(`budget: { ${b.map(([k, v]) => `${k}: ${v}`).join(', ')} }`);
  lines.push(`location: ${q(a.location ?? ARTRIOS)}`, 'schema: 2', '---', '', a.instructions ?? '', '');
  return lines.join('\n');
}

// Shared by agents and schedules: a folder of <id>.md files with one validator.
export function createMdStore({ dir, validate, render, kind }) {
  if (!dir) throw new Error('dir is required');
  const root = path.resolve(dir);
  const fileOf = (id) => {
    if (!ID_RE.test(id ?? '')) throw new AgentError('invalid', `bad ${kind} id: ${id}`);
    return path.join(root, `${id}.md`);
  };
  const readOne = (id) => {
    const { meta, body } = parseFrontmatter(fs.readFileSync(fileOf(id), 'utf8'));
    return validate(meta, body, { id });
  };

  function list() {
    let names = [];
    try { names = fs.readdirSync(root).filter((n) => n.endsWith('.md')).sort(); } catch { return { items: [], errors: [] }; }
    const items = [];
    const errors = [];
    for (const n of names) {
      const id = n.slice(0, -3);
      try {
        if (!ID_RE.test(id)) throw new AgentError('invalid', 'file name must be <id>.md with a lowercase id');
        items.push(readOne(id));
      } catch (e) {
        errors.push({ file: n, error: e.message });
      }
    }
    return { items, errors };
  }

  function get(id) {
    if (!fs.existsSync(fileOf(id))) throw new AgentError('not_found', `no ${kind} ${id}`);
    return readOne(id);
  }

  const write = (x) => withLock(root, () => atomicWrite(fileOf(x.id), render(x)));
  const check = (input) => {
    const { instructions, prompt, ...meta } = input;
    return validate(meta, String(instructions ?? prompt ?? ''), {});
  };

  function create(input) {
    const x = check(input);
    if (fs.existsSync(fileOf(x.id))) throw new AgentError('conflict', `${kind} ${x.id} already exists`);
    fs.mkdirSync(root, { recursive: true });
    write(x);
    return x;
  }

  function update(id, patch) {
    const cur = get(id);
    if (patch.id != null && patch.id !== id) throw new AgentError('invalid', 'id cannot change');
    const x = check({ ...cur, ...patch, id });
    write(x);
    return x;
  }

  function remove(id) {
    get(id);
    withLock(root, () => fs.unlinkSync(fileOf(id)));
    return { id, removed: true };
  }

  return { dir: root, list, get, create, update, remove };
}

export function createAgentService({ dir }) {
  const s = createMdStore({ dir, validate: validateAgent, render: renderAgent, kind: 'agent' });
  return { ...s, list: () => { const r = s.list(); return { agents: r.items, errors: r.errors }; } };
}
