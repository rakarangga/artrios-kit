---
name: task-sync
description: Use when the user runs /task-sync [PROJ] to sync the task tracker with what is already known. Reads open tasks, checks each against evidence (this session, decision log, project docs, external repos, task notes), proposes status, title, and note changes in one table, applies them after approval, and reports overdue and urgent items. Task tracker only; no docs, wiki, or memory edits.
disable-model-invocation: true
argument-hint: "[project key]  (empty = every project)"
---

# /task-sync

Make the task tracker match reality. The tracker is the source of truth for tasks, so a task that was discussed, finished, merged, or superseded must not stay in its old state. Input: `$ARGUMENTS` = a project key, or empty (every project).

Report in the user's language (`artrios/profile.md`). The tracker, its wrapper command, and its rules for states, priority, and due dates are named in `artrios/profile.md`. If it names no tracker, say "no tracker configured" and stop.

Companion to `/compact-project`: that skill saves one project's whole session (docs, wiki, memory, tracker). This one touches **the tracker only**, across one or more projects.

## 1. Read open tasks

List open tasks (Backlog, Todo, In Progress) with the wrapper. For any task whose state might change, read its notes.

## 2. Check each task against evidence

Look, in this order, and only as far as needed:

1. This session: what was decided, done, verified, merged, or dropped.
2. The project decision log (latest entries first).
3. The project folder (README) and canonical pages (priorities file, connections file).
4. External repos named in the project's route tables: read docs only. Never read `.env`.
5. The task's own dated notes.
6. A cheap direct check when one settles it (a file exists, a line is in a config, a commit exists). Read-only.

For each task, decide one of:

| Finding | Proposal |
|---|---|
| Work finished and verified | `done` |
| Work started or partly done | `progress` (respect the limit of max 3 In Progress; say if it is exceeded) |
| Committed for this week | `todo` |
| Not started, no commitment | stays `backlog` |
| Superseded, merged into another task, or no longer wanted | `cancelled` (ask; name the replacing task) |
| Title no longer matches the agreed scope | rename (ask) |
| Status right but new facts exist | add a dated note |
| Two open tasks cover the same work | name both, propose which to keep (ask) |

Evidence must be concrete: a file and line, a commit, a dated note, a verified command. No evidence means no change. Unknown stays as is and is listed as `[CHECK]`.

## 3. Show the proposal

One table, only tasks with a proposed change:

| Task | Now | Evidence | Proposal |

Below it, list:
- Overdue tasks and urgent tasks due within 48 hours.
- In Progress count, if above 3.
- Tasks checked with no change: one line with their keys, not a row each.

Then ask once (AskUserQuestion when available): apply all, apply state moves only, or none. The user can also name single tasks.

## 4. Apply after approval

- Move or complete the task; add a dated note with the evidence first (`<date> task-sync: <evidence>`).
- Rename only when approved.
- Due dates only for real deadlines; never invent one.
- Never delete a task. Never change a task assigned to someone else without asking.
- New follow-ups found during the check: add to Backlog, or Todo when committed this week.

## 5. Report

1. Scope line.
2. Changes made, by key (old state → new state, or note/rename).
3. Overdue and urgent list.
4. Open `[CHECK]` items for the user.
5. One next step: the most urgent open task.

## Guardrails

- Tracker only: do not edit project docs, the wiki, external repos, or memory here (use `/compact-project` for that).
- Never write secrets, tokens, or `.env` values into a task note.
- Never send anything external (messages, reports).
- Approval comes from the user. Invoking this skill approves nothing by itself.
