import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { createApp } from '../server/app.js';
import { createClaudeHeadlessEngine, buildArgs } from '../server/engine.js';
import { createJobRunner, redact } from '../server/job-runner.js';
import { listSkills } from '../server/skills.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude.js');
let TOKEN;
let dir;
let proj;
let project;
let port;
let app;
let pidFile;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// 20 s: jobs spawn real processes, and a busy machine (another suite, a build) can make them slow; a hang still fails.
async function waitFor(fn, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await sleep(25);
  }
}
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const metaOf = (id) => JSON.parse(fs.readFileSync(path.join(proj, '.artrios', 'jobs', id, 'meta.json'), 'utf8'));

function skill(name, body) {
  const d = path.join(proj, '.claude', 'skills', name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'SKILL.md'), `---\nname: ${name}\ndescription: Test skill ${name}\nargument-hint: "<x>"\n---\n\n${body}\n`);
}

const config = () => ({
  claudePath: process.execPath,
  claudeBaseArgs: [FAKE],
  maxJobs: 2,
  jobTimeoutMs: 20000,
  skills: { ok: { allowedTools: ['Read'] }, fail: { allowedTools: ['Read'] }, hang: { allowedTools: ['Read'] } },
});

function api(method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const h = { host: `127.0.0.1:${port}`, cookie: `artrios_s=${TOKEN}`, ...headers };
    let payload;
    if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] = 'application/json'; }
    const r = http.request({ host: '127.0.0.1', port, method, path: url, headers: h }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { let json = null; try { json = JSON.parse(d); } catch { /* not json */ } resolve({ status: res.statusCode, json }); });
    });
    r.on('error', reject);
    r.end(payload);
  });
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artrios-jobs-'));
  proj = path.join(dir, 'proj');
  fs.mkdirSync(path.join(dir, 'data'));
  fs.mkdirSync(proj);
  execFileSync('git', ['init', '-q'], { cwd: proj });
  fs.writeFileSync(path.join(proj, 'a.txt'), 'x');
  execFileSync('git', ['add', '.'], { cwd: proj });
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-qm', 'first commit'], { cwd: proj });
  skill('ok', 'Say hello. Args: $ARGUMENTS');
  skill('fail', 'FAIL now');
  skill('hang', 'HANG now');
  skill('noperm', 'no permission entry');
  project = { key: 'JOB', name: 'Jobs', hat: 'self', path: proj };
  fs.writeFileSync(path.join(dir, 'data', 'projects.json'), JSON.stringify({ projects: [project] }));
  port = await freePort();
  pidFile = path.join(dir, 'pid');
  process.env.FAKE_PID_FILE = pidFile;
  app = createApp({ config: config(), dataDir: path.join(dir, 'data'), port, clientDir: null });
  TOKEN = app.auth.openSession();
  await new Promise((r) => app.server.listen(port, '127.0.0.1', r));
});

