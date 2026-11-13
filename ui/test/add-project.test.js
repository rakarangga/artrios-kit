import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createAddProject, AddProjectError } from '../server/add-project.js';

let root;
let dataDir;
let ap;
const sh = (cwd, ...a) => spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });
const mkRepo = (name, remote) => {
  const d = path.join(root, name);
  fs.mkdirSync(d);
  sh(d, 'init');
  if (remote) sh(d, 'remote', 'add', 'origin', remote);
  return d;
};
const input = (over) => ({ mode: 'existing', hat: 'work', key: 'DEMO', ...over });
const status = (d) => sh(d, 'status', '--short').stdout.trim();
const rows = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'projects.json'), 'utf8')).projects;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'artrios-add-'));
  dataDir = path.join(root, 'data');
  ap = createAddProject({ dataDir, config: { projectLayerFile: 'D:\\kit\\artrios\\project.md', restrictedRemotes: ['(^|[/:@])(acme-corp|acme-org)/'] } });
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('AC9: plan writes nothing; apply on an existing repo creates local files and keeps git clean', () => {
  const d = mkRepo('repo-a', 'https://github.com/someone/app.git');
  const plan = ap.plan(input({ path: d }));
  assert.deepEqual(plan.rejected, []);
  assert.equal(fs.existsSync(path.join(d, 'CLAUDE.local.md')), false);
  assert.equal(fs.existsSync(path.join(d, '.artrios')), false);
  assert.equal(fs.existsSync(path.join(dataDir, 'projects.json')), false);
  const r = ap.apply(input({ path: d }), plan.planId);
  assert.equal(r.project.key, 'DEMO');
  const local = fs.readFileSync(path.join(d, 'CLAUDE.local.md'), 'utf8');
  assert.match(local, /artrios:begin/);
  assert.match(local, /@D:\/kit\/artrios\/project\.md/);
  const pj = JSON.parse(fs.readFileSync(path.join(d, '.artrios', 'project.json'), 'utf8'));
  assert.equal(pj.key, 'DEMO');
  assert.equal(pj.nextIndex, 1);
  assert.match(fs.readFileSync(path.join(d, '.git', 'info', 'exclude'), 'utf8'), /\/CLAUDE\.local\.md\n\/\.artrios\//);
  assert.equal(status(d), '', 'git status shows no new files');
  assert.deepEqual(rows().map((p) => p.key), ['DEMO']);
  assert.match(fs.readFileSync(path.join(d, '.artrios', 'activity.jsonl'), 'utf8'), /"project.added"/);
});

test('B2: key and folder cannot be registered twice', () => {
  const d = mkRepo('repo-b');
  assert.match(ap.plan(input({ path: d })).rejected.join(' '), /already used/);
  const again = ap.plan(input({ path: path.join(root, 'repo-a'), key: 'OTHER' }));
  assert.match(again.rejected.join(' '), /already registered/);
});

test('B1: the personal hat is refused for restricted remotes, the work hat is allowed', () => {
  const a = mkRepo('co-a', 'git@github.com:acme-corp/billing.git');
  const b = mkRepo('co-b', 'https://github.com/acme-org/portal.git');
  assert.match(ap.plan(input({ path: a, hat: 'self', key: 'COA' })).rejected.join(' '), /restricted territory/);
  assert.match(ap.plan(input({ path: b, hat: 'self', key: 'COB' })).rejected.join(' '), /restricted territory/);
  assert.deepEqual(ap.plan(input({ path: a, hat: 'work', key: 'COA' })).rejected, []);
  assert.throws(() => ap.apply(input({ path: a, hat: 'self', key: 'COA' }), 'x'), AddProjectError);
});

test('AC9: a folder that is not a git repo only warns and still registers', () => {
  const d = path.join(root, 'plain');
  fs.mkdirSync(d);
  const plan = ap.plan(input({ path: d, key: 'PLAIN' }));
  assert.deepEqual(plan.rejected, []);
  assert.equal(plan.warnings.length, 1);
  ap.apply(input({ path: d, key: 'PLAIN' }), plan.planId);
  assert.ok(fs.existsSync(path.join(d, '.artrios', 'project.json')));
  assert.equal(fs.existsSync(path.join(d, '.git')), false);
});

test('AC9: mode new creates the folder, runs git init, excludes the local files', () => {
  const d = path.join(root, 'brand-new');
  const plan = ap.plan(input({ path: d, mode: 'new', key: 'NEWP', hat: 'self' }));
  assert.deepEqual(plan.rejected, []);
  assert.ok(plan.steps.some((s) => s.startsWith('create folder')));
  assert.equal(fs.existsSync(d), false);
  ap.apply(input({ path: d, mode: 'new', key: 'NEWP', hat: 'self' }), plan.planId);
  assert.ok(fs.existsSync(path.join(d, '.git')));
  assert.match(fs.readFileSync(path.join(d, '.git', 'info', 'exclude'), 'utf8'), /\/\.artrios\//);
  assert.equal(status(d), '');
});

test('mode new refuses a non-empty folder; mode existing refuses a missing one; relative path and bad key are invalid', () => {
  assert.match(ap.plan(input({ path: path.join(root, 'repo-a'), mode: 'new', key: 'ZZ1' })).rejected.join(' '), /not empty/);
  assert.match(ap.plan(input({ path: path.join(root, 'nope'), key: 'ZZ2' })).rejected.join(' '), /does not exist/);
  assert.throws(() => ap.plan(input({ path: 'relative/dir' })), AddProjectError);
  assert.throws(() => ap.plan(input({ path: root, key: '1bad' })), AddProjectError);
  assert.throws(() => ap.plan(input({ path: root, hat: 'other' })), AddProjectError);
});

test('B3: an existing CLAUDE.local.md keeps its other text and the diff is in the plan; planId mismatch is refused', () => {
  const d = mkRepo('repo-c');
  fs.writeFileSync(path.join(d, 'CLAUDE.local.md'), 'My own note\n\n<!-- artrios:begin (old) -->\nstale\n<!-- artrios:end -->\nTail\n');
  const plan = ap.plan(input({ path: d, key: 'CCC' }));
  const w = plan.writes.find((x) => x.file.endsWith('CLAUDE.local.md'));
  assert.equal(w.action, 'update');
  assert.match(w.before, /stale/);
  assert.doesNotMatch(w.after, /stale/);
  assert.match(w.after, /My own note/);
  assert.match(w.after, /Tail/);
  assert.throws(() => ap.apply(input({ path: d, key: 'CCC' }), 'wrong-id'), (e) => e.code === 'conflict');
  assert.match(fs.readFileSync(path.join(d, 'CLAUDE.local.md'), 'utf8'), /stale/, 'nothing written on mismatch');
  ap.apply(input({ path: d, key: 'CCC' }), plan.planId);
  assert.doesNotMatch(fs.readFileSync(path.join(d, 'CLAUDE.local.md'), 'utf8'), /stale/);
});

test('B3: existing .artrios/project.json of another key is rejected, never overwritten; tracked local files are rejected', () => {
  const d = mkRepo('repo-d');
  fs.mkdirSync(path.join(d, '.artrios'));
  fs.writeFileSync(path.join(d, '.artrios', 'project.json'), JSON.stringify({ key: 'OLD' }));
  assert.match(ap.plan(input({ path: d, key: 'DDD' })).rejected.join(' '), /belongs to key OLD/);
  const e = mkRepo('repo-e');
  fs.writeFileSync(path.join(e, 'CLAUDE.local.md'), 'tracked');
  sh(e, 'add', 'CLAUDE.local.md');
  assert.match(ap.plan(input({ path: e, key: 'EEE' })).rejected.join(' '), /tracked/);
});

test('AC 30b: client replaces hat: stored as client only, empty client = own', () => {
  const own = path.join(root, 'own-ws');
  const planOwn = ap.plan({ mode: 'new', key: 'OWNW', path: own, client: '' });
  assert.equal('hat' in planOwn.input, false);
  assert.equal(planOwn.input.client, '');
  assert.ok(planOwn.writes.some((w) => /"client": ""/.test(w.after)));
  assert.ok(planOwn.writes.some((w) => /- Client: none \(own\)/.test(w.after)));
  assert.ok(!planOwn.writes.some((w) => /"hat"|- Hat:/.test(w.after)));
  const cl = path.join(root, 'client-ws');
  const planCl = ap.plan({ mode: 'new', key: 'CLNT', path: cl, client: '  PT Contoh  ' });
  assert.equal(planCl.input.client, 'PT Contoh');
  assert.ok(planCl.writes.some((w) => /"client": "PT Contoh"/.test(w.after)));
  assert.ok(planCl.writes.some((w) => /- Client: PT Contoh/.test(w.after)));
  assert.throws(() => ap.plan({ mode: 'new', key: 'BADC', path: path.join(root, 'bad-c'), client: 'a\nb' }), AddProjectError);
});

test('AC 30b: B1 uses client (empty client refused on restricted remote), old API hat still accepted', () => {
  const r = mkRepo('repo-b1c', 'git@github.com:acme-org/thing.git');
  assert.match(ap.plan({ mode: 'existing', path: r, key: 'BONE', client: '' }).rejected.join(' '), /no client is refused/);
  assert.deepEqual(ap.plan({ mode: 'existing', path: r, key: 'BONE', client: 'Acme' }).rejected, []);
  const legacyWork = ap.plan({ mode: 'existing', path: r, key: 'BONE', hat: 'work' });
  assert.deepEqual(legacyWork.rejected, []);
  assert.equal(legacyWork.input.client, 'work');
  assert.match(ap.plan({ mode: 'existing', path: r, key: 'BONE', hat: 'self' }).rejected.join(' '), /no client is refused/);
  const named = createAddProject({ dataDir, config: { legacyWorkClient: 'Acme Corp' } });
  assert.equal(named.plan({ mode: 'existing', path: r, key: 'BONE', hat: 'work' }).input.client, 'Acme Corp');
  assert.throws(() => ap.plan({ mode: 'existing', path: r, key: 'BONE' }), /client is required/);
});
