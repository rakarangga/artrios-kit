// Routines (PRD AIOS-61 v2.1 S2, S3, S7): one screen for everything that runs on a clock.
//   Schedules - what runs, when, where (Artrios home or a workspace): a command, or an agent profile with a skill/prompt.
//   Agents    - profiles only (role, model, tools, approval, budget); a schedule calls one.
//   Today     - the morning digest, what waits for Raka, the skill deck.
// The scheduler is its own process; this screen only edits files and asks it to "run now", so it polls.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Bot, CalendarClock, ChevronDown, ChevronRight, LoaderCircle, Pencil, Play, Plus, Power, RefreshCw, Server, Trash2, TriangleAlert } from "lucide-react";
import { api } from "../api.js";
import { T } from "../texts.js";
import { cn } from "@/lib/utils";
import JobLog, { stamp } from "../JobLog.jsx";
import { Markdown } from "../markdown.jsx";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Field, FIELD_FULL, PageHeader } from "@/components/field";
import { SelectField, SettingRow, SettingsSection } from "@/components/settings-layout";
import { ModelPicker } from "@/components/model-picker";
import { usePersisted } from "../lib/persist.js";

// Name -> id suggestion while the id was not typed by hand.
const slug = (name) => name.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 64);
function useIdFromName(editing) {
  const [touched, setTouched] = useState(editing);
  return { touched, touch: () => setTouched(true) };
}

const S = () => T.views.routines;
const pad = (n) => String(n).padStart(2, "0");
const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "-");

// --- schedule <-> friendly "when" ---------------------------------------------------------------------------------
function parseWhen(cron) {
  const p = String(cron ?? "").trim().split(/\s+/);
  const blank = { mode: "daily", time: "08:00", day: "1", dow: "1", n: "3", cron: cron ?? "" };
  if (p.length !== 5) return { ...blank, mode: "custom" };
  const [mi, h, dom, mon, dow] = p;
  const num = (x) => /^\d+$/.test(x);
  const time = num(mi) && num(h) ? `${pad(h)}:${pad(mi)}` : null;
  if (time && dom === "*" && mon === "*" && dow === "*") return { ...blank, mode: "daily", time };
  if (time && dom === "*" && mon === "*" && dow === "1-5") return { ...blank, mode: "weekdays", time };
  if (time && dom === "*" && mon === "*" && /^[0-6]$/.test(dow)) return { ...blank, mode: "weekly", time, dow };
  if (time && num(dom) && mon === "*" && dow === "*") return { ...blank, mode: "monthly", time, day: dom };
  let m = /^\*\/(\d+)$/.exec(h);
  if (num(mi) && m && dom === "*" && mon === "*" && dow === "*") return { ...blank, mode: "hours", n: m[1], time: `00:${pad(mi)}` };
  m = /^\*\/(\d+)$/.exec(mi);
  if (m && h === "*" && dom === "*" && mon === "*" && dow === "*") return { ...blank, mode: "minutes", n: m[1] };
  return { ...blank, mode: "custom" };
}

function buildCron(w) {
  const [h, mi] = (w.time || "08:00").split(":").map((x) => Number(x));
  switch (w.mode) {
    case "daily": return `${mi} ${h} * * *`;
    case "weekdays": return `${mi} ${h} * * 1-5`;
    case "weekly": return `${mi} ${h} * * ${w.dow}`;
    case "monthly": return `${mi} ${h} ${w.day} * *`;
    case "hours": return `${mi || 0} */${w.n} * * *`;
    case "minutes": return `*/${w.n} * * * *`;
    default: return w.cron.trim();
  }
}

export function describeCron(cron) {
  const s = S().when;
  const w = parseWhen(cron);
  switch (w.mode) {
    case "daily": return `${s.daily} ${s.at} ${w.time}`;
    case "weekdays": return `${s.weekdays} ${s.at} ${w.time}`;
    case "weekly": return `${s.days[Number(w.dow)]} ${s.at} ${w.time}`;
    case "monthly": return `${s.monthly}, ${s.on} ${w.day} ${s.at} ${w.time}`;
    case "hours": return `${s.every} ${w.n} h (:${w.time.slice(3)})`;
    case "minutes": return `${s.every} ${w.n} min`;
    default: return cron;
  }
}

