// Small read-mostly screens: Activity, Changelog, Context, MCP Overview (Worktrees: views/Worktrees.jsx).
import { usePersisted } from "../lib/persist.js";
import { useEffect, useMemo, useState } from "react";
import { Copy } from "lucide-react";
import { api } from "../api.js";
import { T } from "../texts.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FIELD, PageHeader, copyText } from "@/components/field";

function useLoad(fn, deps) {
  const [state, setState] = useState({ data: null, error: "", loading: true });
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    fn().then((data) => live && setState({ data, error: "", loading: false })).catch((e) => live && setState({ data: null, error: e.message, loading: false }));
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

const Empty = ({ children }) => <p className="rounded-md border-2 border-dashed px-3 py-6 text-center text-sm text-muted-foreground">{children}</p>;
const ErrorLine = ({ error }) => (error ? <p className="text-sm text-destructive">{error}</p> : null);

// Activity: same layout as Changelog (one card per day), with the time of each event.
export function ActivityView({ events }) {
  const S = T.views.activity;
  const groups = useMemo(() => {
    const by = new Map();
    events.forEach((e) => {
      const ts = String(e.ts ?? "");
      const date = ts.slice(0, 10) || "unknown";
      if (!by.has(date)) by.set(date, []);
      by.get(date).push({ ...e, time: ts.slice(11, 16) });
    });
    return [...by.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [events]);
  const kindOf = (type) => {
    const k = String(type ?? "").replace(/^(card|job|git)\./, "");
    return S.kinds[k] ?? k;
  };
  return (
    <div className="grid max-w-3xl gap-4">
      <PageHeader title={S.title} intro={S.intro} />
      {groups.length === 0 && <Empty>{S.empty}</Empty>}
      {groups.map(([date, items]) => (
        <section key={date} className="rounded-md border bg-card">
          <h3 className="border-b px-3.5 py-2 font-mono text-xs text-muted-foreground">{date}</h3>
          <ul className="grid gap-1.5 p-3 text-sm">
            {items.map((e, n) => (
              <li key={`${e.ts}-${n}`} className="flex items-start gap-2">
                <span className="w-10 shrink-0 pt-0.5 font-mono text-xs text-muted-foreground">{e.time}</span>
                <Badge variant="outline" className={e.type === "git.commit" ? "font-mono" : "border-primary/50 text-primary"}>{kindOf(e.type)}</Badge>
                <span className="min-w-0 break-words"><b className="font-mono font-medium">{e.ref}</b>{e.detail && <span className="text-muted-foreground"> {e.detail}</span>}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function Changelog({ project }) {
  const S = T.views.changelog;
  const [days, setDays] = useState(60);
  const [copied, setCopied] = useState(false);
  const { data, error, loading } = useLoad(() => api.changelog(project, days), [project, days]);
  const groups = useMemo(() => {
    if (!data) return [];
    const by = new Map();
    const add = (date, item) => { const k = date || "unknown"; if (!by.has(k)) by.set(k, []); by.get(k).push(item); };
    data.done.forEach((d) => add(d.date, { kind: "done", text: `${d.key} ${d.title}` }));
    data.commits.forEach((c) => add(c.date, { kind: "commit", text: `${c.hash} ${c.subject}` }));
    return [...by.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [data]);
  const markdown = groups.map(([date, items]) => `## ${date}\n${items.map((i) => `- ${i.kind === "done" ? `${S.doneLabel}: ` : ""}${i.text}`).join("\n")}`).join("\n\n");
  return (
    <div className="grid max-w-3xl gap-4">
      <PageHeader title={S.title} intro={S.intro}>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">{S.last}
          <select className={`${FIELD} h-8`} value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[14, 30, 60, 180].map((d) => <option key={d} value={d}>{d} {S.days}</option>)}
          </select>
        </label>
        <Button variant="outline" size="sm" disabled={!markdown} onClick={async () => { if (await copyText(markdown)) { setCopied(true); setTimeout(() => setCopied(false), 1500); } }}>
          <Copy className="size-4" /> {copied ? S.copied : S.copy}
        </Button>
      </PageHeader>
      <ErrorLine error={error} />
      {!loading && groups.length === 0 && !error && <Empty>{S.empty}</Empty>}
      {groups.map(([date, items]) => (
        <section key={date} className="rounded-md border bg-card">
          <h3 className="border-b px-3.5 py-2 font-mono text-xs text-muted-foreground">{date}</h3>
          <ul className="grid gap-1.5 p-3 text-sm">
            {items.map((i, n) => (
              <li key={n} className="flex items-start gap-2">
                <Badge variant="outline" className={i.kind === "done" ? "border-primary/50 text-primary" : "font-mono"}>{i.kind === "done" ? S.doneLabel : S.commitLabel}</Badge>
                <span className="min-w-0 break-words">{i.text}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

// Overview: Activity (what happened, newest first), Changelog (a draft to copy), Context (what the agent reads) and
// MCP (servers named in .mcp.json) on one page, split by a switch.
export function OverviewView({ events, project }) {
  const S = T.views.overview;
  const [tab, setTab] = usePersisted("overview.tab", "activity", (v) => typeof v === "string");
  return (
    <div className="grid gap-4">
      <div role="group" aria-label={S.title} className="inline-flex w-fit gap-0.5 rounded-[10px] border border-border-strong p-0.5">
        {["activity", "changelog", "context", "mcp"].map((id) => (
          <Button key={id} size="sm" variant={tab === id ? "default" : "ghost"} aria-pressed={tab === id} onClick={() => setTab(id)}>{S[id]}</Button>
        ))}
      </div>
      {tab === "activity" && <ActivityView events={events} />}
      {tab === "changelog" && <Changelog project={project} />}
      {tab === "context" && <ContextView project={project} />}
      {tab === "mcp" && <McpView project={project} />}
    </div>
  );
}

export function ContextView({ project }) {
  const S = T.views.context;
  const { data, error, loading } = useLoad(() => api.context(project), [project]);
  return (
    <div className="grid max-w-3xl gap-4">
      <PageHeader title={S.title} intro={S.intro} />
      <ErrorLine error={error} />
      {!loading && data && data.files.length === 0 && <Empty>{S.empty}</Empty>}
      {data?.files.map((f) => (
        <details key={f.name} className="rounded-md border bg-card" open={data.files.length === 1}>
          <summary className="flex cursor-pointer items-center gap-2 px-3.5 py-2.5 text-sm font-semibold">
            <span className="font-mono">{f.name}</span>
            <span className="font-mono text-[11px] font-normal text-muted-foreground">{f.size} {S.bytes}</span>
          </summary>
          <pre className="max-h-96 overflow-auto border-t px-3.5 py-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">{f.text}</pre>
        </details>
      ))}
    </div>
  );
}

export function McpView({ project }) {
  const S = T.views.mcp;
  const { data, error, loading } = useLoad(() => api.mcp(project), [project]);
  return (
    <div className="grid max-w-3xl gap-4">
      <PageHeader title={S.title} intro={S.intro} />
      <ErrorLine error={error} />
      {!loading && data && !data.file && <Empty>{S.none}</Empty>}
      {!loading && data?.file && data.servers.length === 0 && <Empty>{S.empty}</Empty>}
      {data?.servers.map((s) => (
        <div key={s.name} className="flex items-center gap-3 rounded-md border bg-card px-3.5 py-2.5">
          <span className="font-semibold">{s.name}</span>
          <Badge variant="outline" className="font-mono">{s.type}</Badge>
          {s.where && <span className="font-mono text-xs text-muted-foreground">{s.where}</span>}
        </div>
      ))}
    </div>
  );
}
