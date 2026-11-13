# Attribution audit (AIOS-141, 2026-11-13)

Scope: the 20 core skills in `skills/` at `main` (bdb5016), plus `artrios/`, `docs/`, `ui/`, `NOTICE`, `README.md`.

## Result of the current tree

| Check | Result |
|---|---|
| Core skills counted | 20 (the older "21" in the changelog predates removing `audit` and `audit-followup`) |
| Third-party material in skills | Only `excalidraw` (builder.mjs, diagram-methodology.md, palette style): Brennan Wells, MIT, commit 015ddbb. Credited in `NOTICE` item 1, in `skills/excalidraw/SKILL.md`, and in the README. Changes are marked `[Artrios]` |
| AIS-OS (Nate Herk) remnants | None in `skills/`, `artrios/`, `docs/`, `ui/` (search for "AIS-OS", "Nate Herk", "Three Ms", "mindset", copyright tags). `NOTICE` item 2 keeps the idea credit and the MIT text |
| Other copyright or license headers | None found in skills |
| Client or personal data in the tree | None. No company name, company email, internal host, or local path. `artrios/*.md` are empty templates. The `acme-*` strings in `ui/test` are fake |
| `ingest-wiki` mentions "Karpathy-pattern vault" | Names a pattern, copies no text. No action |
| Runtime dependencies and shadcn/ui | Listed in `NOTICE` items 3 and 4 |

## Not clean: the git history

The history of `main` (91 commits) still holds what the tree no longer does:

- AIS-OS files copied in v0.1.0 (`skills/audit*`, 3D Brain template, onboarding files), removed later.
- The client pack `packs/mhk/` (3d-brain skill and template).
- A company email address in the author metadata of some commits.

Making the repository public as it is would publish all of that. So the public repository must start from a clean copy.

## Release from a clean copy

1. Export the tree: `git archive --format=tar HEAD | tar -x -C <empty folder outside this repo>`.
2. In that folder: `git init -b main`, set a neutral author (`git config user.name`, `user.email` with a noreply address), one commit `Initial public release kit-vX.Y.Z`.
3. Run `cd ui && npm ci && npm test` there to prove the copy stands alone.
4. Tag `kit-vX.Y.Z`, create the empty public repo, push the tag and `main`. Only after the owner confirms; this publishes.
5. Keep the private repo (with history) as the working repo. Public releases then come from the same export step, or the private repo is retired. The owner decides which.

The first public tag must be newer than `kit-v0.2.0` so users on an older tag can move to it (`docs/releasing.md`).