// --- status pill: plain words, the detail on hover -----------------------------------------------------------------
const TONE = {
  done: "bg-primary/12 text-primary", OK: "bg-primary/12 text-primary", warning: "bg-warning/15 text-warning",
  failed: "bg-destructive/12 text-destructive", FAIL: "bg-destructive/12 text-destructive", TIMEOUT: "bg-destructive/12 text-destructive",
  running: "bg-info/15 text-info", waiting_approval: "bg-warning/15 text-warning", BLOCKED: "bg-warning/15 text-warning",
};
function StatePill({ state, detail }) {
  const s = S();
  const help = [s.stateHelp[state], detail].filter(Boolean).join(" · ");
  return (
    <span title={help || undefined} className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium", TONE[state] ?? "bg-muted text-muted-foreground")}>
      {state === "running" && <LoaderCircle className="size-3 animate-spin" />}
      {s.state[state] ?? state}
    </span>
  );
}
const stateOf = (last) => (!last ? "never" : last.status === "done" && last.warning ? "warning" : last.status ?? "never");

// --- scheduler strip -------------------------------------------------------------------------------------------------
function SchedulerStrip({ sch }) {
  const s = S();
  const on = !!sch?.alive;
  return (
    <div className={cn("flex items-start gap-3 rounded-2xl border px-4 py-3", on ? "bg-card/50" : "border-warning/40 bg-warning/5")}>
      <span className={cn("mt-1.5 size-2.5 shrink-0 rounded-full", on ? "bg-primary shadow-[0_0_0_4px] shadow-primary/15" : "bg-warning")} />
      <div className="grid min-w-0 gap-0.5">
        <span className="text-sm font-medium">{on ? s.schedOn : s.schedOff}</span>
        <span className="text-xs text-muted-foreground">{on ? s.schedOnDesc(sch.pid, Math.round((sch.ageMs ?? 0) / 1000), sch.enabled ?? 0, sch.running ?? 0) : s.schedOffDesc}</span>
      </div>
    </div>
  );
}

// --- schedule rows ---------------------------------------------------------------------------------------------------
function ScheduleRow({ x, open, onToggleOpen, onEdit, onRemove, onChanged, schedulerOn, flash }) {
  const s = S();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const act = async (fn) => { setBusy(true); setErr(""); try { await fn(); onChanged(); } catch (e) { setErr(e.message); } finally { setBusy(false); } };
  const state = stateOf(x.last);
  const what = x.type === "command" ? x.command : [x.skill && `/${x.skill}${x.args ? ` ${x.args}` : ""}`, x.prompt && x.prompt.split("\n")[0]].filter(Boolean).join(" · ");
  return (
    <div className={cn("grid", !x.enabled && "opacity-70")}>
      <div className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-6 sm:px-5">
        <button type="button" className="grid min-w-0 gap-1 text-left" onClick={onToggleOpen} aria-expanded={open}>
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            {open ? <ChevronDown className="size-3.5 text-muted-foreground" /> : <ChevronRight className="size-3.5 text-muted-foreground" />}
            <span className="truncate text-sm font-medium">{x.name}</span>
            <Badge variant="outline" className="font-normal">{x.type === "command" ? s.command : x.agentName ?? x.agent ?? s.agent}</Badge>
            <Badge variant="secondary" className="font-normal">{x.locationName}</Badge>
            {!x.enabled && <Badge variant="outline" className="font-normal text-muted-foreground">{s.off}</Badge>}
            {(!x.locationFound || !x.agentFound) && <TriangleAlert className="size-3.5 text-destructive" />}
          </span>
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-5.5 text-xs text-muted-foreground">
            <span>{describeCron(x.schedule)}</span>
            {x.enabled && <span>{s.next}: {when(x.next)}</span>}
            <span className="flex items-center gap-1.5">{s.last}: <StatePill state={state} detail={x.last?.error ?? (x.last?.exitCode ? `exit ${x.last.exitCode}` : "")} />{x.last?.at && <span className="font-mono">{stamp(x.last.at)}</span>}</span>
          </span>
          {what && <span className="truncate pl-5.5 font-mono text-[11px] text-muted-foreground">{what}</span>}
        </button>
        <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
          <Button size="sm" variant="outline" disabled={busy || !schedulerOn} title={schedulerOn ? s.runNow : s.needScheduler} onClick={() => act(async () => { await api.scheduleRun(x.id); flash(s.runQueued); })}><Play className="size-3.5" /> {s.runNow}</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(() => api.scheduleEnabled(x.id, !x.enabled))}><Power className="size-3.5" /> {x.enabled ? s.turnOff : s.turnOn}</Button>
          <Button size="icon" variant="ghost" title={s.edit} onClick={onEdit}><Pencil className="size-3.5" /></Button>
          <Button size="icon" variant="ghost" title={s.remove} onClick={onRemove}><Trash2 className="size-3.5" /></Button>
        </div>
      </div>
      {err && <p className="px-5 pb-2 text-xs text-destructive">{err}</p>}
      {open && <ScheduleRuns id={x.id} />}
    </div>
  );
}

