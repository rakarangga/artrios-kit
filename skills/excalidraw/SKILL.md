---
name: excalidraw
description: Use when the user asks for an Excalidraw diagram or deck ("make an excalidraw diagram", "architecture with a diagram", "flow diagram", "excalidraw deck", "excalidraw slides for a video"), or when a doc (architecture, flow, PRD) needs a diagram file. Builds .excalidraw files with a JS toolkit, renders them to PNG with headless Chromium, and fixes what the render shows before handing over. Global skill; works from any folder.
---

# Excalidraw diagram and deck

Adapted from the Excalidraw-Deck skill by Brennan Wells (MIT, `bwells271/AI-Automation-Network` branch `Excalidraw-Deck-Skill`, commit 015ddbb).

`<skill>` below = the folder holding this SKILL.md (`~/.claude/skills/excalidraw` or `~/.codex/skills/excalidraw` after install).

## Two modes

| Mode | When | Output |
|---|---|---|
| **diagram** (default) | Architecture, flow, system map for a doc | one `<name>.excalidraw` + `<name>.png` + `<name>.build.mjs` beside the doc that uses it |
| **deck** | Teaching or presentation, recorded while panning | `<dir>/slide-NN.excalidraw` + PNG, `<dir>/deck-combined.excalidraw` |

Place output in the project that uses it (its docs or deliverables folder). Never inside the skill folder.

## Rules

- **Argue, not display.** The shape carries the meaning. Isomorphism test: with all text removed, does the structure still say something? Read `references/diagram-methodology.md` once per session before drawing: pattern library, container discipline, shape meaning, multi-zoom, evidence artifacts, quality checklist.
- **Free text first.** Under 30% of texts inside shapes. Labels, notes, and descriptions float; shapes only for things arrows connect to or whose shape means something.
- **Multi-zoom for technical diagrams:** a summary flow, labeled section boundaries (`zone()`), and detail inside sections. Use real names (repos, commands, ports, products), never generic "API" boxes.
- **Long explanations go to a numbered legend or the doc**, not into boxes. Number arrows (1, 2, 3) and explain them once.
- **Never invent facts.** Every label traces to the conversation, a file, or a cited source. Mark drafts in the title ("draft, not approved").
- **Language:** the user's language (`artrios/profile.md`); product and technical names as they are. No em dashes.
- **Palette:** `dark` is the default. Use `light` only when a white page is required. A client with brand colors adds its palette through its client pack. All in `references/palettes.md`; no other hues.
- **Deck mode only:** no frames or slide background rectangles; every slide = title + one short line + one real diagram, never bullet lists; no repeated pattern on adjacent slides; title and recap slides still carry a motif diagram; slide count follows the material.

## Process

1. **Plan before coordinates.** List the sections (diagram) or slides (deck): the one idea, the visual pattern, the evidence to show. Check pattern variety. Ask the user only if scope is unclear.
2. **Author a build script** `<name>.build.mjs` beside the output:
   ```js
   import { usePalette, C, canvas, zone, text, rect, ellipse, diamond, label, line, arrow, dot, code, writeDiagram }
     from 'file:///<home>/.claude/skills/excalidraw/references/builder.mjs'; // absolute file URL
   usePalette('dark'); // default
   canvas(() => {
     zone(0, 0, 800, 600, '1. LAN kantor', { stroke: C.startS });
     const asf = rect(40, 80, 300, 120, { fill: C.primaryF, stroke: C.primaryS, id: 'asf' });
     label(asf, 'ASF');
     // ...
   });
   writeDiagram('arsitektur.excalidraw');
   ```
   Deck: same palette rules, one `slide(() => { head(...); ... })` per slide in local 1920x1080 coords, then `writeDeck('<dir>')`.
   Give shapes descriptive `id`s. Bind arrows with `startEl`/`endEl` so they follow shapes when the user edits by hand. Build a large diagram one section per edit, not in one pass.
3. **Run:** `node <name>.build.mjs`, then `python <skill>/references/check_layout.py <file>` (duplicate ids, broken bindings, overflow, overlaps, container ratio).
4. **Render and look (mandatory):** `python <skill>/references/render_excalidraw.py <file> --width 2600 --scale 1` (deck slides: defaults), then **Read the PNG**. Check against the plan first (structure, pattern, eye flow, hierarchy), then defects: clipped text, overlaps, arrows crossing shapes or text, labels not anchored, uneven spacing, lopsided composition, text too small. Fix in the build script, rebuild, re-render. Usually 2-4 passes. Never hand over an unrendered diagram.
5. **Hand over** the `.excalidraw` path, the PNG path, and a note that hand edits in Excalidraw are overwritten if the build script is rerun (edit the script, or stop using it after hand edits).

## Setup (once per machine)

```bash
python -m pip install -r <skill>/requirements.txt
python -m playwright install chromium
node --version   # any modern Node; builder.mjs only uses node:fs and node:path
```

Rendering loads `@excalidraw/excalidraw@0.18.0` from esm.sh, so it needs internet. Opening: excalidraw.com (Open, load from file), the Excalidraw desktop app, or Obsidian with the Excalidraw plugin.

## Lessons

- First architecture diagram: the first version put every sentence inside boxes (container ratio near 100%), used a Python generator without bindings, and shipped without rendering; arrows crossed boxes until boxes were moved by guesswork. This skill exists to stop that: plan sections, free text, legend for long explanations, render and Read the PNG before handing over.
- Dark palette looked light when opened: Excalidraw in dark mode inverts canvas colors. `builder.mjs` now writes `appState.theme: 'light'`; if a viewer still inverts, switch the viewer (Obsidian or excalidraw.com) to light mode. The PNG is unaffected.
