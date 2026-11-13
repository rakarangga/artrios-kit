// Worktrees screen and the card's worktree panel (PRD AIOS-61 v2.1 S11): one card per worktree with branch, linked
// cards, summary against the base branch, and Merge to main, Create PR, Copy Path, Delete, Check for Conflicts.
// Every action is done by the server (server/git-service.js); this screen only asks and shows the result.
import { useCallback, useEffect, useState } from "react";
import { ArrowRight, Copy, Download, FolderOpen, GitBranch, GitMerge, GitPullRequest, LoaderCircle, Plus, RefreshCw, SearchCheck, Sparkles, SquareCode, SquareTerminal, Trash2 } from "lucide-react";
import { api } from "../api.js";
import { T } from "../texts.js";
import { subscribe } from "../socket.js";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FIELD_FULL, PageHeader, copyText } from "@/components/field";
import { GithubConnectDialog } from "./GitSettings.jsx";

const S = () => T.views.worktrees;

// Confirmation for the actions that change the repository. onConfirm returns a promise; its error stays in the dialog.
function Confirm({ title, desc, action, destructive, onConfirm, onClose }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const go = async () => { setBusy(true); setError(""); try { await onConfirm(); onClose(); } catch (e) { setError(e.message); } finally { setBusy(false); } };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{desc}</DialogDescription></DialogHeader>
        {error && <DialogBody><p role="alert" className="text-sm text-destructive">{error}</p></DialogBody>}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>{S().cancel}</Button>
          <Button variant={destructive ? "destructive" : "default"} disabled={busy} onClick={go}>{busy && <LoaderCircle className="size-4 animate-spin" />} {action}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Summary({ w }) {
  const s = S();
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-muted-foreground">
      <span>{w.files} {w.files === 1 ? s.file : s.files} <span className="text-positive">+{w.added}</span> <span className="text-destructive">−{w.deleted}</span></span>
      <span>{w.ahead ?? "?"} {s.ahead}</span>
      {w.behind ? <span>{w.behind} {s.behind}</span> : null}
      <span className={w.changes ? "text-warning" : ""}>{w.changes === null ? "?" : w.changes ? `${w.changes} ${s.changes}` : s.clean}</span>
    </span>
  );
}

// The actions of one worktree branch, shared by the Worktrees screen and the card panel.
function useBranchActions(project, onDone) {
  const [ask, setAsk] = useState(null); // { kind, w, card }
  const [note, setNote] = useState(null); // { path, text, tone, files }
  const say = (w, text, tone = "info", files = null) => setNote({ path: w.path, text, tone, files });
  const check = async (w) => {
    try {
      const r = await api.conflicts(project, w.branch);
      say(w, r.conflict ? S().conflictFiles(r.files.length) : S().noConflicts, r.conflict ? "warn" : "ok", r.conflict ? r.files : null);
    } catch (e) { say(w, e.message, "error"); }
  };
  const dialogs = ask && (() => {
    const s = S();
    const { kind, w, card } = ask;
    const close = () => setAsk(null);
    if (kind === "merge") return <Confirm title={s.confirmMerge(w.branch, w.base)} desc={s.confirmMergeDesc} action={s.merge} onClose={close} onConfirm={async () => { const r = await api.mergeBranch(project, w.branch, card); say(w, s.merged(r.head), "ok"); onDone?.(); }} />;
    if (kind === "pr") return <Confirm title={s.confirmPr(w.branch)} desc={s.confirmPrDesc} action={s.pr} onClose={close} onConfirm={async () => { const r = await api.createPr(project, w.branch, card); say(w, `${s.prDone} ${r.url}`, "ok"); onDone?.(); }} />;
    if (kind === "delete" || kind === "force") {
      const force = kind === "force";
      return (
        <Confirm destructive title={force ? s.forceTitle : s.confirmDel(w.branch || w.head)} desc={force ? ask.reason : s.confirmDelDesc} action={force ? s.force : s.del} onClose={close}
          onConfirm={async () => {
            try {
              const r = await api.removeWorktree(project, w.path, force);
              say(w, r.keptUnmerged ? `${s.deleted} ${s.keptBranch}` : s.deleted, "ok");
              onDone?.();
            } catch (e) {
              if (e.needsConfirm && !force) { setTimeout(() => setAsk({ kind: "force", w, reason: e.message }), 0); return; }
              throw e;
            }
          }} />
      );
    }
    return null;
  })();
  return { setAsk, check, note, dialogs };
}

function Note({ note }) {
  if (!note) return null;
  const tone = { ok: "text-positive", warn: "text-warning", error: "text-destructive", info: "text-muted-foreground" }[note.tone];
  const url = /https?:\/\/\S+/.exec(note.text)?.[0];
  return (
    <div className={cn("text-xs", tone)} role="status">
      {url ? <>{note.text.replace(url, "")} <a className="underline" href={url} target="_blank" rel="noreferrer">{url}</a></> : note.text}
      {note.files && <ul className="mt-1 grid gap-0.5 font-mono">{note.files.map((f) => <li key={f}>{f}</li>)}</ul>}
    </div>
  );
}

