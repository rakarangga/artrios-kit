// Settings layout: one card per section (icon, title, intro on the left; its action on the right) and rows with the
// label on the left and the control on the right, so every setting lines up on the same two edges.
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

export function SettingsSection({ icon: Icon, title, intro, action, children, id }) {
  return (
    <section className="grid gap-0 overflow-hidden rounded-2xl border bg-card/50" aria-labelledby={id}>
      <header className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3.5 sm:px-5">
        <div className="flex min-w-0 items-start gap-3">
          {Icon && <span className="grid size-9 shrink-0 place-items-center rounded-full bg-primary/15 text-primary"><Icon className="size-4" /></span>}
          <div className="grid min-w-0 gap-0.5">
            <h3 id={id} className="font-heading text-sm font-semibold">{title}</h3>
            {intro && <p className="max-w-2xl text-xs text-muted-foreground">{intro}</p>}
          </div>
        </div>
        {action && <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div>}
      </header>
      <div className="grid divide-y">{children}</div>
    </section>
  );
}

export function SettingRow({ title, desc, children, className }) {
  return (
    <div className={cn("grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-6 sm:px-5", className)}>
      <div className="grid min-w-0 gap-0.5">
        <span className="text-sm font-medium">{title}</span>
        {desc && <span className="text-xs text-muted-foreground">{desc}</span>}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2 sm:justify-end">{children}</div>
    </div>
  );
}

// Styled dropdown (radix Select) in place of the native <select>. options: [{ value, label, hint }]
export function SelectField({ value, onChange, options, placeholder, label, className, size = "default" }) {
  const selected = options.find((o) => o.value === value);
  return (
    <Select value={value || undefined} onValueChange={onChange}>
      <SelectTrigger aria-label={label} className={cn("h-9 min-w-48 rounded-[10px] border-border-strong bg-card/60 px-3 text-[13px] shadow-xs hover:bg-accent/50", size === "sm" && "h-8 min-w-40 text-xs", className)}>
        {selected ? <SelectValue>{selected.label}</SelectValue> : <SelectValue placeholder={placeholder} />}
      </SelectTrigger>
      <SelectContent position="popper" align="end" className="max-h-80 min-w-(--radix-select-trigger-width)">
        <SelectGroup>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value} disabled={o.disabled}>
              {o.hint ? <span className="grid"><span>{o.label}</span><span className="text-[11px] text-muted-foreground">{o.hint}</span></span> : o.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
