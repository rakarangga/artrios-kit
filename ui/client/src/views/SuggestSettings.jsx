// Settings > Prompt Suggestions: active/inactive switch; when active, pick the model and effort of the suggestion call.
import { useState } from "react";
import { Sparkles } from "lucide-react";
import { T } from "../texts.js";
import { SUGGEST_EFFORTS, loadSuggest, saveSuggest } from "../lib/suggest.js";
import { ProviderModelSelect, isCliProvider } from "@/components/provider-model-select";
import { SelectField, SettingRow, SettingsSection } from "@/components/settings-layout";
import { cn } from "@/lib/utils";

export default function SuggestSettings() {
  const S = T.views.suggest;
  const [v, setV] = useState(loadSuggest);
  const [opts, setOpts] = useState(null);
  const update = (next) => { setV(next); saveSuggest(next); };
  return (
    <SettingsSection icon={Sparkles} id="suggest-title" title={S.title} intro={S.intro}>
      <SettingRow title={S.enable} desc={S.enableDesc}>
        <button type="button" role="switch" aria-checked={v.enabled} aria-label={S.enable} onClick={() => update({ ...v, enabled: !v.enabled })}
          className={cn("relative h-6 w-11 shrink-0 rounded-full border transition-colors", v.enabled ? "border-primary bg-primary" : "border-border-strong bg-muted")}>
          <span className={cn("absolute top-0.5 size-4.5 rounded-full bg-background shadow transition-all", v.enabled ? "left-[22px]" : "left-0.5")} />
        </button>
        <span className="w-16 text-xs text-muted-foreground">{v.enabled ? S.on : S.off}</span>
      </SettingRow>
      {v.enabled && (
        <>
          <SettingRow title={S.model} desc={S.modelDesc}>
            <ProviderModelSelect label={S.model} defaultLabel="haiku (Claude Code)" value={{ provider: v.provider, model: v.model }} onChange={({ provider, model }) => update({ ...v, provider, model: model || "haiku" })} onOptions={setOpts} />
          </SettingRow>
          <SettingRow title={S.language} desc={S.languageDesc}>
            <input className="h-9 w-48 rounded-md border border-border-strong bg-card px-3 text-sm" aria-label={S.language} maxLength={40} value={v.language} onChange={(e) => setV({ ...v, language: e.target.value })} onBlur={() => update({ ...v, language: v.language.trim() || "English" })} />
          </SettingRow>
          {isCliProvider(opts, v.provider) && <SettingRow title={S.effort} desc={S.effortDesc}>
            <SelectField label={S.effort} value={v.effort} onChange={(effort) => update({ ...v, effort })} options={SUGGEST_EFFORTS.map((m) => ({ value: m, label: m }))} />
          </SettingRow>}
        </>
      )}
    </SettingsSection>
  );
}
