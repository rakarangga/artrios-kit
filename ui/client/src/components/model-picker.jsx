// Two-stage model picker,:
//   left: providers (model count, key state, current), right: models of the picked provider; one search box filters both.
// "main" mode sets the main model (Settings); "session" mode switches this chat and can also make it the main model.
import { useEffect, useMemo, useState } from "react";
import { Check, CircleAlert, LoaderCircle, RefreshCw, Search, Star } from "lucide-react";
import { T } from "../texts.js";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const S = () => T.views.models;
export const kfmt = (n) => (n == null ? null : n >= 1e6 ? `${(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M` : `${Math.round(n / 1e3)}k`);
export const price = (m) => (m.priceIn == null && m.priceOut == null ? null : `$${fmt(m.priceIn)} / $${fmt(m.priceOut)}`);
const fmt = (n) => (n == null ? "-" : n === 0 ? "0" : n < 0.01 ? n.toFixed(4) : n < 1 ? n.toFixed(2) : n.toFixed(2).replace(/\.00$/, ""));
const words = (q) => q.toLowerCase().split(/\s+/).filter(Boolean);
const hits = (text, q) => words(q).every((w) => text.toLowerCase().includes(w));
export const labelOf = (options, provider) => options?.providers?.find((p) => p.id === provider)?.label ?? provider ?? "";

