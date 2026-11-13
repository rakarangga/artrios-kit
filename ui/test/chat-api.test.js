// Cognition Tahap 3 (PRD prd-cognition T11-T13; AC 6, 12, 13, 15) against a fake OpenAI-compatible provider.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChatService } from '../server/chat-service.js';
import { createProviderStore } from '../server/providers/config.js';
import { createInboxService } from '../server/inbox-service.js';
import { ruleMatches, toMessages } from '../server/chat-api.js';

const KEY = 'sk-SECRET-abc123xyz';
let root, home, ws, chatDir, events, svc, store, inbox, script, calls;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await sleep(10);
  }
}
const reply = (text, usage = { prompt_tokens: 1000, completion_tokens: 50 }) => ({ choices: [{ message: { content: text }, finish_reason: 'stop' }], usage });
const callTool = (name, args, id = `c-${Math.random().toString(36).slice(2, 8)}`) => ({ choices: [{ message: { content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 500, completion_tokens: 20 } });
// The fake provider answers from the script queue; an entry may be a function of the request body.
async function fakeFetch(url, opts) {
  const body = JSON.parse(opts.body);
  calls.push({ url, body, auth: opts.headers?.Authorization ?? null });
  const next = script.shift() ?? reply('done');
  const r = typeof next === 'function' ? next(body) : next;
  if (r.status) return { ok: false, status: r.status, text: async () => r.text };
  return { ok: true, status: 200, text: async () => JSON.stringify(r) };
}
const projects = { find: (k) => (k === 'W' ? { key: 'W', path: ws, hat: null } : null), all: () => [{ key: 'W', path: ws }] };
const done = (id, n = 1) => waitFor(() => events.filter((e) => e.id === id && e.ev === 'status' && e.done).length >= n);
const toolResults = (id) => svc.get('W', id).items.filter((i) => i.kind === 'tool_result');

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-api-'));
  home = path.join(root, 'home');
  ws = path.join(root, 'ws');
  chatDir = path.join(root, 'chat');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(ws, { recursive: true });
  store = createProviderStore({ file: path.join(root, 'providers.yaml'), envFile: path.join(root, '.env') });
  store.put('claude', { transport: 'claude_cli' });
  store.put('gw', { transport: 'chat_completions', base_url: 'http://gw.test/v1', key_env: 'GW_KEY', apiKey: KEY, model: 'open/model-a', models: 'open/model-b' });
  store.put('priced', { transport: 'chat_completions', base_url: 'http://priced.test/v1', model: 'p-1', price_in: 2, price_out: 10, context_window: 64000 });
  inbox = createInboxService({ file: path.join(root, 'putusan.jsonl') });
  events = [];
  calls = [];
  script = [];
  svc = createChatService({ config: {}, chatDir, projects, home, onEvent: (e) => events.push(e), inbox, providerStore: store, fetchImpl: fakeFetch, apiRetryDelayMs: 1, summarizeClaude: async () => 'ringkasan dari claude' });
});
after(() => { svc.stopAll(); fs.rmSync(root, { recursive: true, force: true }); });

test('engines list claude plus API providers, never the key', () => {
  const e = svc.engines();
  assert.deepEqual(e.engines.map((x) => x.id), ['claude_cli', 'gw', 'priced']);
  assert.deepEqual(e.engines[1].models, ['open/model-a', 'open/model-b']);
  assert.equal(e.engines[1].ready, true);
  assert.ok(!JSON.stringify(e).includes(KEY));
});

test('a plain turn: answer, transcript in the chat folder, tokens without a price list (AC 13)', async () => {
  const m = svc.create('W', { engine: 'gw' });
  assert.equal(m.engine, 'gw');
  assert.equal(m.model, 'open/model-a');
  script.push(reply('halo juga'));
  svc.send('W', m.id, { text: 'halo' });
  await done(m.id);
  const c = svc.get('W', m.id);
  assert.deepEqual(c.items.map((i) => [i.kind, i.text]), [['user', 'halo'], ['assistant', 'halo juga']]);
  assert.ok(fs.existsSync(path.join(chatDir, `${m.id}.jsonl`)));
  assert.equal(calls.at(-1).body.model, 'open/model-a');
  assert.equal(calls.at(-1).auth, `Bearer ${KEY}`);
  assert.equal(c.stats.inputTokens, 1000);
  assert.equal(c.stats.outputTokens, 50);
  assert.equal(c.stats.costUsd, null, 'no price list: tokens only');
  assert.equal(c.stats.contextTokens, 1000);
  assert.equal(svc.list('W').find((s) => s.id === m.id).engine, 'gw');
  // History goes back to the provider on the next turn.
  script.push(reply('ok'));
  svc.send('W', m.id, { text: 'lagi' });
  await done(m.id, 2);
  assert.deepEqual(calls.at(-1).body.messages.slice(1).map((x) => x.role), ['user', 'assistant', 'user']);
});

