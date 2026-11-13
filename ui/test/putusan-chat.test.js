// Cognition Tahap 2 (PRD prd-cognition AC 7-11): case keys in the Putusan queue, the MCP tools, parked questions,
// and Brain chips.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInboxService } from '../server/inbox-service.js';
import { createChatService } from '../server/chat-service.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(here, 'fixtures', 'fake-claude-chat.js');
const MCP = path.join(here, '..', 'server', 'mcp-putusan.js');
let root, file, inbox;
const base = { kind: 'putusan', from: 'claude', workspace: 'home', subject: 'AIOS-25', options: ['ok', 'tidak'], why: 'perlu putusan' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('waitFor timed out'); await sleep(20); }
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'putusan-chat-'));
  file = path.join(root, 'inbox', 'putusan.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  inbox = createInboxService({ file });
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('AC 7: the same key twice gives one item marked reasked; the badge stays 1', () => {
  const a = inbox.ask({ ...base, topic: 'izin-tool', question: 'Pakai izin selalu?', session: 's1' });
  const b = inbox.ask({ ...base, topic: 'izin-tool', question: 'Pakai izin selalu? (versi 2)', session: 's2' });
  assert.equal(a.result, 'created');
  assert.equal(b.result, 'reasked');
  assert.equal(b.item.id, a.item.id);
  assert.equal(b.item.reasked, 1);
  assert.equal(b.item.lastSession, 's2');
  assert.equal(b.item.versions.length, 1, 'the earlier wording is kept');
  assert.equal(inbox.pendingCount(), 1);
  assert.equal(a.item.key, 'home/AIOS-25/izin-tool');
});

test('AC 8: a decided key returns the old answer; context changed makes a new item with supersedes', () => {
  const { item } = inbox.ask({ ...base, topic: 'model', question: 'Sonnet?' });
  inbox.decide(item.id, { by: 'user', decision: 'ok' });
  const again = inbox.ask({ ...base, topic: 'model', question: 'Sonnet lagi?' });
  assert.equal(again.result, 'decided');
  assert.equal(again.item.decision, 'ok');
  assert.equal(inbox.list({ kind: 'putusan' }).filter((i) => i.key === 'home/AIOS-25/model').length, 1);
  const changed = inbox.ask({ ...base, topic: 'model', question: 'Sonnet, sekarang ada Fable?', contextChanged: true });
  assert.equal(changed.result, 'created');
  assert.equal(changed.item.supersedes, item.id);
});

test('AC 9: answering one card leaves the other item of the same subject open', () => {
  const x = inbox.ask({ ...base, subject: 'AIOS-99', topic: 'satu', question: 'Satu?' }).item;
  const y = inbox.ask({ ...base, subject: 'AIOS-99', topic: 'dua', question: 'Dua?' }).item;
  inbox.decide(x.id, { by: 'user', decision: 'tidak' });
  assert.equal(inbox.get(x.id).status, 'decided');
  assert.equal(inbox.get(y.id).status, 'pending');
  assert.throws(() => inbox.ask({ ...base, topic: 'a/b', question: 'q' }), /without "\/"/);
});

function mcp(args) {
  const p = spawn(process.execPath, [MCP, ...args], { stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '';
  const waiters = new Map();
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiters.get(m.id)?.(m); }
  });
  let n = 0;
  const rpc = (method, params) => new Promise((r) => { const id = ++n; waiters.set(id, r); p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  return { rpc, end: () => p.stdin.end() };
}

test('MCP tools: initialize, list, ask only after list, one item per case', async () => {
  const s = mcp(['--inbox', file, '--workspace', 'mcpws', '--session', 'sess-1']);
  const init = await s.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.result.serverInfo.name, 'artrios-putusan');
  const tools = await s.rpc('tools/list', {});
  assert.deepEqual(tools.result.tools.map((t) => t.name), ['putusan_list', 'putusan_ask']);
  const args = { subject: 'AIOS-100', topic: 'laci', question: 'Laci di kanan?', why: 'tata letak', options: ['ya', 'tidak'] };
  const early = await s.rpc('tools/call', { name: 'putusan_ask', arguments: args });
  assert.ok(early.result.isError);
  assert.match(early.result.content[0].text, /putusan_list first/);
  await s.rpc('tools/call', { name: 'putusan_list', arguments: {} });
  const r1 = JSON.parse((await s.rpc('tools/call', { name: 'putusan_ask', arguments: args })).result.content[0].text);
  const r2 = JSON.parse((await s.rpc('tools/call', { name: 'putusan_ask', arguments: args })).result.content[0].text);
  assert.equal(r1.result, 'created');
  assert.equal(r2.result, 'reasked');
  const listed = JSON.parse((await s.rpc('tools/call', { name: 'putusan_list', arguments: {} })).result.content[0].text);
  assert.equal(listed.open, 1);
  assert.equal(listed.subjects['AIOS-100'][0].reasked, 1);
  assert.equal(inbox.get(r1.item.id).session, 'sess-1');
  s.end();
});

test('AC 10: a question still open when the chat closes goes to Putusan with the session link; chat args carry the tools', async () => {
  const home = path.join(root, 'home');
  const ws = path.join(root, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  process.env.FAKE_CHAT_HOME = home;
  const events = [];
  const svc = createChatService({
    config: { claudePath: process.execPath, claudeBaseArgs: [FAKE] }, chatDir: path.join(root, 'chat'), home, inbox, inboxFile: file,
    projects: { find: (k) => (k === 'W' ? { key: 'W', path: ws } : null) }, onEvent: (e) => events.push(e),
  });
  const m = svc.create('W');
  svc.send('W', m.id, { text: 'ASK please', context: [{ title: 'Biaya AI', file: 'D:/vault/biaya.md', hat: 'Client A', node: 'n1' }] });
  await waitFor(() => svc.get('W', m.id).pending[0]);
  const args = JSON.parse(fs.readFileSync(path.join(home, 'args.log'), 'utf8').trim().split('\n').pop());
  const mcpCfg = JSON.parse(args[args.indexOf('--mcp-config') + 1]);
  assert.ok(mcpCfg.mcpServers.artrios.args.includes(file));
  assert.match(args[args.indexOf('--allowedTools') + 1], /mcp__artrios__putusan_ask/);
  assert.match(args[args.indexOf('--append-system-prompt') + 1], /putusan_list first/);
  const first = svc.get('W', m.id).items.find((i) => i.kind === 'user');
  assert.match(first.text, /<brain-context>[\s\S]*\[Biaya AI\]\(D:\/vault\/biaya\.md\) · hat: Client A · node: n1/);
  svc.close('W', m.id);
  const parked = await waitFor(() => inbox.list({ kind: 'putusan', status: 'pending' }).find((i) => i.session === m.id));
  assert.equal(parked.question, 'Buah?');
  assert.deepEqual(parked.options, ['Apel', 'Jeruk']);
  assert.equal(parked.workspace, 'W');
  await waitFor(() => events.some((e) => e.id === m.id && e.ev === 'item' && /moved to Putusan/.test(e.item.text)));
  svc.stopAll();
});
