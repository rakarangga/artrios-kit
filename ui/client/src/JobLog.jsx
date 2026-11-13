import { useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import { subscribe } from "./socket.js";
import { T } from "./texts.js";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const S = T.skills;
export const stamp = (ts) => String(ts ?? "").slice(5, 16).replace("T", " ");

const STATUS_CLASS = {
  queued: "italic text-muted-foreground",
  running: "border-info/50 text-info",
  done: "text-muted-foreground",
  failed: "border-destructive/50 font-semibold text-destructive",
  stopped: "text-muted-foreground",
};

export function Status({ status }) {
  return <Badge variant="outline" className={cn(STATUS_CLASS[status])}>{S.status[status] ?? status}</Badge>;
}

export function LogLine({ e }) {
  if (e.kind === "tool") return <div className="log-tool">$ {e.name} {e.text}</div>;
  if (e.kind === "tool_result") return <div className={e.error ? "log-err" : "log-res"}>{e.text}</div>;
  if (e.kind === "status") return <div className="log-status">{e.text}</div>;
  return <div className="log-text">{e.text}</div>;
}

// Live log, failure output and result of one job. Used by the card detail (Logs tab).
export default function JobLog({ project, jobId }) {
  const [detail, setDetail] = useState({ meta: null, result: "" });
  const [entries, setEntries] = useState([]);
  const [err, setErr] = useState("");
  const end = useRef(null);

  useEffect(() => {
    let live = true;
    setDetail({ meta: null, result: "" }); setEntries([]); setErr("");
    Promise.all([api.job(project, jobId), api.jobLog(project, jobId)])
      .then(([d, l]) => { if (live) { setDetail({ meta: d.meta, result: d.result }); setEntries(l.entries); } })
      .catch((e) => live && setErr(e.message));
    const off = subscribe((m) => {
      if (m.project !== project || m.jobId !== jobId) return;
      if (m.type === "job.log") setEntries((cur) => [...cur, m.entry]);
      if (m.type === "job.status") {
        setDetail((d) => ({ ...d, meta: m.meta }));
        if (m.meta.status !== "running") api.job(project, jobId).then((r) => live && setDetail({ meta: r.meta, result: r.result })).catch(() => {});
      }
    });
    return () => { live = false; off(); };
  }, [project, jobId]);

  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [entries]);

  const running = ["running", "queued"].includes(detail.meta?.status);
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {detail.meta && <><b>{detail.meta.skill ? `/${detail.meta.skill}` : detail.meta.schedule ?? detail.meta.agent ?? ""}</b><Status status={detail.meta.status} /><span className="text-xs text-muted-foreground">{stamp(detail.meta.started)}</span></>}
        <Button variant="destructive" size="sm" disabled={!running} onClick={() => api.stopJob(project, jobId).catch((e) => setErr(e.message))}>{S.stop}</Button>
      </div>
      {err && <p className="text-sm text-destructive">{err}</p>}
      <div className="log">{entries.map((e, i) => <LogLine key={i} e={e} />)}<div ref={end} /></div>
      {detail.meta?.status === "failed" && <div className="rounded-xl border border-destructive px-3 py-2"><b>{S.error}</b><pre className="whitespace-pre-wrap">{detail.meta.error}</pre></div>}
      {detail.result && <><h3 className="text-sm font-semibold">{S.result}</h3><pre className="result">{detail.result}</pre></>}
    </div>
  );
}
