// Settings > Model: catalog, live model lists (cached), main model, per-model price in Cognition.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProviderLayer } from '../server/providers/index.js';
import { normalizeModels } from '../server/providers/models.js';
import { createChatService } from '../server/chat-service.js';

const KEY = 'sk-models-secret-77';
let root, layer, seen;
const OR = { data: [
  { id: 'qwen/qwen3-coder', name: 'Qwen3 Coder', context_length: 262144, pricing: { prompt: '0.0000003', completion: '0.0000012' } },
  { id: 'deepseek/deepseek-chat', context_length: 128000, pricing: { prompt: '0.00000027', completion: '0.0000011' } },
  { id: 'deepseek/deepseek-chat' },
  { id: '' },
] };
async function fakeFetch(url, opts = {}) {
  seen.push({ url, auth: opts.headers?.Authorization ?? null, method: opts.method ?? 'GET' });
  if (url.endsWith('/models')) {
    if (url.includes('bad.test')) return { ok: false, status: 401, text: async () => `invalid key ${KEY}` };
    return { ok: true, status: 200, text: async () => JSON.stringify(OR) };
  }
  return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1000000, completion_tokens: 1000000 } }) };
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'models-'));
  seen = [];
  const config = { providersFile: path.join(root, 'providers.yaml'), envFile: path.join(root, '.env') };
  layer = createProviderLayer({ config, cliEngine: { name: 'cli', run() { throw new Error('not used'); } }, fetchImpl: fakeFetch });
  layer.store.put('claude', { transport: 'claude_cli' });
  layer.store.put('or', { transport: 'chat_completions', base_url: 'https://or.test/api/v1', key_env: 'OR_KEY', apiKey: KEY, model: 'qwen/qwen3-coder' });
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('normalizeModels: ids, names, context, prices per 1M tokens, no duplicates or blanks', () => {
  const m = normalizeModels(OR);
  assert.deepEqual(m.map((x) => x.id), ['deepseek/deepseek-chat', 'qwen/qwen3-coder']);
  const q = m.find((x) => x.id === 'qwen/qwen3-coder');
  assert.equal(q.name, 'Qwen3 Coder');
  assert.equal(q.context, 262144);
  assert.equal(q.priceIn, 0.3);
  assert.equal(q.priceOut, 1.2);
  assert.deepEqual(normalizeModels({ models: [{ name: 'models/gemini-x' }] }).map((x) => x.id), ['gemini-x']);
});

test('catalog marks providers whose key is already in .env', () => {
  fs.appendFileSync(path.join(root, '.env'), 'OPENAI_API_KEY=x\n');
  const c = layer.catalog();
  assert.ok(c.find((x) => x.id === 'openrouter').base_url.startsWith('https://openrouter.ai'));
  assert.equal(c.find((x) => x.id === 'openai').hasKey, true);
  assert.equal(c.find((x) => x.id === 'deepseek').hasKey, false);
  assert.equal(c.find((x) => x.id === 'ollama').local, true);
});

test('probe lists models before saving; errors never carry the key', async () => {
  const r = await layer.probe({ base_url: 'https://or.test/api/v1/', apiKey: KEY });
  assert.equal(r.models.length, 2);
  assert.equal(seen.at(-1).url, 'https://or.test/api/v1/models');
  assert.equal(seen.at(-1).auth, `Bearer ${KEY}`);
  await assert.rejects(layer.probe({ base_url: 'https://bad.test/v1', apiKey: KEY }), (e) => e.code === 'unavailable' && !e.message.includes(KEY) && e.message.includes('[redacted]'));
  await assert.rejects(layer.probe({ base_url: 'ftp://x' }), (e) => e.code === 'invalid');
  // A key already saved in .env works through its variable name.
  await layer.probe({ base_url: 'https://or.test/api/v1', key_env: 'OR_KEY' });
  assert.equal(seen.at(-1).auth, `Bearer ${KEY}`);
});

test('refresh caches the list; options show every provider, the main one, and fill prices', async () => {
  let o = layer.options();
  assert.deepEqual(o.current, { provider: 'claude', model: '' });
  assert.deepEqual(o.providers.find((p) => p.id === 'or').models.map((m) => m.id), ['qwen/qwen3-coder']);
  const r = await layer.refreshModels('or');
  assert.equal(r.models.length, 2);
  o = layer.options();
  const or = o.providers.find((p) => p.id === 'or');
  assert.equal(or.models.length, 2);
  assert.ok(or.fetchedAt);
  assert.equal(or.ready, true);
  assert.deepEqual(o.providers.find((p) => p.id === 'claude').models.map((m) => m.id), ['sonnet', 'opus', 'haiku', 'fable']);
  assert.ok(!JSON.stringify(o).includes(KEY));
  assert.deepEqual(layer.info('or', 'deepseek/deepseek-chat'), { context: 128000, priceIn: 0.27, priceOut: 1.1 });
});

test('setMain: provider and model in one write; an API provider needs a model; reserved names refused', () => {
  const l = layer.store.setMain('or', 'deepseek/deepseek-chat');
  assert.equal(l.primary, 'or');
  assert.equal(layer.options().current.model, 'deepseek/deepseek-chat');
  assert.throws(() => layer.store.setMain('or', ''), (e) => e.code === 'invalid');
  assert.throws(() => layer.store.setMain('nope', 'x'), (e) => e.code === 'not_found');
  layer.store.setMain('claude', 'opus');
  assert.deepEqual(layer.options().current, { provider: 'claude', model: 'opus' });
  assert.throws(() => layer.store.put('main', { transport: 'claude_cli' }), (e) => e.code === 'invalid');
});

test('Cognition prices a turn with the fetched per-model price', async () => {
  const ws = path.join(root, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  const events = [];
  const svc = createChatService({ config: {}, chatDir: path.join(root, 'chat'), projects: { find: (k) => (k === 'W' ? { key: 'W', path: ws } : null) }, home: path.join(root, 'home'), onEvent: (e) => events.push(e), providerStore: layer.store, fetchImpl: fakeFetch, modelInfo: layer.info });
  const m = svc.create('W', { engine: 'or', model: 'deepseek/deepseek-chat' });
  svc.send('W', m.id, { text: 'hi' });
  const end = Date.now() + 5000;
  while (!events.some((e) => e.id === m.id && e.ev === 'status' && e.done)) { if (Date.now() > end) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 10)); }
  const st = svc.get('W', m.id).stats;
  assert.equal(Math.round(st.costUsd * 100) / 100, 1.37, '1M in x 0.27 + 1M out x 1.1');
  assert.equal(st.contextWindow, 128000);
  svc.stopAll();
});
