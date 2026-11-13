// Git and worktrees from the UI (PRD AIOS-61 v2.1 S11; AC 19-27, 36). Real git in a temp repo with a bare remote;
// gh is a fake script; the global git config is a temp file so the developer's own config is never touched.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';
import { parseLegacyMergeTree, checkBranchName, worktreeKey } from '../server/git-service.js';
import { agentEnv } from '../server/child-env.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(here, 'fixtures', 'fake-claude.js');
const FAKE_GH = path.join(here, 'fixtures', 'fake-gh.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artrios-git-'));
// Before anything runs git: identity and settings come from this file, not from the user's ~/.gitconfig.
process.env.GIT_CONFIG_GLOBAL = path.join(dir, 'gitconfig');
fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '[user]\n\tname = Tester\n\temail = tester@example.com\n[init]\n\tdefaultBranch = main\n');
process.env.FAKE_GH_LOG = path.join(dir, 'gh.log');

const proj = path.join(dir, 'proj');
const remote = path.join(dir, 'remote.git');
const dataDir = path.join(dir, 'data');
const P = '/api/projects/GIT';
let port;
let app;
let TOKEN;
let cfg;
const spawned = [];
const fakePty = { spawn(file, args, opts) { const p = { file, args, opts, pid: 1, onData() {}, onExit() {}, write() {}, resize() {}, kill() {} }; spawned.push(p); return p; } };

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const g = (...args) => sh(proj, ...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('waitFor timed out'); await sleep(30); }
}
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
function api(method, url, body) {
  return new Promise((resolve, reject) => {
    const h = { host: `127.0.0.1:${port}`, cookie: `artrios_s=${TOKEN}` };
    let payload;
    if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] = 'application/json'; }
    const r = http.request({ host: '127.0.0.1', port, method, path: url, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not json */ } resolve({ status: res.statusCode, json }); });
    });
    r.on('error', reject);
    r.end(payload);
  });
}
const wtPath = (branch) => path.join(proj, '.artrios', 'worktrees', ...branch.split('/'));
const state = () => ({ head: g('rev-parse', 'HEAD').trim(), status: g('status', '--porcelain'), index: g('diff', '--cached', '--name-only') });
function commitIn(cwd, file, text, msg) { fs.writeFileSync(path.join(cwd, file), text); sh(cwd, 'add', file); sh(cwd, 'commit', '-qm', msg); }

before(async () => {
  fs.mkdirSync(dataDir);
  fs.mkdirSync(proj);
  execFileSync('git', ['init', '-q', '--bare', remote]);
  g('init', '-q');
  g('checkout', '-q', '-b', 'main');
  fs.writeFileSync(path.join(proj, 'a.txt'), 'line 1\nline 2\nline 3\n');
  fs.writeFileSync(path.join(proj, 'b.txt'), 'b\n');
  g('add', '.');
  g('commit', '-qm', 'first');
  g('remote', 'add', 'origin', remote);
  g('push', '-q', '-u', 'origin', 'main');
  // A skill for the job tests, kept untracked (the main folder stays clean for tracked files).
  fs.mkdirSync(path.join(proj, '.claude', 'skills', 'ok'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.claude', 'skills', 'ok', 'SKILL.md'), '---\nname: ok\ndescription: t\n---\n\n$ARGUMENTS\n');
  fs.writeFileSync(path.join(proj, '.git', 'info', 'exclude'), '.claude/\n'); // note: no .artrios/ line yet (ensureExcluded adds it)
  fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify({ projects: [{ key: 'GIT', name: 'Git test', hat: 'self', path: proj }] }));
  cfg = { claudePath: process.execPath, claudeBaseArgs: [FAKE], maxJobs: 2, jobTimeoutMs: 20000, skills: { ok: { allowedTools: ['Read'] } }, terminal: true, terminalCommand: process.execPath, git: { gh: [process.execPath, FAKE_GH] } };
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(cfg));
  port = await freePort();
  app = createApp({ config: cfg, dataDir, port, clientDir: null, ptyLib: fakePty, configFile: path.join(dataDir, 'config.json') });
  TOKEN = app.auth.openSession();
  await new Promise((r) => app.server.listen(port, '127.0.0.1', r));
});

