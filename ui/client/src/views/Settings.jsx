// Settings: Model (main model, providers), Microphone, Terminal, Git and Account. Provider and model flow:
// a catalog of providers (pick, paste key), the live model list from the provider, and one "main model" row.
import { useCallback, useEffect, useMemo, useState } from "react";
import { BrainCircuit, Check, ExternalLink, KeyRound, LoaderCircle, Pencil, Plus, RefreshCw, Search, Server, Star, Trash2, Zap } from "lucide-react";
import { api } from "../api.js";
import { T } from "../texts.js";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FIELD_FULL, PageHeader } from "@/components/field";
import { SelectField, SettingRow, SettingsSection } from "@/components/settings-layout";
import { kfmt, labelOf, ModelPicker, price } from "@/components/model-picker";
import MicSettings from "./MicSettings.jsx";
import { AccountSettings, TerminalSettings } from "./AccountSettings.jsx";
import GitSettings from "./GitSettings.jsx";
import SuggestSettings from "./SuggestSettings.jsx";

const S = () => T.views.settings;
const CLI_MODELS = ["sonnet", "opus", "haiku", "fable"];
const CODEX_MODELS = ["gpt-5.1-codex", "gpt-5.1", "gpt-5.1-codex-mini"];
const isCliTransport = (t) => t === "claude_cli" || t === "codex_cli";
const host = (u) => { try { return new URL(u).host; } catch { return u ?? ""; } };
const day = (iso) => (iso ? new Date(iso).toLocaleDateString("id-ID", { day: "numeric", month: "short" }) : "");

export default function SettingsView({ onChanged }) {
  return (
    <div className="grid max-w-4xl gap-6">
      <PageHeader title={S().title} intro={S().intro} />
      <ModelSettings onChanged={onChanged} />
      <MicSettings />
      <SuggestSettings />
      <TerminalSettings onChanged={onChanged} />
      <GitSettings />
      <AccountSettings />
    </div>
  );
}

