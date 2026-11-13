// Wraps a side panel so it slides in from the right and slides out again (AIOS-129). Keeps the last content
// on screen while the exit animation runs; the wrapper fills its parent and lets clicks pass through to the canvas.
import { useEffect, useRef, useState } from "react";

export function SlidePanel({ show, children }) {
  const last = useRef(children);
  const [mounted, setMounted] = useState(show);
  if (show) last.current = children;
  useEffect(() => {
    if (show) { setMounted(true); return undefined; }
    const t = setTimeout(() => setMounted(false), 260);
    return () => clearTimeout(t);
  }, [show]);
  if (!show && !mounted) return null;
  return <div data-state={show ? "open" : "closed"} className="slide-panel pointer-events-none absolute inset-0 z-10 [&>*]:pointer-events-auto">{last.current}</div>;
}
