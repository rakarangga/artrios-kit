---
name: artrios-health
description: Use when the user runs /artrios-health to check that the Artrios layers are still true (installed core, registered projects, inbox, orphaned auto-memory). Read-only; reports findings and proposes fixes.
disable-model-invocation: true
rollout-phase: 1  # phase 1: run by hand and check every result first (level-up references/principles.md)
---

# /artrios-health

Run the Artrios health check by hand and explain it. Report in the user's language (`artrios/profile.md`). Read-only: the check never fixes anything.

If the install has a health script (`scripts/artrios_health.py`), run it and use its output. Otherwise check these by hand:

1. **Installed core:** the global core file read by the agent matches `artrios/core.md` in the source repo. Drift = the PC runs an older soul.
2. **Registry:** every row in `artrios/registry.md` has an existing path and a `CLAUDE.local.md` with the managed block.
3. **Inbox:** count open lines in `artrios/inbox.md` and the oldest date. Older than one month = DRIFTING; a folder that appears 3+ times is a registration candidate.
4. **Auto-memory:** in `~/.claude/projects/*/memory/`, flag folders whose project path no longer exists (orphaned) and memory that holds content instead of pointers.
5. **Task tracker backup:** if `artrios/profile.md` names a tracker, check that its newest backup is recent (skip when none).

Show a table: check | OK/WARN/FAIL | what it means | proposed fix. Apply a fix only after the user says yes.

Bike method phase 1: after two good manual runs the user checked, offer to schedule it (daily); advancing the phase is an explicit edit of this header.
