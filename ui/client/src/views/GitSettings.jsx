// Settings > Git (PRD AIOS-61 v2.1 S10, S11; AC 19, 21): commit identity, credential helper and gh status, the push
// switch (off by default), and a connection test against a workspace remote. No token or password is asked for here.
import { useEffect, useRef, useState } from "react";
import { Copy, ExternalLink, GitBranch, Link2, LoaderCircle } from "lucide-react";
import { api } from "../api.js";
import { T } from "../texts.js";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FIELD_FULL, copyText } from "@/components/field";
import { SelectField, SettingRow, SettingsSection } from "@/components/settings-layout";

const S = () => T.views.git;

// Connect GitHub (device flow through gh): shows the one-time code and the github.com link, waits for the sign-in.
// Used by Settings > Git and the Worktrees screen.
export function GithubConnectDialog({ onClose, onDone }) {
  const s = S();
  const [st, setSt] = useState({ state: "starting" });
  const [copied, setCopied] = useState(false);
  const done = useRef(false);
  useEffect(() => {
    let live = true;
    api.githubConnect().then((r) => live && setSt(r)).catch((e) => live && setSt({ state: "failed", message: e.message }));
    const id = setInterval(() => {
      api.githubState().then((r) => {
        if (!live) return;
        if (r.state !== "idle") setSt(r);
        if (r.state === "done" && !done.current) { done.current = true; onDone?.(); }
      }).catch(() => {});
    }, 2000);
    return () => { live = false; clearInterval(id); if (!done.current) api.githubCancel().catch(() => {}); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>{s.connectTitle}</DialogTitle><DialogDescription>{s.connectIntro}</DialogDescription></DialogHeader>
        <DialogBody className="grid gap-3">
          {st.state === "starting" && <p className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" /> {s.connectStarting}</p>}
          {st.state === "waiting" && (
            <>
              <ol className="grid list-decimal gap-1 pl-5 text-sm text-muted-foreground"><li>{s.step1}</li><li>{s.step2}</li><li>{s.step3}</li></ol>
              <div className="flex items-center justify-center gap-2 rounded-md border bg-card py-3">
                <span className="font-mono text-2xl font-bold tracking-widest">{st.code}</span>
                <Button size="icon-sm" variant="ghost" aria-label={s.copyCode} title={s.copyCode} onClick={async () => { if (await copyText(st.code)) { setCopied(true); setTimeout(() => setCopied(false), 1500); } }}><Copy className="size-4" /></Button>
              </div>
              {copied && <p className="text-center text-xs text-positive">{s.copied}</p>}
              <Button onClick={() => window.open(st.url, "_blank", "noopener")}><ExternalLink className="size-4" /> {s.openGithub}</Button>
              <p className="flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircle className="size-3 animate-spin" /> {s.waiting}</p>
            </>
          )}
          {st.state === "done" && <p className="text-sm text-positive">{s.connected}</p>}
          {st.state === "failed" && <p role="alert" className="text-sm text-destructive">{s.connectFailed} {st.message}</p>}
        </DialogBody>
        <DialogFooter><Button variant={st.state === "done" ? "default" : "ghost"} onClick={onClose}>{st.state === "done" ? s.close : s.cancel}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function GitSettings() {
  const s = S();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [edit, setEdit] = useState(null); // { name, email }
  const [busy, setBusy] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [projects, setProjects] = useState([]);
  const [ws, setWs] = useState("");
  const [test, setTest] = useState(null);
  const [connect, setConnect] = useState(false);
  const [disconnect, setDisconnect] = useState(false);
  const reload = () => api.gitSettings().then(setData).catch((e) => setError(e.message));
  useEffect(() => {
    api.gitSettings().then(setData).catch((e) => setError(e.message));
    api.projects().then((r) => { setProjects(r.projects); setWs((cur) => cur || r.projects[0]?.key || ""); }).catch(() => {});
  }, []);
  const save = async (body) => {
    setBusy("save"); setError("");
    try { setData(await api.setGitSettings(body)); setEdit(null); setConfirm(false); } catch (e) { setError(e.message); } finally { setBusy(""); }
  };
  const runTest = async () => {
    setBusy("test"); setTest(null);
    try { setTest(await api.gitTest(ws)); } catch (e) { setTest({ ok: false, message: e.message }); } finally { setBusy(""); }
  };
  if (!data) return <SettingsSection icon={GitBranch} id="set-git" title={s.title} intro={s.intro}>{error ? <p className="px-5 py-3 text-xs text-destructive">{error}</p> : <LoaderCircle className="m-5 size-4 animate-spin" />}</SettingsSection>;
  const gh = data.gh;
  return (
    <SettingsSection icon={GitBranch} id="set-git" title={s.title} intro={s.intro}>
      <SettingRow title={s.identity} desc={s.identityDesc}>
        <span className="flex items-center gap-2">
          <span className="font-mono text-xs">{data.name || "?"} &lt;{data.email || "?"}&gt;</span>
          <Button size="sm" variant="outline" onClick={() => { setError(""); setEdit({ name: data.name, email: data.email }); }}>{s.edit}</Button>
        </span>
      </SettingRow>
      <SettingRow title={s.helper} desc={`${s.version} ${data.version}`}>
        <span className="font-mono text-xs">{data.credentialHelper ?? s.noHelper}</span>
      </SettingRow>
      <SettingRow title={s.github} desc={!gh.installed ? s.ghInstall : gh.loggedIn ? s.ghIn(gh.account) : s.ghOut}>
        {!gh.installed ? <Button size="sm" variant="outline" onClick={() => window.open("https://cli.github.com", "_blank", "noopener")}><ExternalLink className="size-4" /> cli.github.com</Button>
          : gh.loggedIn ? <Button size="sm" variant="outline" onClick={() => setDisconnect(true)}>{s.disconnect}</Button>
          : <Button size="sm" onClick={() => setConnect(true)}><Link2 className="size-4" /> {s.connect}</Button>}
      </SettingRow>
      {connect && <GithubConnectDialog onClose={() => { setConnect(false); reload(); }} onDone={reload} />}
      {disconnect && (
        <Dialog open onOpenChange={(o) => !o && setDisconnect(false)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader><DialogTitle>{s.disconnectTitle}</DialogTitle><DialogDescription>{s.disconnectIntro}</DialogDescription></DialogHeader>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setDisconnect(false)}>{s.cancel}</Button>
              <Button variant="destructive" disabled={busy === "gh"} onClick={async () => { setBusy("gh"); try { setData(await api.githubDisconnect()); } catch (e) { setError(e.message); } finally { setBusy(""); setDisconnect(false); } }}>{s.disconnect}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      <SettingRow title={s.push} desc={data.allowPush ? s.pushOnDesc : s.pushOffDesc}>
        {data.allowPush
          ? <Button size="sm" variant="outline" disabled={!!busy} onClick={() => save({ allowPush: false })}>{s.turnOff}</Button>
          : <Button size="sm" variant="outline" disabled={!!busy} onClick={() => setConfirm(true)}>{s.turnOn}</Button>}
      </SettingRow>
      <SettingRow title={s.test} desc={test ? (test.ok ? s.okLine(test.url ?? test.remote, test.heads) : test.message) : s.testDesc}>
        <span className="flex items-center gap-2">
          <SelectField size="sm" label={s.workspace} value={ws} onChange={(v) => { setWs(v); setTest(null); }} options={projects.map((p) => ({ value: p.key, label: p.key, hint: p.name }))} />
          <Button size="sm" variant="outline" disabled={!ws || busy === "test"} onClick={runTest}>{busy === "test" && <LoaderCircle className="size-4 animate-spin" />} {s.testRun}</Button>
        </span>
      </SettingRow>
      {error && <p className="px-5 py-2 text-xs text-destructive">{error}</p>}
      {edit && (
        <Dialog open onOpenChange={(o) => !o && setEdit(null)}>
          <DialogContent className="sm:max-w-md">
            <form onSubmit={(e) => { e.preventDefault(); save(edit); }} className="flex min-h-0 flex-1 flex-col">
              <DialogHeader><DialogTitle>{s.identity}</DialogTitle><DialogDescription>{s.identityDesc}</DialogDescription></DialogHeader>
              <DialogBody className="grid gap-3">
                <Field label={s.name}><input className={FIELD_FULL} autoFocus required value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
                <Field label={s.email}><input className={FIELD_FULL} type="email" required value={edit.email} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></Field>
                {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
              </DialogBody>
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setEdit(null)}>{s.cancel}</Button>
                <Button type="submit" disabled={busy === "save"}>{busy === "save" && <LoaderCircle className="size-4 animate-spin" />} {s.save}</Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}
      {confirm && (
        <Dialog open onOpenChange={(o) => !o && setConfirm(false)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader><DialogTitle>{s.warnTitle}</DialogTitle><DialogDescription>{s.warnIntro}</DialogDescription></DialogHeader>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setConfirm(false)}>{s.cancel}</Button>
              <Button disabled={busy === "save"} onClick={() => save({ allowPush: true })}>{s.turnOn}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </SettingsSection>
  );
}
