// Layers and areas for the Brain rings (MAPS tahap 6). An area is whatever its signal file under areasDir says
// (bullets "- [name](path): note" under Proyek, Skill, Status, Memori, Rutinitas); nothing is guessed from folders.
// Adds a core node, one hub per area, app/skill/routine/run nodes, and tags every note with layer and area.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const LAYERS = [
  { id: 'core', label: 'Core' },
  { id: 'skills', label: 'Skills' },
  { id: 'memory', label: 'Memory' },
  { id: 'routines', label: 'Routines' },
  { id: 'apps', label: 'Applications' },
  { id: 'runs', label: 'Runs' },
];
const SECTION = { Proyek: ['app', 'apps'], Skill: ['skill', 'skills'], Status: ['file', 'memory'], Memori: ['file', 'memory'], Rutinitas: ['routine', 'routines'] };
const AREA_COLORS = ['#38bdf8', '#34d399', '#fbbf24', '#f472b6', '#a78bfa', '#fb923c', '#22d3ee'];
const id = (kind, key) => `${kind}-${createHash('sha1').update(kind === 'routine' ? String(key).replace(/_/g, '-') : String(key)).digest('hex').slice(0, 12)}`;

export function parseArea(text, file) {
  const slug = path.basename(file, '.md');
  const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? slug;
  const entries = [];
  let section = null;
  for (const line of text.split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) { section = SECTION[h[1]] ? h[1] : null; continue; }
    const b = section && /^- \[([^\]]+)\]\(([^)]+)\)(?::\s*(.*))?$/.exec(line);
    if (b) {
      const note = b[3] ?? '';
      const hat = /\bhat ([^;]+?)(?:;|$)/i.exec(note)?.[1]?.trim() ?? '';
      entries.push({ section, kind: SECTION[section][0], layer: SECTION[section][1], name: b[1], path: b[2], note, hat });
    }
  }
  return { id: slug, label: title, entries };
}

export function readAreas(dir) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort(); } catch { return []; }
  return files.map((f) => parseArea(fs.readFileSync(path.join(dir, f), 'utf8'), f)).map((a, i) => ({ ...a, color: AREA_COLORS[i % AREA_COLORS.length] }));
}

// Hierarchy area > entity > type > document (PRD AIOS-61 S9). The entity comes from the page path first:
// wiki/clients/<client>/<topic>/... gives the client and the topic (billing, ops, ...) as entity;
// wiki/<area>/<folder>/... gives that folder. A page straight under its area has no entity ('').
export function entityOf(p) {
  const s = String(p).split(String.fromCharCode(92)).join('/').toLowerCase();
  const c = /(?:^|\/)wiki\/clients\/([a-z0-9-]+)\/(?:([a-z0-9-]+)\/)?/.exec(s);
  if (c) return { client: c[1], entity: c[2] ?? '' };
  const w = /(?:^|\/)wiki\/[a-z0-9-]+\/([a-z0-9-]+)\//.exec(s);
  return { client: '', entity: w ? w[1] : '' };
}

// Notes under .../wiki/<area>/ belong to that area; everything else is placed by the area bullets that name its folder or file.
function areaOfNote(n, areas, entryPaths) {
  const p = n.path.replace(/\\/g, '/').toLowerCase();
  const m = /(?:^|\/)wiki\/([a-z0-9-]+)\//.exec(p);
  if (m && areas.some((a) => a.id === m[1])) return m[1];
  for (const [prefix, area] of entryPaths) if (p.endsWith(prefix) || p.includes(prefix + '/')) return area;
  return 'system';
}

