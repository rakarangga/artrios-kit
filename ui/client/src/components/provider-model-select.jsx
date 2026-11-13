// Provider + model chooser for Settings and the task Start dialog: the same pill button and two-stage dialog Cognition uses.
// Value = { provider, model }; an empty provider means "the default": the claude CLI with a model alias, or the main model of Settings.
import { useCallback, useEffect, useState } from "react";
import { ChevronDown, Cpu, X } from "lucide-react";
import { api } from "../api.js";
import { T } from "../texts.js";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ModelPicker, labelOf } from "@/components/model-picker";

export const isCliProvider = (options, provider) => !provider || options?.providers?.find((p) => p.id === provider)?.transport === "claude_cli";

export function ProviderModelSelect({ value, onChange, className, label, defaultLabel, onOptions }) {
  const [options, setOptions] = useState(null);
  const [open, setOpen] = useState(false);
  const load = useCallback(() => api.models().then((o) => { setOptions(o); onOptions?.(o); }).catch(() => {}), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  const provider = value?.provider ?? "";
  const model = value?.model ?? "";
  const isDefault = !provider && (!model || model === defaultLabel);
  const text = isDefault ? (defaultLabel ?? T.views.task.modelDefault) : provider ? `${labelOf(options, provider)} · ${model || T.views.models.cliDefault}` : model;
  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      <Button type="button" variant="outline" size="sm" aria-label={label} title={label} onClick={() => { load(); setOpen(true); }}
        className="h-9 min-w-0 max-w-full flex-1 justify-start gap-1.5 rounded-full border-border-strong bg-card/70 px-3 text-[13px] font-medium shadow-xs">
        <Cpu className="size-3.5 shrink-0 text-primary" /><span className="truncate">{text}</span><ChevronDown className="ml-auto size-3.5 shrink-0 opacity-60" />
      </Button>
      {!isDefault && (
        <Button type="button" variant="ghost" size="icon-sm" className="rounded-full" aria-label={defaultLabel ?? T.views.task.modelDefault} title={defaultLabel ?? T.views.task.modelDefault}
          onClick={() => onChange({ provider: "", model: "" })}><X className="size-3.5" /></Button>
      )}
      <ModelPicker open={open} onClose={() => setOpen(false)} options={options} mode="pick" title={label}
        current={{ provider: provider || null, model }}
        onApply={({ provider: p, model: m }) => onChange({ provider: p, model: m })}
        onRefresh={async (id) => { await api.refreshProviderModels(id); await load(); }} />
    </div>
  );
}
