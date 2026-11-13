import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { createApiEngine } from '../server/providers/api-engine.js';
import { chatCompletions } from '../server/providers/chat-completions.js';
import { createProviderLayer } from '../server/providers/index.js';
import { createProviderStore, parseEnv, parseProviders, stringifyProviders } from '../server/providers/config.js';
import { bashAllowed, createToolbox, globRegex, parseBashRules, splitCommand } from '../server/providers/tools.js';

const tmpDir = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'artrios-prov-')));
const reply = (message, status = 200) => new Response(JSON.stringify(status === 200 ? { choices: [{ message, finish_reason: 'stop' }] } : { error: { message: 'nope' } }), { status });

// Serves scripted answers and keeps every request body.
function scriptedFetch(answers) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const a = answers.shift();
    if (a instanceof Error) throw a;
    return a ?? reply({ content: 'end' });
  };
  fn.calls = calls;
  return fn;
}

async function runEngine(fetchImpl, opts, extra = {}) {
  const events = [];
  const eng = createApiEngine({ provider: { base_url: 'https://llm.test/v1', model: 'm-1' }, apiKey: 'sk-secret-value', transport: chatCompletions, fetchImpl, retryDelayMs: 1, ...extra });
  const h = eng.run(opts, (o) => events.push(o));
  const end = await h.done;
  return { events, end, result: events.find((e) => e.type === 'result') };
}

test('providers.yaml round trip keeps quoted values with colons', () => {
  const data = { primary: 'gw', providers: { gw: { transport: 'chat_completions', base_url: 'https://x.test:8443/v1', key_env: 'GW_KEY', model: 'org/model:free' }, cli: { transport: 'claude_cli' } } };
  assert.deepEqual(parseProviders(stringifyProviders(data)), data);
});

test('.env parser handles quotes, export and comments', () => {
  assert.deepEqual(parseEnv('# c\nA=1\nexport B="two words"\nC=\'3\'\n'), { A: '1', B: 'two words', C: '3' });
});

test('store: first provider is primary, keys go to .env and never come back, removing the primary leaves no hidden default', () => {
  const dir = tmpDir();
  const store = createProviderStore({ file: path.join(dir, 'artrios', 'providers.yaml'), envFile: path.join(dir, 'home', '.env') });
  let r = store.put('gw', { transport: 'chat_completions', base_url: 'https://x.test/v1/', key_env: 'GW_KEY', model: 'm', apiKey: 'sk-abc' });
  assert.equal(r.primary, 'gw');
  assert.equal(r.providers[0].hasKey, true);
  assert.equal(r.providers[0].base_url, 'https://x.test/v1');
  assert.ok(!JSON.stringify(r).includes('sk-abc'));
  assert.ok(!fs.readFileSync(path.join(dir, 'artrios', 'providers.yaml'), 'utf8').includes('sk-abc'));
  assert.match(fs.readFileSync(path.join(dir, 'home', '.env'), 'utf8'), /^GW_KEY=sk-abc$/m);

  store.put('b', { transport: 'claude_cli' });
  r = store.put('c', { transport: 'claude_cli' });
  assert.equal(r.primary, 'gw', 'adding a provider never changes the primary');
  r = store.setPrimary('c');
  assert.equal(r.primary, 'c');
  r = store.remove('c');
  assert.equal(r.primary, null, 'two left: the user must choose');
  r = store.remove('b');
  assert.equal(r.primary, 'gw', 'one left: it is the primary');
  assert.throws(() => store.put('Bad Name', { transport: 'claude_cli' }), /provider name/);
  assert.throws(() => store.put('x', { transport: 'chat_completions', base_url: 'file:///etc', model: 'm' }), /http or https/);
  assert.throws(() => store.put('x', { transport: 'nope' }), /transport/);
});

test('transport: invalid JSON arguments are reported, parsed arguments accepted', () => {
  const r = chatCompletions.normalizeResponse({ choices: [{ message: { content: null, tool_calls: [
    { id: 'a', function: { name: 'Read', arguments: '{bad' } },
    { id: 'b', function: { name: 'Read', arguments: { file_path: 'x' } } },
  ] } }] });
  assert.equal(r.text, '');
  assert.equal(r.toolCalls[0].argsError, 'the arguments are not valid JSON');
  assert.deepEqual(r.toolCalls[1].args, { file_path: 'x' });
  assert.throws(() => chatCompletions.normalizeResponse({ error: { message: 'quota' } }), /quota/);
});

