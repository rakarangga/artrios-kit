# Changelog

Format follows Keep a Changelog. Versions are tags `kit-vX.Y.Z`.

## Unreleased

## kit-v0.2.1 - 2026-11-13

- UI: Update button. When a newer release tag (`kit-vX.Y.Z`) exists on the kit's origin, the header shows **Update vX.Y.Z**; it opens a Putusan case with the CHANGELOG, then Update switches the kit to the tag, rebuilds skills and UI, and restarts the service. Your own files (`profile.md`, `registry.md`, `inbox.md`, `activity.md`) are backed up to `~/.artrios/backup/` and put back; a failed update rolls back to the previous version. Commits on `main` after the last tag show only as "N unreleased commits", without a button. Also `python install.py --update kit-vX.Y.Z`.
- `install.py --apply` rebuilds `apps/artrios-ui` (scaffold, npm install, build) when its version differs from `ui/`, keeping `data/`, port and password; a running service is stopped and started again. The manual wizard step in the update guide is no longer needed.
- Attribution audit of the 20 core skills done (`docs/attribution-audit.md`): only `excalidraw` carries third-party material and it is credited. The git history still holds removed third-party files and a client pack, so the first public release is made from a clean copy.

## kit-v0.2.0 - 2026-11-13

- UI: Cognition, the chat that replaces the CLI (route `/cognition`, own tab or panel). Sessions per workspace with chat data in `.artrios/chat`, usage and a context bar per session, a warning at 100k context with Compact and New session buttons, auto-compact, default pins, ask-me questions as a chat card, Add folder for extra folders, a workspace picker in the own-tab chat, and a toggle to hide the sessions sidebar. Insights is the same chat per workspace. The API engine works like the claude engine, and switching engine carries a summary over.
- UI: Prompt Suggestions in Cognition: reply chips, accepted with a click or Tab. Off by default; model and effort are set in Settings > Prompt Suggestions.
- UI: Settings > Microphone: dictation hotkey, hands-free, and push to dictate for Cognition.
- UI: Decision Required, the approval queue: decisions and approval requests as cards with the consequence of each choice, a preview, a sidebar badge, and the `inboxOnDecide` hook that applies a decision after the click. "Waiting for you" items can be acted on.
- UI: Routines replaces Today: schedules and agent profiles on one screen. The scheduler is its own process; `npm start` starts the UI and the scheduler together.
- UI: Brain is layered (Rings, Areas, Links, 3D Orbit) from the area signal files, with the hierarchy area > entity > kind, zoom, pan, full screen, and ring animation. New skill `brain-shot`.
- UI: tasks. `client` replaces `hat` on cards, in the CLI, on the board, and in Add workspace; a task snapshot from an outside tool can be read and imported into cards; `artrios-task` covers what the old tracker CLI did; the board scrolls per column at window height.
- UI: a card can start without a skill, and the Start dialog picks the provider and model per job. New Anthropic API provider. The usage dialog hides plan limits for API-provider chats.
- UI: Settings > Model redesigned: provider catalogue, model list read from the provider, two-column model picker.
- UI: Connect GitHub from the UI; side panels slide in from the right; new Artrios logo and icons.
- UI: the default inbox user is the signed-in account; no personal names remain in the kit.
- `/onboard`: the default task tracker is the Artrios board; no external tracker is offered.
- UI: git and worktrees from the UI (S11). Worktrees screen with one card per worktree (summary against the base branch, linked cards) and Check for Conflicts, Merge to main, Create PR, Copy Path, Delete, New worktree at `.artrios/worktrees/<branch>`, open in Cognition or a terminal; "Run in worktree" on a card gives it its own branch `artrios/<key>` and worktree; Settings > Git (identity, credential helper and gh status, Test connection, push switch off by default); Fetch and Pull (`--ff-only`). Agents never push: their git push fails by configuration and is logged.
- UI: sign-in replaces the one-time `?t=` link. One account, `administrator`, no roles: `npm run password` (asked by the installer) sets it, the first sign-in forces a new password, five wrong passwords lock it for 15 minutes, sessions are an in-memory `HttpOnly SameSite=Strict` cookie. Without a session every page is the sign-in page (401) and every API call and WebSocket is 401. Optional `"host"` (LAN address) and `"allowedHosts"` open the UI to other devices behind the same sign-in. Settings gains Account (change password, sign out) and Terminal. Agent Terminals is now off by default and switched on from Settings with a warning; the switch, terminal sessions and sign-ins go to `data/audit.jsonl`. An existing install must run `npm run password` once before `npm start`, and set `"terminal": true` (or use Settings) to keep the terminal.

