// Settings > Account and Terminal (PRD AIOS-61 v2.0 S1, S6, S10): one account, change its password, sign out; switch
// Agent Terminals on (with a warning) or off. The server writes the switch to data/config.json and the audit log.
import { useEffect, useState } from "react";
import { LoaderCircle, LogOut, ShieldCheck, SquareTerminal } from "lucide-react";
import { api } from "../api.js";
import { T } from "../texts.js";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FIELD_FULL } from "@/components/field";
import { SettingRow, SettingsSection } from "@/components/settings-layout";

const S = () => T.views.account;

export function AccountSettings() {
  const s = S();
  const [general, setGeneral] = useState(null);
  const [changing, setChanging] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => { api.general().then(setGeneral).catch(() => {}); }, []);
  const signOut = async () => { try { await api.logout(); } finally { location.reload(); } };
  return (
    <SettingsSection icon={ShieldCheck} id="set-account" title={s.title} intro={s.intro}>
      <SettingRow title={s.user} desc={general ? s.where(general.host, general.port) : ""}>
        <span className="font-mono text-xs">{general?.user ?? "administrator"}</span>
      </SettingRow>
      <SettingRow title={s.password} desc={done ? s.changed : s.passwordDesc}>
        <Button size="sm" variant="outline" onClick={() => setChanging(true)}>{s.change}</Button>
      </SettingRow>
      <SettingRow title={s.signOut} desc={s.signOutDesc}>
        <Button size="sm" variant="outline" onClick={signOut}><LogOut className="size-4" /> {s.signOut}</Button>
      </SettingRow>
      {changing && <PasswordDialog onClose={() => setChanging(false)} onDone={() => { setChanging(false); setDone(true); }} />}
    </SettingsSection>
  );
}

function PasswordDialog({ onClose, onDone }) {
  const s = S();
  const [f, setF] = useState({ current: "", next: "", again: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const submit = async (e) => {
    e.preventDefault();
    setError("");
    if (f.next !== f.again) { setError(s.differ); return; }
    setBusy(true);
    try { await api.changePassword(f.current, f.next); onDone(); } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>{s.changeTitle}</DialogTitle>
            <DialogDescription>{s.changeIntro}</DialogDescription>
          </DialogHeader>
          <DialogBody className="grid gap-3">
            <Field label={s.current}><input className={FIELD_FULL} type="password" autoComplete="current-password" required autoFocus value={f.current} onChange={set("current")} /></Field>
            <Field label={s.next} hint={s.minHint}><input className={FIELD_FULL} type="password" autoComplete="new-password" required minLength={8} value={f.next} onChange={set("next")} /></Field>
            <Field label={s.again}><input className={FIELD_FULL} type="password" autoComplete="new-password" required minLength={8} value={f.again} onChange={set("again")} /></Field>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>{s.cancel}</Button>
            <Button type="submit" disabled={busy}>{busy && <LoaderCircle className="size-4 animate-spin" />} {s.save}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function TerminalSettings({ onChanged }) {
  const s = S();
  const [on, setOn] = useState(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { api.general().then((g) => setOn(g.terminal)).catch((e) => setError(e.message)); }, []);
  const apply = async (value) => {
    setBusy(true); setError("");
    try { const g = await api.setGeneral({ terminal: value }); setOn(g.terminal); onChanged?.(); } catch (e) { setError(e.message); } finally { setBusy(false); setConfirm(false); }
  };
  return (
    <SettingsSection icon={SquareTerminal} id="set-terminal" title={s.terminalTitle} intro={s.terminalIntro}>
      <SettingRow title={on ? s.terminalOn : s.terminalOff} desc={on ? s.terminalOnDesc : s.terminalOffDesc}>
        {on === null ? <LoaderCircle className="size-4 animate-spin" />
          : on ? <Button size="sm" variant="outline" disabled={busy} onClick={() => apply(false)}>{s.turnOff}</Button>
          : <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirm(true)}>{s.turnOn}</Button>}
      </SettingRow>
      {error && <p className="px-5 py-2 text-xs text-destructive">{error}</p>}
      {confirm && (
        <Dialog open onOpenChange={(o) => !o && setConfirm(false)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{s.warnTitle}</DialogTitle>
              <DialogDescription>{s.warnIntro}</DialogDescription>
            </DialogHeader>
            <DialogBody>
              <ul className="grid list-disc gap-1.5 pl-5 text-sm text-muted-foreground">{s.warn.map((w) => <li key={w}>{w}</li>)}</ul>
            </DialogBody>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setConfirm(false)}>{s.cancel}</Button>
              <Button variant="destructive" disabled={busy} onClick={() => apply(true)}>{busy && <LoaderCircle className="size-4 animate-spin" />} {s.turnOn}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </SettingsSection>
  );
}
