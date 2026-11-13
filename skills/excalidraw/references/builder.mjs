// Excalidraw layout toolkit for the Artrios excalidraw skill.
// Adapted from bwells271/AI-Automation-Network branch Excalidraw-Deck-Skill,
// references/deck_builder.mjs (MIT, commit 015ddbb). Artrios changes: named palettes,
// single-canvas diagram mode (writeDiagram), per-font width factor, descriptive ids.
//
// Diagram (one canvas, any size):
//   import { usePalette, C, canvas, text, rect, label, arrow, writeDiagram } from '<skill>/references/builder.mjs';
//   usePalette('dark');   // default; 'corporate' for company-facing, 'light' for plain docs
//   canvas(() => { ... absolute coords ... });
//   writeDiagram('workspace/x/arsitektur.excalidraw');
//
// Deck (frameless 1920x1080 slides on one canvas, left to right):
//   usePalette('dark');
//   slide(() => { head('01 · TOPIC','Title','subtitle'); ...diagram... });
//   writeDeck('<out-dir>');
//
// The toolkit only removes JSON boilerplate. Every coordinate and color is your decision.

import fs from 'node:fs';
import path from 'node:path';

export const SLIDE_W = 1920, SLIDE_H = 1080, GAP = 240;

// Mirrors references/palettes.md. Edit both together.
export const PALETTES = {
  light: { font: 2, canvas: '#ffffff',
    primaryF: '#d0ebff', primaryS: '#1971c2', secondaryF: '#e5dbff', secondaryS: '#6741d9',
    neutralF: '#f1f3f5', neutralS: '#868e96', startF: '#d3f9d8', startS: '#2f9e44',
    endF: '#c3fae8', endS: '#0c8599', decisionF: '#fff3bf', decisionS: '#f08c00',
    aiF: '#f3d9fa', aiS: '#9c36b5', dangerF: '#ffe3e3', dangerS: '#e03131',
    inactiveF: '#f8f9fa', inactiveS: '#adb5bd',
    title: '#1e1e1e', sub: '#1971c2', body: '#495057', accent: '#e03131', onShape: '#1e1e1e',
    arrow: '#495057', line: '#adb5bd', dot: '#1971c2',
    codeBg: '#f8f9fa', codeStroke: '#dee2e6', codeBase: '#1e1e1e', codeStr: '#2f9e44', codeKey: '#9c36b5' },
  corporate: { font: 2, canvas: '#ffffff',
    primaryF: '#cfe3f3', primaryS: '#00589e', secondaryF: '#e6f2b8', secondaryS: '#4f7a0a',
    neutralF: '#f2f2f2', neutralS: '#676767', startF: '#d6ecfb', startS: '#007fe3',
    endF: '#e6f2b8', endS: '#4f7a0a', decisionF: '#fff3bf', decisionS: '#b26a00',
    aiF: '#cfe3f3', aiS: '#032e42', dangerF: '#fbe0e0', dangerS: '#d83030',
    inactiveF: '#f2f2f2', inactiveS: '#b0b0b0',
    title: '#032e42', sub: '#00589e', body: '#676767', accent: '#d83030', onShape: '#032e42',
    arrow: '#032e42', line: '#b0b0b0', dot: '#a9ce1e',
    codeBg: '#f2f2f2', codeStroke: '#e6e6e6', codeBase: '#032e42', codeStr: '#4f7a0a', codeKey: '#00589e' },
  dark: { font: 3, canvas: '#0b0018',
    primaryF: '#FF2FB3', primaryS: '#FF8AD4', secondaryF: '#B010B8', secondaryS: '#DD72E2',
    neutralF: '#3A2154', neutralS: '#8B6BA8', startF: '#6D28D9', startS: '#B79CF0',
    endF: '#0E7C6B', endS: '#4FD1B5', decisionF: '#B45309', decisionS: '#F0B064',
    aiF: '#7C2FB0', aiS: '#DD72E2', dangerF: '#B91C1C', dangerS: '#F08A8A',
    inactiveF: '#3A2154', inactiveS: '#6B5A80',
    title: '#FFFFFF', sub: '#DD72E2', body: '#B8A0C4', accent: '#FF2FB3', onShape: '#FFFFFF',
    arrow: '#DD72E2', line: '#8B6BA8', dot: '#FF2FB3',
    codeBg: '#1A0E26', codeStroke: '#4A2E63', codeBase: '#E6D8F0', codeStr: '#4FD1B5', codeKey: '#DD72E2' },
};