- UI: "project" is now "workspace" in every visible label (sidebar, picker, Add workspace dialog, empty states, Insights, Overview, Review) and in the UI docs. Code identifiers, file names, API routes (`/api/projects`), JSON keys, and data files (`data/projects.json`, `.artrios/project.json`) are unchanged.
- `/os-audit` is now the kit's own audit: it also tests connections with a read, checks that scheduled jobs ran and that key workflows produce output, and tracks findings in `audits/findings.md` until closed. No score. `/os-audit followup <ID>` replaces `/audit-followup`.
- Removed `audit` and `audit-followup` from the core (20 core skills).
- Rewrote `level-up`, `onboard`, `grill-me`, `link`, and the intake in this kit's own words and structure. `references/3ms-framework.md` became `references/principles.md`; the figures without a source are gone; a new artifact's field is now `rollout-phase`. No AIS-OS file remains; NOTICE keeps a credit and the MIT text.
- UI: Brain screen rewritten from scratch in React with the app's theme (light and dark), replacing the iframe of the AIS-OS 3D Brain template: 3D graph, search, source legend, note panel, inventory, rotate. The cinema and demo modes and the `codex-memory` source type are gone. `data/brain.config.json` keeps working.
- Installer: one-line bootstrap (`install.sh`, `install.ps1`) that clones a tag to a fixed folder and starts the wizard; `install.py --wizard` (provider, core and skills, UI, seven-question form) and `--uninstall`. `install.py` without flags still only shows a dry run.
- UI runs without a CLI: new OpenAI-compatible adapter with its own tool loop (`ui/server/providers/`, wire format behind one transport interface). Tools: Read, Grep, Glob, Write, Edit inside the project; Bash only for prefixes in `allowedTools`, without a shell. The claude command stays available as a provider, and terminals always use it.
- UI: Settings > Model adds, tests, removes providers and picks the primary. Settings live in `artrios/providers.yaml`, keys in `~/.artrios/.env`. There is no hidden default. Installs without `providersFile` in `data/config.json` keep running `claude` as before.
- NOTICE: AIS-OS (MIT) credited with the list of copied, adapted, and rewritten files, including the 3D Brain code; notice headers added to copied skill files.
- Removed the bundled client pack (`packs/`): client packs now live in separate private repositories.
- `install.py`: `--pack PATH` replaces `--client NAME`; it installs `skills/*` from any pack folder.
- Added `LICENSE` (Apache-2.0), `NOTICE`, `SECURITY.md`, and this changelog.
- Added `ui/`: the local web UI (Node server, React, Tailwind 4 and shadcn/ui components, light and dark themes). Install it with `/artrios-ui`.
- UI: the Overview page merges Activity, Changelog, Context and MCP (shortcut O); the Roadmap screen is hidden until an AI-generated roadmap exists.
- UI: Insights answers render Markdown (tables, lists, code), type in word by word, show progress with seconds and play short chat sounds; Ideation plays a sound when Generate finishes.
- UI: Insights and Ideation start `claude` without MCP servers; terminal and job children no longer inherit the parent Claude Code session variables; Open in VS Code reports a failed launch.
- UI: the Browse folder dialog opens in front of the browser window.
- UI: new Brain screen (shortcut B), the 3D knowledge graph merged from the standalone 3D Brain app: `ui/brain/` (renderer) and `ui/server/brain/` (graph builder, read-only API under `/api/brain/`, behind the same token guard). Configure sources in `data/brain.config.json`.

## kit-v0.1.3 - 2026-11-02

- Verified `install.py`, `/link-me`, and `/onboard` (fictional persona) in a temporary home.
- Rewrote the "Three Ms" material in `level-up` and `onboard` in this kit's own words; removed third-party copyright tags.
- Release checker skips files ignored by git.

## kit-v0.1.2 - 2026-11-02

- Added core skill `analisa-trace-playwright` (21 core skills).

## kit-v0.1.1 - 2026-11-01

- Added `audit`, `audit-followup`, `commit-this`, `grill-me`, `level-up` to the core (20 core skills).

## kit-v0.1.0 - 2026-11-01

- First release: 15 core skills, one client pack, `artrios/core.md`, `project.md`, `profile.md`, `install.py`, bilingual README.