function ModelSettings({ onChanged }) {
  const s = S();
  const [data, setData] = useState(null);
  const [options, setOptions] = useState(null);
  const [catalog, setCatalog] = useState([]);
  const [picker, setPicker] = useState(false);
  const [dialog, setDialog] = useState(null); // { initial } (null initial = add)
  const [results, setResults] = useState({});
  const [busy, setBusy] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const d = await api.providers();
      setData(d);
      if (d.managed) {
        setOptions(await api.models());
        api.providerCatalog().then((r) => setCatalog(r.catalog ?? [])).catch(() => {});
      }
    } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const act = async (name, fn) => {
    setBusy(name); setError("");
    try { const r = await fn(); await load(); onChanged?.(); return r; } catch (e) { setError(e.message); return null; } finally { setBusy(""); }
  };
  const test = async (id) => { const r = await act(`test-${id}`, () => api.testProvider(id)); if (r) setResults((x) => ({ ...x, [id]: r })); };

  if (!data) return error ? <p className="text-sm text-destructive">{error}</p> : <LoaderCircle className="size-4 animate-spin" />;
  if (!data.managed) return <SettingsSection icon={BrainCircuit} id="set-model" title={s.modelTitle} intro={s.unmanaged} />;

  const cur = options?.current;
  const rowOf = (id) => options?.providers.find((p) => p.id === id);

  return (
    <>
      <SettingsSection icon={BrainCircuit} id="set-model" title={s.modelTitle} intro={s.modelIntro}>
        <SettingRow title={s.main} desc={s.mainDesc}>
          <span className="flex min-w-0 items-center gap-1.5 rounded-full border border-border-strong bg-card/70 px-3 py-1.5 font-mono text-xs" title={cur?.model || ""}>
            <Star className="size-3 shrink-0 fill-primary text-primary" />
            <span className="truncate">{cur?.provider ? `${labelOf(options, cur.provider)} · ${cur.model || T.views.models.cliDefault}` : s.unset}</span>
          </span>
          <Button size="sm" onClick={() => setPicker(true)} disabled={!options?.providers.length}>{s.change}</Button>
        </SettingRow>
        {!cur?.provider && data.providers.length > 0 && <p className="px-5 py-2 text-xs text-warning">{s.choosePrimary}</p>}
        <div className="grid gap-2 px-4 py-3 sm:px-5">
          <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{s.howTitle}</span>
          <ol className="grid gap-1.5 sm:grid-cols-3 sm:gap-3">
            {s.how.map((t, i) => (
              <li key={i} className="flex gap-2 rounded-xl border bg-card/60 p-2.5 text-xs leading-relaxed">
                <span className="grid size-5 shrink-0 place-items-center rounded-full bg-primary/15 font-mono text-[11px] font-bold text-primary">{i + 1}</span>
                <span className="text-muted-foreground">{t}</span>
              </li>
            ))}
          </ol>
        </div>
      </SettingsSection>

      <SettingsSection icon={Server} id="set-providers" title={s.providersTitle} intro={s.providersIntro}
        action={<Button size="sm" onClick={() => setDialog({ initial: null })}><Plus className="size-3.5" /> {s.add}</Button>}>
        {error && <p className="px-5 py-2 text-sm text-destructive">{error}</p>}
        {data.providers.length === 0 && <p className="px-5 py-4 text-sm text-muted-foreground">{s.none}</p>}
        {data.providers.map((p) => {
          const o = rowOf(p.id);
          const cli = isCliTransport(p.transport);
          const r = results[p.id];
          return (
            <div key={p.id} className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-6 sm:px-5">
              <div className="flex min-w-0 items-center gap-3">
                <span className={cn("grid size-9 shrink-0 place-items-center rounded-full font-heading text-sm font-bold", cli ? "bg-primary/15 text-primary" : "bg-muted text-foreground")}>
                  {cli ? <Zap className="size-4" /> : p.id.slice(0, 2).toUpperCase()}
                </span>
                <div className="grid min-w-0 gap-1">
                  <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <b className="truncate text-sm">{o?.label ?? p.id}</b>
                    {cur?.provider === p.id && <Badge className="gap-1"><Star className="size-3 fill-current" />{T.views.models.main}</Badge>}
                    <Badge variant="outline">{p.transport === "codex_cli" ? s.codex : cli ? s.cli : s.api}</Badge>
                    {!cli && (p.key_env
                      ? <Badge variant="outline" className={p.hasKey ? "text-positive" : "text-warning"}><KeyRound className="size-3" />{p.hasKey ? s.keyOk : s.noKey}</Badge>
                      : <Badge variant="outline">{s.local}</Badge>)}
                  </span>
                  <span className="truncate font-mono text-[11px] text-muted-foreground">
                    {cli ? (p.model || T.views.models.cliDefault) : [host(p.base_url), `${o?.models.length ?? 0} ${s.models}`, o?.fetchedAt ? `${s.fetched} ${day(o.fetchedAt)}` : null].filter(Boolean).join(" · ")}
                  </span>
                  {r && <span className={cn("text-xs", r.ok ? "text-positive" : "text-destructive")}>{r.ok ? `${s.testOk}: ${r.text}` : r.error}</span>}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1 sm:justify-end">
                {!cli && <Button size="icon-sm" variant="ghost" title={s.refresh} aria-label={`${s.refresh} ${p.id}`} disabled={!!busy} onClick={() => act(`models-${p.id}`, () => api.refreshProviderModels(p.id))}>{busy === `models-${p.id}` ? <LoaderCircle className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}</Button>}
                <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => test(p.id)}>{busy === `test-${p.id}` ? <LoaderCircle className="size-3.5 animate-spin" /> : s.test}</Button>
                <Button size="icon-sm" variant="ghost" title={s.edit} aria-label={`${s.edit} ${p.id}`} disabled={!!busy} onClick={() => setDialog({ initial: p })}><Pencil className="size-3.5" /></Button>
                {confirmRemove === p.id
                  ? <Button size="sm" variant="destructive" title={s.removeConfirm} disabled={!!busy} onClick={() => { setConfirmRemove(null); act("remove", () => api.removeProvider(p.id)); }}>{s.remove}?</Button>
                  : <Button size="icon-sm" variant="ghost" title={s.remove} aria-label={`${s.remove} ${p.id}`} disabled={!!busy} onClick={() => setConfirmRemove(p.id)}><Trash2 className="size-3.5" /></Button>}
              </div>
            </div>
          );
        })}
      </SettingsSection>

      <ModelPicker open={picker} onClose={() => setPicker(false)} options={options} mode="main"
        onApply={async ({ provider, model }) => { await api.setMainModel(provider, model); await load(); onChanged?.(); }}
        onRefresh={async (id) => { await api.refreshProviderModels(id); setOptions(await api.models()); }} />
      <ProviderDialog open={!!dialog} initial={dialog?.initial ?? null} taken={data.providers.map((p) => p.id)} catalog={catalog}
        onClose={() => setDialog(null)} onSaved={async () => { setDialog(null); await load(); onChanged?.(); }} />
    </>
  );
}