// Active palette. `C` is a live object: usePalette() refills it in place.
export const C = { ...PALETTES.dark }; // default palette: dark
export function usePalette(name) {
  if (!PALETTES[name]) throw new Error(`unknown palette ${name}; have ${Object.keys(PALETTES)}`);
  for (const k of Object.keys(C)) delete C[k];
  Object.assign(C, PALETTES[name]);
}

// Average glyph width / font size. Estimates only: always render and look.
const CW = { 1: 0.6, 2: 0.55, 3: 0.6, 5: 0.6, 6: 0.55 };
const cw = () => CW[C.font] ?? 0.6;

let S = 1000; const seed = () => ++S;
let cur = [];
const SLIDES = [];
const ids = new Set();

function push(o) { cur.push(o); return o; }
function newId(id) {
  let v = id || ('e' + seed());
  if (ids.has(v)) throw new Error(`duplicate id ${v}`);
  ids.add(v); return v;
}
function baseEl(type, x, y, w, h, o = {}) {
  const { id, ...rest } = o;
  return { id: newId(id), type, x, y, width: w, height: h, angle: 0,
    strokeColor: C.title, backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid',
    roughness: 0, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: seed(), version: 1,
    versionNonce: seed(), isDeleted: false, boundElements: null, link: null, locked: false, ...rest };
}

export function text(x, y, str, { size = 16, color = C.title, align = 'left', lh = 1.25, w, id } = {}) {
  const lines = String(str).split('\n');
  const width = w || Math.max(...lines.map(l => l.length)) * size * cw();
  return push(baseEl('text', x, y, width, lines.length * size * lh, { id, strokeColor: color, text: str, originalText: str,
    fontSize: size, fontFamily: C.font, textAlign: align, verticalAlign: 'top', containerId: null, lineHeight: lh, autoResize: true }));
}

export function ctext(cx, y, str, o = {}) {
  const size = o.size || 16;
  const w = String(str).split('\n').reduce((m, l) => Math.max(m, l.length), 0) * size * cw();
  return text(cx - w / 2, y, str, { ...o, align: 'center' });
}

export function rect(x, y, w, h, { fill = C.neutralF, stroke = C.neutralS, round = true, sw = 2, dashed = false, id } = {}) {
  return push(baseEl('rectangle', x, y, w, h, { id, backgroundColor: fill, strokeColor: stroke, strokeWidth: sw,
    strokeStyle: dashed ? 'dashed' : 'solid', roundness: round ? { type: 3 } : null }));
}

// Section boundary: dashed, unfilled or lightly filled region with a free-floating title.
export function zone(x, y, w, h, title, { stroke = C.neutralS, fill = 'transparent', size = 22, id } = {}) {
  const r = rect(x, y, w, h, { fill, stroke, round: false, dashed: true, id });
  text(x + 16, y + 12, title, { size, color: stroke });
  return r;
}

export function ellipse(x, y, w, h, { fill = C.neutralF, stroke = C.neutralS, sw = 2, id } = {}) {
  return push(baseEl('ellipse', x, y, w, h, { id, backgroundColor: fill, strokeColor: stroke, strokeWidth: sw }));
}

export function diamond(x, y, w, h, { fill = C.decisionF, stroke = C.decisionS, sw = 2, id } = {}) {
  return push(baseEl('diamond', x, y, w, h, { id, backgroundColor: fill, strokeColor: stroke, strokeWidth: sw }));
}

// Centered text bound to a container (Excalidraw keeps it centered when the shape moves).
export function label(container, str, { size = 16, color = C.onShape } = {}) {
  const lines = String(str).split('\n');
  const w = Math.max(...lines.map(l => l.length)) * size * cw(), h = lines.length * size * 1.25;
  const cx = container.x + container.width / 2, cy = container.y + container.height / 2;
  const t = push(baseEl('text', cx - w / 2, cy - h / 2, w, h, { id: container.id + '_label', strokeColor: color, text: str,
    originalText: str, fontSize: size, fontFamily: C.font, textAlign: 'center', verticalAlign: 'middle',
    containerId: container.id, lineHeight: 1.25 }));
  container.boundElements = (container.boundElements || []).concat([{ id: t.id, type: 'text' }]);
  return t;
}