test('bash rules: prefix or exact only, bare Bash grants nothing', () => {
  const rules = parseBashRules(['Bash(git log:*)', 'Bash(git status)', 'Bash', 'Read']);
  assert.equal(rules.length, 2);
  assert.ok(bashAllowed(rules, ['git', 'log', '--oneline']));
  assert.ok(bashAllowed(rules, ['git', 'status']));
  assert.ok(!bashAllowed(rules, ['git', 'status', '-s']));
  assert.ok(!bashAllowed(rules, ['git', 'push']));
  assert.ok(!bashAllowed(rules, ['git', '-c', 'x=y', 'log']));
  assert.deepEqual(splitCommand(`git log "a b" 'c'`), ['git', 'log', 'a b', 'c']);
  assert.throws(() => splitCommand('git "x'), /unbalanced/);
});

test('glob regex', () => {
  assert.ok(globRegex('src/**/*.js').test('src/a/b/c.js'));
  assert.ok(globRegex('src/**/*.js').test('src/c.js'));
  assert.ok(!globRegex('src/*.js').test('src/a/c.js'));
  assert.ok(globRegex('**/*.md').test('README.md'));
});

test('toolbox: only allowed tools exist; paths stay inside; .env and .git are refused', async () => {
  const dir = tmpDir();
  const outside = tmpDir();
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo needle\nthree\n');
  fs.writeFileSync(path.join(dir, '.env'), 'KEY=value\n');
  fs.writeFileSync(path.join(dir, '.env.local'), 'KEY=needle\n');
  const ro = createToolbox({ cwd: dir, allowedTools: ['Read', 'Grep', 'Glob'] });
  assert.deepEqual(ro.definitions().map((d) => d.name), ['Read', 'Grep', 'Glob']);
  assert.equal((await ro.run('Write', { file_path: 'x', content: 'y' })).isError, true);
  assert.equal(fs.existsSync(path.join(dir, 'x')), false);

  assert.equal((await ro.run('Read', { file_path: 'a.txt', offset: 2, limit: 1 })).text, '2\ttwo needle');
  assert.match((await ro.run('Read', { file_path: '../' + path.basename(outside) + '/secret.txt' })).text, /outside the project/);
  assert.match((await ro.run('Read', { file_path: path.join(outside, 'secret.txt') })).text, /outside the project/);
  assert.match((await ro.run('Read', { file_path: '.env' })).text, /off limits/);
  assert.match((await ro.run('Read', { file_path: '.env.local' })).text, /off limits/);
  assert.equal((await ro.run('Grep', { pattern: 'needle' })).text, 'a.txt:2:two needle', 'grep skips .env files');
  assert.ok(!(await ro.run('Glob', { pattern: '**/*' })).text.includes('.env'));

  let linked = false;
  try { fs.symlinkSync(outside, path.join(dir, 'link'), 'junction'); linked = true; } catch { /* no symlink right here */ }
  if (linked) assert.match((await ro.run('Read', { file_path: 'link/secret.txt' })).text, /outside the project/);

  const rw = createToolbox({ cwd: dir, allowedTools: ['Write', 'Edit'] });
  assert.equal((await rw.run('Write', { file_path: 'sub/new.txt', content: 'aa bb' })).isError, false);
  assert.equal((await rw.run('Edit', { file_path: 'sub/new.txt', old_string: 'bb', new_string: 'cc' })).isError, false);
  assert.equal(fs.readFileSync(path.join(dir, 'sub', 'new.txt'), 'utf8'), 'aa cc');
  assert.match((await rw.run('Edit', { file_path: 'a.txt', old_string: 'zzz', new_string: 'y' })).text, /not found/);
  assert.match((await rw.run('Write', { file_path: '.git/config', content: 'x' })).text, /\.git is off limits/);
  assert.match((await rw.run('Write', { file_path: '.env', content: 'x' })).text, /off limits/);
  if (linked) assert.match((await rw.run('Write', { file_path: 'link/new.txt', content: 'x' })).text, /outside the project/);
  assert.equal(fs.existsSync(path.join(outside, 'new.txt')), false);
});

