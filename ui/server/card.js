// Card file format (PRD AIOS-55 v3, section 8a): YAML-subset frontmatter + Markdown body.
// Subset: `key: value` lines; values are plain/quoted strings, true/false, or inline lists.
// Anything else (nested YAML, malformed lines) makes the card "broken"; it is reported, never rewritten.

export const STATUSES = ['backlog', 'todo', 'in_progress', 'ai_review', 'human_review', 'pr_created', 'done', 'error', 'archived'];
export const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'];
// Owner of a card or workspace is `client` (free text, empty = the owner's own; PRD AIOS-61 v2.1 S12).
// `hat: work|self` is the legacy form: still read, never written. work -> config.legacyWorkClient, self -> ''.
export const LEGACY_HATS = ['work', 'self'];
export const DEFAULT_WORK_CLIENT = 'work';
export const CLIENT_MAX = 80;

export function ownerClient(o, workClient = DEFAULT_WORK_CLIENT) {
  if (typeof o?.client === 'string' && o.client.trim()) return o.client.trim();
  return o?.hat === 'work' ? workClient || DEFAULT_WORK_CLIENT : '';
}

// Valid client text or null: single line, at most CLIENT_MAX characters.
export function cleanClient(v) {
  const s = String(v ?? '').trim();
  return /[\u0000-\u001f]/.test(s) || s.length > CLIENT_MAX ? null : s;
}
export const KINDS = ['task', 'approval_request'];
export const KEY_ORDER = ['key', 'project', 'client', 'hat', 'kind', 'title', 'status', 'cancelled', 'priority', 'due', 'parent', 'labels', 'branch', 'worktree', 'created', 'updated', 'schema'];
const NUMERIC = new Set(['schema']);

export class CardError extends Error {}

function parseScalar(raw) {
  let v = raw.trim();
  if (v.startsWith('"')) {
    const m = v.match(/^"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/);
    if (!m) throw new CardError(`bad quoted value: ${raw}`);
    try {
      return JSON.parse(`"${m[1]}"`);
    } catch {
      throw new CardError(`bad quoted value: ${raw}`);
    }
  }
  v = v.replace(/\s+#.*$/, '').trim();
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v;
}

// Inline list: items are comma separated; commas inside double quotes are kept.
function splitList(inner) {
  const items = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '\\' && quoted) { cur += ch + (inner[++i] ?? ''); continue; }
    if (ch === '"') quoted = !quoted;
    if (ch === ',' && !quoted) { items.push(cur); cur = ''; continue; }
    cur += ch;
  }
  items.push(cur);
  return items;
}

function parseValue(key, raw) {
  const v = raw.trim();
  if (v.startsWith('[')) {
    const m = v.match(/^\[(.*)\]\s*(?:#.*)?$/);
    if (!m) throw new CardError(`bad list: ${raw}`);
    const inner = m[1].trim();
    return inner === '' ? [] : splitList(inner).map((s) => parseScalar(s));
  }
  const s = parseScalar(v);
  if (NUMERIC.has(key) && typeof s === 'string' && /^\d+$/.test(s)) return Number(s);
  return s;
}

export function parseCard(text) {
  const src = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  if (!src.startsWith('---\n')) throw new CardError('missing frontmatter');
  const end = src.indexOf('\n---', 3);
  if (end < 0 || !/^\n---[ \t]*(\n|$)/.test(src.slice(end))) throw new CardError('unterminated frontmatter');
  const head = src.slice(4, end);
  const nl = src.indexOf('\n', end + 1);
  const body = nl < 0 ? '' : src.slice(nl + 1);
  const meta = {};
  for (const line of head.split('\n')) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const m = line.match(/^([A-Za-z_][\w-]*):(?:[ \t]+(.*))?$/);
    if (!m) throw new CardError(`unsupported frontmatter line: ${line}`);
    if (m[1] in meta) throw new CardError(`duplicate field: ${m[1]}`);
    meta[m[1]] = parseValue(m[1], m[2] ?? '');
  }
  if (!meta.key) throw new CardError('missing key');
  return { meta, body };
}

function fmtScalar(v) {
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const s = String(v);
  if (s === '') return '""';
  const risky = /^[\s"'[\]{}>|*&!%@`#-]/.test(s) || /\s$/.test(s) || /: |\s#|:$/.test(s) || /^(true|false)$/.test(s) || /[\n\r,]/.test(s);
  return risky ? JSON.stringify(s) : s;
}

export function serializeCard({ meta, body }) {
  const keys = [...KEY_ORDER.filter((k) => k in meta), ...Object.keys(meta).filter((k) => !KEY_ORDER.includes(k))];
  const lines = keys.map((k) => {
    const v = meta[k];
    if (Array.isArray(v)) return `${k}: [${v.map(fmtScalar).join(', ')}]`;
    if (v === '' || v == null) return `${k}:`;
    return `${k}: ${fmtScalar(v)}`;
  });
  return `---\n${lines.join('\n')}\n---\n${body}`;
}
