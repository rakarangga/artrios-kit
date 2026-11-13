// Finds the notes of each source: Markdown and text files only, no hidden folders, no symbolic links,
// and never this app's own folder. Files over 1 MB are reported, not read.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const MAX_NOTE_BYTES = 1024 * 1024;
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKIP = new Set(['node_modules', 'dist', 'build', 'archives', 'archive', 'tmp', 'audits', 'data', 'assets', 'scripts', 'tests', 'examples']);
const NOTE_RE = /\.(md|txt)$/i;
const INDEX_RE = /^(_index.*|_hot|_log.*|index|log|overview)$/i;

const posix = (p) => p.split(path.sep).join('/');
const insideOf = (file, folder) => file === folder || file.startsWith(folder + path.sep);

// Front matter as flat key: value pairs; lists and nesting are not needed here.
export function splitFrontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { fields: {}, body: text };
  const fields = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.+)$/.exec(line);
    if (kv) fields[kv[1]] = kv[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return { fields, body: text.slice(m[0].length) };
}

function excerpt(body) {
  return body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#+\s.*$/gm, ' ')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, label) => label ?? target)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

function toNote(file, source, base, root, text, stat) {
  const { fields, body } = splitFrontMatter(text);
  const stem = path.basename(file, path.extname(file));
  const title = (fields.title ?? fields.name ?? /^#\s+(.+)$/m.exec(body)?.[1] ?? stem.replace(/[-_]+/g, ' ')).replace(/\s+/g, ' ').trim();
  const updated = Date.parse(fields.updated ?? fields['last-updated'] ?? '');
  const shown = insideOf(file, root) ? posix(path.relative(root, file)) : posix(file);
  return {
    file,
    body,
    relToSource: posix(path.relative(base, file)),
    meta: {
      id: `${source.id}-${createHash('sha1').update(file).digest('hex').slice(0, 12)}`,
      source: source.id,
      title,
      path: shown,
      summary: fields.description ?? excerpt(body),
      updated: Number.isFinite(updated) ? updated : stat.mtimeMs,
      words: body.split(/\s+/).filter(Boolean).length,
      tags: (fields.tags ?? '').replace(/[[\]'"]/g, '').split(',').map((t) => t.trim()).filter(Boolean),
      type: String(fields.type ?? '').trim(), // page kind from front matter (analysis, concept, ...); the "jenis" level of the hierarchy
      isIndex: INDEX_RE.test(stem),
    },
  };
}

// -> { notes, warnings }. Stops at maxNotes and says so.
export async function scanSources(config) {
  const notes = [];
  const warnings = [];
  const taken = new Set();
  let full = false;

  async function addFile(file, source, base) {
    if (notes.length >= config.maxNotes) { full = true; return; }
    const real = await fs.realpath(file);
    if (insideOf(real, APP_DIR) || taken.has(real)) return;
    const stat = await fs.stat(real);
    if (stat.size > MAX_NOTE_BYTES) { warnings.push(`Skipped, over 1 MB: ${posix(file)}`); return; }
    taken.add(real);
    notes.push(toNote(real, source, base, config.root, await fs.readFile(real, 'utf8'), stat));
  }

  async function walk(folder, source, base) {
    if (insideOf(await fs.realpath(folder), APP_DIR)) return;
    const entries = (await fs.readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
      const full_ = path.join(folder, e.name);
      const rel = posix(path.relative(base, full_));
      if (source.exclude.some((x) => rel === x || rel.startsWith(`${x}/`))) continue;
      if (e.isDirectory()) { if (!SKIP.has(e.name)) await walk(full_, source, base); } else if (e.isFile() && NOTE_RE.test(e.name)) await addFile(full_, source, base);
    }
  }

  for (const source of config.sources) {
    for (const p of source.paths) {
      try {
        const st = await fs.lstat(p);
        if (st.isSymbolicLink()) warnings.push(`${source.label}: skipped symbolic link ${posix(p)}`);
        else if (st.isDirectory()) await walk(p, source, p);
        else if (NOTE_RE.test(p)) await addFile(p, source, path.dirname(p));
      } catch (e) {
        if (e.code !== 'ENOENT' && e.code !== 'EACCES' && e.code !== 'EPERM') throw e;
        warnings.push(`${source.label}: cannot read ${posix(p)} (${e.code})`);
      }
    }
  }
  if (full) warnings.push(`Stopped at ${config.maxNotes} notes. Narrow the paths or raise maxNotes.`);
  return { notes, warnings };
}
