// Layered Brain views (MAPS tahap 6): Rings, Areas, Links, Timeline. Plain SVG and HTML, no extra library.
// Data comes from the graph: notes plus graph.extra (core, areas, apps, skills, routines, runs), tagged with layer and area.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { forceLink, forceManyBody, forceSimulation, forceX, forceY } from "d3-force-3d";
import { cn } from "@/lib/utils";

export const RING = { skills: 112, memory: 150, routines: 318, runs: 352, apps: 395 };
const KIND_LABEL = { core: "core", area: "area", app: "aplikasi", skill: "skill", routine: "rutinitas", run: "run", file: "berkas" };

export function allNodes(graph) { return [...graph.nodes, ...(graph.extra?.nodes ?? [])]; }
export function allLinks(graph) { return [...graph.links, ...(graph.extra?.links ?? [])]; }

// The two marks the snapshot puts inside a shape: an application window in each app hexagon, the initial in each area hub.
const APP_GLYPH = "M6 7.5h12v9H6zM6 10.5h12M8 9h.01M10 9h.01";
function Shape({ kind, x, y, r, fill, stroke, dim, onClick, title, letter }) {
  const common = { fill, stroke, strokeWidth: stroke ? 1.5 : 0, opacity: dim ? 0.18 : 0.95, onClick, style: { cursor: "pointer" } };
  let el;
  if (kind === "skill") el = <polygon {...common} points={`${x},${y - r * 1.3} ${x + r * 1.3},${y} ${x},${y + r * 1.3} ${x - r * 1.3},${y}`} />;
  else if (kind === "routine") el = <rect {...common} x={x - r} y={y - r} width={r * 2} height={r * 2} />;
  else if (kind === "app") el = <polygon {...common} points={[0, 1, 2, 3, 4, 5].map((i) => `${x + r * 1.4 * Math.cos(Math.PI / 3 * i)},${y + r * 1.4 * Math.sin(Math.PI / 3 * i)}`).join(" ")} />;
  else if (kind === "run") el = <polygon {...common} points={`${x},${y - r} ${x + r},${y + r} ${x - r},${y + r}`} />;
  else el = <circle {...common} cx={x} cy={y} r={r} />;
  const k = (r * 1.25) / 12;
  return (
    <g>
      {el}
      {kind === "app" && <path d={APP_GLYPH} transform={`translate(${x - 12 * k} ${y - 12 * k}) scale(${k})`} fill="none" stroke="#fff" strokeWidth={2 / k} strokeLinejoin="round" strokeLinecap="round" opacity={dim ? 0.18 : 0.95} pointerEvents="none" />}
      {kind === "area" && letter && <text x={x} y={y + r * 0.36} textAnchor="middle" fontSize={r * 1.05} fontWeight="800" fill="#fff" opacity={dim ? 0.18 : 0.95} pointerEvents="none">{letter}</text>}
      <title>{title}</title>
    </g>
  );
}

// The same shapes on a canvas, for the 3D sprites. Cached per kind, color and label.
const shapeCache = new Map();
export function shapeCanvas(kind, color, label = "") {
  const key = kind + color + label;
  if (shapeCache.has(key)) return shapeCache.get(key);
  const S = 64, c = document.createElement("canvas");
  c.width = label ? 512 : S; c.height = S;
  const g = c.getContext("2d");
  const x = S / 2, y = S / 2, r = 20;
  g.beginPath();
  if (kind === "skill") { g.moveTo(x, y - r * 1.3); g.lineTo(x + r * 1.3, y); g.lineTo(x, y + r * 1.3); g.lineTo(x - r * 1.3, y); }
  else if (kind === "routine") g.rect(x - r, y - r, r * 2, r * 2);
  else if (kind === "app") for (let i = 0; i < 6; i++) g[i ? "lineTo" : "moveTo"](x + r * 1.4 * Math.cos(Math.PI / 3 * i), y + r * 1.4 * Math.sin(Math.PI / 3 * i));
  else if (kind === "run") { g.moveTo(x, y - r); g.lineTo(x + r, y + r); g.lineTo(x - r, y + r); }
  else g.arc(x, y, kind === "app" ? r : r, 0, Math.PI * 2);
  g.closePath();
  g.globalAlpha = 0.95; g.fillStyle = color; g.fill(); g.globalAlpha = 1;
  if (kind === "app") { g.save(); g.translate(x - 15, y - 15); g.scale(30 / 24, 30 / 24); g.strokeStyle = "#fff"; g.lineWidth = 2; g.lineJoin = "round"; g.lineCap = "round"; g.stroke(new Path2D(APP_GLYPH)); g.restore(); }
  if (kind === "area" && label) { g.fillStyle = "#fff"; g.font = "800 22px 'Archivo', 'DM Sans', sans-serif"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(label[0].toUpperCase(), x, y + 1); g.textAlign = "start"; }
  if (label) {
    g.font = "600 26px 'Archivo', 'DM Sans', sans-serif"; g.textBaseline = "middle";
    g.lineWidth = 6; g.strokeStyle = "#05070dcc"; g.strokeText(label, S + 8, y);
    g.fillStyle = "#e2e8f0"; g.fillText(label, S + 8, y);
  }
  shapeCache.set(key, c);
  return c;
}

