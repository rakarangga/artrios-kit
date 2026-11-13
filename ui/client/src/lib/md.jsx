// A tiny Markdown renderer for the roadmap preview: headings, bullets, check boxes, **bold** and `code`.
// It builds React elements, never HTML strings, so file content cannot inject markup.
import { cn } from "@/lib/utils";

function inline(text) {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={i} className="rounded bg-muted px-1 font-mono text-[12px]">{part.slice(1, -1)}</code>;
    return part;
  });
}

export function Md({ text, onToggle }) {
  return (
    <div className="grid gap-1 text-sm">
      {text.split("\n").map((line, i) => {
        const h = /^(#{1,3})\s+(.*)$/.exec(line);
        if (h) return <div key={i} className={cn("font-heading font-bold tracking-tight", h[1].length === 1 ? "mt-2 text-xl" : h[1].length === 2 ? "mt-3 text-base" : "mt-2 text-sm")}>{inline(h[2])}</div>;
        const c = /^(\s*)[-*]\s+\[( |x|X)\]\s?(.*)$/.exec(line);
        if (c) {
          const done = c[2] !== " ";
          return (
            <label key={i} className="flex items-start gap-2" style={{ paddingLeft: c[1].length * 8 }}>
              <input type="checkbox" className="mt-1" checked={done} onChange={() => onToggle?.(i)} />
              <span className={cn(done && "text-muted-foreground line-through")}>{inline(c[3])}</span>
            </label>
          );
        }
        const b = /^(\s*)[-*]\s+(.*)$/.exec(line);
        if (b) return <div key={i} className="flex gap-2" style={{ paddingLeft: b[1].length * 8 }}><span aria-hidden="true">•</span><span>{inline(b[2])}</span></div>;
        if (!line.trim()) return <div key={i} className="h-1.5" />;
        return <p key={i}>{inline(line)}</p>;
      })}
    </div>
  );
}

// Flips the check box on one line and returns the new text.
export function toggleLine(text, index) {
  const lines = text.split("\n");
  lines[index] = lines[index].replace(/\[( |x|X)\]/, (m, v) => (v === " " ? "[x]" : "[ ]"));
  return lines.join("\n");
}
