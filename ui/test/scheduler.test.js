// Scheduler, agents, approval gates, launcher (PRD AIOS-61 v2.0 S2, S2a, S3, S4, S7; AC 6-16).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseCron, fireTimes, nextFire } from '../server/cron.js';
import { createAgentService, parseAgentText, validateAgent } from '../server/agents.js';
import { createScheduleService, splitCommand } from '../server/schedules.js';
import { createLocations } from '../server/instance.js';
import { createScheduler, readHeartbeat, requestRun, READ_ONLY_TOOLS } from '../server/scheduler.js';
import { createJobRunner } from '../server/job-runner.js';
import { createClaudeHeadlessEngine } from '../server/engine.js';
import { createInboxService } from '../server/inbox-service.js';
import { createProjects } from '../server/projects.js';
import { writeAccount } from '../server/auth.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, 'fixtures', 'fake-claude.js');
const ROOT = path.resolve(HERE, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await sleep(25);
  }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

let base;
before(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'artrios-sched-')); });
after(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* windows may hold a file */ } });

// One instance: data dir, one workspace, agents folder, inbox, a scheduler on a fake clock.
function instance(name, { clock } = {}) {
  const root = path.join(base, name);
  const dataDir = path.join(root, 'data');
  const proj = path.join(root, 'proj');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify({ projects: [{ key: 'P', name: 'P', path: proj, hat: 'self' }] }));
  const t = { now: clock ?? new Date('2026-11-11T09:00:30') };
  const now = () => new Date(t.now);
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const config = { claudePath: process.execPath, claudeBaseArgs: [FAKE], maxJobs: 2, jobTimeoutMs: 20000, cognitionHome: { key: 'HOME', name: 'Artrios', path: home } };
  const inbox = createInboxService({ file: path.join(dataDir, 'inbox', 'events.jsonl'), now });
  const projects = createProjects({ dataDir, config });
  const agents = createAgentService({ dir: path.join(dataDir, 'agents') });
  const schedules = createScheduleService({ dir: path.join(dataDir, 'schedules') });
  const locations = createLocations({ config, projects });
  let sched = null;
  const jobs = createJobRunner({ engine: createClaudeHeadlessEngine({ command: process.execPath, baseArgs: [FAKE] }), config, now, onEvent: (e) => sched?.onJobEvent(e) });
  const mk = () => createScheduler({ dir: path.join(dataDir, 'scheduler'), schedules, agents, locate: locations.locate, allLocations: locations.allLocations, jobs, inbox, now });
  sched = mk();
  // One agent profile and one schedule with the same id that calls it (location: the workspace P).
  const PROFILE = ['allowedTools', 'approval', 'budget', 'model'];
  const agent = (id, extra = {}) => {
    const prof = Object.fromEntries(Object.entries(extra).filter(([k]) => PROFILE.includes(k)));
    const rest = Object.fromEntries(Object.entries(extra).filter(([k]) => !PROFILE.includes(k)));
    agents.create({ id, allowedTools: ['Read'], ...prof });
    const { instructions, ...s } = rest;
    return schedules.create({ id, agent: id, location: 'P', schedule: '0 9 * * *', prompt: instructions ?? 'Say hello.', ...s });
  };
  const project = projects.find('P');
  const jobsOf = (id, loc = project) => jobs.list(loc).filter((j) => j.schedule === id);
  return { root, dataDir, proj, home, t, now, inbox, agents, schedules, jobs, project, homeLoc: locations.home(), agent, jobsOf, get sched() { return sched; }, restart() { sched = mk(); return sched; } };
}
const settle = (I, id) => waitFor(() => { const j = I.jobsOf(id)[0]; return j && !['running', 'queued'].includes(j.status) && j; });

test('cron: fields, ranges, steps, weekday, fire times, next fire', () => {
  const c = parseCron('0 7 * * 1-5');
  const fires = fireTimes(c, new Date('2026-11-13T00:00'), new Date('2026-11-17T08:00')); // Fri .. Tue
  assert.deepEqual(fires.map((d) => d.getDate()), [13, 16, 17]);
  assert.equal(nextFire(parseCron('*/15 * * * *'), new Date('2026-11-11T09:07')).getMinutes(), 15);
  assert.equal(nextFire(parseCron('30 8 1 * *'), new Date('2026-11-11T09:00')).getMonth(), 11);
  assert.ok(parseCron('0 0 * * 7').dow.has(0));
  for (const bad of ['', '* * * *', '60 * * * *', '* * * * mon', '5-1 * * * *', '*/0 * * * *']) assert.throws(() => parseCron(bad), bad);
});