export const radius = (n) => (n.kind === "area" ? 11 : n.kind === "core" ? 16 : n.kind === "app" ? 6.5 : Math.min(7, 2.4 + Math.sqrt(n.degree || 0) * 0.5));


// Sector per area: width follows the area's size (softened), so a large area does not pile up in a thin slice.
function sectors(areas) {
  const w = areas.map((a) => Math.max(6, Math.pow(Math.max(1, a.count), 0.6))); // a floor, so a small area still gets room for its label
  const total = w.reduce((x, y) => x + y, 0) || 1;
  const from = w.map((_, i) => (w.slice(0, i).reduce((x, y) => x + y, 0) / total) * 2 * Math.PI);
  const span = w.map((x) => (x / total) * 2 * Math.PI);
  return { from, span, mid: (i) => from[i] + span[i] / 2 - Math.PI / 2 };
}

// Scale a layout so it fits the 860-wide camera.
function fit(out, r = 400) {
  let m = 1;
  for (const p of out.values()) m = Math.max(m, Math.hypot(p.x, p.y));
  for (const p of out.values()) { p.x *= r / m; p.y *= r / m; }
  return out;
}

// Rings: each area owns one sector; inside it every layer is packed in tidy arcs, row by row from the layer's radius outward.
// Applications sit evenly on the outer ring; area hubs sit between the skills and the memory band.
export function ringLayout(graph) {
  const areas = graph.areas;
  const { from, span } = sectors(areas);
  const out = new Map();
  const groups = new Map();
  const apps = [];
  const ai = (n) => Math.max(0, areas.findIndex((a) => a.id === n.area));
  for (const n of allNodes(graph)) {
    if (n.kind === "core") { out.set(n.id, { x: 0, y: 0 }); continue; }
    if (n.kind === "area") { const i = ai(n), t = from[i] + span[i] / 2 - Math.PI / 2; out.set(n.id, { x: 72 * Math.cos(t), y: 72 * Math.sin(t) }); continue; }
    if (n.layer === "apps") { apps.push(n); continue; }
    const key = `${n.layer}|${ai(n)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(n);
  }
  const STEP = { memory: 11, skills: 12, routines: 14, runs: 12 };
  for (const [key, list] of groups) {
    const [layer, i] = [key.split("|")[0], Number(key.split("|")[1])];
    const gap = STEP[layer] ?? 12;
    const pad = Math.min(0.06, 8 / (RING[layer] ?? 300));
    const a0 = from[i] - Math.PI / 2 + pad, width = span[i] - pad * 2;
    // Hierarchy area > entity > type > document: pages of one entity sit next to each other in the sector.
    list.sort((x, y) => (x.entity || "~").localeCompare(y.entity || "~") || (x.type || "").localeCompare(y.type || "") || (y.degree || 0) - (x.degree || 0) || x.title.localeCompare(y.title));
    let k = 0, row = 0;
    while (k < list.length) {
      const r = (RING[layer] ?? 395) + row * gap;
      const cap = Math.max(1, Math.floor((r * width) / gap));
      const take = list.slice(k, k + cap);
      take.forEach((n, j) => { const t = a0 + (width * (j + 0.5)) / take.length; out.set(n.id, { x: r * Math.cos(t), y: r * Math.sin(t) }); });
      k += take.length; row++;
    }
  }
  apps.sort((x, y) => ai(x) - ai(y) || x.title.localeCompare(y.title));
  apps.forEach((n, j) => {
    const i = ai(n), mine = apps.filter((m) => ai(m) === i), q = mine.indexOf(n);
    const t = from[i] - Math.PI / 2 + (span[i] * (q + 0.5)) / mine.length;
    out.set(n.id, { x: RING.apps * Math.cos(t), y: RING.apps * Math.sin(t) });
  });
  return out;
}

// Areas: one dense cluster per area around its hub, applications on an inner ring between the core and the clusters.
const KIND_ORDER = { skill: 0, routine: 1, file: 2, run: 3 };
export function areasLayout(graph) {
  const areas = graph.areas;
  const { mid } = sectors(areas);
  const out = new Map([["core", { x: 0, y: 0 }]]);
  const members = new Map(areas.map((a) => [a.id, []]));
  const apps = [];
  for (const n of allNodes(graph)) {
    if (n.kind === "core") out.set(n.id, { x: 0, y: 0 });
    else if (n.kind === "app") apps.push(n);
    else if (n.kind !== "area" && members.has(n.area)) members.get(n.area).push(n);
  }
  const SP = 9;
  areas.forEach((a, i) => {
    const t = mid(i), list = members.get(a.id);
    const cr = SP * Math.sqrt(list.length + 1);
    const hub = 150, c = hub + cr + 22;
    out.set(allNodes(graph).find((n) => n.kind === "area" && n.area === a.id)?.id ?? "area-" + a.id, { x: hub * Math.cos(t), y: hub * Math.sin(t) });
    list.sort((x, y) => (KIND_ORDER[x.kind] ?? 9) - (KIND_ORDER[y.kind] ?? 9) || (x.entity || "~").localeCompare(y.entity || "~") || (y.degree || 0) - (x.degree || 0));
    list.forEach((n, j) => {
      const r = SP * Math.sqrt(j + 0.5), th = j * 2.39996;
      out.set(n.id, { x: c * Math.cos(t) + r * Math.cos(th), y: c * Math.sin(t) + r * Math.sin(th) });
    });
  });
  const ai = (n) => Math.max(0, areas.findIndex((a) => a.id === n.area));
  apps.sort((x, y) => ai(x) - ai(y) || x.title.localeCompare(y.title));
  apps.forEach((n, i) => { const t = (i / Math.max(1, apps.length)) * 2 * Math.PI - Math.PI / 2; out.set(n.id, { x: 95 * Math.cos(t), y: 95 * Math.sin(t) }); });
  for (const n of allNodes(graph)) if (!out.has(n.id)) out.set(n.id, { x: 0, y: 0 });
  return fit(out);
}

// Links: force-directed from the real links, seeded by the area clusters so each area keeps its place.
export function linksLayout(graph) {
  const seed = areasLayout(graph);
  const nodes = allNodes(graph).map((n) => ({ id: n.id, kind: n.kind, x: seed.get(n.id).x, y: seed.get(n.id).y, ...(n.kind === "core" ? { fx: 0, fy: 0 } : {}) }));
  const ids = new Set(nodes.map((n) => n.id));
  const links = allLinks(graph).filter((l) => ids.has(l.source) && ids.has(l.target)).map((l) => ({ source: l.source, target: l.target, kind: l.kind }));
  const home = new Map(nodes.map((n) => [n.id, { ...seed.get(n.id) }]));
  const sim = forceSimulation(nodes, 2)
    .force("link", forceLink(links).id((n) => n.id).distance((l) => (l.kind === "belongs" || l.kind === "core" ? 60 : 28)).strength((l) => (l.kind === "belongs" ? 0.05 : 0.25)))
    .force("charge", forceManyBody().strength((n) => (n.kind === "area" ? -160 : -22)).distanceMax(220))
    .force("x", forceX((n) => home.get(n.id).x).strength(0.04))
    .force("y", forceY((n) => home.get(n.id).y).strength(0.04))
    .stop();
  for (let i = 0; i < 260; i++) sim.tick();
  return fit(new Map(nodes.map((n) => [n.id, { x: n.x, y: n.y }])));
}
const LAYOUTS = { rings: ringLayout, areas: areasLayout, links: linksLayout };

// Layouts are computed once per graph and cached; the heavy ones are warmed up in idle time,
// so opening a tab never freezes the screen before its transition starts.
const layoutCache = new WeakMap();
export function layoutOf(graph, name) {
  let c = layoutCache.get(graph);
  if (!c) { c = {}; layoutCache.set(graph, c); }
  return (c[name] ??= LAYOUTS[name](graph));
}
export function warmLayouts(graph) {
  const idle = typeof requestIdleCallback === "function" ? requestIdleCallback : (f) => setTimeout(f, 300);
  idle(() => layoutOf(graph, "areas"));
  idle(() => layoutOf(graph, "links"));
}

// Rings: layers as concentric rings (inside out: skills, memory, routines, applications, runs), one angular sector per area.
// Each ring turns slowly at its own speed and direction; it pauses while a node is hovered or selected, and the Gerak button
// (default off with prefers-reduced-motion) turns it off. Positions are written straight to the SVG in a frame loop, not through React.
const SPIN = { skills: 3.2, memory: -1.4, routines: 2.2, apps: -1.8, runs: 4 }; // degrees per second
export function Rings({ graph, visible, selected, onSelect, layerFocus, onLayer, areaFocus, onArea, layout = "rings" }) {
  const spin = layout === "rings";
  const [hover, setHover] = useState(null);
  const [motion, setMotion] = useState(true);
  const color = useMemo(() => new Map(graph.areas.map((a) => [a.id, a.color])), [graph.areas]);
  const target = useMemo(() => layoutOf(graph, layout), [graph, layout]);
  // Switching between Rings, Areas and Links morphs every node from where it is now to its new place (see the effect below).
  // pos = where the layout puts each node; cur = where it is drawn right now. During a morph only cur moves,
  // written straight to the SVG each frame (like the ring rotation), so React never re-renders 1,300 lines per frame.
  const pos = target;
  const cur = useRef(null);
  if (!cur.current) cur.current = new Map(target);
  const nodeRefs = useRef(new Map());
  const moving = useRef(false);
  const layerOf = useMemo(() => new Map(allNodes(graph).map((n) => [n.id, n.layer])), [graph]);
  const lit = useMemo(() => {
    const focus = hover ?? selected;
    if (!focus) return null;
    const set = new Set([focus]);
    for (const l of allLinks(graph)) { if (l.source === focus) set.add(l.target); if (l.target === focus) set.add(l.source); }
    return set;
  }, [graph, hover, selected]);

  const groupRefs = useRef({});
  const lineRefs = useRef([]);
  const pathRefs = useRef({});
  const angle = useRef({});
  const still = useRef(false);
  still.current = hover !== null || selected !== null;
  const focus = hover ?? selected;
  const ok = (l) => visible.has(l.source) && visible.has(l.target) && pos.has(l.source) && pos.has(l.target);
  // Every line starts dim. Declared lines (core, hat) stay faint; the lines of the focused node light up and carry a transfer flow.
  const lines = allLinks(graph).filter((l) => ok(l) && (!spin || ["core", "hat"].includes(l.kind) || (focus && (l.source === focus || l.target === focus))));
  const isHot = (l) => Boolean(focus) && (l.source === focus || l.target === focus);
  const hotLines = lines.filter(isHot);
  const dim = lines.filter((l) => !isHot(l));
  const METEORS = 4;
  const meteors = useRef([]);
  const meteorRefs = useRef([]);
  const flashRefs = useRef([]); // per meteor: [launch flash, arrival flash]
  const pool = useMemo(() => {
    const all = allLinks(graph).filter((l) => l.kind !== "belongs" && ok(l));
    const step = Math.max(1, Math.floor(all.length / 300));
    return all.filter((_, i) => i % step === 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, visible, target]);
  const poolRef = useRef(pool);
  poolRef.current = focus ? pool.filter((l) => l.source === focus || l.target === focus).concat(hotLines) : pool;

  const at = (id) => {
    const p = cur.current.get(id) ?? pos.get(id), a = ((angle.current[layerOf.get(id)] ?? 0) * Math.PI) / 180;
    return { x: p.x * Math.cos(a) - p.y * Math.sin(a), y: p.x * Math.sin(a) + p.y * Math.cos(a) };
  };
  const atRef = useRef(at);
  atRef.current = at;

  const apply = useCallback(() => {
    if (moving.current) for (const [id, el] of nodeRefs.current) { const q = cur.current.get(id); if (el && q) el.setAttribute("transform", `translate(${q.x} ${q.y})`); }
    for (const [layer, el] of Object.entries(groupRefs.current)) el?.setAttribute("transform", `rotate(${angle.current[layer] ?? 0})`);
    // Dim lines are drawn as one path per color (1,300 lines would be 1,300 DOM nodes); lit lines stay single, for the glow.
    const seg = (l) => { const s = at(l.source), t = at(l.target); return `M${s.x.toFixed(1)} ${s.y.toFixed(1)}L${t.x.toFixed(1)} ${t.y.toFixed(1)}`; };
    for (const [kind, el] of Object.entries(pathRefs.current)) el?.setAttribute("d", dim.filter((l) => (l.kind === "hat") === (kind === "hat")).map(seg).join(""));
    lineRefs.current.forEach((el, i) => {
      const l = hotLines[i];
      if (!el || !l) return;
      const s = at(l.source), t = at(l.target);
      el.setAttribute("x1", s.x); el.setAttribute("y1", s.y); el.setAttribute("x2", t.x); el.setAttribute("y2", t.y);
    });
  });
  useLayoutEffect(() => { apply(); }); // after every render, so a re-render never snaps rings back
  useEffect(() => {
    if (!motion) { meteorRefs.current.forEach((g) => g?.setAttribute("visibility", "hidden")); flashRefs.current.flat().forEach((c) => c?.setAttribute("visibility", "hidden")); return undefined; }
    let raf = 0, last = performance.now();
    const fresh = (i) => ({ link: null, t: -i * 0.35, speed: 0.22 + Math.random() * 0.25 });
    if (meteors.current.length !== METEORS) meteors.current = Array.from({ length: METEORS }, (_, i) => fresh(i));
    const tick = (now) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (spin && !still.current) for (const [layer, v] of Object.entries(SPIN)) angle.current[layer] = ((angle.current[layer] ?? 0) + v * dt) % 360;
      if (spin) apply();
      meteors.current.forEach((m, i) => {
        const g = meteorRefs.current[i];
        if (!g) return;
        m.t += m.speed * dt;
        if (m.link === null || m.t > 1.15) {
          const list = poolRef.current;
          m.link = list.length ? list[Math.floor(Math.random() * list.length)] : null;
          m.t = m.link ? -Math.random() * 0.4 : 0;
          m.speed = 0.22 + Math.random() * 0.25;
          if (m.link && Math.random() < 0.5) m.link = { source: m.link.target, target: m.link.source };
        }
        const l = m.link;
        // The sender twinkles as the meteor leaves, the receiver as it lands.
        const [fa, fb] = flashRefs.current[i] ?? [];
        const twinkle = 0.7 + 0.3 * Math.sin(now / 45 + i * 1.7);
        const flash = (el, id, k) => {
          if (!el) return;
          if (!l || k <= 0 || !pos.has(id)) { el.setAttribute("visibility", "hidden"); return; }
          const c = atRef.current(id);
          el.setAttribute("cx", c.x); el.setAttribute("cy", c.y);
          el.setAttribute("r", 6 + 10 * (1 - k));
          el.setAttribute("opacity", (k * twinkle).toFixed(3));
          el.setAttribute("visibility", "visible");
        };
        flash(fa, l?.source, 1 - Math.abs(m.t) / 0.22);
        flash(fb, l?.target, 1 - Math.abs(m.t - 1) / 0.18);
        if (!l || m.t < 0 || m.t > 1 || !pos.has(l.source) || !pos.has(l.target)) { g.setAttribute("visibility", "hidden"); return; }
        const s = atRef.current(l.source), e = atRef.current(l.target);
        const q = (u) => ({ x: s.x + (e.x - s.x) * u, y: s.y + (e.y - s.y) * u });
        const head = q(m.t), tail = q(Math.max(0, m.t - 0.16));
        const [ln, dot] = g.children;
        ln.setAttribute("x1", tail.x); ln.setAttribute("y1", tail.y); ln.setAttribute("x2", head.x); ln.setAttribute("y2", head.y);
        dot.setAttribute("cx", head.x); dot.setAttribute("cy", head.y);
        g.setAttribute("visibility", "visible");
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [motion, apply]);

  // Zoom and pan: the viewBox is the camera. Wheel zooms toward the pointer, dragging the background pans.
  const [cam, setCam] = useState({ k: 1, x: 0, y: 0 });
  const svgRef = useRef(null);
  const drag = useRef(null);
  const zoomAt = useCallback((factor, sx = 0, sy = 0) => setCam((c) => {
    const k = Math.min(8, Math.max(0.5, c.k * factor));
    const f = k / c.k;
    return { k, x: sx - (sx - c.x) / f, y: sy - (sy - c.y) / f };
  }), []);
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const side = Math.min(r.width, r.height);
      setCam((c) => {
        const wx = c.x + ((e.clientX - r.left - r.width / 2) / side) * (860 / c.k);
        const wy = c.y + ((e.clientY - r.top - r.height / 2) / side) * (860 / c.k);
        const k = Math.min(8, Math.max(0.5, c.k * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
        const f = k / c.k;
        return { k, x: wx - (wx - c.x) / f, y: wy - (wy - c.y) / f };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);
  // Layout change: bake the current ring rotation into the start positions, then ease every node and the camera to the new layout.
  const morph = useRef(0);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return undefined; }
    const from = new Map();
    for (const id of target.keys()) from.set(id, pos.has(id) ? atRef.current(id) : { x: 0, y: 0 });
    angle.current = {};
    const c0 = camRef.current, t0 = performance.now(), D = 1400;
    moving.current = true;
    cancelAnimationFrame(morph.current);
    const ease = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
    const step = (now) => {
      const u = Math.min(1, (now - t0) / D), e = ease(u);
      for (const [id, b] of target) { const a = from.get(id); cur.current.set(id, { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e }); }
      apply();
      view({ k: c0.k + (1 - c0.k) * e, x: c0.x * (1 - e), y: c0.y * (1 - e) });
      if (u < 1) morph.current = requestAnimationFrame(step);
      else { moving.current = false; cur.current = new Map(target); setCam(camRef.current); }
    };
    morph.current = requestAnimationFrame(step);
    return () => { cancelAnimationFrame(morph.current); moving.current = false; cur.current = new Map(target); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  // Clicking a node flies the camera to it (rotation is paused while selected, so the target holds still); clearing flies back.
  const flight = useRef(0);
  const wasSel = useRef(false);
  const camRef = useRef(cam);
  camRef.current = cam;
  // Camera moves during animations go straight to the viewBox; React state catches up once at the end.
  const view = (c) => { camRef.current = c; const h = 430 / c.k; svgRef.current?.setAttribute("viewBox", `${c.x - h} ${c.y - h} ${h * 2} ${h * 2}`); };
  useEffect(() => {
    let to = null;
    if (selected && pos.has(selected)) { const p = atRef.current(selected); to = { k: 3.2, x: p.x, y: p.y }; wasSel.current = true; }
    else if (wasSel.current) { to = { k: 1, x: 0, y: 0 }; wasSel.current = false; }
    if (!to) return undefined;
    const from = camRef.current, t0 = performance.now();
    cancelAnimationFrame(flight.current);
    const step = (now) => {
      const u = Math.min(1, (now - t0) / 900), e = 1 - Math.pow(1 - u, 3);
      view({ k: from.k + (to.k - from.k) * e, x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e });
      if (u < 1) flight.current = requestAnimationFrame(step);
      else setCam(camRef.current);
    };
    flight.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(flight.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);
  const onDown = (e) => { drag.current = { x: e.clientX, y: e.clientY, moved: 0 }; };
  const onMove = (e) => {
    const d = drag.current;
    if (!d || !(e.buttons & 1)) return;
    const r = svgRef.current.getBoundingClientRect();
    const side = Math.min(r.width, r.height);
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    d.x = e.clientX; d.y = e.clientY; d.moved += Math.abs(dx) + Math.abs(dy);
    setCam((c) => ({ ...c, x: c.x - (dx / side) * (860 / c.k), y: c.y - (dy / side) * (860 / c.k) }));
  };
  const onClickCapture = (e) => { if (drag.current?.moved > 4) { e.stopPropagation(); } drag.current = null; };
  const half = 430 / cam.k;
  const nodes = allNodes(graph).filter((n) => visible.has(n.id) && pos.has(n.id));
  // Area labels point away from the core. Two small neighbouring areas can still meet, so a label that would overlap
  // one already placed moves further out until it is clear (boxes are estimated from the text length).
  const labels = useMemo(() => {
    const out = new Map(), boxes = [];
    for (const n of allNodes(graph).filter((x) => x.kind === "area" && target.has(x.id))) {
      const p = target.get(n.id), h = Math.hypot(p.x, p.y) || 1, ux = p.x / h, uy = p.y / h;
      const text = `${n.title} ${graph.areas.find((a) => a.id === n.area)?.count ?? ""}`;
      const anchor = Math.abs(ux) < 0.3 ? "middle" : ux > 0 ? "start" : "end";
      const w = text.length * 5.2;
      let d = 0, box;
      for (let tries = 0; tries < 8; tries++) {
        const lx = ux * (radius(n) + 5 + d), ly = uy * (radius(n) + 9 + d) + 3;
        const x0 = p.x + lx - (anchor === "middle" ? w / 2 : anchor === "end" ? w : 0);
        box = { lx, ly, x0, x1: x0 + w, y0: p.y + ly - 9, y1: p.y + ly + 2 };
        if (!boxes.some((b) => box.x0 < b.x1 && b.x0 < box.x1 && box.y0 < b.y1 && b.y0 < box.y1)) break;
        d += 11;
      }
      boxes.push(box);
      out.set(n.id, { x: box.lx, y: box.ly, anchor, text });
    }
    return out;
  }, [graph, target]);

  const draw = (n) => {
    const p = pos.get(n.id), q = cur.current.get(n.id) ?? p;
    const c = n.kind === "core" ? "#e2e8f0" : color.get(n.area) ?? "#94a3b8";
    const label = n.kind === "area" || n.kind === "core";
    return (
      <g key={n.id} ref={(el) => { if (el) nodeRefs.current.set(n.id, el); else nodeRefs.current.delete(n.id); }} transform={`translate(${q.x} ${q.y})`} onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)}>
        <Shape kind={n.kind} x={0} y={0} r={radius(n)} fill={c} stroke={selected === n.id ? "#fff" : null} dim={lit && !lit.has(n.id)}
          onClick={() => onSelect(n.id)}
          letter={n.kind === "area" ? n.title[0]?.toUpperCase() : undefined}
          title={`${n.title} · ${KIND_LABEL[n.kind] ?? n.kind} · ${[n.area || "core", n.entity, n.kind === "file" ? n.type : ""].filter(Boolean).join(" › ")}`} />
        {label && (() => {
          const core = n.kind === "core", L = labels.get(n.id) ?? { x: 0, y: radius(n) + 12, anchor: "middle", text: n.title };
          return <text x={core ? 0 : L.x} y={core ? 30 : L.y} textAnchor={core ? "middle" : L.anchor} fontSize={core ? 11 : 9} fontWeight="600" className="fill-foreground pointer-events-none" style={{ paintOrder: "stroke", stroke: "var(--background)", strokeWidth: 3, strokeLinejoin: "round" }}>{core ? n.title : L.text}</text>;
        })()}
      </g>
    );
  };

  return (
    <>
      <svg ref={svgRef} viewBox={`${cam.x - half} ${cam.y - half} ${half * 2} ${half * 2}`} className="absolute inset-0 size-full cursor-grab touch-none select-none" role="img" aria-label={layout} onPointerDown={onDown} onPointerMove={onMove} onClickCapture={onClickCapture}>
        <defs>
          <radialGradient id="brain-shine" cx="35%" cy="30%" r="75%"><stop offset="0" stopColor="#fff" stopOpacity=".55" /><stop offset=".45" stopColor="#fff" stopOpacity=".04" /><stop offset="1" stopColor="#000" stopOpacity=".45" /></radialGradient>
          <filter id="brain-glow" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="3" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
        </defs>
        {spin && Object.entries(RING).map(([layer, r]) => (
          <g key={layer} onClick={() => onLayer(layerFocus === layer ? null : layer)} style={{ cursor: "pointer" }}>
            <circle r={r} fill="none" stroke="currentColor" strokeOpacity={layerFocus === layer ? 0.5 : 0.1} strokeDasharray="3 5" />
            <text x={0} y={-r - 3} textAnchor="middle" className="fill-muted-foreground" fontSize="9" letterSpacing="2">{(graph.layers.find((l) => l.id === layer)?.label ?? layer).toUpperCase()}</text>
          </g>
        ))}
        <path ref={(el) => { pathRefs.current.plain = el; }} fill="none" stroke="currentColor" strokeWidth="0.8" strokeOpacity="0.1" pointerEvents="none" />
        <path ref={(el) => { pathRefs.current.hat = el; }} fill="none" stroke="#fbbf24" strokeWidth="0.8" strokeOpacity="0.22" pointerEvents="none" />
        {hotLines.map((l, i) => <line key={l.source + l.target + l.kind} ref={(el) => { lineRefs.current[i] = el; }} stroke="var(--primary)" strokeWidth={1.6} strokeOpacity={0.95} />)}
        {Object.keys(SPIN).map((layer) => <g key={layer} ref={(el) => { groupRefs.current[layer] = el; }}>{nodes.filter((n) => n.layer === layer && n.kind !== "area" && n.kind !== "core").map(draw)}</g>)}
        {nodes.filter((n) => n.kind === "area" || n.kind === "core").map(draw)}
        {Array.from({ length: 4 }, (_, i) => [0, 1].map((j) => (
          <circle key={`f${i}${j}`} ref={(el) => { (flashRefs.current[i] ??= [])[j] = el; }} visibility="hidden" pointerEvents="none" fill="#fff" filter="url(#brain-glow)" />
        )))}
        {Array.from({ length: 4 }, (_, i) => (
          <g key={i} ref={(el) => { meteorRefs.current[i] = el; }} visibility="hidden" pointerEvents="none" filter="url(#brain-glow)">
            <line stroke="#fff" strokeOpacity=".75" strokeWidth="2" strokeLinecap="round" />
            <circle r="3" fill="#fff" />
          </g>
        ))}
      </svg>
      <div className="absolute top-3 right-3 z-10 flex gap-1 text-xs">
        <button type="button" aria-label="Perbesar" onClick={() => zoomAt(1.4)} className="rounded-lg border bg-card/85 px-2 py-1">+</button>
        <button type="button" aria-label="Perkecil" onClick={() => zoomAt(1 / 1.4)} className="rounded-lg border bg-card/85 px-2 py-1">−</button>
        <button type="button" aria-label="Setel ulang zoom" onClick={() => setCam({ k: 1, x: 0, y: 0 })} className="rounded-lg border bg-card/85 px-2 py-1">{Math.round(cam.k * 100)}%</button>
        <button type="button" aria-pressed={motion} aria-label={motion ? "Jeda" : "Putar"} title={motion ? "Jeda" : "Putar"} onClick={() => setMotion((m) => !m)} className={cn("rounded-lg border px-2 py-1", motion ? "bg-primary text-primary-foreground" : "bg-card/85")}>{motion ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}</button>
      </div>
    </>
  );
}

// Timeline: one column per day. Top: each routine's runs; bottom: files stacked on the day they last changed. Same shapes and colors as the graphs.
export function TimelineView({ graph, visible, onSelect }) {
  const DAYS = 35, X0 = 190, W = 1000, COL = (W - X0 - 20) / DAYS, ROW = 22;
  const day0 = new Date(); day0.setHours(24, 0, 0, 0); // start of tomorrow, so today is day 0
  const dayOf = (ms) => Math.floor((day0.getTime() - ms) / 86400000);
  const xOf = (d) => X0 + (DAYS - 1 - d) * COL + COL / 2;
  const color = new Map(graph.areas.map((a) => [a.id, a.color]));
  const nodes = allNodes(graph);
  const routines = nodes.filter((n) => n.kind === "routine" && visible.has(n.id)).sort((a, b) => a.title.localeCompare(b.title));
  const runs = nodes.filter((n) => n.kind === "run" && visible.has(n.id));
  const files = nodes.filter((n) => n.kind === "file" && visible.has(n.id) && n.updated);
  const yR = 60, yF = yR + routines.length * ROW + 40;
  const stacks = new Map();
  for (const f of files.sort((a, b) => a.area.localeCompare(b.area))) { const d = dayOf(f.updated); if (d >= 0 && d < DAYS) { if (!stacks.has(d)) stacks.set(d, []); stacks.get(d).push(f); } }
  const tallest = Math.max(1, ...[...stacks.values()].map((l) => l.length));
  const H = yF + 20 + tallest * 11 + 20;
  const days = Array.from({ length: DAYS }, (_, d) => { const t = new Date(day0.getTime() - (d + 1) * 86400000 + 3600000); return { d, t, monday: t.getDay() === 1 }; });
  const runColor = (r) => (r.status === "OK" ? color.get(r.area) ?? "#94a3b8" : r.status === "SKIP" ? "#64748b" : "#ef4444");
  let k = 0;
  return (
    <div className="absolute inset-0 overflow-auto pl-52">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[720px]" role="img" aria-label="Timeline">
        <defs><filter id="tl-glow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="2" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter></defs>
        {days.map(({ d, t, monday }) => (
          <g key={d}>
            <line x1={xOf(d)} x2={xOf(d)} y1={36} y2={H - 10} stroke="currentColor" strokeOpacity={monday ? 0.16 : 0.05} />
            {monday && <text x={xOf(d)} y={28} textAnchor="middle" fontSize="9" className="fill-muted-foreground font-mono">{`Sen ${String(t.getDate()).padStart(2, "0")}.${String(t.getMonth() + 1).padStart(2, "0")}`}</text>}
          </g>
        ))}
        <line x1={xOf(0)} x2={xOf(0)} y1={20} y2={H - 10} stroke="var(--primary)" strokeWidth="1.5" className="brain-glow" />
        <text x={xOf(0)} y={14} textAnchor="middle" fontSize="9" fill="var(--primary)" className="font-mono">today</text>
        <text x={X0 - 14} y={yR - 20} textAnchor="end" fontSize="10" fontWeight="700" fill="#fbbf24">RUTINITAS · run per hari</text>
        {routines.map((r, i) => {
          const y = yR + i * ROW;
          const own = runs.filter((x) => x.title.startsWith(r.title + " "));
          return (
            <g key={r.id}>
              <line x1={X0} x2={W - 20} y1={y} y2={y} stroke="currentColor" strokeOpacity="0.05" />
              <text x={X0 - 22} y={y + 3} textAnchor="end" fontSize="10" className="fill-foreground font-mono cursor-pointer" onClick={() => onSelect(r.id)}>{r.title}</text>
              <Shape kind="routine" x={X0 - 11} y={y} r={4} fill={color.get(r.area) ?? "#94a3b8"} onClick={() => onSelect(r.id)} title={r.title} />
              {own.map((x) => { const d = dayOf(x.updated); return d >= 0 && d < DAYS ? (
                <g key={x.id} className="brain-pop" style={{ "--i": k++ % 40, transformBox: "fill-box", transformOrigin: "center" }} filter={d === 0 ? "url(#tl-glow)" : undefined}>
                  <Shape kind="run" x={xOf(d)} y={y} r={3.5} fill={runColor(x)} onClick={() => onSelect(x.id)} title={`${x.title} ${x.status}`} />
                </g>) : null; })}
            </g>
          );
        })}
        {routines.length === 0 && <text x={X0} y={yR} fontSize="10" className="fill-muted-foreground">Tidak ada rutinitas.</text>}
        <line x1={20} x2={W - 20} y1={yF - 14} y2={yF - 14} stroke="currentColor" strokeOpacity="0.12" />
        <text x={X0 - 14} y={yF} textAnchor="end" fontSize="10" fontWeight="700" fill="#a78bfa">BERKAS · menurut perubahan</text>
        {[...stacks].map(([d, list]) => list.map((f, j) => (
          <g key={f.id} className="brain-pop" style={{ "--i": (j + d) % 40, transformBox: "fill-box", transformOrigin: "center" }}>
            <Shape kind="file" x={xOf(d)} y={yF + 16 + j * 11} r={3.6} fill={color.get(f.area) ?? "#94a3b8"} onClick={() => onSelect(f.id)} title={`${f.title} · ${new Date(f.updated).toISOString().slice(0, 10)}`} />
          </g>
        )))}
      </svg>
    </div>
  );
}

export function ExtraCard({ node, graph, onClose }) {
  const area = graph.areas.find((a) => a.id === node.area);
  return (
    <aside className="absolute inset-y-3 right-3 z-10 w-[min(22rem,calc(100%-1.5rem))] overflow-auto rounded-xl border bg-card/95 p-3 text-[13px] backdrop-blur">
      <div className="flex items-start gap-2">
        <div className="grid gap-1">
          <span className="eyebrow">{KIND_LABEL[node.kind]} · {node.layer}{area ? ` · ${area.label}` : ""}{node.entity ? ` › ${node.entity}` : ""}</span>
          <h3 className="font-heading text-base font-bold">{node.title}</h3>
          <code className="break-all text-xs text-muted-foreground">{node.path}</code>
        </div>
        <button type="button" className="ml-auto text-muted-foreground" aria-label="Tutup" onClick={onClose}>×</button>
      </div>
      {node.summary && <p className="mt-2 text-muted-foreground">{node.summary}</p>}
      {node.hat && <p className="mt-2 text-xs">hat: {node.hat}</p>}
      <button type="button" className="mt-3 rounded border px-2 py-1 text-xs hover:bg-accent" onClick={() => navigator.clipboard?.writeText(node.path).catch(() => {})}>Salin path</button>
    </aside>
  );
}
