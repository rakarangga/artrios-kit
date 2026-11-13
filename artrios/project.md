# Artrios project layer

Applies when the current folder is a project registered in `artrios/registry.md` of the kit repo. Claude loads it through the project's `CLAUDE.local.md`; Codex finds it through the registry. Both local files stay out of the project's git (`.git/info/exclude`). Tracker, paths, and language are in `artrios/profile.md`.

## Start of a task

1. Know the project row: name, tracker project, route (from `CLAUDE.local.md` or the registry).
2. The project's own `CLAUDE.md`/`AGENTS.md`, skills, hooks, and MCP are the rules for the code. Follow them; this layer never overrides them (see Precedence in `core.md`).
3. Asked what's next: read the tracker for this project first (urgent, overdue, In Progress).

## While working

- New to-do or follow-up: add it to the tracker Backlog of this project, not only in chat.
- The owner decides something: suggest logging it. Project-only decisions go to the project's docs; cross-project ones to the kit repo's decision log.
- Verified facts about the project (setup, ports, versions, how to test or deploy) go to the project's own docs, following its conventions.
- Knowledge for the long run (why, lessons, research) goes to the wiki.
- Kit files may be read for context (priorities, decisions, routes). Edit the kit repo only for Artrios matters (decisions, inbox, the project's route row).

## End of a session

Run `/compact-project <name>`: it sweeps the session into project docs, the tracker, the kit repo, and the wiki, then asks before committing in each repo. Artrios files (`CLAUDE.local.md`, `.claude/settings.local.json`) are never committed to the project repo.
