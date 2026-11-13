// Microphone for Cognition (PRD T21, hotkeys by owner request 2026-11-10): browser speech-to-text plus three hotkey
// modes. Settings live in this browser (localStorage): hotkeys belong to the keyboard in front of the viewer.
//   dictation  - hold to speak; what you say is inserted in the message box
//   handsfree  - press once to dictate; press again or Enter to stop
//   push       - hold to speak; inserted and sent when you let go
// Hotkeys only work while the Artrios tab has focus (a web page cannot register global shortcuts).
import { useCallback, useEffect, useRef, useState } from "react";

export const MIC_MODES = ["dictation", "handsfree", "push"];
export const MIC_DEFAULTS = { lang: "id-ID", hotkeys: { dictation: "Win+Alt", handsfree: "Ctrl+Win+Shift", push: "Ctrl+Win" } };
const KEY = "artrios.mic";
const MOD_ORDER = ["Ctrl", "Win", "Alt", "Shift"];

export function loadMic() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (!v) return structuredClone(MIC_DEFAULTS);
    return { lang: v.lang || MIC_DEFAULTS.lang, hotkeys: { ...MIC_DEFAULTS.hotkeys, ...(v.hotkeys ?? {}) } };
  } catch { return structuredClone(MIC_DEFAULTS); }
}
export function saveMic(v) {
  try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* storage blocked: lasts until reload */ }
  window.dispatchEvent(new CustomEvent("artrios-mic", { detail: v }));
}
export function useMicSettings() {
  const [v, setV] = useState(loadMic);
  useEffect(() => {
    const on = (e) => setV(e.detail ?? loadMic());
    window.addEventListener("artrios-mic", on);
    return () => window.removeEventListener("artrios-mic", on);
  }, []);
  return v;
}

// One key name per physical key: modifiers by role, anything else by its key value.
export function keyName(e) {
  if (e.key === "Control") return "Ctrl";
  if (e.key === "Meta" || e.key === "OS") return "Win";
  if (e.key === "Alt" || e.key === "AltGraph") return "Alt";
  if (e.key === "Shift") return "Shift";
  if (e.key === " ") return "Space";
  return e.key.length === 1 ? e.key.toUpperCase() : e.key;
}
export const comboOf = (set) => [...set].sort((a, b) => (MOD_ORDER.indexOf(a) + 1 || 9) - (MOD_ORDER.indexOf(b) + 1 || 9) || a.localeCompare(b)).join("+");
export const normCombo = (s) => comboOf(new Set(String(s ?? "").split("+").map((x) => x.trim()).filter(Boolean)));

const Rec = () => (typeof window !== "undefined" ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null);
export const micSupported = () => Boolean(Rec());

// Dictation engine + hotkeys. onInsert(text) adds final words; onSend() runs after a push-to-dictate release.
export function useDictation({ onInsert, onSend, enabled = true, texts = {} }) {
  const settings = useMicSettings();
  const [active, setActive] = useState(null); // null | mode | "button"
  const [interim, setInterim] = useState("");
  const [err, setErr] = useState("");
  const rec = useRef(null);
  const st = useRef({ mode: null, discard: false, pending: null, consumed: false });
  const cb = useRef({ onInsert, onSend, texts });
  cb.current = { onInsert, onSend, texts };
  const down = useRef(new Set()); // keys held now; survives re-renders (a new listener must not forget them)

  const begin = useCallback((mode) => {
    const R = Rec();
    const texts = cb.current.texts ?? {};
    if (!R) { setErr(texts.unsupported ?? "Speech input is not supported in this browser"); return; }
    if (rec.current) { st.current.pending = mode; try { rec.current.abort(); } catch { /* gone */ } return; }
    setErr("");
    const r = new R();
    r.lang = settings.lang;
    r.continuous = true;
    r.interimResults = true;
    st.current = { ...st.current, mode, discard: false, pending: null };
    r.onresult = (e) => {
      let tmp = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) { if (!st.current.discard) cb.current.onInsert(t.trim()); } else tmp += t;
      }
      setInterim(st.current.discard ? "" : tmp);
    };
    r.onerror = (e) => { if (e.error !== "aborted" && e.error !== "no-speech") setErr(e.error === "not-allowed" ? (texts.denied ?? "Microphone blocked") : `${texts.error ?? "Voice input error"}: ${e.error}`); };
    r.onend = () => {
      const { mode: ended, discard, pending } = st.current;
      rec.current = null;
      setInterim("");
      setActive(null);
      st.current.mode = null;
      if (ended === "push" && !discard) setTimeout(() => cb.current.onSend(), 50);
      if (pending) begin(pending);
    };
    rec.current = r;
    try { r.start(); setActive(mode); } catch (e) { rec.current = null; setErr(e.message); }
  }, [settings.lang]);

  const end = useCallback(({ discard = false } = {}) => {
    if (!rec.current) return;
    st.current.discard = discard;
    try { if (discard) rec.current.abort(); else rec.current.stop(); } catch { /* gone */ }
  }, []);

  // Hotkeys: exact match of the keys held down. A longer combo that contains a shorter one (Ctrl+Win+Shift vs
  // Ctrl+Win) wins when its last key arrives: the short hold is dropped without inserting anything.
  useEffect(() => {
    if (!enabled) return undefined;
    const held = down.current;
    const hk = Object.fromEntries(MIC_MODES.map((m) => [m, normCombo(settings.hotkeys[m])]));
    const onDown = (e) => {
      if (e.repeat) return;
      if (e.key === "Enter" && st.current.mode === "handsfree") { e.preventDefault(); e.stopPropagation(); end(); return; }
      held.add(keyName(e));
      const now = comboOf(held);
      if (now === hk.handsfree) {
        e.preventDefault();
        st.current.consumed = true;
        if (st.current.mode === "handsfree") end();
        else if (st.current.mode) { st.current.discard = true; begin("handsfree"); }
        else begin("handsfree");
        return;
      }
      if (st.current.mode) return;
      for (const m of ["dictation", "push"]) {
        if (now === hk[m]) { e.preventDefault(); st.current.consumed = false; begin(m); return; }
      }
    };
    const onUp = (e) => {
      const k = keyName(e);
      const mode = st.current.mode;
      if ((mode === "dictation" || mode === "push") && hk[mode].split("+").includes(k)) end();
      held.delete(k);
      if (!held.size) st.current.consumed = false;
    };
    const onBlur = () => { held.clear(); if (st.current.mode === "dictation" || st.current.mode === "push") end({ discard: true }); };
    window.addEventListener("keydown", onDown, true);
    window.addEventListener("keyup", onUp, true);
    window.addEventListener("blur", onBlur);
    return () => { window.removeEventListener("keydown", onDown, true); window.removeEventListener("keyup", onUp, true); window.removeEventListener("blur", onBlur); };
  }, [enabled, settings.hotkeys, begin, end]);

  useEffect(() => () => { try { rec.current?.abort(); } catch { /* gone */ } }, []);
  return {
    supported: micSupported(),
    active,
    on: Boolean(active),
    interim,
    err,
    hotkeys: settings.hotkeys,
    toggle: () => (active ? end() : begin("button")),
  };
}
