// Runs one headless prompt to completion and returns its final text. Used by Ideation and the Cognition engine switch.
import { redact } from './job-runner.js';

const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n)}…` : String(s));

// opts: { prompt, cwd, allowedTools, model }. onHandle receives the engine handle so the caller can stop it.
export function runOnce(engine, config, opts, onHandle) {
  return new Promise((resolve) => {
    let result = null;
    let lastText = '';
    const handle = engine.run({ ...opts, maxBudgetUsd: config.jobMaxBudgetUsd }, (obj) => {
      if (obj.type === 'result') result = obj;
      if (obj.type === 'assistant') for (const c of obj.message?.content ?? []) if (c.type === 'text') lastText = c.text;
    });
    onHandle?.(handle);
    const timer = setTimeout(() => handle.stop(), config.jobTimeoutMs ?? 30 * 60 * 1000);
    handle.done.then(({ exitCode, stderrTail }) => {
      clearTimeout(timer);
      if (exitCode === 0 && result && !result.is_error) return resolve({ ok: true, text: redact(String(result.result ?? lastText)), cost: result.total_cost_usd ?? null });
      resolve({ ok: false, error: redact(clip(result?.is_error ? String(result.result) : (stderrTail.trim() || lastText || `exit code ${exitCode}`), 1500)) });
    });
  });
}
