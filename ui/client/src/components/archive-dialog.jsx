import { RotateCcw } from "lucide-react";
import { T } from "../texts.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function ArchiveDialog({ cards, onRestore, onOpen, onClose }) {
  const S = T.views.archive;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent closeLabel={T.close}>
        <DialogHeader>
          <DialogTitle>{S.title}</DialogTitle>
          <DialogDescription>{cards.length} {S.archived.toLowerCase()}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {cards.length === 0 && <p className="text-sm text-muted-foreground">{S.empty}</p>}
          <ul className="grid gap-2">
            {cards.map((c) => (
              <li key={c.key} className="flex items-center gap-2 rounded-md border bg-card px-3 py-2">
                <Badge variant="outline" className="font-mono">{c.key}</Badge>
                <button type="button" className="min-w-0 flex-1 truncate text-left text-sm hover:underline" onClick={() => onOpen(c.key)}>{c.title}</button>
                <Button size="sm" variant="outline" onClick={() => onRestore(c.key)}><RotateCcw className="size-4" /> {S.restore}</Button>
              </li>
            ))}
          </ul>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
