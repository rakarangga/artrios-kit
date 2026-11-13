// Engine for the ChatGPT-subscription path: runs `codex exec --json` (the user's own `codex login`, no API key) and
// maps its JSONL events to the shapes of `claude -p --output-format stream-json`, so the job runner, Insights and
// Ideation stay unchanged. Same interface as engine.js: run(opts, onLine) -> { pid, stop(), done }.
// Event names follow the Codex CLI docs (thread.started, item.completed, turn.completed, turn.failed, error). Unknown
// events are ignored, so a newer CLI adds nothing that breaks a run. No cost is reported: a subscription has no price per token.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { agentEnv } from '../child-env.js';
import { killTree } from '../engine.js';

const STDERR_TAIL = 4000;

// A run with no tools allowed (Q&A, summaries) may not touch files; a run with tools can write inside its folder, nowhere else.
export function buildCodexArgs({ cwd, model, allowedTools = [] }) {
  const args = ['exec', '--json', '--skip-git-repo-check', '--sandbox', allowedTools.length ? 'workspace-write' : 'read-only'];
  if (cwd) args.push('-C', cwd);
  if (model) args.push('-m', model);
  args.push('-'); // the prompt arrives on stdin
  return args;
}

// One Codex event -> zero or more stream-json lines. state keeps the last message so the run can close with it.
export function mapCodexEvent(ev, state) {
  const out = [];
  const item = ev?.item;
  if (ev?.type === 'thread.started' && ev.thread_id) state.sessionId = ev.thread_id;
  else if (ev?.type === 'item.completed' && item) {
    if (item.type === 'agent_message' && item.text) {
      state.lastText = item.text;
      out.push({ type: 'assistant', message: { content: [{ type: 'text', text: item.text }] } });
    } else if (item.type === 'command_execution') {
      const id = item.id ?? `cmd_${++state.n}`;
      out.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: item.command ?? '' } }] } });
      out.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: item.exit_code != null && item.exit_code !== 0, content: String(item.aggregated_output ?? '') }] } });
    } else if (item.type === 'file_change') {
      const id = item.id ?? `chg_${++state.n}`;
      const files = (item.changes ?? []).map((c) => c.path).filter(Boolean).join(', ');
      out.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Edit', input: { file_path: files } }] } });
      out.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: item.status === 'failed', content: files }] } });
    } else if (item.type === 'error' && item.message) state.error = item.message;
  } else if (ev?.type === 'turn.completed') state.done = true;
  else if (ev?.type === 'turn.failed') state.error = ev.error?.message ?? 'the turn failed';
  else if (ev?.type === 'error' && ev.message) state.error = ev.message;
  return out;
}

export function createCodexEngine({ command = 'codex', baseArgs = [], env = process.env, name = 'codex_cli' } = {}) {
  function run(opts, onLine) {
    const { prompt, cwd } = opts;
    const state = { sessionId: `codex-${crypto.randomBytes(6).toString('hex')}`, lastText: '', error: null, done: false, n: 0 };
    const emit = (o) => { try { onLine(o); } catch { /* a bad consumer must not kill the stream */ } };
    const child = spawn(command, [...baseArgs, ...buildCodexArgs(opts)], {
      cwd, env: agentEnv(env), windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stopped = false;
    let stderrTail = '';
    let buf = '';
    emit({ type: 'system', subtype: 'init', session_id: state.sessionId });

    const feed = (line) => {
      let ev;
      try { ev = JSON.parse(line); } catch { return; } // progress text that is not JSON
      for (const o of mapCodexEvent(ev, state)) emit(o);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) feed(line); }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => { stderrTail = (stderrTail + c).slice(-STDERR_TAIL); });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt ?? '');

    const done = new Promise((resolve) => {
      let finished = false;
      const finish = (code) => {
        if (finished) return;
        finished = true;
        if (buf.trim()) feed(buf.trim());
        const failed = !stopped && (Boolean(state.error) || code !== 0 || !state.done);
        if (!stopped) {
          const msg = state.error ?? (stderrTail.trim() || `codex exited with code ${code}`);
          emit({ type: 'result', is_error: failed, result: failed ? msg : state.lastText, session_id: state.sessionId, total_cost_usd: null });
        }
        resolve({ exitCode: failed ? (code || 1) : 0, stopped, stderrTail: state.error ?? stderrTail });
      };
      child.on('error', (e) => { stderrTail = e.code === 'ENOENT' ? 'the codex command was not found. Install it and run `codex login`.' : e.message; finish(-1); });
      child.on('close', (code) => finish(code ?? -1));
    });
    return { pid: child.pid, stop() { stopped = true; killTree(child.pid); }, done };
  }
  return { name, run };
}