test('agent profiles and schedules: file syntax, round trip, broken files reported not fatal (AC 14)', () => {
  const { meta, body } = parseAgentText('---\nid: brain-lint\nname: "Brain # lint"\nallowedTools: [Read, Grep, Bash(git status:*)]   # tools\napproval: report-only\nbudget: { maxUsd: 0.5, maxMinutes: 10 }\nschema: 2\n---\nYou lint the brain.\n');
  const a = validateAgent(meta, body, { id: 'brain-lint' });
  assert.equal(a.name, 'Brain # lint');
  assert.deepEqual(a.allowedTools, ['Read', 'Grep', 'Bash(git status:*)']);
  assert.deepEqual(a.budget, { maxUsd: 0.5, maxMinutes: 10 });
  assert.equal(a.location, 'artrios', 'default location is the Artrios home');
  assert.deepEqual(splitCommand('powershell -File "scripts/a b.ps1" -X'), ['powershell', '-File', 'scripts/a b.ps1', '-X']);

  const I = instance('agents');
  I.agent('good', { budget: { maxUsd: 1 } });
  I.agent('sk', { skill: '/x lint', enabled: false });
  const cmd = I.schedules.create({ id: 'cmd', schedule: '0 9 * * *', command: 'node -e "process.exit(0)"', timeout: 60, exitWarn: [1] });
  assert.equal(cmd.type, 'command');
  assert.equal(cmd.location, 'artrios');
  fs.writeFileSync(path.join(I.dataDir, 'schedules', 'bad.md'), '---\nid: bad\nschedule: "every morning"\n---\nx\n');
  fs.writeFileSync(path.join(I.dataDir, 'schedules', 'other.md'), '---\nid: wrong\nschedule: "0 9 * * *"\n---\nx\n');
  fs.writeFileSync(path.join(I.dataDir, 'agents', 'nofm.md'), 'just text');
  const r = I.schedules.list();
  assert.deepEqual(r.schedules.map((x) => x.id), ['cmd', 'good', 'sk']);
  assert.equal(r.errors.length, 2);
  assert.match(r.errors.find((e) => e.file === 'bad.md').error, /schedule needs 5 fields/);
  assert.match(r.errors.find((e) => e.file === 'other.md').error, /does not match the file name/);
  assert.equal(I.agents.list().errors.length, 1);
  const back = I.schedules.get('sk');
  assert.equal(back.skill, 'x');
  assert.equal(back.args, 'lint');
  assert.equal(back.enabled, false);
  assert.equal(I.schedules.update('sk', { prompt: 'new prompt' }).skill, 'x', 'update keeps the skill');
  assert.equal(I.agents.get('good').budget.maxUsd, 1);
  assert.throws(() => I.agents.create({ id: 'good' }), /already exists/);
  assert.throws(() => I.agents.create({ id: 'x2', approval: 'yolo' }), /approval must be/);
  assert.throws(() => I.agents.create({ id: 'x3', budget: { maxUsd: -1 } }), /maxUsd/);
  assert.throws(() => I.schedules.create({ id: 'x4', schedule: '0 9 * * *' }), /needs a skill or a prompt/);
  assert.throws(() => I.schedules.create({ id: 'x5', schedule: '0 9 * * *', command: 'a | b' }), /without a shell/);
  assert.equal(I.schedules.update('cmd', { command: '', prompt: 'now an agent job' }).type, 'agent', 'clearing the command makes it an agent schedule');
  I.schedules.update('cmd', { command: 'node -e "process.exit(0)"', prompt: '' });

  // broken files do not stop the others from running (AC 14)
  const s = I.sched;
  s.tick();
  I.t.now = new Date('2026-11-12T09:00:20');
  const hb = s.tick();
  assert.equal(hb.errors.length, 3);
  assert.equal(I.jobsOf('good').length, 1);
});