after(() => {
  app.close();
  app.server.closeAllConnections();
  app.server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('branch names: option look-alikes, "..", path tricks and odd characters are refused', () => {
  for (const bad of ['-x', '--force', '..', 'a..b', '../evil', 'a/../b', '.hidden', 'x/', 'x.lock', 'a b', 'a@{1}', 'a\\b', '']) {
    assert.throws(() => checkBranchName(bad), /not allowed/, bad);
  }
  assert.equal(checkBranchName('feat/x-1.2_y'), 'feat/x-1.2_y');
});

test('AC 20, 36: a worktree for a new branch lands in .artrios/worktrees, stays out of git status and the project list', async () => {
  const before = (await api('GET', '/api/projects')).json.projects.length;
  const r = await api('POST', `${P}/worktrees`, { branch: 'feat/one' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(path.resolve(r.json.path).toLowerCase(), wtPath('feat/one').toLowerCase());
  assert.ok(fs.existsSync(path.join(wtPath('feat/one'), 'a.txt')));
  assert.equal(g('status', '--porcelain'), '', 'parent repo stays clean');
  assert.match(fs.readFileSync(path.join(proj, '.git', 'info', 'exclude'), 'utf8'), /^\.artrios\/$/m);
  assert.equal((await api('GET', '/api/projects')).json.projects.length, before);
  const list = (await api('GET', `${P}/worktrees`)).json;
  assert.equal(list.base, 'main');
  assert.equal(list.worktrees.length, 2);
  assert.equal(list.worktrees[0].main, true);
  const w = list.worktrees.find((x) => x.branch === 'feat/one');
  assert.equal(w.managed, true);
  assert.equal(w.rel, '.artrios/worktrees/feat/one');
  assert.equal(w.key, worktreeKey('GIT', w.path));
});

test('AC 20: a worktree for an existing branch, and bad names or duplicates are refused', async () => {
  g('branch', 'old');
  const r = await api('POST', `${P}/worktrees`, { branch: 'old' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.branch, 'old');
  for (const bad of ['--orphan', '../x', 'a..b', '-b']) assert.equal((await api('POST', `${P}/worktrees`, { branch: bad })).status, 400, bad);
  assert.equal((await api('POST', `${P}/worktrees`, { branch: 'old' })).status, 409);
  assert.equal((await api('POST', `${P}/worktrees`, { branch: 'new2', from: '--upload-pack=x' })).status, 400);
  assert.equal((await api('POST', `${P}/worktrees/remove`, { path: wtPath('old') })).status, 200);
});

test('AC 23: changed files, commits ahead and added/deleted lines match git diff --shortstat and rev-list --count', async () => {
  const w = wtPath('feat/one');
  commitIn(w, 'a.txt', 'line 1\nline two\nline 3\nline 4\n', 'edit a');
  commitIn(w, 'c.txt', 'c1\nc2\n', 'add c');
  fs.writeFileSync(path.join(w, 'dirty.txt'), 'x'); // uncommitted
  const row = (await api('GET', `${P}/worktrees`)).json.worktrees.find((x) => x.branch === 'feat/one');
  const short = sh(proj, 'diff', '--shortstat', 'main...feat/one');
  assert.equal(row.files, Number(/(\d+) files? changed/.exec(short)[1]));
  assert.equal(row.added, Number(/(\d+) insertion/.exec(short)[1]));
  assert.equal(row.deleted, Number(/(\d+) deletion/.exec(short)[1]));
  assert.equal(row.ahead, Number(sh(proj, 'rev-list', '--count', 'main..feat/one').trim()));
  assert.equal(row.changes, 1);
  fs.rmSync(path.join(w, 'dirty.txt'));
});

test('AC 24: Check for Conflicts finds a conflict and a clean merge without touching index or files', async () => {
  // feat/clash edits line 2 of a.txt differently from main.
  await api('POST', `${P}/worktrees`, { branch: 'feat/clash' });
  commitIn(wtPath('feat/clash'), 'a.txt', 'line 1\nline TWO clash\nline 3\n', 'clash a');
  commitIn(proj, 'a.txt', 'line 1\nline 2 on main\nline 3\n', 'main edits a');
  g('branch', 'calm', 'HEAD~1'); // a branch with nothing new: merges cleanly
  const before = state();
  const c = await api('POST', `${P}/worktrees/conflicts`, { branch: 'feat/clash' });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  assert.equal(c.json.conflict, true);
  assert.deepEqual(c.json.files, ['a.txt']);
  const clean = await api('POST', `${P}/worktrees/conflicts`, { branch: 'calm' });
  assert.equal(clean.json.conflict, false);
  assert.deepEqual(state(), before);
  assert.equal((await api('POST', `${P}/worktrees/conflicts`, { branch: 'main' })).status, 400);
  assert.equal((await api('POST', `${P}/worktrees/conflicts`, { branch: 'nope' })).status, 404);
});

test('AC 25: merge is refused for a conflict or a dirty main folder (repo unchanged) and works for a clean branch', async () => {
  let before = state();
  const r1 = await api('POST', `${P}/worktrees/merge`, { branch: 'feat/clash' });
  assert.equal(r1.status, 409);
  assert.match(r1.json.error, /conflicting/);
  assert.deepEqual(state(), before);
  fs.appendFileSync(path.join(proj, 'b.txt'), 'dirty\n');
  before = state();
  const r2 = await api('POST', `${P}/worktrees/merge`, { branch: 'calm' });
  assert.equal(r2.status, 409);
  assert.match(r2.json.error, /uncommitted/);
  assert.deepEqual(state(), before);
  g('checkout', '-q', '--', 'b.txt');
  await api('POST', `${P}/worktrees`, { branch: 'feat/clean' });
  commitIn(wtPath('feat/clean'), 'd.txt', 'd\n', 'add d');
  const card = (await api('POST', `${P}/cards`, { title: 'Clean work', status: 'human_review' })).json;
  const r3 = await api('POST', `${P}/worktrees/merge`, { branch: 'feat/clean', card: card.key });
  assert.equal(r3.status, 200, JSON.stringify(r3.json));
  assert.equal(r3.json.merged, true);
  assert.ok(fs.existsSync(path.join(proj, 'd.txt')));
  assert.equal(g('status', '--porcelain', '--untracked-files=no'), '');
  assert.equal((await api('GET', `${P}/cards/${card.key}`)).json.status, 'done');
  const feed = (await api('GET', `${P}/activity`)).json.events;
  assert.ok(feed.some((e) => e.type === 'git.merge' && e.ref === 'feat/clean'));
});

test('AC 20: Delete refuses dirty or unmerged worktrees until confirmed, keeps unmerged branches, drops merged ones', async () => {
  // merged: feat/clean -> worktree and branch go
  const m = await api('POST', `${P}/worktrees/remove`, { path: wtPath('feat/clean') });
  assert.equal(m.status, 200, JSON.stringify(m.json));
  assert.equal(m.json.branchDeleted, true);
  assert.equal(g('branch', '--list', 'feat/clean').trim(), '');
  // unmerged + dirty: feat/clash
  fs.writeFileSync(path.join(wtPath('feat/clash'), 'wip.txt'), 'wip');
  const r = await api('POST', `${P}/worktrees/remove`, { path: wtPath('feat/clash') });
  assert.equal(r.status, 409);
  assert.equal(r.json.needsConfirm, true);
  assert.match(r.json.error, /uncommitted/);
  assert.match(r.json.error, /not merged/);
  assert.ok(fs.existsSync(wtPath('feat/clash')));
  const f = await api('POST', `${P}/worktrees/remove`, { path: wtPath('feat/clash'), force: true });
  assert.equal(f.status, 200, JSON.stringify(f.json));
  assert.equal(f.json.keptUnmerged, true);
  assert.ok(!fs.existsSync(wtPath('feat/clash')));
  assert.equal(g('branch', '--list', 'feat/clash').trim(), 'feat/clash');
  // not a worktree / the main folder
  assert.equal((await api('POST', `${P}/worktrees/remove`, { path: path.join(dir, 'elsewhere') })).status, 404);
  assert.equal((await api('POST', `${P}/worktrees/remove`, { path: proj, force: true })).status, 400);
});

test('AC 21: push and Create PR are off by default; an agent process cannot push', async () => {
  const s = (await api('GET', '/api/settings/git')).json;
  assert.equal(s.allowPush, false);
  assert.equal((await api('GET', `${P}/worktrees`)).json.allowPush, false);
  const r = await api('POST', `${P}/worktrees/pr`, { branch: 'feat/one' });
  assert.equal(r.status, 403);
  // agentEnv: git push fails for any remote, fetch still works.
  const env = agentEnv({ ...process.env });
  const push = spawnSync('git', ['push', 'origin', 'feat/one'], { cwd: proj, env, encoding: 'utf8' });
  assert.notEqual(push.status, 0);
  assert.match(push.stderr, /artrios-no-push/);
  assert.equal(spawnSync('git', ['fetch', 'origin'], { cwd: proj, env }).status, 0);
  assert.equal(spawnSync('git', ['ls-remote', '--heads', remote], { encoding: 'utf8' }).stdout.includes('feat/one'), false);
});

test('AC 21: a job that tries to push is refused and written to its log and the activity feed', async () => {
  const card = (await api('POST', `${P}/cards`, { title: 'Pusher' })).json;
  const job = (await api('POST', `${P}/jobs`, { skill: 'ok', args: 'PUSHTRY', card: card.key })).json;
  const done = await waitFor(async () => { const j = (await api('GET', `${P}/jobs/${job.id}`)).json.meta; return ['done', 'failed'].includes(j.status) && j; });
  assert.equal(done.status, 'done');
  const log = (await api('GET', `${P}/jobs/${job.id}/log`)).json.entries;
  assert.ok(log.some((e) => e.kind === 'status' && /push refused/.test(e.text)));
  const feed = (await api('GET', `${P}/activity`)).json.events;
  assert.ok(feed.some((e) => e.type === 'git.push-refused' && e.ref === job.id));
});

test('AC 22: "run in worktree" gives the card its own branch and worktree; the job writes only there', async () => {
  const card = (await api('POST', `${P}/cards`, { title: 'Worktree job' })).json;
  const job = await api('POST', `${P}/jobs`, { skill: 'ok', args: 'WTSAVE', card: card.key, worktree: true });
  assert.equal(job.status, 201, JSON.stringify(job.json));
  await waitFor(async () => (await api('GET', `${P}/jobs/${job.json.id}`)).json.meta.status === 'done');
  const branch = `artrios/${card.key.toLowerCase()}`;
  const c = (await api('GET', `${P}/cards/${card.key}`)).json;
  assert.equal(c.branch, branch);
  assert.equal(c.worktree, `.artrios/worktrees/${branch}`);
  assert.ok(fs.existsSync(path.join(wtPath(branch), 'job-wrote.txt')));
  assert.ok(!fs.existsSync(path.join(proj, 'job-wrote.txt')));
  assert.equal(g('status', '--porcelain'), '', 'main folder unchanged');
  const row = (await api('GET', `${P}/worktrees`)).json.worktrees.find((w) => w.branch === branch);
  assert.deepEqual(row.cards.map((x) => x.key), [card.key]);
  // a second run reuses the same worktree
  const again = await api('POST', `${P}/jobs`, { skill: 'ok', args: 'WTSAVE', card: card.key, worktree: true });
  assert.equal(again.status, 201);
  assert.equal(path.resolve(again.json.cwd).toLowerCase(), wtPath(branch).toLowerCase());
  await waitFor(async () => (await api('GET', `${P}/jobs/${again.json.id}`)).json.meta.status === 'done');
  assert.equal((await api('POST', `${P}/jobs`, { skill: 'ok', args: 'x', worktree: true })).status, 400);
});

test('AC 26: with allowPush, Create PR pushes the branch and calls gh pr create with the card title; no gh login = message', async () => {
  const set = await api('PUT', '/api/settings/git', { allowPush: true });
  assert.equal(set.json.allowPush, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')).git.allowPush, true);
  const card = (await api('POST', `${P}/cards`, { title: 'Ship feature one', status: 'human_review' })).json;
  process.env.FAKE_GH_AUTH = 'no';
  const denied = await api('POST', `${P}/worktrees/pr`, { branch: 'feat/one', card: card.key });
  assert.equal(denied.status, 503);
  assert.match(denied.json.error, /gh auth login/);
  delete process.env.FAKE_GH_AUTH;
  const r = await api('POST', `${P}/worktrees/pr`, { branch: 'feat/one', card: card.key });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.url, 'https://github.com/example/repo/pull/7');
  assert.ok(spawnSync('git', ['ls-remote', '--heads', remote], { encoding: 'utf8' }).stdout.includes('refs/heads/feat/one'));
  const args = JSON.parse(fs.readFileSync(process.env.FAKE_GH_LOG, 'utf8').trim().split('\n').pop());
  assert.equal(args[args.indexOf('--title') + 1], `${card.key} Ship feature one`);
  assert.equal(args[args.indexOf('--head') + 1], 'feat/one');
  assert.equal(args[args.indexOf('--base') + 1], 'main');
  assert.equal((await api('GET', `${P}/cards/${card.key}`)).json.status, 'pr_created');
  await api('PUT', '/api/settings/git', { allowPush: false });
});

test('AC 19: settings show identity and gh status; test connection reports success or the git error; no token stored', async () => {
  const s = (await api('GET', '/api/settings/git')).json;
  assert.equal(s.name, 'Tester');
  assert.equal(s.email, 'tester@example.com');
  assert.equal(s.gh.loggedIn, true);
  assert.equal(s.gh.account, 'tester');
  const upd = await api('PUT', '/api/settings/git', { name: 'Owner Test', email: 'owner@example.com' });
  assert.equal(upd.json.name, 'Owner Test');
  assert.match(fs.readFileSync(process.env.GIT_CONFIG_GLOBAL, 'utf8'), /Owner Test/);
  assert.equal((await api('PUT', '/api/settings/git', { name: 'x\ny', email: 'a@b' })).status, 400);
  assert.equal((await api('PUT', '/api/settings/git', { name: 'x', email: 'not-an-email' })).status, 400);
  const ok = (await api('POST', `${P}/git/test`)).json;
  assert.equal(ok.ok, true);
  g('remote', 'set-url', 'origin', path.join(dir, 'missing.git'));
  const bad = (await api('POST', `${P}/git/test`)).json;
  assert.equal(bad.ok, false);
  assert.ok(bad.message.length > 0);
  g('remote', 'set-url', 'origin', remote);
  const st = (await api('GET', `${P}/git`)).json;
  assert.equal(st.git, true);
  assert.equal(st.branch, 'main');
  assert.equal((await api('POST', `${P}/git/fetch`)).status, 200);
  // nothing that looks like a credential in the kit's files
  const stored = [fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'), ...fs.readdirSync(path.join(proj, '.artrios'), { recursive: true }).filter((f) => /\.(json|jsonl|md)$/.test(f)).map((f) => fs.readFileSync(path.join(proj, '.artrios', f), 'utf8'))].join('\n');
  assert.doesNotMatch(stored, /ghp_|github_pat_|gho_|x-access-token|password\s*[:=]/i);
});

test('AC 27: a terminal opened in a worktree runs there and carries its label; open/Copy Path use the absolute path', async () => {
  const branch = 'feat/one';
  const t = await api('POST', `${P}/terminals`, { cols: 80, rows: 20, worktree: wtPath(branch) });
  assert.equal(t.status, 201, JSON.stringify(t.json));
  assert.equal(t.json.worktree.branch, branch);
  assert.equal(path.resolve(spawned.at(-1).opts.cwd).toLowerCase(), wtPath(branch).toLowerCase());
  assert.equal((await api('GET', `${P}/terminals`)).json.terminals.find((x) => x.id === t.json.id).worktree.branch, branch);
  assert.equal((await api('POST', `${P}/terminals`, { worktree: path.join(dir, 'nope') })).status, 404);
  const row = (await api('GET', `${P}/worktrees`)).json.worktrees.find((w) => w.branch === branch);
  assert.ok(path.isAbsolute(row.path));
});

test('worktrees open under the parent in Cognition: listed with the parent key and resolvable as a chat workspace', async () => {
  const ws = (await api('GET', '/api/chat/workspaces')).json;
  const w = ws.worktrees.find((x) => x.branch === 'feat/one');
  assert.equal(w.parent, 'GIT');
  assert.equal(w.key, worktreeKey('GIT', wtPath('feat/one')));
  assert.ok(!ws.workspaces.some((x) => x.key === w.key), 'not in the workspace (project) list');
  const s = await api('GET', `/api/chat/${encodeURIComponent(w.key)}/sessions`);
  assert.equal(s.status, 200, JSON.stringify(s.json));
  assert.equal((await api('GET', `/api/chat/${encodeURIComponent('GIT~deadbeef')}/sessions`)).status, 404);
});

test('legacy merge-tree output: conflict markers and delete/modify pairs are found', () => {
  const out = [
    'changed in both',
    '  base   100644 1111111111111111111111111111111111111111 a.txt',
    '  our    100644 2222222222222222222222222222222222222222 a.txt',
    '  their  100644 3333333333333333333333333333333333333333 a.txt',
    '@@ -1,3 +1,7 @@',
    ' line 1',
    '+<<<<<<< .our',
    '+x',
    '+=======',
    '+y',
    '+>>>>>>> .their',
    'changed in both',
    '  base   100644 4444444444444444444444444444444444444444 ok.txt',
    '  our    100644 5555555555555555555555555555555555555555 ok.txt',
    '  their  100644 6666666666666666666666666666666666666666 ok.txt',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    'removed in remote',
    '  base   100644 7777777777777777777777777777777777777777 gone.txt',
    '  our    100644 8888888888888888888888888888888888888888 gone.txt',
    'removed in remote',
    '  base   100644 9999999999999999999999999999999999999999 same.txt',
    '  our    100644 9999999999999999999999999999999999999999 same.txt',
  ].join('\n');
  assert.deepEqual(parseLegacyMergeTree(out).sort(), ['a.txt', 'gone.txt']);
});

test('Connect GitHub: device code shown, sign-in finishes, git is set up through gh; Disconnect logs out', async () => {
  const r = await api('POST', '/api/settings/git/github/connect');
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.state, 'waiting');
  assert.equal(r.json.code, 'ABCD-1234');
  assert.equal(r.json.url, 'https://github.com/login/device');
  const again = (await api('POST', '/api/settings/git/github/connect')).json; // one login at a time
  assert.equal(again.code, 'ABCD-1234');
  await waitFor(async () => (await api('GET', '/api/settings/git/github')).json.state === 'done');
  const calls = fs.readFileSync(process.env.FAKE_GH_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(calls.filter((a) => a[1] === 'login').length, 1);
  assert.ok(calls.some((a) => a[1] === 'setup-git'));
  assert.ok(!fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8').includes('ABCD-1234'));
  const out = await api('POST', '/api/settings/git/github/disconnect');
  assert.equal(out.status, 200);
  assert.ok(fs.readFileSync(process.env.FAKE_GH_LOG, 'utf8').includes('"logout"'));
  process.env.FAKE_GH_LOGIN_FAIL = '1';
  await api('POST', '/api/settings/git/github/connect');
  const failed = await waitFor(async () => { const s = (await api('GET', '/api/settings/git/github')).json; return s.state === 'failed' && s; });
  assert.ok(failed.message);
  delete process.env.FAKE_GH_LOGIN_FAIL;
  process.env.FAKE_GH_LOGIN_MS = '60000';
  assert.equal((await api('POST', '/api/settings/git/github/connect')).json.state, 'waiting');
  const c = (await api('POST', '/api/settings/git/github/cancel')).json;
  assert.equal(c.state, 'failed');
  assert.equal(c.message, 'cancelled');
  delete process.env.FAKE_GH_LOGIN_MS;
  assert.equal((await api('POST', '/api/settings/git/github/connect')).json.state, 'waiting', 'a new login can start after a cancel');
  await waitFor(async () => (await api('GET', '/api/settings/git/github')).json.state === 'done');
});
