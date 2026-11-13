// Engine "claude-headless" (PRD section 6): runs `claude -p` with stream-json and reports parsed events.
// Pure library: no HTTP. Interface: run({ prompt, cwd, allowedTools, model, resume, maxBudgetUsd }, onLine)
//   -> { stop(), done: Promise<{ exitCode, stopped, stderrTail }> }
// onLine receives one parsed JSON object per stdout line (non-JSON lines arrive as { type: 'raw', text }).
// Spike A1 (2026-11-05): --verbose is required for stream-json; stdin must be closed; `-p` does not expand /skill,
// so callers send the SKILL.md body as the prompt and pass --allowedTools per skill (B4: no skip-permissions mode).
import { spawn, spawnSync } from 'node:child_process';
import { agentEnv } from './child-env.js';

const STDERR_TAIL = 4000;

// noMcp: start claude without any MCP server (read-only Q&A never uses them; saves about 2 s of startup).
export function buildArgs({ allowedTools = [], model, effort, resume, maxBudgetUsd, noMcp = false }) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (noMcp) args.push('--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}');
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  if (resume) args.push('--resume', resume);
  if (allowedTools.length) args.push('--allowedTools', allowedTools.join(','));
  if (maxBudgetUsd) args.push('--max-budget-usd', String(maxBudgetUsd));
  return args;
}

// Kill the whole process tree: claude spawns children (shell, git, node) that a plain kill leaves behind.
export function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  }
}

export function createClaudeHeadlessEngine({ command = 'claude', baseArgs = [], env = process.env } = {}) {
  function run(opts, onLine) {
    const { prompt, cwd } = opts;
    const child = spawn(command, [...baseArgs, ...buildArgs(opts)], {
      cwd,
      env: agentEnv(env), // a headless claude is an agent: it can commit but never push (S11, AC 21)
      windowsHide: true,
      detached: process.platform !== 'win32', // own process group so killTree can signal -pid
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stopped = false;
    let stderrTail = '';
    let buf = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) emit(line);
      }
    });
    function emit(line) {
      let obj;
      try { obj = JSON.parse(line); } catch { obj = { type: 'raw', text: line }; }
      try { onLine(obj); } catch { /* a bad consumer must not kill the stream */ }
    }
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => { stderrTail = (stderrTail + c).slice(-STDERR_TAIL); });
    child.stdin.on('error', () => { /* child exited before reading the prompt */ });
    child.stdin.end(prompt ?? '');

    const done = new Promise((resolve) => {
      let finished = false;
      const finish = (exitCode) => {
        if (finished) return;
        finished = true;
        if (buf.trim()) emit(buf.trim());
        resolve({ exitCode, stopped, stderrTail });
      };
      child.on('error', (e) => { stderrTail = `${stderrTail}${e.message}`.slice(-STDERR_TAIL); finish(-1); });
      child.on('close', (code) => finish(code ?? -1));
    });

    return {
      pid: child.pid,
      stop() {
        stopped = true;
        killTree(child.pid);
      },
      done,
    };
  }
  return { name: 'claude-headless', run };
}