function ScheduleRuns({ id }) {
  const s = S();
  const [data, setData] = useState({ jobs: [], project: null });
  const [jobId, setJobId] = useState(null);
  useEffect(() => {
    let live = true;
    const load = () => api.scheduleJobs(id).then((d) => { if (live) { setData(d); setJobId((cur) => cur ?? d.jobs[0]?.id ?? null); } }).catch(() => {});
    load();
    const t = setInterval(load, 4000);
    return () => { live = false; clearInterval(t); };
  }, [id]);
  return (
    <div className="grid gap-3 border-t bg-muted/20 px-4 py-3 sm:px-5">
      <span className="text-xs font-medium text-muted-foreground">{s.history}</span>
      {!data.jobs.length && <p className="text-xs text-muted-foreground">{s.noRuns}</p>}
      <div className="flex flex-wrap gap-1.5">
        {data.jobs.map((j) => (
          <button key={j.id} type="button" onClick={() => setJobId(j.id)}
            className={cn("flex items-center gap-1.5 rounded-[10px] border px-2 py-1 text-[11px] transition-colors hover:bg-accent/50", j.id === jobId && "border-primary/60 bg-primary/5")}>
            <span className="font-mono">{stamp(j.started)}</span><StatePill state={j.status === "done" && j.warning ? "warning" : j.status} />
          </button>
        ))}
      </div>
      {jobId && data.project && <JobLog key={jobId} project={data.project} jobId={jobId} />}
    </div>
  );
}

