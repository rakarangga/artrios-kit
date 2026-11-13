// Git service (PRD AIOS-61 v2.1 S11): git settings, repo status, worktrees per workspace and per card, conflict check,
// merge to the base branch, push + PR. Pure library like task-service: no HTTP, every call gets the project, events go
// out through onActivity (written to the project's activity.jsonl by the caller).
// Safety rules:
// - git runs with an argument list, never a shell; branch names and refs are checked before they reach git;
// - nothing is deleted or merged when it would lose work: a dirty or unmerged worktree needs force, a merge runs only
//   into a clean base with no conflict, and a failed merge is aborted so the repo is as it was;
// - push and Create PR exist only with config.git.allowPush true; agents never push (child-env agentEnv);
// - the kit stores no git token or password: identity is git config, authentication is the OS credential helper or gh.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { TaskError, localTimestamp } from './task-service.js';
import { redact } from './job-runner.js';
import { childEnv } from './child-env.js';

const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const WT_KEY_RE = /^([A-Z][A-Z0-9]{0,15})~([0-9a-f]{8})$/;
const LINE_RE = /^[^\r\n\0]{1,200}$/;
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+$/;

// Environment for git run by the UI: never prompt (a prompt would hang the request), never open an editor.
const gitEnv = () => ({ ...childEnv(process.env), GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no' });

export const worktreeKey = (projectKey, wtPath) => `${projectKey}~${crypto.createHash('sha1').update(path.resolve(wtPath).toLowerCase()).digest('hex').slice(0, 8)}`;

// A branch name the UI accepts: plain characters, no option look-alike, no "..", no path tricks. git check-ref-format
// runs afterwards for the remaining rules.
export function checkBranchName(name, what = 'branch') {
  const s = String(name ?? '').trim();
  if (!BRANCH_RE.test(s) || s.includes('..') || s.includes('//') || s.endsWith('/') || s.endsWith('.') || s.endsWith('.lock') || /(^|\/)\./.test(s) || s.includes('@{')) {
    throw new TaskError('invalid', `${what} name not allowed: ${JSON.stringify(String(name ?? ''))} (letters, digits, . _ - /; no "..", no leading "-" or ".")`);
  }
  return s;
}

function parseWorktrees(out) {
  return out.split(/\r?\n\r?\n/).filter((b) => b.trim()).map((b) => {
    const o = {};
    for (const l of b.split(/\r?\n/)) { const i = l.indexOf(' '); if (l) o[i < 0 ? l : l.slice(0, i)] = i < 0 ? true : l.slice(i + 1); }
    return {
      path: path.resolve(o.worktree ?? ''),
      head: String(o.HEAD ?? '').slice(0, 7),
      branch: typeof o.branch === 'string' ? o.branch.replace(/^refs\/heads\//, '') : '',
      detached: o.detached === true,
      bare: o.bare === true,
      locked: o.locked !== undefined,
      prunable: o.prunable !== undefined,
    };
  });
}

// Old-style `git merge-tree <base> <ours> <theirs>` (git before 2.38): files whose merged text carries conflict markers,
// plus delete/modify pairs. Read only: it writes nothing.
export function parseLegacyMergeTree(out) {
  const files = new Set();
  let section = '';
  let entries = {};
  let current = '';
  const flush = () => {
    if (/^removed in (local|remote)$/.test(section) && entries.base && (entries.our || entries.their)) {
      const kept = entries.our ?? entries.their;
      if (kept.sha !== entries.base.sha) files.add(kept.path);
    }
  };
  for (const line of out.split(/\r?\n/)) {
    if (/^(changed in both|added in both|removed in local|removed in remote|added in local|added in remote|merged)$/.test(line)) {
      flush();
      section = line; entries = {}; current = '';
      continue;
    }
    const m = /^ {2}(base|our|their) +\d+ ([0-9a-f]+) (.+)$/.exec(line);
    if (m) { entries[m[1]] = { sha: m[2], path: m[3] }; current = m[3]; continue; }
    if (/^\+<<<<<<< /.test(line) && current) files.add(current);
  }
  flush();
  return [...files];
}

export function createGitService({ config = {}, onActivity = () => {}, now = () => new Date(), ghPath = null } = {}) {
  const gcfg = () => config.git ?? {};
  // gh command as an argv prefix: "gh" by default; config.git.gh may name another program (a list, no shell).
  const gh = () => {
    const c = ghPath ?? gcfg().gh ?? 'gh';
    return Array.isArray(c) && c.length && c.every((x) => typeof x === 'string') ? c : [String(c)];
  };
  const remoteName = () => gcfg().remote ?? 'origin';

  function run(dir, args, { timeout = 15000, cmd = null } = {}) {
    return new Promise((resolve) => {
      const [prog, ...pre] = cmd ?? ['git', '-C', dir];
      execFile(prog, [...pre, ...args], { cwd: dir, timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env: gitEnv() }, (err, out, errOut) => {
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, out: String(out ?? ''), err: String(errOut || (err ? err.message : '')) });
      });
    });
  }
  const ok = async (dir, args, what, opts) => {
    const r = await run(dir, args, opts);
    if (r.code !== 0) throw new TaskError('conflict', `${what}: ${redact((r.err || r.out).trim().split('\n').slice(-4).join(' ')) || `exit ${r.code}`}`);
    return r.out;
  };

  let versionCache = null;
  async function gitVersion() {
    if (versionCache) return versionCache;
    const r = await run(process.cwd(), ['--version']);
    const m = /(\d+)\.(\d+)/.exec(r.out);
    versionCache = m ? [Number(m[1]), Number(m[2])] : [0, 0];
    return versionCache;
  }

  const log = (project, type, ref, detail, by = 'ui') => {
    try { onActivity(project, { ts: localTimestamp(now()), type, ref, by, detail }); } catch { /* the action itself succeeded */ }
  };

  // ---- worktrees -------------------------------------------------------------------------------------------------
  async function rawList(project) {
    const r = await run(project.path, ['worktree', 'list', '--porcelain']);
    if (r.code !== 0) return null;
    return parseWorktrees(r.out).filter((w) => !w.bare);
  }
  async function repo(project) {
    const list = await rawList(project);
    if (!list || !list.length) throw new TaskError('invalid', `${project.key} is not a git repository`);
    const main = list[0];
    const base = gcfg().baseBranch ?? main.branch;
    if (!base) throw new TaskError('conflict', 'the main folder is on a detached HEAD; check out the base branch first');
    return { list, main, base };
  }
  const managedRoot = (project) => path.join(project.path, '.artrios', 'worktrees');
  const isManaged = (project, p) => path.resolve(p).toLowerCase().startsWith(managedRoot(project).toLowerCase() + path.sep);

  async function branchExists(dir, name) {
    return (await run(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])).code === 0;
  }
  async function checkRefFormat(dir, name) {
    const r = await run(dir, ['check-ref-format', '--branch', name]);
    if (r.code !== 0) throw new TaskError('invalid', `branch name not allowed by git: ${name}`);
  }

  async function summary(dir, base, branch, wtPath) {
    const [st, counts, short] = await Promise.all([
      run(wtPath, ['status', '--porcelain']),
      branch ? run(dir, ['rev-list', '--left-right', '--count', `${base}...${branch}`]) : null,
      branch ? run(dir, ['diff', '--shortstat', `${base}...${branch}`]) : null,
    ]);
    const changes = st.code === 0 ? st.out.split('\n').filter(Boolean).length : null;
    let behind = null;
    let ahead = null;
    if (counts?.code === 0) [behind, ahead] = counts.out.trim().split(/\s+/).map(Number);
    const s = short?.out ?? '';
    const num = (re) => Number((re.exec(s) ?? [0, 0])[1]);
    return { changes, ahead, behind, files: num(/(\d+) files? changed/), added: num(/(\d+) insertions?/), deleted: num(/(\d+) deletions?/) };
  }

  // Cards of the project that point at a worktree (by path or by branch).
  function cardsByWorktree(svc) {
    if (!svc) return [];
    try { return svc.list({}).cards.filter((c) => c.worktree || c.branch).map((c) => ({ key: c.key, title: c.title, status: c.status, branch: c.branch ?? '', worktree: c.worktree ?? '' })); } catch { return []; }
  }

  async function list(project, svc = null) {
    let info;
    try { info = await repo(project); } catch (e) { if (e.code === 'invalid') return { git: false, worktrees: [] }; throw e; }
    const { list: wts, main, base } = info;
    const cards = cardsByWorktree(svc);
    const rows = await Promise.all(wts.map(async (w, i) => {
      const isMain = i === 0;
      const sum = await summary(main.path, base, isMain ? null : w.branch, w.path);
      const rel = path.relative(project.path, w.path).split(path.sep).join('/');
      const linked = isMain ? [] : cards.filter((c) => (c.worktree && path.resolve(project.path, c.worktree).toLowerCase() === w.path.toLowerCase()) || (c.branch && c.branch === w.branch));
      return { ...w, main: isMain, managed: isManaged(project, w.path), rel, key: isMain ? project.key : worktreeKey(project.key, w.path), base, ...sum, cards: linked.map(({ key, title, status }) => ({ key, title, status })) };
    }));
    return { git: true, base, mainPath: main.path, allowPush: gcfg().allowPush === true, worktrees: rows };
  }

  async function find(project, wtPath) {
    const { list: wts, main, base } = await repo(project);
    const p = path.resolve(String(wtPath ?? ''));
    const w = wts.find((x) => x.path.toLowerCase() === p.toLowerCase());
    if (!w) throw new TaskError('not_found', 'not a worktree of this project');
    return { w, main, base, isMain: w === wts[0] };
  }
  async function findBranch(project, branch) {
    const name = checkBranchName(branch);
    const info = await repo(project);
    if (!(await branchExists(info.main.path, name))) throw new TaskError('not_found', `no local branch ${name}`);
    if (name === info.base) throw new TaskError('invalid', `${name} is the base branch`);
    return { ...info, branch: name, w: info.list.find((x) => x.branch === name) ?? null };
  }

  // .artrios/ must stay out of git, also when the folder was registered before add-project wrote the exclude line.
  async function ensureExcluded(project) {
    const probe = await run(project.path, ['check-ignore', '-q', '.artrios/worktrees/x']);
    if (probe.code === 0) return false;
    const p = (await run(project.path, ['rev-parse', '--git-path', 'info/exclude'])).out.trim();
    if (!p) return false;
    const file = path.isAbsolute(p) ? p : path.join(project.path, p);
    let old = '';
    try { old = fs.readFileSync(file, 'utf8'); } catch { /* new file */ }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${old.replace(/\n?$/, old ? '\n' : '')}# Artrios UI\n.artrios/\n`);
    return true;
  }

  // New worktree at <repo>/.artrios/worktrees/<branch> (AC 36): for a new branch from `from` (default the base branch),
  // or for an existing branch that has no worktree yet.
  async function create(project, { branch, from = null, by = 'ui' } = {}) {
    const name = checkBranchName(branch);
    const { list: wts, main, base } = await repo(project);
    await checkRefFormat(main.path, name);
    if (wts.some((w) => w.branch === name)) throw new TaskError('conflict', `branch ${name} already has a worktree`);
    const target = path.join(managedRoot(project), ...name.split('/'));
    if (!isManaged(project, target)) throw new TaskError('invalid', 'worktree path escapes .artrios/worktrees');
    if (fs.existsSync(target)) throw new TaskError('conflict', `folder already exists: ${target}`);
    await ensureExcluded(project);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const exists = await branchExists(main.path, name);
    if (exists) {
      await ok(main.path, ['worktree', 'add', target, name], 'git worktree add', { timeout: 60000 });
    } else {
      const start = from ? checkBranchName(from, 'start point') : base;
      if ((await run(main.path, ['rev-parse', '--verify', '--quiet', `${start}^{commit}`])).code !== 0) throw new TaskError('not_found', `start point not found: ${start}`);
      await ok(main.path, ['worktree', 'add', '-b', name, target, start], 'git worktree add', { timeout: 60000 });
    }
    log(project, 'git.worktree', name, `created ${path.relative(project.path, target).split(path.sep).join('/')}${exists ? '' : ` from ${from ?? base}`}`, by);
    invalidate();
    return (await list(project)).worktrees.find((w) => w.path.toLowerCase() === target.toLowerCase()) ?? { path: target, branch: name };
  }

  // Delete a worktree; its local branch goes too when it is merged into the base. Dirty or unmerged needs force
  // (the UI asks again); an unmerged branch is kept even then, so its commits are never lost.
  async function remove(project, wtPath, { force = false, by = 'ui' } = {}) {
    const { w, main, base, isMain } = await find(project, wtPath);
    if (isMain) throw new TaskError('invalid', 'the main folder cannot be removed');
    const sum = await summary(main.path, base, w.branch, w.path);
    const reasons = [];
    if (sum.changes) reasons.push(`${sum.changes} uncommitted change${sum.changes === 1 ? '' : 's'}`);
    if (w.branch && sum.ahead) reasons.push(`${sum.ahead} commit${sum.ahead === 1 ? '' : 's'} not merged into ${base}`);
    if (reasons.length && !force) {
      const e = new TaskError('conflict', `not removed: ${reasons.join(', ')}. Confirm to remove anyway.`);
      e.needsConfirm = true;
      throw e;
    }
    await ok(main.path, ['worktree', 'remove', ...(sum.changes ? ['--force'] : []), w.path], 'git worktree remove', { timeout: 60000 });
    let branchDeleted = false;
    if (w.branch && !sum.ahead) branchDeleted = (await run(main.path, ['branch', '-d', w.branch])).code === 0;
    // Empty parent folders left by a branch with slashes (feat/x -> .artrios/worktrees/feat).
    let dir = path.dirname(w.path);
    while (isManaged(project, dir)) { try { fs.rmdirSync(dir); } catch { break; } dir = path.dirname(dir); }
    log(project, 'git.worktree', w.branch || w.head, `removed${branchDeleted ? ' with its merged branch' : sum.ahead ? ' (unmerged branch kept)' : ''}${reasons.length ? ` after confirm: ${reasons.join(', ')}` : ''}`, by);
    invalidate();
    return { removed: w.path, branch: w.branch, branchDeleted, keptUnmerged: !!(w.branch && sum.ahead) };
  }

  // ---- conflicts and merge ---------------------------------------------------------------------------------------
  async function conflicts(project, branch) {
    const { main, base, branch: name } = await findBranch(project, branch);
    const [maj, min] = await gitVersion();
    if (maj > 2 || (maj === 2 && min >= 38)) {
      const r = await run(main.path, ['merge-tree', '--write-tree', '--name-only', '--no-messages', base, name], { timeout: 60000 });
      if (r.code > 1 || r.code < 0) throw new TaskError('conflict', `git merge-tree: ${r.err.trim() || `exit ${r.code}`}`);
      const files = r.code === 1 ? r.out.split('\n').slice(1).map((l) => l.trim()).filter(Boolean) : [];
      return { base, branch: name, conflict: r.code === 1, files: [...new Set(files)], method: 'merge-tree --write-tree' };
    }
    const mb = await run(main.path, ['merge-base', base, name]);
    if (mb.code !== 0) throw new TaskError('conflict', `${name} has no common history with ${base}`);
    const r = await run(main.path, ['merge-tree', mb.out.trim(), base, name], { timeout: 60000 });
    if (r.code !== 0) throw new TaskError('conflict', `git merge-tree: ${r.err.trim() || `exit ${r.code}`}`);
    const files = parseLegacyMergeTree(r.out);
    return { base, branch: name, conflict: files.length > 0, files, method: 'merge-tree (legacy)' };
  }

  // Plain merge (fast-forward when possible) in the main folder. Refused when the main folder has tracked changes or the
  // check finds a conflict; if git still fails, the merge is aborted and HEAD is checked to be where it was (AC 25).
  async function merge(project, branch, { by = 'ui' } = {}) {
    const { main, base, branch: name } = await findBranch(project, branch);
    if (main.branch !== base) throw new TaskError('conflict', `the main folder is on ${main.branch || 'a detached HEAD'}, not ${base}`);
    const dirty = (await run(main.path, ['status', '--porcelain', '--untracked-files=no'])).out.split('\n').filter(Boolean);
    if (dirty.length) throw new TaskError('conflict', `the main folder has ${dirty.length} uncommitted change${dirty.length === 1 ? '' : 's'}; commit or stash them first`);
    const check = await conflicts(project, name);
    if (check.conflict) throw new TaskError('conflict', `merge refused: ${check.files.length} conflicting file${check.files.length === 1 ? '' : 's'} (${check.files.slice(0, 5).join(', ')}). Resolve them in Cognition or an editor.`);
    const before = (await run(main.path, ['rev-parse', 'HEAD'])).out.trim();
    const r = await run(main.path, ['merge', '--no-edit', name], { timeout: 120000 });
    if (r.code !== 0) {
      await run(main.path, ['merge', '--abort']);
      const after = (await run(main.path, ['rev-parse', 'HEAD'])).out.trim();
      const restored = after === before;
      log(project, 'git.merge', name, `failed into ${base}${restored ? ', repo unchanged' : ', CHECK THE MAIN FOLDER'}`, by);
      throw new TaskError('conflict', `merge failed and was aborted${restored ? '' : ' (HEAD moved: check the main folder)'}: ${redact((r.err || r.out).trim().split('\n').slice(-3).join(' '))}`);
    }
    const head = (await run(main.path, ['rev-parse', '--short', 'HEAD'])).out.trim();
    const fastForward = /Fast-forward/i.test(r.out);
    log(project, 'git.merge', name, `merged into ${base}${fastForward ? ' (fast-forward)' : ''} at ${head}`, by);
    return { merged: true, base, branch: name, head, fastForward };
  }

  // ---- push and PR (off unless config.git.allowPush) --------------------------------------------------------------
  async function ghStatus() {
    const r = await run(process.cwd(), ['auth', 'status'], { cmd: gh(), timeout: 15000 });
    if (r.code === -1 && /ENOENT/.test(r.err)) return { installed: false, loggedIn: false, account: null };
    const text = `${r.out}\n${r.err}`;
    const m = /account (\S+)/.exec(text) ?? /Logged in to \S+ as (\S+)/.exec(text);
    return { installed: true, loggedIn: r.code === 0, account: m ? m[1] : null };
  }
  // Connect GitHub from Settings (device flow): `gh auth login --web` prints a one-time code and the URL; the person
  // enters the code on github.com. gh keeps the token in its own store (keyring), never in the kit. After a sign-in,
  // `gh auth setup-git` lets git use it for push. One login at a time; it gives up after 15 minutes.
  let login = { state: 'idle', code: null, url: null, message: null, at: null };
  let loginChild = null;
  function githubLogin() {
    if (loginChild) return { ...login };
    const [prog, ...pre] = gh();
    login = { state: 'starting', code: null, url: null, message: null, at: new Date().toISOString() };
    let out = '';
    let child;
    try {
      child = spawn(prog, [...pre, 'auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--skip-ssh-key'], { env: { ...gitEnv(), GH_PROMPT_DISABLED: '', BROWSER: 'none' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { login = { ...login, state: 'failed', message: e.message }; return { ...login }; }
    loginChild = child;
    const read = (d) => {
      out = (out + d).slice(-4000);
      const code = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/.exec(out);
      const url = /(https:\/\/github\.com\/login\/device\S*)/.exec(out);
      if (code && login.state === 'starting') login = { ...login, state: 'waiting', code: code[1], url: url ? url[1] : 'https://github.com/login/device' };
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.stdin.on('error', () => {});
    setTimeout(() => { try { child.stdin.write('\n'); } catch { /* exited */ } }, 800).unref?.();
    const timer = setTimeout(() => { if (loginChild === child) login = { ...login, state: 'failed', message: 'timed out after 15 minutes' }; try { child.kill(); } catch { /* gone */ } }, 15 * 60000);
    timer.unref?.();
    const mine = () => loginChild === child; // a cancelled login must not overwrite the next one
    child.on('error', (e) => { clearTimeout(timer); if (!mine()) return; loginChild = null; login = { ...login, state: 'failed', message: /ENOENT/.test(e.message) ? 'GitHub CLI (gh) is not installed' : e.message }; });
    child.on('close', async (code) => {
      clearTimeout(timer);
      if (!mine()) return;
      loginChild = null;
      if (login.state === 'failed') return;
      if (code !== 0) { login = { ...login, state: 'failed', message: redact(out.trim().split('\n').slice(-2).join(' ')) || `exit ${code}` }; return; }
      await run(process.cwd(), ['auth', 'setup-git', '--hostname', 'github.com'], { cmd: gh(), timeout: 20000 });
      login = { ...login, state: 'done', message: null };
    });
    return new Promise((resolve) => {
      const end = Date.now() + 8000;
      const tick = () => (login.state !== 'starting' || Date.now() > end ? resolve({ ...login }) : setTimeout(tick, 100));
      tick();
    });
  }
  const githubLoginState = () => ({ ...login });
  function githubLoginCancel() {
    if (loginChild) { const c = loginChild; loginChild = null; login = { ...login, state: 'failed', message: 'cancelled' }; try { c.kill(); } catch { /* gone */ } }
    return { ...login };
  }
  async function githubLogout() {
    if (loginChild) { try { loginChild.kill(); } catch { /* gone */ } }
    const r = await run(process.cwd(), ['auth', 'logout', '--hostname', 'github.com'], { cmd: gh(), timeout: 20000 });
    if (r.code !== 0) throw new TaskError('conflict', `gh auth logout: ${redact((r.err || r.out).trim().split('\n').slice(-2).join(' '))}`);
    login = { state: 'idle', code: null, url: null, message: null, at: null };
    return settings();
  }

  async function createPr(project, branch, { title, body = '', by = 'ui' } = {}) {
    if (gcfg().allowPush !== true) throw new TaskError('forbidden', 'push is off for this instance (Settings > Git, git.allowPush)');
    const { main, base, branch: name } = await findBranch(project, branch);
    const t = String(title ?? '').trim() || name;
    if (!LINE_RE.test(t)) throw new TaskError('invalid', 'PR title must be one line of at most 200 characters');
    const st = await ghStatus();
    if (!st.installed) throw new TaskError('unavailable', 'GitHub CLI (gh) is not installed; install it and run `gh auth login`');
    if (!st.loggedIn) throw new TaskError('unavailable', 'gh is not signed in; run `gh auth login` in a terminal first');
    await ok(main.path, ['push', '-u', remoteName(), name], 'git push', { timeout: 120000 });
    log(project, 'git.push', name, `pushed to ${remoteName()}`, by);
    const r = await run(main.path, ['pr', 'create', '--head', name, '--base', base, '--title', t, '--body', String(body).slice(0, 20000) || t], { cmd: gh(), timeout: 60000 });
    if (r.code !== 0) throw new TaskError('conflict', `gh pr create: ${redact((r.err || r.out).trim().split('\n').slice(-3).join(' '))}`);
    const url = (r.out.match(/https?:\/\/\S+/g) ?? []).pop() ?? r.out.trim();
    log(project, 'git.pr', name, `PR ${url}`, by);
    return { pushed: true, branch: name, base, url };
  }

  // ---- repo status, fetch, pull ----------------------------------------------------------------------------------
  async function status(project, dir = null) {
    const d = dir ?? project.path;
    const inside = await run(d, ['rev-parse', '--is-inside-work-tree']);
    if (inside.code !== 0 || inside.out.trim() !== 'true') return { git: false };
    const [br, up, st] = await Promise.all([
      run(d, ['rev-parse', '--abbrev-ref', 'HEAD']),
      run(d, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']),
      run(d, ['status', '--porcelain']),
    ]);
    let ahead = null;
    let behind = null;
    if (up.code === 0) {
      const c = await run(d, ['rev-list', '--left-right', '--count', '@{u}...HEAD']);
      if (c.code === 0) [behind, ahead] = c.out.trim().split(/\s+/).map(Number);
    }
    return { git: true, branch: br.out.trim(), upstream: up.code === 0 ? up.out.trim() : null, ahead, behind, changes: st.out.split('\n').filter(Boolean).length };
  }
  async function fetch(project, { by = 'ui' } = {}) {
    await ok(project.path, ['fetch', '--prune', remoteName()], 'git fetch', { timeout: 120000 });
    log(project, 'git.fetch', remoteName(), 'fetched', by);
    return status(project);
  }
  async function pull(project, { by = 'ui' } = {}) {
    const r = await run(project.path, ['pull', '--ff-only'], { timeout: 120000 });
    if (r.code !== 0) throw new TaskError('conflict', `git pull --ff-only: ${redact((r.err || r.out).trim().split('\n').slice(-3).join(' '))}`);
    log(project, 'git.pull', remoteName(), /Already up to date/i.test(r.out) ? 'already up to date' : 'fast-forwarded', by);
    return status(project);
  }

  // ---- settings: identity and connection -------------------------------------------------------------------------
  async function settings() {
    const home = process.cwd();
    const [name, email, helper, st] = await Promise.all([
      run(home, ['config', '--global', '--get', 'user.name']),
      run(home, ['config', '--global', '--get', 'user.email']),
      run(home, ['config', '--get', 'credential.helper']),
      ghStatus(),
    ]);
    const [maj, min] = await gitVersion();
    return {
      name: name.out.trim(), email: email.out.trim(), credentialHelper: helper.out.trim() || null,
      gh: st, allowPush: gcfg().allowPush === true, remote: remoteName(), version: `${maj}.${min}`,
    };
  }
  async function setIdentity({ name, email } = {}) {
    const n = String(name ?? '').trim();
    const e = String(email ?? '').trim();
    if (!LINE_RE.test(n)) throw new TaskError('invalid', 'name must be one line');
    if (!EMAIL_RE.test(e) || e.length > 200) throw new TaskError('invalid', 'email is not valid');
    await ok(process.cwd(), ['config', '--global', 'user.name', n], 'git config user.name');
    await ok(process.cwd(), ['config', '--global', 'user.email', e], 'git config user.email');
    return settings();
  }
  // git ls-remote against the workspace remote: proves the credential helper works without changing anything.
  async function testConnection(project) {
    const url = await run(project.path, ['remote', 'get-url', remoteName()]);
    if (url.code !== 0) return { ok: false, remote: remoteName(), message: `this repository has no remote "${remoteName()}"` };
    const r = await run(project.path, ['ls-remote', '--heads', remoteName()], { timeout: 30000 });
    const shown = url.out.trim().replace(/\/\/[^@/]+@/, '//');
    if (r.code === 0) return { ok: true, remote: remoteName(), url: shown, heads: r.out.split('\n').filter(Boolean).length };
    return { ok: false, remote: remoteName(), url: shown, message: redact((r.err || r.out).trim().split('\n').slice(-3).join(' ')) || `exit ${r.code}` };
  }

  // ---- card worktree: "run in worktree" ----------------------------------------------------------------------------
  // The card's branch is artrios/<key>; its worktree is reused while it exists. The card keeps branch and path (AC 22).
  async function forCard(project, svc, cardKey, { by = 'ui' } = {}) {
    const card = svc.show(cardKey);
    const branch = card.branch || `artrios/${card.key.toLowerCase()}`;
    const { list: wts } = await repo(project);
    let w = wts.find((x) => x.branch === branch);
    if (!w) w = await create(project, { branch, by });
    const rel = path.relative(project.path, w.path).split(path.sep).join('/');
    if (card.branch !== branch || card.worktree !== rel) svc.update(card.key, { branch, worktree: rel }, { by });
    return { branch, path: w.path, rel };
  }

  // ---- worktrees as Cognition workspaces ("opened under the parent workspace") -----------------------------------
  // Synchronous: the chat service resolves workspace keys synchronously. Cached for 20 s per project.
  const cache = new Map();
  function invalidate() { cache.clear(); }
  function syncList(project) {
    const c = cache.get(project.key);
    if (c && Date.now() - c.at < 20000) return c.list;
    let wts = [];
    try {
      const out = execFileSync('git', ['-C', project.path, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env: gitEnv() });
      wts = parseWorktrees(out).filter((w) => !w.bare).slice(1);
    } catch { /* not a repo */ }
    cache.set(project.key, { at: Date.now(), list: wts });
    return wts;
  }
  const asWorkspace = (project, w) => ({ key: worktreeKey(project.key, w.path), name: `${project.name ?? project.key} › ${w.branch || w.head}`, path: w.path, hat: project.hat ?? null, client: project.client ?? null, parent: project.key, branch: w.branch, worktree: true });
  function workspaceOf(key, projects) {
    const m = WT_KEY_RE.exec(String(key ?? ''));
    if (!m) return null;
    const project = projects.find(m[1]);
    if (!project) return null;
    const w = syncList(project).find((x) => worktreeKey(project.key, x.path) === key);
    return w && fs.existsSync(w.path) ? asWorkspace(project, w) : null;
  }
  function workspacesOf(projects) {
    return (projects.all?.() ?? []).flatMap((p) => syncList(p).filter((w) => fs.existsSync(w.path)).map((w) => asWorkspace(p, w)));
  }

  return { list, create, remove, conflicts, merge, createPr, githubLogin, githubLoginState, githubLoginCancel, githubLogout, status, fetch, pull, settings, setIdentity, testConnection, forCard, find, workspaceOf, workspacesOf, invalidate, ghStatus };
}
