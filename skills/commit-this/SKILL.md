---
name: commit-this
description: Safe lightweight Git checkpoint commit workflow. Use when the user invokes /commit-this or explicitly asks to create a checkpoint commit. Reviews scope, validates relevant changed files, blocks unrelated or sensitive changes, creates a Conventional Commit, and never pushes.
---

# /commit-this

## Purpose

Create a safe, lightweight Git checkpoint commit without blindly committing the entire working tree.

## Core Rules

1. Inspect only changed files and directly relevant context.
2. Never blindly use `git add .` or `git add -A`.
3. Classify every changed file as IN-SCOPE, UNRELATED, SENSITIVE, GENERATED, TEMPORARY, or AMBIGUOUS.
4. Never commit secrets, credentials, private keys, tokens, sensitive `.env` files, dumps, logs, generated artifacts, or temporary files.
5. If unrelated or ambiguous changes exist, exclude them when safely possible; otherwise STOP.
6. Never modify, discard, reset, clean, rebase, amend, or delete the user's work.
7. Always create a new commit; never amend.
8. Never push to remote.
9. Validate proportionally to the actual diff.
10. Leave the intended checkpoint committed and report the final Git state.

## Invocation

Primary:

```text
/commit-this
```

Optional explicit commit message:

```text
/commit-this feat(limbah): add atomic submission engine
```

Optional scope:

```text
/commit-this workflow migration
```

If a message is supplied, verify it accurately describes the diff. If only a scope is supplied, derive a concise Conventional Commit message from the actual changes.

## Procedure

### 1. Inspect Git State

Run:

```bash
git status --short
git branch --show-current
git diff --stat
```

Inspect relevant unstaged and staged diffs:

```bash
git diff -- <relevant-files>
git diff --cached --stat
git diff --cached -- <relevant-files>
```

Do not assume staged changes are correct.

### 2. Classify Changes

Use these classifications:

- IN-SCOPE
- UNRELATED
- SENSITIVE
- GENERATED
- TEMPORARY
- AMBIGUOUS

Do not automatically commit anything classified as UNRELATED, SENSITIVE, GENERATED, TEMPORARY, or AMBIGUOUS.

Preserve pre-existing unrelated changes.

### 3. Sensitive File Check

Watch for:

```text
.env
.env.*
*.pem
*.key
credentials*
secrets*
tokens
passwords
private keys
database dumps
```

Do not print secret contents.

If an intended commit contains suspicious sensitive material:

```text
STOP — commit blocked due to potentially sensitive file.
```

### 4. Determine Logical Scope

A commit must represent one logical checkpoint.

Examples:

```text
Workflow schema migration
Limbah parent relationship
Material ID sequence generator
Atomic submission engine
UI form implementation
```

Do not combine independent implementation phases.

### 5. Run Proportional Validation

For PHP changes:

```bash
php -l <changed.php>
```

Always run:

```bash
git diff --check
```

For SQL/schema changes, inspect the relevant DDL and use read-only live-schema verification when appropriate.

For documentation-only changes, `git diff --check` is sufficient unless project rules require more.

Do not invent or run an expensive full-repository test suite without need.

### 6. Final Diff Review

Before staging, verify:

- only intended files are included;
- no debug code;
- no temporary code;
- no credentials/secrets;
- no unrelated refactor;
- no accidental formatting-only changes;
- no generated artifacts;
- commit message matches the actual change.

If scope is unclear:

```text
STOP — scope is ambiguous.
```

### 7. Stage Explicit Files

Prefer:

```bash
git add -- <file1> <file2> ...
```

Do not use `git add .` or `git add -A` by default.

Then verify:

```bash
git diff --cached --stat
git diff --cached
```

### 8. Commit

Use Conventional Commit style:

```text
feat(scope): add ...
fix(scope): fix ...
refactor(scope): change ...
docs(scope): update ...
test(scope): add ...
chore(scope): ...
```

Examples:

```text
refactor(workflow): migrate instance reference to variant
feat(limbah): add kedatangan parent relationship
feat(limbah): add material id sequence generator
feat(limbah): add atomic submission engine
```

Commit with:

```bash
git commit -m "<message>"
```

Never amend.

### 9. Post-Commit Verification

Run:

```bash
git status --short
git log -1 --oneline
```

Report the commit hash, message, files, validations, final status, and:

```text
Push: NOT PUSHED
```

## Blocking Conditions

STOP without committing when:

1. scope is ambiguous;
2. unrelated changes cannot safely be excluded;
3. sensitive files are in the intended scope;
4. validation fails;
5. unexpected destructive changes are found;
6. independent logical checkpoints would be mixed;
7. the repository is in an unsafe/conflicted state;
8. the requested commit message does not accurately describe the diff.

Do not repair unrelated work automatically.

Use:

```text
COMMIT BLOCKED

Reason:
...

Affected files:
...

Required action:
...
```

## Success Output

```text
COMMIT THIS RESULT

[1] Status
PASS

[2] Commit
<hash> <message>

[3] Files committed
- <file>
- <file>

[4] Validation
- git diff --check: PASS
- <relevant validation>: PASS

[5] Git status
clean

[6] Push
NOT PUSHED
```

## Checkpoint Principle

Treat `/commit-this` as a project checkpoint, not merely a Git command:

```text
Implementation
    ↓
Validation
    ↓
/commit-this
    ↓
Clean checkpoint
    ↓
Next implementation phase
```

Never push unless separately instructed by the user.
