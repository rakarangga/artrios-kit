import { usePersisted } from "../lib/persist.js";
import { useCallback, useEffect, useMemo, useState } from "react";
import { LoaderCircle, Play, Sparkles, X } from "lucide-react";
import { api } from "../api.js";
import { subscribe } from "../socket.js";
import { playReceive, primeSound } from "../sound.js";
import { T } from "../texts.js";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/field";

const CAT_CLASS = {
  code: "text-info border-info/40", ui: "text-self border-self/40", docs: "text-muted-foreground", security: "text-destructive border-destructive/40", performance: "text-warning border-warning/40",
};

export default function Ideation({ project, onChanged }) {
  const S = T.views.ideation;
  const [data, setData] = useState({ ideas: [], running: false, categories: [] });
  const [tab, setTab] = usePersisted("ideation.tab", "all", (v) => typeof v === "string");
  const [showDismissed, setShowDismissed] = useState(false);
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(() => api.ideas(project).then(setData).catch((e) => setError(e.message)), [project]);
  useEffect(() => { setSelected(null); setError(""); load(); }, [project, load]);
  useEffect(() => subscribe((m) => { if (m.project === project && m.type === "ideation") load(); }), [project, load]);

  const generate = async () => {
    primeSound();
    setBusy(true); setError("");
    try { setData(await api.generateIdeas(project, tab === "all" ? {} : { category: tab })); playReceive(); } catch (e) { setError(e.message); }
    setBusy(false);
  };
  const dismiss = async (id, status) => { try { await api.setIdea(project, id, status); await load(); } catch (e) { setError(e.message); } };
  const convert = async (id) => {
    try { await api.convertIdea(project, id); await load(); onChanged?.(); } catch (e) { setError(e.message); }
  };

  const counts = useMemo(() => {
    const c = {};
    for (const i of data.ideas) if (i.status !== "dismissed") c[i.category] = (c[i.category] ?? 0) + 1;
    return c;
  }, [data.ideas]);
  const visible = data.ideas.filter((i) => (tab === "all" || i.category === tab) && (showDismissed || i.status !== "dismissed")).slice().reverse();
  const sel = data.ideas.find((i) => i.id === selected) ?? null;
  const working = busy || data.running;

  return (
    <div className="grid gap-4">
      <PageHeader title={`${S.title} · ${data.ideas.filter((i) => i.status !== "dismissed").length}`} intro={S.intro}>
        <label className="flex items-center gap-2 text-sm text-muted-foreground"><input type="checkbox" checked={showDismissed} onChange={(e) => setShowDismissed(e.target.checked)} /> {S.showDismissed}</label>
        <Button onClick={generate} disabled={working}>{working ? <LoaderCircle className="size-4 animate-spin" /> : <Sparkles className="size-4" />} {working ? S.generating : S.generate}</Button>
      </PageHeader>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap gap-1.5" role="tablist">
        {["all", ...(data.categories ?? [])].map((c) => (
          <Button key={c} role="tab" aria-selected={tab === c} size="sm" variant={tab === c ? "default" : "outline"} onClick={() => setTab(c)}>
            {c === "all" ? S.all : S.categories[c]}{c !== "all" && counts[c] ? <span className="font-mono text-[11px] opacity-80">{counts[c]}</span> : null}
          </Button>
        ))}
      </div>
      <div className={cn("grid items-start gap-4", sel && "lg:grid-cols-[minmax(0,1fr)_24rem]")}>
        <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
          {data.ideas.length === 0 && <p className="col-span-full rounded-md border-2 border-dashed px-3 py-8 text-center text-sm text-muted-foreground">{S.empty}</p>}
          {data.ideas.length > 0 && visible.length === 0 && <p className="col-span-full rounded-md border-2 border-dashed px-3 py-6 text-center text-sm text-muted-foreground">{S.none}</p>}
          {visible.map((i) => (
            <div
              key={i.id}
              role="button"
              tabIndex={0}
              onClick={() => setSelected(i.id)}
              onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); setSelected(i.id); } }}
              className={cn("grid cursor-pointer gap-2 rounded-md border bg-card p-3 shadow-sm outline-none transition-colors hover:border-primary/60 focus-visible:ring-2 focus-visible:ring-ring", i.id === selected && "border-primary", i.status === "dismissed" && "opacity-60")}
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="outline" className={CAT_CLASS[i.category]}>{S.categories[i.category]}</Badge>
                <Badge variant="outline">{S.efforts[i.effort]}</Badge>
                {i.status === "converted" && <Badge className="bg-primary/15 text-primary">{S.task} {i.card}</Badge>}
              </div>
              <div className="text-sm font-semibold">{i.title}</div>
              <div className="min-h-0 overflow-hidden text-[13px] text-muted-foreground" style={{ lineHeight: "1.4em", maxHeight: "2.8em" }}>{i.description}</div>
              {i.status === "new" && (
                <div className="flex justify-end gap-1">
                  <Button size="icon-sm" variant="ghost" title={S.convert} aria-label={`${S.convert}: ${i.title}`} onClick={(e) => { e.stopPropagation(); convert(i.id); }}><Play className="size-4" /></Button>
                  <Button size="icon-sm" variant="ghost" title={S.dismiss} aria-label={`${S.dismiss}: ${i.title}`} onClick={(e) => { e.stopPropagation(); dismiss(i.id, "dismissed"); }}><X className="size-4" /></Button>
                </div>
              )}
            </div>
          ))}
        </div>
        {sel && (
          <aside className="grid gap-3 rounded-md border bg-card p-4 lg:sticky lg:top-20">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="outline" className={CAT_CLASS[sel.category]}>{S.categories[sel.category]}</Badge>
              <Badge variant="outline">{S.efforts[sel.effort]}</Badge>
              <Button className="ml-auto" size="icon-sm" variant="ghost" aria-label="Close" onClick={() => setSelected(null)}><X className="size-4" /></Button>
            </div>
            <h3 className="font-heading text-lg font-bold tracking-tight">{sel.title}</h3>
            {[[S.description, sel.description], [S.rationale, sel.rationale], [S.current, sel.currentState], [S.proposed, sel.proposedChange]].map(([label, text]) => text && (
              <div key={label} className="grid gap-1"><span className="eyebrow">{label}</span><p className="text-[13px] whitespace-pre-wrap">{text}</p></div>
            ))}
            {sel.status === "converted" && <p className="text-sm text-primary">{S.task} {sel.card}</p>}
            {sel.status === "new" && <Button onClick={() => convert(sel.id)}><Play className="size-4" /> {S.convert}</Button>}
            {sel.status === "new" && <Button variant="outline" onClick={() => dismiss(sel.id, "dismissed")}>{S.dismiss}</Button>}
            {sel.status === "dismissed" && <Button variant="outline" onClick={() => dismiss(sel.id, "new")}>{S.restore}</Button>}
          </aside>
        )}
      </div>
    </div>
  );
}