const blank = { id: "", transport: "chat_completions", base_url: "", key_env: "", apiKey: "", model: "", models: "", price_in: "", price_out: "", context_window: "", label: "", keys_url: "", note: "", hasKey: false };

function ProviderDialog({ open, initial, taken, catalog, onClose, onSaved }) {
  const s = S();
  const [step, setStep] = useState("pick");
  const [f, setF] = useState(blank);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState(null); // models from the probe
  const [mq, setMq] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const set = (patch) => setF((x) => ({ ...x, ...patch }));

  useEffect(() => {
    if (!open) return;
    setError(""); setQuery(""); setMq(""); setFound(null); setBusy("");
    if (initial) {
      const extra = (initial.models ?? []).filter((m) => m !== initial.model).join(", ");
      const c = catalog.find((x) => x.base_url === initial.base_url);
      setF({ ...blank, id: initial.id, transport: initial.transport, base_url: initial.base_url ?? "", key_env: initial.key_env ?? "", model: initial.model ?? "", models: extra,
        price_in: initial.price_in ?? "", price_out: initial.price_out ?? "", context_window: initial.context_window ?? "", label: c?.label ?? initial.id, keys_url: c?.keys_url ?? "", note: c?.note ?? "", hasKey: !!initial.hasKey });
      setStep("form");
    } else { setF(blank); setStep("pick"); }
  }, [open, initial, catalog]);

  const freeId = (id) => { let n = id; let i = 2; while (taken.includes(n)) n = `${id}-${i++}`; return n; };
  const choose = (c) => {
    if (c === "codex") setF({ ...blank, id: freeId("codex"), transport: "codex_cli", label: s.codex });
    else if (c === "cli") setF({ ...blank, id: freeId("claude"), transport: "claude_cli", label: s.cli });
    else if (c === "custom") setF({ ...blank, id: freeId("custom"), label: s.custom });
    else setF({ ...blank, id: freeId(c.id), base_url: c.base_url, key_env: c.key_env, label: c.label, keys_url: c.keys_url ?? "", note: c.note ?? "", hasKey: !!c.hasKey });
    setStep("form");
  };
  const list = useMemo(() => catalog.filter((c) => !query.trim() || `${c.label} ${c.id} ${c.base_url}`.toLowerCase().includes(query.trim().toLowerCase())), [catalog, query]);
  const isApi = f.transport === "chat_completions";
  const shownModels = (found ?? []).filter((m) => !mq.trim() || `${m.id} ${m.name ?? ""}`.toLowerCase().includes(mq.trim().toLowerCase())).slice(0, 300);

  const probe = async () => {
    setBusy("probe"); setError("");
    try {
      const r = await api.probeProvider({ base_url: f.base_url, key_env: f.key_env || undefined, apiKey: f.apiKey || undefined });
      setFound(r.models);
      if (!f.model && r.models[0]) set({ model: r.models[0].id });
    } catch (e) { setError(e.message); } finally { setBusy(""); }
  };
  const save = async () => {
    setBusy("save"); setError("");
    try {
      const body = { transport: f.transport, model: f.model.trim() };
      const keyEnv = f.key_env.trim() || (f.apiKey.trim() ? `${f.id.trim().toUpperCase().replace(/-/g, "_")}_API_KEY` : "");
      if (isApi) Object.assign(body, { base_url: f.base_url.trim(), key_env: keyEnv || undefined, apiKey: f.apiKey.trim() || undefined, models: f.models, price_in: f.price_in, price_out: f.price_out, context_window: f.context_window });
      await api.saveProvider(f.id.trim(), body);
      // Cache the list now so the pickers show it at once (the probe result is not stored).
      if (isApi && found) await api.refreshProviderModels(f.id.trim()).catch(() => {});
      await onSaved();
    } catch (e) { setError(e.message); } finally { setBusy(""); }
  };
  const canSave = f.id.trim() && (!isApi || (f.base_url.trim() && f.model.trim()));

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader className="border-b px-6 pt-5 pb-3 text-left">
          <DialogTitle>{initial ? s.editTitle : step === "pick" ? s.pickTitle : `${s.addTitle}: ${f.label}`}</DialogTitle>
          <DialogDescription>{step === "pick" ? s.pickIntro : f.note || (isApi ? host(f.base_url) : f.transport === "codex_cli" ? s.codexNote : s.cliNote)}</DialogDescription>
        </DialogHeader>

        {step === "pick" ? (
          <DialogBody className="space-y-3">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input autoFocus className={cn(FIELD_FULL, "pl-8")} placeholder={s.searchProviders} value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {!query && <PickCard title="Claude Code" hint={s.cliHint} icon={Zap} onClick={() => choose("cli")} />}
              {!query && <PickCard title="Codex (ChatGPT)" hint={s.codexHint} icon={Zap} onClick={() => choose("codex")} />}
              {list.map((c) => <PickCard key={c.id} title={c.label} hint={c.local ? c.note : host(c.base_url)} badge={c.hasKey ? s.keySaved : null} onClick={() => choose(c)} />)}
              <PickCard title={s.custom} hint={s.customHint} icon={Plus} onClick={() => choose("custom")} />
            </div>
          </DialogBody>
        ) : (
          <DialogBody className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={s.name} hint={s.nameHint}><input className={FIELD_FULL} value={f.id} disabled={!!initial} onChange={(e) => set({ id: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "") })} /></Field>
              {isApi ? (
                <Field label={s.apiKey} hint={f.key_env ? (f.hasKey ? `${s.keySaved} (${f.key_env}). ${s.apiKeyHint}` : s.apiKeyHint) : s.apiKeyOptional}>
                  <div className="flex gap-2">
                    <input className={FIELD_FULL} type="password" autoComplete="off" placeholder={f.hasKey ? "••••••••" : ""} value={f.apiKey} onChange={(e) => set({ apiKey: e.target.value })} />
                    {f.keys_url && <Button asChild variant="outline" size="sm" className="h-9 shrink-0"><a href={f.keys_url} target="_blank" rel="noreferrer noopener">{s.getKey} <ExternalLink className="size-3" /></a></Button>}
                  </div>
                </Field>
              ) : (
                <Field label={s.cliModel} hint={f.transport === "codex_cli" ? s.codexModelHint : s.cliModelHint}>
                  <SelectField label={s.cliModel} value={f.model || "_default"} onChange={(v) => set({ model: v === "_default" ? "" : v })}
                    options={[{ value: "_default", label: T.views.models.cliDefault }, ...(f.transport === "codex_cli" ? CODEX_MODELS : CLI_MODELS).map((m) => ({ value: m, label: m }))]} className="w-full" />
                </Field>
              )}
            </div>

            {isApi && (
              <div className="grid gap-2 rounded-xl border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="grid gap-0.5">
                    <span className="text-sm font-medium">{s.pickDefault}</span>
                    <span className="text-xs text-muted-foreground">{found ? `${found.length} ${s.modelsFound}` : s.pickDefaultHint}</span>
                  </div>
                  <Button size="sm" variant={found ? "outline" : "default"} disabled={!f.base_url || !!busy} onClick={probe}>
                    {busy === "probe" ? <><LoaderCircle className="size-3.5 animate-spin" /> {s.loading}</> : <><RefreshCw className="size-3.5" /> {s.loadModels}</>}
                  </Button>
                </div>
                {found && (
                  <>
                    <input className={FIELD_FULL} placeholder={s.searchModels} value={mq} onChange={(e) => setMq(e.target.value)} />
                    <ul className="max-h-56 overflow-y-auto rounded-lg border p-1" role="listbox" aria-label={s.pickDefault}>
                      {shownModels.map((m) => (
                        <li key={m.id}>
                          <button type="button" role="option" aria-selected={f.model === m.id} onClick={() => set({ model: m.id })}
                            className={cn("flex w-full items-center gap-3 rounded-md px-2 py-1 text-left", f.model === m.id ? "bg-primary/15" : "hover:bg-muted/60")}>
                            <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{m.id}</span>
                            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{[kfmt(m.context) && `${kfmt(m.context)} ctx`, price(m)].filter(Boolean).join(" · ")}</span>
                            {f.model === m.id ? <Check className="size-3.5 shrink-0 text-primary" /> : <span className="size-3.5 shrink-0" />}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                <input className={cn(FIELD_FULL, "font-mono")} placeholder={s.typeModel} value={f.model} onChange={(e) => set({ model: e.target.value.trim() })} />
              </div>
            )}

            {isApi && (
              <details className="rounded-xl border px-3 py-2">
                <summary className="cursor-pointer text-sm font-medium">{s.advanced}</summary>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <Field label={s.baseUrl}><input className={FIELD_FULL} type="url" value={f.base_url} onChange={(e) => set({ base_url: e.target.value })} /></Field>
                  <Field label={s.keyEnv} hint={s.keyEnvHint}><input className={FIELD_FULL} value={f.key_env} onChange={(e) => set({ key_env: e.target.value.toUpperCase() })} /></Field>
                  <Field label={s.extraModels} hint={s.extraModelsHint}><input className={FIELD_FULL} value={f.models} onChange={(e) => set({ models: e.target.value })} /></Field>
                  <Field label={s.contextWindow} hint={s.contextWindowHint}><input className={FIELD_FULL} type="number" min="0" value={f.context_window} onChange={(e) => set({ context_window: e.target.value })} /></Field>
                  <Field label={s.priceIn} hint={s.priceHint}><input className={FIELD_FULL} type="number" min="0" step="any" value={f.price_in} onChange={(e) => set({ price_in: e.target.value })} /></Field>
                  <Field label={s.priceOut}><input className={FIELD_FULL} type="number" min="0" step="any" value={f.price_out} onChange={(e) => set({ price_out: e.target.value })} /></Field>
                </div>
              </details>
            )}
            {isApi && !f.model && <p className="text-xs text-muted-foreground">{s.needModel}</p>}
            {error && <p className="text-sm text-destructive">{error}</p>}
          </DialogBody>
        )}

        <DialogFooter>
          {step === "form" && !initial ? <Button variant="ghost" onClick={() => setStep("pick")} disabled={!!busy}>{s.back}</Button> : <span />}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose} disabled={!!busy}>{s.cancel}</Button>
            {step === "form" && <Button onClick={save} disabled={!canSave || !!busy}>{busy === "save" ? s.saving : s.save}</Button>}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PickCard({ title, hint, badge, icon: Icon, onClick }) {
  return (
    <button type="button" onClick={onClick} className="grid gap-0.5 rounded-xl border bg-card/60 px-3 py-2.5 text-left transition-colors hover:border-primary/60 hover:bg-accent/50">
      <span className="flex items-center gap-1.5 text-sm font-medium">{Icon && <Icon className="size-3.5 text-primary" />}<span className="truncate">{title}</span>{badge && <Badge variant="outline" className="ml-auto h-4 px-1 text-[10px] text-positive">{badge}</Badge>}</span>
      <span className="truncate text-[11px] text-muted-foreground">{hint}</span>
    </button>
  );
}