function BranchButtons({ w, allowPush, actions, card }) {
  const s = S();
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => actions.check(w)}><SearchCheck className="size-4" /> {s.conflicts}</Button>
      <Button variant="outline" size="sm" onClick={() => actions.setAsk({ kind: "merge", w, card })}><GitMerge className="size-4" /> {s.merge}</Button>
      {allowPush && <Button variant="outline" size="sm" onClick={() => actions.setAsk({ kind: "pr", w, card })}><GitPullRequest className="size-4" /> {s.pr}</Button>}
    </>
  );
}

export function WorktreesView({ project, terminalOn, onCognition, onTerminal, onOpenCard }) {
  const s = S();
  const [data, setData] = useState(null);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState("");
  const [form, setForm] = useState({ branch: "", from: "" });
  const [creating, setCreating] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [formError, setFormError] = useState("");
  const [gh, setGh] = useState(null);
  const [connect, setConnect] = useState(false);
  const loadGh = useCallback(() => { api.gitSettings().then(setGh).catch(() => setGh(null)); }, []);
  useEffect(() => { loadGh(); }, [loadGh]);
  const [busy, setBusy] = useState("");
  const load = useCallback(() => {
    setLoading(true);
    Promise.all([api.worktrees(project), api.gitStatus(project).catch(() => null)])
      .then(([w, st]) => { setData(w); setStatus(st); setError(""); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [project]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => subscribe((m) => { if (m.project === project && m.type === "activity" && String(m.event?.type).startsWith("git.")) load(); }), [project, load]);
  const actions = useBranchActions(project, load);
  const open = async (target, worktree) => { setError(""); try { await api.openIn(project, { target, worktree }); } catch (e) { setError(e.message); } };
  const create = async (e) => {
    e.preventDefault();
    setCreating(true); setFormError("");
    try { await api.createWorktree(project, { branch: form.branch.trim(), from: form.from.trim() || undefined }); setForm({ branch: "", from: "" }); setNewOpen(false); load(); } catch (x) { setFormError(x.message); } finally { setCreating(false); }
  };
  const repoAction = async (name, fn) => { setBusy(name); setError(""); try { setStatus(await fn(project)); load(); } catch (x) { setError(x.message); } finally { setBusy(""); } };
  const openTerminal = async (w) => { setError(""); try { await api.openTerminal(project, { cols: 100, rows: 30, worktree: w.path }); onTerminal?.(); } catch (x) { setError(x.message); } };

  return (
    <div className="grid max-w-4xl gap-4">
      <PageHeader title={s.title} intro={s.intro}>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}><RefreshCw className={cn("size-4", loading && "animate-spin")} /> {s.refresh}</Button>
        {data?.git && <Button size="sm" onClick={() => { setFormError(""); setNewOpen(true); }}><Plus className="size-4" /> {s.newTitle}</Button>}
      </PageHeader>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {!loading && data && !data.git && <p className="rounded-md border-2 border-dashed px-3 py-6 text-center text-sm text-muted-foreground">{s.none}</p>}
      {data?.git && status?.git && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-card px-3.5 py-2.5 text-sm">
          <span className="eyebrow">{s.status}</span>
          <Badge variant="outline" className="font-mono">{status.branch}</Badge>
          <span className="font-mono text-xs text-muted-foreground">{status.upstream ? `${status.upstream} · ${status.ahead} ${s.ahead} · ${status.behind} ${s.behind}` : s.noUpstream}</span>
          <span className="ml-auto flex gap-2">
            <Button variant="outline" size="sm" disabled={!!busy} onClick={() => repoAction("fetch", api.gitFetch)}>{busy === "fetch" ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} {s.fetch}</Button>
            <Button variant="outline" size="sm" disabled={!!busy || !status.upstream} onClick={() => repoAction("pull", api.gitPull)}>{busy === "pull" ? <LoaderCircle className="size-4 animate-spin" /> : <Download className="size-4" />} {s.pull}</Button>
          </span>
        </div>
      )}
      {data?.git && gh && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-card px-3.5 py-2.5 text-sm">
          <span className="eyebrow">{s.github}</span>
          <span className={cn("font-mono text-xs", gh.gh.loggedIn ? "text-positive" : "text-warning")}>{gh.gh.loggedIn ? s.ghIn(gh.gh.account) : s.ghOut}</span>
          {!gh.gh.loggedIn && gh.gh.installed && <Button size="sm" className="ml-auto" onClick={() => setConnect(true)}>{s.connect}</Button>}
          {gh.gh.loggedIn && !gh.allowPush && <span className="ml-auto text-xs text-muted-foreground">{s.pushOff}</span>}
        </div>
      )}
      {connect && <GithubConnectDialog onClose={() => { setConnect(false); loadGh(); load(); }} onDone={loadGh} />}
      {data?.git && (data.worktrees ?? []).map((w) => (
        <div key={w.path} className={cn("grid gap-2 rounded-md border bg-card p-3.5", w.main && "border-dashed")}>
          <div className="flex flex-wrap items-center gap-2">
            <GitBranch className="size-4 text-muted-foreground" />
            <span className="font-semibold">{w.branch || "(detached)"}</span>
            {w.main ? <Badge variant="outline">{s.main}</Badge> : <Badge variant="outline" className="font-mono">{w.head}</Badge>}
            {(w.cards ?? []).map((c) => <Badge key={c.key} className="cursor-pointer bg-info/15 font-mono text-info" onClick={() => onOpenCard?.(c.key)} title={c.title}>{c.key}</Badge>)}
            {!w.main && <span className="ml-auto"><Summary w={w} /></span>}
          </div>
          {!w.main && <span className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground">{w.base} <ArrowRight className="size-3" /> {w.branch}</span>}
          <code className="break-all text-xs text-muted-foreground">{w.path}</code>
          <div className="flex flex-wrap gap-2">
            {!w.main && w.branch && <BranchButtons w={w} allowPush={data.allowPush} actions={actions} card={w.cards?.[0]?.key} />}
            <Button variant="outline" size="sm" onClick={async () => { if (await copyText(w.path)) { setCopied(w.path); setTimeout(() => setCopied(""), 1500); } }}><Copy className="size-4" /> {copied === w.path ? s.copied : s.copyPath}</Button>
            {!w.main && <Button variant="outline" size="sm" onClick={() => onCognition?.(w.key)}><Sparkles className="size-4" /> {s.chat}</Button>}
            {!w.main && terminalOn && <Button variant="outline" size="sm" onClick={() => openTerminal(w)}><SquareTerminal className="size-4" /> {s.terminal}</Button>}
            <Button variant="outline" size="sm" onClick={() => open("vscode", w.path)}><SquareCode className="size-4" /> {s.vscode}</Button>
            <Button variant="outline" size="sm" onClick={() => open("folder", w.path)}><FolderOpen className="size-4" /> {s.folder}</Button>
            {!w.main && <Button variant="outline" size="sm" className="text-destructive" onClick={() => actions.setAsk({ kind: "delete", w })}><Trash2 className="size-4" /> {s.del}</Button>}
          </div>
          {actions.note?.path === w.path && <Note note={actions.note} />}
        </div>
      ))}
      {actions.dialogs}
      {newOpen && (
        <Dialog open onOpenChange={(o) => !o && setNewOpen(false)}>
          <DialogContent className="sm:max-w-lg">
            <form onSubmit={create} className="flex min-h-0 flex-1 flex-col">
              <DialogHeader><DialogTitle>{s.newTitle}</DialogTitle><DialogDescription>{s.intro}</DialogDescription></DialogHeader>
              <DialogBody className="grid gap-3">
                <Field label={s.branch} hint={s.branchHint}><input className={FIELD_FULL} autoFocus required value={form.branch} placeholder="feat/my-change" onChange={(e) => setForm({ ...form, branch: e.target.value })} /></Field>
                <Field label={s.from} hint={s.fromHint}><input className={FIELD_FULL} value={form.from} placeholder={data?.base} onChange={(e) => setForm({ ...form, from: e.target.value })} /></Field>
                {formError && <p role="alert" className="text-sm text-destructive">{formError}</p>}
              </DialogBody>
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setNewOpen(false)}>{s.cancel}</Button>
                <Button type="submit" disabled={creating || !form.branch.trim()}>{creating && <LoaderCircle className="size-4 animate-spin" />} {s.create}</Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

// Human Review of a card that ran in a worktree: summary, base > branch, path, Check for Conflicts, Merge, Create PR.
export function CardWorktreePanel({ project, card, onChanged }) {
  const s = S();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const load = useCallback(() => { api.worktrees(project).then(setData).catch((e) => setError(e.message)); }, [project]);
  useEffect(() => { load(); }, [load]);
  const actions = useBranchActions(project, () => { load(); onChanged?.(); });
  const w = data?.worktrees.find((x) => x.branch === card.branch);
  return (
    <section className="grid gap-2 rounded-md border bg-card p-3.5" aria-label={s.card}>
      <h3 className="eyebrow">{s.card}</h3>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <span className="flex items-center gap-1.5 font-mono text-xs">{w?.base ?? data?.base ?? "main"} <ArrowRight className="size-3" /> {card.branch}</span>
      {w ? (
        <>
          <Summary w={w} />
          <code className="break-all text-xs text-muted-foreground">{w.path}</code>
          <div className="flex flex-wrap gap-2">
            <BranchButtons w={w} allowPush={data.allowPush} actions={actions} card={card.key} />
            <Button variant="outline" size="sm" onClick={async () => { if (await copyText(w.path)) { setCopied(true); setTimeout(() => setCopied(false), 1500); } }}><Copy className="size-4" /> {copied ? s.copied : s.copyPath}</Button>
          </div>
          <Note note={actions.note} />
        </>
      ) : data && <p className="text-xs text-muted-foreground">{card.worktree} ({s.deleted.replace(".", "")})</p>}
      {actions.dialogs}
    </section>
  );
}