test('command schedule runs in the Artrios home without a shell; exitWarn is a warning, not a failure', async () => {
  const I = instance('command', { clock: new Date('2026-11-12T08:00') });
  I.schedules.create({ id: 'health', schedule: '0 9 * * *', command: `"${process.execPath}" -e "console.log('7 findings'); process.exit(1)"`, exitWarn: [1], timeout: 30 });
  I.schedules.create({ id: 'broken', schedule: '0 9 * * *', command: `"${process.execPath}" -e "process.exit(2)"` });
  I.schedules.create({ id: 'nothere', schedule: '5 9 * * *', command: 'no-such-program-xyz' }); // later: two slots
  I.sched.tick();
  I.t.now = new Date('2026-11-12T09:00:20');
  I.sched.tick();
  const done = (id) => waitFor(() => { const j = I.jobsOf(id, I.homeLoc)[0]; return j && j.status !== 'running' && j; });
  const h = await done('health');
  assert.equal(h.status, 'done');
  assert.equal(h.warning, true);
  assert.equal(h.exitCode, 1);
  assert.ok(fs.readFileSync(path.join(I.home, '.artrios', 'jobs', h.id, 'log.jsonl'), 'utf8').includes('7 findings'));
  assert.equal((await done('broken')).status, 'failed');
  I.t.now = new Date('2026-11-12T09:05:20');
  I.sched.tick();
  assert.equal((await done('nothere')).status, 'failed');
  assert.equal(I.inbox.pendingCount(), 0, JSON.stringify(I.inbox.list()));
});

test('schedule without an agent runs as the default read-only profile; agent location artrios uses the home', async () => {
  const I = instance('default-agent');
  I.schedules.create({ id: 'ask', schedule: '0 9 * * *', prompt: 'WRITE something.' });
  I.sched.tick();
  I.t.now = new Date('2026-11-12T09:00:20');
  I.sched.tick();
  const j = await waitFor(() => { const x = I.jobsOf('ask', I.homeLoc)[0]; return x && x.status !== 'running' && x; });
  assert.equal(j.agent, 'bawaan');
  assert.equal(j.status, 'done');
  assert.deepEqual(j.allowedTools, READ_ONLY_TOOLS);
  assert.ok(!fs.existsSync(path.join(I.home, 'agent-wrote.txt')));
});

test('scheduler runs a due agent without the UI, logs the job, writes the heartbeat (AC 7)', async () => {
  const I = instance('due', { clock: new Date('2026-11-11T08:59:50') });
  I.agent('hello', { instructions: 'Say hello.' });
  I.sched.tick(); // first tick: nothing missed, nothing due
  assert.equal(I.jobsOf('hello').length, 0);
  I.t.now = new Date('2026-11-11T09:00:20');
  const hb = I.sched.tick();
  const j = await settle(I, 'hello');
  assert.equal(j.status, 'done');
  assert.ok(fs.readFileSync(path.join(I.proj, '.artrios', 'jobs', j.id, 'log.jsonl'), 'utf8').includes('finished'));
  assert.equal(hb.next.hello.slice(0, 10), new Date('2026-11-12T09:00').toISOString().slice(0, 10));
  const read = readHeartbeat(path.join(I.dataDir, 'scheduler'), { now: I.now });
  assert.equal(read.alive, true);
  assert.equal(read.pid, process.pid);
  assert.equal(I.inbox.pendingCount(), 0);
  I.sched.stop();
  assert.equal(readHeartbeat(path.join(I.dataDir, 'scheduler'), { now: I.now }).alive, false);
});