after(() => {
  app.close();
  app.server.closeAllConnections();
  app.server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('engine args: stream-json with verbose, tools comma-joined, no skip-permissions flag', () => {
  const a = buildArgs({ allowedTools: ['Bash(git:*)', 'Read'], model: 'sonnet' });
  assert.deepEqual(a.slice(0, 4), ['-p', '--output-format', 'stream-json', '--verbose']);
  assert.ok(a.includes('Bash(git:*),Read'));
  assert.ok(!a.some((x) => x.includes('dangerously')));
  assert.ok(!a.includes('--strict-mcp-config'), 'MCP stays on by default (skill jobs)');
});

test('engine args: noMcp starts claude with an empty MCP config', () => {
  const a = buildArgs({ allowedTools: ['Read'], noMcp: true });
  const i = a.indexOf('--mcp-config');
  assert.ok(a.includes('--strict-mcp-config') && i > -1);
  assert.deepEqual(JSON.parse(a[i + 1]), { mcpServers: {} });
});

test('engine args: effort is passed to claude only when set', () => {
  const a = buildArgs({ allowedTools: [], effort: 'low' });
  assert.equal(a[a.indexOf('--effort') + 1], 'low');
  assert.ok(!buildArgs({ allowedTools: [] }).includes('--effort'));
});

test('redact masks secret-looking text (B5)', () => {
  assert.ok(!redact('key ghp_abcdefghijklmnopqrstuvwx').includes('ghp_abc'));
  assert.ok(!redact('password=hunter2hunter2').includes('hunter2'));
  assert.equal(redact('plain text'), 'plain text');
});

test('skills: only skills with a config permission entry are runnable', () => {
  const s = Object.fromEntries(listSkills(project, config()).map((x) => [x.name, x]));
  assert.equal(s.ok.runnable, true);
  assert.deepEqual(s.ok.allowedTools, ['Read']);
  assert.equal(s.noperm.runnable, false);
  assert.equal(s.ok.argumentHint, '<x>');
});

test('AC6: job streams log, writes meta, result.md and activity with project', async () => {
  const r = await api('POST', '/api/projects/JOB/jobs', { skill: 'ok', args: 'AIOS' });
  assert.equal(r.status, 201);
  const id = r.json.id;
  await waitFor(() => metaOf(id).status === 'done');
  const shown = (await api('GET', `/api/projects/JOB/jobs/${id}`)).json;
  assert.equal(shown.meta.cost, 0.01);
  assert.match(shown.request, /Args: AIOS/);
  assert.match(shown.result, /RESULT for:/);
  const log = (await api('GET', `/api/projects/JOB/jobs/${id}/log`)).json.entries;
  assert.ok(log.some((e) => e.kind === 'text'));
  assert.ok(log.some((e) => e.kind === 'tool' && e.name === 'Bash'));
  assert.ok(log.every((e) => e.project === 'JOB' && e.jobId === id));
  assert.ok(!JSON.stringify(log).includes('abcdef123456'), 'secret masked in the log');
  const ev = (await api('GET', '/api/projects/JOB/activity')).json.events;
  assert.ok(ev.some((e) => e.type === 'job.started' && e.ref === id && e.project === 'JOB'));
  assert.ok(ev.some((e) => e.type === 'job.finished' && e.ref === id));
});

test('AC8: feed merges job events with git commits, newest first, per project and combined', async () => {
  const ev = (await api('GET', '/api/projects/JOB/activity')).json.events;
  assert.ok(ev.some((e) => e.type === 'git.commit' && e.detail === 'first commit'));
  const times = ev.map((e) => Date.parse(e.ts));
  assert.deepEqual(times, [...times].sort((a, b) => b - a));
  const all = (await api('GET', '/api/activity')).json.events;
  assert.ok(all.every((e) => e.project));
  assert.ok(all.some((e) => e.type === 'git.commit'));
});

test('AC6+AC16: failed job shows failed with last output and moves its card to error', async () => {
  const card = (await api('POST', '/api/projects/JOB/cards', { title: 'Linked card', hat: 'self', status: 'in_progress' })).json;
  const r = await api('POST', '/api/projects/JOB/jobs', { skill: 'fail', card: card.key });
  assert.equal(r.status, 201);
  await waitFor(() => metaOf(r.json.id).status === 'failed');
  const meta = metaOf(r.json.id);
  assert.match(meta.error, /boom: something broke/);
  assert.equal(meta.exitCode, 1);
  const after = (await api('GET', `/api/projects/JOB/cards/${card.key}`)).json;
  assert.equal(after.status, 'error');
  const back = await api('POST', `/api/projects/JOB/cards/${card.key}/move`, { status: 'todo' });
  assert.equal(back.json.status, 'todo');
});

test('AC6: Stop ends the process tree and marks the job stopped', async () => {
  const childFile = `${pidFile}.child`;
  const r = await api('POST', '/api/projects/JOB/jobs', { skill: 'hang' });
  const id = r.json.id;
  await waitFor(() => fs.existsSync(childFile) && fs.readFileSync(childFile, 'utf8'));
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  const child = Number(fs.readFileSync(childFile, 'utf8'));
  assert.ok(alive(pid) && alive(child));
  const s = await api('POST', `/api/projects/JOB/jobs/${id}/stop`);
  assert.equal(s.status, 200);
  await waitFor(() => metaOf(id).status === 'stopped');
  await waitFor(() => !alive(pid) && !alive(child), 5000);
  fs.rmSync(childFile);
});

test('AC6: job over the time limit is stopped and fails with a timeout', async () => {
  const runner = createJobRunner({ engine: createClaudeHeadlessEngine({ command: process.execPath, baseArgs: [FAKE] }), config: { ...config(), jobTimeoutMs: 400 } });
  const meta = runner.start(project, { skill: 'hang' });
  await waitFor(() => runner.show(project, meta.id).meta.status === 'failed');
  assert.match(runner.show(project, meta.id).meta.error, /timeout/);
});

test('B4: skill without permission entry is refused; bad names cannot escape the skills folder', async () => {
  assert.equal((await api('POST', '/api/projects/JOB/jobs', { skill: 'noperm' })).status, 403);
  assert.equal((await api('POST', '/api/projects/JOB/jobs', { skill: '../../etc/passwd' })).status, 400);
  assert.equal((await api('POST', '/api/projects/JOB/jobs', { skill: 'missing' })).status, 404);
  assert.equal((await api('GET', '/api/projects/JOB/jobs/..%2F..%2Fx')).status, 400);
});

test('no waiting line: a third job is refused with 429, writes nothing, and leaves its card where it was', async () => {
  const card = (await api('POST', '/api/projects/JOB/cards', { title: 'Refused card', hat: 'self', status: 'todo' })).json;
  const before = (await api('GET', '/api/projects/JOB/jobs')).json.jobs.length;
  const a = (await api('POST', '/api/projects/JOB/jobs', { skill: 'hang' })).json.id;
  const b = (await api('POST', '/api/projects/JOB/jobs', { skill: 'hang' })).json.id;
  assert.equal(app.jobs.activeCount(), 2);
  const c = await api('POST', '/api/projects/JOB/jobs', { skill: 'ok', args: 'third', card: card.key });
  assert.equal(c.status, 429);
  assert.match(c.json.error, /slots are busy/);
  assert.equal((await api('GET', '/api/projects/JOB/jobs')).json.jobs.length, before + 2, 'the refused job left no folder');
  assert.equal((await api('GET', `/api/projects/JOB/cards/${card.key}`)).json.status, 'todo');
  await api('POST', `/api/projects/JOB/jobs/${a}/stop`);
  await waitFor(() => app.jobs.activeCount() === 1);
  const d = await api('POST', '/api/projects/JOB/jobs', { skill: 'ok', args: 'after a slot freed' });
  assert.equal(d.status, 201, 'a freed slot accepts a new job');
  await api('POST', `/api/projects/JOB/jobs/${b}/stop`);
  await waitFor(() => app.jobs.activeCount() === 0);
});

test('the card follows its job: In progress while it runs, back to its column when stopped', async () => {
  const runner = createJobRunner({ engine: createClaudeHeadlessEngine({ command: process.execPath, baseArgs: [FAKE] }), config: config() });
  const svc = app.projects.service(project);
  const card = (await api('POST', '/api/projects/JOB/cards', { title: 'Flow stop', hat: 'self', status: 'todo' })).json;
  const h = runner.start(project, { skill: 'hang', card: card.key, svc });
  assert.equal(svc.show(card.key).status, 'in_progress');
  runner.stop(project, h.id);
  await waitFor(() => runner.show(project, h.id).meta.status === 'stopped');
  assert.equal(svc.show(card.key).status, 'todo');
});

test('without a review skill a finished job sends its card straight to Human review', async () => {
  const runner = createJobRunner({ engine: createClaudeHeadlessEngine({ command: process.execPath, baseArgs: [FAKE] }), config: config() });
  const svc = app.projects.service(project);
  const card = (await api('POST', '/api/projects/JOB/cards', { title: 'Flow done', hat: 'self', status: 'backlog' })).json;
  const j = runner.start(project, { skill: 'ok', card: card.key, svc });
  await waitFor(() => runner.show(project, j.id).meta.status === 'done');
  assert.equal(svc.show(card.key).status, 'human_review');
});

test('with a review skill: finished work goes to AI review, a review job runs, then Human review', async () => {
  skill('review', 'Review: $ARGUMENTS');
  const cfg = { ...config(), reviewSkill: 'review', skills: { ...config().skills, review: { allowedTools: ['Read'] } } };
  const runner = createJobRunner({ engine: createClaudeHeadlessEngine({ command: process.execPath, baseArgs: [FAKE] }), config: cfg });
  const svc = app.projects.service(project);
  const card = (await api('POST', '/api/projects/JOB/cards', { title: 'Flow review', hat: 'self', status: 'todo' })).json;
  const seen = new Set();
  const j = runner.start(project, { skill: 'ok', card: card.key, svc });
  await waitFor(() => { seen.add(svc.show(card.key).status); return runner.list(project).some((m) => m.skill === 'review' && m.card === card.key && m.status === 'done'); });
  await waitFor(() => svc.show(card.key).status === 'human_review');
  assert.equal(runner.show(project, j.id).meta.status, 'done');
  const review = runner.list(project).find((m) => m.skill === 'review' && m.card === card.key);
  assert.equal(review.role, 'review');
  assert.match(review.args, new RegExp(`^${card.key} Flow review`));
  assert.equal(runner.list(project).filter((m) => m.card === card.key && m.role === 'review').length, 1, 'a review job does not start another review');
});

test('a failed review job moves the card to Error', async () => {
  const runner = createJobRunner({ engine: createClaudeHeadlessEngine({ command: process.execPath, baseArgs: [FAKE] }), config: { ...config(), reviewSkill: 'fail', maxJobs: 1 } });
  const svc = app.projects.service(project);
  const card = (await api('POST', '/api/projects/JOB/cards', { title: 'Review fails', hat: 'self', status: 'todo' })).json;
  const j = runner.start(project, { skill: 'ok', card: card.key, svc });
  await waitFor(() => runner.show(project, j.id).meta.status === 'done');
  await waitFor(() => svc.show(card.key).status === 'error');
});

test('a review that cannot start does not strand the card in AI review', async () => {
  // "noperm" exists as a skill but has no entry in config.skills, so starting it is refused (B4).
  const runner = createJobRunner({ engine: createClaudeHeadlessEngine({ command: process.execPath, baseArgs: [FAKE] }), config: { ...config(), reviewSkill: 'noperm' } });
  const svc = app.projects.service(project);
  const card = (await api('POST', '/api/projects/JOB/cards', { title: 'Review refused', hat: 'self', status: 'todo' })).json;
  const j = runner.start(project, { skill: 'ok', card: card.key, svc });
  await waitFor(() => runner.show(project, j.id).meta.status === 'done');
  await waitFor(() => svc.show(card.key).status === 'human_review');
  assert.equal(runner.list(project).filter((m) => m.card === card.key).length, 1, 'no review job was created');
});

test('a card the user moved meanwhile is left alone when its job ends', async () => {
  const runner = createJobRunner({ engine: createClaudeHeadlessEngine({ command: process.execPath, baseArgs: [FAKE] }), config: config() });
  const svc = app.projects.service(project);
  const card = (await api('POST', '/api/projects/JOB/cards', { title: 'User moves it', hat: 'self', status: 'todo' })).json;
  const h = runner.start(project, { skill: 'hang', card: card.key, svc });
  svc.move(card.key, 'done', { by: 'ui' });
  runner.stop(project, h.id);
  await waitFor(() => runner.show(project, h.id).meta.status === 'stopped');
  assert.equal(svc.show(card.key).status, 'done');
});

test('a failed job moves its card to error; stopAll stops running jobs', async () => {
  const runner = createJobRunner({ engine: createClaudeHeadlessEngine({ command: process.execPath, baseArgs: [FAKE] }), config: { ...config(), maxJobs: 1 } });
  const card = (await api('POST', '/api/projects/JOB/cards', { title: 'Will fail', hat: 'self', status: 'todo' })).json;
  const svc = app.projects.service(project);
  const f = runner.start(project, { skill: 'fail', card: card.key, svc });
  assert.throws(() => runner.start(project, { skill: 'ok' }), (e) => e.code === 'busy');
  await waitFor(() => runner.show(project, f.id).meta.status === 'failed');
  assert.equal(svc.show(card.key).status, 'error');

  const h = runner.start(project, { skill: 'hang' });
  runner.stopAll();
  await waitFor(() => runner.show(project, h.id).meta.status === 'stopped');
  assert.equal(runner.activeCount(), 0);
});

test('a job left queued by an older version and a dead server is reported as failed (interrupted)', async () => {
  const id = 'j-20200102-000000-abcd';
  const d = path.join(proj, '.artrios', 'jobs', id);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify({ id, project: 'JOB', skill: 'ok', status: 'queued', queued: '2020-01-02T00:00+07:00' }));
  const shown = (await api('GET', `/api/projects/JOB/jobs/${id}`)).json;
  assert.equal(shown.meta.status, 'failed');
  assert.match(shown.meta.error, /interrupted/);
});

test('a job left running by a dead server is reported as failed (interrupted)', async () => {
  const id = 'j-20200101-000000-abcd';
  const d = path.join(proj, '.artrios', 'jobs', id);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify({ id, project: 'JOB', skill: 'ok', status: 'running', started: '2020-01-01T00:00+07:00' }));
  const shown = (await api('GET', `/api/projects/JOB/jobs/${id}`)).json;
  assert.equal(shown.meta.status, 'failed');
  assert.match(shown.meta.error, /interrupted/);
});

