// Update kit (AIOS-130): version detection against a real local git origin, the Putusan case, and the run guard.
// The updater itself (install.py --update) is tested in the kit repository; here the launcher is a stub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createKitUpdate, newer } from '../server/kit-update.js';
import { createInboxService } from '../server/inbox-service.js';

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

function world(installedVersion = '0.2.0') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'artrios-kitup-')));
  const work = path.join(root, 'work');
  const origin = path.join(root, 'origin.git');
  fs.mkdirSync(path.join(work, 'ui'), { recursive: true });
  fs.writeFileSync(path.join(work, 'install.py'), '# stub\n');
  git(root, 'init', '-q', '-b', 'main', work);
  const release = (v, notes) => {
    fs.writeFileSync(path.join(work, 'ui', 'package.json'), JSON.stringify({ version: v }));
    const old = fs.existsSync(path.join(work, 'CHANGELOG.md')) ? fs.readFileSync(path.join(work, 'CHANGELOG.md'), 'utf8').replace(/^# Changelog\n\n/, '') : '';
    fs.writeFileSync(path.join(work, 'CHANGELOG.md'), `# Changelog\n\n## kit-v${v} - 2026-11-13\n\n${notes}\n\n${old}`);
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', `release ${v}`);
    git(work, 'tag', '-a', `kit-v${v}`, '-m', v);
  };
  release('0.2.0', '- first');
  release('0.2.1', '- fix one');
  release('0.2.2', '- fix two');
  fs.writeFileSync(path.join(work, 'x.txt'), 'after the last tag');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'unreleased 1');
  fs.writeFileSync(path.join(work, 'y.txt'), 'again');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'unreleased 2');
  git(root, 'clone', '-q', '--bare', work, origin);
  const kit = path.join(root, 'kit');
  git(root, 'clone', '-q', origin, kit);
  git(kit, 'checkout', '-q', `kit-v${installedVersion}`);
  const uiDir = path.join(kit, 'apps', 'artrios-ui');
  fs.mkdirSync(path.join(uiDir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(uiDir, 'package.json'), JSON.stringify({ version: installedVersion }));
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.artrios'), { recursive: true });
  const launched = [];
  const ku = (extra = {}) => createKitUpdate({ kitRoot: kit, uiDir, dataDir: path.join(uiDir, 'data'), home, launch: async (a) => { launched.push(a); }, ...extra });
  return { root, work, kit, uiDir, home, launched, ku, done: () => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* a handle of a just-closed app may hold it; the OS temp cleaner takes it */ } } };
}

test('newer compares numerically, not as text', () => {
  assert.equal(newer('kit-v0.10.0', 'kit-v0.9.9'), true);
  assert.equal(newer('kit-v0.2.1', 'kit-v0.2.1'), false);
  assert.equal(newer('kit-v1.0.0', 'kit-v0.99.99'), true);
});

test('not a kit checkout: disabled, nothing is run', async () => {
  const w = world();
  try {
    const off = createKitUpdate({ kitRoot: path.join(w.root, 'nowhere'), uiDir: w.uiDir, dataDir: path.join(w.uiDir, 'data'), home: w.home });
    assert.deepEqual(off.status(), { enabled: false });
    assert.deepEqual(await off.check(), { enabled: false });
    await assert.rejects(() => off.run('kit-v0.2.2'), /not available/);
  } finally { w.done(); }
});

test('older tag installed: latest tag found, button offered, commits after the tag counted as info', async () => {
  const w = world('0.2.0');
  try {
    const s = await w.ku().check();
    assert.equal(s.enabled, true);
    assert.equal(s.installed, 'kit-v0.2.0');
    assert.equal(s.latest, 'kit-v0.2.2');
    assert.equal(s.available, true);
    assert.equal(s.unreleased, 2);
  } finally { w.done(); }
});

test('on the latest tag with main ahead: no button, only "2 unreleased commits"', async () => {
  const w = world('0.2.2');
  try {
    const s = await w.ku().check();
    assert.equal(s.available, false);
    assert.equal(s.behind, false);
    assert.equal(s.unreleased, 2);
  } finally { w.done(); }
});

test('origin unreachable: no crash, error reported, no button', async () => {
  const w = world('0.2.0');
  try {
    git(w.kit, 'remote', 'set-url', 'origin', path.join(w.root, 'missing.git'));
    const s = await w.ku().check();
    assert.equal(s.available, false);
    assert.ok(s.error);
  } finally { w.done(); }
});

test('the check is cached until the ttl passes or a forced check', async () => {
  const w = world('0.2.0');
  try {
    let t = 1000;
    let calls = 0;
    const real = (await import('node:child_process')).execFileSync;
    const ku = w.ku({ now: () => t, ttlMs: 5000, git: async (cwd, args) => { calls++; return real('git', args, { cwd, encoding: 'utf8' }); } });
    await ku.check();
    const first = calls;
    await ku.check();
    assert.equal(calls, first, 'second call served from cache');
    t += 6000;
    await ku.check();
    assert.ok(calls > first, 'expired');
  } finally { w.done(); }
});

