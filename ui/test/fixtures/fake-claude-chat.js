#!/usr/bin/env node
// Stand-in for `claude -p --input-format stream-json --output-format stream-json --permission-prompt-tool stdio`.
// Speaks the control protocol seen in spike AIOS-98 and writes a transcript to $FAKE_CHAT_HOME/.claude/projects.
// Message text drives behaviour: "WRITE" asks permission for Write, "ASK" sends AskUserQuestion, "SLOW" waits for an
// interrupt, anything else is echoed. Args are recorded in $FAKE_CHAT_HOME/args.log.
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const home = process.env.FAKE_CHAT_HOME;
const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const sessionId = arg('--session-id') ?? arg('--resume');
const forking = argv.includes('--fork-session');
// FAKE_BUSY lists session ids held by a "background job": resuming them fails like the real CLI.
if (arg('--resume') && !forking && (process.env.FAKE_BUSY ?? '').split(',').includes(arg('--resume'))) {
  process.stderr.write(`Error: That session is running in the background (${arg('--resume').slice(0, 8)}). Run \`claude attach\` to open it.\n`);
  process.exit(1);
}
let model = arg('--model') ?? 'claude-sonnet-x';
let mode = arg('--permission-mode') ?? 'default';
fs.appendFileSync(path.join(home, 'args.log'), `${JSON.stringify(argv)}\n`);
const dir = path.join(home, '.claude', 'projects', path.resolve(process.cwd()).replace(/[^A-Za-z0-9]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const transcript = path.join(dir, `${sessionId}.jsonl`);
if (forking) fs.copyFileSync(path.join(dir, `${arg('--resume')}.jsonl`), transcript);
if (arg('--resume') && !forking && !fs.existsSync(transcript)) { process.stderr.write('No conversation found\n'); process.exit(1); }
const log = (o) => fs.appendFileSync(transcript, `${JSON.stringify(o)}\n`);
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
let seq = 0;
const waiting = new Map();
let interrupted = null;
let earlyInterrupt = false;

function askHost(request) {
  const id = `req-${++seq}`;
  out({ type: 'control_request', request_id: id, request });
  return new Promise((r) => waiting.set(id, r));
}
function assistant(text) {
  out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } }, parent_tool_use_id: null });
  const m = { type: 'assistant', message: { role: 'assistant', model, content: [{ type: 'text', text }], usage: { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 0, output_tokens: 5 } }, parent_tool_use_id: null, session_id: sessionId, timestamp: new Date().toISOString() };
  out(m); log(m);
}
function result() { out({ type: 'result', subtype: 'success', total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5 }, modelUsage: { [model]: { contextWindow: 1000000, costUSD: 0.01 } }, session_id: sessionId }); }

async function turn(content) {
  const text = typeof content === 'string' ? content : content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const images = Array.isArray(content) ? content.filter((b) => b.type === 'image').length : 0;
  log({ type: 'user', message: { role: 'user', content }, session_id: sessionId, timestamp: new Date().toISOString() });
  out({ type: 'system', subtype: 'init', session_id: sessionId, model, permissionMode: mode });
  out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.4 } } } });
  if (text === '/compact') {
    fs.appendFileSync(path.join(home, 'compact.log'), 'x\n');
    out({ type: 'system', subtype: 'compact_boundary', session_id: sessionId });
  } else if (text.includes('WRITE')) {
    const tu = { type: 'assistant', message: { role: 'assistant', model, content: [{ type: 'tool_use', id: 'tu1', name: 'Write', input: { file_path: 'a.txt', content: 'hi' } }] }, parent_tool_use_id: null, timestamp: new Date().toISOString() };
    out(tu); log(tu);
    if (mode === 'acceptEdits') assistant('written without asking');
    else if (mode === 'plan') assistant('plan mode: not written');
    else {
      const r = await askHost({ subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: 'a.txt', content: 'hi' }, permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }], tool_use_id: 'tu1' });
      if (r.behavior === 'allow' && r.updatedPermissions) fs.writeFileSync(path.join(home, 'rules.json'), JSON.stringify(r.updatedPermissions));
      assistant(r.behavior === 'allow' ? 'allowed' : `denied: ${r.message}`);
    }
  } else if (text.includes('ASK')) {
    const input = { questions: [{ question: 'Buah?', header: 'Buah', multiSelect: false, options: [{ label: 'Apel' }, { label: 'Jeruk' }] }] };
    const r = await askHost({ subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input, tool_use_id: 'tu2', requires_user_interaction: true });
    assistant(r.behavior === 'allow' ? `jawab: ${r.updatedInput.answers['Buah?']}` : 'no answer');
  } else if (text.includes('SLOW')) {
    if (!earlyInterrupt) await new Promise((r) => { interrupted = r; });
    earlyInterrupt = false;
    out({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }, parent_tool_use_id: null });
  } else {
    assistant(`echo(${model}${images ? `, ${images} img` : ''}): ${text}`);
  }
  result();
}

let queue = Promise.resolve();
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.type === 'control_response') { const w = waiting.get(m.response.request_id); waiting.delete(m.response.request_id); w?.(m.response.response); continue; }
    if (m.type === 'control_request') {
      const r = m.request;
      let resp = {};
      if (r.subtype === 'initialize') resp = { commands: [{ name: 'halo', description: 'Test skill' }], models: [{ value: 'sonnet', displayName: 'Sonnet', supportedEffortLevels: ['low', 'high'] }] };
      if (r.subtype === 'set_model') { model = r.model; resp = { model }; }
      if (r.subtype === 'set_permission_mode') { mode = r.mode; resp = { mode }; }
      if (r.subtype === 'interrupt') { if (interrupted) interrupted(); else earlyInterrupt = true; interrupted = null; }
      out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: resp } });
      continue;
    }
    if (m.type === 'user') queue = queue.then(() => turn(m.message.content));
  }
});
process.stdin.on('end', () => queue.then(() => process.exit(0)));
