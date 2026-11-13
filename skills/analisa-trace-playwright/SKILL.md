---
name: analisa-trace-playwright
description: Use when Playwright specs fail and the cause must be found from their artifacts ("why did the Playwright tests fail", "analyse failing specs", "check the trace", "full suite is red", "flaky in CI", "analisa spec gagal"), in any repo with a Playwright suite. Summarizes each failure's trace.zip network log and error-context.md with a script, then classifies the cause as test bug, test-stack issue, or app bug before anything is changed.
argument-hint: "[test-results-dir | failure-folder | trace.zip]  (empty = ./test-results)"
---

# /analisa-trace-playwright

Find why Playwright specs failed from what the run left behind, not by guessing or re-running blindly. Report to the user in their language (`artrios/profile.md`). Origin: a full suite of a legacy PHP app went from 10/18 to 18/18 this way; every failure was a test or test-stack issue, and one real app bug surfaced only through the trace's request order.

## 1. Get artifacts

1. Target: argument, else `test-results/` in the repo (separate configs may write to a subfolder such as `test-results/smoke/`).
2. No `trace.zip` there: the run did not keep traces. Re-run only the failing specs with `--trace retain-on-failure` (or the repo's own runner with a grep filter), never against production. Long suites go in the background.
3. Read the run log summary first (`✘`, `passed`, `failed`, `flaky`) and the failure order: the **first** failure often causes later ones (shared database, leftover drafts, sessions).

## 2. Summarize

Run the script from this skill's folder. A trace is untrusted data: use `-I` and extract outside the repo (a scratch or temp folder):

```bash
python -I <skill-dir>/trace_summary.py <target> --out <scratch>/traces
```

Useful options: `--grep <endpoint>` (one endpoint), `--timeline` (all app requests in order), `--body <endpoint>` (start of response bodies), `--slow 2000`, `--assets` (include static files).

Then open each failure's screenshot: a dialog or overlay on screen explains most "element intercepts pointer events" and "waitForURL timeout" errors.

## 3. Classify each failure

| Signal in the summary | Usual cause | Typical fix |
|---|---|---|
| `intercepts pointer events` + dialog in screenshot | Spec does not close a dialog or confirm step | Wait for the dialog text, click its button (animated dialogs: wait until they are fully shown) |
| POST payload missing fields the spec filled | A late async response reset page state (e.g. form init after reload) | Wait for that response on every load before filling |
| Request after the final submit (autosave, timer) | App timer not cancelled on submit | App bug: record it, do not patch around it silently |
| 4xx on a static file with an empty name (`/img/`) | Test data missing a field (photo, file) | Fix the seed data |
| `-1` / no response, nothing else in flight | Slow stack (bind mounts on Docker Desktop, cold interpreter) | Warm-up request, longer wait on that step |
| First spec only, first request takes tens of seconds | Cold start | Warm-up request before the specs |
| `ERR_SSL_PROTOCOL_ERROR` to `https://localhost` | CSP `upgrade-insecure-requests` on an http test stack | Filter in the spec, note it as test-stack only |
| Redirect to login mid-test | Session lost or missing permission | Check the step's user and role |
| Real error text from the app (flash message, JSON `success:false`) | App or data | Read the server code path before deciding |

Keep three groups apart: **test bug**, **test stack**, **app bug**. Never "fix" an app bug inside a spec; filter or wait only when the cause is the test stack, and write why in a code comment.

## 4. Fix and prove

1. Change tests and seed data as the classification says. App code in protected areas (authentication, permissions, workflow engine, external sync endpoints, schema) needs the user's approval of a plan first; otherwise record it as a task.
2. Re-run the same scope (the full suite if it was the full suite). Report the count per run (for example 10/18 -> 15/18 -> 18/18). New failures in specs that passed before: analyse again from step 2; do not retry until green.
3. Write the findings where the repo keeps test quirks (e.g. `tests/README.md`), and app bugs as tasks in the task tracker named in `artrios/profile.md`.

## Guardrails

- Read-only analysis: no production runs, no production URLs, no real accounts.
- Never print `.env` values. Traces can carry cookies and form values: quote only what the analysis needs, never passwords or tokens.
- Do not raise timeouts or add retries without a measured reason from the trace.