test('missed schedules become one missed_run each, never run, no duplicates after restart; run now starts it (AC 8)', async () => {
  const I = instance('missed', { clock: new Date('2026-11-09T12:00') });
  I.agent('daily', { schedule: '0 9 * * *' });
  I.sched.tick();
  I.t.now = new Date('2026-11-11T12:00'); // off for two days: 10th 09:00 and 11th 09:00 fell
  I.sched.tick();
  let items = I.inbox.list({ kind: 'missed_run' });
  assert.deepEqual(items.map((i) => i.key), ['jadwal/daily/2026-11-10T09:00', 'jadwal/daily/2026-11-11T09:00']);
  assert.equal(items[0].expires, null);
  assert.deepEqual(items[0].options, ['jalankan sekarang', 'lewati']);
  assert.equal(I.jobsOf('daily').length, 0);

  // restart with an old state file: the same falls are not filed again
  fs.writeFileSync(path.join(I.dataDir, 'scheduler', 'state.json'), JSON.stringify({ lastTick: new Date('2026-11-09T12:00').toISOString(), agents: {} }));
  I.restart().tick();
  assert.equal(I.inbox.list({ kind: 'missed_run' }).length, 2);

  I.inbox.decide(items[0].id, { by: 'administrator', decision: 'lewati' });
  I.inbox.decide(items[1].id, { by: 'administrator', decision: 'jalankan sekarang' });
  I.sched.tick();
  const j = await settle(I, 'daily');
  assert.equal(j.status, 'done');
  items = I.inbox.list({ kind: 'missed_run' });
  assert.equal(items[0].applied.result, 'skipped');
  assert.match(items[1].applied.result, /^started j-/);
  assert.equal(I.jobsOf('daily').length, 1);
});

test('ask-before-write waits without writing; approve continues the session and writes (AC 9)', async () => {
  const I = instance('gate-ok');
  I.sched.tick();
  I.agent('writer', { instructions: 'WRITE a file.', allowedTools: ['Read', 'Write'], approval: 'ask-before-write' });
  I.t.now = new Date('2026-11-12T09:00:10');
  I.sched.tick();
  const j = await waitFor(() => I.jobsOf('writer').find((x) => x.status === 'waiting_approval'));
  assert.ok(!fs.existsSync(path.join(I.proj, 'agent-wrote.txt')));
  const item = await waitFor(() => I.inbox.list({ kind: 'approval_request', status: 'pending' })[0]);
  assert.equal(item.jobId, j.id);
  assert.match(item.question, /ingin menulis: Write/);
  assert.ok(!item.question.includes('abcdef1234567'), 'secret in tool input is masked (AC 16)');
  assert.ok(item.expires, 'approval requests expire');
  I.inbox.decide(item.id, { by: 'administrator', decision: 'setuju' });
  I.sched.tick();
  const done = await settle(I, 'writer');
  assert.equal(done.status, 'done');
  assert.equal(fs.readFileSync(path.join(I.proj, 'agent-wrote.txt'), 'utf8').trim(), 'written after resume');
  assert.equal(I.inbox.get(item.id).applied.result, 'continued');
});

test('ask-before-write: reject closes rejected, expiry closes expired, neither writes (AC 9)', async () => {
  const I = instance('gate-no');
  I.sched.tick();
  I.agent('w1', { instructions: 'WRITE one.', allowedTools: ['Read', 'Write'], approval: 'ask-before-write' });
  I.agent('w2', { instructions: 'WRITE two.', allowedTools: ['Read', 'Write'], approval: 'ask-before-write' });
  I.t.now = new Date('2026-11-12T09:00:10');
  I.sched.tick();
  await waitFor(() => I.inbox.list({ kind: 'approval_request', status: 'pending' }).length === 2);
  const [a, b] = I.inbox.list({ kind: 'approval_request', status: 'pending' });
  I.inbox.decide(a.id, { by: 'administrator', decision: 'tolak', note: 'no' });
  I.t.now = new Date('2026-11-20T10:00'); // past the 7-day expiry of the other one
  I.sched.tick();
  const st = (id) => I.jobs.show(I.project, id).meta.status;
  assert.equal(st(a.jobId), 'rejected');
  assert.equal(st(b.jobId), 'expired');
  assert.equal(I.inbox.get(b.id).status, 'expired');
  assert.ok(!fs.existsSync(path.join(I.proj, 'agent-wrote.txt')));
});

test('ask-before-run waits before starting; approve runs it', async () => {
  const I = instance('gate-run');
  I.sched.tick();
  I.agent('runner', { instructions: 'Say hello.', approval: 'ask-before-run' });
  I.t.now = new Date('2026-11-12T09:00:10');
  I.sched.tick();
  const j = I.jobsOf('runner')[0];
  assert.equal(j.status, 'waiting_approval');
  assert.ok(!fs.existsSync(path.join(I.proj, '.artrios', 'jobs', j.id, 'log.jsonl')));
  const item = I.inbox.list({ kind: 'approval_request', status: 'pending' })[0];
  assert.match(item.question, /minta izin untuk mulai/);
  I.inbox.decide(item.id, { by: 'administrator', decision: 'setuju' });
  I.sched.tick();
  assert.equal((await settle(I, 'runner')).status, 'done');
});

