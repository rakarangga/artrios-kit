// Brain (B): the knowledge graph of the sources in data/brain.config.json, drawn in 3D.
// The WebGL library loads only when this screen opens, so the rest of the app stays light.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { SlidePanel } from "@/components/slide-panel";
import { AlertTriangle, BrainCog, ChevronDown, Pause, Play, FolderOpen, Maximize2, Minimize2, LoaderCircle, RefreshCw, RotateCw, Search, X, Crosshair, ListTree } from "lucide-react";
import { api } from "../api.js";
import { Markdown } from "../markdown.jsx";
import { T } from "../texts.js";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FIELD_FULL, PageHeader } from "@/components/field";
import { allLinks, allNodes, ExtraCard, radius, warmLayouts, ringLayout, Rings, shapeCanvas, RING, TimelineView } from "./BrainLayers.jsx";

const MODES = [["rings", "Rings"], ["areas", "Areas"], ["links", "Links"], ["timeline", "Timeline"], ["orbit", "3D Orbit"]];

const ago = (ms, S) => {
  if (!ms) return "";
  const days = Math.floor((Date.now() - ms) / 86400000);
  return days <= 0 ? S.today : days === 1 ? S.yesterday : S.daysAgo(days);
};
const FLAGS = ["stale", "orphan", "stub", "broken-links"];

// three.js wants a real color string, and the theme tokens may be in any CSS color form.
// The canvas turns any CSS color form (oklch included, which three.js cannot read) into rgb.
const toRgb = (c) => {
  const x = document.createElement("canvas").getContext("2d");
  x.fillStyle = c; x.fillRect(0, 0, 1, 1);
  const [r, g, b] = x.getImageData(0, 0, 1, 1).data;
  return `rgb(${r}, ${g}, ${b})`;
};
const cssColor = (name, fallback) => toRgb(getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback);
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function useGraph() {
  const [state, setState] = useState({ graph: null, error: "", code: 0, loading: true });
  const load = useCallback(async (rebuild = false) => {
    setState((s) => ({ ...s, loading: true, error: "" }));
    try { setState({ graph: await api.brainGraph(rebuild), error: "", code: 0, loading: false }); } catch (e) { setState({ graph: null, error: e.message, code: e.status, loading: false }); }
  }, []);
  useEffect(() => { load(); }, [load]);
  return { ...state, load };
}

