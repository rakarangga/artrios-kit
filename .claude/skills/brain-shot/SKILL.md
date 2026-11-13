---
name: brain-shot
description: Use when working on the Brain screen of the Artrios UI (ui/client/src/views/Brain*.jsx) and the change must be seen or timed ("cek tampilan brain", "screenshot brain", "ada glitch saat pindah tab", "ukur delay transisi"). Screenshots every Brain tab of a running UI with headless Chromium and measures the longest frame gap after each tab click, then shows the images. Project skill of artrios-kit.
---

# /brain-shot

Look at the Brain screen the way a user does, without asking them for screenshots: one image per tab and the stall after each tab click.

## 1. Have a running UI with the new build

1. Build the client in the install that serves the UI: `node node_modules/vite/bin/vite.js build client` (prefer this to `npx vite build`, which can hang when an old build process is left over; kill that process first).
2. The server serves `client/dist` from disk, so a running server needs no restart after a client build. A server change does: restart it from the install folder, never from the template.
3. Take the address from the server's own output (for an install started in the background, its `data/server.log`). The UI asks for a sign-in: ask the user to put the password in `ARTRIOS_PASSWORD` for the run (for example `! $env:ARTRIOS_PASSWORD = '...'` is not kept between commands, so let them run the whole command with `!`). Never write the password into a file, a log, or the conversation.

## 2. Run

```
python .claude/skills/brain-shot/shot.py --url "http://127.0.0.1:<port>/" --out <scratch folder>
```

with `ARTRIOS_PASSWORD` set in that same command's environment.

Options: `--tabs "Areas,Rings"` for a subset (order matters: each tab is entered from the one before), `--wait 2500` ms watched per tab, `--light` for the light theme. Needs Python Playwright with Chromium. Run one copy at a time, and not while `npm test` runs: a busy machine inflates the timings and makes the job tests time out.

## 3. Read the result

- Open each `brain-<tab>.png` with the Read tool and compare with what was asked (for design work, the reference images the user named).
- Per tab the script prints `frames`, `firstFrameMs`, `maxGapMs` and page errors. `maxGapMs` is the visible freeze after the click: under about 100 ms reads as smooth; several hundred ms is a stall worth fixing (heavy layout on click, React re-rendering many SVG elements per frame, a library loading on first open).
- The 3D tab renders on SwiftShader here, so its numbers are an upper bound; on a real GPU it is faster.
- A page error makes the script exit 1: report it with its text.

## 4. Report

One line per tab (looks right or not, stall in ms), the images that show a problem, and what to change. Do not claim a fix works until a new run shows it.
