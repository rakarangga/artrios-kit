// Context warning (AIOS-120). The model window is 1M tokens, so a percentage bar never warns, yet every tool call
// re-reads the whole context. The warning therefore uses an absolute size: from WARN_TOKENS on, a session should be
// compacted or replaced.
export const WARN_TOKENS = 100_000;
export const HIGH_TOKENS = 200_000;

// null = unknown size; "ok" below the warning; "warn" from 100k; "high" from 200k.
export function contextLevel(tokens, { warn = WARN_TOKENS, high = HIGH_TOKENS } = {}) {
  if (!Number.isFinite(tokens) || tokens <= 0) return null;
  if (tokens >= high) return "high";
  if (tokens >= warn) return "warn";
  return "ok";
}
