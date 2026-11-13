// Environment for child processes (terminal tabs, headless jobs). When the server is started from inside a Claude Code
// session, that session's markers and messaging channel are inherited. A child claude must not join that session, so
// these keys are removed. Credentials and settings (CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_*, HOME, PATH) are kept.
const SESSION_KEYS = new Set([
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SSE_PORT',
]);

export function childEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || SESSION_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

// Agents never push (PRD AIOS-61 v2.1 S11, AC 21). Every push URL of an agent process is rewritten to a scheme git has
// no helper for, so `git push` fails ("remote-artrios-no-push is not a git command") whatever the remote or the
// wording of the command. Fetch and pull are untouched. Added through GIT_CONFIG_COUNT (git 2.31+), after any keys
// already passed that way. Used for headless jobs and API-provider tools, not for the terminal or Cognition (the owner at the keyboard).
export const NO_PUSH_MARK = 'artrios-no-push';
export function agentEnv(env = process.env) {
  const out = childEnv(env);
  const n = Number.parseInt(out.GIT_CONFIG_COUNT ?? '0', 10) || 0;
  out[`GIT_CONFIG_KEY_${n}`] = `url.${NO_PUSH_MARK}://.pushInsteadOf`;
  out[`GIT_CONFIG_VALUE_${n}`] = '';
  out.GIT_CONFIG_COUNT = String(n + 1);
  return out;
}
