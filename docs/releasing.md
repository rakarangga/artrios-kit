# Releasing the kit

A release is a git tag `kit-vX.Y.Z` on `main`. Users update by tag (`docs/user-guide.md`, section Update). The UI Update button (AIOS-130) offers only tags: it appears when `git ls-remote --tags origin "kit-v*"` shows a tag newer than the installed `ui/package.json` version. So the tag and the `ui/package.json` version must match.

## Rule

A fix that must reach users needs a tag. A commit on `main` alone does not reach anyone.

## Patch release (X.Y.Z+1)

1. `main` is clean and up to date: `git status`, `git pull --ff-only`.
2. Tests pass: `cd ui && npm test`.
3. `CHANGELOG.md`: rename `## Unreleased` to `## kit-vX.Y.Z+1 - YYYY-MM-DD` and add a new empty `## Unreleased` above it. One line per user-visible change.
4. `ui/package.json`: set `version` to `X.Y.Z+1`.
5. Commit: `chore(release): kit-vX.Y.Z+1`.
6. Tag: `git tag -a kit-vX.Y.Z+1 -m "kit-vX.Y.Z+1"`.
7. Push the commit and the tag: `git push origin main` then `git push origin kit-vX.Y.Z+1`.
8. Check: `git ls-remote --tags origin kit-vX.Y.Z+1` shows the tag, and (if `gh` is set up) `gh release create kit-vX.Y.Z+1 --notes-from-tag` or a notes file.

Minor and major releases use the same steps with the number bumped accordingly.

## Fix a wrong tag

Never move a pushed tag. Release the next patch instead.
