import { useEffect, useState } from "react";
import { FolderOpen, SquareCode, SquareTerminal } from "lucide-react";
import { api } from "../api.js";
import { T } from "../texts.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const CODE_CLASS = { M: "text-warning", A: "text-positive", "?": "text-info", D: "text-destructive", R: "text-self" };

// Human Review panel: what changed in the project folder, plus the quick actions from the reference.
export function ReviewPanel({ project, onOpenTerminal }) {
  const S = T.views.review;
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  useEffect(() => { let live = true; api.review(project).then((r) => live && setData(r)).catch((e) => live && setError(e.message)); return () => { live = false; }; }, [project]);
  const open = async (target) => { setError(""); setNote(""); try { await api.openIn(project, { target }); setNote(S.opened); } catch (e) { setError(e.message); } };

  return (
    <section className="grid gap-3 rounded-md border bg-card p-3.5" aria-label={S.title}>
      <h3 className="eyebrow">{S.title}</h3>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {data && !data.git && <p className="text-sm text-muted-foreground">{S.noGit}</p>}
      {data?.git && (
        <>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">{S.branch}</span>
            <Badge variant="outline" className="font-mono">{data.branch || "?"}</Badge>
            <Badge variant="outline" className="font-mono">{data.head}</Badge>
            <span className="ml-auto font-mono text-xs">
              {data.totals.files} {S.files} <span className="text-positive">+{data.totals.added}</span> <span className="text-destructive">−{data.totals.deleted}</span>
            </span>
          </div>
          {data.files.length === 0 ? <p className="text-sm text-muted-foreground">{S.nothing}</p> : (
            <ul className="grid max-h-44 gap-0.5 overflow-y-auto font-mono text-xs">
              {data.files.map((f) => (
                <li key={f.path} className="flex items-center gap-2">
                  <span className={`w-4 text-center font-bold ${CODE_CLASS[f.code] ?? ""}`}>{f.code}</span>
                  <span className="min-w-0 flex-1 truncate" title={f.path}>{f.path}</span>
                  {f.added !== null && <span className="text-positive">+{f.added}</span>}
                  {f.deleted !== null && <span className="text-destructive">−{f.deleted}</span>}
                </li>
              ))}
            </ul>
          )}
          {data.commits.length > 0 && (
            <div className="grid gap-1">
              <span className="eyebrow">{S.commits}</span>
              <ul className="grid gap-0.5 text-xs">
                {data.commits.map((c) => <li key={c.hash} className="flex gap-2"><span className="font-mono text-muted-foreground">{c.hash}</span><span className="truncate">{c.subject}</span></li>)}
              </ul>
            </div>
          )}
        </>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => open("vscode")}><SquareCode className="size-4" /> {S.vscode}</Button>
        <Button variant="outline" size="sm" onClick={onOpenTerminal}><SquareTerminal className="size-4" /> {S.terminal}</Button>
        <Button variant="outline" size="sm" onClick={() => open("folder")}><FolderOpen className="size-4" /> {S.folder}</Button>
        {note && <span className="text-xs text-muted-foreground">{note}</span>}
      </div>
    </section>
  );
}
