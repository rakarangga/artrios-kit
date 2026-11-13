"""Static layout check for an .excalidraw file (Artrios). Run before rendering; it does not replace looking at the PNG.

Usage: python check_layout.py <file.excalidraw>

Reports:
- duplicate ids, bindings to missing elements
- text overflowing the smallest shape that contains its top-left corner (estimated width)
- free texts overlapping each other
- container ratio (methodology target: under 30% of texts inside shapes)
Exit code 1 when a hard error (duplicate id, broken binding) is found.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

CW = {1: 0.6, 2: 0.55, 3: 0.6, 5: 0.6, 6: 0.55}
SHAPES = {"rectangle", "ellipse", "diamond"}


def text_box(t: dict) -> tuple[float, float, float, float]:
    lines = str(t.get("text", "")).split("\n")
    size = t.get("fontSize", 16)
    w = max(len(l) for l in lines) * size * CW.get(t.get("fontFamily", 2), 0.6)
    h = len(lines) * size * t.get("lineHeight", 1.25)
    return t["x"], t["y"], t["x"] + w, t["y"] + h


def main() -> int:
    data = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    els = [e for e in data["elements"] if not e.get("isDeleted")]
    by_id: dict[str, dict] = {}
    hard = []
    for e in els:
        if e["id"] in by_id:
            hard.append(f"duplicate id {e['id']}")
        by_id[e["id"]] = e
    for e in els:
        for key in ("startBinding", "endBinding"):
            b = e.get(key)
            if b and b.get("elementId") not in by_id:
                hard.append(f"{e['id']}.{key} -> missing {b.get('elementId')}")
        if e.get("containerId") and e["containerId"] not in by_id:
            hard.append(f"{e['id']}.containerId -> missing {e['containerId']}")

    shapes = [e for e in els if e["type"] in SHAPES and e.get("strokeStyle") != "dashed"]
    texts = [e for e in els if e["type"] == "text"]
    warn = []
    inside = 0
    free = []
    for t in texts:
        x1, y1, x2, y2 = text_box(t)
        host = by_id.get(t.get("containerId")) if t.get("containerId") else None
        if host is None:
            cands = [s for s in shapes if s["x"] <= x1 <= s["x"] + s["width"] and s["y"] <= y1 <= s["y"] + s["height"]]
            host = min(cands, key=lambda s: s["width"] * s["height"]) if cands else None
        if host is None:
            free.append((t, (x1, y1, x2, y2)))
            continue
        inside += 1
        ox = x2 - (host["x"] + host["width"])
        oy = y2 - (host["y"] + host["height"])
        if ox > 2 or oy > 2:
            warn.append(f"overflow {t['id']} by ({ox:.0f},{oy:.0f})px: {t['text'][:40]!r}")

    for i, (a, ba) in enumerate(free):
        for b, bb in free[i + 1:]:
            if ba[0] < bb[2] and bb[0] < ba[2] and ba[1] < bb[3] and bb[1] < ba[3]:
                warn.append(f"overlap {a['id']} / {b['id']}: {a['text'][:20]!r} vs {b['text'][:20]!r}")

    ratio = inside / len(texts) if texts else 0
    for h in hard:
        print("ERROR", h)
    for w in warn:
        print("WARN ", w)
    print(f"texts {len(texts)}, inside shapes {inside} ({ratio:.0%}, target under 30%), shapes {len(shapes)}")
    return 1 if hard else 0


if __name__ == "__main__":
    sys.exit(main())