test('auto runs without a waiting item but within allowedTools; report-only never writes (AC 10, §11)', async () => {
  const I = instance('auto');
  I.sched.tick();
  I.agent('auto-w', { instructions: 'WRITE it.', allowedTools: ['Read', 'Write'], approval: 'auto' });
  I.t.now = new Date('2026-11-12T09:00:10');
  I.sched.tick();
  assert.equal((await settle(I, 'auto-w')).status, 'done');
  assert.ok(fs.existsSync(path.join(I.proj, 'agent-wrote.txt')));
  assert.equal(I.inbox.pendingCount(), 0);
  fs.rmSync(path.join(I.proj, 'agent-wrote.txt'));

  I.agent('auto-r', { instructions: 'WRITE it.', allowedTools: ['Read'], approval: 'auto', schedule: '5 9 * * *' });
  I.agent('report', { instructions: 'WRITE it.', allowedTools: ['Read', 'Write', 'Bash'], approval: 'report-only', schedule: '5 9 * * *' });
  I.t.now = new Date('2026-11-12T09:05:10');
  I.sched.tick();
  const r1 = await settle(I, 'auto-r');
  const r2 = await settle(I, 'report');
  assert.equal(r1.denials, 1);
  assert.deepEqual(r2.allowedTools, ['Read']);
  assert.ok(READ_ONLY_TOOLS.includes('Read') && !READ_ONLY_TOOLS.includes('Bash'));
  assert.ok(!fs.existsSync(path.join(I.proj, 'agent-wrote.txt')));
  assert.equal(I.inbox.pendingCount(), 0);
});

test('over budget: job stops as failed and files an item; rerun works (AC 15)', async () => {
  const I = instance('budget');
  I.sched.tick();
  I.agent('spender', { instructions: 'EXPENSIVE work.', budget: { maxUsd: 1 } });
  I.t.now = new Date('2026-11-12T09:00:10');
  I.sched.tick();
  const j = await settle(I, 'spender');
  assert.equal(j.status, 'failed');
  assert.equal(j.budgetExceeded, true);
  assert.match(j.error, /budget/);
  const item = await waitFor(() => I.inbox.list({ status: 'pending' })[0]);
  assert.deepEqual(item.options, ['jalankan ulang', 'tutup']);
  I.inbox.decide(item.id, { by: 'administrator', decision: 'tutup' });
  I.sched.tick();
  assert.equal(I.inbox.get(item.id).applied.result, 'skipped');

  // maxMinutes stops a hanging run
  I.agent('slow', { instructions: 'HANG forever.', budget: { maxMinutes: 0.01 }, schedule: '5 9 * * *' });
  I.t.now = new Date('2026-11-12T09:05:10');
  I.sched.tick();
  const s = await settle(I, 'slow');
  assert.equal(s.status, 'failed');
  assert.match(s.error, /maxMinutes/);
});

test('secrets in job output are masked in the log and the inbox (AC 16)', async () => {
  const I = instance('secret');
  I.sched.tick();
  I.agent('leaky', { instructions: 'SECRET output.' });
  I.t.now = new Date('2026-11-12T09:00:10');
  I.sched.tick();
  const j = await settle(I, 'leaky');
  const dir = path.join(I.proj, '.artrios', 'jobs', j.id);
  const log = fs.readFileSync(path.join(dir, 'log.jsonl'), 'utf8');
  const result = fs.readFileSync(path.join(dir, 'result.md'), 'utf8');
  for (const s of ['ghp_abcdefghijklmnopqrstuvwxyz123456', 'hunter22222', 'supersecretvalue']) {
    assert.ok(!log.includes(s) && !result.includes(s), s);
  }
  // the inbox side: a denied write whose input holds a token (see the ask-before-write test) is masked in the file too
  I.agent('leaky-w', { instructions: 'WRITE it.', allowedTools: ['Read', 'Write'], approval: 'ask-before-write', schedule: '5 9 * * *' });
  I.t.now = new Date('2026-11-12T09:05:10');
  I.sched.tick();
  await waitFor(() => I.inbox.pendingCount() === 1);
  const inboxText = fs.readFileSync(path.join(I.dataDir, 'inbox', 'events.jsonl'), 'utf8');
  assert.ok(!inboxText.includes('abcdef1234567'));
});

