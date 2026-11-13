---
name: task-review
description: Use when the user runs /task-review [backlog|todo|progress|cancelled|all] [PROJ] to review tasks per status. Shows one table per status (never Done) with each task, why it is in that status, and a proposal, based on evidence. Read-only until the user approves changes; applying follows the /task-sync rules.
disable-model-invocation: true
argument-hint: "[backlog | todo | progress | cancelled | all] [project key]"
---

# /task-review

Explain the task board, status by status. For each open (or cancelled) task: why it sits where it does, and what to do with it. Input: `$ARGUMENTS` = a status (`backlog`, `todo`, `progress`, `cancelled`, or `all` = the first three), optionally a project key. Default: `all`, every project. **Done is never shown.**

Report in the user's language (`artrios/profile.md`), short. The task tracker, its wrapper script, and its state rules are named in `artrios/profile.md`.

Difference from `/task-sync`: `/task-sync` hunts for tasks whose state is wrong and proposes only changes. `/task-review` walks every task in the chosen status so the user understands the board. Both apply changes only after approval.

## 1. Read

- List open tasks (Backlog, Todo, In Progress) with the tracker wrapper. Cancelled tasks are usually not in the list command: for `cancelled`, show the keys named in notes or in the user's question, or say the list command does not cover it.
- Show the full task for items whose reason is not obvious from the title.

## 2. Find the reason per task

Short evidence, in this order, only as far as needed: this session, the task's own notes, the project's decision log, the project README, the priorities file, external repo docs (never `.env`), a cheap read-only check (a file exists, a config line).

Typical reasons:
- **Backlog:** not committed this week; waiting on the user or another person; needs approval; quarterly target not yet started; idea.
- **Todo:** committed this week; due date; blocked by another task.
- **In Progress:** what is moving and what is left; flag if more than 3.
- **Cancelled:** what replaced it.

## 3. Show

One table per status, in this order: In Progress, Todo, Backlog, Cancelled.

| Task | Prio/due | Reason | Proposal |

- `Proposal`: keep, move (to which status), done, cancel, rename, split, add a due date (only a real deadline), or "user decides". One line.
- Mark overdue tasks (`OVERDUE`) and urgent tasks due within 48 hours.
- No evidence: write `[CHECK]` instead of guessing.

End with a numbered list of only the decisions the user needs to make.

## 4. Apply (only after approval)

Same as the `/task-sync` apply step: a dated note with the evidence first, then `move` / `done` / `rename` / `due`; cancel, rename, and other people's tasks only with an explicit yes. Never delete.

## Guardrails

- Task tracker only. No docs, wiki, or memory edits (use `/compact-project`).
- Never write secrets into task notes.
