import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive, FolderSearch, AlertCircle, BookOpen, Clock, Columns3, Rows3, EllipsisVertical, GitBranch, Inbox, LayoutGrid,
  Brain, CalendarDays, Download, Gavel, BrainCog, Lightbulb, LoaderCircle, Plus, RefreshCw, Settings, Sparkles, Square, SquareTerminal,
} from "lucide-react";
import { api } from "./api.js";
import { usePersisted } from "./lib/persist.js";
import { BrandMark } from "@/components/brand-mark";
import { ProviderModelSelect } from "@/components/provider-model-select";
import { subscribe } from "./socket.js";
import JobLog, { stamp } from "./JobLog.jsx";
import Terminal from "./Terminal.jsx";
import AddProject from "./AddProject.jsx";
import Ideation from "./views/Ideation.jsx";
import SettingsView from "./views/Settings.jsx";
// Roadmap (./views/Roadmap.jsx, GET/PUT /roadmap) is hidden for now. Bring it back when the AI-generated roadmap
// (Auto Claude style, through the engine) is built; see AIOS-68 "additional features".
import { OverviewView } from "./views/Simple.jsx";
import { CardWorktreePanel, WorktreesView } from "./views/Worktrees.jsx";
import { ReviewPanel } from "@/components/review-panel";
import { ArchiveDialog } from "@/components/archive-dialog";
import { FilePicker } from "@/components/file-picker";
import { Field, FIELD_FULL, FIELD } from "@/components/field";
import { T } from "./texts.js";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/combobox";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarInset,
  SidebarMenu, SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarRail, SidebarTrigger,
} from "@/components/ui/sidebar";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ThemeToggle } from "@/components/theme-toggle";

const TodayView = lazy(() => import("./views/Routines.jsx"));
const BrainView = lazy(() => import("./views/Brain.jsx"));
const PutusanView = lazy(() => import("./views/Putusan.jsx"));
const CognitionView = lazy(() => import("./views/Cognition.jsx"));

const COLUMNS = ["error", "backlog", "todo", "in_progress", "ai_review", "human_review", "pr_created", "done"];
const PRIORITIES = ["urgent", "high", "medium", "low", "none"];
const RANK = Object.fromEntries(PRIORITIES.map((p, i) => [p, i]));
const today = () => new Date().toISOString().slice(0, 10);
const num = (key) => Number(key.split("-").pop());

// Full class names so Tailwind can see them.
const COL_LEFT = {
  error: "border-l-destructive", backlog: "border-l-muted-foreground/60", todo: "border-l-info",
  in_progress: "border-l-info", ai_review: "border-l-warning", human_review: "border-l-warning", pr_created: "border-l-self", done: "border-l-primary",
};
const COL_TOP = {
  error: "border-t-destructive", backlog: "border-t-muted-foreground/60", todo: "border-t-info",
  in_progress: "border-t-info", ai_review: "border-t-warning", human_review: "border-t-warning", pr_created: "border-t-self", done: "border-t-primary",
};
const COL_ICON = { error: AlertCircle, in_progress: LoaderCircle };
const PRIO_CLASS = { urgent: "text-destructive border-destructive/50", high: "text-warning border-warning/50", medium: "text-info border-info/50", low: "text-muted-foreground" };

