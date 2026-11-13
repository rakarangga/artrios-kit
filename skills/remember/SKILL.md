---
name: remember
description: Use when the user runs /remember, with or without text, to save facts, decisions, or follow-ups right now to their durable homes (task tracker, decision log, context page, project docs, wiki, or inbox), without a full session checkpoint. With no text, Claude picks what is worth keeping from the conversation itself. Global skill; works from any folder.
disable-model-invocation: true
argument-hint: "[optional: what to remember; empty = I pick from the conversation]"
---

# /remember

Quick capture into the files that own the items. For a full project checkpoint use `/compact-project`. Input: `$ARGUMENTS`. Paths and tools (kit root, decision log, tracker, wiki) come from `artrios/profile.md`.

## 0. Pick what to remember

- **With text:** that text is the one item.
- **Empty (normal case):** do not ask what to remember. Scan the conversation since the last `/remember` (or the start) and pick the items that future sessions would otherwise lose:
  - decisions the user made, with the why
  - facts verified in this session (numbers, versions, names, paths, routes), with source
  - follow-ups the user agreed to
  - new terms or codes
  - corrections or preferences the user gave about how Artrios should work
- **Skip:** proposals the user has not accepted, guesses, chatter, anything already recorded (code, git history, existing pages), and anything only useful in this conversation. List skipped proposals in one line as "not saved: ..." so the user can overrule.
- Save without asking per item. Ask only when an item is ambiguous between two homes. Keep it small: at most about 5 items; more than that means the session needs `/compact-project`.

Report in the user's language. No secrets, tokens, private IPs, or `.env` values anywhere; if the item contains one, store the location only.

## 1. Classify

| Item is... | Home |
|---|---|
| A to-do or follow-up | Task tracker Backlog, in the right project (real due date only if given) |
| A decision (has a why) | The project decision log, append-only, format in that file |
| A verified fact about one project | That project's docs (registry row, its folder, or the repo's own docs) |
| A fact about the user, business, priorities | `context/about-me.md`, `about-business.md`, or `priorities.md`; also the matching Q1-Q7 answer in `aios-intake.md` |
| A tool or access route | `connections.md` or `references/` |
| Long-term knowledge, research, a "why" | The wiki named in `artrios/profile.md` (read the vault `CLAUDE.md` first; update a page, do not duplicate; append to its log). From conversation, follow the vault's rule for conversation sources; for important or long material write a session note into the vault's `raw/` folder (first line: "Claude summary of a session, not a source quote"; add, never edit existing raw files), then ingest it with `/ingest-wiki` |
| Unsure, or the current folder is not in `artrios/registry.md` | `artrios/inbox.md`: `- YYYY-MM-DD \| <folder> \| <finding>` |

Rules:
- Unconfirmed or guessed values are stored as `[CHECK]` or as a labeled proposal, never as fact.
- Do not store what the code, git history, or an existing page already records. If it is already there, say so and stop.
- Never put the content in auto-memory. Only add a pointer in `MEMORY.md` when the item is something future sessions must find fast (rare).

## 2. Write

1. Read the target first; make the smallest correct edit (update an existing line before adding a new one).
2. Date every entry with today's date (absolute, not "yesterday").
3. Backslash paths: use the Edit/Write tool, not scripted strings (`\a`, `\v`, `\r` turn into control characters).
4. If `CLAUDE.md` or `AGENTS.md` changed, edit both together and `diff` them.

## 3. Report

One line per saved item: `<file link or task key> : <one-line summary>`. Then:
- `Not saved: <proposals or unclear items>` (omit when none)
- `Not committed.` (never commit or push here; suggest `/commit-this` or `/compact-project` if more is pending)

## Guardrails

- Light capture only: at most about 5 items per call. A whole project session, wiki updates across many pages, or commits: point to `/compact-project`.
- Never send anything external. Never touch tracker items other than adding a new one.
