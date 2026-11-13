---
name: compact-project
description: Use when the user runs /compact-project <project name> to checkpoint a working session before compacting context. Checks docs and tasks for that project, updates the task tracker, kit docs, external project docs, the wiki, and memory pointers with what was discussed, suggests skills for approval, and asks before committing in each repo.
disable-model-invocation: true
argument-hint: "<project name | cross>"
---

# /compact-project

Save everything the session produced for one project into its durable homes, so the work can continue after `/compact` or in a fresh session without chat history. Input: `$ARGUMENTS` = project name.

Report in the user's language (`artrios/profile.md`). Follow `CLAUDE.md`/`AGENTS.md` routing and the precedence rule throughout. Paths and tools (kit root, decision log, tracker, wiki) come from `artrios/profile.md`.

## 1. Resolve the project

1. Match `$ARGUMENTS` against `artrios/registry.md`, the route tables in the kit's project README, the tracker's projects, and the folders of the project area. Run from a registered project folder (global copy of this skill): the folder's `CLAUDE.local.md` or its registry row gives the project; empty input means that project.
2. Write a one-line scope: tracker project, kit folders, external repos, wiki domain.
3. Empty or ambiguous name: ask once with numbered options. Never guess.
4. **Cross-project mode.** `$ARGUMENTS` = `cross`, or empty input outside any registered project when the session was not about one project. Use it for sessions about Artrios itself, a decision spanning projects, or a topic with no project yet. Differences from the normal flow:
   - Step 2: the ledger covers cross-project decisions, facts, and follow-ups only. Anything that belongs to one project is listed under "project: <name>" and left for `/compact-project <name>`.
   - Step 4: do only the tracker (any project), the decision log, `context/` pages and `priorities.md` when changed, `connections.md`/`references/`, memory pointers, and the inbox. Skip the project folder, external repos, and wiki unless a wiki page for a cross-project topic clearly needs it (read the vault `CLAUDE.md` first).
   - Step 8: only the kit commit question.
   - Report scope line reads `cross-project`.

## 2. Build the session ledger

Scan the conversation for this project only and list, before editing anything:

| Kind | What to capture |
|---|---|
| Decisions | What the user decided, with date and why |
| Facts | Verified facts (numbers, versions, prices, names), with source and date |
| Work done | Changes made, with verification evidence |
| Tasks | Started, finished, blocked, new follow-ups |
| Codes and terms | New short codes or names |
| Open | Questions waiting for the user, items marked [CHECK] |

Only confirmed items go to canonical pages. Proposals and guesses stay labeled as proposals.

## 3. Check docs and tasks

1. Read the current state of each route from step 1: the project README, canonical pages, the external repo's docs, the wiki domain index, the open tasks of the tracker project.
2. Mark what is stale, missing, or contradicted by the ledger.

## 4. Update, in this order

Make the smallest correct edit in each place. Skip a place when it has nothing new and say so in the report.

1. **Task tracker** (rules file named in `artrios/profile.md`). Invoking this skill approves:
   - moving items to the state the ledger proves
   - adding new follow-ups to Backlog, or to Todo when committed this week, with real due dates only
   - Cancelling, deleting, or changing someone else's item: ask first.
2. **Kit docs.**
   - `context/priorities.md`: only when a priority, milestone, or plan order changed.
   - `aios-intake.md`: when `context/about-me.md`, `about-business.md`, `priorities.md`, `connections.md`, or `references/voice.md` changed in a way its Q1-Q7 answers cover, update the matching answer too (the `context/` file stays the source of truth).
   - Decision log: append confirmed decisions (append-only).
   - Project folder: status, deliverables, open items.
   - `connections.md`, `references/`: new or changed access routes and dated successful reads.
   - `CLAUDE.md` + `AGENTS.md`: only for working rules, edited together, then `diff` them.
3. **External project docs.** First read that repo's `CLAUDE.md`/`AGENTS.md` and follow its rules: verified facts only, dates, secrets by location only. Docs only: no changes to live systems from this skill.
4. **Wiki** (the vault named in `artrios/profile.md`; skip when "none"). First read the vault's `CLAUDE.md`. Update pages instead of duplicating, mark superseded content, add new codes to the glossary, update the indexes if pages were added, and append a line to the vault log. Facts taken from this conversation follow the vault's rule for conversation sources; important or long material: write a session note to `<vault>/raw/YYYY-MM-DD-session-<topic>.md` (first line: "Claude summary of a session, not a source quote"; add, never edit existing raw files), then ingest it right away with `/ingest-wiki`. Never edit `raw/`.
5. **Memory.** Auto-memory holds pointers only. Add, update, or delete pointer files and the `MEMORY.md` index so they point at the files updated above. Delete pointers that are past their date. When run in a registered project, this is that project's auto-memory folder, not the kit's.
6. **Inbox** (`artrios/inbox.md`). Lines for this project's folder: move each confirmed finding to its home from this list, then remove the line. Findings that are not confirmed stay, marked `[CHECK]`.
7. **Activity** (`artrios/activity.md`). Append one line: `- YYYY-MM-DD | <machine> | <folder> | <one-line summary of what the session did>`. One line per closed session, newest last; no secrets. Cross-project mode: folder = the session's working folder.

## 5. Suggest skills (no creation)

Look at the session for a manual workflow done 2+ times, a multi-step routine that will recur, or friction with an existing skill. For each candidate, give: proposed name, trigger, what it does, and why. The user approves or skips. Do not create or edit skills here. If none, say "No skill suggestions."

## 6. Verify

- Never put a Windows backslash path inside a scripted string (python, perl, sed, heredoc): `\a`, `\v`, `\r` turn into control characters. Use the Edit/Write tool for such text, or build backslashes with `chr(92)`.
- Check every edited file: `grep -c $'\a\|\v\|\r' <file>` must be 0 for LF files; for CRLF files check `$'\a\|\v'`.
- If both manuals changed: `diff CLAUDE.md AGENTS.md` is clean.
- If `artrios/core.md` changed, reinstall the global copy by the kit's install steps.
- `git status --short` for every repo touched.

## 7. Report

1. Scope line (project).
2. Table: place | updated / no change / waiting for approval | short note with file link.
3. Tracker changes, by key.
4. Open items for the user (numbered), including [CHECK] items.
5. Skill suggestions.
6. Resume line: `Continue from: <next concrete step>`, so the next session starts there.
7. Commit questions (step 8).

## 8. Ask about commits (last step)

For each repo with changes worth committing (the kit repo and every external project repo touched), ask the user separately, one numbered question per repo, and list the in-scope files under each:

1. `Commit in the kit repo?`
2. `Commit in <external project repo>?`

Do not commit before the user answers yes for that repo. On yes, follow the `/commit-this` rules: stage only in-scope files, block secrets and unrelated changes, Conventional Commit, new commit only, never push. For an external repo, also follow its own `CLAUDE.md`/`AGENTS.md`. Changes that predate this session are listed separately and stay out unless the user includes them. Skip the question for a repo with nothing worth committing. Never commit the Artrios local files (`CLAUDE.local.md`, `.claude/settings.local.json`) to a project repo. Pushing is the user's call.

## Guardrails

- Never write secrets, tokens, private-system IPs, or `.env` values anywhere.
- Never send anything external: no messages, no pushes. Commit only after the user says yes for that repo (step 8).
- Never record a planned or assumed value as a fact. Unknown stays `[CHECK]`.
- Approval in the ledger must come from the user (or Artrios acting on the user's explicit instruction, logged).