test('run now request from the UI is picked up on the next tick; overlap is refused', async () => {
  const I = instance('request');
  I.agent('manual', { instructions: 'HANG a while.', budget: { maxMinutes: 0.05 } });
  I.sched.tick();
  requestRun(path.join(I.dataDir, 'scheduler'), 'manual');
  requestRun(path.join(I.dataDir, 'scheduler'), 'manual');
  I.sched.tick();
  assert.equal(I.jobsOf('manual').length, 1, 'second request refused while the first runs');
  assert.ok(I.sched.recent().some((e) => /still going/.test(e.text)));
  assert.equal(fs.readdirSync(path.join(I.dataDir, 'scheduler', 'requests')).length, 0);
  await settle(I, 'manual');
});

test('inbox: UI and scheduler writing at once keep the file whole (AC 12)', async () => {
  const dir = path.join(base, 'lock');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'events.jsonl');
  const script = path.join(dir, 'writer.mjs');
  const mod = path.join(ROOT, 'server', 'inbox-service.js').replaceAll('\\', '/');
  fs.writeFileSync(script, `import { createInboxService } from 'file:///${mod.replace(/^\//, '')}';\nconst s = createInboxService({ file: process.argv[2] });\nfor (let i = 0; i < 25; i++) s.create({ kind: 'missed_run', from: 'scheduler', workspace: 'jadwal', subject: 'a', topic: process.argv[3] + '-' + i, question: 'q', options: ['lewati'] });\n`);
  const run = (tag) => new Promise((res, rej) => execFile(process.execPath, [script, file, tag], (e) => (e ? rej(e) : res())));
  await Promise.all([run('A'), run('B'), run('C')]);
  const s = createInboxService({ file });
  const items = s.list();
  assert.equal(items.length, 75);
  assert.equal(new Set(items.map((i) => i.id)).size, 75);
});

test('UI job list leaves a job owned by a live scheduler process alone', () => {
  const I = instance('owner');
  const id = 'j-20261111-090000-abcd';
  const d = path.join(I.proj, '.artrios', 'jobs', id);
  fs.mkdirSync(d, { recursive: true });
  const other = spawn(process.execPath, ['-e', 'setTimeout(()=>{},5000)']);
  fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify({ id, project: 'P', status: 'running', pid: other.pid, agent: 'x' }));
  assert.equal(I.jobs.list(I.project)[0].status, 'running');
  other.kill();
  fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify({ id, project: 'P', status: 'running', pid: 999999, agent: 'x' }));
  assert.equal(I.jobs.list(I.project)[0].status, 'failed');
});