test('AC 13: with a price list the session records cost', async () => {
  const m = svc.create('W', { engine: 'priced' });
  script.push(reply('x', { prompt_tokens: 1000000, completion_tokens: 100000 }));
  svc.send('W', m.id, { text: 'hitung' });
  await done(m.id);
  const c = svc.get('W', m.id);
  assert.equal(c.stats.costUsd, 2 + 1);
  assert.equal(c.stats.contextWindow, 64000);
});

test('AC 12 / AC 2: permission card once, always (rule in settings.local.json), deny stops only that tool', async () => {
  const m = svc.create('W', { engine: 'gw' });
  const write = (name) => [callTool('Write', { file_path: name, content: 'isi' }), reply('selesai')];

  script.push(...write('a.txt'));
  svc.send('W', m.id, { text: 'tulis a' });
  let p = await waitFor(() => svc.get('W', m.id).pending[0]);
  assert.equal(p.kind, 'permission');
  assert.equal(p.tool, 'Write');
  svc.answer('W', m.id, { requestId: p.requestId, decision: 'once' });
  await done(m.id);
  assert.equal(fs.readFileSync(path.join(ws, 'a.txt'), 'utf8'), 'isi');

  script.push(...write('b.txt'));
  svc.send('W', m.id, { text: 'tulis b' });
  p = await waitFor(() => svc.get('W', m.id).pending[0]);
  svc.answer('W', m.id, { requestId: p.requestId, decision: 'always' });
  await done(m.id, 2);
  const local = JSON.parse(fs.readFileSync(path.join(ws, '.claude', 'settings.local.json'), 'utf8'));
  assert.deepEqual(local.permissions.allow, ['Write']);

  script.push(...write('c.txt'));
  svc.send('W', m.id, { text: 'tulis c' });
  await done(m.id, 3);
  assert.ok(fs.existsSync(path.join(ws, 'c.txt')), 'rule allows it without a card');

  script.push(callTool('Bash', { command: 'echo hai' }), reply('ditolak, oke'));
  svc.send('W', m.id, { text: 'jalankan' });
  p = await waitFor(() => svc.get('W', m.id).pending[0]);
  assert.equal(p.tool, 'Bash');
  assert.equal(p.suggestions[0].rules[0].ruleContent, 'Bash(echo hai:*)');
  svc.answer('W', m.id, { requestId: p.requestId, decision: 'deny' });
  await done(m.id, 4);
  const last = toolResults(m.id).at(-1);
  assert.equal(last.error, true);
  assert.match(last.text, /Denied by the user/);
  assert.equal(svc.get('W', m.id).items.at(-1).text, 'ditolak, oke', 'the turn goes on after a denial');
});

test('AC 12 / AC 3: plan mode writes nothing; accept edits writes without a card', async () => {
  const m = svc.create('W', { engine: 'gw', mode: 'plan' });
  script.push(callTool('Edit', { file_path: 'a.txt', old_string: 'isi', new_string: 'baru' }), reply('rencana'));
  svc.send('W', m.id, { text: 'ubah' });
  await done(m.id);
  assert.equal(fs.readFileSync(path.join(ws, 'a.txt'), 'utf8'), 'isi');
  assert.match(toolResults(m.id).at(-1).text, /Plan mode/);
  assert.match(calls.at(-1).body.messages[0].content, /Permission mode: plan/);

  await svc.setOptions('W', m.id, { mode: 'acceptEdits' });
  script.push(callTool('Edit', { file_path: 'a.txt', old_string: 'isi', new_string: 'baru' }), reply('beres'));
  svc.send('W', m.id, { text: 'ubah sekarang' });
  await done(m.id, 2);
  assert.equal(fs.readFileSync(path.join(ws, 'a.txt'), 'utf8'), 'baru');
});

test('AskUserQuestion is a question card; the answer goes back as the tool result', async () => {
  const m = svc.create('W', { engine: 'gw' });
  script.push(callTool('AskUserQuestion', { questions: [{ question: 'Pilih warna?', header: 'Warna', options: [{ label: 'Merah' }, { label: 'Biru' }] }] }), reply('oke biru'));
  svc.send('W', m.id, { text: 'tanya' });
  const p = await waitFor(() => svc.get('W', m.id).pending[0]);
  assert.equal(p.kind, 'question');
  svc.answer('W', m.id, { requestId: p.requestId, answers: { 'Pilih warna?': 'Biru' } });
  await done(m.id);
  assert.match(toolResults(m.id).at(-1).text, /Pilih warna\? -> Biru/);
});

test('AC 12 / AC 4: a skill runs with its SKILL.md body; the screen shows /name args', async () => {
  const dir = path.join(ws, '.claude', 'skills', 'sapa');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: sapa\ndescription: sapa\n---\nSapa $ARGUMENTS dengan ramah.\n');
  const m = svc.create('W', { engine: 'gw' });
  script.push(reply('Halo Budi!'));
  svc.send('W', m.id, { text: '/sapa Budi' });
  await done(m.id);
  const sent = calls.at(-1).body.messages.at(-1).content;
  assert.match(sent, /Sapa Budi dengan ramah/);
  assert.equal(svc.get('W', m.id).items[0].text, '/sapa Budi');
  assert.throws(() => svc.send('W', m.id, { text: '/tidak-ada' }), /unknown command/);
});

