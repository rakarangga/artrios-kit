// Engine for API providers: the tool loop the CLI otherwise runs. Same interface as engine.js, and it emits the same
// event shapes as `claude -p --output-format stream-json`, so the job runner, Insights and Ideation stay unchanged.
// Tool results go back as role "tool" messages. Spending is bounded by maxTurns and the job timeout: the app knows
// no price list, so cost stays null and config.jobMaxBudgetUsd does not apply here.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createToolbox } from './tools.js';
import { extraHeaders } from './catalog.js';

const MAX_TURNS = 40;
const RETRIES = 2;
const CONTEXT_MAX = 16 * 1024;
const CLAUDE_ALIAS = /^(opus|sonnet|haiku)(\[.*\])?$/;

const readHead = (file) => { try { return fs.readFileSync(file, 'utf8').slice(0, CONTEXT_MAX); } catch { return ''; } };

// The CLI loads these by itself; an API model gets them here.
export function systemPrompt({ cwd, coreFile }) {
  const manual = readHead(path.join(cwd, 'AGENTS.md')) || readHead(path.join(cwd, 'CLAUDE.md'));
  return [
    `You work in the project folder ${cwd}. Use the tools you are given; paths are relative to that folder.`,
    'A refused tool call is final: do not try to get around it. End with a short plain answer when the work is done.',
    coreFile && readHead(coreFile) ? `Standing rules:\n${readHead(coreFile)}` : '',
    manual ? `Project manual:\n${manual}` : '',
  ].filter(Boolean).join('\n\n');
}

const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

// One POST with retries (429 and 5xx), shared by the job engine and the Cognition chat. Errors never carry the key.
export function createCaller({ provider, apiKey, transport, fetchImpl = fetch, retryDelayMs = 1500 }) {
  const hide = (text) => (apiKey ? String(text).split(apiKey).join('[redacted]') : String(text));
  async function call(body, signal) {
    let last = null;
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      if (attempt) await sleep(retryDelayMs * attempt, signal);
      if (signal.aborted) throw new Error('stopped');
      let res;
      try {
        res = await fetchImpl(`${provider.base_url}${transport.path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), ...extraHeaders(provider.base_url) },
          body: JSON.stringify(body),
          signal,
        });
      } catch (e) {
        if (signal.aborted) throw new Error('stopped');
        last = `could not reach ${provider.base_url}: ${e.cause?.code ?? e.message}`;
        continue;
      }
      const text = await res.text();
      if (res.ok) {
        try { return JSON.parse(text); } catch { throw new Error('the provider returned something that is not JSON'); }
      }
      last = `HTTP ${res.status}: ${hide(text.slice(0, 500))}`;
      if (res.status !== 429 && res.status < 500) break; // bad key or bad request: retrying will not help
    }
    throw new Error(hide(last));
  }
  return { call, hide };
}

export function createApiEngine({ provider, apiKey, transport, fetchImpl = fetch, coreFile = null, maxTurns = MAX_TURNS, retryDelayMs = 1500, name = 'api' }) {
  const { call, hide } = createCaller({ provider, apiKey, transport, fetchImpl, retryDelayMs });

  function run(opts, onLine) {
    const { prompt, cwd, allowedTools = [], model } = opts;
    const ctl = new AbortController();
    const toolbox = createToolbox({ cwd, allowedTools });
    const sessionId = `api-${crypto.randomBytes(6).toString('hex')}`;
    let stopped = false;
    const emit = (o) => { try { onLine(o); } catch { /* a bad consumer must not kill the loop */ } };
    const chosen = model && !CLAUDE_ALIAS.test(model) ? model : provider.model; // sonnet, opus, haiku mean nothing here

    async function loop() {
      emit({ type: 'system', subtype: 'init', session_id: sessionId });
      const messages = [{ role: 'system', content: systemPrompt({ cwd, coreFile }) }, { role: 'user', content: prompt ?? '' }];
      const tools = transport.convertTools(toolbox.definitions());
      for (let turn = 1; turn <= maxTurns; turn++) {
        const json = await call(transport.buildKwargs({ model: chosen, messages: transport.convertMessages(messages), tools }), ctl.signal);
        const r = transport.normalizeResponse(json);
        const content = [
          ...(r.text ? [{ type: 'text', text: r.text }] : []),
          ...r.toolCalls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.args })),
        ];
        emit({ type: 'assistant', message: { content } });
        if (!r.toolCalls.length) {
          emit({ type: 'result', is_error: false, result: r.text, num_turns: turn, session_id: sessionId, total_cost_usd: null });
          return 0;
        }
        messages.push({
          role: 'assistant',
          content: r.text || null,
          tool_calls: r.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })),
        });
        for (const c of r.toolCalls) {
          if (ctl.signal.aborted) throw new Error('stopped');
          const out = c.argsError ? { text: c.argsError, isError: true } : await toolbox.run(c.name, c.args);
          emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: c.id, is_error: out.isError, content: out.text }] } });
          messages.push({ role: 'tool', tool_call_id: c.id, content: out.text });
        }
      }
      throw new Error(`stopped after ${maxTurns} turns without a final answer`);
    }

    const done = loop().then((exitCode) => ({ exitCode, stopped, stderrTail: '' })).catch((e) => {
      const message = hide(e.message);
      if (!stopped) emit({ type: 'result', is_error: true, result: message, session_id: sessionId, total_cost_usd: null });
      return { exitCode: 1, stopped, stderrTail: message };
    });

    return {
      pid: null,
      stop() { stopped = true; ctl.abort(); toolbox.stop(); },
      done,
    };
  }
  return { name, run };
}
