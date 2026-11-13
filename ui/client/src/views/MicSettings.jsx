// Settings > Microphone: language and the three hotkey modes for Cognition (owner request 2026-11-10).
// Stored in this browser only; "Change" records the keys held down and saves them when all are released.
import { useEffect, useState } from "react";
import { Keyboard, Mic, RotateCcw } from "lucide-react";
import { T } from "../texts.js";
import { MIC_DEFAULTS, MIC_MODES, comboOf, keyName, loadMic, micSupported, normCombo, saveMic } from "../mic.js";
import { Button } from "@/components/ui/button";
import { SelectField, SettingRow, SettingsSection } from "@/components/settings-layout";
import { cn } from "@/lib/utils";

const LANGS = [["id-ID", "Bahasa Indonesia"], ["en-US", "English (US)"], ["en-GB", "English (UK)"]];

function Keys({ combo }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      {normCombo(combo).split("+").filter(Boolean).map((k, i) => (
        <span key={k} className="flex items-center gap-1">
          {i > 0 && <span className="text-muted-foreground">+</span>}
          <kbd className="rounded-md border border-border-strong bg-card px-1.5 py-0.5 font-mono text-[11px] shadow-xs">{k}</kbd>
        </span>
      ))}
    </span>
  );
}

export default function MicSettings() {
  const S = T.views.mic;
  const [v, setV] = useState(loadMic);
  const [recording, setRecording] = useState(null); // mode being recorded
  const [seen, setSeen] = useState("");
  const update = (next) => { setV(next); saveMic(next); };

  useEffect(() => {
    if (!recording) return undefined;
    const down = new Set();
    let best = new Set();
    const onDown = (e) => {
      e.preventDefault(); e.stopPropagation();
      if (e.key === "Escape" && down.size === 0) { setRecording(null); return; }
      down.add(keyName(e));
      if (down.size >= best.size) best = new Set(down);
      setSeen(comboOf(best));
    };
    const onUp = (e) => {
      e.preventDefault(); e.stopPropagation();
      down.delete(keyName(e));
      if (down.size === 0 && best.size) {
        const combo = comboOf(best);
        const clash = MIC_MODES.find((m) => m !== recording && normCombo(v.hotkeys[m]) === combo);
        if (!clash) update({ ...v, hotkeys: { ...v.hotkeys, [recording]: combo } });
        setSeen(clash ? `${combo} · ${S.clash} ${S.modes[clash].title}` : "");
        setRecording(null);
      }
    };
    window.addEventListener("keydown", onDown, true);
    window.addEventListener("keyup", onUp, true);
    return () => { window.removeEventListener("keydown", onDown, true); window.removeEventListener("keyup", onUp, true); };
  }, [recording]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <SettingsSection icon={Mic} id="mic-title" title={S.title} intro={S.intro}>
      {!micSupported() && <p className="px-5 py-2 text-sm text-warning">{T.views.cognition.micUnsupported}</p>}
      <SettingRow title={S.lang}>
        <SelectField label={S.lang} value={v.lang} onChange={(lang) => update({ ...v, lang })} options={LANGS.map(([value, label]) => ({ value, label }))} />
      </SettingRow>
      {MIC_MODES.map((m) => (
        <SettingRow key={m} title={S.modes[m].title} desc={S.modes[m].desc} className={cn(recording === m && "bg-primary/5")}>
          {recording === m
            ? <span className="text-xs text-primary">{seen || S.pressKeys}</span>
            : <Keys combo={v.hotkeys[m]} />}
          {normCombo(v.hotkeys[m]) !== normCombo(MIC_DEFAULTS.hotkeys[m]) && (
            <Button size="icon-sm" variant="ghost" title={`${S.reset} (${MIC_DEFAULTS.hotkeys[m]})`} aria-label={S.reset} onClick={() => update({ ...v, hotkeys: { ...v.hotkeys, [m]: MIC_DEFAULTS.hotkeys[m] } })}><RotateCcw className="size-3.5" /></Button>
          )}
          <Button size="sm" className="min-w-24" variant={recording === m ? "default" : "outline"} onClick={() => { setSeen(""); setRecording(recording === m ? null : m); }}>
            <Keyboard className="size-3.5" /> {recording === m ? S.cancel : S.change}
          </Button>
        </SettingRow>
      ))}
      {seen && !recording && <p className="px-5 py-2 text-xs text-warning">{seen}</p>}
      <p className="px-5 py-3 text-[11px] text-muted-foreground">{S.note}</p>
    </SettingsSection>
  );
}
