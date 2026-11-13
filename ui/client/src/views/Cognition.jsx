// "Cognition" (PRD prd-cognition Tahap 1-2): chat with Claude Code from the UI, sessions shared with the CLI.
// Server side: server/chat-service.js. Events arrive on the shared socket as { type: "chat", id, ev }.
// Three layouts: "page" (menu screen), "compact" (side drawer), "full" (own browser tab, messenger style, /chat).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Ban, Bot, Brain, BrainCog, Check, ChevronDown, ChevronRight, CircleHelp, Cpu, ExternalLink, FileText, Gauge, Gavel, Lightbulb, LightbulbOff, ListFilter, Mic, MicOff,
  FolderPlus, PanelLeftClose, PanelLeftOpen, Paperclip, Pin, PinOff, Plus, Search, Send, ShieldCheck, Sparkles, Square, TextCursorInput, Wrench, X, Zap,
} from "lucide-react";
import { api } from "../api.js";
import { readPersisted, writePersisted, usePersisted } from "../lib/persist.js";
import { useSuggestSettings, saveSuggest } from "../lib/suggest.js";
import { subscribe } from "../socket.js";
import { playReceive, playSend } from "../sound.js";
import { T } from "../texts.js";
import { Markdown } from "../markdown.jsx";
import { useDictation } from "../mic.js";
import { ModelPicker, labelOf } from "@/components/model-picker";
import { cn } from "@/lib/utils";
import { contextLevel } from "../lib/context-level.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FIELD_FULL } from "@/components/field";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

const S = T.views.cognition;
const DEF = "_default"; // radix Select items cannot hold an empty value
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const MODES = ["default", "acceptEdits", "auto", "plan"];
const MODE_ICON = { default: ShieldCheck, acceptEdits: Check, auto: Zap, plan: ListFilter };
const CLAUDE = "claude_cli";

// A chat moved from another engine starts with the old session's summary (T12); shown folded, not as text.
function splitPrev(text) {
  const m = /^<previous-session[^>]*>\n([\s\S]*?)\n<\/previous-session>\n\n?/.exec(text ?? "");
  return m ? { text: text.slice(m[0].length), prev: m[1] } : { text, prev: null };
}

const ago = (iso) => {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(s)) return "";
  if (s < 60) return S.justNow;
  if (s < 3600) return `${Math.floor(s / 60)} mnt`;
  if (s < 86400) return `${Math.floor(s / 3600)} jam`;
  return `${Math.floor(s / 86400)} hr`;
};
const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" }) : "");
const day = (iso) => (iso ? new Date(iso).toLocaleDateString("id-ID", { weekday: "long", day: "numeric", month: "long" }) : "");
const kfmt = (n) => (n == null ? "-" : n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const usd = (n) => (n == null ? "-" : `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}`);
const readFile = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve({ name: file.name || "tempel.png", mime: file.type || "application/octet-stream", data: String(r.result).split(",")[1] ?? "", size: file.size, preview: file.type.startsWith("image/") ? String(r.result) : null });
  r.onerror = reject;
  r.readAsDataURL(file);
});

// Splits the <brain-context> block the server adds for Brain chips back into chips for display.
function splitContext(text) {
  const m = /\n*<brain-context>\n[^\n]*\n([\s\S]*?)\n<\/brain-context>\s*$/.exec(text ?? "");
  if (!m) return { body: text, chips: [] };
  const chips = [];
  for (const l of m[1].split("\n")) {
    const f = /^- filter: (.*) · (\d+) pages$/.exec(l);
    if (f) { chips.push({ title: f[1], filter: true, count: Number(f[2]) }); continue; }
    const x = /^- \[(.*?)\]\((.*?)\) · hat: ([^·]*?)(?: · node: (.*))?$/.exec(l);
    if (x) chips.push({ title: x[1], file: x[2], hat: x[3].trim(), node: x[4] ?? null });
  }
  return { body: text.slice(0, m.index), chips };
}

function Chip({ c, onRemove }) {
  const filter = c.filter || Array.isArray(c.pages);
  return (
    <span className="flex items-center gap-1.5 rounded-full border border-self/40 bg-self/10 py-0.5 pl-2 pr-1.5 text-xs" title={c.file ?? c.title}>
      {filter ? <ListFilter className="size-3.5 shrink-0" /> : <Brain className="size-3.5 shrink-0" />}
      <span className="max-w-56 truncate">{c.title}</span>
      {filter
        ? <Badge variant="outline" className="h-4 px-1 text-[10px]">{c.count ?? c.pages?.length} hal.</Badge>
        : <Badge variant="outline" className="h-4 px-1 text-[10px]">{c.hat || "own"}</Badge>}
      {onRemove && <button type="button" aria-label={`${S.remove} ${c.title}`} onClick={onRemove}><X className="size-3" /></button>}
    </span>
  );
}

// Context bar (Raka 2026-11-10): context in use against the model window, plus spend and tokens of this session.
function ContextBar({ stats, compact = false, className }) {
  const used = stats?.contextTokens ?? null;
  const win = stats?.contextWindow ?? null;
  const pct = used != null && win ? Math.min(100, (used / win) * 100) : null;
  // Absolute size decides the colour (the window is 1M, so a percentage would stay green far too long).
  const level = contextLevel(used);
  const tone = level == null ? "bg-muted-foreground/30" : level === "high" ? "bg-destructive" : level === "warn" ? "bg-warning" : "bg-positive";
  const title = `${S.contextLabel}: ${used != null ? used.toLocaleString("id-ID") : "-"} / ${win ? win.toLocaleString("id-ID") : "-"} token`
    + ` · ${S.costLabel}: ${usd(stats?.costUsd)} · in ${kfmt(stats?.inputTokens)} · out ${kfmt(stats?.outputTokens)}`;
  return (
    <div className={cn("grid gap-0.5", className)} title={title} aria-label={title}>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full rounded-full transition-[width]", tone)} style={{ width: `${pct ?? 0}%` }} />
      </div>
      {!compact && (
        <div className="flex flex-wrap justify-between gap-x-3 font-mono text-[10px] text-muted-foreground">
          <span>ctx {kfmt(used)}/{kfmt(win)}{pct != null ? ` (${Math.round(pct)}%)` : ""}</span>
          <span>{usd(stats?.costUsd)} · in {kfmt(stats?.inputTokens)} · out {kfmt(stats?.outputTokens)}</span>
        </div>
      )}
    </div>
  );
}