function useData(project) {
  const [state, setState] = useState({ cards: [], broken: [], events: [], jobs: [], bridge: null });
  const [error, setError] = useState("");
  const reload = useCallback(async () => {
    if (!project) return;
    try {
      const [c, a, j] = await Promise.all([api.cards(project), api.activity(project), api.jobs(project).catch(() => ({ jobs: [] }))]);
      setState({ cards: c.cards, broken: c.broken, events: a.events, jobs: j.jobs, bridge: c.bridge ?? null });
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }, [project]);
  useEffect(() => {
    reload();
    const id = setInterval(reload, 15000);
    return () => clearInterval(id);
  }, [reload]);
  // New events appear at once; a changed card or job also refreshes the board (job failure moves a card to error).
  useEffect(() => subscribe((m) => {
    if (m.project !== project) return;
    if (m.type === "activity") {
      setState((cur) => ({ ...cur, events: [m.event, ...cur.events].slice(0, 100) }));
      if (m.event.type.startsWith("card.") || m.event.type === "job.finished") reload();
    }
    if (m.type === "job.status") {
      setState((cur) => ({ ...cur, jobs: cur.jobs.some((j) => j.id === m.meta.id) ? cur.jobs.map((j) => (j.id === m.meta.id ? m.meta : j)) : [m.meta, ...cur.jobs] }));
    }
  }), [project, reload]);
  return { ...state, error, reload };
}

// Workspace screens belong to the selected workspace. Kit screens belong to the kit itself and need no workspace.
const WORKSPACE_NAV = [
  { id: "board", label: "Kanban Board", key: "K", icon: LayoutGrid },
  { id: "terminal", label: T.nav.terminals, key: "A", icon: SquareTerminal },
  { id: "overview", label: "Overview", key: "O", icon: BookOpen },
  { id: "insights", label: "Insights", key: "N", icon: Sparkles },
  { id: "ideation", label: "Ideation", key: "I", icon: Lightbulb },
  { id: "worktrees", label: "Worktrees", key: "W", icon: GitBranch },
];
const KIT_NAV = [
  { id: "cognition", label: "Cognition", key: "C", icon: BrainCog },
  { id: "putusan", label: "Decision Required", key: "P", icon: Gavel },
  { id: "brain", label: "Brain", key: "B", icon: Brain },
  { id: "today", label: "Routines", key: "H", icon: CalendarDays },
];
const NAV = [...WORKSPACE_NAV, ...KIT_NAV];

function AppSidebar({ view, onView, onNew, connected, claude, provider, disabled, boardOnly = false, newDisabled = false, pending = 0, cognitionUnseen = 0, terminalOn = true }) {
  // The footer names what actually runs jobs: an API provider needs no CLI, and "none" must be visible.
  const isCli = !provider || provider.transport === "claude_cli";
  const healthy = connected && (isCli ? claude?.ok && provider !== null : true);
  const engineText = provider === null ? T.nav.noProvider
    : !isCli ? `${provider.id}${provider.model ? ` · ${provider.model}` : ""}`
    : claude?.ok ? `${T.nav.claudeCode} ${claude.version ?? ""}`.trim() : claude ? T.nav.claudeMissing : T.nav.connected;
  return (
    <Sidebar collapsible="icon" variant="inset">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" className="pointer-events-none">
              {/* Wrapped: the menu button forces direct svg children to 16 px. */}
              <span className="-ml-1 grid size-8 shrink-0 place-items-center"><BrandMark size={30} className="drop-shadow-[0_0_6px_var(--primary)]" /></span>
              <div className="grid flex-1 text-left leading-tight group-data-[collapsible=icon]:hidden">
                <span className="truncate font-heading text-[17px] font-bold tracking-tight">{T.appName}</span>
                <span className="eyebrow leading-tight tracking-[0.06em] whitespace-normal">{T.nav.tagline}</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>{T.nav.section}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {WORKSPACE_NAV.filter((n) => terminalOn || n.id !== "terminal").map((n) => (
                <SidebarMenuItem key={n.id}>
                  {n.soon ? (
                    <>
                      <SidebarMenuButton tooltip={`${n.label} (${T.nav.soon})`} className="pr-14 opacity-50" aria-disabled>
                        <n.icon />
                        <span>{n.label}</span>
                      </SidebarMenuButton>
                      <SidebarMenuBadge className="text-[10px] font-normal text-muted-foreground">{T.nav.soon}</SidebarMenuBadge>
                    </>
                  ) : (
                    <>
                      <SidebarMenuButton tooltip={n.label} isActive={view === n.id} disabled={disabled || (boardOnly && n.id !== "board")} onClick={() => onView(n.id)}>
                        <n.icon />
                        <span>{n.label}</span>
                      </SidebarMenuButton>
                      <SidebarMenuBadge><kbd className="font-mono text-[10px]">{n.key}</kbd></SidebarMenuBadge>
                    </>
                  )}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground group-data-[collapsible=icon]:justify-center">
          <span className={cn("size-2 shrink-0 rounded-full", healthy ? "dot-running bg-positive" : connected ? "bg-warning" : "bg-destructive")} aria-hidden="true" />
          <span className="truncate group-data-[collapsible=icon]:hidden" title={connected ? T.nav.connected : T.nav.offline}>
            {!connected ? T.nav.offline : engineText}
          </span>
        </div>
        <SidebarMenu>
          {KIT_NAV.map((n) => (
            <SidebarMenuItem key={n.id}>
              <SidebarMenuButton tooltip={n.label} isActive={view === n.id} onClick={() => onView(n.id)}>
                <n.icon />
                <span>{n.label}</span>
              </SidebarMenuButton>
              {n.id === "putusan" && pending > 0
                ? <SidebarMenuBadge className="rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground" aria-label={`${pending} menunggu putusan`}>{pending}</SidebarMenuBadge>
                : n.id === "cognition" && cognitionUnseen > 0
                ? <SidebarMenuBadge className="rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground" aria-label={`${cognitionUnseen} chat needs you`}>{cognitionUnseen}</SidebarMenuBadge>
                : <SidebarMenuBadge><kbd className="font-mono text-[10px]">{n.key}</kbd></SidebarMenuBadge>}
            </SidebarMenuItem>
          ))}
          <SidebarMenuItem>
            <SidebarMenuButton tooltip={T.nav.settings} isActive={view === "settings"} onClick={() => onView("settings")}>
              <Settings />
              <span>{T.nav.settings}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <Button size="lg" className="h-10 w-full text-sm font-semibold group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:p-0" disabled={disabled || newDisabled} onClick={onNew} title={T.nav.newTask}>
          <Plus className="size-4" />
          <span className="group-data-[collapsible=icon]:hidden">{T.nav.newTask}</span>
        </Button>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

// Filter value for cards with no client (the owner's own); "" means any client.
const OWN = "__own__";

function Filters({ cards, f, setF }) {
  const labels = useMemo(() => [...new Set(cards.flatMap((c) => c.labels))].sort(), [cards]);
  const clients = useMemo(() => [...new Set(cards.map((c) => c.client ?? ""))].sort((a, b) => (a === "") - (b === "") || a.localeCompare(b)), [cards]);
  return (
    <div className="flex flex-wrap gap-2">
      <select className={FIELD} aria-label="client" value={f.client} onChange={(e) => setF({ ...f, client: e.target.value })}>
        <option value="">{T.filters.client}</option>
        {clients.map((c) => <option key={c || OWN} value={c || OWN}>{c || T.ownClient}</option>)}
      </select>
      <select className={FIELD} aria-label="priority" value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>
        <option value="">{T.filters.priority}</option>
        {PRIORITIES.map((p) => <option key={p} value={p}>{T.priorities[p]}</option>)}
      </select>
      <select className={FIELD} aria-label="label" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })}>
        <option value="">{T.filters.label}</option>
        {labels.map((l) => <option key={l} value={l}>{l}</option>)}
      </select>
      <select className={FIELD} aria-label="due" value={f.due} onChange={(e) => setF({ ...f, due: e.target.value })}>
        <option value="">{T.filters.due}</option>
        <option value="overdue">{T.filters.overdue}</option>
        <option value="has">{T.filters.hasDue}</option>
        <option value="none">{T.filters.noDue}</option>
      </select>
    </div>
  );
}

function passes(c, f) {
  if (f.client && (c.client ?? "") !== (f.client === OWN ? "" : f.client)) return false;
  if (f.priority && c.priority !== f.priority) return false;
  if (f.label && !c.labels.includes(f.label)) return false;
  if (f.due === "overdue" && !(c.due && c.due < today() && c.status !== "done")) return false;
  if (f.due === "has" && !c.due) return false;
  if (f.due === "none" && c.due) return false;
  return true;
}


// Provider + model of one run, from the same list as Cognition (Settings > Model). Empty = the main model.
function ModelSelect({ value, onChange }) {
  return (
    <Field label={T.views.task.model}>
      <ProviderModelSelect className={FIELD_FULL} label={T.views.task.model} value={value} onChange={onChange} />
    </Field>
  );
}

function StartDialog({ project, card, skills, onDone, onCancel }) {
  const D = T.startDialog;
  const [skill, setSkill] = useState(""); // a skill is optional: empty = the text below runs as a plain prompt
  const [args, setArgs] = useState(card.title);
  const [model, setModel] = useState({ provider: "", model: "" });
  const [worktree, setWorktree] = useState(!!card.branch); // S11: a card that already has a worktree keeps using it
  const [err, setErr] = useState("");
  const cur = skills.find((k) => k.name === skill);
  const go = async (e) => {
    e.preventDefault();
    try { await api.runJob(project, { skill, args: args.trim(), card: card.key, model: model.model || undefined, provider: model.provider || undefined, worktree: worktree || undefined }); onDone(); } catch (x) { setErr(x.message); }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent closeLabel={T.close}>
        <form onSubmit={go} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>{D.title} {card.key}</DialogTitle>
            <DialogDescription>{card.title}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <Field label={T.newDialog.skill} hint={cur?.description || D.noSkillHint}>
              <select className={FIELD_FULL} autoFocus value={skill} onChange={(e) => setSkill(e.target.value)}>
                <option value="">{D.noSkill}</option>
                {skills.map((k) => <option key={k.name} value={k.name}>/{k.name}</option>)}
              </select>
            </Field>
            <Field label={skill ? T.newDialog.args : D.prompt}>
              <input className={FIELD_FULL} value={args} placeholder={cur?.argumentHint} onChange={(e) => setArgs(e.target.value)} />
            </Field>
            <ModelSelect value={model} onChange={setModel} />
            <WorktreeCheck checked={worktree} onChange={setWorktree} />
            {err && <p className="text-sm text-destructive">{err}</p>}
          </DialogBody>
          <DialogFooter className="justify-end">
            <Button type="button" variant="outline" onClick={onCancel}>{T.cancel}</Button>
            <Button type="submit" disabled={!skill && !args.trim()}>{D.start}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// "Run in worktree" (PRD AIOS-61 v2.1 S11): the job runs in the card's own branch and worktree.
function WorktreeCheck({ checked, onChange }) {
  const D = T.startDialog;
  return (
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" className="mt-0.5" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span><span className="font-medium">{D.worktree}</span><span className="block text-xs text-muted-foreground">{D.worktreeHint}</span></span>
    </label>
  );
}

function CardView({ card, job, onOpen, onMove, onStop, onStart }) {
  const overdue = card.due && card.due < today() && card.status !== "done";
  const live = job && ["running", "queued"].includes(job.status);
  const desc = (card.body ?? "").replace(/^#.*$/gm, "").replace(/\s+/g, " ").trim();
  const targets = [...COLUMNS.filter((c) => c !== card.status), ...(card.status === "done" ? ["archived"] : [])];
  const ro = card.readOnly === true;
  return (
    <div
      className={cn(
        "grid gap-2", ro ? "cursor-pointer" : "cursor-grab", " rounded-[6px] border bg-card p-3 text-card-foreground shadow-sm transition-colors outline-none hover:border-primary/60 focus-visible:ring-2 focus-visible:ring-ring",
        card.cancelled && "opacity-70",
      )}
      draggable={!ro}
      tabIndex={0}
      role="button"
      aria-label={`${card.key} ${card.title}`}
      onDragStart={(e) => e.dataTransfer.setData("text/plain", card.key)}
      onClick={() => onOpen(card.key)}
      onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onOpen(card.key); } }}
    >
      <div className={cn("text-sm font-semibold break-words", card.cancelled && "line-through")}>{card.title}</div>
      {desc && <div className="line-clamp-2 text-[13px] text-muted-foreground">{desc}</div>}
      <div className="flex flex-wrap gap-1.5">
        {card.priority !== "none" && <Badge variant="outline" className={PRIO_CLASS[card.priority]}>{T.priorities[card.priority]}</Badge>}
        {card.kind === "approval_request" && <Badge variant="outline">approval</Badge>}
        {job && live && (
          <Badge variant="outline" className="border-warning/40 bg-warning/10 text-warning">
            <span className={cn("size-1.5 rounded-full bg-current", job.status === "running" && "dot-running")} aria-hidden="true" /> /{job.skill} {T.card[job.status] ?? job.status}
          </Badge>
        )}
        {job && job.status === "failed" && <Badge variant="outline" className="border-destructive/50 text-destructive">/{job.skill} {T.card.failed}</Badge>}
        {card.due && <Badge variant="outline" className={overdue ? "border-destructive/50 text-destructive" : ""}>{card.due}</Badge>}
        {card.cancelled && <Badge variant="outline">{T.cancelled}</Badge>}
        {ro && <Badge variant="outline" className="border-info/50 text-info" title={T.bridge.detail(card.bridge)}>{card.bridge} · {T.bridge.readOnly}</Badge>}
        {card.labels.map((l) => <Badge key={l} variant="secondary">{l}</Badge>)}
      </div>
      <div className="flex items-center gap-2">
        <span className="mr-auto inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground" title={stamp(card.updated)}><Clock className="size-3.5" /> {card.key}</span>
        {live && (
          <Button size="sm" className="bg-destructive text-white hover:bg-destructive/90" onClick={(e) => { e.stopPropagation(); onStop(job.id); }}>
            <Square className="size-3 fill-current" /> {T.card.stop}
          </Button>
        )}
        {!ro && !live && ["backlog", "todo", "error"].includes(card.status) && (
          <Button size="sm" onClick={(e) => { e.stopPropagation(); onStart(card); }}>{T.card.start}</Button>
        )}
        {!ro && !live && card.status === "done" && (
          <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); onMove(card.key, "archived"); }}><Archive className="size-3.5" /> {T.views.archive.archive}</Button>
        )}
        {!ro && <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`${T.card.more} ${card.key}`} onClick={(e) => e.stopPropagation()}><EllipsisVertical className="size-4" /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
            <DropdownMenuLabel>{T.moveTo}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {targets.map((c) => (
              <DropdownMenuItem key={c} onSelect={() => onMove(card.key, c)}>{T.columns[c]}</DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>}
      </div>
    </div>
  );
}

function Board({ cards, jobs, filters, layout, archivedCount, onOpen, onMove, onStop, onStart, onNew, onArchiveAll, onShowArchive, bridgeLabel = null }) {
  const latest = {};
  for (const j of jobs) if (j.card && !latest[j.card]) latest[j.card] = j; // jobs come newest first
  const visible = cards.filter((c) => passes(c, filters));
  const wide = layout === "horizontal";
  const A = T.views.archive;
  // Horizontal: the board fills the rest of the window, so its sideways scrollbar stays in view and each column
  // scrolls on its own instead of the page growing as tall as the longest column (Raka 2026-11-12).
  const boardRef = useRef(null);
  const [boardH, setBoardH] = useState(null);
  useEffect(() => {
    if (!wide) { setBoardH(null); return undefined; }
    const fit = () => {
      const el = boardRef.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top + window.scrollY;
      setBoardH(Math.max(320, Math.floor(window.innerHeight - top - 32)));
    };
    fit();
    window.addEventListener("resize", fit);
    const ro = typeof ResizeObserver === "function" && boardRef.current?.parentElement ? new ResizeObserver(fit) : null;
    ro?.observe(boardRef.current.parentElement);
    return () => { window.removeEventListener("resize", fit); ro?.disconnect(); };
  }, [wide]);
  return (
    <div ref={boardRef} style={wide && boardH ? { height: boardH } : undefined} className={wide ? "flex items-stretch gap-3.5 overflow-x-auto pr-1 pb-2" : "grid gap-3"}>
      {COLUMNS.map((col) => {
        const items = visible.filter((c) => c.status === col).sort((a, b) => RANK[a.priority] - RANK[b.priority] || num(a.key) - num(b.key));
        const [etitle, ehint] = T.empty.col[col];
        const EmptyIcon = COL_ICON[col] ?? Inbox;
        return (
          <section
            key={col}
            className={cn(
              "flex flex-col rounded-md border bg-muted/50",
              wide ? cn("max-h-full min-h-48 w-72 shrink-0 self-start border-t-4", COL_TOP[col]) : cn("border-l-4", COL_LEFT[col]),
            )}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const key = e.dataTransfer.getData("text/plain");
              if (key) onMove(key, col);
            }}
          >
            <h3 className="flex shrink-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 px-3.5 py-2 text-sm font-semibold">
              <span className="inline-flex items-center gap-2">{T.columns[col]} <Badge variant="outline" className="h-5 min-w-5 justify-center px-1.5 font-mono">{items.length}</Badge></span>
              {col === "backlog" && (bridgeLabel
                ? <Button variant="ghost" size="icon-sm" aria-label={T.newCard} title={T.bridge.noNew(bridgeLabel)} disabled><Plus className="size-4" /></Button>
                : <Button variant="ghost" size="icon-sm" aria-label={T.newCard} title={T.newCard} onClick={onNew}><Plus className="size-4" /></Button>)}
              {col === "done" && (
                <span className="flex flex-wrap items-center gap-0.5">
                  {archivedCount > 0 && <Button variant="ghost" size="sm" onClick={onShowArchive}>{A.archived} <span className="font-mono text-[11px]">{archivedCount}</span></Button>}
                  {items.some((c) => !c.readOnly) && <Button variant="ghost" size="sm" onClick={() => onArchiveAll(items.filter((c) => !c.readOnly).map((c) => c.key))}><Archive className="size-3.5" /> {A.archiveAll}</Button>}
                </span>
              )}
            </h3>
            <div className={cn("grid gap-2.5 border-t p-2.5", wide ? "min-h-0 flex-1 content-start overflow-y-auto overscroll-contain" : "[grid-template-columns:repeat(auto-fill,minmax(270px,1fr))]")}>
              {items.length === 0 && (
                <div className={cn("flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-[6px] border-2 border-dashed px-3 py-2 text-xs text-muted-foreground", !wide && "col-span-full")}>
                  <EmptyIcon className="size-4 shrink-0" />
                  <b className="text-[13px] text-foreground">{etitle}</b>
                  <span>{ehint}</span>
                </div>
              )}
              {items.map((c) => <CardView key={c.key} card={c} job={latest[c.key]} onOpen={onOpen} onMove={onMove} onStop={onStop} onStart={onStart} />)}
            </div>
          </section>
        );
      })}
    </div>
  );
}

