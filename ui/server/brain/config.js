// Reads data/brain.config.json. Unknown fields are ignored, so an older file keeps working.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const COLORS = ['#38bdf8', '#34d399', '#fbbf24', '#f472b6', '#a78bfa', '#fb923c', '#22d3ee', '#a3e635', '#fca5a5', '#c4b5fd', '#fde68a', '#94a3b8'];
const MAX_SOURCES = 12;
const DEFAULT_MAX_NOTES = 3000;
const DEFAULT_STALE_DAYS = 90;

function fail(message) { throw new Error(`brain config: ${message}`); }

export function resolvePath(value, base) {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2));
  return path.resolve(base, value);
}

export async function readBrainConfig(file) {
  let raw;
  try { raw = JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) { fail(e instanceof SyntaxError ? 'not valid JSON' : e.message); }
  const list = raw?.sources;
  if (!Array.isArray(list) || !list.length) fail('"sources" must list at least one source');
  if (list.length > MAX_SOURCES) fail(`at most ${MAX_SOURCES} sources`);
  const folder = path.dirname(file);
  const root = resolvePath(String(raw.root ?? '.'), folder);
  const seen = new Set();
  const sources = list.map((s, i) => {
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(s?.id ?? '')) fail(`source ${i + 1}: id must be lowercase letters, digits, dashes`);
    if (seen.has(s.id)) fail(`duplicate source id: ${s.id}`);
    seen.add(s.id);
    if (!Array.isArray(s.paths) || !s.paths.length || s.paths.some((p) => typeof p !== 'string' || !p.trim())) fail(`source ${s.id}: "paths" must list files or folders`);
    if (s.color !== undefined && !/^#[0-9a-f]{6}$/i.test(s.color)) fail(`source ${s.id}: color must look like #38bdf8`);
    const stale = s.staleDays === null ? null : Number(s.staleDays ?? DEFAULT_STALE_DAYS);
    if (stale !== null && !(stale > 0)) fail(`source ${s.id}: staleDays must be positive, or null for never`);
    return {
      id: s.id,
      label: String(s.label ?? s.id).slice(0, 64),
      color: s.color ?? COLORS[i % COLORS.length],
      staleDays: stale,
      paths: s.paths.map((p) => resolvePath(p, root)),
      exclude: (s.exclude ?? []).map((x) => String(x).replace(/\\/g, '/').replace(/\/+$/, '')),
    };
  });
  const maxNotes = Number(raw.maxNotes ?? raw.maxNodes ?? DEFAULT_MAX_NOTES);
  if (!Number.isInteger(maxNotes) || maxNotes < 1 || maxNotes > 10000) fail('maxNotes must be between 1 and 10000');
  return { name: String(raw.name ?? 'Brain').slice(0, 64), root, maxNotes, sources, areasDir: raw.areasDir ? String(raw.areasDir) : '' };
}