test('toolbox Bash: runs an allowed prefix without a shell; operators and other commands are refused', async () => {
  const dir = tmpDir();
  const box = createToolbox({ cwd: dir, allowedTools: [`Bash(node --version:*)`, 'Bash(node --print 1)'] });
  assert.deepEqual(box.definitions().map((d) => d.name), ['Bash']);
  assert.match((await box.run('Bash', { command: 'node --version' })).text, /^v\d+/);
  assert.match((await box.run('Bash', { command: 'node --version; whoami' })).text, /shell operators/);
  assert.match((await box.run('Bash', { command: 'node --version && whoami' })).text, /shell operators/);
  assert.match((await box.run('Bash', { command: 'node --version > out.txt' })).text, /shell operators/);
  assert.match((await box.run('Bash', { command: 'node --eval 1' })).text, /not allowed/);
  assert.equal(createToolbox({ cwd: dir, allowedTools: ['Bash'] }).definitions().length, 0);
});

test('engine: runs the tool loop and emits the events the job runner reads', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'MANUAL TEXT');
  const f = scriptedFetch([
    reply({ content: 'looking', tool_calls: [{ id: 'c1', function: { name: 'Read', arguments: '{"file_path":"a.txt"}' } }, { id: 'c2', function: { name: 'Write', arguments: '{"file_path":"b.txt","content":"x"}' } }, { id: 'c3', function: { name: 'Read', arguments: '{oops' } }] }),
    reply({ content: 'all done' }),
  ]);
  const { events, end, result } = await runEngine(f, { prompt: 'go', cwd: dir, allowedTools: ['Read'], model: 'sonnet' });
  assert.equal(end.exitCode, 0);
  assert.equal(result.result, 'all done');
  assert.equal(result.num_turns, 2);
  assert.equal(events[0].type, 'system');
  assert.equal(f.calls[0].url, 'https://llm.test/v1/chat/completions');
  assert.equal(f.calls[0].headers.Authorization, 'Bearer sk-secret-value');
  assert.equal(f.calls[0].body.model, 'm-1', 'a Claude alias from the task dialog falls back to the provider model');
  assert.deepEqual(f.calls[0].body.tools.map((t) => t.function.name), ['Read']);
  assert.ok(f.calls[0].body.messages[0].content.includes('MANUAL TEXT'));
  const tools = f.calls[1].body.messages.filter((m) => m.role === 'tool');
  assert.deepEqual(tools.map((m) => m.tool_call_id), ['c1', 'c2', 'c3']);
  assert.match(tools[0].content, /hello/);
  assert.match(tools[1].content, /not allowed/);
  assert.match(tools[2].content, /not valid JSON/);
  assert.equal(fs.existsSync(path.join(dir, 'b.txt')), false);
});

test('engine: retries 429 and 5xx, not 401; never repeats the key in an error', async () => {
  const dir = tmpDir();
  const ok = await runEngine(scriptedFetch([reply({}, 429), reply({}, 500), reply({ content: 'fine' })]), { prompt: 'x', cwd: dir });
  assert.equal(ok.result.result, 'fine');
  const bad = scriptedFetch([new Response('invalid key sk-secret-value', { status: 401 })]);
  const r = await runEngine(bad, { prompt: 'x', cwd: dir });
  assert.equal(bad.calls.length, 1);
  assert.equal(r.end.exitCode, 1);
  assert.equal(r.result.is_error, true);
  assert.ok(!r.result.result.includes('sk-secret-value'));
  assert.match(r.result.result, /401/);
});

test('engine: maxTurns ends a loop that never finishes', async () => {
  const dir = tmpDir();
  const loop = async () => reply({ tool_calls: [{ id: 'c', function: { name: 'Glob', arguments: '{"pattern":"*"}' } }] });
  const r = await runEngine(loop, { prompt: 'x', cwd: dir, allowedTools: ['Glob'] }, { maxTurns: 3 });
  assert.match(r.result.result, /after 3 turns/);
});

test('engine: stop aborts a call in flight', async () => {
  const dir = tmpDir();
  const hang = (_, init) => new Promise((_r, reject) => { init.signal.addEventListener('abort', () => reject(new Error('aborted'))); });
  const eng = createApiEngine({ provider: { base_url: 'https://llm.test', model: 'm' }, apiKey: null, transport: chatCompletions, fetchImpl: hang });
  const events = [];
  const h = eng.run({ prompt: 'x', cwd: dir }, (o) => events.push(o));
  setTimeout(() => h.stop(), 10);
  const end = await h.done;
  assert.equal(end.stopped, true);
  assert.equal(events.some((e) => e.type === 'result'), false);
});

