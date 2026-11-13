import { useEffect, useState } from "react";
import { Eye, Pencil } from "lucide-react";
import { api } from "../api.js";
import { T } from "../texts.js";
import { Md, toggleLine } from "@/lib/md";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader } from "@/components/field";

export default function Roadmap({ project }) {
  const S = T.views.roadmap;
  const [text, setText] = useState("");
  const [saved, setSaved] = useState("");
  const [exists, setExists] = useState(true);
  const [mode, setMode] = useState("preview");
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    api.roadmap(project).then((r) => { if (live) { setText(r.text); setSaved(r.exists ? r.text : ""); setExists(r.exists); setError(""); } }).catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [project]);

  const save = async (next = text) => {
    try { await api.saveRoadmap(project, next); setSaved(next); setExists(true); setError(""); } catch (e) { setError(e.message); }
  };
  const dirty = text !== saved;
  return (
    <div className="grid max-w-3xl gap-4">
      <PageHeader title={S.title} intro={S.intro}>
        <div role="group" className="inline-flex gap-0.5 rounded-[10px] border border-border-strong p-0.5">
          <Button size="sm" variant={mode === "preview" ? "default" : "ghost"} aria-pressed={mode === "preview"} onClick={() => setMode("preview")}><Eye className="size-4" /> {S.preview}</Button>
          <Button size="sm" variant={mode === "edit" ? "default" : "ghost"} aria-pressed={mode === "edit"} onClick={() => setMode("edit")}><Pencil className="size-4" /> {S.edit}</Button>
        </div>
        <Button size="sm" disabled={!dirty} onClick={() => save()}>{S.save}</Button>
      </PageHeader>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {!exists && <p className="rounded-md border border-warning bg-warning/10 px-3 py-2 text-sm">{S.missing}</p>}
      <p className="font-mono text-[11px] text-muted-foreground">{dirty ? S.unsaved : exists ? S.saved : ""}</p>
      {mode === "edit" ? (
        <Textarea rows={22} className="font-mono text-[13px]" value={text} onChange={(e) => setText(e.target.value)} />
      ) : (
        <div className="rounded-md border bg-card p-4"><Md text={text} onToggle={(i) => { const next = toggleLine(text, i); setText(next); save(next); }} /></div>
      )}
    </div>
  );
}