export function ModelPicker({ open, onClose, options, current, mode = "session", onApply, onRefresh, title }) {
  const s = S();
  const providers = options?.providers ?? [];
  const cur = current ?? options?.current ?? { provider: null, model: "" };
  const [query, setQuery] = useState("");
  const [slug, setSlug] = useState("");
  const [model, setModel] = useState(null);
  const [persist, setPersist] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setQuery(""); setError(""); setPersist(false); setModel(null);
    const first = providers.find((p) => p.id === cur.provider) ?? providers.find((p) => p.ready && p.models.length) ?? providers[0];
    setSlug(first?.id ?? "");
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const q = query.trim();
  // Providers that match by name or by one of their models; with no query, ready providers with models first.
  const shown = useMemo(() => {
    const list = providers.filter((p) => !q || hits(`${p.label} ${p.id} ${p.models.map((m) => m.id).join(" ")}`, q));
    return q ? list : [...list.filter((p) => p.ready && p.models.length), ...list.filter((p) => !(p.ready && p.models.length))];
  }, [providers, q]);
  const sel = providers.find((p) => p.id === slug) ?? null;
  // A query that only found the provider by its name keeps the whole model list (provider-only match).
  const providerOnly = sel && q && hits(`${sel.label} ${sel.id}`, q) && !sel.models.some((m) => hits(`${m.id} ${m.name ?? ""}`, q));
  const isCli = sel?.transport === "claude_cli" || sel?.transport === "codex_cli";
  const rows = useMemo(() => {
    if (!sel) return [];
    const base = isCli ? [{ id: "", name: s.cliDefault, note: s.cliDefaultHint }, ...sel.models] : sel.models;
    return !q || providerOnly ? base : base.filter((m) => hits(`${m.id} ${m.name ?? ""}`, q));
  }, [sel, q, providerOnly, isCli, s.cliDefault, s.cliDefaultHint]);
  const isCurrent = (p, m) => p === cur.provider && (m ?? "") === (cur.model ?? "");

  const apply = async (m = model) => {
    if (!sel || m === null || busy) return;
    setBusy("apply"); setError("");
    try { await onApply({ provider: sel.id, transport: sel.transport, model: m, persist: mode === "main" || persist }); onClose(); }
    catch (e) { setError(e.message); }
    finally { setBusy(""); }
  };
  const refresh = async () => {
    if (!sel || isCli || !onRefresh) return;
    setBusy("refresh"); setError("");
    try { await onRefresh(sel.id); } catch (e) { setError(e.message); } finally { setBusy(""); }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent className="flex max-h-[85vh] w-[min(56rem,calc(100vw-2rem))] max-w-none flex-col gap-0 p-0 sm:max-w-none">
        <DialogHeader className="border-b px-5 pt-5 pb-3 text-left">
          <DialogTitle>{title ?? (mode === "main" ? s.mainTitle : s.sessionTitle)}</DialogTitle>
          <DialogDescription className="font-mono text-xs">
            {s.current}: {cur.provider ? `${labelOf(options, cur.provider)} · ${cur.model || s.cliDefault}` : s.unset}
          </DialogDescription>
        </DialogHeader>
        <div className="border-b px-5 py-2.5">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") apply(); }}
              placeholder={s.search} className="h-9 w-full rounded-[10px] border border-border-strong bg-card/60 pr-3 pl-8 text-[13px] outline-none focus-visible:border-primary/70 focus-visible:ring-4 focus-visible:ring-primary/15" />
          </div>
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(9rem,13rem)_minmax(0,1fr)] overflow-hidden" style={{ height: "min(26rem, 60vh)" }}>
          <ul className="min-h-0 overflow-y-auto border-r p-1.5" aria-label={s.providers}>
            {shown.length === 0 && <li className="p-3 text-xs text-muted-foreground">{providers.length ? s.noMatch : s.noProviders}</li>}
            {shown.map((p) => (
              <li key={p.id}>
                <button type="button" onClick={() => { setSlug(p.id); setModel(null); }}
                  className={cn("grid w-full gap-0.5 rounded-lg px-2.5 py-2 text-left", p.id === slug ? "bg-accent text-accent-foreground" : "hover:bg-muted/60")}>
                  <span className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium">
                    <span className="truncate">{p.label}</span>
                    {p.id === options?.current?.provider && <Star className="size-3 shrink-0 fill-primary text-primary" aria-label={s.main} />}
                  </span>
                  <span className={cn("truncate text-[11px]", p.ready ? "text-muted-foreground" : "text-warning")}>
                    {!p.ready ? s.noKey : p.transport === "claude_cli" ? s.cliShort : p.transport === "codex_cli" ? s.codexShort : `${p.models.length} ${s.modelsCount}`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className="flex min-h-0 flex-col">
            {sel && !sel.ready && (
              <p className="m-3 flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-2.5 text-xs"><CircleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />{s.needKey}</p>
            )}
            {sel && sel.ready && !isCli && !sel.models.length && (
              <p className="m-3 rounded-lg border bg-muted/40 p-2.5 text-xs text-muted-foreground">{s.emptyList}</p>
            )}
            <ul className="min-h-0 flex-1 overflow-y-auto p-1.5" aria-label={s.models}>
              {sel?.ready && rows.length === 0 && q && <li className="p-3 text-xs text-muted-foreground">{s.noMatch}</li>}
              {sel?.ready && rows.map((m) => {
                const picked = model === m.id;
                const now = isCurrent(sel.id, m.id);
                return (
                  <li key={m.id || "_default"}>
                    <button type="button" onClick={() => setModel(m.id)} onDoubleClick={() => apply(m.id)}
                      className={cn("flex w-full items-center gap-3 rounded-lg px-2.5 py-1.5 text-left", picked ? "bg-primary/15 ring-1 ring-primary/50" : "hover:bg-muted/60")}>
                      <span className="grid min-w-0 flex-1 gap-0.5">
                        <span className={cn("truncate text-[13px]", m.id ? "font-mono" : "font-medium")}>{m.id || m.name}</span>
                        {(m.name && m.id) || m.note ? <span className="truncate text-[11px] text-muted-foreground">{m.id ? [m.name, m.note].filter(Boolean).join(" · ") : m.note}</span> : null}
                      </span>
                      <span className="hidden shrink-0 gap-3 font-mono text-[11px] text-muted-foreground sm:flex">
                        {kfmt(m.context) && <span title={s.contextTitle}>{kfmt(m.context)} ctx</span>}
                        {price(m) && <span title={s.priceTitle}>{price(m)}</span>}
                      </span>
                      {now ? <Check className="size-4 shrink-0 text-primary" aria-label={s.current} /> : <span className="size-4 shrink-0" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t px-5 py-3">
          {mode === "pick" ? <span /> : mode === "session" ? (
            <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
              <input type="checkbox" className="size-3.5 accent-(--primary)" checked={persist} onChange={(e) => setPersist(e.target.checked)} />
              {s.persist}
            </label>
          ) : <span className="text-xs text-muted-foreground">{s.mainNote}</span>}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {error && <span className="max-w-72 truncate text-xs text-destructive" title={error}>{error}</span>}
            {sel && !isCli && sel.ready && onRefresh && (
              <Button variant="outline" size="sm" onClick={refresh} disabled={!!busy}>
                {busy === "refresh" ? <LoaderCircle className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} {s.refresh}
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={onClose} disabled={!!busy}>{s.cancel}</Button>
            <Button size="sm" onClick={() => apply()} disabled={!sel?.ready || model === null || !!busy}>
              {busy === "apply" ? <LoaderCircle className="size-3.5 animate-spin" /> : mode === "main" ? s.setMain : s.switch}
            </Button>
          </div>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
