// Per-browser memory of UI choices (menu, tabs, filters, Cognition model/effort/session) so a reload keeps them.
// Conveniences only: storage can be blocked or empty (private window), so every read and write is guarded and the
// UI still works with the defaults.
import { useEffect, useState } from "react";

const PREFIX = "artrios.";

export function readPersisted(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch { return fallback; }
}

export function writePersisted(key, value) {
  try {
    if (value === undefined || value === null) localStorage.removeItem(PREFIX + key);
    else localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch { /* storage blocked: the choice lasts until reload */ }
}

// useState that survives a reload. `valid` drops a stored value that no longer fits (e.g. a removed menu).
export function usePersisted(key, initial, valid = () => true) {
  const [value, setValue] = useState(() => {
    const v = readPersisted(key, undefined);
    return v !== undefined && valid(v) ? v : (typeof initial === "function" ? initial() : initial);
  });
  useEffect(() => { writePersisted(key, value); }, [key, value]);
  return [value, setValue];
}