test('AC2: job endpoints and the WebSocket reject missing token and foreign Origin', async () => {
  assert.equal((await api('POST', '/api/projects/JOB/jobs', { skill: 'ok' }, { cookie: '' })).status, 401);
  const open = (opts) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, opts);
    ws.on('open', () => { ws.close(); resolve(true); });
    ws.on('error', () => resolve(false));
    ws.on('unexpected-response', () => resolve(false));
  });
  assert.equal(await open({}), false, 'no token');
  assert.equal(await open({ headers: { cookie: `artrios_s=${TOKEN}`, origin: 'http://evil.example' } }), false, 'foreign origin');
  assert.equal(await open({ headers: { cookie: 'artrios_s=wrong' } }), false, 'wrong token');
  assert.equal(await open({ headers: { cookie: `artrios_s=${TOKEN}` } }), true, 'valid token');
});

test('F5: a connected browser receives job and activity events live', async () => {
  const msgs = [];
  const ws = await new Promise((resolve, reject) => {
    const w = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie: `artrios_s=${TOKEN}` } });
    w.on('open', () => resolve(w));
    w.on('error', reject);
    w.on('message', (m) => msgs.push(JSON.parse(m.toString())));
  });
  const r = await api('POST', '/api/projects/JOB/jobs', { skill: 'ok', args: 'live' });
  await waitFor(() => msgs.some((m) => m.type === 'job.status' && m.meta.status === 'done' && m.jobId === r.json.id));
  assert.ok(msgs.some((m) => m.type === 'job.log' && m.entry.kind === 'text'));
  assert.ok(msgs.some((m) => m.type === 'activity' && m.event.type === 'job.finished'));
  const c = await api('POST', '/api/projects/JOB/cards', { title: 'Live card', hat: 'self' });
  await waitFor(() => msgs.some((m) => m.type === 'activity' && m.event.type === 'card.created' && m.event.ref === c.json.key));
  ws.close();
});