test('prepare: one Putusan case with the CHANGELOG between the versions and the backup warning; asking again does not duplicate', async () => {
  const w = world('0.2.0');
  try {
    const inbox = createInboxService({ file: path.join(w.root, 'putusan.jsonl') });
    const ku = w.ku();
    await ku.check();
    const r = await ku.prepare(inbox);
    assert.equal(r.result, 'created');
    assert.match(r.item.question, /kit-v0\.2\.0 to kit-v0\.2\.2/);
    assert.match(r.item.question, /fix one/);
    assert.match(r.item.question, /fix two/);
    assert.doesNotMatch(r.item.question, /first/, 'the installed version is not repeated');
    assert.match(r.item.why, /profile\.md, registry\.md, inbox\.md, activity\.md/);
    assert.deepEqual(r.item.options, ['Update', 'Later']);
    const again = await ku.prepare(inbox);
    assert.equal(again.result, 'reasked');
    assert.equal(inbox.list({ status: 'pending' }).length, 1);
  } finally { w.done(); }
});

test('decided: Update starts the updater for that tag only; Later hides the button until a forced check; other cases ignored', async () => {
  const w = world('0.2.0');
  try {
    const inbox = createInboxService({ file: path.join(w.root, 'putusan.jsonl') });
    const ku = w.ku();
    await ku.check();
    const { item } = await ku.prepare(inbox);

    inbox.decide(item.id, { by: 'administrator', decision: 'Later' });
    assert.deepEqual(await ku.decided(inbox.get(item.id)), { started: false });
    assert.equal(w.launched.length, 0);
    assert.equal(ku.status().available, false, 'hidden after Later');
    assert.equal((await ku.check({ force: true })).available, true, 'a manual check offers it again');

    const second = (await ku.prepare(inbox)).item;
    inbox.decide(second.id, { by: 'administrator', decision: 'Update' });
    const r = await ku.decided(inbox.get(second.id));
    assert.deepEqual(r, { started: true, tag: 'kit-v0.2.2' });
    assert.equal(w.launched.length, 1);
    assert.equal(w.launched[0].tag, 'kit-v0.2.2');
    assert.equal(ku.status().running, true);
    await assert.rejects(() => ku.run('kit-v0.2.2'), /already running/);

    assert.equal(await ku.decided({ key: 'artrios/other/topic', decision: 'Update' }), null);
  } finally { w.done(); }
});

test('run refuses a tag that is not a release tag or does not exist on origin', async () => {
  const w = world('0.2.0');
  try {
    const ku = w.ku();
    await assert.rejects(() => ku.run('main'), /not a release tag/);
    await assert.rejects(() => ku.run('kit-v9.9.9'), /not found/);
    assert.equal(w.launched.length, 0);
  } finally { w.done(); }
});

test('result of the last update is shown once, then acknowledged', async () => {
  const w = world('0.2.0');
  try {
    const ku = w.ku();
    fs.writeFileSync(path.join(w.home, '.artrios', 'update-result.json'), JSON.stringify({ tag: 'kit-v0.2.2', ok: false, rolledBack: true, error: 'build failed' }));
    assert.equal(ku.status().result.rolledBack, true);
    assert.equal(ku.ack().result, null);
  } finally { w.done(); }
});

// Through the HTTP routes: the decide route hands the stored case (with its key) to the updater.
test('routes: status, prepare, and an "Update" decision on the Putusan page starts the updater', async () => {
  const http = await import('node:http');
  const { createApp } = await import('../server/app.js');
  const w = world('0.2.0');
  const port = await new Promise((r) => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const dataDir = path.join(w.uiDir, 'data');
  fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify({ projects: [] }));
  const app = createApp({ config: { kitRoot: w.kit, homeDir: w.home, inboxFile: path.join(w.root, 'putusan.jsonl') }, dataDir, port, clientDir: null });
  const token = app.auth.openSession();
  await new Promise((r) => app.server.listen(port, '127.0.0.1', r));
  const call = (method, url, body) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, method, path: url, headers: { host: `127.0.0.1:${port}`, cookie: `artrios_s=${token}`, ...(payload ? { 'content-type': 'application/json' } : {}) } }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(d || '{}') }));
    });
    r.on('error', reject);
    r.end(payload);
  });
  try {
    await call('POST', '/api/kit/update/check');
    const st = await call('GET', '/api/kit/update');
    assert.equal(st.json.available, true);
    const prep = await call('POST', '/api/kit/update/prepare');
    assert.equal(prep.json.result, 'created');
    const dec = await call('POST', `/api/inbox/${prep.json.item.id}/decide`, { decision: 'Update' });
    assert.equal(dec.status, 200, JSON.stringify(dec.json));
    assert.equal((await call('GET', '/api/kit/update')).json.running, true, 'the updater was started (install.py here is a stub that does nothing)');
  } finally {
    await new Promise((r) => app.server.close(r));
    app.close?.();
    w.done();
  }
});
