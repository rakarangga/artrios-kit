import { useState } from "react";
import { ArrowLeft, ChevronRight, FolderOpen, FolderPlus, FolderSearch } from "lucide-react";
import { api } from "./api.js";
import { T } from "./texts.js";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function Field({ label, children }) {
  return <label className="field-label">{label}{children}</label>;
}

// Step 1 of the reference dialog: two large choices, each with an icon tile, a hint and a chevron.
function Choice({ icon: Icon, tone, title, hint, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full items-center gap-3.5 rounded-[10px] border border-border-strong bg-card/60 p-3.5 text-left transition-colors outline-none hover:border-primary/60 hover:bg-primary/10 focus-visible:border-primary/70 focus-visible:ring-4 focus-visible:ring-primary/15"
    >
      <span className={cn("flex size-11 shrink-0 items-center justify-center rounded-lg", tone)}><Icon className="size-5" /></span>
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="text-sm font-semibold">{title}</span>
        <span className="text-[13px] text-muted-foreground">{hint}</span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
    </button>
  );
}

// Add project dialog (F6): choose how, fill in, review the write plan, approve. Nothing is written before "Approve" (B3).
export default function AddProject({ onDone, onCancel }) {
  const [step, setStep] = useState("choose");
  const [f, setF] = useState({ path: "", mode: "existing", client: "", key: "", name: "", gitInit: true });
  const [plan, setPlan] = useState(null);
  const [planned, setPlanned] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const t = T.addDialog;
  const set = (patch) => { setF({ ...f, ...patch }); setErr(""); };
  const stale = plan && !same(planned, f);

  // Opens the Windows folder picker on this PC; elsewhere the server answers "unavailable" and the user types the path.
  const browse = async () => {
    try { const r = await api.browseFolder(); if (r.path) set({ path: r.path }); } catch (x) { setErr(x.message); }
  };
  const choose = (mode) => { setF({ ...f, mode }); setStep("form"); setErr(""); };
  const back = () => { setStep("choose"); setPlan(null); setPlanned(null); setErr(""); };

  const review = async (e) => {
    e.preventDefault();
    setBusy(true);
    try { setPlan(await api.planProject(f)); setPlanned(f); setErr(""); } catch (x) { setPlan(null); setErr(x.message); }
    setBusy(false);
  };
  const approve = async () => {
    setBusy(true);
    try { const r = await api.addProject({ ...planned, planId: plan.planId }); onDone(r.project.key); } catch (x) { setErr(x.message); }
    setBusy(false);
  };

  if (step === "choose") {
    return (
      <Dialog open onOpenChange={(o) => !o && onCancel()}>
        <DialogContent closeLabel={T.close} className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t.title}</DialogTitle>
            <DialogDescription>{t.choose}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-3 py-5">
            <Choice icon={FolderOpen} tone="bg-primary/15 text-primary" title={t.openExisting} hint={t.openExistingHint} onClick={() => choose("existing")} />
            <Choice icon={FolderPlus} tone="bg-positive/15 text-positive" title={t.createNew} hint={t.createNewHint} onClick={() => choose("new")} />
          </DialogBody>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent closeLabel={T.close} className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{f.mode === "new" ? t.createNew : t.openExisting}</DialogTitle>
          <DialogDescription>{f.mode === "new" ? t.createNewHint : t.openExistingHint}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <form id="add-project-form" className="grid gap-3" onSubmit={review}>
            <Field label={t.path}>
              <div className="flex gap-2">
                <input className="field flex-1" autoFocus required placeholder="D:\ai\my-workspace" value={f.path} onChange={(e) => set({ path: e.target.value })} />
                <Button type="button" variant="outline" onClick={browse}><FolderSearch className="size-4" /> {T.browse}</Button>
              </div>
            </Field>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label={t.client} hint={t.clientHint}><input className="field" maxLength={80} placeholder={t.clientPlaceholder} value={f.client} onChange={(e) => set({ client: e.target.value })} /></Field>
              <Field label={t.key}><input className="field" required maxLength={10} placeholder="DEMO" value={f.key} onChange={(e) => set({ key: e.target.value.toUpperCase() })} /></Field>
              <Field label={t.name}><input className="field" value={f.name} placeholder={t.nameHint} onChange={(e) => set({ name: e.target.value })} /></Field>
            </div>
            {f.mode === "new" && (
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.gitInit} onChange={(e) => set({ gitInit: e.target.checked })} /> {t.gitInit}</label>
            )}
            <div><Button type="submit" variant="outline" disabled={busy}>{t.review}</Button></div>
          </form>
          {err && <p className="text-sm text-destructive">{err}</p>}
          {plan && (
            <div className="grid gap-2">
              <h3 className="text-sm font-semibold">{t.plan}</h3>
              {plan.rejected.length > 0 && (
                <div className="reject" role="alert">{plan.rejected.map((r) => <p key={r}>{r}</p>)}</div>
              )}
              {plan.warnings.map((w) => <p key={w} className="warn-box">{w}</p>)}
              {plan.steps.length > 0 && <ul className="list-disc pl-5 text-sm">{plan.steps.map((s) => <li key={s}>{s}</li>)}</ul>}
              <ul className="writes grid gap-1.5">
                {plan.writes.map((w) => (
                  <li key={w.file}>
                    <span className={`act act-${w.action}`}>{t.actions[w.action]}</span> <code className="text-xs">{w.file}</code>
                    {w.action === "update" && (
                      <details><summary className="cursor-pointer text-sm">{t.diff}</summary>
                        <div className="diff"><b>{t.before}</b><pre>{w.before}</pre><b>{t.after}</b><pre>{w.after}</pre></div>
                      </details>
                    )}
                    {w.action === "append" && <pre className="lines">{w.lines.join("\n")}</pre>}
                    {w.action === "append-row" && <pre className="lines">{JSON.stringify(w.row)}</pre>}
                    {w.action === "create" && w.file.endsWith("project.json") && <pre className="lines">{w.after}</pre>}
                  </li>
                ))}
              </ul>
              {stale && <p className="warn-box">{t.stale}</p>}
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={back}><ArrowLeft className="size-4" /> {t.back}</Button>
          <span className="flex items-center gap-2">
            <Button variant="outline" onClick={onCancel}>{T.cancel}</Button>
            {plan && <Button disabled={busy || stale || plan.rejected.length > 0} onClick={approve}>{t.approve}</Button>}
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
