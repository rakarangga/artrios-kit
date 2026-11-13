---
name: release-patch
description: Use when a fix or change in artrios-kit must reach users ("rilis patch", "tag baru", "release kit", "bump versi"). Bumps CHANGELOG and ui/package.json, commits, tags kit-vX.Y.Z, pushes the tag after the user confirms, and checks the remote. Project skill of artrios-kit.
---

# /release-patch

Follow `docs/releasing.md`. Steps:

1. Check `git status` is clean and on `main`; read the newest `kit-v*` tag and the commits since (`git log <tag>..HEAD --oneline`). No commits since: stop, nothing to release.
2. Run `cd ui && npm test`. Failing tests: stop and report.
3. Pick the next version (patch by default; ask only if the commits look like a feature or a breaking change).
4. Edit `CHANGELOG.md` (Unreleased becomes the new version with today's date, add an empty Unreleased) and `ui/package.json` version. Show the CHANGELOG entry.
5. Commit `chore(release): kit-vX.Y.Z`, then tag `kit-vX.Y.Z` (annotated).
6. Pushing is outward-facing: ask the user before `git push origin main` and `git push origin kit-vX.Y.Z`.
7. Verify with `git ls-remote --tags origin kit-vX.Y.Z` and report.

Never move or delete a pushed tag; release the next patch instead.