export function line(x, y, pts, { color = C.line, sw = 2, dashed = false, id } = {}) {
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  return push(baseEl('line', x, y, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys),
    { id, strokeColor: color, strokeWidth: sw, strokeStyle: dashed ? 'dashed' : 'solid', points: pts }));
}

// Arrow; pass startEl/endEl to bind (bound arrows follow shapes when edited by hand).
// Add waypoints to `pts` to route around shapes.
export function arrow(x, y, pts, { color = C.arrow, sw = 2, startEl, endEl, head = 'arrow', both = false, dashed = false, id } = {}) {
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const a = push(baseEl('arrow', x, y, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys),
    { id, strokeColor: color, strokeWidth: sw, strokeStyle: dashed ? 'dashed' : 'solid', points: pts,
      startArrowhead: both ? 'arrow' : null, endArrowhead: head, roundness: { type: 2 },
      startBinding: startEl ? { elementId: startEl.id, focus: 0, gap: 4 } : null,
      endBinding: endEl ? { elementId: endEl.id, focus: 0, gap: 4 } : null }));
  if (startEl) startEl.boundElements = (startEl.boundElements || []).concat([{ id: a.id, type: 'arrow' }]);
  if (endEl) endEl.boundElements = (endEl.boundElements || []).concat([{ id: a.id, type: 'arrow' }]);
  return a;
}

export function dot(cx, cy, r, { fill = C.dot, id } = {}) {
  return push(baseEl('ellipse', cx - r, cy - r, r * 2, r * 2, { id, backgroundColor: fill, strokeColor: fill, strokeWidth: 1 }));
}

// Evidence panel: code/config/JSON shown as it really looks.
export function code(x, y, str, { size = 15, w, id } = {}) {
  const lines = String(str).split('\n');
  const width = w || Math.max(...lines.map(l => l.length)) * size * 0.6 + 32;
  rect(x, y, width, lines.length * size * 1.35 + 28, { fill: C.codeBg, stroke: C.codeStroke, sw: 1, id });
  const prev = C.font; C.font = 3;
  const t = text(x + 16, y + 14, str, { size, color: C.codeBase, lh: 1.35 });
  C.font = prev; return t;
}

// Standard slide header (deck mode).
export function head(kick, title, sub, { title2 } = {}) {
  text(100, 60, kick, { size: 22, color: C.sub });
  text(100, 95, title, { size: 58, color: C.title });
  let y = 175;
  if (title2) { text(100, 168, title2, { size: 58, color: C.sub }); y = 250; }
  if (sub) text(100, y, sub, { size: 26, color: C.body, lh: 1.35 });
}

const wrap = (elements) => ({ type: 'excalidraw', version: 2, source: 'https://excalidraw.com',
  elements, appState: { viewBackgroundColor: C.canvas, gridSize: null, theme: 'light' }, files: {} });
// theme 'light' always: Excalidraw dark mode inverts canvas colors (a #0b0018 canvas turns light).
// Palettes are authored as final colors, so the viewer must not invert them.

// ---- Diagram mode: one canvas, absolute coordinates.
export function canvas(fn) { cur = []; fn(); SLIDES.push(cur); return SLIDES.length; }
export function writeDiagram(outFile) {
  if (SLIDES.length !== 1) throw new Error('writeDiagram expects exactly one canvas()');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(wrap(SLIDES[0]), null, 1));
  console.log(`wrote ${SLIDES[0].length} elements to ${outFile}`);
  return outFile;
}

// ---- Deck mode: per-slide files (local coords) + combined pannable deck.
export function slide(fn) { cur = []; fn(); SLIDES.push(cur); return SLIDES.length; }
export function writeDeck(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const paths = [];
  SLIDES.forEach((sl, i) => {
    const p = `${outDir}/slide-${String(i + 1).padStart(2, '0')}.excalidraw`;
    fs.writeFileSync(p, JSON.stringify(wrap(sl), null, 1)); paths.push(p);
  });
  const combined = [];
  SLIDES.forEach((sl, i) => { const ox = i * (SLIDE_W + GAP);
    sl.forEach(el => { const c = JSON.parse(JSON.stringify(el)); c.x += ox; combined.push(c); }); });
  const cp = `${outDir}/deck-combined.excalidraw`;
  fs.writeFileSync(cp, JSON.stringify(wrap(combined), null, 1)); paths.push(cp);
  console.log(`wrote ${SLIDES.length} slides + combined (${combined.length} els) to ${outDir}`);
  return paths;
}