function Picker({ label, icon: Icon, value, onChange, children, className, display }) {
  return (
    <Select value={value || DEF} onValueChange={(v) => onChange(v === DEF ? "" : v)}>
      <SelectTrigger size="sm" aria-label={label} title={label} className={cn("h-8 gap-1.5 rounded-full border-border-strong bg-card/70 px-3 text-xs font-medium shadow-xs hover:bg-accent", className)}>
        {Icon && <Icon className="size-3.5 text-primary" />}
        {display ? <SelectValue>{display}</SelectValue> : <SelectValue />}
      </SelectTrigger>
      <SelectContent position="popper" align="start" className="min-w-52">
        <SelectGroup>
          <SelectLabel className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</SelectLabel>
          {children}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

function ToolRow({ item, result }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-1.5 max-w-[85%] rounded-xl border border-dashed bg-muted/30 text-xs">
      <button type="button" className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <ChevronRight className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
        <Wrench className="size-3 shrink-0 text-muted-foreground" />
        <span className="font-mono font-semibold">{item.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">{item.summary}</span>
        {result && (result.error ? <X className="size-3 text-destructive" /> : <Check className="size-3 text-positive" />)}
      </button>
      {open && (
        <div className="grid gap-1.5 border-t px-2.5 py-2">
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px]">{JSON.stringify(item.input ?? {}, null, 2)}</pre>
          {result && <pre className={cn("max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px]", result.error && "text-destructive")}>{result.text}</pre>}
        </div>
      )}
    </div>
  );
}

function PermissionCard({ p, onAnswer }) {
  return (
    <div className="mb-3 max-w-[85%] rounded-xl border border-warning/60 bg-warning/10 p-3 text-sm" role="alertdialog" aria-label={S.permTitle}>
      <div className="mb-1 flex items-center gap-2 font-semibold"><ShieldCheck className="size-4 text-warning" /> {S.permTitle}: <span className="font-mono">{p.tool}</span></div>
      {p.description && <p className="mb-1 text-xs text-muted-foreground">{p.description}</p>}
      <pre className="mb-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-background/60 p-2 font-mono text-[11px]">{p.tool === "Bash" || p.tool === "PowerShell" ? p.input?.command : JSON.stringify(p.input, null, 2)}</pre>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => onAnswer({ decision: "once" })}><Check className="size-3.5" /> {S.allowOnce}</Button>
        <Button size="sm" variant="outline" onClick={() => onAnswer({ decision: "always" })}>{S.allowAlways}</Button>
        <Button size="sm" variant="ghost" className="text-destructive" onClick={() => onAnswer({ decision: "deny" })}><Ban className="size-3.5" /> {S.deny}</Button>
      </div>
    </div>
  );
}

function QuestionCard({ p, onAnswer }) {
  const qs = p.input?.questions ?? [];
  const [sel, setSel] = useState({});
  const [other, setOther] = useState({});
  const value = (q) => (other[q.question]?.trim() ? other[q.question].trim() : q.multiSelect ? (sel[q.question] ?? []).join(", ") : sel[q.question]);
  const ready = qs.every((q) => value(q));
  const toggle = (q, label) => setSel((s) => {
    if (!q.multiSelect) return { ...s, [q.question]: label };
    const cur = new Set(s[q.question] ?? []);
    if (cur.has(label)) cur.delete(label); else cur.add(label);
    return { ...s, [q.question]: [...cur] };
  });
  return (
    <div className="mb-3 max-w-[85%] rounded-xl border border-info/60 bg-info/10 p-3 text-sm" role="group" aria-label={S.askTitle}>
      <div className="mb-2 flex items-center gap-2 font-semibold"><CircleHelp className="size-4 text-info" /> {S.askTitle}</div>
      {qs.map((q) => (
        <fieldset key={q.question} className="mb-3">
          <legend className="mb-1.5 font-medium">{q.header && <Badge variant="outline" className="mr-1.5">{q.header}</Badge>}{q.question}</legend>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {q.options.map((o) => {
              const on = q.multiSelect ? (sel[q.question] ?? []).includes(o.label) : sel[q.question] === o.label;
              return (
                <button key={o.label} type="button" aria-pressed={on} onClick={() => toggle(q, o.label)}
                  className={cn("rounded-lg border px-2.5 py-1.5 text-left text-[13px] transition-colors", on ? "border-primary bg-primary/15" : "bg-background/60 hover:border-primary/50")}>
                  <div className="font-medium">{o.label}</div>
                  {o.description && <div className="text-xs text-muted-foreground">{o.description}</div>}
                </button>
              );
            })}
          </div>
          <input className={cn(FIELD_FULL, "mt-1.5")} placeholder={S.otherAnswer} value={other[q.question] ?? ""} onChange={(e) => setOther({ ...other, [q.question]: e.target.value })} />
        </fieldset>
      ))}
      <div className="flex gap-2">
        <Button size="sm" disabled={!ready} onClick={() => onAnswer({ decision: "once", answers: Object.fromEntries(qs.map((q) => [q.question, value(q)])) })}><Send className="size-3.5" /> {S.sendAnswer}</Button>
        <Button size="sm" variant="ghost" onClick={() => onAnswer({ decision: "deny" })}>{S.skip}</Button>
      </div>
    </div>
  );
}

