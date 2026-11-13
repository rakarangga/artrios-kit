---
name: artrios-ui
description: Use when the user runs /artrios-ui to install or reinstall the Artrios local web UI (project dropdown with search, kanban board with Start and Stop on cards, Insights chat, Ideation, Overview with Activity, Changelog, Context and MCP, Worktrees, terminal grid, light and dark themes, Add project) into a folder, build it, and print the URL to open it. Global skill; works from any folder.
disable-model-invocation: true
argument-hint: "[target folder, default apps/artrios-ui in the current folder]"
---

# /artrios-ui

Install the Artrios UI from the kit template (`<kit>/ui/`) into a project folder, build it, and print the local address. Input: `$ARGUMENTS` = optional target folder. Report in the user's language (`artrios/profile.md`).

The kit root (the folder holding `artrios/core.md`) is named in `artrios/profile.md` as `Kit root`. Below, `<kit>` means that folder.

## 1. Check

1. Node.js 20 or newer: `node --version`. Older or missing: stop and say so.
2. `claude --version` works. Missing: say the terminal needs it, that skills and Insights can run through an API provider set in Settings > Model, and continue.
3. Target = `$ARGUMENTS`, else `apps/artrios-ui` under the session's working directory. If the target is `<kit>/ui` itself, stop (that is the template).
4. Target already holds an install (`server/index.js`): tell the user this is a reinstall. `data/config.json` and everything in `data/` are kept; source files are refreshed.

## 2. Show the plan, then wait

Tell the user what will happen, and ask once to proceed:

- copy `<kit>/ui/` to the target, without `node_modules`, `client/dist`, and `data`;
- write `<target>/data/config.json` if it does not exist (free port from 4317, `maxTerminals` 12, paths to `<kit>/artrios/project.md` and `<kit>/artrios/providers.yaml`);
- `npm install` and `npm run build` in the target;
- start the server once and print its address.

Nothing outside the target folder is written. The UI itself connects out only to the API provider the user sets in Settings > Model; otherwise only the user's own `claude` talks to Anthropic.

## 3. Install

1. `node <kit>/ui/bin/scaffold.js --target <target> --kit <kit>`
2. `npm install` in `<target>` (prebuilt `node-pty`; no compiler needed). Report the error text if it fails and stop.
3. `npm run build` in `<target>`.
4. Optional: `npm test` in `<target>`, report pass or fail in one line.
5. If the target is inside a git repo: check `git status --short` for the target. The folder `apps/artrios-ui` is a normal project folder; tell the user to commit it by the repo's own rules or add it to `.git/info/exclude`. Never commit for them.

## 3a. Update an existing install

When step 1.4 found an install, this is an update (the user may also say "update" or "restart" the UI):

1. Stop the server that runs from the target. Several `node server/index.js` processes can exist (the template in `<kit>/ui`, other installs); match the one whose working folder is the target, and leave every other node process alone (a running `npm test` is not the server).
2. Run steps 3.1 to 3.3, then start from the target (step 4). Never start the server from `<kit>/ui`: that folder has no `data/`, so the project list is empty.
3. Check that `/` answers 401 with the sign-in page (the server is up and locked) before reporting the address. A restart signs every browser out: tell the user to sign in again.

## 4. Account, start, and print the address

1. One account, `administrator`, no roles. If `<target>/data/users.json` does not exist, the server refuses to start: the user sets the first password with `npm run password` in `<target>`. It asks for hidden input, so let the user run it themselves; never choose, type, or store the password for them. The first sign-in forces a new password. A forgotten password is reset the same way.
2. Start `npm start` in `<target>` in the background and read the line `Artrios UI: http://127.0.0.1:<port>/`. Print that address and say to sign in as `administrator`. The server listens on `127.0.0.1` unless `"host"` in `data/config.json` names a LAN address (still behind the sign-in; only when the user asks).
3. Tell the user how to start it next time: `npm start` in `<target>`, and how to stop it (Ctrl+C, or stop the background task); stopping the server also closes its terminal tabs.
4. First use: open the address, sign in, then use **+ Add project** in the sidebar to register a folder. Each registration shows a write plan and writes nothing until the user approves it. Agent Terminals is off by default; Settings > Terminal turns it on after a warning.

## Guardrails

- Never read `.env` files or `data/users.json`. Never write passwords, session cookies, or secrets into any file, log, or message.
- The UI refuses the personal hat for a folder whose git remote matches `restrictedRemotes` in `data/config.json` (regex list, empty by default; the owner sets it for employer territory). Do not work around a refusal.
- One target per run. Do not edit `data/config.json` unless the user asks (for example to change the port or to allow a skill's tools under `skills.<name>.allowedTools`).