test('AC 12 / AC 7-8: Putusan tools: list first, then one item per case (reasked, not two)', async () => {
  const m = svc.create('W', { engine: 'gw' });
  const ask = { subject: 'AIOS-101', topic: 'harga', question: 'Pakai harga?', why: 'biaya', options: ['Ya', 'Tidak'] };
  script.push(callTool('putusan_ask', ask), callTool('putusan_list', {}), callTool('putusan_ask', ask), callTool('putusan_ask', ask), reply('antre'));
  svc.send('W', m.id, { text: 'antrekan' });
  await done(m.id);
  const r = toolResults(m.id).map((x) => x.text);
  assert.match(r[0], /putusan_list first/);
  assert.match(r[2], /"result": "created"/);
  assert.match(r[3], /"result": "reasked"/);
  assert.equal(inbox.list({ kind: 'putusan' }).filter((i) => i.subject === 'AIOS-101').length, 1);
});

test('AC 6: model change keeps the session; another engine opens a linked session with a summary', async () => {
  const m = svc.create('W', { engine: 'gw' });
  script.push(reply('jawaban pertama'));
  svc.send('W', m.id, { text: 'konteks penting: proyek Zeta' });
  await done(m.id);
  const same = await svc.switchEngine('W', m.id, { engine: 'gw', model: 'open/model-b' });
  assert.equal(same.switched, false);
  assert.equal(svc.get('W', m.id).model, 'open/model-b');

  // API -> API: the target provider writes the summary; the new transcript starts with it.
  script.push((body) => { assert.match(body.messages[1].content, /proyek Zeta/); return reply('RINGKASAN: proyek Zeta'); });
  const n = await svc.switchEngine('W', m.id, { engine: 'priced' });
  assert.equal(n.switched, true);
  assert.equal(n.engine, 'priced');
  assert.equal(n.linkedFrom, m.id);
  assert.equal(svc.get('W', m.id).linkedTo, n.id);
  const g = svc.get('W', n.id);
  assert.match(g.items[0].text, /Continued from session/);
  script.push(reply('lanjut'));
  svc.send('W', n.id, { text: 'lanjutkan' });
  await done(n.id);
  assert.match(calls.at(-1).body.messages[1].content, /RINGKASAN: proyek Zeta/);

  // API -> claude: summary from claude, sent once at the start of the first claude turn.
  const c = await svc.switchEngine('W', n.id, { engine: 'claude_cli' });
  assert.equal(c.engine, 'claude_cli');
  assert.equal(c.seed, 'ringkasan dari claude');
  assert.equal(c.linkedFrom, n.id);
});

test('AC 15: the provider key never reaches the transcript, metadata, or events', async () => {
  const m = svc.create('W', { engine: 'gw' });
  script.push({ status: 401, text: `{"error":"bad key ${KEY}"}` });
  svc.send('W', m.id, { text: 'coba' });
  await done(m.id);
  const err = svc.get('W', m.id);
  assert.ok(events.some((e) => e.id === m.id && e.item?.kind === 'error' && /HTTP 401/.test(e.item.text)));
  const all = [JSON.stringify(events), JSON.stringify(err), ...fs.readdirSync(chatDir).filter((f) => f.endsWith('.json') || f.endsWith('.jsonl')).map((f) => fs.readFileSync(path.join(chatDir, f), 'utf8'))].join('\n');
  assert.ok(!all.includes(KEY), 'secret leaked');
  assert.ok(all.includes('[redacted]'));
});

test('stop ends a running API turn and denies its open card', async () => {
  const m = svc.create('W', { engine: 'gw' });
  script.push(callTool('Bash', { command: 'echo x' }));
  svc.send('W', m.id, { text: 'jalan' });
  await waitFor(() => svc.get('W', m.id).pending[0]);
  await svc.interrupt('W', m.id);
  await done(m.id);
  assert.equal(svc.get('W', m.id).status, 'idle');
  assert.deepEqual(svc.get('W', m.id).pending, []);
});

test('rule matching and history repair', () => {
  assert.ok(ruleMatches('Bash(git status:*)', 'Bash', { command: 'git status -s' }));
  assert.ok(!ruleMatches('Bash(git status:*)', 'Bash', { command: 'git statusx' }));
  assert.ok(ruleMatches('Bash(npm run *)', 'Bash', { command: 'npm run test' }));
  assert.ok(ruleMatches('Edit(docs/**)', 'Edit', { file_path: 'docs/a/b.md' }, ws));
  assert.ok(!ruleMatches('Edit(docs/**)', 'Edit', { file_path: 'src/a.js' }, ws));
  assert.ok(ruleMatches('Write', 'Write', { file_path: 'x' }));
  const msgs = toMessages([
    { type: 'user', message: { content: 'a' } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] } },
    { type: 'user', message: { content: 'b' } },
  ]);
  assert.deepEqual(msgs.map((x) => x.role), ['user', 'assistant', 'tool', 'user'], 'a tool call without a result gets one');
});
