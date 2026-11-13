// Turns scanned notes into the graph: who links to whom, what is broken, what needs attention.
// Link kinds: "link" = [[wikilink]] or Markdown link, "reference" = a file or folder named in `backticks`,
// "mention" = a note's full title written in a note of another source.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { readBrainConfig } from './config.js';
import { scanSources } from './scan.js';
import { buildLayers } from './layers.js';

const STUB_WORDS = 60;
const DAY_MS = 86400000;
const PARENT_LEVELS = 6;

const normal = (s) => String(s).toLowerCase().replace(/\.(md|txt)$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const stripCode = (s) => s.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function buildLookups(notes) {
  const byName = new Map();
  const byFile = new Map();
  const name = (alias, note) => {
    const k = normal(alias);
    if (!k) return;
    if (!byName.has(k)) byName.set(k, new Set());
    byName.get(k).add(note);
  };
  for (const n of notes) {
    byFile.set(n.file, n);
    name(n.meta.title, n);
    name(path.basename(n.file), n);
    name(n.meta.path, n);
    name(n.relToSource, n);
  }
  return { byName, byFile };
}

// A wikilink goes to the only match in its own source, else the only match anywhere; an ambiguous name is no link.
function resolveWikilink(target, from, byName) {
  const all = [...(byName.get(normal(target)) ?? [])];
  const own = all.filter((n) => n.meta.source === from.meta.source);
  if (own.length === 1) return { note: own[0], known: true };
  if (all.length === 1) return { note: all[0], known: true };
  return { note: null, known: all.length > 0 };
}

// A path in backticks may be relative to the note or to any parent folder (a repo root, usually).
function resolveReference(ref, from, byFile, candidates) {
  for (let dir = path.dirname(from.file), i = 0; i < PARENT_LEVELS; i++) {
    for (const c of candidates) {
      const hit = byFile.get(path.resolve(dir, ref, c));
      if (hit) return hit;
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

export function linkNotes(notes) {
  const { byName, byFile } = buildLookups(notes);
  const edges = new Map();
  const connect = (a, b, kind) => {
    if (!b || a === b || a.meta.isIndex || b.meta.isIndex) return;
    const key = [a.meta.id, b.meta.id].sort().join('|');
    const had = edges.get(key);
    if (!had || (kind === 'link' && had.kind !== 'link')) edges.set(key, { source: a.meta.id, target: b.meta.id, kind });
  };
  const broken = new Map();
  const mark = (n, target) => { if (!broken.has(n)) broken.set(n, new Set()); broken.get(n).add(target); };

  for (const n of notes) {
    if (n.meta.isIndex) continue;
    const prose = stripCode(n.body);
    for (const m of prose.matchAll(/\[\[([^\]|#]+)[^\]]*\]\]/g)) {
      const target = m[1].trim();
      const { note, known } = resolveWikilink(target, n, byName);
      if (note) connect(n, note, 'link');
      else if (!known) mark(n, target);
    }
    for (const m of prose.matchAll(/\[[^\]]*\]\(([^)#\s]+)[^)]*\)/g)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(m[1])) continue; // web and mail addresses
      let target;
      try { target = decodeURIComponent(m[1]); } catch { continue; }
      const file = path.resolve(path.dirname(n.file), target);
      const hit = byFile.get(file);
      if (hit) connect(n, hit, 'link');
      else if (!existsSync(file)) mark(n, m[1]);
    }
    for (const m of n.body.matchAll(/`([\w./-]+\.(?:md|txt))`/g)) {
      let hit = resolveReference(m[1], n, byFile, ['']);
      if (!hit && !m[1].includes('/')) { // a bare file name counts when only one note in this source has it
        const same = notes.filter((o) => o.meta.source === n.meta.source && path.basename(o.file) === m[1]);
        if (same.length === 1) hit = same[0];
      }
      connect(n, hit, 'reference');
    }
    for (const m of n.body.matchAll(/`([\w.-]+(?:\/[\w.-]+)*\/)`/g)) connect(n, resolveReference(m[1], n, byFile, ['README.md', 'SKILL.md']), 'reference');
  }

  // Titles too short or too common would connect everything, so only long, unique ones count.
  const titled = new Map();
  for (const n of notes) {
    const t = n.meta.title;
    if (!n.meta.isIndex && t.length >= 7 && t.length <= 80 && byName.get(normal(t))?.size === 1) titled.set(t.toLowerCase(), n);
  }
  if (titled.size) {
    const re = new RegExp(`\\b(?:${[...titled.keys()].sort((a, b) => b.length - a.length).map(escapeRe).join('|')})\\b`, 'gi');
    for (const n of notes) {
      if (n.meta.isIndex) continue;
      for (const m of n.body.matchAll(re)) {
        const other = titled.get(m[0].toLowerCase());
        if (other && other.meta.source !== n.meta.source) connect(n, other, 'mention');
      }
    }
  }
  return { links: [...edges.values()], broken };
}

export async function buildGraph(configFile, now = Date.now(), pulse = null) {
  const config = await readBrainConfig(configFile);
  const { notes, warnings } = await scanSources(config);
  const { links, broken } = linkNotes(notes);
  const staleBySource = new Map(config.sources.map((s) => [s.id, s.staleDays]));

  const degree = new Map();
  for (const l of links) for (const id of [l.source, l.target]) degree.set(id, (degree.get(id) ?? 0) + 1);

  const shown = notes.filter((n) => !n.meta.isIndex);
  const nodes = shown.map((n) => {
    const { isIndex, ...meta } = n.meta;
    const links_ = degree.get(meta.id) ?? 0;
    const ageDays = Math.max(0, Math.floor((now - meta.updated) / DAY_MS));
    const limit = staleBySource.get(meta.source);
    const flags = [];
    if (!links_) flags.push('orphan');
    if (meta.words < STUB_WORDS) flags.push('stub');
    if (broken.has(n)) flags.push('broken-links');
    if (limit && ageDays > limit) flags.push('stale');
    return { ...meta, degree: links_, ageDays, flags, broken: [...(broken.get(n) ?? [])] };
  });

  const sources = config.sources.map(({ id, label, color, staleDays }) => {
    const own = nodes.filter((n) => n.source === id);
    return {
      id,
      label,
      color,
      staleDays,
      count: own.length,
      words: own.reduce((sum, n) => sum + n.words, 0),
      flagged: own.filter((n) => n.flags.length).length,
      newest: own.length ? Math.max(...own.map((n) => n.updated)) : null,
    };
  });

  // Optional layer view: only when the config names an areasDir and the caller passes the pulse reader.
  let layered = {};
  if (config.areasDir && pulse) {
    const L = buildLayers({ config, notes: nodes, routines: pulse.routines(), skills: pulse.skills() });
    nodes.splice(0, nodes.length, ...L.notes);
    layered = { layers: L.layers, areas: L.areas, extra: L.extra };
  }
  const records = new Map(notes.filter((n) => !n.meta.isIndex).map((n) => [n.meta.id, n]));
  const graph = {
    name: config.name,
    builtAt: new Date(now).toISOString(),
    warnings,
    sources,
    nodes,
    links,
    indexes: notes.filter((n) => n.meta.isIndex).map((n) => ({ title: n.meta.title, path: n.meta.path, updated: n.meta.updated })),
    hubs: [...nodes].sort((a, b) => b.degree - a.degree).slice(0, 10).filter((n) => n.degree > 0).map((n) => n.id),
    ...layered,
    totals: { notes: nodes.length, links: links.length, words: nodes.reduce((sum, n) => sum + n.words, 0) },
  };
  return { graph, records };
}