const draftKey = (p) => `artrios.draft.${p}`;
function loadDraft(p) { try { return JSON.parse(localStorage.getItem(draftKey(p)) ?? "null"); } catch { return null; } }
function saveDraft(p, v) { try { if (v) localStorage.setItem(draftKey(p), JSON.stringify(v)); else localStorage.removeItem(draftKey(p)); } catch { /* storage blocked: the form still works */ } }
const blank = { title: "", body: "", priority: "none", due: "", status: "backlog", skill: "", args: "", model: { provider: "", model: "" }, images: [] };

function NewCard({ project, skills, onDone, onCancel }) {
  const D = T.newDialog;
  const V = T.views.task;
  const draft = useMemo(() => loadDraft(project), [project]);
  const [restored, setRestored] = useState(Boolean(draft));
  const [f, setF] = useState(draft ? { ...blank, ...draft } : blank);
  const [err, setErr] = useState("");
  const [made, setMade] = useState(false);
  const [mention, setMention] = useState(null);
  const [files, setFiles] = useState([]);
  const [idx, setIdx] = useState(0);
  const [picker, setPicker] = useState(false);
  const [uploading, setUploading] = useState(false);
  const taRef = useRef(null);
  const set = (patch) => setF((cur) => {
    const next = { ...cur, ...patch };
    saveDraft(project, next.title || next.body || next.images.length ? next : null);
    return next;
  });

  // "@" mentions: type @ and part of a file name, pick with the arrow keys and Enter.
  const onBody = (e) => {
    const text = e.target.value;
    const pos = e.target.selectionStart;
    set({ body: text });
    const m = /(^|\s)@([^\s@]*)$/.exec(text.slice(0, pos));
    setMention(m ? { q: m[2], start: pos - m[2].length - 1, end: pos } : null);
  };
  const mentionQ = mention?.q;
  useEffect(() => {
    if (mentionQ === undefined) { setFiles([]); return undefined; }
    let live = true;
    const t = setTimeout(() => api.files(project, mentionQ).then((r) => { if (live) { setFiles(r.files); setIdx(0); } }).catch(() => {}), 120);
    return () => { live = false; clearTimeout(t); };
  }, [mentionQ, project]);
  const insertFile = (file) => {
    const body = f.body;
    const m = mention ?? { start: body.length, end: body.length };
    const before = body.slice(0, m.start);
    set({ body: `${before}${before && !/\s$/.test(before) ? " " : ""}@${file} ${body.slice(m.end)}` });
    setMention(null);
    setPicker(false);
    requestAnimationFrame(() => taRef.current?.focus());
  };
  const onKeyDown = (e) => {
    if (!mention || files.length === 0) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => Math.min(i + 1, files.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); insertFile(files[idx]); }
  };
  // Pasted screenshots are saved in .artrios/attachments and listed in the task text.
  const onPaste = async (e) => {
    const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith("image/"));
    const file = item?.getAsFile();
    if (!file) return;
    e.preventDefault();
    setUploading(true);
    setErr("");
    try {
      const data = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.onerror = rej; r.readAsDataURL(file); });
      const saved = await api.saveImage(project, { type: file.type, data });
      setF((cur) => { const next = { ...cur, images: [...cur.images, { name: saved.name, path: saved.path }] }; saveDraft(project, next); return next; });
    } catch (x) { setErr(x.message); }
    setUploading(false);
  };

  const submit = async (e) => {
    e.preventDefault();
    const text = f.body.trim();
    if (!text) { setErr(D.required); return; }
    const title = f.title.trim() || text.split("\n").find((l) => l.trim()).trim().slice(0, 80);
    const body = f.images.length ? `${text}\n\n## Attachments\n${f.images.map((i) => `- ${i.path}`).join("\n")}` : text;
    try {
      const card = await api.create(project, { title, body, priority: f.priority, due: f.due, status: f.status });
      saveDraft(project, null);
      if (f.skill) {
        try {
          await api.runJob(project, { skill: f.skill, args: f.args.trim() || title, card: card.key, model: f.model.model || undefined, provider: f.model.provider || undefined, worktree: f.worktree || undefined });
        } catch (x) {
          setMade(true);
          setErr(`${D.madeButNotStarted} ${x.message}`);
          return;
        }
      }
      onDone();
    } catch (x) {
      setErr(x.message);
    }
  };
  const cur = skills.find((k) => k.name === f.skill);
  return (
    <>
      <Dialog open onOpenChange={(o) => !o && onCancel()}>
        <DialogContent closeLabel={T.close} onEscapeKeyDown={(e) => { if (mention) { e.preventDefault(); setMention(null); } }}>
          <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
            <DialogHeader>
              <DialogTitle>{D.title}</DialogTitle>
              <DialogDescription>{D.intro}</DialogDescription>
            </DialogHeader>
            <DialogBody>
              <Field label={`${D.description} *`} hint={`${D.descriptionHint} ${V.tip}`}>
                <div className="relative">
                  <Textarea ref={taRef} autoFocus rows={7} value={f.body} onChange={onBody} onKeyDown={onKeyDown} onPaste={onPaste} />
                  {mention && files.length > 0 && (
                    <ul role="listbox" className="absolute top-full right-0 left-0 z-20 mt-1 max-h-48 overflow-auto rounded-md border bg-popover p-1 font-mono text-xs shadow-md">
                      {files.map((file, i) => (
                        <li key={file} role="option" aria-selected={i === idx}>
                          <button type="button" className={cn("w-full truncate rounded px-2 py-1 text-left", i === idx && "bg-accent text-accent-foreground")} onMouseEnter={() => setIdx(i)} onMouseDown={(e) => { e.preventDefault(); insertFile(file); }}>{file}</button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </Field>
              {(f.images.length > 0 || uploading) && (
                <div className="grid gap-1.5">
                  <span className="eyebrow">{V.attached}{uploading ? " …" : ""}</span>
                  <div className="flex flex-wrap gap-2">
                    {f.images.map((im) => (
                      <div key={im.name} className="relative">
                        <img src={api.imageUrl(project, im.name)} alt={im.name} className="h-16 rounded-md border object-cover" />
                        <button type="button" className="absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full border bg-background text-xs" title={V.remove} aria-label={`${V.remove} ${im.name}`} onClick={() => set({ images: f.images.filter((x) => x.name !== im.name) })}>×</button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <Field label={D.titleOptional} hint={D.titleHint}>
                <input className={FIELD_FULL} value={f.title} placeholder={D.titlePlaceholder} onChange={(e) => set({ title: e.target.value })} />
              </Field>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label={T.priority}>
                  <select className={FIELD_FULL} value={f.priority} onChange={(e) => set({ priority: e.target.value })}>
                    {PRIORITIES.map((p) => <option key={p} value={p}>{T.priorities[p]}</option>)}
                  </select>
                </Field>
                <Field label={T.due}><input className={FIELD_FULL} type="date" value={f.due} onChange={(e) => set({ due: e.target.value })} /></Field>
                <Field label="Status">
                  <select className={FIELD_FULL} value={f.status} onChange={(e) => set({ status: e.target.value })}>
                    {COLUMNS.map((c) => <option key={c} value={c}>{T.columns[c]}</option>)}
                  </select>
                </Field>
              </div>
              <Field label={D.skill} hint={cur?.description || D.skillHint}>
                <select className={FIELD_FULL} value={f.skill} onChange={(e) => set({ skill: e.target.value })}>
                  <option value="">{D.noSkill}</option>
                  {skills.map((k) => <option key={k.name} value={k.name}>/{k.name}</option>)}
                </select>
              </Field>
              {f.skill && (
                <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
                  <Field label={D.args}>
                    <input className={FIELD_FULL} value={f.args} placeholder={cur?.argumentHint || D.argsDefault} onChange={(e) => set({ args: e.target.value })} />
                  </Field>
                  <ModelSelect value={f.model} onChange={(m) => set({ model: m })} />
                </div>
              )}
              {f.skill && <WorktreeCheck checked={!!f.worktree} onChange={(v) => set({ worktree: v })} />}
              {err && <p className="text-sm text-destructive">{err}</p>}
            </DialogBody>
            <DialogFooter>
              <span className="flex flex-wrap items-center gap-2">
                {restored && (
                  <>
                    <Badge className="bg-info/15 text-info">{D.draftRestored}</Badge>
                    <Button type="button" variant="ghost" size="sm" onClick={() => { saveDraft(project, null); setF(blank); setRestored(false); }}>{D.startFresh}</Button>
                  </>
                )}
                <Button type="button" variant="outline" size="sm" onClick={() => setPicker(true)}><FolderSearch className="size-4" /> {V.browse}</Button>
              </span>
              <span className="flex items-center gap-2">
                {made ? <Button type="button" onClick={onDone}>{T.close}</Button> : (
                  <>
                    <Button type="button" variant="outline" onClick={onCancel}>{T.cancel}</Button>
                    <Button type="submit" disabled={!f.body.trim()}>{f.skill ? D.createStart : D.createTask}</Button>
                  </>
                )}
              </span>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      {picker && <FilePicker project={project} onPick={insertFile} onClose={() => setPicker(false)} />}
    </>
  );
}

function Detail({ project, cardKey, jobs, onClose, onChanged, onOpenTerminal, onCognition }) {
  const [tab, setTab] = useState("overview");
  const [jobId, setJobId] = useState("");
  const [changes, setChanges] = useState("");
  const [card, setCard] = useState(null);
  const [f, setF] = useState(null);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => {
    api.cards(project).then(({ cards }) => {
      const c = cards.find((x) => x.key === cardKey);
      setCard(c);
      if (c) setF({ title: c.title, priority: c.priority, due: c.due, labels: c.labels.join(", "), body: c.body });
    });
  }, [project, cardKey]);
  if (!card || !f) return null;
  const ro = card.readOnly === true;
  const save = async () => {
    try {
      await api.update(project, card.key, { title: f.title, priority: f.priority, due: f.due, labels: f.labels.split(",").map((s) => s.trim()).filter(Boolean), body: f.body });
      onChanged();
      onClose();
    } catch (x) {
      setErr(x.message);
    }
  };
  const addNote = async () => {
    try {
      const c = await api.note(project, card.key, note);
      setCard(c);
      setF({ ...f, body: c.body });
      setNote("");
      onChanged();
    } catch (x) {
      setErr(x.message);
    }
  };
  const mine = jobs.filter((j) => j.card === card.key);
  const shown = mine.find((j) => j.id === jobId) ?? mine[0];
  const requestChanges = async () => {
    try {
      await api.note(project, card.key, `Request changes: ${changes.trim()}`);
      await api.move(project, card.key, "todo");
      onChanged();
      onClose();
    } catch (x) {
      setErr(x.message);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent closeLabel={T.close} aria-label={card.key}>
        <DialogHeader>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="font-mono">{card.key}</Badge>
            <Badge className="bg-info/15 text-info">{T.columns[card.status]}</Badge>
            {onCognition && (
              <Button size="xs" variant="outline" className="ml-auto mr-8" onClick={() => onCognition(`${card.key} ${card.title}\n\n`)} title={T.views.cognition.openHere}>
                <Sparkles className="size-3" /> {T.views.cognition.openHere}
              </Button>
            )}
          </div>
          <DialogTitle>{card.title}</DialogTitle>
          <DialogDescription className="sr-only">{card.key}</DialogDescription>
        </DialogHeader>
        <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col gap-0">
          <div className="border-b px-6 py-2">
            <TabsList>
              {Object.entries(T.card.detailTabs).map(([id, label]) => (
                <TabsTrigger key={id} value={id}>{label}{id === "logs" && mine.length > 0 ? ` (${mine.length})` : ""}</TabsTrigger>
              ))}
            </TabsList>
          </div>
          <TabsContent value="logs" className="space-y-3 overflow-y-auto px-6 py-4">
            {mine.length === 0 ? <p className="text-sm text-muted-foreground">{T.card.noJobs}</p> : (
              <>
                <Field label={T.card.pickJob}>
                  <select className={FIELD_FULL} value={shown.id} onChange={(e) => setJobId(e.target.value)}>
                    {mine.map((j) => <option key={j.id} value={j.id}>/{j.skill} {stamp(j.started ?? j.queued)} {j.status}</option>)}
                  </select>
                </Field>
                <JobLog project={project} jobId={shown.id} />
              </>
            )}
          </TabsContent>
          <TabsContent value="overview" className="space-y-4 overflow-y-auto px-6 py-4">
            {ro && <p className="rounded-md border border-info/50 bg-info/10 px-3 py-2 text-sm">{T.bridge.detail(card.bridge)}</p>}
            <fieldset disabled={ro} className="contents">
            <Field label={T.title}><input className={FIELD_FULL} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label={T.priority}>
                <select className={FIELD_FULL} value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>
                  {PRIORITIES.map((p) => <option key={p} value={p}>{T.priorities[p]}</option>)}
                </select>
              </Field>
              <Field label={T.due}><input className={FIELD_FULL} type="date" value={f.due} onChange={(e) => setF({ ...f, due: e.target.value })} /></Field>
              <Field label={T.labels}><input className={FIELD_FULL} value={f.labels} onChange={(e) => setF({ ...f, labels: e.target.value })} /></Field>
            </div>
            <Field label={T.description}><Textarea rows={9} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></Field>
            <div className="flex gap-2">
              <input className={`${FIELD_FULL} flex-1`} value={note} placeholder={T.notePlaceholder} onChange={(e) => setNote(e.target.value)} />
              <Button variant="outline" disabled={!note.trim()} onClick={addNote}>{T.note}</Button>
            </div>
            </fieldset>
            {!ro && card.branch && ["in_progress", "ai_review", "human_review", "pr_created", "done", "error"].includes(card.status) && <CardWorktreePanel project={project} card={card} onChanged={() => { onChanged(); api.cards(project).then(({ cards }) => { const c = cards.find((x) => x.key === card.key); if (c) setCard(c); }).catch(() => {}); }} />}
            {!ro && !card.branch && ["ai_review", "human_review", "done"].includes(card.status) && <ReviewPanel project={project} onOpenTerminal={() => { onClose(); onOpenTerminal(); }} />}
            {!ro && card.status === "human_review" && (
              <div className="grid gap-2 rounded-xl border border-warning bg-warning/10 p-3">
                <b className="text-sm">{T.review.title}</b>
                <p className="text-xs text-muted-foreground">{T.review.hint}</p>
                <Textarea rows={3} value={changes} onChange={(e) => setChanges(e.target.value)} />
                <Button variant="outline" disabled={!changes.trim()} onClick={requestChanges}>{T.review.send}</Button>
              </div>
            )}
            {err && <p className="text-sm text-destructive">{err}</p>}
          </TabsContent>
        </Tabs>
        {tab === "overview" && (
          <DialogFooter className="justify-between">
            <span className="text-xs text-muted-foreground">{card.status} · {card.updated}</span>
            {!ro && <Button onClick={save}>{T.save}</Button>}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default function App() {
  const [projects, setProjects] = useState([]);
  const [current, setCurrent] = useState(() => localStorage.getItem("artrios.project") ?? "");
  // ?view=putusan (from the /cognition tab) opens that screen directly.
  // Otherwise the last menu is kept across a reload (lib/persist.js).
  const [view, setView] = usePersisted("view", "board", (v) => typeof v === "string" && /^[a-z]+$/.test(v));
  useEffect(() => { try { const v = new URLSearchParams(location.search).get("view"); if (v) setView(v); } catch { /* no URL params */ } }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [pending, setPending] = useState(0);
  useEffect(() => {
    const load = () => api.inbox("?status=pending").then((d) => setPending(d.pending)).catch(() => {});
    load();
    const id = setInterval(load, 30000);
    const off = subscribe((m) => { if (m.type === "inbox") load(); });
    return () => { clearInterval(id); off(); };
  }, []);
  // Cognition (PRD T20): a finished turn or a waiting card counts on the menu badge while the chat screen is not in
  // view, and raises a browser notification when the tab is hidden.
  const [cognitionUnseen, setCognitionUnseen] = useState(0);
  const [cognitionPrefill, setCognitionPrefill] = useState(null); // { text, chips, session } for the Cognition screen
  const [insightsPrefill, setInsightsPrefill] = useState(null); // { session } for the Insights screen of a workspace
  // Cognition = the Artrios home folder; Insights = the same chat per workspace (owner decision 2026-11-10).
  const [homeKey, setHomeKey] = useState(null);
  const homeRef = useRef(null);
  homeRef.current = homeKey;
  useEffect(() => { api.chatWorkspaces().then((r) => setHomeKey(r.home?.key ?? null)).catch(() => {}); }, []);
  const openSession = (workspace, session) => {
    if (!workspace || workspace === homeRef.current) { setCognitionPrefill({ session }); setView("cognition"); }
    else { setCurrent(workspace); setInsightsPrefill({ session, workspace }); setView("insights"); }
  };
  const [drawer, setDrawer] = useState(null); // the same chat in a side drawer, opened from Brain, a workspace, or a card (T1)
  const viewRef = useRef(view);
  viewRef.current = view;
  useEffect(() => subscribe((m) => {
    if (m.type !== "chat") return;
    const done = m.ev === "status" && m.done;
    const asks = m.ev === "pending" && m.pending?.length > 0;
    if (!done && !asks) return;
    if (m.workspace && homeRef.current && m.workspace !== homeRef.current) return; // Insights turns do not count on the Cognition badge
    if (viewRef.current !== "cognition" || document.hidden) setCognitionUnseen((n) => n + 1);
    if (document.hidden && "Notification" in window && Notification.permission === "granted") {
      try { new Notification(T.views.cognition.doneTitle, { body: asks ? T.views.cognition.permTitle : (m.title ?? ""), tag: `cognition-${m.id}` }); } catch { /* notifications blocked */ }
    }
  }), []);
  useEffect(() => {
    if (view !== "cognition") return;
    setCognitionUnseen(0);
    if ("Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => {});
  }, [view]);
  useEffect(() => {
    const onVis = () => { if (!document.hidden && viewRef.current === "cognition") setCognitionUnseen(0); };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);
  const [filters, setFilters] = usePersisted("filters", { client: "", priority: "", label: "", due: "" }, (v) => v && typeof v === "object" && !Array.isArray(v) && !("hat" in v));
  const [layout, setLayout] = useState(() => { try { return localStorage.getItem("artrios.layout") === "horizontal" ? "horizontal" : "vertical"; } catch { return "vertical"; } });
  useEffect(() => { try { localStorage.setItem("artrios.layout", layout); } catch { /* storage blocked: the choice lasts until reload */ } }, [layout]);
  const [creating, setCreating] = useState(false);
  const [starting, setStarting] = useState(null);
  const [skills, setSkills] = useState([]);
  const [open, setOpen] = useState(null);
  const [fatal, setFatal] = useState("");
  const [adding, setAdding] = useState(false);
  const [showArchive, setShowArchive] = useState(false);
  const [claude, setClaude] = useState(null);
  const [provider, setProvider] = useState(undefined); // undefined = not known yet, null = none set

  const [terminalOn, setTerminalOn] = useState(true);
  const loadStatus = useCallback(() => api.status().then((r) => { setClaude(r.claude); setProvider(r.provider); setTerminalOn(r.terminal !== false); }).catch(() => {}), []);
  useEffect(() => { if (!terminalOn && view === "terminal") setView("board"); }, [terminalOn, view]);
  const loadProjects = useCallback(async () => {
    try {
      const { projects: list } = await api.projects();
      setProjects(list);
      setCurrent((cur) => (list.some((p) => p.key === cur) ? cur : list[0]?.key ?? ""));
      setFatal("");
    } catch {
      setFatal(T.loadFailed);
    }
  }, []);
  useEffect(() => { loadProjects(); }, [loadProjects]);
  useEffect(() => { loadStatus(); }, [loadStatus]);
  // Update kit (AIOS-130): present only when this UI was installed from the kit; polls fast while an update runs.
  const [kit, setKit] = useState(null);
  const loadKit = useCallback(() => api.kitUpdate().then(setKit).catch(() => {}), []);
  useEffect(() => { loadKit(); const t = setInterval(loadKit, kit?.running ? 5000 : 600000); return () => clearInterval(t); }, [loadKit, kit?.running]);
  const openKitUpdate = async () => { try { await api.kitUpdatePrepare(); setView("putusan"); } catch (e) { setFatal(e.message); } };
  useEffect(() => { if (current) localStorage.setItem("artrios.project", current); }, [current]);
  useEffect(() => {
    setSkills([]);
    if (current) api.skills(current).then((r) => setSkills(r.skills.filter((k) => k.runnable))).catch(() => {});
  }, [current]);

  const { cards, broken, events, jobs, bridge, error, reload } = useData(current);
  const refresh = () => { reload(); loadProjects(); };
  const move = async (key, status) => {
    try { await api.move(current, key, status); } catch { /* shown by reload error */ }
    refresh();
  };
  const archiveAll = async (keys) => {
    for (const k of keys) { try { await api.move(current, k, "archived"); } catch { /* shown by reload error */ } }
    refresh();
  };
  const stop = async (id) => { try { await api.stopJob(current, id); } catch { /* shown by reload error */ } };
  const project = projects.find((p) => p.key === current);
  // A project only the task bridge knows has no folder: just its board (read-only).
  const boardOnly = !!project?.bridgeOnly;
  const bridgeLabel = project?.bridged ? (bridge?.label ?? "bridge") : null;
  useEffect(() => { if (boardOnly && WORKSPACE_NAV.some((n) => n.id === view && n.id !== "board")) setView("board"); }, [boardOnly, view]); // eslint-disable-line react-hooks/exhaustive-deps

  // One-letter shortcuts like the reference: off while typing, inside the terminal, or with a dialog open.
  useEffect(() => {
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || creating || adding || open || starting || showArchive) return;
      if (e.target.closest?.("input, textarea, select, .term-host, [contenteditable], [role=dialog], [role=menu]")) return;
      const k = e.key.toLowerCase();
      const nav = NAV.find((n) => !n.soon && n.key.toLowerCase() === k && (terminalOn || n.id !== "terminal"));
      if (nav && (KIT_NAV.includes(nav) || (current && (!boardOnly || nav.id === "board")))) setView(nav.id);
      else if (k === "t" && current && !bridgeLabel) { e.preventDefault(); setCreating(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [creating, adding, open, starting, showArchive, current, terminalOn, boardOnly, bridgeLabel]);

  const options = projects.map((p) => ({
    value: p.key,
    label: p.key + (p.broken > 0 ? " !" : ""),
    hint: p.name,
    prefix: <span className={cn("size-2 shrink-0 rounded-full", p.client ? "bg-work" : "bg-self")} title={p.client || T.ownClient} />,
  }));

  return (
    <SidebarProvider>
      <AppSidebar view={view} onView={setView} onNew={() => setCreating(true)} connected={!fatal && !error} claude={claude} provider={provider} disabled={!project} boardOnly={boardOnly} newDisabled={!!bridgeLabel} pending={pending} cognitionUnseen={cognitionUnseen} terminalOn={terminalOn} />
      <SidebarInset className="min-w-0">
        <header className="sticky top-0 z-20 flex min-h-14 shrink-0 items-center gap-2 border-b bg-background/80 px-3 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/65 md:rounded-t-xl md:px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="data-[orientation=vertical]:h-4" />
          <Combobox
            value={current}
            options={options}
            onChange={(k) => { setCurrent(k); setOpen(null); setCreating(false); }}
            placeholder={T.noProjectsShort}
            searchPlaceholder={T.combo.search}
            emptyText={T.combo.empty}
          />
          {project && <span className="hidden min-w-0 truncate text-sm text-muted-foreground sm:inline">{project.name}</span>}
          <div className="ml-auto flex items-center gap-1">
            {view === "board" && project && (
              <Button variant="ghost" size="sm" onClick={async () => { if (bridgeLabel) await api.projectsFresh().catch(() => {}); refresh(); }}><RefreshCw className="size-3.5" /> <span className="hidden sm:inline">{T.refresh}</span></Button>
            )}
            {project && view !== "insights" && <Button variant="ghost" size="icon" className="size-8" aria-label={T.views.cognition.drawerHere} title={T.views.cognition.drawerHere} onClick={() => setDrawer({ workspace: current })}><Sparkles className="size-4" /></Button>}
            {kit?.available && <Button variant="outline" size="sm" title={T.kit.updateHint} onClick={openKitUpdate}><Download className="size-3.5" /> {T.kit.update(kit.latest)}</Button>}
            {kit?.enabled && !kit.available && kit.unreleased > 0 && <span className="hidden px-2 text-xs text-muted-foreground md:inline" title={T.kit.unreleasedHint}>{T.kit.unreleased(kit.unreleased)}</span>}
            <Button variant="ghost" size="icon" className="size-8" aria-label={T.addProject} title={T.addProject} onClick={() => setAdding(true)}><Plus className="size-4" /></Button>
            <ThemeToggle labels={T.theme} />
          </div>
        </header>
        <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
          {fatal && <p className="text-sm text-destructive">{fatal}</p>}
          {kit?.running && <p className="flex items-center gap-2 rounded-md border bg-card p-3 text-sm"><LoaderCircle className="size-4 animate-spin" /> {T.kit.running}</p>}
          {kit?.result && !kit.running && (
            <div className={cn("flex flex-wrap items-center gap-2 rounded-md border p-3 text-sm", kit.result.ok ? "bg-card" : "border-destructive/50 text-destructive")}>
              <span>{kit.result.ok ? T.kit.ok(kit.result.tag) : T.kit.failed(kit.result.tag, kit.result.error ?? "")}</span>
              <span className="text-xs text-muted-foreground">{T.kit.log}</span>
              <Button size="sm" variant="ghost" className="ml-auto" onClick={() => api.kitUpdateAck().then(setKit).catch(() => {})}>{T.kit.dismiss}</Button>
            </div>
          )}
          {view === "settings" && <SettingsView onChanged={loadStatus} />}
          {view === "today" && <Suspense fallback={<LoaderCircle className="size-4 animate-spin" />}><TodayView onOpenPutusan={() => setView("putusan")} /></Suspense>}
          {view === "putusan" && <Suspense fallback={<LoaderCircle className="size-4 animate-spin" />}><PutusanView onCount={setPending} onOpenSession={openSession} /></Suspense>}
          {view === "brain" && <Suspense fallback={<LoaderCircle className="size-4 animate-spin" />}><BrainView onAsk={(chip) => setDrawer({ chips: [chip] })} /></Suspense>}
          {view === "cognition" && (
            <Suspense fallback={<LoaderCircle className="size-4 animate-spin" />}>
              <CognitionView initialSession={cognitionPrefill?.session} prefill={cognitionPrefill?.text} chips={cognitionPrefill?.chips} onPrefillUsed={() => setCognitionPrefill((p) => (p ? { session: p.session } : p))} onOpenPutusan={() => setView("putusan")} />
            </Suspense>
          )}
          {!project && !fatal && view !== "settings" && !KIT_NAV.some((n) => n.id === view) && (
            <div className="grid justify-items-center gap-1 rounded-xl border-2 border-dashed px-3 py-10 text-center">
              <b>{T.noProjects}</b>
            </div>
          )}
          {project && view !== "settings" && (
            <>
              {error && <p className="text-sm text-destructive">{error}</p>}
              {view === "board" && (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Filters cards={cards} f={filters} setF={setFilters} />
                    <div role="group" aria-label={T.layout.title} className="inline-flex gap-0.5 rounded-[10px] border border-border-strong p-0.5">
                      <Button size="icon-sm" variant={layout === "vertical" ? "default" : "ghost"} aria-pressed={layout === "vertical"} title={T.layout.vertical} aria-label={T.layout.vertical} onClick={() => setLayout("vertical")}><Rows3 className="size-4" /></Button>
                      <Button size="icon-sm" variant={layout === "horizontal" ? "default" : "ghost"} aria-pressed={layout === "horizontal"} title={T.layout.horizontal} aria-label={T.layout.horizontal} onClick={() => setLayout("horizontal")}><Columns3 className="size-4" /></Button>
                    </div>
                  </div>
                  {bridgeLabel && (
                    <div className="grid gap-1 rounded-md border border-info/50 bg-info/10 px-3 py-2 text-sm">
                      <span>{boardOnly ? `${T.bridge.boardOnly(bridgeLabel)} ` : ""}{T.bridge.banner(bridgeLabel, bridge?.at)}</span>
                      {bridge?.error && <span className="text-destructive">{T.bridge.stale(bridge.error)}</span>}
                      {bridge?.conflicts?.length > 0 && <span className="text-warning">{T.bridge.conflicts(bridgeLabel, bridge.conflicts)}</span>}
                    </div>
                  )}
                  {broken.length > 0 && (
                    <details className="rounded-xl border border-destructive px-3 py-2" open>
                      <summary>{T.brokenTitle}: {broken.length}</summary>
                      <ul>{broken.map((b) => <li key={b.file}><code>{b.error}</code></li>)}</ul>
                    </details>
                  )}
                  <Board cards={cards.filter((c) => c.status !== "archived")} archivedCount={cards.filter((c) => c.status === "archived").length} onArchiveAll={archiveAll} onShowArchive={() => setShowArchive(true)} jobs={jobs} filters={filters} layout={layout} onOpen={setOpen} onMove={move} onStop={stop} onStart={setStarting} onNew={() => setCreating(true)} bridgeLabel={bridgeLabel} />
                </>
              )}
              {view === "overview" && <OverviewView events={events} project={current} />}
              {view === "terminal" && <Terminal project={current} />}
              {view === "insights" && (
                <Suspense fallback={<LoaderCircle className="size-4 animate-spin" />}>
                  <CognitionView key={current} workspace={current} initialSession={insightsPrefill?.workspace === current ? insightsPrefill.session : undefined} onOpenPutusan={() => setView("putusan")} />
                </Suspense>
              )}
              {view === "ideation" && <Ideation project={current} onChanged={refresh} />}
              {view === "worktrees" && <WorktreesView project={current} terminalOn={terminalOn} onCognition={(ws) => setDrawer({ workspace: ws })} onTerminal={() => setView("terminal")} onOpenCard={setOpen} />}
            </>
          )}
        </div>
      </SidebarInset>
      {creating && <NewCard project={current} skills={skills} onDone={() => { setCreating(false); refresh(); }} onCancel={() => setCreating(false)} />}
      {starting && <StartDialog project={current} card={starting} skills={skills} onDone={() => { setStarting(null); refresh(); }} onCancel={() => setStarting(null)} />}
      {adding && <AddProject onCancel={() => setAdding(false)} onDone={async (key) => { setAdding(false); await loadProjects(); setCurrent(key); }} />}
      {open && <Detail project={current} cardKey={open} jobs={jobs} onClose={() => setOpen(null)} onChanged={refresh} onOpenTerminal={() => setView("terminal")} onCognition={(text) => { setOpen(null); setDrawer({ workspace: current, text }); }} />}
      {showArchive && <ArchiveDialog cards={cards.filter((c) => c.status === "archived")} onClose={() => setShowArchive(false)} onOpen={(k) => { setShowArchive(false); setOpen(k); }} onRestore={async (k) => { await move(k, "done"); }} />}
      <Sheet open={!!drawer} onOpenChange={(o) => { if (!o) setDrawer(null); }}>
        {/* 60% of the window on a normal screen, full width on a phone (Raka 2026-11-11). */}
        <SheetContent side="right" className="gap-2 p-3 data-[side=right]:w-full data-[side=right]:sm:w-[60vw] data-[side=right]:sm:max-w-none" aria-describedby={undefined}>
          <SheetTitle className="sr-only">Cognition</SheetTitle>
          {drawer && (
            <Suspense fallback={<LoaderCircle className="size-4 animate-spin" />}>
              <CognitionView compact key={drawer.workspace ?? "home"} workspace={drawer.workspace ?? null} prefill={drawer.text} chips={drawer.chips} onPrefillUsed={() => setDrawer((d) => (d ? { ...d, text: null } : d))} onOpenPutusan={() => { setDrawer(null); setView("putusan"); }} />
            </Suspense>
          )}
        </SheetContent>
      </Sheet>
    </SidebarProvider>
  );
}
