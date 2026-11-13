---
name: git-sync-after-merge
description: Use when the user says a PR was merged or asks to tidy git in a repo that has a fork remote (origin) and an upstream remote ("sudah saya merge", "sinkronkan git", "rapikan git local", "sesuaikan git setelah merge", "my PR was merged", "sync git"). Fast-forwards local main to upstream, pushes it to the fork, and deletes branches that are already merged, locally and on the fork, without force and without touching unmerged work.
argument-hint: "[repo-path]  (empty = current repo)"
---

# /git-sync-after-merge

Bring a fork-and-upstream repo back to a clean state after one or more PRs were merged: local `main`, the fork's `main`, and upstream aligned; merged feature branches gone. Report to the user in their language (`artrios/profile.md`).

Invoking this skill approves exactly these actions: fetch with prune, fast-forward of local `main`, push of `main` to the fork (`origin`), deleting merged local branches with `git branch -d`, and deleting merged branches on the fork. Nothing else.

## 1. Preflight

1. `git status -sb`. If the working tree has uncommitted changes, stop and list them. Never stash, reset, or discard.
2. Identify remotes: `origin` = fork, `upstream` = shared repo. If either is missing, stop and ask.
3. Base branch = upstream's default (`master` or `main`): `git remote show upstream | sed -n '/HEAD branch/p'`. Local branch to sync = `main` (create tracking `upstream/<base>` if absent and the user confirms).
4. `git fetch --all --prune`.

## 2. Read the state before changing anything

Show the user a short table:

| What | Check |
|---|---|
| Local branches | `git branch -vv` |
| Merged into `upstream/<base>` | `git branch --merged upstream/<base>` |
| Not merged | `git branch --no-merged upstream/<base>` |
| Fork branches | `git branch -r` (origin/*) |
| Alignment | `git rev-list --count` ahead/behind of `main`, `origin/main`, `origin/<base>` against `upstream/<base>` |
| Open PRs | `gh pr list --repo <upstream> --state open --json number,title,headRefName` (skip if `gh` is missing) |

A branch counts as merged only if it is in `--merged upstream/<base>` or `gh pr view <n>` says MERGED. Squash-merged branches look unmerged by commit: confirm through the PR state, then ask the user before using `-D`.

## 3. Sync

1. If the current branch will be deleted, `git switch main` first.
2. `git merge --ff-only upstream/<base>`. If it is not a fast-forward, stop and explain; never reset or rebase `main`.
3. `git push origin main` (plain push, never `--force`).

## 4. Delete merged branches

1. Local: `git branch -d <branch>` for each merged branch except the current one. Never `-D` without the user's yes for that branch.
2. Fork: delete each merged branch **one at a time** with `git push origin --delete <branch>`. A single multi-branch command fails entirely if one ref is already gone. Skip branches that no longer exist on the fork (`git fetch --prune` already dropped their refs).
3. Keep branches with an open PR and branches not merged. List them with the reason.

## 5. Verify and report

1. `git fetch --all --prune`, `git branch -a`, and the alignment counts again: `main`, `origin/main`, `upstream/<base>` must show 0 ahead and 0 behind.
2. Report: what was deleted (local, fork), what stays and why, final alignment. Mention separately, without acting, anything odd: a stale `origin/<base>` (the fork's own default branch behind upstream), unmerged branches, stashes (`git stash list`).

## Guardrails

- No `--force`, `reset --hard`, `clean`, `rebase`, or amend. No new commits.
- Never touch `upstream`, and never delete a branch with unmerged commits or an open PR.
- Never delete a stash or an untracked file.
- Aligning the fork's stale default branch (`origin/<base>`) is a separate push: ask first.
