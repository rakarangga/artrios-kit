import { useCallback, useEffect, useRef, useState } from "react";
import { Maximize2, Minimize2, Plus, X } from "lucide-react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api } from "./api.js";
import { subscribe } from "./socket.js";
import { T } from "./texts.js";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/settings-layout";

const S = T.terminal;

// One xterm bound to one server-side pty. The server keeps the scrollback, so remounting (expand, page reload)
// replays it and the session continues.
function Pane({ project, term, height }) {
  const host = useRef(null);
  const [exited, setExited] = useState(term.alive === false ? term.exitCode : null);
  const [link, setLink] = useState("connecting");

  useEffect(() => {
    const x = new XTerm({ cursorBlink: true, fontSize: 13, fontFamily: "'JetBrains Mono', ui-monospace, Consolas, monospace", scrollback: 5000, theme: { background: "#05070d", foreground: "#e8ecf4" } });
    const fit = new FitAddon();
    x.loadAddon(fit);
    x.open(host.current);
    const ws = new WebSocket(`ws://${location.host}/term/${term.id}`);
    const send = (msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };
    const doFit = () => { try { fit.fit(); send({ type: "resize", cols: x.cols, rows: x.rows }); } catch { /* host not laid out yet */ } };
    ws.onopen = () => { setLink("open"); doFit(); };
    ws.onclose = () => setLink("closed");
    ws.onmessage = (m) => {
      let msg;
      try { msg = JSON.parse(m.data); } catch { return; }
      if (msg.type === "replay" || msg.type === "output") x.write(msg.data);
      else if (msg.type === "exit") setExited(msg.code);
    };
    const sub = x.onData((data) => send({ type: "input", data }));
    const ro = new ResizeObserver(doFit);
    ro.observe(host.current);
    doFit();
    return () => { ro.disconnect(); sub.dispose(); ws.close(); x.dispose(); };
  }, [project, term.id]);

  return (
    <div className="term-wrap">
      {exited !== null && <div className="term-banner">{S.exited(exited)}</div>}
      {link === "closed" && exited === null && <div className="term-banner">{S.disconnected}</div>}
      <div className="term-host" style={{ height }} ref={host} />
    </div>
  );
}

function PaneHeader({ term, expanded, onExpand, onClose }) {
  return (
    <div className="flex items-center gap-2 border-b px-3 py-1.5">
      <span className={cn("size-2 rounded-full", term.alive ? "bg-positive" : "bg-destructive")} aria-hidden="true" />
      <span className="text-sm font-semibold">{term.title}</span>
      {term.worktree && <span className="rounded border px-1.5 font-mono text-[11px] text-info" title={term.worktree.path}>{term.worktree.branch ?? "worktree"}</span>}
      <span className="font-mono text-[11px] text-muted-foreground">{term.alive ? S.running : S.endedShort}</span>
      <span className="ml-auto flex items-center gap-0.5">
        <Button variant="ghost" size="icon-sm" title={expanded ? S.collapse : S.expand} aria-label={`${expanded ? S.collapse : S.expand} ${term.title}`} onClick={onExpand}>
          {expanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
        </Button>
        <Button variant="ghost" size="icon-sm" title={S.closeTab} aria-label={`${S.closeTab} ${term.title}`} onClick={onClose}><X className="size-4" /></Button>
      </span>
    </div>
  );
}

export default function Terminal({ project }) {
  const [terms, setTerms] = useState([]);
  const [max, setMax] = useState(12);
  const [expandedId, setExpandedId] = useState(null);
  const [error, setError] = useState("");
  const [worktrees, setWorktrees] = useState([]); // S11: a new tab may run in a worktree of this workspace
  const [where, setWhere] = useState("");
  useEffect(() => { setWhere(""); api.worktrees(project).then((r) => setWorktrees((r.worktrees ?? []).filter((w) => !w.main))).catch(() => setWorktrees([])); }, [project]);

  const load = useCallback(() => {
    api.terminals(project).then((r) => {
      setTerms(r.terminals);
      setMax(r.max);
      setExpandedId((cur) => (r.terminals.some((t) => t.id === cur) ? cur : null));
    }).catch((e) => setError(e.message));
  }, [project]);

  useEffect(() => { setError(""); setExpandedId(null); load(); }, [load]);
  useEffect(() => subscribe((m) => { if (m.project === project && String(m.type).startsWith("terminal.")) load(); }), [project, load]);

  async function add() {
    setError("");
    try {
      const t = await api.openTerminal(project, { cols: 100, rows: 30, ...(where ? { worktree: where } : {}) });
      setTerms((cur) => [...cur, t]);
    } catch (e) { setError(e.message); }
  }
  async function close(id) {
    try { await api.closeTerminal(project, id); } catch (e) { setError(e.message); }
    setTerms((cur) => cur.filter((t) => t.id !== id));
    setExpandedId((cur) => (cur === id ? null : cur));
    load();
  }

  const expanded = terms.find((t) => t.id === expandedId) ?? null;
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-heading text-lg font-bold tracking-tight">{T.nav.terminals}</h2>
        <span className="font-mono text-xs text-muted-foreground">{terms.length} / {max} {S.countLabel}</span>
        {worktrees.length > 0 && (
          <SelectField size="sm" className="ml-auto" label="worktree" value={where || "main"} onChange={(v) => setWhere(v === "main" ? "" : v)}
            options={[{ value: "main", label: T.views.worktrees.main }, ...worktrees.map((w) => ({ value: w.path, label: w.branch || w.head }))]} />
        )}
        <Button className={worktrees.length ? "" : "ml-auto"} size="sm" onClick={add} disabled={terms.length >= max}><Plus className="size-4" /> {S.newTab}</Button>
      </div>
      {error && <div className="rounded-xl border border-destructive px-3 py-2 text-sm"><b>{S.error}</b> {error}</div>}
      {terms.length === 0 && <p className="rounded-md border-2 border-dashed px-3 py-6 text-center text-sm text-muted-foreground">{S.empty}</p>}
      <div className="grid gap-3 xl:grid-cols-2">
        {terms.map((t) => (
          <section key={t.id} className="flex flex-col overflow-hidden rounded-md border bg-card">
            <PaneHeader term={t} expanded={false} onExpand={() => setExpandedId(t.id)} onClose={() => close(t.id)} />
            {expanded?.id === t.id ? <p className="px-3 py-10 text-center text-sm text-muted-foreground">{S.expandedHint}</p> : <Pane project={project} term={t} height={300} />}
          </section>
        ))}
      </div>
      {expanded && (
        <div className="fixed inset-4 z-40 flex flex-col overflow-hidden rounded-xl border border-border-strong bg-card shadow-2xl">
          <PaneHeader term={expanded} expanded onExpand={() => setExpandedId(null)} onClose={() => close(expanded.id)} />
          <div className="min-h-0 flex-1 p-2">
            <Pane key={`x-${expanded.id}`} project={project} term={expanded} height="calc(100vh - 8.5rem)" />
          </div>
        </div>
      )}
    </div>
  );
}