function SearchBox({ nodes, onPick }) {
  const S = T.views.brain;
  const [q, setQ] = useState("");
  const hits = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return [];
    return nodes.filter((n) => n.title.toLowerCase().includes(t) || n.path.toLowerCase().includes(t) || n.tags.some((g) => g.toLowerCase().includes(t))).slice(0, 8);
  }, [q, nodes]);
  return (
    <div className="relative w-full sm:w-64">
      <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
      <input className={cn(FIELD_FULL, "pl-8")} type="search" aria-label={S.search} placeholder={S.search} value={q} onChange={(e) => setQ(e.target.value)} />
      {hits.length > 0 && (
        <ul className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-xl border bg-popover p-1 shadow-lg">
          {hits.map((n) => (
            <li key={n.id}>
              <button type="button" className="grid w-full rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-accent" onClick={() => { onPick(n.id); setQ(""); }}>
                <span className="truncate">{n.title}</span>
                <span className="truncate text-xs text-muted-foreground">{n.path}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Legend({ sources, active, onToggle, attention, onAttention }) {
  const S = T.views.brain;
  return (
    <div className="absolute top-3 left-3 z-10 grid max-h-[calc(100%-1.5rem)] max-w-56 gap-1 overflow-auto rounded-xl border bg-card/85 p-2 text-xs backdrop-blur">
      {sources.map((s) => (
        <label key={s.id} className={cn("flex cursor-pointer items-center gap-2 rounded px-1 py-0.5", !active.has(s.id) && "opacity-45")}>
          <input type="checkbox" className="sr-only" checked={active.has(s.id)} onChange={() => onToggle(s.id)} />
          <span className="size-2.5 shrink-0 rounded-full" style={{ background: s.color }} aria-hidden="true" />
          <span className="truncate">{s.label}</span>
          <span className="ml-auto pl-2 font-mono text-muted-foreground">{s.count}</span>
        </label>
      ))}
      <label className="mt-1 flex cursor-pointer items-center gap-2 border-t px-1 pt-1.5">
        <input type="checkbox" checked={attention} onChange={(e) => onAttention(e.target.checked)} />
        <span>{S.attentionOnly}</span>
      </label>
    </div>
  );
}

function NotePanel({ graph, id, onClose, onPick, onFocus, onAsk }) {
  const S = T.views.brain;
  const node = graph.nodes.find((n) => n.id === id);
  const [note, setNote] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setNote(null); setError("");
    let alive = true;
    api.brainNode(id).then((r) => { if (alive) setNote(r); }).catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [id]);
  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);
  const neighbours = useMemo(() => graph.links.flatMap((l) => (l.source === id ? [{ id: l.target, kind: l.kind }] : l.target === id ? [{ id: l.source, kind: l.kind }] : [])), [graph, id]);
  if (!node) return null;
  const source = graph.sources.find((s) => s.id === node.source);

  return (
    <aside aria-label={node.title} className="absolute inset-y-3 right-3 z-10 flex w-[min(26rem,calc(100%-1.5rem))] flex-col overflow-hidden rounded-xl border bg-card/95 backdrop-blur">
      <div className="flex items-start gap-2 border-b p-3">
        <div className="grid min-w-0 gap-1">
          <span className="eyebrow flex items-center gap-1.5"><span className="size-2 rounded-full" style={{ background: source?.color }} aria-hidden="true" />{source?.label}</span>
          <h3 className="font-heading text-base leading-snug font-bold">{node.title}</h3>
          <code className="break-all text-xs text-muted-foreground">{node.path}</code>
          {node.area !== undefined && <p className="text-xs text-muted-foreground">{[graph.areas?.find((a) => a.id === node.area)?.label ?? node.area, node.entity || "tanpa entitas", node.type].filter(Boolean).join(" › ")}</p>}
        </div>
        <Button className="ml-auto shrink-0" size="icon-sm" variant="ghost" aria-label={S.close} onClick={onClose}><X className="size-4" /></Button>
      </div>
      <div className="grid gap-3 overflow-auto p-3 text-[13px]">
        <p className="text-xs text-muted-foreground">{S.meta(node.words, ago(node.updated, S), node.degree)}</p>
        <div className="flex flex-wrap gap-1">
          {node.flags.length === 0 && <Badge variant="outline" className="text-positive">{S.healthy}</Badge>}
          {node.flags.map((f) => <Badge key={f} variant="outline" className="text-warning">{S.flags[f].title}</Badge>)}
          {node.tags.map((t) => <Badge key={t} variant="outline">{t}</Badge>)}
        </div>
        <div className="flex flex-wrap gap-1">
          <Button size="sm" variant="outline" onClick={() => onFocus(id)}><Crosshair className="size-3.5" /> {S.focus}</Button>
          <Button size="sm" variant="outline" onClick={() => api.brainReveal(id).catch((e) => setError(e.message))}><FolderOpen className="size-3.5" /> {S.reveal}</Button>
          {onAsk && <Button size="sm" variant="outline" onClick={() => onAsk({ title: node.title, file: note?.file ?? node.path, hat: node.client || "", node: id })}><BrainCog className="size-3.5" /> Cognition</Button>}
        </div>
        {neighbours.length > 0 && (
          <section className="grid gap-1">
            <h4 className="eyebrow">{S.connections} ({neighbours.length})</h4>
            <ul className="grid gap-0.5">
              {neighbours.map((n) => (
                <li key={n.id}>
                  <button type="button" className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-accent" onClick={() => onPick(n.id)}>
                    <span className="truncate">{byId.get(n.id)?.title}</span>
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">{S.linkKind[n.kind]}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        {node.broken.length > 0 && (
          <section className="grid gap-1">
            <h4 className="eyebrow">{S.brokenLinks} ({node.broken.length})</h4>
            <ul className="grid gap-0.5 text-xs text-warning">{node.broken.map((b) => <li key={b} className="break-all"><code>{b}</code></li>)}</ul>
          </section>
        )}
        <section className="grid gap-1 border-t pt-3">
          {error && <p className="text-destructive">{error}</p>}
          {!note && !error && <LoaderCircle className="size-4 animate-spin" />}
          {note && <Markdown text={note.markdown} />}
        </section>
      </div>
    </aside>
  );
}

function Inventory({ graph, onPick, onClose }) {
  const S = T.views.brain;
  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);
  const Row = ({ n, hint }) => (
    <li>
      <button type="button" className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-[13px] hover:bg-accent" onClick={() => onPick(n.id)}>
        <span className="truncate">{n.title}</span>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">{hint}</span>
      </button>
    </li>
  );
  return (
    <aside aria-label={S.inventory} className="absolute inset-y-3 right-3 z-10 flex w-[min(30rem,calc(100%-1.5rem))] flex-col overflow-hidden rounded-xl border bg-card/95 backdrop-blur">
      <div className="flex items-center gap-2 border-b p-3">
        <h3 className="font-heading text-base font-bold">{S.inventory}</h3>
        <Button className="ml-auto" size="icon-sm" variant="ghost" aria-label={S.close} onClick={onClose}><X className="size-4" /></Button>
      </div>
      <div className="grid gap-4 overflow-auto p-3 text-[13px]">
        <p className="text-muted-foreground">{S.totals(graph.totals.notes, graph.totals.links, graph.totals.words)}</p>
        {graph.warnings.length > 0 && (
          <ul className="grid gap-1 rounded-lg border border-warning/40 p-2 text-xs text-warning">
            {graph.warnings.map((w) => <li key={w} className="flex gap-1.5 break-words"><AlertTriangle className="mt-0.5 size-3 shrink-0" />{w}</li>)}
          </ul>
        )}
        <section className="grid gap-1">
          <h4 className="eyebrow">{S.sources}</h4>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-left text-muted-foreground"><tr><th className="py-1 font-medium">{S.source}</th><th className="px-2 text-right font-medium">{S.notes}</th><th className="px-2 text-right font-medium">{S.needAttention}</th><th className="text-right font-medium">{S.newest}</th></tr></thead>
              <tbody>
                {graph.sources.map((s) => (
                  <tr key={s.id} className="border-t">
                    <td className="py-1"><span className="flex items-center gap-1.5"><span className="size-2 shrink-0 rounded-full" style={{ background: s.color }} aria-hidden="true" />{s.label}</span></td>
                    <td className="px-2 text-right font-mono">{s.count}</td>
                    <td className={cn("px-2 text-right font-mono", s.flagged > 0 && "text-warning")}>{s.flagged}</td>
                    <td className="whitespace-nowrap text-right text-muted-foreground">{ago(s.newest, S)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section className="grid gap-1">
          <h4 className="eyebrow">{S.health}</h4>
          {FLAGS.map((f) => {
            const list = graph.nodes.filter((n) => n.flags.includes(f));
            return (
              <details key={f} className="group rounded-lg border px-2 py-1">
                <summary className="flex cursor-pointer list-none items-center gap-2">
                  <ChevronDown className="size-3.5 shrink-0 transition-transform group-open:rotate-180" />
                  <span className="grid"><span>{S.flags[f].title}</span><span className="text-xs text-muted-foreground">{S.flags[f].hint}</span></span>
                  <span className={cn("ml-auto font-mono", list.length > 0 && "text-warning")}>{list.length}</span>
                </summary>
                <ul className="mt-1 grid max-h-52 gap-0.5 overflow-auto">{list.map((n) => <Row key={n.id} n={n} hint={ago(n.updated, S)} />)}</ul>
              </details>
            );
          })}
        </section>
        {graph.hubs.length > 0 && (
          <section className="grid gap-1">
            <h4 className="eyebrow">{S.hubs}</h4>
            <ul className="grid gap-0.5">{graph.hubs.map((id) => byId.get(id)).filter(Boolean).map((n) => <Row key={n.id} n={n} hint={S.linkCount(n.degree)} />)}</ul>
          </section>
        )}
        {graph.indexes.length > 0 && (
          <details>
            <summary className="eyebrow cursor-pointer">{S.indexes} ({graph.indexes.length})</summary>
            <ul className="mt-1 grid gap-0.5 text-xs text-muted-foreground">{graph.indexes.map((i) => <li key={i.path} className="break-all">{i.path}</li>)}</ul>
          </details>
        )}
      </div>
    </aside>
  );
}

// Rings position made round: same angle and radius, lifted onto a sphere. Applications stay on the equator.
const hash = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return ((h >>> 0) % 1000) / 1000; };
function orbitPos(n, p) {
  if (!p) return {};
  const r = Math.hypot(p.x, p.y) * (n.kind === "area" ? 2.6 : 1), t = Math.atan2(p.y, p.x);
  const lat = n.kind === "app" || n.kind === "core" ? 0 : n.kind === "area" ? (hash(n.id) - 0.5) * 0.5 : (hash(n.id) - 0.5) * 1.5;
  const x = r * Math.cos(lat) * Math.cos(t), y = r * Math.sin(lat), z = r * Math.cos(lat) * Math.sin(t);
  return { x, y, z, fx: x, fy: y, fz: z };
}

function Canvas({ graph, visible, selected, rotate, onSelect, onReady, onFail }) {
  const flat = useMemo(() => (graph.extra ? ringLayout(graph) : new Map()), [graph]);
  const host = useRef(null);
  const fg = useRef(null);
  const { resolvedTheme } = useTheme();
  const [scene, setScene] = useState(0); // counts scenes, so the paint effect runs once one exists
  const [shown, setShown] = useState(false); // the canvas fades in only once the first frame is drawn
  const latest = useRef({});
  latest.current = { visible, selected, onSelect };

  // Neighbours of the selected note stay lit; everything else dims.
  const lit = useMemo(() => {
    if (!selected) return null;
    const set = new Set([selected]);
    for (const l of allLinks(graph)) {
      if (l.source === selected) set.add(l.target);
      if (l.target === selected) set.add(l.source);
    }
    return set;
  }, [graph, selected]);
  // Same colors as the Rings: area color for layered data, source color for plain notes.
  const colorOf = useMemo(() => {
    const m = new Map(graph.sources.map((s) => [s.id, s.color]));
    for (const a of graph.areas ?? []) m.set("area:" + a.id, a.color);
    return m;
  }, [graph]);
  const nodeColor = useCallback((n) => (n.kind === "core" ? "#e2e8f0" : (graph.extra ? colorOf.get("area:" + n.area) : null) ?? colorOf.get(n.source) ?? "#94a3b8"), [graph, colorOf]);

  useEffect(() => {
    let dead = false;
    let observer = null;
    let instance = null;
    Promise.all([import("3d-force-graph"), import("three")]).then(([{ default: ForceGraph3D }, THREE]) => {
      if (dead || !host.current) return;
      instance = new ForceGraph3D(host.current, { controlType: "orbit" });
      const layered = Boolean(graph.extra);
      const textures = new Map();
      fg.current = instance;
      instance
        .showNavInfo(false)
        .nodeId("id")
        .nodeLabel((n) => `<div class="brain-tip"><b>${escapeHtml(n.title)}</b><br>${escapeHtml(n.path)}</div>`)
        .nodeVal((n) => 1 + Math.sqrt(n.degree || 0) * 2)
        .nodeOpacity(0.92)
        .nodeResolution(12)
        // Layered data looks like the Rings, made round: same shapes and colors, labels on the core and the areas.
        .nodeThreeObject(layered ? (n) => {
          const named = n.kind === "core" || n.kind === "area";
          const label = n.kind === "area" ? `${n.title.toUpperCase()} ${graph.areas.find((a) => a.id === n.area)?.count ?? ""}` : n.kind === "core" ? n.title : "";
          // One texture per shape, color and label, shared by every sprite that looks the same.
          const cv = shapeCanvas(n.kind, nodeColor(n), named ? label : "");
          let tex = textures.get(cv);
          if (!tex) { tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; textures.set(cv, tex); }
          const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
          const k = radius(n) * 2.4;
          if (named) { sp.scale.set(k * 8, k, 1); sp.center.set(1 / 16, 0.5); } else sp.scale.set(k, k, 1);
          return sp;
        } : null)
        .cooldownTicks(layered ? 0 : Infinity)
        .linkOpacity(0.12)
        .linkDirectionalParticleWidth(2.2)
        .linkDirectionalParticleSpeed(0.012)
        .enableNodeDrag(false)
        .onNodeClick((n) => latest.current.onSelect(n.id))
        .onBackgroundClick(() => latest.current.onSelect(null))
        // A copy: the library rewrites source and target into objects, and React state must stay as it came.
        .graphData({ nodes: allNodes(graph).map((n) => ({ ...n, ...(layered ? orbitPos(n, flat.get(n.id)) : {}) })), links: allLinks(graph).map((l) => ({ ...l })) });
      if (layered) {
        // A thin wire sphere: the applications ring on the equator, two tilted great circles, and the inner layers.
        const wire = new THREE.Group();
        const loop = (r, tiltX, tiltZ, op) => {
          const pts = Array.from({ length: 129 }, (_, i) => { const t = (i / 128) * Math.PI * 2; return new THREE.Vector3(r * Math.cos(t), 0, r * Math.sin(t)); });
          const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: cssColor("--muted-foreground", "#64748b"), transparent: true, opacity: op }));
          l.rotation.set(tiltX, 0, tiltZ);
          wire.add(l);
        };
        loop(RING.apps, 0, 0, 0.45);
        loop(RING.apps, Math.PI / 2, 0, 0.15);
        loop(RING.apps, Math.PI / 2, Math.PI / 3, 0.12);
        for (const r of [RING.skills, RING.memory, RING.routines]) loop(r, 0, 0, 0.08);
        instance.scene().add(wire);
        instance.cameraPosition({ x: 0, y: 420, z: 1100 }, { x: 0, y: 0, z: 0 });
      }
      const fit = () => { if (host.current) instance.width(host.current.clientWidth).height(host.current.clientHeight); };
      fit();
      observer = new ResizeObserver(fit);
      observer.observe(host.current);
      setScene((n) => n + 1);
      onReady(instance);
      requestAnimationFrame(() => requestAnimationFrame(() => { if (!dead) setShown(true); }));
    }).catch((e) => onFail(e.message));
    return () => {
      dead = true;
      observer?.disconnect();
      if (instance) { instance.pauseAnimation(); instance._destructor?.(); }
      fg.current = null;
      if (host.current) host.current.replaceChildren();
    };
    // graph is the only input that needs a new scene; the rest is applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph]);

  const paint = useCallback(() => {
    const g = fg.current;
    if (!g) return;
    const dim = cssColor("--muted-foreground", "#64748b");
    const endpoint = (e) => (typeof e === "object" ? e.id : e);
    const hot = (l) => latest.current.selected && (endpoint(l.source) === latest.current.selected || endpoint(l.target) === latest.current.selected);
    g.backgroundColor(cssColor("--background", "#05070d"))
      .nodeColor((n) => (lit && !lit.has(n.id) ? dim : nodeColor(n)))
      .nodeVisibility((n) => latest.current.visible.has(n.id))
      .linkVisibility((l) => latest.current.visible.has(endpoint(l.source)) && latest.current.visible.has(endpoint(l.target)))
      .linkColor((l) => (hot(l) ? cssColor("--primary", "#38bdf8") : dim))
      .linkOpacity(lit ? 0.35 : 0.05)
      .linkWidth((l) => (hot(l) ? 0.8 : 0))
      // Transfer along the lines of the selected node (meteors are drawn separately, below).
      .linkDirectionalParticles((l) => (hot(l) ? 4 : 0));
    // Dim what is out of focus: the sprite carries the node's look.
    for (const n of g.graphData().nodes) { const m = n.__threeObj?.material; if (m && m.map) m.opacity = lit && !lit.has(n.id) ? 0.15 : 1; }
    g.linkDirectionalParticles(g.linkDirectionalParticles());
  }, [lit, nodeColor]);

  // Meteors, as in the Rings: a bright head with a short tail flies along a random visible line; the sender twinkles as it
  // leaves and the receiver as it lands. Drawn in the scene itself so their timing is known; paused with the rotation.
  useEffect(() => {
    const g = fg.current;
    if (!rotate || !scene || !g || !graph.extra) return undefined;
    let raf = 0, group = null, dead = false;
    import("three").then((THREE) => {
      if (dead) return;
      const c = document.createElement("canvas");
      c.width = c.height = 64;
      const x = c.getContext("2d"), grad = x.createRadialGradient(32, 32, 0, 32, 32, 32);
      grad.addColorStop(0, "rgba(255,255,255,1)"); grad.addColorStop(0.25, "rgba(255,255,255,.55)"); grad.addColorStop(1, "rgba(255,255,255,0)");
      x.fillStyle = grad; x.fillRect(0, 0, 64, 64);
      const tex = new THREE.CanvasTexture(c);
      group = new THREE.Group();
      g.scene().add(group);
      const glow = (size) => { const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 })); sp.scale.set(size, size, 1); group.add(sp); return sp; };
      const N = 5, TAIL = 4;
      const ms = Array.from({ length: N }, (_, i) => ({ link: null, t: -i * 0.35, speed: 0.25, parts: Array.from({ length: TAIL }, (_, j) => glow(12 - j * 2.2)), from: glow(34), to: glow(34) }));
      const end = (e) => (typeof e === "object" ? e : null);
      let last = performance.now();
      const tick = (now) => {
        const dt = Math.min(0.1, (now - last) / 1000);
        last = now;
        const links = g.graphData().links.filter((l) => end(l.source) && end(l.target) && latest.current.visible.has(l.source.id) && latest.current.visible.has(l.target.id));
        ms.forEach((m, i) => {
          m.t += m.speed * dt;
          if (!m.link || m.t > 1.15) {
            m.link = links.length ? links[Math.floor(Math.random() * links.length)] : null;
            m.flip = Math.random() < 0.5;
            m.t = -Math.random() * 0.4;
            m.speed = 0.22 + Math.random() * 0.25;
          }
          const l = m.link;
          const hide = () => { for (const p of m.parts) p.material.opacity = 0; m.from.material.opacity = 0; m.to.material.opacity = 0; };
          if (!l) return hide();
          const a = m.flip ? l.target : l.source, b = m.flip ? l.source : l.target;
          const at = (u) => new THREE.Vector3(a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u, a.z + (b.z - a.z) * u);
          m.parts.forEach((p, j) => {
            const u = m.t - j * 0.035;
            p.material.opacity = u >= 0 && u <= 1 ? 0.95 - j * 0.2 : 0;
            if (p.material.opacity) p.position.copy(at(u));
          });
          const twinkle = 0.7 + 0.3 * Math.sin(now / 45 + i * 1.7);
          const flash = (sp, node, k) => {
            sp.material.opacity = k > 0 ? k * twinkle : 0;
            if (k > 0) { sp.position.set(node.x, node.y, node.z); const s = 22 + 26 * (1 - k); sp.scale.set(s, s, 1); }
          };
          flash(m.from, a, 1 - Math.abs(m.t) / 0.22);
          flash(m.to, b, 1 - Math.abs(m.t - 1) / 0.18);
        });
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    });
    return () => { dead = true; cancelAnimationFrame(raf); if (group) { g.scene().remove(group); group.traverse((o) => o.material?.dispose?.()); } };
  }, [rotate, scene, graph]);
  // resolvedTheme: the tokens change with the theme.
  useEffect(() => { paint(); }, [paint, resolvedTheme, visible, scene]);
  useEffect(() => {
    const c = fg.current?.controls?.();
    if (c) c.autoRotate = rotate;
  }, [rotate, scene]);

  return (
    <>
      <div ref={host} className="absolute inset-0" style={{ opacity: shown ? 1 : 0, transform: shown ? "none" : "scale(.96)", transition: "opacity .6s ease, transform .8s cubic-bezier(.2,.7,.2,1)" }} />
      {!shown && <LoaderCircle className="absolute top-1/2 left-1/2 size-5 -translate-1/2 animate-spin text-muted-foreground" />}
    </>
  );
}

export default function BrainView({ onAsk }) {
  const S = T.views.brain;
  const { graph, error, code, loading, load } = useGraph();
  const [selected, setSelected] = useState(null);
  const [showInventory, setShowInventory] = useState(false);
  const [hidden, setHidden] = useState(() => new Set());
  const [attention, setAttention] = useState(false);
  const [rotate, setRotate] = useState(true);
  const [instance, setInstance] = useState(null);
  const [drawError, setDrawError] = useState("");
  const [mode, setMode] = useState("rings");
  const [layerFocus, setLayerFocus] = useState(null);
  const [areaFocus, setAreaFocusRaw] = useState(null);
  // T14: inside an area, narrow to one entity and one document type; the filter can go to Cognition as one chip.
  const [entityFocus, setEntityFocus] = useState("");
  const [typeFocus, setTypeFocus] = useState("");
  const setAreaFocus = useCallback((a) => { setAreaFocusRaw(a); setEntityFocus(""); setTypeFocus(""); }, []);
  const shell = useRef(null);
  const [full, setFull] = useState(false);
  useEffect(() => {
    const on = () => setFull(document.fullscreenElement === shell.current);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);
  const toggleFull = () => { try { if (document.fullscreenElement) document.exitFullscreen(); else shell.current?.requestFullscreen(); } catch { /* not allowed here */ } };
  const layered = Boolean(graph?.extra);
  // Warm up what the other tabs need while the user looks at the first one: layouts, and the 3D library.
  useEffect(() => {
    if (!graph?.extra) return undefined;
    warmLayouts(graph);
    const t = setTimeout(() => { import("3d-force-graph").catch(() => {}); import("three").catch(() => {}); }, 800);
    return () => clearTimeout(t);
  }, [graph]);
  const view = layered ? mode : "orbit";

  const active = useMemo(() => new Set((graph?.sources ?? []).map((s) => s.id).filter((id) => !hidden.has(id))), [graph, hidden]);
  const visible = useMemo(() => new Set((graph?.nodes ?? []).filter((n) => active.has(n.source) && (!attention || n.flags.length)).map((n) => n.id)), [graph, active, attention]);

  // One visibility set for every node (notes and layer nodes): source toggles and attention apply to notes, layer and area focus to all.
  const visibleAll = useMemo(() => {
    if (!graph) return new Set();
    const set = new Set();
    for (const n of allNodes(graph)) {
      const isNote = n.kind === "file" && Boolean(n.source);
      if (isNote && !visible.has(n.id)) continue;
      if (layerFocus && n.layer !== layerFocus && n.kind !== "area" && n.kind !== "core") continue;
      if (areaFocus && n.area !== areaFocus && n.kind !== "core") continue;
      if (isNote && entityFocus && (n.entity || "") !== entityFocus) continue;
      if (isNote && typeFocus && (n.type || "") !== typeFocus) continue;
      set.add(n.id);
    }
    return set;
  }, [graph, visible, layerFocus, areaFocus, entityFocus, typeFocus]);
  const areaNotes = useMemo(() => (graph?.nodes ?? []).filter((n) => areaFocus && n.area === areaFocus), [graph, areaFocus]);
  const entities = useMemo(() => [...new Set(areaNotes.map((n) => n.entity).filter(Boolean))].sort(), [areaNotes]);
  const types = useMemo(() => [...new Set(areaNotes.filter((n) => !entityFocus || n.entity === entityFocus).map((n) => n.type).filter(Boolean))].sort(), [areaNotes, entityFocus]);
  const askFilter = () => {
    const pages = areaNotes.filter((n) => visibleAll.has(n.id)).map((n) => ({ title: n.title, file: n.path, hat: n.client || "", node: n.id }));
    const area = graph.areas.find((a) => a.id === areaFocus)?.label ?? areaFocus;
    onAsk?.({ title: [area, entityFocus, typeFocus].filter(Boolean).join(" › "), pages });
  };

  const fly = useCallback((id) => {
    if (!instance) return;
    const n = instance.graphData().nodes.find((x) => x.id === id);
    if (!n || n.x === undefined) return;
    const r = Math.hypot(n.x, n.y, n.z) || 1;
    const k = 1 + 260 / r; // far enough to see the note with its neighbours
    instance.cameraPosition({ x: n.x * k, y: n.y * k, z: n.z * k }, n, 900);
  }, [instance]);

  // Picking a note that is filtered out brings its source back, so the choice is never invisible.
  const pick = useCallback((id) => {
    setShowInventory(false);
    setSelected(id);
    if (!id) return;
    const n = graph?.nodes.find((x) => x.id === id);
    if (n && !visible.has(id)) {
      setAttention(false);
      setHidden((h) => { const c = new Set(h); c.delete(n.source); return c; });
    }
    fly(id);
  }, [graph, visible, fly]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") { setSelected(null); setShowInventory(false); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (code === 404) {
    return (
      <div className="grid max-w-2xl gap-3">
        <PageHeader title={S.title} intro={S.notConfigured} />
        <code className="break-all rounded-lg border p-2 text-xs">{error}</code>
        <pre className="overflow-auto rounded-lg border p-3 font-mono text-xs">{S.example}</pre>
        <div><Button size="sm" variant="outline" onClick={() => load()}><RefreshCw className="size-3.5" /> {S.retry}</Button></div>
      </div>
    );
  }
  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!graph) return <LoaderCircle className="size-4 animate-spin" />;

  return (
    <div ref={shell} className={cn("grid gap-3", full && "content-start overflow-auto bg-background p-4")}>
      <PageHeader title={graph.name} intro={S.totals(graph.totals.notes, graph.totals.links, graph.totals.words)}>
        <SearchBox nodes={graph.nodes} onPick={pick} />
        {view === "orbit" && <Button size="sm" variant={rotate ? "default" : "outline"} aria-pressed={rotate} onClick={() => setRotate((r) => !r)}>{rotate ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}<span className="sr-only">{rotate ? "Jeda" : "Putar"}</span></Button>}
        {view === "orbit" && <Button size="sm" variant="outline" onClick={() => instance?.zoomToFit(600, 40)}><Crosshair className="size-3.5" /> {S.fit}</Button>}
        <Button size="sm" variant={showInventory ? "default" : "outline"} aria-pressed={showInventory} onClick={() => { setSelected(null); setShowInventory((v) => !v); }}><ListTree className="size-3.5" /> {S.inventory}</Button>
        <Button size="sm" variant="outline" disabled={loading} title={S.rebuildHint} onClick={() => { setSelected(null); load(true); }}>{loading ? <LoaderCircle className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} {S.rebuild}</Button>
        <Button size="sm" variant={full ? "default" : "outline"} aria-pressed={full} title="Layar penuh (Esc keluar)" onClick={toggleFull}>{full ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />} Layar penuh</Button>
      </PageHeader>
      {layered && (
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="Tampilan Brain">
          {MODES.map(([id, label]) => <Button key={id} size="sm" role="tab" aria-selected={view === id} variant={view === id ? "default" : "outline"} onClick={() => setMode(id)}>{label}</Button>)}
          <span className="ml-auto self-center font-mono text-[11px] text-muted-foreground">{allNodes(graph).length} item, {graph.links.length + graph.extra.links.length} tautan, {graph.extra.nodes.filter((n) => n.kind === "run").length} run</span>
        </div>
      )}
      <div className={cn("relative min-h-96 overflow-hidden rounded-xl border bg-background", full ? "h-[calc(100svh-9rem)]" : "h-[calc(100svh-13rem)]")}>
        {layered && graph.nodes.length > 0 ? (
          <>
            {["rings", "areas", "links"].includes(view) && <div className="brain-view-in absolute inset-0"><Rings layout={view} graph={graph} visible={visibleAll} selected={selected} onSelect={pick} layerFocus={layerFocus} onLayer={setLayerFocus} areaFocus={areaFocus} onArea={setAreaFocus} /></div>}
            {view === "timeline" && <div key="timeline" className="brain-view-in absolute inset-0"><TimelineView graph={graph} visible={visibleAll} onSelect={pick} /></div>}
            {view === "orbit" && <div key="orbit" className="absolute inset-0">{drawError ? <p className="p-4 text-sm text-destructive">{S.drawFailed}: {drawError}</p> : <Canvas graph={graph} visible={visibleAll} selected={selected} rotate={rotate} onSelect={pick} onReady={(g) => setInstance(() => g)} onFail={setDrawError} />}</div>}
            <div className="absolute top-3 left-3 z-10 grid max-h-[calc(100%-1.5rem)] max-w-52 gap-1 overflow-auto rounded-xl border bg-card/85 p-2 text-xs backdrop-blur">
              <button type="button" className={cn("rounded px-1 py-0.5 text-left", !areaFocus && "font-semibold")} onClick={() => setAreaFocus(null)}>Semua area</button>
              {graph.areas.map((a) => (
                <button key={a.id} type="button" className={cn("flex items-center gap-2 rounded px-1 py-0.5", areaFocus && areaFocus !== a.id && "opacity-45")} onClick={() => setAreaFocus(areaFocus === a.id ? null : a.id)}>
                  <span className="size-2.5 shrink-0 rounded-full" style={{ background: a.color }} /><span className="truncate">{a.label}</span><span className="ml-auto pl-2 font-mono text-muted-foreground">{a.count}</span>
                </button>
              ))}
              {areaFocus && (
                <div className="mt-1 grid gap-1 border-t pt-1.5">
                  <select aria-label="Entitas" className="h-7 rounded-md border bg-card px-1.5 text-xs" value={entityFocus} onChange={(e) => { setEntityFocus(e.target.value); setTypeFocus(""); }}>
                    <option value="">Semua entitas</option>
                    {entities.map((x) => <option key={x} value={x}>{x}</option>)}
                  </select>
                  <select aria-label="Jenis" className="h-7 rounded-md border bg-card px-1.5 text-xs" value={typeFocus} onChange={(e) => setTypeFocus(e.target.value)}>
                    <option value="">Semua jenis</option>
                    {types.map((x) => <option key={x} value={x}>{x}</option>)}
                  </select>
                  {onAsk && <Button size="xs" variant="outline" onClick={askFilter} title="Kirim filter ini sebagai konteks chat"><BrainCog className="size-3" /> Cognition</Button>}
                </div>
              )}
              <div className="mt-1 border-t pt-1.5">
                {graph.layers.map((l) => (
                  <button key={l.id} type="button" className={cn("flex w-full gap-2 rounded px-1 py-0.5", layerFocus && layerFocus !== l.id && "opacity-45")} onClick={() => setLayerFocus(layerFocus === l.id ? null : l.id)}>
                    <span>{l.label}</span><span className="ml-auto font-mono text-muted-foreground">{l.count}</span>
                  </button>
                ))}
              </div>
            </div>
            <p className="pointer-events-none absolute bottom-2 left-3 z-10 text-[11px] text-muted-foreground">titik = item, klik = kartu, nama area atau cincin = isolasi · data {graph.builtAt.slice(0, 16).replace("T", " ")}</p>
          </>
        ) : drawError ? (
          <p className="p-4 text-sm text-destructive">{S.drawFailed}: {drawError}</p>
        ) : graph.nodes.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">{S.empty}</p>
        ) : (
          <Canvas graph={graph} visible={layered ? visibleAll : visible} selected={selected} rotate={rotate} onSelect={pick} onReady={(g) => setInstance(() => g)} onFail={setDrawError} />
        )}
        {!layered && <Legend sources={graph.sources} active={active} onToggle={(id) => setHidden((h) => { const c = new Set(h); if (c.has(id)) c.delete(id); else c.add(id); return c; })} attention={attention} onAttention={setAttention} />}
        <SlidePanel show={Boolean(selected && !graph.nodes.some((n) => n.id === selected) && allNodes(graph).find((n) => n.id === selected))}>{selected && !graph.nodes.some((n) => n.id === selected) && allNodes(graph).find((n) => n.id === selected) ? <ExtraCard node={allNodes(graph).find((n) => n.id === selected)} graph={graph} onClose={() => setSelected(null)} /> : null}</SlidePanel>
        <SlidePanel show={Boolean(selected && graph.nodes.some((n) => n.id === selected))}>{selected && graph.nodes.some((n) => n.id === selected) ? <NotePanel graph={graph} id={selected} onClose={() => setSelected(null)} onPick={pick} onFocus={fly} onAsk={onAsk} /> : null}</SlidePanel>
        <SlidePanel show={showInventory}>{showInventory ? <Inventory graph={graph} onPick={pick} onClose={() => setShowInventory(false)} /> : null}</SlidePanel>
      </div>
    </div>
  );
}
