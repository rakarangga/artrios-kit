---
name: codex-check
description: Use when the user runs /codex-check [folder ...], or right after artrios/core.md or artrios/registry.md changed, to verify that Codex recognizes Artrios (name, language, registry row, task project, a safety rule) from given folders. Read-only; costs Codex tokens.
disable-model-invocation: true
argument-hint: "[folder ...] (default: a scratch folder plus every registry path)"
---

# /codex-check

Ask Codex, read-only, who it is in a folder and compare the answer with `artrios/registry.md`. Origin: Codex did not read the registry on its own; the fix lives in `artrios/core.md`. Report in the user's language (`artrios/profile.md`).

## 1. Pick folders

- Arguments given: those folders.
- None: one scratch folder (an empty folder in the scratchpad, expected "not registered") plus each path in the registry `| Name | Path |` table (not `## Retired`).
- Ask first when more than 4 folders: each call costs about 7-20 thousand Codex tokens.

## 2. Run

Find the CLI: `codex` on PATH, otherwise the newest `codex` executable under the Codex install folder of the OS (the hash folder changes with updates). Per folder, with a 280 s timeout:

```bash
"$CODEX" exec -s read-only [--skip-git-repo-check for non-git folders] -C "<folder>" '<PROMPT>'
```

PROMPT (keep it fixed so results are comparable):

> Answer in at most 6 lines, without running any command that changes anything: (1) what is your name on this PC, (2) which reply language is required, (3) is this working folder registered in the Artrios registry and which row, (4) its project context, (5) its task-tracker project, (6) one safety rule that applies.

Use only the last answer block of the output (Codex prints it twice).

## 3. Compare

Expected per folder: name Artrios; the language in `artrios/profile.md`; registered or not exactly as the registry says (a parent row counts); project and tracker project from that row; a safety rule from core (`.env`, secrets).

## 4. Report

| Folder | Name | Language | Registry | Project | Tracker | Safety | Result |

`Result` = Pass, Half (which item failed), or Fail. For a failure, name the likely owning file (`artrios/core.md`, the registry row, or the folder's own `AGENTS.md`) and propose the fix; change it only after the user approves, then rerun that folder. Add the total tokens used.

## Guardrails

- Read-only sandbox always. Never pass `--dangerously-bypass-approvals-and-sandbox` or a write sandbox.
- Do not ask Codex to read `.env` or secrets; the prompt above is the only prompt unless the user asks for another.
- A task-tracker note is optional: only when the check closes or reopens a task, and only after the user says so.
