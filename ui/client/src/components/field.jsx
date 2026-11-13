// Shared form bits: the field class string (3D Brain look) and a labelled field wrapper.
export const FIELD = "h-9 rounded-[10px] border border-border-strong bg-card/60 px-3 text-[13px] outline-none transition-colors focus-visible:border-primary/70 focus-visible:ring-4 focus-visible:ring-primary/15";
export const FIELD_FULL = `${FIELD} w-full`;

export function Field({ label, hint, children }) {
  return (
    <label className="grid content-start gap-1.5 text-sm font-medium">
      {label}
      {children}
      {hint && <span className="text-xs font-normal text-muted-foreground">{hint}</span>}
    </label>
  );
}

export function PageHeader({ title, intro, children }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="grid gap-1">
        <h2 className="font-heading text-xl font-bold tracking-tight">{title}</h2>
        {intro && <p className="max-w-2xl text-[13px] text-muted-foreground">{intro}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}
