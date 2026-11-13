---
name: gl
description: Use when the user runs /gl <project-name> to see a readable git log graph of one project repo (git log --oneline --all --graph --decorate), limited to the last 10 commits. Read-only.
disable-model-invocation: true
argument-hint: "<project-name> (a registered project, a folder name, or empty = the current repo)"
---

# /gl

Show the git history of one project as a compact graph (`git log --oneline --all --graph --decorate`), limited to 10 commits. Input: `$ARGUMENTS` = project name. Read-only: never fetch, pull, switch, or change anything.

## 1. Find the repo

Take the first folder that has a `.git`:
1. The current folder, when `$ARGUMENTS` is empty or equals its name.
2. The `Path` of a row in `artrios/registry.md` whose name matches.
3. A sibling folder of the current repo with that name.

None found, or more than one match: list the candidates and ask once.

## 2. Run

```bash
git -C "<repo>" log --oneline --all --graph --decorate -10
```

## 3. Report

Reply in the user's language (`artrios/profile.md`), exactly this shape:

1. One line: `Last 10 commits for <name> (<repo path>):`
2. The raw output in one code block, unchanged (no prompt line, no trimming, branch and tag names kept). A repo with only one branch shows only `*` lines; that is correct.
3. Two or three short lines in plain words:
   - the shape of the history (straight on one branch, or merges/branches) and where `HEAD` is; any revert or diverged branch;
   - whether the local main branch matches `origin` (and `upstream` if any): ahead/behind counts from `git -C "<repo>" status -sb`, and which commits are not pushed yet;
   - uncommitted files as a count (`git -C "<repo>" status --short`), with what they are if known from this session.

Repo not found: say so in one line.
