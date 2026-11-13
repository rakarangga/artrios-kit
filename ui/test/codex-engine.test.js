import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCodexArgs, createCodexEngine, mapCodexEvent } from '../server/providers/codex-engine.js';
import { createProviderLayer } from '../server/providers/index.js';

const tmpDir = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'artrios-codex-')));

// A stand-in for `codex exec --json`: prints the lines it is given in CODEX_FAKE, reads the prompt from stdin.
function fakeCodex(dir) {
  const file = path.join(dir, 'fake-codex.js');
  fs.writeFileSync(file, `
let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  const script = JSON.parse(process.env.CODEX_FAKE);
  for (const l of script.lines) console.log(typeof l === 'string' ? l : JSON.stringify(l));
  if (script.echoArgs) console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ args: process.argv.slice(2), input }) } }));
  if (script.stderr) console.error(script.stderr);
  process.exit(script.code ?? 0);
});`);
  return file;
}

async function run(script, opts = {}) {
  const dir = tmpDir();
  const eng = createCodexEngine({ command: process.execPath, baseArgs: [fakeCodex(dir)], env: { ...process.env, CODEX_FAKE: JSON.stringify(script) } });
  const events = [];
  const h = eng.run({ prompt: 'hello', cwd: dir, ...opts }, (o) => events.push(o));
  const end = await h.done;
  return { events, end, result: events.find((e) => e.type === 'result'), dir };
}

test('args: read-only without tools, workspace-write with tools, model and folder passed, prompt on stdin', () => {
  assert.deepEqual(buildCodexArgs({ cwd: '/w', model: 'gpt-x' }), ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '-C', '/w', '-m', 'gpt-x', '-']);
  assert.ok(buildCodexArgs({ cwd: '/w', allowedTools: ['Read'] }).includes('workspace-write'));
});

test('events map to the stream-json shapes: messages, commands, file changes, errors', () => {
  const st = { sessionId: 's', lastText: '', error: null, done: false, n: 0 };
  assert.deepEqual(mapCodexEvent({ type: 'thread.started', thread_id: 'T1' }, st), []);
  assert.equal(st.sessionId, 'T1');
  const msg = mapCodexEvent({ type: 'item.completed', item: { type: 'agent_message', text: 'hi' } }, st);
  assert.equal(msg[0].message.content[0].text, 'hi');
  const cmd = mapCodexEvent({ type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'ls', aggregated_output: 'a', exit_code: 1 } }, st);
  assert.equal(cmd[0].message.content[0].name, 'Bash');
  assert.equal(cmd[1].message.content[0].is_error, true);
  assert.deepEqual(mapCodexEvent({ type: 'item.started', item: { type: 'agent_message', text: 'x' } }, st), []);
  mapCodexEvent({ type: 'turn.failed', error: { message: 'quota' } }, st);
  assert.equal(st.error, 'quota');
});

test('engine: a finished turn ends with the last message as the result; the prompt arrives on stdin', async () => {
  const r = await run({ lines: ['not json', { type: 'thread.started', thread_id: 'T9' }, { type: 'turn.started' }, { type: 'item.completed', item: { type: 'agent_message', text: 'done it' } }, { type: 'turn.completed', usage: {} }] });
  assert.equal(r.end.exitCode, 0);
  assert.equal(r.result.is_error, false);
  assert.equal(r.result.result, 'done it');
  assert.equal(r.result.session_id, 'T9');
  assert.equal(r.result.total_cost_usd, null);
});

test('engine: turn.failed or a missing turn.completed is an error with the reason', async () => {
  const bad = await run({ lines: [{ type: 'turn.failed', error: { message: 'not signed in' } }], code: 1 });
  assert.equal(bad.result.is_error, true);
  assert.match(bad.result.result, /not signed in/);
  assert.notEqual(bad.end.exitCode, 0);
  const cut = await run({ lines: [{ type: 'item.completed', item: { type: 'agent_message', text: 'half' } }], stderr: 'boom' });
  assert.equal(cut.result.is_error, true);
  assert.match(cut.result.result, /boom/);
});

test('engine: a missing codex command says what to do', async () => {
  const eng = createCodexEngine({ command: path.join(tmpDir(), 'no-such-codex') });
  const events = [];
  const h = eng.run({ prompt: 'x', cwd: tmpDir() }, (o) => events.push(o));
  const end = await h.done;
  assert.notEqual(end.exitCode, 0);
  assert.match(events.find((e) => e.type === 'result').result, /codex login/);
});

test('layer: a codex_cli primary runs the codex engine, ignores Claude aliases, and the test call only asks the version', async () => {
  const dir = tmpDir();
  const calls = [];
  const codexEngine = { run: (o) => { calls.push(o); return { pid: null, stop() {}, done: Promise.resolve({ exitCode: 0, stopped: false, stderrTail: '' }) }; } };
  const layer = createProviderLayer({ config: { providersFile: path.join(dir, 'providers.yaml'), envFile: path.join(dir, '.env') }, cliEngine: { run() { throw new Error('not claude'); } }, codexEngine });
  layer.store.put('codex', { transport: 'codex_cli', model: 'gpt-5.1' });
  assert.equal(layer.active().transport, 'codex_cli');
  await layer.engine.run({ prompt: 'p', cwd: dir, model: 'sonnet' }, () => {}).done;
  assert.equal(calls[0].model, 'gpt-5.1');
  await layer.engine.run({ prompt: 'p', cwd: dir, model: 'gpt-x' }, () => {}).done;
  assert.equal(calls[1].model, 'gpt-x');
  assert.deepEqual(await layer.test('codex', async () => ({ ok: false }), async () => ({ ok: true, version: 'codex-cli 1.2.3' })), { ok: true, text: 'codex-cli 1.2.3' });
  assert.equal((await layer.test('codex', async () => ({ ok: true }), async () => ({ ok: false }))).ok, false);
  const row = layer.options().providers.find((p) => p.id === 'codex');
  assert.equal(row.transport, 'codex_cli');
  assert.ok(row.models.length > 0);
});
