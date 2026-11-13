import { useEffect, useState } from "react";
import { api } from "../api.js";
import { T } from "../texts.js";
import { FIELD_FULL } from "@/components/field";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

// Browse Files: search the project's files, click one to mention it in the task text.
export function FilePicker({ project, onPick, onClose }) {
  const S = T.views.task;
  const [q, setQ] = useState("");
  const [res, setRes] = useState({ files: [], more: 0 });
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => api.files(project, q).then((r) => live && setRes(r)).catch(() => {}), 120);
    return () => { live = false; clearTimeout(t); };
  }, [project, q]);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent closeLabel={T.close} className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{S.pick}</DialogTitle>
          <DialogDescription className="sr-only">{S.search}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <input autoFocus className={FIELD_FULL} placeholder={S.search} aria-label={S.search} value={q} onChange={(e) => setQ(e.target.value)} />
          <ul className="grid max-h-72 gap-0.5 overflow-y-auto font-mono text-xs">
            {res.files.length === 0 && <li className="py-4 text-center text-muted-foreground">{S.noFiles}</li>}
            {res.files.map((f) => (
              <li key={f}><button type="button" className="w-full truncate rounded-md px-2 py-1.5 text-left hover:bg-accent hover:text-accent-foreground" onClick={() => onPick(f)}>{f}</button></li>
            ))}
          </ul>
          {res.more > 0 && <p className="text-xs text-muted-foreground">+{res.more} {S.moreFiles}</p>}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
