// Decision Required (AIOS-94): the queue of decisions waiting for a click, one card per item. Shares inbox-service
// with the agent approval inbox (PRD AIOS-61 section 7). A decided item is never edited; a correction is a new item.
// Card: decision type, related to (file and area), suggestion, preview, decision buttons and what each one does.
import { useCallback, useEffect, useMemo, useState } from "react";
import { BrainCog, Check, ChevronRight, Eye, RefreshCw } from "lucide-react";
import { api } from "../api.js";
import { subscribe } from "../socket.js";
import { Markdown } from "../markdown.jsx";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FIELD_FULL, PageHeader } from "@/components/field";

const FILTERS = [["pending", "Menunggu"], ["decided", "Diputuskan"], ["expired", "Kedaluwarsa"]];
const KIND = { putusan: "Putusan", approval_request: "Izin agen", missed_run: "Jadwal terlewat" };
const age = (ts) => Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 86400000));
const stripFm = (t) => t.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");

// Items without display data (agent approvals, ad-hoc questions) fall back to the question text.
function view(item) {
  const m = item.meta ?? {};
  const file = item.links[0]?.split("/").pop();
  return {
    kind: m.type ?? KIND[item.kind] ?? item.kind,
    file: m.title ?? file ?? "",
    area: m.related ?? (item.links[0] ? item.links[0].split("/").slice(0, -1).join("/") : ""),
    suggestion: m.suggestion ?? "",
    outcome: m.outcome ?? "",
    // Scheduler and agent items carry a title (the agent) and still need their question shown.
    fallback: m.title && item.kind === "putusan" ? "" : item.question,
  };
}