export function buildLayers({ config, notes, routines, skills }) {
  const areas = readAreas(config.areasDir ? path.resolve(config.root, config.areasDir) : '');
  const entryPaths = areas
    .flatMap((a) => a.entries.map((e) => [e.path.replace(/\\/g, '/').replace(/^[A-Za-z]:\//, '').toLowerCase(), a.id]))
    .filter(([p]) => p.length > 6);
  const nodes = [];
  const links = [];
  const core = { id: 'core-claude', title: 'CLAUDE.md', kind: 'core', layer: 'core', area: '', path: 'CLAUDE.md', updated: Date.now(), degree: 0 };
  nodes.push(core);
  for (const a of areas) {
    nodes.push({ id: `area-${a.id}`, title: a.label, kind: 'area', layer: 'core', area: a.id, path: `areas/${a.id}.md`, updated: Date.now(), degree: 0, color: a.color });
    links.push({ source: core.id, target: `area-${a.id}`, kind: 'core' });
  }
  const hasClients = areas.some((a) => a.id === 'clients');
  const seen = new Set();
  const add = (n, areaId) => {
    if (seen.has(n.id)) return;
    seen.add(n.id);
    nodes.push(n);
    if (areaId) links.push({ source: `area-${areaId}`, target: n.id, kind: 'belongs' });
    if (n.hat && hasClients && areaId !== 'clients') links.push({ source: n.id, target: 'area-clients', kind: 'hat' });
  };
  for (const a of areas) {
    for (const e of a.entries) {
      if (e.layer === 'memory') continue; // memory notes come from the scanned sources, not from these bullets
      add({ id: id(e.kind, e.kind === 'skill' || e.kind === 'routine' ? e.name.replace(/^\//, '') : a.id + e.name), title: e.name, kind: e.kind, layer: e.layer, area: a.id, path: e.path, summary: e.note, hat: e.hat, updated: 0, degree: 0 }, a.id);
    }
  }
  for (const s of skills) {
    const owner = areas.find((a) => a.entries.some((e) => e.kind === 'skill' && e.name === `/${s.name}`))?.id ?? 'system';
    add({ id: id('skill', s.name), title: `/${s.name}`, kind: 'skill', layer: 'skills', area: owner, path: `.claude/skills/${s.name}`, summary: s.description, updated: 0, degree: 0 }, owner);
  }
  for (const r of routines.board) {
    add({ id: id('routine', r.name), title: r.name, kind: 'routine', layer: 'routines', area: 'system', path: 'artrios/routines.yaml', summary: `${r.schedule} · ${r.host} · ${r.state}`, hat: r.hat, updated: r.last ? Date.parse(r.last.t) : 0, degree: 0 }, 'system');
  }
  for (const x of routines.recent) {
    const rid = id('routine', x.name);
    const runId = id('run', x.host + x.t + x.name);
    add({ id: runId, title: `${x.name} ${x.t.slice(5, 16).replace('T', ' ')}`, kind: 'run', layer: 'runs', area: 'system', path: `logs/routines.${x.host}.log`, summary: `${x.status} ${x.detail}`, updated: Date.parse(x.t), degree: 0, status: x.status }, null);
    if (seen.has(rid)) links.push({ source: runId, target: rid, kind: 'ran' });
  }
  const tagged = notes.map((n) => ({ ...n, kind: 'file', layer: 'memory', area: areaOfNote(n, areas, entryPaths), ...entityOf(n.path), type: n.type || 'dokumen' }));
  const deg = new Map();
  for (const l of links) for (const k of [l.source, l.target]) deg.set(k, (deg.get(k) ?? 0) + 1);
  for (const n of nodes) { n.degree = deg.get(n.id) ?? 0; n.client ??= ''; n.entity ??= ''; n.type ??= n.kind; }
  return {
    notes: tagged,
    extra: { nodes, links },
    layers: LAYERS.map((l) => ({ ...l, count: l.id === 'memory' ? tagged.length : nodes.filter((n) => n.layer === l.id).length })),
    areas: areas.map((a) => ({
      id: a.id, label: a.label, color: a.color,
      count: nodes.filter((n) => n.area === a.id && n.kind !== 'area' && n.kind !== 'run').length + tagged.filter((n) => n.area === a.id).length,
    })),
  };
}
