// Cognition Tahap 1 (PRD prd-cognition AC 1-5) against a fake stream-json claude.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChatService, encodeCwd, readTranscript, skillUsage, DEFAULT_PINNED } from '../server/chat-service.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude-chat.js');
let root, home, ws, chatDir, events, svc;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await sleep(20);
  }
}
const projects = { find: (k) => (k === 'W' ? { key: 'W', path: ws, hat: 'personal' } : null) };
const make = () => createChatService({ config: { claudePath: process.execPath, claudeBaseArgs: [FAKE] }, chatDir, projects, home, onEvent: (e) => events.push(e) });
const idle = (id) => waitFor(() => events.some((e) => e.id === id && e.ev === 'status' && e.done) && svc.get('W', id).status === 'idle');
const lastArgs = () => JSON.parse(fs.readFileSync(path.join(home, 'args.log'), 'utf8').trim().split('\n').pop());
const skill = (dir, name) => { fs.mkdirSync(path.join(dir, name), { recursive: true }); fs.writeFileSync(path.join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} test\n---\nbody\n`); };

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-test-'));
  home = path.join(root, 'home');
  ws = path.join(root, 'ws');
  chatDir = path.join(root, 'data', 'chat');
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  process.env.FAKE_CHAT_HOME = home;
  events = [];
  svc = make();
});
after(() => { svc.stopAll(); fs.rmSync(root, { recursive: true, force: true }); });

test('encodeCwd follows the CLI folder rule', () => {
  assert.equal(encodeCwd('D:\\ai\\home'), process.platform === 'win32' ? 'D--ai-home' : encodeCwd('D:\\ai\\home'));
  assert.match(encodeCwd('/x/.claude/a.b'), /^-x--claude-a-b$|^[A-Za-z]--x--claude-a-b$/);
});

test('AC 1: a CLI session is listed and resumed with --resume; a UI session is stored where the CLI finds it', async () => {
  const id = '11111111-2222-4333-8444-555555555555';
  const dir = path.join(home, '.claude', 'projects', encodeCwd(ws));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), [
    { type: 'ai-title', aiTitle: 'Sesi dari CLI', sessionId: id },
    { type: 'user', message: { role: 'user', content: 'halo dari CLI' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hai' }] } },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');
  const listed = svc.list('W');
  assert.ok(listed.some((s) => s.id === id && s.title === 'Sesi dari CLI' && s.source === 'cli'));
  const before = svc.get('W', id);
  assert.deepEqual(before.items.map((i) => i.kind), ['user', 'assistant']);
  svc.send('W', id, { text: 'lanjut' });
  await idle(id);
  assert.ok(lastArgs().includes('--resume'));
  assert.equal(svc.get('W', id).items.at(-1).text, 'echo(claude-sonnet-x): lanjut');

  const m = svc.create('W', { model: 'haiku' });
  svc.send('W', m.id, { text: 'sesi baru' });
  await idle(m.id);
  const a = lastArgs();
  assert.ok(a.includes('--session-id') && a.includes(m.id) && !a.includes('--resume'));
  assert.ok(fs.existsSync(path.join(dir, `${m.id}.jsonl`)), 'transcript in the CLI store, so `claude --resume <id>` finds it');
  assert.equal(svc.list('W')[0].id, m.id);
});

test('AC 2: permission card: once, always (writes a localSettings rule), deny stops only that tool', async () => {
  const m = svc.create('W');
  for (const [decision, expect] of [['once', 'allowed'], ['always', 'allowed'], ['deny', 'denied: Denied by the user.']]) {
    svc.send('W', m.id, { text: 'please WRITE' });
    const p = await waitFor(() => svc.get('W', m.id).pending[0]);
    assert.equal(p.kind, 'permission');
    assert.equal(p.tool, 'Write');
    svc.answer('W', m.id, { requestId: p.requestId, decision });
    await waitFor(() => svc.get('W', m.id).status === 'idle' && svc.get('W', m.id).items.at(-1)?.text === expect);
    if (decision === 'always') {
      const rules = JSON.parse(fs.readFileSync(path.join(home, 'rules.json'), 'utf8'));
      assert.equal(rules[0].destination, 'localSettings');
      assert.equal(rules[0].type, 'addRules');
    }
  }
  assert.throws(() => svc.answer('W', m.id, { requestId: 'nope', decision: 'once' }), /no such pending/);
});

test('AC 3: plan mode does not write; accept edits writes without a card (mode changes between turns)', async () => {
  const m = svc.create('W');
  svc.send('W', m.id, { text: 'hi' });
  await idle(m.id);
  await svc.setOptions('W', m.id, { mode: 'plan' });
  events = [];
  svc.send('W', m.id, { text: 'WRITE' });
  await idle(m.id);
  assert.equal(svc.get('W', m.id).items.at(-1).text, 'plan mode: not written');
  await svc.setOptions('W', m.id, { mode: 'acceptEdits' });
  events = [];
  svc.send('W', m.id, { text: 'WRITE' });
  await idle(m.id);
  assert.equal(svc.get('W', m.id).items.at(-1).text, 'written without asking');
  await assert.rejects(svc.setOptions('W', m.id, { mode: 'bypassPermissions' }), /mode must be/);
});

test('AskUserQuestion card returns the chosen label', async () => {
  const m = svc.create('W');
  svc.send('W', m.id, { text: 'ASK me' });
  const p = await waitFor(() => svc.get('W', m.id).pending[0]);
  assert.equal(p.kind, 'question');
  svc.answer('W', m.id, { requestId: p.requestId, decision: 'once', answers: { 'Buah?': 'Jeruk' } });
  await waitFor(() => svc.get('W', m.id).items.at(-1)?.text === 'jawab: Jeruk');
});

test('AC 4 and model/effort: /skill goes as typed; model switch keeps the session; effort restarts with --resume', async () => {
  const m = svc.create('W');
  events = [];
  svc.send('W', m.id, { text: '/grill-me rencana X' });
  await idle(m.id);
  const t = svc.get('W', m.id);
  assert.equal(t.items[0].text, '/grill-me rencana X');
  await svc.setOptions('W', m.id, { model: 'opus' });
  events = [];
  svc.send('W', m.id, { text: 'model?' });
  await idle(m.id);
  assert.equal(svc.get('W', m.id).items.at(-1).text, 'echo(opus): model?');
  await svc.setOptions('W', m.id, { effort: 'high' });
  await waitFor(() => svc.liveCount() === 0 || !svc.list('W').find((s) => s.id === m.id && s.status !== 'idle'));
  await sleep(300);
  events = [];
  svc.send('W', m.id, { text: 'lagi' });
  await idle(m.id);
  const a = lastArgs();
  assert.ok(a.includes('--resume') && a[a.indexOf('--effort') + 1] === 'high' && a[a.indexOf('--model') + 1] === 'opus');
  assert.throws(() => svc.send('W', m.id, { text: '/clear' }), /new session/);
});

test('interrupt stops a running turn', async () => {
  const m = svc.create('W');
  svc.send('W', m.id, { text: 'SLOW' });
  await waitFor(() => svc.get('W', m.id).status === 'running');
  assert.throws(() => svc.send('W', m.id, { text: 'again' }), /still running/);
  await svc.interrupt('W', m.id);
  await waitFor(() => svc.get('W', m.id).status === 'idle');
});

test('attachments: images become image blocks, other files are saved and named by path', async () => {
  const m = svc.create('W');
  const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
  svc.send('W', m.id, { text: 'lihat', attachments: [{ name: 'a.png', mime: 'image/png', data: png }, { name: 'data.xlsx', mime: 'application/octet-stream', data: Buffer.from('xlsx').toString('base64') }] });
  await idle(m.id);
  const last = svc.get('W', m.id).items.at(-1).text;
  assert.match(last, /1 img/);
  assert.match(last, /data\.xlsx/);
  assert.equal(fs.readdirSync(path.join(chatDir, 'uploads', m.id)).length, 1);
});

test('AC 5: quick actions: four default pins, the rest pinned by hand, pins survive a restart', () => {
  const g = path.join(home, '.claude', 'skills');
  for (const n of ['grill-me', 'commit-this', 'worklog', 'task-sync', 'compact-project', 'ask-me']) skill(g, n);
  skill(path.join(ws, '.claude', 'skills'), 'lokal');
  fs.writeFileSync(path.join(home, '.claude', 'history.jsonl'), ['/worklog', '/worklog', '/worklog', '/task-sync', '/tidak-ada', '/lokal'].map((d) => JSON.stringify({ display: d })).join('\n'));
  assert.equal(skillUsage(path.join(home, '.claude', 'history.jsonl')).worklog, 3);
  const q = svc.quickActions('W').items;
  assert.deepEqual(q.map((x) => x.name), ['compact', 'compact-project', 'ask-me', 'clear'], 'only the default pins, even when other skills are used more');
  assert.ok(q.every((x) => x.pinned));
  assert.ok(svc.quickActions('W').all.some((x) => x.name === 'worklog' && !x.pinned), 'other skills are in the pin panel, unpinned');
  svc.pin('W', 'lokal', true);
  const again = make().quickActions('W').items;
  assert.deepEqual(again.map((x) => x.name), ['compact', 'compact-project', 'ask-me', 'clear', 'lokal'], 'a manual pin keeps the defaults');
  svc.pin('W', 'clear', false);
  assert.ok(!make().quickActions('W').items.some((x) => x.name === 'clear'), 'a default can be unpinned');
  assert.ok(svc.commands('W').some((c) => c.name === 'compact' && c.builtin));
});

test('auto-compact: runs /compact after a turn that ends above the limit, once, and never when off', async () => {
  const log = path.join(home, 'compact.log');
  fs.rmSync(log, { force: true });
  const ev = [];
  const big = createChatService({ config: { claudePath: process.execPath, claudeBaseArgs: [FAKE], autoCompactTokens: 500 }, chatDir: path.join(root, 'data', 'chat-auto'), projects, home, onEvent: (e) => ev.push(e) });
  const { id } = big.create('W');
  big.send('W', id, { text: 'halo' });
  await waitFor(() => fs.existsSync(log) && big.get('W', id).status === 'idle');
  assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 1, 'compacted exactly once');
  assert.ok(ev.some((e) => e.ev === 'item' && /compacting automatically/.test(e.item?.text ?? '')));
  big.stopAll();
  fs.rmSync(log, { force: true });
  const off = createChatService({ config: { claudePath: process.execPath, claudeBaseArgs: [FAKE], autoCompactTokens: 0 }, chatDir: path.join(root, 'data', 'chat-off'), projects, home, onEvent: () => {} });
  const o = off.create('W');
  off.send('W', o.id, { text: 'halo' });
  await waitFor(() => off.get('W', o.id).status === 'idle' && off.get('W', o.id).items.length >= 2);
  assert.ok(!fs.existsSync(log), 'limit 0 never compacts');
  off.stopAll();
});

test('Cognition home is its own folder; Insights workspaces are the registered ones; data sits in <workspace>/.artrios/chat', async () => {
  const homeDir = path.join(root, 'home-ws');
  fs.mkdirSync(homeDir, { recursive: true });
  const s = createChatService({ config: { claudePath: process.execPath, claudeBaseArgs: [FAKE], cognitionHome: { key: 'home', path: homeDir } }, projects: { ...projects, all: () => [{ key: 'W', path: ws }] }, home, onEvent: () => {} });
  const r = s.workspaces();
  assert.equal(r.home.key, 'home');
  assert.deepEqual(r.workspaces.map((w) => w.key), ['W'], 'the home folder is not an Insights workspace');
  assert.equal(r.default, 'home');
  const c = s.create('home');
  assert.ok(fs.existsSync(path.join(homeDir, '.artrios', 'chat', 'sessions.json')));
  const i = s.create('W');
  assert.ok(JSON.parse(fs.readFileSync(path.join(ws, '.artrios', 'chat', 'sessions.json'), 'utf8')).sessions[i.id]);
  assert.equal(s.list('home').length, 1);
  assert.equal(s.list('home')[0].id, c.id);
  s.pin('home', 'grill-me', true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(homeDir, '.artrios', 'chat', 'quick-actions.json'), 'utf8')).pinned, [...DEFAULT_PINNED, 'grill-me']);
  // add-dir: folders join the session as --add-dir; a missing folder is refused.
  await s.setOptions('home', c.id, { addDirs: [ws] });
  assert.throws(() => s.create('home', { addDirs: [path.join(root, 'nope')] }), /not a folder/);
  s.send('home', c.id, { text: 'halo' });
  await waitFor(() => s.get('home', c.id).status === 'idle' && s.get('home', c.id).items.some((x) => x.kind === 'assistant'));
  const a = lastArgs();
  assert.equal(a[a.indexOf('--add-dir') + 1], path.resolve(ws));
  s.stopAll();
});

test('a session held by a background job fails with canFork; the copy keeps the history and runs', async () => {
  const id = '99999999-2222-4333-8444-555555555555';
  const dir = path.join(home, '.claude', 'projects', encodeCwd(ws));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), JSON.stringify({ type: 'user', message: { role: 'user', content: 'asli' } }) + '\n');
  process.env.FAKE_BUSY = id;
  events = [];
  svc.send('W', id, { text: 'halo' });
  const err = await waitFor(() => events.find((e) => e.id === id && e.ev === 'error'));
  assert.equal(err.canFork, true);
  const copy = svc.fork('W', id);
  assert.equal(copy.forkFrom, id);
  assert.equal(svc.get('W', copy.id).items[0].text, 'asli', 'source history shows before the first turn');
  events = [];
  svc.send('W', copy.id, { text: 'lanjut' });
  await idle(copy.id);
  const a = lastArgs();
  assert.deepEqual(a.slice(a.indexOf('--resume'), a.indexOf('--resume') + 5), ['--resume', id, '--fork-session', '--session-id', copy.id]);
  assert.deepEqual(svc.get('W', copy.id).items.map((i) => i.text), ['asli', 'lanjut', 'echo(claude-sonnet-x): lanjut']);
  delete process.env.FAKE_BUSY;
});

test('usage: context, cost, and tokens per session; plan limits and model windows persist; auto mode; skill args info', async () => {
  const m = svc.create('W', { mode: 'auto' });
  assert.equal(m.mode, 'auto');
  events = [];
  svc.send('W', m.id, { text: 'hitung' });
  await idle(m.id);
  const a = lastArgs();
  assert.equal(a[a.indexOf('--permission-mode') + 1], 'auto');
  const g = svc.get('W', m.id);
  assert.equal(g.stats.contextTokens, 1000);
  assert.equal(g.stats.contextWindow, 1000000, 'window learned from modelUsage');
  assert.equal(g.stats.costUsd, 0.01);
  assert.equal(g.stats.outputTokens, 5);
  assert.ok(g.items.every((i) => i.ts), 'transcript items carry a time');
  assert.equal(g.rate.unifiedWindows.five_hour.utilization, 0.4);
  const fresh = make();
  assert.equal(fresh.usage().rate.unifiedWindows.five_hour.utilization, 0.4, 'limits survive a restart (no live process)');
  assert.equal(fresh.list('W').find((s) => s.id === m.id).stats.contextTokens, 1000);
  assert.ok(events.some((e) => e.id === m.id && e.ev === 'context' && e.contextTokens === 1000));
  const sk = path.join(home, '.claude', 'skills');
  fs.mkdirSync(path.join(sk, 'pakai-arg'), { recursive: true });
  fs.writeFileSync(path.join(sk, 'pakai-arg', 'SKILL.md'), '---\nname: pakai-arg\ndescription: x\n---\nRun with $ARGUMENTS\n');
  const all = svc.quickActions('W').all;
  assert.equal(all.find((s) => s.name === 'pakai-arg').takesArgs, true);
  assert.equal(all.find((s) => s.name === 'worklog').takesArgs, false);
});

test('a Brain filter chip sends its label and its pages with hat labels', async () => {
  const m = svc.create('W');
  svc.send('W', m.id, { text: 'ringkas', context: [{ title: 'Clients › alpha', pages: [{ title: 'Biaya', file: 'D:/v/b.md', hat: 'client-a', node: 'n1' }, { title: 'Arsitektur', file: 'D:/v/a.md', hat: '' }] }] });
  await idle(m.id);
  const u = svc.get('W', m.id).items.find((i) => i.kind === 'user').text;
  assert.match(u, /- filter: Clients › alpha · 2 pages\n {2}- \[Biaya\]\(D:\/v\/b\.md\) · hat: client-a · node: n1\n {2}- \[Arsitektur\]\(D:\/v\/a\.md\) · hat: own \(no hat\)/);
});

test('readTranscript is tolerant of broken lines and hides meta and subagent lines', () => {
  const f = path.join(root, 't.jsonl');
  fs.writeFileSync(f, 'not json\n' + [
    { type: 'user', isMeta: true, message: { role: 'user', content: 'meta' } },
    { type: 'user', isSidechain: true, message: { role: 'user', content: 'side' } },
    { type: 'user', message: { role: 'user', content: '<command-name>/gl</command-name>\n<command-args>x</command-args>' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'git log' } }] } },
  ].map((x) => JSON.stringify(x)).join('\n'));
  const r = readTranscript(f);
  assert.deepEqual(r.items.map((i) => [i.kind, i.text ?? i.summary]), [['user', '/gl x'], ['tool_use', 'git log']]);
});