test('routines API: schedules with next run, agent profiles, locations, run now needs a live scheduler, home job logs (S7)', async () => {
  const { createApp } = await import('../server/app.js');
  const http = await import('node:http');
  const I = instance('api', { clock: new Date() });
  const port = await freePort();
  const app = createApp({ config: { claudePath: process.execPath, claudeBaseArgs: [FAKE], cognitionHome: { key: 'HOME', name: 'Artrios', path: I.home } }, dataDir: I.dataDir, port, clientDir: null });
  const sid = app.auth.openSession();
  await new Promise((r) => app.server.listen(port, '127.0.0.1', r));
  const call = (method, url, body) => new Promise((resolve, reject) => {
    const h = { host: `127.0.0.1:${port}`, cookie: `artrios_s=${sid}` };
    if (body !== undefined) h['content-type'] = 'application/json';
    const r = http.request({ host: '127.0.0.1', port, method, path: url, headers: h }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, json: d ? JSON.parse(d) : null }));
    });
    r.on('error', reject);
    r.end(body === undefined ? undefined : JSON.stringify(body));
  });
  try {
    let r = await call('POST', '/api/agents', { id: 'a1', name: 'Peninjau', instructions: 'You review.', allowedTools: ['Read'], approval: 'auto', budget: { maxUsd: 0.2 } });
    assert.equal(r.status, 201);
    assert.equal((await call('POST', '/api/agents', { id: 'a2', approval: 'nope' })).status, 400);
    r = await call('POST', '/api/schedules', { id: 's1', name: 'Tinjau pagi', schedule: '*/5 * * * *', agent: 'a1', prompt: 'Say hello.' });
    assert.equal(r.status, 201);
    assert.equal(r.json.location, 'artrios');
    assert.equal((await call('POST', '/api/schedules', { id: 's2', schedule: 'nope', prompt: 'x' })).status, 400);
    fs.writeFileSync(path.join(I.dataDir, 'agents', 'broken.md'), 'no frontmatter');
    r = await call('GET', '/api/routines');
    assert.equal(r.json.schedules.length, 1);
    assert.equal(r.json.schedules[0].agentName, 'Peninjau');
    assert.equal(r.json.schedules[0].locationName, 'Artrios');
    assert.ok(r.json.schedules[0].next);
    assert.deepEqual(r.json.agents[0].usedBy, ['s1']);
    assert.equal(r.json.errors.length, 1);
    assert.deepEqual(r.json.locations.map((l) => l.key), ['artrios', 'P']);
    assert.equal(r.json.scheduler.alive, false);
    assert.equal((await call('POST', '/api/schedules/s1/run', {})).status, 503, 'no scheduler, no run');
    I.sched.tick(); // a live heartbeat from this process
    assert.equal((await call('GET', '/api/routines')).json.scheduler.alive, true);
    assert.equal((await call('POST', '/api/schedules/s1/run', {})).status, 202);
    I.sched.tick();
    const j = await waitFor(() => { const x = I.jobsOf('s1', I.homeLoc)[0]; return x && x.status !== 'running' && x; });
    r = await call('GET', '/api/schedules/s1/jobs');
    assert.equal(r.json.project, 'HOME');
    assert.equal(r.json.jobs[0].id, j.id);
    assert.equal((await call('GET', `/api/projects/HOME/jobs/${j.id}/log`)).status, 200, 'home job log readable');
    assert.equal((await call('GET', '/api/routines')).json.schedules[0].last.status, 'done');
    assert.equal((await call('DELETE', '/api/agents/a1')).status, 409, 'agent still used by a schedule');
    r = await call('POST', '/api/schedules/s1/enabled', { enabled: false });
    assert.equal(r.json.enabled, false);
    assert.equal((await call('GET', '/api/routines')).json.schedules[0].next, null);
    assert.equal((await call('DELETE', '/api/schedules/s1')).status, 200);
    assert.equal((await call('DELETE', '/api/agents/a1')).status, 200);
    assert.equal((await call('GET', '/api/schedules/nope')).status, 404);
  } finally {
    app.close();
    app.server.close();
  }
});

const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

test('launcher: two processes; UI stopping leaves the scheduler; stopping the launcher stops both (AC 6)', async () => {
  const I = instance('launcher');
  const port = await freePort();
  fs.writeFileSync(path.join(I.dataDir, 'config.json'), JSON.stringify({ port, claudePath: process.execPath, claudeBaseArgs: [FAKE] }));
  writeAccount(path.join(I.dataDir, 'users.json'), 'launcher-pass-1');
  const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'start.js'), '--data', I.dataDir, '--tick-ms', '1000'], {
    cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ARTRIOS_START_STOP_ON_STDIN_END: '1' },
  });
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  child.stderr.on('data', (c) => (out += c));
  try {
    const m = await waitFor(() => /UI pid (\d+), scheduler pid (\d+)/.exec(out));
    const [uiPid, schedPid] = [Number(m[1]), Number(m[2])];
    await waitFor(() => out.includes('Artrios UI:'));
    await waitFor(() => readHeartbeat(path.join(I.dataDir, 'scheduler')).alive);
    process.kill(uiPid); // the UI dies on its own
    await waitFor(() => !alive(uiPid));
    await sleep(2500);
    const hb = readHeartbeat(path.join(I.dataDir, 'scheduler'));
    assert.equal(hb.alive, true, 'scheduler keeps ticking without the UI');
    assert.equal(hb.pid, schedPid);
    assert.ok(alive(schedPid));
    child.stdin.end(); // stop the launcher
    await waitFor(() => !alive(schedPid) && child.exitCode !== null, 15000);
    assert.equal(readHeartbeat(path.join(I.dataDir, 'scheduler')).alive, false);
  } finally {
    if (child.exitCode === null) child.kill();
  }
});
