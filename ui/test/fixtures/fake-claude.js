// Stand-in for the claude binary: reads the prompt from stdin and behaves by keyword (tests only).
if (process.argv.includes('--version')) { console.log('9.9.9 (fake)'); process.exit(0); }
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (prompt += c));
process.stdin.on('end', () => {
  const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
  const pidFile = process.env.FAKE_PID_FILE;
  if (pidFile) fs.writeFileSync(pidFile, String(process.pid));
  out({ type: 'system', subtype: 'init', session_id: 'sess-1' });
  if (prompt.includes('HANG')) {
    // a grandchild proves that Stop kills the whole tree, not just the direct child
    const g = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    if (pidFile) fs.writeFileSync(`${pidFile}.child`, String(g.pid));
    out({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } });
    setInterval(() => {}, 1000);
    return;
  }
  if (prompt.includes('Return a JSON array of ideas')) {
    const ideas = [
      { category: 'security', title: 'Pin dependencies', description: 'd', rationale: 'r', currentState: 'c', proposedChange: 'p', effort: 'small' },
      { category: 'bogus', title: 'Add tests', effort: 'huge' },
      { title: '' },
    ];
    out({ type: 'result', subtype: 'success', is_error: false, result: `Here you go:\n\`\`\`json\n${JSON.stringify(ideas)}\n\`\`\``, total_cost_usd: 0, num_turns: 1, session_id: 'sess-1', permission_denials: [] });
    return;
  }
  // Agent gates (scheduler tests): WRITE wants the Write tool; without it the run ends with a permission denial.
  const tools = (process.argv[process.argv.indexOf('--allowedTools') + 1] ?? '').split(',');
  const allowed = process.argv.includes('--allowedTools') ? tools : [];
  const resumed = process.argv.includes('--resume');
  if (prompt.includes('WRITE') || (resumed && prompt.includes('Approved'))) {
    if (allowed.includes('Write')) {
      fs.writeFileSync('agent-wrote.txt', `written${resumed ? ' after resume' : ''}\n`);
      out({ type: 'result', subtype: 'success', is_error: false, result: 'wrote agent-wrote.txt', total_cost_usd: 0.01, num_turns: 2, session_id: 'sess-1', permission_denials: [] });
    } else {
      out({ type: 'result', subtype: 'success', is_error: false, result: 'Plan: write agent-wrote.txt', total_cost_usd: 0.01, num_turns: 1, session_id: 'sess-1', permission_denials: [{ tool_name: 'Write', tool_input: { file_path: 'agent-wrote.txt', content: 'token=abcdef1234567' } }] });
    }
    return;
  }
  if (prompt.includes('EXPENSIVE')) {
    out({ type: 'result', subtype: 'success', is_error: false, result: 'done, expensively', total_cost_usd: 3, num_turns: 1, session_id: 'sess-1', permission_denials: [] });
    return;
  }
  if (prompt.includes('SECRET')) {
    out({ type: 'assistant', message: { content: [{ type: 'text', text: 'key ghp_abcdefghijklmnopqrstuvwxyz123456 password=hunter22222' }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'api_key=supersecretvalue', total_cost_usd: 0, num_turns: 1, session_id: 'sess-1', permission_denials: [] });
    return;
  }
  // Worktree tests (S11): WTSAVE writes a file in the folder the job runs in; PUSHTRY tries git push there.
  if (prompt.includes('WTSAVE')) {
    fs.writeFileSync('job-wrote.txt', `cwd ${process.cwd()}
`);
    out({ type: 'result', subtype: 'success', is_error: false, result: 'wrote job-wrote.txt', total_cost_usd: 0, num_turns: 1, session_id: 'sess-1', permission_denials: [] });
    return;
  }
  if (prompt.includes('PUSHTRY')) {
    const r = spawnSync('git', ['push', 'origin', 'HEAD'], { encoding: 'utf8' });
    out({ type: 'user', message: { content: [{ type: 'tool_result', content: `${r.stdout}${r.stderr}`, is_error: r.status !== 0 }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: `push exit ${r.status}`, total_cost_usd: 0, num_turns: 1, session_id: 'sess-1', permission_denials: [] });
    return;
  }
  if (prompt.includes('FAIL')) {
    process.stderr.write('boom: something broke\n');
    process.exit(1);
  }
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello token=abcdef123456 done' }, { type: 'tool_use', name: 'Bash', input: { command: 'git log' } }] } });
  out({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok', is_error: false }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: `RESULT for: ${prompt.trim().split('\n').pop()}`, total_cost_usd: 0.01, num_turns: 2, session_id: 'sess-1', permission_denials: [] });
});