// --- dialogs ---------------------------------------------------------------------------------------------------------
function ScheduleDialog({ initial, agents, locations, onClose, onSaved }) {
  const s = S();
  const f0 = useMemo(() => {
    const x = initial ?? {};
    return {
      id: x.id ?? "", name: x.name ?? "", kind: x.type ?? "agent", location: x.location ?? "artrios", agent: x.agent ?? "",
      skill: x.skill ? `/${x.skill}${x.args ? ` ${x.args}` : ""}` : "", prompt: x.prompt ?? "", command: x.command ?? "",
      timeout: x.timeout ? String(x.timeout) : "", exitWarn: (x.exitWarn ?? []).join(", "), output: x.output ?? "", enabled: x.enabled !== false,
      w: parseWhen(x.schedule ?? "0 8 * * *"),
    };
  }, [initial]);
  const [f, setF] = useState(f0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const editing = !!initial;
  const idState = useIdFromName(editing);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e?.target ? e.target.value : e, ...(k === "name" && !idState.touched ? { id: slug(e.target.value) } : {}) }));
  const setW = (k) => (e) => setF((x) => ({ ...x, w: { ...x.w, [k]: e?.target ? e.target.value : e } }));
  const W = s.when;
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError("");
    const cron = buildCron(f.w);
    const body = {
      name: f.name.trim() || f.id.trim(), schedule: cron, location: f.location, enabled: f.enabled, output: f.output.trim(),
      ...(f.kind === "command"
        ? { command: f.command.trim(), timeout: f.timeout ? Number(f.timeout) : null, exitWarn: f.exitWarn.split(",").map((t) => t.trim()).filter(Boolean).map(Number), agent: null, skill: null, prompt: "" }
        : { command: "", agent: f.agent || null, skill: f.skill.trim().replace(/^\//, "") || null, args: "", prompt: f.prompt }),
    };
    try {
      if (editing) await api.updateSchedule(initial.id, body); else await api.createSchedule({ id: f.id.trim(), ...body });
      onSaved();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  const whenOptions = ["daily", "weekdays", "weekly", "monthly", "hours", "minutes", "custom"].map((v) => ({ value: v, label: W[v] }));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>{editing ? `${s.edit}: ${initial.name}` : s.newSchedule}</DialogTitle>
            <DialogDescription>{s.intro}</DialogDescription>
          </DialogHeader>
          <DialogBody className="grid gap-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={s.form.name}><input className={FIELD_FULL} required value={f.name} onChange={set("name")} autoFocus /></Field>
              <Field label={s.form.idLabel} hint={s.form.idHint}><input className={cn(FIELD_FULL, "font-mono")} required pattern="[a-z0-9][a-z0-9-]{0,63}" disabled={editing} value={f.id} onChange={(e) => { idState.touch(); set("id")(e); }} /></Field>
            </div>
            <div className="grid gap-2 rounded-xl border bg-muted/20 p-3">
              <div className="flex flex-wrap items-end gap-2">
                <Field label={s.form.when}><SelectField value={f.w.mode} onChange={setW("mode")} options={whenOptions} label={s.form.when} /></Field>
                {["daily", "weekdays", "weekly", "monthly"].includes(f.w.mode) && <Field label={s.form.time}><input type="time" className={cn(FIELD_FULL, "w-32")} value={f.w.time} onChange={setW("time")} /></Field>}
                {f.w.mode === "weekly" && <Field label={s.form.day}><SelectField value={f.w.dow} onChange={setW("dow")} options={W.days.map((d, i) => ({ value: String(i), label: d }))} label={s.form.day} /></Field>}
                {f.w.mode === "monthly" && <Field label={s.form.day}><input type="number" min="1" max="31" className={cn(FIELD_FULL, "w-24")} value={f.w.day} onChange={setW("day")} /></Field>}
                {["hours", "minutes"].includes(f.w.mode) && <Field label={s.form.interval}><input type="number" min="1" max={f.w.mode === "hours" ? 23 : 59} className={cn(FIELD_FULL, "w-24")} value={f.w.n} onChange={setW("n")} /></Field>}
                {f.w.mode === "custom" && <Field label="cron" hint={W.cronHint}><input className={cn(FIELD_FULL, "w-56 font-mono")} value={f.w.cron} onChange={setW("cron")} /></Field>}
              </div>
              <span className="font-mono text-[11px] text-muted-foreground">{buildCron(f.w) || "-"} · {describeCron(buildCron(f.w))}</span>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={s.form.location} hint={s.form.locationHint}><SelectField className="w-full" value={f.location} onChange={set("location")} options={locations.map((l) => ({ value: l.key, label: l.name, hint: l.home ? "Artrios" : l.key }))} label={s.form.location} /></Field>
              <Field label={s.form.kind}><SelectField className="w-full" value={f.kind} onChange={set("kind")} options={[{ value: "agent", label: s.form.kindAgent }, { value: "command", label: s.form.kindCommand }]} label={s.form.kind} /></Field>
            </div>
            {f.kind === "agent" ? (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label={s.form.agent} hint={s.form.agentHint}><SelectField className="w-full" value={f.agent || "__default"} onChange={(v) => { const a = agents.find((x) => x.id === v); setF((x) => ({ ...x, agent: v === "__default" ? "" : v, ...(a && !editing ? { location: a.location } : {}) })); }} options={[{ value: "__default", label: s.form.noAgent }, ...agents.map((a) => ({ value: a.id, label: a.name, hint: s.approval[a.approval] }))]} label={s.form.agent} /></Field>
                  <Field label={s.form.skill} hint={s.form.skillHint}><input className={cn(FIELD_FULL, "font-mono")} value={f.skill} onChange={set("skill")} placeholder="/ingest-wiki lint" /></Field>
                </div>
                <Field label={s.form.prompt} hint={s.form.promptHint}><Textarea rows={5} value={f.prompt} onChange={set("prompt")} /></Field>
              </>
            ) : (
              <>
                <Field label={s.form.command} hint={s.form.commandHint}><input className={cn(FIELD_FULL, "font-mono")} required value={f.command} onChange={set("command")} placeholder="python scripts/artrios_health.py" /></Field>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label={s.form.timeout}><input type="number" min="1" className={FIELD_FULL} value={f.timeout} onChange={set("timeout")} /></Field>
                  <Field label={s.form.exitWarn} hint={s.form.exitWarnHint}><input className={cn(FIELD_FULL, "font-mono")} value={f.exitWarn} onChange={set("exitWarn")} placeholder="1" /></Field>
                </div>
              </>
            )}
            <Field label={s.form.output} hint={s.form.outputHint}><input className={FIELD_FULL} value={f.output} onChange={set("output")} /></Field>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>{s.form.cancel}</Button>
            <Button type="submit" disabled={busy}>{busy && <LoaderCircle className="size-4 animate-spin" />} {editing ? s.form.save : s.form.create}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AgentDialog({ initial, locations, onClose, onSaved }) {
  const s = S();
  const x = initial ?? {};
  const [f, setF] = useState({
    id: x.id ?? "", name: x.name ?? "", description: x.description ?? "", instructions: x.instructions ?? "", model: x.model ?? "", engine: x.engine ?? "",
    tools: (x.allowedTools ?? ["Read", "Grep", "Glob"]).join(", "), approval: x.approval ?? "report-only",
    maxUsd: x.budget?.maxUsd != null ? String(x.budget.maxUsd) : "0.5", maxMinutes: x.budget?.maxMinutes != null ? String(x.budget.maxMinutes) : "15", location: x.location ?? "artrios",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const editing = !!initial;
  const idState = useIdFromName(editing);
  const set = (k) => (e) => setF((v) => ({ ...v, [k]: e?.target ? e.target.value : e, ...(k === "name" && !idState.touched ? { id: slug(e.target.value) } : {}) }));
  const [picker, setPicker] = useState(false);
  const [models, setModels] = useState(null);
  const openPicker = async () => { try { setModels(await api.models()); setPicker(true); } catch (err) { setError(err.message); } };
  const modelLabel = f.engine || f.model ? [f.engine, f.model].filter(Boolean).join(" · ") : s.form.mainModel;
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError("");
    const body = {
      name: f.name.trim() || f.id.trim(), description: f.description.trim(), instructions: f.instructions, model: f.model.trim() || null, engine: f.engine || null,
      allowedTools: f.tools.split(",").map((t) => t.trim()).filter(Boolean), approval: f.approval, location: f.location,
      budget: { ...(f.maxUsd.trim() ? { maxUsd: Number(f.maxUsd) } : {}), ...(f.maxMinutes.trim() ? { maxMinutes: Number(f.maxMinutes) } : {}) },
    };
    try {
      if (editing) await api.updateAgent(initial.id, body); else await api.createAgent({ id: f.id.trim(), ...body });
      onSaved();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>{editing ? `${s.edit}: ${initial.name}` : s.newAgent}</DialogTitle>
            <DialogDescription>{s.agentsIntro}</DialogDescription>
          </DialogHeader>
          <DialogBody className="grid gap-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={s.form.name}><input className={FIELD_FULL} required value={f.name} onChange={set("name")} autoFocus /></Field>
              <Field label={s.form.idLabel} hint={s.form.idHint}><input className={cn(FIELD_FULL, "font-mono")} required pattern="[a-z0-9][a-z0-9-]{0,63}" disabled={editing} value={f.id} onChange={(e) => { idState.touch(); set("id")(e); }} /></Field>
            </div>
            <Field label={s.form.description}><input className={FIELD_FULL} value={f.description} onChange={set("description")} /></Field>
            <Field label={s.form.role} hint={s.form.roleHint}><Textarea rows={4} value={f.instructions} onChange={set("instructions")} /></Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={s.form.approval} hint={s.approvalHint[f.approval]}><SelectField className="w-full" value={f.approval} onChange={set("approval")} options={Object.keys(s.approval).map((k) => ({ value: k, label: s.approval[k], hint: s.approvalHint[k] }))} label={s.form.approval} /></Field>
              <Field label={s.form.defaultLocation}><SelectField className="w-full" value={f.location} onChange={set("location")} options={locations.map((l) => ({ value: l.key, label: l.name }))} label={s.form.defaultLocation} /></Field>
            </div>
            <Field label={s.form.tools} hint={s.form.toolsHint}><input className={cn(FIELD_FULL, "font-mono")} value={f.tools} onChange={set("tools")} /></Field>
            <Field label={s.form.model} hint={s.form.modelHint}>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" variant="outline" className="h-9 min-w-48 justify-start rounded-[10px] border-border-strong bg-card/60 font-mono text-[13px]" onClick={openPicker}>{modelLabel}</Button>
                {(f.engine || f.model) && <Button type="button" variant="ghost" size="sm" onClick={() => setF((v) => ({ ...v, engine: "", model: "" }))}>{s.form.useMain}</Button>}
              </div>
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={s.form.maxUsd}><input type="number" step="0.1" min="0" className={FIELD_FULL} value={f.maxUsd} onChange={set("maxUsd")} /></Field>
              <Field label={s.form.maxMinutes}><input type="number" min="1" className={FIELD_FULL} value={f.maxMinutes} onChange={set("maxMinutes")} /></Field>
            </div>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>{s.form.cancel}</Button>
            <Button type="submit" disabled={busy}>{busy && <LoaderCircle className="size-4 animate-spin" />} {editing ? s.form.save : s.form.create}</Button>
          </DialogFooter>
        </form>
        <ModelPicker open={picker} onClose={() => setPicker(false)} options={models} mode="session" title={s.form.model}
          current={{ provider: f.engine || models?.current?.provider || null, model: f.model }}
          onApply={async ({ provider, model }) => setF((v) => ({ ...v, engine: provider, model: model ?? "" }))}
          onRefresh={async (id) => { await api.refreshProviderModels(id); setModels(await api.models()); }} />
      </DialogContent>
    </Dialog>
  );
}

function ConfirmRemove({ name, onCancel, onConfirm }) {
  const s = S();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>{s.remove}</DialogTitle><DialogDescription>{s.form.confirmRemove(name)}</DialogDescription></DialogHeader>
        {error && <DialogBody><p role="alert" className="text-sm text-destructive">{error}</p></DialogBody>}
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>{s.form.cancel}</Button>
          <Button variant="destructive" disabled={busy} onClick={async () => { setBusy(true); try { await onConfirm(); } catch (e) { setError(e.message); setBusy(false); } }}>{busy && <LoaderCircle className="size-4 animate-spin" />} {s.remove}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --- Today tab (digest, waiting, skills) -----------------------------------------------------------------------------
// A pending decision, answered right here; "revisi" needs a note, so it opens Decision Required instead.
function WaitingDecision({ i, onDone, onOpenPutusan }) {
  const s = S().today;
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const decide = async (o) => {
    if (o === "revisi") { onOpenPutusan?.(); return; }
    setBusy(o); setErr("");
    try { await api.inboxDecide(i.id, o, ""); onDone(); } catch (e) { setErr(e.message); } finally { setBusy(""); }
  };
  return (
    <div className="grid gap-1.5 px-4 py-2.5 sm:px-5">
      <span className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <span className="font-mono">{i.date}</span>
        <Badge variant="outline" className="font-normal">{s.kinds[i.kind] ?? i.kind}</Badge>
        {i.stale && <span className="rounded-full bg-warning/15 px-2 py-0.5 text-warning">{s.old}</span>}
      </span>
      {i.title && <span className="text-sm font-medium">{i.title}</span>}
      <span className="text-[13px] text-muted-foreground">{i.text}</span>
      <div className="flex flex-wrap gap-1.5 pt-0.5">
        {(i.options ?? []).map((o, n) => (
          <Button key={o} size="sm" variant={n === 0 ? "default" : "outline"} disabled={!!busy} onClick={() => decide(o)}>
            {busy === o && <LoaderCircle className="size-3.5 animate-spin" />} {o}
          </Button>
        ))}
      </div>
      {err && <p role="alert" className="text-xs text-destructive">{err}</p>}
    </div>
  );
}

// A task that needs Raka's own hands; Done closes it in the task tool (two clicks, so a slip does not close it).
function WaitingTask({ t, canDone, onDone }) {
  const s = S().today;
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const done = async () => {
    if (!confirm) { setConfirm(true); setTimeout(() => setConfirm(false), 5000); return; }
    setBusy(true); setErr("");
    try { await api.taskDone(t.key, t.hat); onDone(); } catch (e) { setErr(e.message); setBusy(false); }
  };
  return (
    <div className="grid gap-1.5 px-4 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-4 sm:px-5">
      <div className="grid min-w-0 gap-1">
        <span className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          <span className="font-mono font-medium text-foreground">{t.key}</span>
          <Badge variant="outline" className="font-normal">{t.state}</Badge>
          {t.due && <span className="font-mono">{s.due} {t.due}</span>}
        </span>
        <span className="text-[13px]">{t.title}</span>
        {err && <span role="alert" className="text-xs text-destructive">{err}</span>}
      </div>
      {canDone && (
        <Button size="sm" variant={confirm ? "default" : "outline"} disabled={busy} onClick={done}>
          {busy && <LoaderCircle className="size-3.5 animate-spin" />} {confirm ? s.confirmDone : s.markDone}
        </Button>
      )}
    </div>
  );
}

function TodayTab({ onOpenPutusan }) {
  const s = S().today;
  const [d, setD] = useState(null);
  const [tasks, setTasks] = useState(null); // loads on its own: the task tool may take a few seconds
  const reload = useCallback(() => {
    api.pulse().then(setD).catch(() => {});
    api.waitingTasks().then(setTasks).catch((e) => setTasks({ enabled: true, tasks: [], error: e.message }));
  }, []);
  useEffect(() => { reload(); }, [reload]);
  if (!d) return <LoaderCircle className="size-4 animate-spin" />;
  const age = (iso, stale) => <span className={cn("font-mono text-[11px]", stale ? "text-warning" : "text-muted-foreground")}>{stale ? `${s.stale} · ` : ""}{String(iso ?? "").slice(0, 16).replace("T", " ")}</span>;
  return (
    <div className="grid gap-4">
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <SettingsSection icon={CalendarClock} title={`${s.digest}${d.today.date ? ` (${d.today.date})` : ""}`} action={age(d.today.builtAt, d.today.stale)}>
          <div className="px-4 py-3 text-sm sm:px-5">{d.today.markdown ? <Markdown text={d.today.markdown} /> : <p className="text-muted-foreground">{s.noDigest}</p>}</div>
        </SettingsSection>
        <SettingsSection icon={TriangleAlert} title={s.waiting} intro={s.waitingIntro}
          action={onOpenPutusan && d.waiting.total > 0 ? <Button size="sm" variant="outline" onClick={onOpenPutusan}>{s.openDecisions(d.waiting.total)}</Button> : null}>
          <div className="px-4 pt-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground sm:px-5">{s.decisionsHead}</div>
          {!d.waiting.items.length && <p className="px-4 pb-3 text-sm text-muted-foreground sm:px-5">{s.nothing}</p>}
          {d.waiting.items.map((i) => <WaitingDecision key={i.id} i={i} onDone={reload} onOpenPutusan={onOpenPutusan} />)}
          {(tasks === null || tasks.enabled) && (
            <>
              <div className="px-4 pt-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground sm:px-5">{s.tasksHead}</div>
              {tasks === null && <div className="px-4 pb-3 sm:px-5"><LoaderCircle className="size-4 animate-spin text-muted-foreground" /></div>}
              {tasks?.error && <p className="px-4 pb-2 text-xs text-destructive sm:px-5">{tasks.error}</p>}
              {tasks && !tasks.tasks.length && !tasks.error && <p className="px-4 pb-3 text-sm text-muted-foreground sm:px-5">{s.noTasks}</p>}
              {tasks?.tasks.map((t) => <WaitingTask key={t.key} t={t} canDone={tasks.canDone} onDone={reload} />)}
            </>
          )}
          {d.waiting.inbox > 0 && <p className="px-4 py-2.5 text-xs text-muted-foreground sm:px-5">{s.inbox(d.waiting.inbox)}</p>}
        </SettingsSection>
      </div>
      <SettingsSection icon={Bot} title={`${s.skills} (${d.skills.length})`}>
        <div className="flex flex-wrap gap-1.5 px-4 py-3 sm:px-5">{d.skills.map((k) => <Badge key={k.name} variant="secondary" title={k.description}>/{k.name}</Badge>)}</div>
      </SettingsSection>
    </div>
  );
}

// --- screen ----------------------------------------------------------------------------------------------------------
export default function RoutinesView({ onOpenPutusan }) {
  const s = S();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [tab, setTab] = usePersisted("routines.tab", "schedules", (v) => ["schedules", "agents", "today"].includes(v));
  const [open, setOpen] = useState(null);
  const [dialog, setDialog] = useState(null); // { kind: 'schedule'|'agent', initial } | { kind: 'remove', ... }
  const [note, setNote] = useState("");
  const load = useCallback(() => api.routines().then((d) => { setData(d); setError(""); }).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);
  const flash = (m) => { setNote(m); setTimeout(() => setNote(""), 6000); };
  const close = () => setDialog(null);
  const saved = () => { setDialog(null); load(); };
  const schedulerOn = !!data?.scheduler?.alive;

  return (
    <div className="grid gap-4">
      <PageHeader title={s.title} intro={s.intro}>
        <Button size="sm" variant="outline" onClick={load}><RefreshCw className="size-3.5" /> {s.refresh}</Button>
        {tab === "agents"
          ? <Button size="sm" onClick={() => setDialog({ kind: "agent" })}><Plus className="size-3.5" /> {s.newAgent}</Button>
          : <Button size="sm" onClick={() => setDialog({ kind: "schedule" })} disabled={!data}><Plus className="size-3.5" /> {s.newSchedule}</Button>}
      </PageHeader>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {data && <SchedulerStrip sch={data.scheduler} />}
      {note && <p className="rounded-xl border bg-card/50 px-3 py-2 text-xs text-muted-foreground">{note}</p>}
      {data?.errors.length > 0 && (
        <SettingsSection icon={TriangleAlert} title={s.problemsTitle} intro={s.problemsIntro}>
          {data.errors.map((e) => <SettingRow key={e.kind + e.file} title={<span className="font-mono text-xs">{e.kind}/{e.file}</span>} desc={e.error} />)}
        </SettingsSection>
      )}
      <Tabs value={tab} onValueChange={setTab} className="flex flex-col gap-2">
        <TabsList>
          <TabsTrigger value="schedules">{s.tabs.schedules}{data ? ` (${data.schedules.length})` : ""}</TabsTrigger>
          <TabsTrigger value="agents">{s.tabs.agents}{data ? ` (${data.agents.length})` : ""}</TabsTrigger>
          <TabsTrigger value="today">{s.tabs.today}</TabsTrigger>
        </TabsList>
        <TabsContent value="schedules" className="grid gap-4 pt-2">
          <SettingsSection icon={CalendarClock} id="routines-schedules" title={s.schedulesTitle} intro={s.schedulesIntro}>
            {data && !data.schedules.length && <p className="px-5 py-4 text-sm text-muted-foreground">{s.noSchedules}</p>}
            {data?.schedules.map((x) => (
              <ScheduleRow key={x.id} x={x} open={open === x.id} onToggleOpen={() => setOpen(open === x.id ? null : x.id)} schedulerOn={schedulerOn} flash={flash}
                onEdit={() => setDialog({ kind: "schedule", initial: x })} onChanged={load}
                onRemove={() => setDialog({ kind: "remove", name: x.name, run: () => api.removeSchedule(x.id) })} />
            ))}
          </SettingsSection>
          {data?.remote.length > 0 && (
            <SettingsSection icon={Server} id="routines-remote" title={s.remoteTitle} intro={s.remoteIntro}>
              {data.remote.map((r) => (
                <SettingRow key={r.host + r.name} title={<span className="flex items-center gap-2">{r.name}<Badge variant="secondary" className="font-normal">{r.host}</Badge></span>} desc={`${r.schedule}${r.last ? ` · ${r.last.t.slice(5, 16).replace("T", " ")}` : ""}`}>
                  <StatePill state={r.state} detail={r.last?.detail} />
                </SettingRow>
              ))}
            </SettingsSection>
          )}
        </TabsContent>
        <TabsContent value="agents" className="pt-2">
          <SettingsSection icon={Bot} id="routines-agents" title={s.agentsTitle} intro={s.agentsIntro}>
            {data && !data.agents.length && <p className="px-5 py-4 text-sm text-muted-foreground">{s.noAgents}</p>}
            {data?.agents.map((a) => (
              <SettingRow key={a.id} title={<span className="flex flex-wrap items-center gap-2">{a.name}<Badge variant="outline" className="font-normal">{s.approval[a.approval]}</Badge><Badge variant="secondary" className="font-normal">{a.locationName}</Badge></span>}
                desc={[a.description, `${a.allowedTools.join(", ") || "-"}`, a.model, a.budget?.maxUsd != null && `${a.budget.maxUsd} USD`, a.budget?.maxMinutes != null && `${a.budget.maxMinutes} min`, s.usedBy(a.usedBy.length)].filter(Boolean).join(" · ")}>
                <Button size="icon" variant="ghost" title={s.edit} onClick={() => setDialog({ kind: "agent", initial: a })}><Pencil className="size-3.5" /></Button>
                <Button size="icon" variant="ghost" title={s.remove} onClick={() => setDialog({ kind: "remove", name: a.name, run: () => api.removeAgent(a.id) })}><Trash2 className="size-3.5" /></Button>
              </SettingRow>
            ))}
          </SettingsSection>
        </TabsContent>
        <TabsContent value="today" className="pt-2"><TodayTab onOpenPutusan={onOpenPutusan} /></TabsContent>
      </Tabs>
      {dialog?.kind === "schedule" && <ScheduleDialog initial={dialog.initial} agents={data?.agents ?? []} locations={data?.locations ?? []} onClose={close} onSaved={saved} />}
      {dialog?.kind === "agent" && <AgentDialog initial={dialog.initial} locations={data?.locations ?? []} onClose={close} onSaved={saved} />}
      {dialog?.kind === "remove" && <ConfirmRemove name={dialog.name} onCancel={close} onConfirm={async () => { await dialog.run(); saved(); }} />}
    </div>
  );
}