function UsageDialog({ open, onClose, stats, rate, rateTs, apiChat = false }) {
  const w = rate?.unifiedWindows ?? {};
  const row = (label, x) => {
    const pct = x?.utilization != null ? Math.round(x.utilization * 100) : null;
    return (
      <div className="grid gap-1">
        <div className="flex justify-between text-sm"><span>{label}</span><span className="font-mono">{pct != null ? `${pct}%` : "-"}</span></div>
        <div className="h-2 overflow-hidden rounded-full bg-muted"><div className={cn("h-full rounded-full", pct == null ? "" : pct < 60 ? "bg-positive" : pct < 85 ? "bg-warning" : "bg-destructive")} style={{ width: `${pct ?? 0}%` }} /></div>
        {x?.resetsAt && <span className="text-[11px] text-muted-foreground">{S.resets} {new Date(x.resetsAt * 1000).toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" })}</span>}
      </div>
    );
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent closeLabel={T.close} className="max-w-md">
        <DialogHeader><DialogTitle>{S.usageTitle}</DialogTitle><DialogDescription>{apiChat ? S.usageApiHint : rateTs ? `${S.usageHint} ${new Date(rateTs).toLocaleString("id-ID", { timeStyle: "short", dateStyle: "short" })}` : S.usageEmpty}</DialogDescription></DialogHeader>
        <DialogBody className="grid gap-4">
          {apiChat ? (
            <div className="grid gap-1.5">
              <span className="text-sm font-medium">{S.thisSession}</span>
              <ContextBar stats={stats} />
            </div>
          ) : (
            <>
              {row(S.window5h, w.five_hour)}
              {row(S.window7d, w.seven_day)}
              {w.seven_day_opus && row(S.window7dOpus, w.seven_day_opus)}
              <div className="grid gap-1.5 border-t pt-3">
                <span className="text-sm font-medium">{S.thisSession}</span>
                <ContextBar stats={stats} />
              </div>
            </>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

// Skill with arguments: a small popup; empty is allowed and sends the bare command.
function ArgsDialog({ skill, onClose, onSend }) {
  const [args, setArgs] = useState("");
  useEffect(() => { setArgs(""); }, [skill]);
  return (
    <Dialog open={!!skill} onOpenChange={(o) => !o && onClose()}>
      <DialogContent closeLabel={T.close} className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-mono">/{skill?.name}</DialogTitle>
          <DialogDescription className="line-clamp-3">{skill?.description}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <label className="grid gap-1.5 text-sm">
            <span className="text-muted-foreground">{S.argsLabel}{skill?.argumentHint ? ` ${skill.argumentHint}` : ""}</span>
            <textarea autoFocus rows={3} className={cn(FIELD_FULL, "h-auto py-2")} value={args} placeholder={skill?.argumentHint || S.argsEmpty}
              onChange={(e) => setArgs(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSend(args); } }} />
          </label>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>{S.cancel}</Button>
          <Button onClick={() => onSend(args)}><Send className="size-4" /> {S.send}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SkillPanel({ quick, all, onUse, onPin, disabled }) {
  const [manage, setManage] = useState(false);
  const [q, setQ] = useState("");
  const shown = all.filter((s) => !q || s.name.includes(q.toLowerCase()) || s.description.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="grid gap-2 rounded-xl border bg-muted/30 p-2" aria-label={S.quick}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Sparkles className="ml-1 size-3.5 text-primary" aria-hidden="true" />
        {quick.map((s) => (
          <Button key={s.name} size="xs" variant="outline" disabled={disabled} className="rounded-full bg-card font-mono" title={`${s.description}${s.uses ? ` · ${s.uses}x` : ""}`} onClick={() => onUse(s)}>
            {s.pinned && <Pin className="size-3" />}/{s.name}{s.takesArgs && <TextCursorInput className="size-3 text-muted-foreground" aria-label={S.takesArgs} />}
          </Button>
        ))}
        <Button size="xs" variant={manage ? "default" : "ghost"} className="ml-auto rounded-full" aria-pressed={manage} onClick={() => setManage((m) => !m)}>
          <Pin className="size-3" /> {S.managePins}
        </Button>
      </div>
      {manage && (
        <div className="grid gap-2 border-t pt-2">
          <label className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input className={cn(FIELD_FULL, "h-8 pl-8")} placeholder={S.searchSkills} value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          <ul className="grid max-h-56 gap-1 overflow-y-auto sm:grid-cols-2 xl:grid-cols-3">
            {shown.map((s) => (
              <li key={s.name} className="flex min-w-0 items-start gap-2 rounded-lg border bg-card px-2 py-1.5">
                <button type="button" className="grid min-w-0 flex-1 text-left" onClick={() => onUse(s)} title={s.description}>
                  <span className="truncate font-mono text-[12px] font-medium">/{s.name}</span>
                  <span className="line-clamp-1 text-[11px] text-muted-foreground">{s.description || "-"}</span>
                </button>
                <Button size="icon-xs" variant={s.pinned ? "default" : "ghost"} aria-pressed={s.pinned} aria-label={`${s.pinned ? S.unpinSkill : S.pinSkill} /${s.name}`} title={s.pinned ? S.unpinSkill : S.pinSkill} onClick={() => onPin(s.name, !s.pinned)}>
                  {s.pinned ? <PinOff className="size-3" /> : <Pin className="size-3" />}
                </Button>
              </li>
            ))}
            {shown.length === 0 && <li className="px-2 py-3 text-xs text-muted-foreground">{S.noSkills}</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

const initials = (t) => (String(t ?? "?").replace(/^\//, "").match(/[A-Za-z0-9]/g) ?? ["?"]).slice(0, 2).join("").toUpperCase();
const HUES = ["bg-primary/20 text-primary", "bg-info/20 text-info", "bg-self/20 text-self", "bg-warning/20 text-warning", "bg-positive/20 text-positive"];
const hue = (id) => HUES[[...String(id)].reduce((a, c) => a + c.charCodeAt(0), 0) % HUES.length];

export default function Cognition({ workspace: fixedWs = null, initialWorkspace, initialSession, prefill, chips: incomingChips, onPrefillUsed, onOpenPutusan, compact = false, layout: layoutProp, headerExtra = null }) {
  const layout = layoutProp ?? (compact ? "compact" : "page");
  const full = layout === "full";
  const [ctx, setCtx] = useState([]); // Brain chips for the next message (T14)
  useEffect(() => {
    if (!incomingChips?.length) return;
    setCtx((cur) => [...cur, ...incomingChips.filter((n) => !cur.some((x) => x.title === n.title && x.node === n.node && x.file === n.file))].slice(0, 20));
  }, [incomingChips]);
  // Cognition = the Artrios home folder only; Insights = the same chat for the workspace picked in the header
  // (owner decision 2026-11-10). Other folders join a Cognition session through "add folder" (CLI /add-dir).
  const [projects, setProjects] = useState([]);
  const [homeWs, setHomeWs] = useState(null);
  // Kept across a reload per place (page, Insights, drawer): workspace, open session, new-chat model/effort/mode.
  const scope = compact ? "drawer" : fixedWs ? "insights" : "cognition";
  const sessionKey = (w) => `${scope}.session.${w}`;
  const [ws, setWs] = useState(() => fixedWs || initialWorkspace || readPersisted(`${scope}.ws`, "") || "");
  useEffect(() => { if (ws && !fixedWs) writePersisted(`${scope}.ws`, ws); }, [ws, fixedWs, scope]);
  const [folderMenu, setFolderMenu] = useState(false);
  const [folderPath, setFolderPath] = useState("");
  const [sessions, setSessions] = useState([]);
  const [activeId, setActiveId] = useState(initialSession ?? null);
  const [chat, setChat] = useState(null);
  const [stream, setStream] = useState("");
  const [input, setInput] = useState("");
  const [files, setFiles] = useState([]);
  const [error, setError] = useState("");
  const [commands, setCommands] = useState([]);
  const [quick, setQuick] = useState({ items: [], all: [] });
  const [pick, setPick] = useState(0);
  const [showUsage, setShowUsage] = useState(false);
  const [usage, setUsage] = useState({ rate: null, rateTs: null });
  const [argsFor, setArgsFor] = useState(null);
  const [filter, setFilter] = useState("");
  // Options for a chat not created yet; once picked (touched) they survive a reload instead of falling back to the main model.
  const [draft, setDraft] = usePersisted("cognition.draft", { engine: CLAUDE, model: "", effort: "", mode: "default", addDirs: [], touched: false },
    (v) => v && typeof v === "object" && typeof v.engine === "string" && Array.isArray(v.addDirs));
  const [sideHidden, setSideHidden] = usePersisted("cognition.sideHidden", false, (v) => typeof v === "boolean"); // /cognition tab: hide the session list for a full-width chat
  const [modelOpts, setModelOpts] = useState(null); // providers and their models (GET /api/models), picker data
  const [modelPicker, setModelPicker] = useState(false);
  const [switchTo, setSwitchTo] = useState(null); // { engine, model } waiting for confirmation
  const [switching, setSwitching] = useState(false);
  const end = useRef(null);
  const box = useRef(null);
  const fileInput = useRef(null);
  const activeRef = useRef(null);
  activeRef.current = activeId;

  useEffect(() => {
    api.chatWorkspaces().then((r) => {
      setProjects(r.workspaces);
      setHomeWs(r.home);
      setWs((cur) => cur || r.home?.key || r.default || "");
    }).catch((e) => setError(e.message));
    api.chatUsage().then(setUsage).catch(() => {});
    loadModelOpts();
  }, []);
  useEffect(() => { if (fixedWs) setWs(fixedWs); }, [fixedWs]);
  useEffect(() => { if (prefill) { setActiveId(null); setInput(prefill); onPrefillUsed?.(); box.current?.focus(); } }, [prefill, onPrefillUsed]);

  // New sessions start on the main model (Settings > Model), until the user picks another one here.
  const loadModelOpts = useCallback(() => api.models().then((o) => {
    setModelOpts(o);
    const c = o.current;
    const row = o.providers.find((p) => p.id === c?.provider);
    if (row) setDraft((d) => (d.touched ? d : { ...d, engine: row.transport === "claude_cli" ? CLAUDE : row.id, model: c.model ?? "" }));
  }).catch(() => {}), []);
  const loadSessions = useCallback(() => { if (ws) api.chatSessions(ws).then((r) => setSessions(r.sessions)).catch((e) => setError(e.message)); }, [ws]);
  const loadQuick = useCallback(() => { if (ws) api.chatQuick(ws).then((r) => setQuick({ items: r.items ?? [], all: r.all ?? [] })).catch(() => {}); }, [ws]);
  const loadChat = useCallback((id) => api.chatSession(ws, id).then((c) => { setChat(c); setStream(""); }).catch((e) => setError(e.message)), [ws]);

  const firstWs = useRef(true);
  useEffect(() => {
    // The first workspace load keeps a session asked for by the caller (Putusan link, /cognition?s=...).
    if (firstWs.current && initialSession) { firstWs.current = false; } else { setActiveId(ws ? readPersisted(sessionKey(ws), null) : null); setChat(null); }
    firstWs.current = false;
    setError(""); loadSessions(); loadQuick();
  }, [ws, loadSessions, loadQuick]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (initialSession) setActiveId(initialSession); }, [initialSession]);
  useEffect(() => { if (ws) writePersisted(sessionKey(ws), activeId ?? null); }, [ws, activeId]); // eslint-disable-line react-hooks/exhaustive-deps
  // A remembered session that no longer exists (closed or deleted elsewhere) is dropped quietly.
  useEffect(() => { if (activeId && sessions.length && !sessions.some((x) => x.id === activeId)) setActiveId(null); }, [sessions]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (ws) api.chatCommands(ws, activeId).then((r) => setCommands(r.commands)).catch(() => {}); }, [ws, activeId, chat?.models]);
  // A chat created by send() is already in state; loading it now would drop the optimistic first message.
  const fresh = useRef(null);
  useEffect(() => {
    if (!activeId || !ws) { if (!activeId) { setChat(null); setStream(""); } return; }
    if (fresh.current === activeId) { fresh.current = null; return; }
    loadChat(activeId);
  }, [activeId, ws, loadChat]);
  useEffect(() => {
    if (!full) return;
    const u = new URL(location.href);
    if (ws) u.searchParams.set("ws", ws); else u.searchParams.delete("ws");
    if (activeId) u.searchParams.set("s", activeId); else u.searchParams.delete("s");
    history.replaceState(null, "", u);
    document.title = chat?.title ? `${chat.title} · ${kindTitle}` : `${kindTitle} · Artrios`;
  }, [full, ws, activeId, chat?.title]);

  useEffect(() => subscribe((m) => {
    if (m.type !== "chat") return;
    if (m.ev === "status") loadSessions();
    if (m.ev === "usage" && m.rate) setUsage({ rate: m.rate, rateTs: new Date().toISOString() });
    if (m.id !== activeRef.current) return;
    setChat((c) => {
      if (!c) return c;
      switch (m.ev) {
        case "item": return { ...c, items: [...c.items, m.item] };
        case "pending": return { ...c, pending: m.pending };
        case "status": return { ...c, status: m.status, pending: m.pending ?? c.pending, title: m.title ?? c.title };
        case "meta": return { ...c, ...Object.fromEntries(Object.entries({ model: m.model, mode: m.mode, effort: m.effort, title: m.title, pinned: m.pinned }).filter(([, v]) => v !== undefined)) };
        case "context": return { ...c, stats: { ...(c.stats ?? {}), contextTokens: m.contextTokens, contextWindow: m.contextWindow, model: m.model } };
        case "init": return { ...c, models: m.models };
        case "error": return { ...c, status: "idle", items: [...c.items, { kind: "error", text: m.message, canFork: !!m.canFork }] };
        default: return c;
      }
    });
    if (m.ev === "delta") setStream((s) => s + m.text);
    if (m.ev === "item" && m.item.kind === "assistant") setStream("");
    // At the end of a turn the CLI transcript is the truth: reload it (keeps the view equal to `claude --resume`).
    if (m.ev === "status" && m.done) { setStream(""); playReceive(); loadQuick(); loadChat(m.id); api.chatUsage().then(setUsage).catch(() => {}); }
  }), [loadSessions, loadQuick, loadChat]);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [chat?.items.length, chat?.pending?.length, stream]);

  const results = useMemo(() => {
    const r = new Map();
    for (const it of chat?.items ?? []) if (it.kind === "tool_result") r.set(it.toolUseId, it);
    return r;
  }, [chat?.items]);

  // "/" autocomplete: only while the first word is being typed.
  const slash = /^\/([a-z0-9:-]*)$/i.exec(input);
  const matches = slash ? commands.filter((c) => c.name.startsWith(slash[1].toLowerCase())).slice(0, 8) : [];
  useEffect(() => { setPick(0); }, [input]);

  const inputRef = useRef("");
  inputRef.current = input;
  // T21 + hotkeys from Settings > Microphone (dictation, hands-free, push to dictate).
  const speech = useDictation({
    onInsert: (t) => setInput((cur) => { const v = cur && !/\s$/.test(cur) ? `${cur} ${t}` : `${cur}${t}`; inputRef.current = v; return v; }),
    onSend: () => { const v = inputRef.current.trim(); if (v && chat?.status !== "running") { setInput(""); send(v); } },
    texts: { denied: S.micDenied, error: S.micError, unsupported: S.micUnsupported },
  });
  const micTitle = `${S.micStart} · ${S.micModes.dictation}: ${speech.hotkeys.dictation} · ${S.micModes.handsfree}: ${speech.hotkeys.handsfree} · ${S.micModes.push}: ${speech.hotkeys.push}`;
  const running = chat?.status === "running";
  const opts = chat ? { engine: chat.engine ?? CLAUDE, model: chat.model ?? "", effort: chat.effort ?? "", mode: chat.mode ?? "default" } : draft;
  const isApiEngine = (opts.engine ?? CLAUDE) !== CLAUDE;
  // The engine of a chat is "claude_cli" or an API provider id; the picker works with provider ids.
  const cliProvider = modelOpts?.providers.find((p) => p.transport === "claude_cli")?.id ?? "claude";
  const providerOfEngine = (e) => (!e || e === CLAUDE ? cliProvider : e);
  const engineLabel = (e) => (!e || e === CLAUDE ? "Claude Code" : labelOf(modelOpts, e));
  const modelLabel = `${engineLabel(opts.engine)} · ${opts.model || (isApiEngine ? (modelOpts?.providers.find((p) => p.id === opts.engine)?.model ?? "") : T.views.models.cliDefault)}`;
  const stats = chat?.stats ?? null;
  const ctxLevel = contextLevel(stats?.contextTokens);

  const newChat = () => { setActiveId(null); setChat(null); setInput(""); setFiles([]); setError(""); box.current?.focus(); };
  async function send(raw) {
    const text = (raw ?? input).trim();
    if (!text && !files.length && !ctx.length) return;
    if (/^\/clear\b/.test(text)) { newChat(); return; }
    if (/^\/usage\b/.test(text)) { setShowUsage(true); setInput(""); return; }
    if (/^\/add-dir\b/.test(text)) { const p = text.replace(/^\/add-dir\s*/, "").trim().replace(/^"|"$/g, ""); setInput(""); if (p) addFolder(p); else setFolderMenu(true); return; }
    if (/^\/model\b/.test(text)) { const m = text.split(/\s+/)[1]; setInput(""); if (m) setOption("model", m); return; }
    setError("");
    playSend();
    const now = new Date().toISOString();
    try {
      let id = activeId;
      if (!id) {
        id = (await api.chatCreate(ws, { engine: draft.engine, model: draft.model || undefined, effort: draft.effort || undefined, mode: draft.mode, addDirs: draft.addDirs })).id;
        fresh.current = id;
        setActiveId(id);
        setChat({ id, items: [], pending: [], status: "running", title: text.slice(0, 80), ...draft });
      }
      setChat((c) => (c ? { ...c, status: "running", items: [...c.items, { kind: "user", ts: now, text, chips: ctx, images: files.filter((f) => f.preview).length, files: files.map((f) => f.name) }] } : c));
      if (raw === undefined) setInput("");
      await api.chatSend(ws, id, { text, context: ctx, attachments: files.map(({ name, mime, data }) => ({ name, mime, data })) });
      setCtx([]);
      setFiles([]);
      loadSessions();
    } catch (e) { setError(e.message); }
  }
  // Skill buttons (Raka 2026-11-10): no arguments = send at once; arguments = popup, empty allowed.
  const useSkill = (s) => {
    if (running) return;
    if (s.takesArgs) setArgsFor(s);
    else send(`/${s.name}`);
  };
  // The session is held by a background claude job: continue as a copy and put the unsent message back in the box.
  const forkActive = async () => {
    try {
      const lastUser = [...(chat?.items ?? [])].reverse().find((x) => x.kind === "user")?.text ?? "";
      const n = await api.chatFork(ws, activeId);
      setActiveId(n.id);
      setInput(lastUser);
      loadSessions();
      box.current?.focus();
    } catch (e) { setError(e.message); }
  };
  const answer = async (p, body) => {
    try { await api.chatAnswer(ws, activeId, { requestId: p.requestId, ...body }); } catch (e) { setError(e.message); }
  };
  // Model picker result: same engine = only the model changes; another engine = a linked new session.
  async function pickModel({ provider, transport, model, persist }) {
    const engine = transport === "claude_cli" ? CLAUDE : provider;
    if (persist) await api.setMainModel(provider, model);
    if (!activeId) { setDraft((d) => ({ ...d, engine, model, touched: true, effort: engine === CLAUDE ? d.effort : "" })); return; }
    if (engine === (chat?.engine ?? CLAUDE)) { await setOption("model", model); return; }
    if (!chat?.items?.length) { await doSwitch(engine, model); return; }
    setSwitchTo({ engine, model });
  }
  async function setOption(key, value) {
    if (!activeId) { setDraft((d) => ({ ...d, [key]: value, touched: true })); return; }
    try { const m = await api.chatOptions(ws, activeId, { [key]: value }); setChat((c) => ({ ...c, model: m.model, effort: m.effort, mode: m.mode, addDirs: m.addDirs ?? [] })); } catch (e) { setError(e.message); }
  }
  // T12: another engine = a new linked session that starts with a summary of this one.
  async function doSwitch(engine, model) {
    setSwitching(true); setError("");
    try {
      const n = await api.chatSwitch(ws, activeId, { engine, model: model || undefined });
      setSwitchTo(null);
      setActiveId(n.id);
      loadSessions();
    } catch (e) { setError(e.message); } finally { setSwitching(false); }
  }
  const addFiles = async (list) => {
    try {
      const read = await Promise.all([...list].slice(0, 10).map(readFile));
      setFiles((f) => [...f, ...read].slice(0, 10));
    } catch (e) { setError(e.message); }
  };
  const onPaste = (e) => {
    const imgs = [...(e.clipboardData?.files ?? [])];
    if (imgs.length) { e.preventDefault(); addFiles(imgs); }
  };
  const togglePin = async (name, on) => { try { await api.chatPin(ws, name, on); loadQuick(); } catch (e) { setError(e.message); } };
  const dirs = (chat ? chat.addDirs : draft.addDirs) ?? [];
  const addFolder = (p) => { const v = String(p ?? "").trim(); if (!v) return; setFolderMenu(false); setFolderPath(""); if (!dirs.some((d) => d.toLowerCase() === v.toLowerCase())) setOption("addDirs", [...dirs, v]); };
  const removeFolder = (p) => setOption("addDirs", dirs.filter((d) => d !== p));
  const browse = async () => { try { const r = await api.browseFolder(); if (r?.path) addFolder(r.path); } catch (e) { setError(e.message); } };
  // Ghost suggestion: shown as the placeholder while the box is empty; Tab writes it into the box.
  const pool = (chat?.items?.length ? S.followUps : S.starters) ?? [];
  // Prompt Suggestions (Settings): after a finished turn a light model proposes replies; chips + Tab use them.
  const sg = useSuggestSettings();
  const [aiSug, setAiSug] = useState([]);
  const [sugOff, setSugOff] = useState(false); // Esc hides chips and ghost text until the next turn
  const lastItem = chat?.items?.[chat.items.length - 1];
  const sgKey = sg.enabled && !running && lastItem?.kind === "assistant" ? `${activeId}:${chat.items.length}` : "";
  useEffect(() => {
    setAiSug([]); setSugOff(false);
    if (!sgKey) return undefined;
    let live = true;
    const text = chat.items.filter((x) => (x.kind === "user" || x.kind === "assistant") && x.text).slice(-2).map((x) => `${x.kind === "user" ? "User" : "Assistant"}: ${x.text}`).join("\n\n");
    api.chatSuggest({ text, provider: sg.provider || undefined, model: sg.model, effort: sg.effort, language: sg.language }).then((r) => { if (live) setAiSug(r.suggestions ?? []); }).catch(() => {});
    return () => { live = false; };
  }, [sgKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const suggestion = ws && !running && !input && !sugOff && (aiSug[0] || pool.length) ? (aiSug[0] ?? pool[(chat?.items?.length ?? 0) % pool.length]) : "";
  // after Send (or any programmatic clear) the auto-grown box returns to its resting height.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    if (input) el.style.height = `${Math.min(192, el.scrollHeight)}px`;
    else el.style.height = "";
  }, [input]);
  const onKey = (e) => {
    if (e.key === "Tab" && !e.shiftKey && suggestion && !matches.length) { e.preventDefault(); setInput(suggestion); return; }
    if (matches.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) { e.preventDefault(); setPick((p) => (p + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length); return; }
    if (matches.length && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && `/${matches[pick].name}` !== input.trim()))) { e.preventDefault(); setInput(`/${matches[pick].name} `); return; }
    if (e.key === "Escape" && !running && !input && (aiSug.length || suggestion)) { e.preventDefault(); setSugOff(true); return; }
    if (e.key === "Escape" && running) { api.chatStop(ws, activeId).catch(() => {}); return; }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (!running) send(); }
  };
  const isInsights = Boolean(ws && homeWs && ws !== homeWs.key) || Boolean(fixedWs && !homeWs);
  const project = isInsights ? projects.find((p) => p.key === ws) : homeWs;
  const kindTitle = isInsights ? `${S.insightsTitle} · ${ws}` : S.title;
  const openTab = () => window.open(`/cognition?ws=${encodeURIComponent(ws)}${activeId ? `&s=${activeId}` : ""}`, "_blank", "noopener");
  const visibleSessions = sessions.filter((s) => !filter || s.title.toLowerCase().includes(filter.toLowerCase()));

  // ---- pieces shared by the layouts ----
  const pickers = (
    <>
      <Button variant="outline" size="sm" title={S.modelButton} aria-label={S.modelButton} onClick={() => { loadModelOpts(); setModelPicker(true); }}
        className="h-8 max-w-72 gap-1.5 rounded-full border-border-strong bg-card/70 px-3 text-xs font-medium shadow-xs">
        <Cpu className="size-3.5 shrink-0 text-primary" /><span className="truncate">{modelLabel}</span><ChevronDown className="size-3.5 shrink-0 opacity-60" />
      </Button>
      {!isApiEngine && (
        <Picker label={S.effort} icon={Gauge} value={opts.effort} onChange={(v) => setOption("effort", v)}>
          <SelectItem value={DEF}>{S.defaultEffort}</SelectItem>
          {EFFORTS.map((m) => <SelectItem key={m} value={m}>effort {m}</SelectItem>)}
        </Picker>
      )}
      <Picker label={S.mode} icon={MODE_ICON[opts.mode] ?? ShieldCheck} value={opts.mode} display={S.modes[opts.mode] ?? opts.mode} onChange={(v) => setOption("mode", v || "default")}>
        {MODES.map((m) => <SelectItem key={m} value={m}><span className="grid"><span>{S.modes[m]}</span><span className="text-[11px] text-muted-foreground">{S.modeHints[m]}</span></span></SelectItem>)}
      </Picker>
    </>
  );
  // The server keeps the home folder apart from the registered projects; the picker lists both, home first.
  const pickList = homeWs ? [homeWs, ...projects.filter((p) => p.key !== homeWs.key)] : projects;
  const canSwitchWs = layout === "full" && pickList.length > 1; // only the own-tab chat (/cognition); the menu screen and drawer stay fixed
  const wsPicker = canSwitchWs ? (
    <Select value={ws} onValueChange={(v) => { setWs(v); setActiveId(null); }}>
      <SelectTrigger size="sm" aria-label={S.workspace} title={project?.path ?? S.workspace} className="h-8 w-full min-w-0 rounded-full border-border-strong bg-card/70 px-3 text-xs font-medium">
        {isInsights ? <Bot className="size-3.5 shrink-0 text-primary" /> : <BrainCog className="size-3.5 shrink-0 text-primary" />}
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper" className="max-h-80">
        {pickList.map((p) => <SelectItem key={p.key} value={p.key}>{p.name ?? p.key}</SelectItem>)}
      </SelectContent>
    </Select>
  ) : (
    <div className="grid gap-1.5">
      <span className="flex min-w-0 items-center gap-1.5 rounded-full border border-border-strong bg-card/70 px-3 py-1.5 text-xs font-medium" title={project?.path ?? ""}>
        {isInsights ? <Bot className="size-3.5 shrink-0 text-primary" /> : <BrainCog className="size-3.5 shrink-0 text-primary" />}
        <span className="truncate">{isInsights ? ws : (homeWs?.name ?? homeWs?.key ?? "Artrios")}</span>
      </span>
    </div>
  );

  const folderBar = (
      <div className="flex flex-wrap items-center gap-1" aria-label={S.addDir}>
        {dirs.map((d) => (
          <span key={d} className="flex max-w-full items-center gap-1 rounded-full border bg-muted/50 py-0.5 pl-2 pr-1 text-[11px]" title={d}>
            <FolderPlus className="size-3 shrink-0" /><span className="truncate">{projects.find((p) => p.path?.toLowerCase() === d.toLowerCase())?.key ?? d}</span>
            <button type="button" aria-label={`${S.remove} ${d}`} onClick={() => removeFolder(d)}><X className="size-3" /></button>
          </span>
        ))}
        <DropdownMenu open={folderMenu} onOpenChange={setFolderMenu}>
          <DropdownMenuTrigger asChild><Button size="xs" variant="ghost" className="rounded-full" title={S.addDirHint}><FolderPlus className="size-3" /> {S.addDir}</Button></DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-96 w-80 overflow-y-auto">
            <DropdownMenuLabel>{S.addDirHint}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {projects.filter((p) => !dirs.some((d) => d.toLowerCase() === p.path?.toLowerCase())).map((p) => (
              <DropdownMenuItem key={p.key} onSelect={() => addFolder(p.path)}>
                <span className="grid min-w-0"><span className="font-medium">{p.key}</span><span className="truncate text-[11px] text-muted-foreground">{p.path}</span></span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={(e) => { e.preventDefault(); browse(); }}><Search className="size-3.5" /> {S.browseDir}</DropdownMenuItem>
            <div className="flex gap-1 p-1.5">
              <input className={cn(FIELD_FULL, "h-8")} placeholder="D:\\path\\folder" value={folderPath} onChange={(e) => setFolderPath(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") addFolder(folderPath); }} />
              <Button size="sm" onClick={() => addFolder(folderPath)}>{S.add}</Button>
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
  );

  const messages = (
    <>
      {!chat && (
        <div className="mx-auto grid max-w-xl justify-items-center gap-2 py-10 text-center">
          {isInsights ? <Sparkles className="size-7 text-primary" /> : <BrainCog className="size-7 text-primary" />}
          <h3 className="font-heading text-lg font-bold">{kindTitle}</h3>
          <p className="text-sm text-muted-foreground">{isInsights ? S.insightsHint : S.startHint}</p>
        </div>
      )}
      {chat?.truncated && <p className="mb-3 text-center text-xs text-muted-foreground">{S.truncated}</p>}
      {(chat?.linkedFrom || chat?.linkedTo) && (
        <div className="mb-3 flex flex-wrap justify-center gap-2 text-xs text-muted-foreground">
          {chat.linkedFrom && <span className="flex items-center gap-1.5 rounded-full border bg-muted/40 px-2.5 py-0.5">{S.linkedFrom} <code>{chat.linkedFrom.slice(0, 8)}</code><Button size="xs" variant="ghost" onClick={() => setActiveId(chat.linkedFrom)}>{S.openLinked}</Button></span>}
          {chat.linkedTo && <span className="flex items-center gap-1.5 rounded-full border bg-muted/40 px-2.5 py-0.5">{S.linkedTo} <code>{chat.linkedTo.slice(0, 8)}</code><Button size="xs" variant="ghost" onClick={() => setActiveId(chat.linkedTo)}>{S.openLinked}</Button></span>}
        </div>
      )}
      {chat?.items.map((it, i) => {
        const prevTs = chat.items.slice(0, i).reverse().find((x) => x.ts)?.ts;
        const sep = it.ts && (!prevTs || day(prevTs) !== day(it.ts)) ? <div key={`d${i}`} className="my-3 flex justify-center"><span className="rounded-full bg-muted px-3 py-0.5 text-[11px] text-muted-foreground shadow-xs">{day(it.ts)}</span></div> : null;
        let el = null;
        if (it.kind === "tool_result") el = null;
        else if (it.kind === "tool_use") el = <ToolRow item={it} result={results.get(it.id)} />;
        else if (it.kind === "system") el = <p className="mb-2 text-center text-xs text-muted-foreground">{it.text}</p>;
        else if (it.kind === "error") el = (
          <div className="mb-3 grid max-w-[85%] gap-2 rounded-xl border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <p>{it.text}</p>
            {it.canFork && <div><Button size="sm" variant="outline" onClick={forkActive}>{S.forkCopy}</Button></div>}
          </div>
        );
        else {
          const user = it.kind === "user";
          const pv = user ? splitPrev(it.text) : null;
          const split = user ? (it.chips ? { body: pv.text, chips: it.chips } : splitContext(pv.text)) : null;
          el = (
            <div className={cn("mb-2 flex", user ? "justify-end" : "justify-start")}>
              <div className={cn("relative max-w-[85%] px-3 pt-2 pb-1.5 text-sm break-words shadow-xs",
                full ? "rounded-2xl" : "rounded-xl border",
                user ? cn("whitespace-pre-wrap", full ? "rounded-br-md bg-primary text-primary-foreground" : "border-primary/40 bg-primary/10") : cn(full ? "rounded-bl-md border bg-card" : "bg-muted/50"))}>
                {user ? split.body : <Markdown text={it.text} />}
                {user && pv.prev && <details className="mb-1 text-xs opacity-90"><summary className="cursor-pointer">{S.prevSession}</summary><p className="mt-1 whitespace-pre-wrap">{pv.prev}</p></details>}
                {user && split.chips.length > 0 && <div className="mt-1.5 flex flex-wrap gap-1">{split.chips.map((c, j) => <Chip key={j} c={c} />)}</div>}
                {user && (it.images > 0 || it.files?.length > 0) && <div className="mt-1 text-[11px] opacity-80">{it.images > 0 && `${it.images} gambar`}{it.files?.length > 0 && ` · ${it.files.join(", ")}`}</div>}
                {it.ts && <div className={cn("mt-0.5 text-right text-[10px]", user && full ? "text-primary-foreground/70" : "text-muted-foreground")}>{clock(it.ts)}</div>}
              </div>
            </div>
          );
        }
        return el || sep ? <div key={i}>{sep}{el}</div> : null;
      })}
      {stream && <div className="mb-3 flex justify-start"><div className={cn("max-w-[85%] px-3 py-2 text-sm", full ? "rounded-2xl rounded-bl-md border bg-card" : "rounded-xl border bg-muted/50")}><Markdown text={stream} /></div></div>}
      {chat?.pending?.map((p) => (p.kind === "question"
        ? <QuestionCard key={p.requestId} p={p} onAnswer={(b) => answer(p, b)} />
        : <PermissionCard key={p.requestId} p={p} onAnswer={(b) => answer(p, b)} />))}
      {running && !chat?.pending?.length && !stream && (
        <div className="mb-3 flex w-fit items-center gap-2 rounded-2xl border bg-card px-3 py-2 text-sm text-muted-foreground" role="status">
          <span className="flex gap-1" aria-hidden="true">{[0, 1, 2].map((d) => <span key={d} className="size-1.5 animate-bounce rounded-full bg-primary" style={{ animationDelay: `${d * 150}ms` }} />)}</span>
          {S.working}
        </div>
      )}
      <div ref={end} />
    </>
  );

  const composer = (
    <footer className={cn("grid gap-2 p-3", !full && "border-t")}>
      {folderBar}
      {error && <p className="text-sm text-destructive">{error}</p>}
      {ctx.length > 0 && <div className="flex flex-wrap gap-1.5" aria-label={S.context}>{ctx.map((c, i) => <Chip key={i} c={c} onRemove={() => setCtx(ctx.filter((_, j) => j !== i))} />)}</div>}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {files.map((f, i) => (
            <span key={i} className="flex items-center gap-1.5 rounded-full border bg-muted/50 py-0.5 pl-1 pr-1.5 text-xs">
              {f.preview ? <img src={f.preview} alt="" className="size-6 rounded-full object-cover" /> : <FileText className="size-3.5" />}
              <span className="max-w-40 truncate">{f.name}</span>
              <button type="button" aria-label={`${S.remove} ${f.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))}><X className="size-3" /></button>
            </span>
          ))}
        </div>
      )}
      {aiSug.length > 0 && !input && !running && !sugOff && (
        <div className="flex flex-wrap gap-1.5 pb-1.5">
          {aiSug.map((t) => (
            <button key={t} type="button" className="rounded-full border border-border-strong bg-card px-2.5 py-1 text-xs hover:bg-accent" onClick={() => { setInput(t); box.current?.focus(); }}>{t}</button>
          ))}
        </div>
      )}
      <div className="relative flex items-end gap-2">
        {matches.length > 0 && (
          <ul role="listbox" aria-label={S.commands} className="absolute bottom-full left-0 z-30 mb-1 max-h-72 w-full max-w-lg overflow-y-auto rounded-xl border bg-popover p-1 shadow-md">
            {matches.map((c, i) => (
              <li key={c.name} role="option" aria-selected={i === pick}>
                <button type="button" className={cn("grid w-full gap-0.5 rounded-lg px-2 py-1 text-left", i === pick && "bg-accent")} onMouseDown={(e) => { e.preventDefault(); setInput(`/${c.name} `); box.current?.focus(); }}>
                  <span className="font-mono text-[13px]">/{c.name} <span className="text-muted-foreground">{c.argumentHint}</span></span>
                  {c.description && <span className="truncate text-[11px] text-muted-foreground">{c.description}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
        <input ref={fileInput} type="file" multiple className="hidden" onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
        <div className={cn("flex min-w-0 flex-1 items-end gap-1 rounded-2xl border border-border-strong bg-card/70 px-1.5 py-1 focus-within:border-primary/70 focus-within:ring-4 focus-within:ring-primary/15")}>
          <Button variant="ghost" size="icon-sm" className="rounded-full" title={S.attach} aria-label={S.attach} onClick={() => fileInput.current?.click()}><Paperclip className="size-4" /></Button>
          <textarea
            ref={box}
            rows={full ? 1 : 2}
            className="max-h-48 min-h-9 flex-1 resize-none bg-transparent px-1 py-2 text-[13px] outline-none placeholder:text-muted-foreground"
            placeholder={speech.on ? `${S.listening} (${S.micModes[speech.active] ?? S.micStart})` : ws ? (suggestion ? `${suggestion}  ${S.tabHint}` : S.placeholder) : S.pickWorkspace}
            value={speech.interim ? `${input}${input && !/\s$/.test(input) ? " " : ""}${speech.interim}` : input}
            disabled={!ws}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            onPaste={onPaste}
            onInput={(e) => { e.currentTarget.style.height = "auto"; e.currentTarget.style.height = `${Math.min(192, e.currentTarget.scrollHeight)}px`; }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer.files); }}
          />
          {speech.supported && (
            <Button variant={speech.on ? "destructive" : "ghost"} size="icon-sm" className={cn("rounded-full", speech.on && "animate-pulse")} aria-pressed={speech.on} title={speech.on ? S.micStop : micTitle} aria-label={speech.on ? S.micStop : S.micStart} onClick={speech.toggle}>
              {speech.on ? <MicOff className="size-4" /> : <Mic className="size-4" />}
            </Button>
          )}
        </div>
        {running
          ? <Button variant="destructive" className="h-11 rounded-full" onClick={() => api.chatStop(ws, activeId).catch((e) => setError(e.message))}><Square className="size-4" /> {S.stop}</Button>
          : <Button className="h-11 rounded-full" disabled={!ws || (!input.trim() && !files.length && !ctx.length)} onClick={() => send()}><Send className="size-4" /> <span className={cn(full && "sr-only")}>{S.send}</span></Button>}
      </div>
      {speech.err && <p className="text-xs text-destructive">{speech.err}</p>}
      <SkillPanel quick={quick.items} all={quick.all} onUse={useSkill} onPin={togglePin} disabled={!ws || running} />
      {!full && <p className="text-[11px] text-muted-foreground">{S.hint}</p>}
    </footer>
  );

  const header = (
    <header className={cn("flex flex-wrap items-center gap-2 px-3 py-2", full ? "border-b bg-card/80 backdrop-blur" : "border-b")}>
      {full && (
        <Button size="icon-sm" variant="ghost" className="hidden md:inline-flex" title={sideHidden ? "Show sessions" : "Hide sessions"} aria-label={sideHidden ? "Show sessions" : "Hide sessions"} aria-pressed={sideHidden} onClick={() => setSideHidden(!sideHidden)}>
          {sideHidden ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
        </Button>
      )}
      {full
        ? <span className={cn("grid size-9 shrink-0 place-items-center rounded-full font-heading text-sm font-bold", hue(activeId ?? "new"))}>{initials(chat?.title ?? "AR")}</span>
        : isInsights ? <Sparkles className="size-5 shrink-0 text-primary" aria-hidden="true" /> : <BrainCog className="size-5 shrink-0 text-primary" aria-hidden="true" />}
      <div className="grid min-w-0 flex-1 basis-48 gap-1 leading-tight">
        <h2 className="truncate font-heading text-sm font-bold">{chat?.title ?? kindTitle}</h2>
        <span className="truncate text-xs text-muted-foreground">
          {running ? S.typing : project?.path ?? ""}{activeId && !running ? ` · ${activeId.slice(0, 8)}` : ""}
        </span>
        {chat && <ContextBar stats={stats} className="max-w-md" />}
        {chat && ctxLevel && ctxLevel !== "ok" && (
          <div role="alert" className={cn("flex flex-wrap items-center gap-2 rounded-md border px-2 py-1 text-[11px]", ctxLevel === "high" ? "border-destructive/50 bg-destructive/10 text-destructive" : "border-warning/50 bg-warning/10")}>
            <span className="min-w-0 flex-1 basis-40">{ctxLevel === "high" ? S.ctxWarnHigh : S.ctxWarn} ({kfmt(stats?.contextTokens)})</span>
            <Button size="xs" variant="outline" disabled={running} onClick={() => send("/compact")}>{S.compact}</Button>
            <Button size="xs" variant="outline" onClick={newChat}>{S.ctxNew}</Button>
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {pickers}
        <Button variant={sg.enabled ? "secondary" : "ghost"} size="icon-sm" className="rounded-full" role="switch" aria-checked={sg.enabled} title={`${S.suggestToggle}: ${sg.enabled ? S.suggestOn : S.suggestOff}`} aria-label={S.suggestToggle} onClick={() => saveSuggest({ ...sg, enabled: !sg.enabled })}>{sg.enabled ? <Lightbulb className="size-4" /> : <LightbulbOff className="size-4" />}</Button>
        <Button variant="ghost" size="icon-sm" className="rounded-full" title={S.usageTitle} aria-label={S.usageTitle} onClick={() => setShowUsage(true)}><Gauge className="size-4" /></Button>
        {activeId && (
          <Button variant="ghost" size="icon-sm" className="rounded-full" title={chat?.pinned ? S.unpin : S.pin} aria-label={chat?.pinned ? S.unpin : S.pin} onClick={() => api.chatOptions(ws, activeId, { pinned: !chat?.pinned }).then(() => { loadSessions(); setChat((c) => ({ ...c, pinned: !c.pinned })); })}>
            {chat?.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
          </Button>
        )}
        {onOpenPutusan && <Button variant="ghost" size="icon-sm" className="rounded-full" title="Putusan" aria-label="Putusan" onClick={onOpenPutusan}><Gavel className="size-4" /></Button>}
        {!full && <Button variant="ghost" size="icon-sm" className="rounded-full" title={S.openTab} aria-label={S.openTab} onClick={openTab}><ExternalLink className="size-4" /></Button>}
      </div>
    </header>
  );

  const sessionList = (
    <ul className="min-h-0 flex-1 overflow-y-auto p-1.5" aria-label={S.sessions}>
      {visibleSessions.length === 0 && <li className="px-2 py-4 text-center text-xs text-muted-foreground">{S.noSessions}</li>}
      {visibleSessions.map((s) => (
        <li key={s.id}>
          <button type="button" onClick={() => setActiveId(s.id)} className={cn("flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left", s.id === activeId ? "bg-accent text-accent-foreground" : "hover:bg-muted/60")}>
            {full && <span className={cn("grid size-10 shrink-0 place-items-center rounded-full font-heading text-sm font-bold", hue(s.id))}>{initials(s.title)}</span>}
            <span className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)] gap-1">
              <span className="flex min-w-0 items-center gap-1.5">
                {s.status === "running" && <span className="dot-running size-1.5 shrink-0 rounded-full bg-positive" aria-label={S.running} />}
                {s.pending > 0 && <span className="size-1.5 shrink-0 rounded-full bg-warning" aria-label={S.waiting} />}
                {s.pinned && <Pin className="size-3 shrink-0" />}
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{s.title}</span>
                <span className="shrink-0 text-[10px] text-muted-foreground">{ago(s.updated)}</span>
              </span>
              <span className="flex min-w-0 items-center gap-2">
                <ContextBar stats={s.stats} compact className="min-w-0 flex-1" />
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{kfmt(s.stats?.contextTokens)}{s.stats?.costUsd != null ? ` · ${usd(s.stats.costUsd)}` : ""} · {s.engine && s.engine !== CLAUDE ? s.engine : s.source === "ui" ? "UI" : "CLI"}</span>
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );

  const dialogs = (
    <>
      <Dialog open={!!switchTo} onOpenChange={(o) => { if (!o && !switching) setSwitchTo(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{S.switchTitle}</DialogTitle><DialogDescription>{S.switchBody}</DialogDescription></DialogHeader>
          <DialogFooter>
            <Button variant="ghost" disabled={switching} onClick={() => setSwitchTo(null)}>{S.cancel}</Button>
            <Button disabled={switching} onClick={() => doSwitch(switchTo.engine, switchTo.model)}>{switching ? S.switching : `${S.switchGo}: ${engineLabel(switchTo?.engine)}${switchTo?.model ? ` · ${switchTo.model}` : ""}`}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ModelPicker open={modelPicker} onClose={() => setModelPicker(false)} options={modelOpts} mode="session"
        current={{ provider: providerOfEngine(opts.engine), model: opts.model ?? "" }}
        onApply={pickModel} onRefresh={async (id) => { await api.refreshProviderModels(id); await loadModelOpts(); }} />
      <UsageDialog open={showUsage} onClose={() => setShowUsage(false)} stats={stats} rate={usage.rate} rateTs={usage.rateTs} apiChat={isApiEngine} />
      <ArgsDialog skill={argsFor} onClose={() => setArgsFor(null)} onSend={(a) => { const s = argsFor; setArgsFor(null); send(`/${s.name}${a.trim() ? ` ${a.trim()}` : ""}`); }} />
    </>
  );

  if (layout === "compact") {
    return (
      <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-3">
        <div className="flex flex-wrap gap-2">
          {wsPicker}
          <Select value={activeId ?? DEF} onValueChange={(v) => setActiveId(v === DEF ? null : v)}>
            <SelectTrigger size="sm" aria-label={S.sessions} className="h-8 min-w-0 flex-1 rounded-full border-border-strong bg-card/70 px-3 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent position="popper" className="max-h-80">
              <SelectItem value={DEF}>{S.newChat}</SelectItem>
              {sessions.map((s) => <SelectItem key={s.id} value={s.id}>{s.title}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <section className="flex min-h-0 flex-col rounded-xl border bg-card">
          {header}
          <div className="min-h-0 flex-1 overflow-y-auto p-4">{messages}</div>
          {composer}
        </section>
        {dialogs}
      </div>
    );
  }

  if (full) {
    return (
      <div className={cn("grid h-svh min-h-0 grid-cols-1 bg-background", sideHidden ? "md:grid-cols-[minmax(0,1fr)]" : "md:grid-cols-[22rem_minmax(0,1fr)]")}>
        <aside className={cn("flex min-h-0 flex-col border-r bg-card", activeId && "hidden md:flex", sideHidden && "md:hidden")}>
          <div className="grid gap-2 border-b p-3">
            <div className="flex items-center gap-2">
              {isInsights ? <Sparkles className="size-5 shrink-0 text-primary" aria-hidden="true" /> : <BrainCog className="size-5 shrink-0 text-primary" aria-hidden="true" />}
              <h1 className="flex-1 truncate font-heading text-lg font-bold">{kindTitle}</h1>
              {headerExtra}
              <Button size="icon-sm" className="rounded-full" title={S.newChat} aria-label={S.newChat} onClick={newChat}><Plus className="size-4" /></Button>
            </div>
            {wsPicker}
            <label className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input className={cn(FIELD_FULL, "h-9 rounded-full pl-8")} placeholder={S.searchSessions} value={filter} onChange={(e) => setFilter(e.target.value)} />
            </label>
          </div>
          {sessionList}
        </aside>
        <section className={cn("flex min-h-0 flex-col", !activeId && !chat && "hidden md:flex")}>
          {header}
          <div className="chat-wall min-h-0 flex-1 overflow-y-auto px-3 py-4 md:px-[8%]">{messages}</div>
          <div className="border-t bg-card/80 backdrop-blur md:px-[8%]">{composer}</div>
        </section>
        {dialogs}
      </div>
    );
  }

  return (
    <div className="grid h-[calc(100vh-9.5rem)] min-h-[30rem] gap-4 md:grid-cols-[18rem_minmax(0,1fr)]">
      <aside className="flex min-h-0 flex-col rounded-xl border bg-card">
        <div className="grid gap-2 border-b p-2">
          {wsPicker}
          <Button size="sm" className="rounded-full" onClick={newChat}><Plus className="size-4" /> {S.newChat}</Button>
        </div>
        {sessionList}
      </aside>
      <section className="flex min-h-0 flex-col rounded-xl border bg-card">
        {header}
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{messages}</div>
        {composer}
      </section>
      {dialogs}
    </div>
  );
}

