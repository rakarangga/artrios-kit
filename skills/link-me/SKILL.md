---
name: link-me
description: Use when the user runs /link-me in a folder that is not yet registered with Artrios, to register the current folder directly from that session (project layer, registry row, route, auto-memory harvest, identity check). Global skill; works from any folder.
disable-model-invocation: true
argument-hint: "[name] [task-tracker project]"
---

# /link-me

Register the folder this session runs in with Artrios, without going back to the kit folder. Input: `$ARGUMENTS` = optional name and task-tracker project. Report in the user's language (`artrios/profile.md`).

The kit root (the folder holding `artrios/core.md`) is named in `artrios/profile.md` as `Kit root`. Below, `<kit>` means that folder.

## 1. Check the folder

1. Folder = the session's working directory. If it is `<kit>` itself: stop, the kit already runs the full router.
2. Already in `<kit>/artrios/registry.md`: report "already registered" with its row, and stop.
3. Inspect it: git repo or not (`git -C <folder> rev-parse`), remote, and purpose from its `README`/`CLAUDE.md`/`AGENTS.md`. Never read `.env`.
4. Not a project repo (Downloads, temp, a loose folder): say registration is meant for project repos and offer an inbox line in `<kit>/artrios/inbox.md` instead. Continue only on the user's yes.

## 2. Settle name and tracker project

Ask everything still missing in one question round (host question tool if available):
- **Name:** default the folder name.
- **Task-tracker project:** offer the matching one from the tracker named in `artrios/profile.md`, or "none yet". Do not create a tracker project here.

## 3. Install

1. Write `<folder>/CLAUDE.local.md` with this managed block (replace an existing block, keep other text):

   ```
   <!-- artrios:begin (managed by /link-me; edit artrios/project.md instead) -->
   @<kit>/artrios/project.md

   ## This project (Artrios)

   - Name: <name>
   - Tasks: <tracker project or "no project yet">
   - Registry: <kit>/artrios/registry.md
   <!-- artrios:end -->
   ```

2. Merge `<kit>` into `permissions.additionalDirectories` of `<folder>/.claude/settings.local.json` (keep other keys).
3. Add `CLAUDE.local.md` and `.claude/settings.local.json` to `<folder>/.git/info/exclude`. If either file is already tracked in the project repo, stop and ask the user.
4. Add one row to `<kit>/artrios/registry.md` (name, absolute path, tracker project, route).
5. Add one route row to the kit's project README (when to use → exact path → entry point, "Registered for Artrios (`artrios/registry.md`, <date>)"). Facts about the project stay in its own docs.
6. **Harvest auto-memory** of that folder (`~/.claude/projects/<mangled path>/memory/`): show each memory with a proposed home (project docs, kit, task tracker, wiki, or "already covered by `artrios/core.md`"), check stale claims against the repo, move only what the user approves, then leave pointers. Delete memory files only on the user's explicit yes; keep session histories (`*.jsonl`).
7. Identity check: a fresh `claude -p "Who are you and what is this project?"` run in the folder must answer as Artrios with the right name. Report a FAIL, do not ignore it.

Editing the kit from this folder may trigger permission prompts; that is expected.

## 4. Verify and report

- `git -C <folder> status --short` shows no Artrios files.
- Report in three to five lines: what was registered (name, tracker project), the identity-check result, harvested memory, and "start a new session in this folder so the project layer loads" (this session started before the layer existed).
- Ask once: `Commit in the kit repo?` with the registry and README files. Never commit Artrios files to the project repo; never push without the user's yes.

## Guardrails

- Never write secrets. No changes to the project's own files besides the two excluded local files.
- One folder per run. Registering other folders goes through `/link` in the kit folder.