test('layer: no providersFile keeps the CLI; no primary fails with a clear message; primary is read per run', async () => {
  const cli = { name: 'claude-headless', run: (opts, onLine) => { onLine({ type: 'result', result: `cli ${opts.model ?? ''}`.trim() }); return { stop() {}, done: Promise.resolve({ exitCode: 0, stopped: false, stderrTail: '' }) }; } };
  assert.equal(createProviderLayer({ config: {}, cliEngine: cli }).engine, cli);

  const dir = tmpDir();
  const cfg = { providersFile: path.join(dir, 'providers.yaml'), envFile: path.join(dir, '.env') };
  const f = scriptedFetch([reply({ content: 'from api' })]);
  const layer = createProviderLayer({ config: cfg, cliEngine: cli, fetchImpl: f });
  assert.equal(layer.active(), null);
  const none = await layer.engine.run({ prompt: 'x', cwd: dir }, () => {}).done;
  assert.equal(none.exitCode, 1);
  assert.match(none.stderrTail, /No model provider/);

  layer.store.put('c', { transport: 'claude_cli', model: 'opus' });
  let got = null;
  await layer.engine.run({ prompt: 'x', cwd: dir }, (o) => { got = o; }).done;
  assert.equal(got.result, 'cli opus');

  layer.store.put('gw', { transport: 'chat_completions', base_url: 'https://llm.test/v1', model: 'm' });
  layer.store.setPrimary('gw');
  assert.equal(layer.engine.name, 'chat_completions:gw');
  await layer.engine.run({ prompt: 'x', cwd: dir }, (o) => { got = o; }).done;
  assert.equal(got.result, 'from api');
});

test('layer test call: reports the answer or the failure', async () => {
  const dir = tmpDir();
  const cfg = { providersFile: path.join(dir, 'providers.yaml'), envFile: path.join(dir, '.env') };
  const f = scriptedFetch([reply({ content: 'OK' }), reply({}, 401)]);
  const layer = createProviderLayer({ config: cfg, cliEngine: null, fetchImpl: f });
  layer.store.put('gw', { transport: 'chat_completions', base_url: 'https://llm.test/v1', model: 'm' });
  assert.deepEqual(await layer.test('gw'), { ok: true, text: 'OK' });
  const bad = await layer.test('gw');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /401/);
  layer.store.put('c', { transport: 'claude_cli' });
  assert.deepEqual(await layer.test('c', async () => ({ ok: true, version: '9' })), { ok: true, text: '9' });
});

test('HTTP: settings API behind the sign-in, key never returned; an old install stays read-only', async () => {
  const dir = tmpDir();
  const start = async (config, fetchImpl) => {
    const port = 42000 + Math.floor(Math.random() * 2000);
    const app = createApp({ config, dataDir: path.join(dir, 'data'), port, clientDir: null, fetchImpl });
    const sid = app.auth.openSession();
    await new Promise((r) => app.server.listen(port, '127.0.0.1', r));
    const call = (method, p, body, auth = true) => fetch(`http://127.0.0.1:${port}${p}`, {
      method,
      headers: { Host: `127.0.0.1:${port}`, ...(auth ? { cookie: `artrios_s=${sid}`, Origin: `http://127.0.0.1:${port}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { app, call };
  };
  const a = await start({ providersFile: path.join(dir, 'providers.yaml'), envFile: path.join(dir, '.env') }, scriptedFetch([reply({ content: 'OK' })]));
  try {
    assert.equal((await a.call('GET', '/api/settings/providers', null, false)).status, 401);
    const put = await a.call('PUT', '/api/settings/providers/gw', { transport: 'chat_completions', base_url: 'https://llm.test/v1', key_env: 'GW_KEY', model: 'm', apiKey: 'sk-http-secret' });
    assert.equal(put.status, 200);
    const text = await put.text();
    assert.ok(!text.includes('sk-http-secret'));
    assert.equal(JSON.parse(text).providers[0].hasKey, true);
    assert.deepEqual(await (await a.call('POST', '/api/settings/providers/gw/test')).json(), { ok: true, text: 'OK' });
    assert.equal((await (await a.call('GET', '/api/status')).json()).provider.id, 'gw');
    assert.equal((await a.call('DELETE', '/api/settings/providers/nope')).status, 404);
  } finally { a.app.close(); a.app.server.close(); }

  const old = await start({}, fetch);
  try {
    assert.equal((await (await old.call('GET', '/api/settings/providers')).json()).managed, false);
    assert.equal((await old.call('PUT', '/api/settings/providers/gw', { transport: 'claude_cli' })).status, 409);
  } finally { old.app.close(); old.app.server.close(); }
});
