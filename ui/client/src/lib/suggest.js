// Prompt Suggestions settings for Cognition Stored in this browser; off by default (each use is a model call).
import { useEffect, useState } from "react";
import { readPersisted, writePersisted } from "./persist.js";

export const SUGGEST_DEFAULTS = { enabled: false, provider: "", model: "haiku", effort: "low", language: "English" };
export const SUGGEST_MODELS = ["haiku", "sonnet", "opus"];
export const SUGGEST_EFFORTS = ["low", "medium", "high"];
const KEY = "suggest";

export function loadSuggest() {
  const v = readPersisted(KEY, null) ?? {};
  return {
    enabled: v.enabled === true,
    provider: typeof v.provider === "string" ? v.provider.slice(0, 60) : "",
    model: typeof v.model === "string" && v.model.trim() ? v.model.trim().slice(0, 80) : SUGGEST_DEFAULTS.model,
    effort: SUGGEST_EFFORTS.includes(v.effort) ? v.effort : SUGGEST_DEFAULTS.effort,
    language: typeof v.language === "string" && v.language.trim() ? v.language.trim().slice(0, 40) : SUGGEST_DEFAULTS.language,
  };
}
export function saveSuggest(v) {
  writePersisted(KEY, v);
  window.dispatchEvent(new CustomEvent("artrios-suggest", { detail: v }));
}
export function useSuggestSettings() {
  const [v, setV] = useState(loadSuggest);
  useEffect(() => {
    const on = (e) => setV(e.detail ?? loadSuggest());
    window.addEventListener("artrios-suggest", on);
    return () => window.removeEventListener("artrios-suggest", on);
  }, []);
  return v;
}