function Card({ item, stale, onDecide, onPreview, onOpenSession }) {
  const v = view(item);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const open = item.status === "pending";
  const decide = async (d) => {
    setBusy(true);
    try { await onDecide(item.id, d, note); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <li className="grid content-start gap-3 rounded-md border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-semibold">{v.kind}</span>
          {open && stale && <Badge className="bg-warning/15 text-warning">tertunda {age(item.ts)} hari</Badge>}
          {item.reasked > 0 && <Badge variant="outline" title={item.lastAsked ?? ""}>ditanya lagi {item.reasked}x</Badge>}
          {item.supersedes && <Badge variant="outline" title="Menggantikan keputusan lama">ganti {item.supersedes}</Badge>}
        </div>
        <span className="font-mono text-[10px] text-muted-foreground">{item.id}</span>
      </div>
      <div className="grid gap-0.5">
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Terkait apa</span>
        {v.file && <span className="font-mono text-[13px] font-medium break-all">{v.file}</span>}
        {v.area && <span className="font-mono text-[11px] break-all text-muted-foreground">{v.area}</span>}
        {v.fallback && <span className="text-[13px] whitespace-pre-line">{v.fallback}</span>}
      </div>
      {item.why && (
        <div className="grid gap-0.5">
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Alasan bertanya</span>
          <span className="text-[13px]">{item.why}</span>
        </div>
      )}
      {v.suggestion && (
        <div className="grid gap-0.5">
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Saran</span>
          <span className="text-[13px]">{v.suggestion}</span>
        </div>
      )}
      {(item.links.length > 0 || (item.session && onOpenSession)) && (
        <div className="flex flex-wrap gap-1.5">
          {item.links.length > 0 && <Button size="sm" variant="outline" onClick={() => onPreview(item, v.file || v.kind)}><Eye className="size-3.5" /> Preview</Button>}
          {item.session && onOpenSession && item.workspace && <Button size="sm" variant="outline" onClick={() => onOpenSession(item.workspace, item.lastSession ?? item.session)}><BrainCog className="size-3.5" /> Buka sesi asal</Button>}
        </div>
      )}
      {open ? (
        <div className="grid gap-2 border-t pt-3">
          <input className={FIELD_FULL} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Catatan (wajib bila revisi)" aria-label="Catatan" />
          <div className="flex flex-wrap gap-1.5">
            {item.options.map((o) => (
              <Button key={o} size="sm" variant={o === item.options[0] ? "default" : "outline"} disabled={busy || (o === "revisi" && !note.trim())} onClick={() => decide(o)}>
                {o === item.options[0] && <Check className="size-3.5" />} {o}
              </Button>
            ))}
          </div>
          {v.outcome && <p className="text-[11px] text-muted-foreground">{v.outcome}</p>}
          {err && <p className="text-xs text-destructive">{err}</p>}
        </div>
      ) : (
        <p className="border-t pt-3 text-xs text-muted-foreground">
          {item.status === "decided" ? `${item.decision} · ${item.decidedAt?.slice(0, 16).replace("T", " ")}${item.note ? ` · ${item.note}` : ""}${item.applied ? ` · diterapkan (${item.applied.result})` : " · belum diterapkan"}` : "Kedaluwarsa, tidak dijalankan."}
        </p>
      )}
    </li>
  );
}

function PreviewDialog({ state, onClose }) {
  return (
    <Dialog open={!!state} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm">{state?.title}</DialogTitle>
          <DialogDescription>{state?.data?.path ?? "Pratinjau berkas yang ditautkan"}</DialogDescription>
        </DialogHeader>
        <DialogBody className="max-h-[70vh] overflow-auto">
          {state?.error && <p className="text-sm text-destructive">{state.error}</p>}
          {!state?.error && !state?.data && <p className="text-sm text-muted-foreground">Memuat...</p>}
          {state?.data && <Markdown text={stripFm(state.data.text)} />}
          {state?.data?.truncated && <p className="mt-2 text-xs text-muted-foreground">Dipotong di 200 KB.</p>}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

export default function PutusanView({ onCount, onOpenSession }) {
  const [filter, setFilter] = useState("pending");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState(null);
  const load = useCallback(() => api.inbox(`?status=${filter}`).then((d) => { setData(d); setError(""); onCount?.(d.pending); }).catch((e) => setError(e.message)), [filter, onCount]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => subscribe((m) => { if (m.type === "inbox") load(); }), [load]);
  const stale = useMemo(() => new Set(data?.stale ?? []), [data]);
  // Grouped per workspace, then subject (PRD Cognition §11), oldest first inside each group.
  const groups = useMemo(() => {
    const ws = new Map();
    for (const i of data?.items ?? []) {
      const w = i.workspace ?? "Lainnya";
      const s = i.subject ?? i.meta?.related ?? "Tanpa subjek";
      if (!ws.has(w)) ws.set(w, new Map());
      const sub = ws.get(w);
      if (!sub.has(s)) sub.set(s, []);
      sub.get(s).push(i);
    }
    return [...ws.entries()].map(([w, sub]) => [w, [...sub.entries()]]);
  }, [data]);
  const decide = async (id, d, note) => { await api.inboxDecide(id, d, note); await load(); };
  const showPreview = (item, title) => {
    setPreview({ title });
    api.inboxPreview(item.id).then((d) => setPreview({ title, data: d })).catch((e) => setPreview({ title, error: e.message }));
  };
  return (
    <div className="grid gap-4">
      <PageHeader title="Decision Required" intro="Keputusan yang menunggu klik. Jawaban ditulis ke antrean dan diterapkan oleh skrip atau sesi berikutnya.">
        <Button size="sm" variant="outline" onClick={load}><RefreshCw className="size-3.5" /> Muat ulang</Button>
      </PageHeader>
      <div className="flex gap-2">
        {FILTERS.map(([k, label]) => (
          <Button key={k} size="sm" variant={filter === k ? "default" : "outline"} onClick={() => setFilter(k)}>
            {label}{k === "pending" && data ? ` (${data.pending})` : ""}
          </Button>
        ))}
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {!data && !error && <p className="text-sm text-muted-foreground">Memuat...</p>}
      {data && data.items.length === 0 && <p className="rounded-md border-2 border-dashed px-3 py-6 text-center text-sm text-muted-foreground">Tidak ada item.</p>}
      {data && data.items.length > 0 && (
        <div className="grid gap-3">
          {groups.map(([ws, subjects]) => (
            <details key={ws} open className="group/ws rounded-md border bg-card/40">
              <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 font-heading text-sm font-bold">
                <ChevronRight className="size-4 transition-transform group-open/ws:rotate-90" />{ws}
                <Badge variant="outline">{subjects.reduce((n, [, items]) => n + items.length, 0)}</Badge>
              </summary>
              <div className="grid gap-3 px-3 pb-3">
                {subjects.map(([subject, items]) => (
                  <details key={subject} open className="group/sub">
                    <summary className="mb-2 flex cursor-pointer list-none items-center gap-1.5 text-[13px] font-semibold text-muted-foreground">
                      <ChevronRight className="size-3.5 transition-transform group-open/sub:rotate-90" />{subject} <span className="font-normal">({items.length})</span>
                    </summary>
                    <ul className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
                      {items.map((i) => <Card key={i.id} item={i} stale={stale.has(i.id)} onDecide={decide} onPreview={showPreview} onOpenSession={onOpenSession} />)}
                    </ul>
                  </details>
                ))}
              </div>
            </details>
          ))}
        </div>
      )}
      <PreviewDialog state={preview} onClose={() => setPreview(null)} />
    </div>
  );
}
