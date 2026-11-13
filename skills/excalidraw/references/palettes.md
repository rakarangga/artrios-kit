# Palettes

Single source of truth for colors. `builder.mjs` holds the same values in `PALETTES`; edit both together. Pick one palette per file with `usePalette('<name>')`. Keep to about 3 strong colors per view; lean on text colors for hierarchy.

| Palette | Use for | Canvas | Font |
|---|---|---|---|
| `light` | Plain diagrams where a white page is required (print, PR descriptions) | `#ffffff` | 2 (Helvetica) |
| `dark` (default) | Everything unless another palette is asked for: diagrams, decks, recordings | `#0b0018` | 3 (monospace) |

The `dark` palette comes from the upstream skill's style (AI Automation Network, Brennan Wells). It is Artrios' default look; never present it as a client brand. A client with its own brand colors adds a palette through its client pack.

## Semantic shape colors

Rule on light canvases: light fill + darker stroke + dark text. Rule on dark canvases: saturated fill + lighter stroke + white text.

| Purpose | `light` fill / stroke | `dark` fill / stroke |
|---|---|---|
| Primary / hero | `#d0ebff` / `#1971c2` | `#FF2FB3` / `#FF8AD4` |
| Secondary | `#e5dbff` / `#6741d9` | `#B010B8` / `#DD72E2` |
| Neutral panel | `#f1f3f5` / `#868e96` | `#3A2154` / `#8B6BA8` |
| Start / input | `#d3f9d8` / `#2f9e44` | `#6D28D9` / `#B79CF0` |
| End / output | `#c3fae8` / `#0c8599` | `#0E7C6B` / `#4FD1B5` |
| Decision | `#fff3bf` / `#f08c00` | `#B45309` / `#F0B064` |
| AI / agent | `#f3d9fa` / `#9c36b5` | `#7C2FB0` / `#DD72E2` |
| Danger / human gate / forbidden | `#ffe3e3` / `#e03131` | `#B91C1C` / `#F08A8A` |
| Inactive (dashed stroke) | `#f8f9fa` / `#adb5bd` | `#3A2154` / `#6B5A80` |

## Text hierarchy

| Level | `light` | `dark` |
|---|---|---|
| Title | `#1e1e1e` | `#FFFFFF` |
| Subtitle / kicker | `#1971c2` | `#DD72E2` |
| Body / detail | `#495057` | `#B8A0C4` |
| Accent (one word or number) | `#e03131` | `#FF2FB3` |

## Lines and evidence panels

| Item | `light` | `dark` |
|---|---|---|
| Neutral arrow | `#495057` | `#DD72E2` |
| Structural line (tree, timeline, divider) | `#adb5bd` | `#8B6BA8` |
| Marker dot | `#1971c2` | `#FF2FB3` |
| Code / JSON panel bg / stroke | `#f8f9fa` / `#dee2e6` | `#1A0E26` / `#4A2E63` |
| Code text base / string / key | `#1e1e1e` / `#2f9e44` / `#9c36b5` | `#E6D8F0` / `#4FD1B5` / `#DD72E2` |

## Do not

- Invent hues outside this file. A concept with no category uses Neutral or Secondary.
- Use transparency (`opacity` stays 100).
- Mix palettes in one file.
