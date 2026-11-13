---
name: ingest-wiki
description: Use when the user says "ingest ..." or drops a file into the wiki's raw/ folder, to turn raw sources into connected wiki pages. Global skill; works from any folder, not just the wiki itself.
argument-hint: "[raw file(s) or what to ingest]"
---

# Ingest wiki

Turn a raw source into connected pages in the knowledge wiki (Karpathy-pattern vault), following that vault's own rules. Input: `$ARGUMENTS` or the file(s)/content named in the conversation. Report in the user's language (`artrios/profile.md`).

The vault path is the `Wiki` field of `artrios/profile.md`. If it says "none", tell the user there is no wiki configured and stop.

## 1. Resolve the vault

1. A raw file already sitting in `<vault>/raw/` needs no further resolution (Obsidian Web Clipper drops there).
2. Several vaults listed in the profile: decide from the source's subject; ambiguous means ask once, numbered. Never guess.
3. Read the vault's `CLAUDE.md` in full before touching anything. It is the authoritative schema (page format, domains, ingest and lint steps) and can evolve independently of this skill. If this skill and the vault's `CLAUDE.md` disagree, the vault's `CLAUDE.md` wins. No `CLAUDE.md` in the vault: ask the user whether to create a minimal one first (frontmatter format, domains, index and log files).

## 2. Place the source

- First, repair raw links: raw files get moved and renamed in Obsidian, which rewrites `[[raw/<folder>/<file>]]` into a short `[[<file>]]` or leaves it pointing at an old path. Scan `wiki/sources/` for wikilinks that do not resolve to an existing file and for short links whose target is a file under `raw/`; rewrite each to the full path `[[raw/<folder>/<file>]]` (without `.md`) of the file that now exists. Add one `tidy` line to `wiki/log.md` for the fixes. Never rename the raw file back.
- Already in `raw/`: use it as-is: never edit a file under `raw/`. If it sits in the `raw/` root, move it into the vault's raw folder first (the vault `CLAUDE.md` decides the layout); update paths if it was already referenced.
- Not yet in `raw/` (pasted content, an attachment, a fetched page the user asked to save): write it into `<vault>/raw/` first, named so its origin is clear (date + short slug, inside the right `raw/<domain>/` folder), then ingest from there.
- Several files in one request: ingest each, but write one combined report at the end unless the user asks for several ingests separately.

## 3. Ingest (per the vault's own steps)

1. Read the raw file. Context or focus unclear: ask 1-3 questions before writing anything.
2. Create `wiki/sources/<name>.md` (`type: source`): origin, the raw file as a full-path wikilink `[[raw/<folder>/<file>]]` (never a backtick path: Obsidian's graph only draws links, so a backtick path leaves the raw file an orphan), date, summary, takeaways, and the list of pages this ingest creates or changes.
3. Break the content into `concept`/`entity`/`decision`/`analysis` pages in the right domain. Update an existing page instead of duplicating one: search `wiki/<domain>/` and `wiki/index.md` first.
4. New domain only when at least 3 pages don't fit any existing one; then add it to `wiki/index.md`.
5. A new source contradicts an older page: never delete the old content. Mark it `status: superseded`, and write what changed and when.
6. Update `wiki/<domain>/_index.md` and `wiki/index.md` for every page added or changed, and append one dated line to `wiki/log.md`: `YYYY-MM-DD HH:MM | ingest | <raw file(s)> | +N pages (...), ~M changed (...); <one-line gist>`.
7. Extracted collections (a CHM unpacked into thousands of files, a site mirror): do not wikilink every file. Record the collection per folder on the source page (which parts are ingested, which are not yet) and wikilink only files actually cited. Keep the collection out of the graph with a `-path:` filter in the vault's `.obsidian/graph.json`.
8. No orphans either way: every `raw/` file is wikilinked from a `sources/` page, and every `[[raw/...]]` on a source page points at a file that exists. Check before reporting.
9. Page format and linking: frontmatter `type/domain/tags/sources/updated/status`, `[[wikilink]]` for cross-references, every material claim cites its `[[sources/...]]`. Exact format: the vault's own `CLAUDE.md`.

## 4. Respect the authority boundary

The vault's `CLAUDE.md` has an authority table (what the wiki owns vs. what it only summarizes and links to: live infrastructure state, tracker tasks, quarterly priorities). Never copy a changing number or status into a wiki page as if the wiki owned it. Link to the canonical source instead.

## 5. Task impact

After ingesting, compare the new content against the relevant project in the task tracker named in `artrios/profile.md` (skip when "none"). Propose task changes as a list (add / reprioritize / change due / close) with the reasoning from the ingest. **Never change the tracker before the user approves.** This skill only proposes.

## 6. Report

1. Vault used, and why if it wasn't obvious.
2. Pages created vs. changed (with paths), and any marked `superseded`.
3. Conflicts found with other pages or with live/tracker state.
4. Proposed tracker changes (step 5), waiting for approval.
5. Open questions, if any were needed in step 3.1.

## Guardrails

- Never write secrets, tokens, private IPs, or `.env` values into any wiki page.
- `raw/` is immutable once a file lands there: add, never edit or delete (moving a file into its `raw/<domain>/` folder is allowed).
- Each vault is its own git repo. Never commit or push from this skill; list the changed vault under "Not committed" in the report so the user can commit and push it. If the ingest also warrants a tracker change, a decision-log entry, or an auto-memory pointer, say so in the report rather than doing it silently. Those follow their own rules (`/compact-project`, the decision log, auto-memory).
