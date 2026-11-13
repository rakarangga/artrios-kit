// Job runner (F3, PRD sections 5, 6, 8a). Pure library: no HTTP, context comes in as parameters,
// events go out through `onEvent`. Jobs keep running and logging when no browser is connected.
// Files per job: <project>/.artrios/jobs/<id>/{request.md, meta.json, log.jsonl, result.md}.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildSkillPrompt } from './skills.js';
import { localTimestamp } from './task-service.js';
import { atomicWrite } from './lock.js';
import { spawn } from 'node:child_process';
import { childEnv, NO_PUSH_MARK } from './child-env.js';
import { killTree } from './engine.js';

const ID_RE = /^j-\d{8}-\d{6}-[0-9a-f]{4}$/;
const TEXT_MAX = 4000;
const ERROR_TAIL = 2000;

export class JobError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // invalid | not_found | busy (all slots in use)
  }
}

// B5: output that looks like a secret is masked before it is stored or shown.
const SECRET_PATTERNS = [
  /\b(sk|pk|ghp|gho|ghs|github_pat|xox[bap]|AKIA)[-_A-Za-z0-9]{16,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\b((?:password|passwd|secret|token|api[_-]?key)\s*[=:]\s*)\S{6,}/gi,
];
export function redact(text) {
  let out = String(text);
  out = out.replace(SECRET_PATTERNS[0], '[redacted]').replace(SECRET_PATTERNS[1], 'Bearer [redacted]').replace(SECRET_PATTERNS[2], '$1[redacted]');
  return out;
}

export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

const clip = (s, n = TEXT_MAX) => (String(s).length > n ? `${String(s).slice(0, n)} [cut]` : String(s));

// Turns one stream-json object into zero or more compact log entries.
export function normalize(obj) {
  const out = [];
  if (obj.type === 'assistant') {
    for (const b of obj.message?.content ?? []) {
      if (b.type === 'text' && b.text) out.push({ kind: 'text', text: clip(b.text) });
      else if (b.type === 'tool_use') out.push({ kind: 'tool', name: b.name, text: clip(JSON.stringify(b.input ?? {}), 300) });
    }
  } else if (obj.type === 'user') {
    for (const b of obj.message?.content ?? []) {
      if (b.type !== 'tool_result') continue;
      const t = Array.isArray(b.content) ? b.content.map((c) => c.text ?? '').join('') : String(b.content ?? '');
      out.push({ kind: 'tool_result', error: !!b.is_error, text: clip(t, 500) });
    }
  } else if (obj.type === 'raw') {
    out.push({ kind: 'raw', text: clip(obj.text, 500) });
  }
  return out;
}

export function createJobRunner({ engine, config = {}, onEvent = () => {}, now = () => new Date() }) {
  const active = new Map(); // `${project}/${id}` -> { handle, stopRequested, timedOut, timer }
  const maxJobs = config.maxJobs ?? 2;
  const timeoutMs = config.jobTimeoutMs ?? 30 * 60 * 1000;

  const jobsDir = (project) => path.join(project.path, '.artrios', 'jobs');
  const dirOf = (project, id) => {
    if (!ID_RE.test(id ?? '')) throw new JobError('invalid', `bad job id: ${id}`);
    return path.join(jobsDir(project), id);
  };
  const readMeta = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const writeMeta = (dir, meta) => atomicWrite(path.join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);

  function appendLog(project, id, dir, entry) {
    const line = { ts: localTimestamp(now()), project: project.key, jobId: id, ...entry, ...(entry.text !== undefined ? { text: redact(entry.text) } : {}) };
    try { fs.appendFileSync(path.join(dir, 'log.jsonl'), `${JSON.stringify(line)}\n`); } catch { /* best effort */ }
    onEvent({ type: 'job.log', project: project.key, jobId: id, entry: line });
  }

  function setStatus(project, id, dir, patch) {
    const meta = { ...readMeta(dir), ...patch };
    writeMeta(dir, meta);
    onEvent({ type: 'job.status', project: project.key, jobId: id, meta });
    return meta;
  }

  // A job still marked running without a live process was interrupted (server stopped): close it as failed.
  // A job owned by another live process (the scheduler, while the UI only reads) is left alone (AC 6).
  function recover(project, id, dir, meta) {
    if (!['running', 'queued'].includes(meta.status) || active.has(`${project.key}/${id}`)) return meta;
    if (meta.pid && meta.pid !== process.pid && pidAlive(meta.pid)) return meta;
    return setStatus(project, id, dir, { status: 'failed', finished: localTimestamp(now()), error: `interrupted: the server stopped while this job ${meta.status === 'queued' ? 'waited' : 'ran'}` });
  }

  function list(project, limit = 50) {
    let ids = [];
    try { ids = fs.readdirSync(jobsDir(project)).filter((n) => ID_RE.test(n)); } catch { return []; }
    return ids.sort().reverse().slice(0, limit).flatMap((id) => {
      try {
        const dir = path.join(jobsDir(project), id);
        return [recover(project, id, dir, readMeta(dir))];
      } catch { return []; }
    });
  }

  function show(project, id) {
    const dir = dirOf(project, id);
    let meta;
    try { meta = recover(project, id, dir, readMeta(dir)); } catch { throw new JobError('not_found', `unknown job: ${id}`); }
    const read = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return ''; } };
    return { meta, request: read('request.md'), result: read('result.md') };
  }

  function log(project, id, limit = 2000) {
    const dir = dirOf(project, id);
    if (!fs.existsSync(dir)) throw new JobError('not_found', `unknown job: ${id}`);
    try {
      const lines = fs.readFileSync(path.join(dir, 'log.jsonl'), 'utf8').split('\n').filter(Boolean);
      return lines.slice(-limit).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
    } catch { return []; }
  }

  // Moves the linked card, but only while it is still in one of the expected columns: the user may have moved it meanwhile.
  function moveCard(entry, to, from) {
    if (!entry.card || !entry.svc) return;
    try {
      const cur = entry.svc.show(entry.card).status;
      if (cur !== to && from.includes(cur)) entry.svc.move(entry.card, to, { by: 'agent' });
    } catch { /* card gone or broken: the job itself is unaffected */ }
  }

  // The card follows its job (Auto Claude style): In progress while a work job runs; a finished work job goes to
  // AI review, where config.reviewSkill (when set) runs as a second job; its success, or no review skill, goes to
  // Human review. Failure goes to Error. Stop puts the card back where it was.
  const WORK_FROM = ['backlog', 'todo', 'error', 'human_review'];
  function settleCard(entry, status) {
    const { project, card, svc, role, cardPrev, skill } = entry;
    if (!card || !svc) return;
    if (status === 'failed') { moveCard(entry, 'error', ['in_progress', 'ai_review']); return; }
    if (status === 'stopped') {
      if (role === 'work') moveCard(entry, WORK_FROM.includes(cardPrev) && cardPrev !== 'human_review' ? cardPrev : 'todo', ['in_progress']);
      return;
    }
    if (role === 'review') { moveCard(entry, 'human_review', ['ai_review']); return; }
    const reviewSkill = config.reviewSkill;
    if (!reviewSkill || reviewSkill === skill) { moveCard(entry, 'human_review', ['in_progress']); return; }
    moveCard(entry, 'ai_review', ['in_progress']);
    try {
      const title = svc.show(card).title;
      start(project, { skill: reviewSkill, args: `${card} ${title}`, card, svc, by: 'agent', role: 'review', cwd: entry.cwd ?? null });
    } catch {
      moveCard(entry, 'human_review', ['ai_review']); // review could not start (slots busy, skill not allowed): do not strand the card
    }
  }

  const busy = () => { if (active.size >= maxJobs) throw new JobError('busy', `all ${maxJobs} job slots are busy; wait for one to finish or stop one`); };

  // svc = the project's task service, so the job can move its card (see settleCard).
  // There is no waiting line: when all maxJobs slots are busy a new job is refused (429) and nothing is written.
  // Agent runs (scheduler) also pass: agent, allowedTools (from agents/<id>.md), instructions, budget
  // { maxUsd, maxMinutes }, and a gate (PRD AIOS-61 v2.0 S3, §11):
  //   gate 'write': the run gets only phaseTools (read-only); if it tried a tool outside them it stops as
  //                 waiting_approval, and resume() continues the same session with the full allowedTools.
  //   gate 'run':   nothing runs; the job waits as waiting_approval until resume().
  // Command run (a schedule of type command): a fixed argv without a shell, in the location folder, same job files.
  // An exit code listed in exitWarn ends as done with warning (e.g. a health check that found something).
  function startCommand(project, { argv, timeoutSec = null, exitWarn = [], schedule = null, by = 'scheduler' }) {
    busy();
    if (!Array.isArray(argv) || !argv.length) throw new JobError('invalid', 'command is empty');
    const stamp = now();
    const p2 = (n) => String(n).padStart(2, '0');
    const id = `j-${stamp.getFullYear()}${p2(stamp.getMonth() + 1)}${p2(stamp.getDate())}-${p2(stamp.getHours())}${p2(stamp.getMinutes())}${p2(stamp.getSeconds())}-${crypto.randomBytes(2).toString('hex')}`;
    const dir = dirOf(project, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'request.md'), `# Job ${id}\n\n- schedule: ${schedule ?? '(none)'}\n- command: ${argv.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}\n- folder: ${project.path}\n`);
    const meta0 = { id, project: project.key, skill: null, schedule, command: argv, engine: 'command', role: 'schedule', status: 'running', started: localTimestamp(stamp), finished: null, exitCode: null, cost: null, error: null, warning: false, pid: process.pid };
    writeMeta(dir, meta0);
    onEvent({ type: 'job.status', project: project.key, jobId: id, meta: meta0 });
    onEvent({ type: 'activity', project: project.key, event: { ts: meta0.started, type: 'job.started', ref: id, by, detail: `schedule ${schedule ?? argv[0]}` } });
    const key = `${project.key}/${id}`;
    const state = { handle: null, stopRequested: false, timedOut: false, timer: null };
    active.set(key, state);
    let child;
    let spawnError = null;
    const tail = [];
    try {
      child = spawn(argv[0], argv.slice(1), { cwd: project.path, env: childEnv(process.env), windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    } catch (e) { spawnError = e; }
    const finish = (exitCode, errText) => {
      clearTimeout(state.timer);
      active.delete(key);
      let status = 'done';
      let error = null;
      let warning = false;
      if (state.stopRequested) status = 'stopped';
      else if (state.timedOut) { status = 'failed'; error = `timeout after ${timeoutSec}s`; }
      else if (errText) { status = 'failed'; error = redact(errText); }
      else if (exitCode !== 0 && exitWarn.includes(exitCode)) warning = true;
      else if (exitCode !== 0) { status = 'failed'; error = clip(redact(tail.join('\n') || `exit code ${exitCode}`), ERROR_TAIL); }
      try { fs.writeFileSync(path.join(dir, 'result.md'), `${redact(tail.slice(-40).join('\n')).trimEnd()}\n`); } catch { /* best effort */ }
      appendLog(project, id, dir, { kind: 'status', text: status === 'done' ? (warning ? `finished with exit ${exitCode} (warning)` : 'finished') : `${status}${error ? `: ${error}` : ''}` });
      const meta = setStatus(project, id, dir, { status, exitCode, error, warning, finished: localTimestamp(now()) });
      onEvent({ type: 'activity', project: project.key, event: { ts: meta.finished, type: 'job.finished', ref: id, by: 'scheduler', detail: `schedule ${schedule ?? argv[0]} ${warning ? 'warning' : status}` } });
    };
    if (spawnError) { finish(-1, spawnError.message); return readMeta(dir); }
    const onData = (kind) => {
      let buf = '';
      return (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, '');
          buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          tail.push(line); if (tail.length > 200) tail.shift();
          appendLog(project, id, dir, { kind, text: clip(line, 1000) });
        }
      };
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', onData('text'));
    child.stderr.on('data', onData('raw'));
    let done = false;
    child.on('error', (e) => { if (!done) { done = true; finish(-1, e.message); } });
    child.on('close', (code) => { if (!done) { done = true; finish(code ?? -1, null); } });
    state.handle = { stop: () => killTree(child.pid) };
    if (timeoutSec) state.timer = setTimeout(() => { state.timedOut = true; killTree(child.pid); }, timeoutSec * 1000);
    return meta0;
  }

  // cwd: a worktree of the project (S11 "run in worktree"); the job's files stay in the project's .artrios/jobs.
  function start(project, { skill = null, args = '', card = null, svc = null, by = 'ui', role = 'work', model = null, agent = null, schedule = null, provider = null, allowedTools = null, phaseTools = null, instructions = '', budget = null, gate = null, cwd = null }) {
    if (gate !== 'run') busy();
    let built;
    if (skill) {
      built = buildSkillPrompt(project, config, skill, args, { allowedTools: allowedTools ?? undefined });
      if (instructions.trim()) built.prompt = `${built.prompt.trimEnd()}\n\n## Agent instructions\n\n${instructions.trim()}\n`;
    } else {
      if (!agent || !instructions.trim()) throw new JobError('invalid', 'a job needs a skill (or, for an agent, instructions)');
      built = { prompt: `${instructions.trim()}\n`, allowedTools: allowedTools ?? [], args: '' };
    }
    const cardPrev = card && svc ? svc.show(card).status : null; // throws not_found/invalid for an unknown card

    const stamp = now();
    const p2 = (n) => String(n).padStart(2, '0');
    const id = `j-${stamp.getFullYear()}${p2(stamp.getMonth() + 1)}${p2(stamp.getDate())}-${p2(stamp.getHours())}${p2(stamp.getMinutes())}${p2(stamp.getSeconds())}-${crypto.randomBytes(2).toString('hex')}`;
    const dir = dirOf(project, id);
    fs.mkdirSync(dir, { recursive: true });
    const label = skill ?? `agent:${agent}`;
    fs.writeFileSync(path.join(dir, 'request.md'), `# Job ${id}\n\n- skill: ${skill ?? '(none)'}\n${agent ? `- agent: ${agent}\n` : ''}- arguments: ${built.args || '(none)'}\n- card: ${card ?? '(none)'}\n- allowed tools: ${built.allowedTools.join(', ') || '(none)'}\n${gate ? `- approval gate: ${gate}\n` : ''}\n## Prompt\n\n${built.prompt}\n`);
    fs.writeFileSync(path.join(dir, 'prompt.md'), built.prompt);
    const meta0 = {
      id, project: project.key, skill, args: built.args, card, role, model, engine: engine.name,
      status: gate === 'run' ? 'waiting_approval' : 'running', started: localTimestamp(stamp), finished: null, exitCode: null,
      allowedTools: built.allowedTools, cost: null, turns: null, sessionId: null, denials: 0, error: null,
      ...(schedule ? { schedule } : {}),
      ...(provider ? { provider } : {}),
      ...(cwd ? { cwd: path.resolve(cwd) } : {}),
      ...(agent ? { agent, gate, budget: budget ?? null, phaseTools: phaseTools ?? null, phase: gate === 'run' ? 'before-run' : (gate === 'write' ? 'read' : 'full'), denied: [] } : {}),
      pid: process.pid,
    };
    writeMeta(dir, meta0);
    onEvent({ type: 'job.status', project: project.key, jobId: id, meta: meta0 });
    if (gate === 'run') {
      onEvent({ type: 'activity', project: project.key, event: { ts: meta0.started, type: 'job.waiting', ref: id, by, detail: `${label} waits for approval` } });
      return meta0;
    }
    const entry = { project, id, dir, prompt: built.prompt, tools: gate === 'write' ? (phaseTools ?? []) : built.allowedTools, skill, label, card, svc, by, role, cardPrev, model, provider, budget, gate, cwd: cwd ? path.resolve(cwd) : null };
    if (role === 'work') moveCard(entry, 'in_progress', WORK_FROM);
    return launch(entry, meta0);
  }

  // Continues a job that waits for approval (scheduler, after the inbox decision):
  //   'approve' -> runs with the full allowedTools (same session when the read phase already ran);
  //   'revise'  -> runs the read phase again in the same session with the note; may wait again.
  function resume(project, id, { action = 'approve', note = '', by = 'scheduler' } = {}) {
    const dir = dirOf(project, id);
    let meta;
    try { meta = readMeta(dir); } catch { throw new JobError('not_found', `unknown job: ${id}`); }
    if (meta.status !== 'waiting_approval') throw new JobError('invalid', `job ${id} is ${meta.status}, not waiting_approval`);
    busy();
    const original = fs.readFileSync(path.join(dir, 'prompt.md'), 'utf8');
    const fresh = meta.phase === 'before-run' || !meta.sessionId;
    let prompt;
    let tools;
    let phase;
    if (action === 'revise') {
      prompt = fresh ? `${original}\n\nRevision note from the reviewer: ${note}\n` : `The reviewer asked for a revision before anything is written: ${note}\nRevise the plan and try again.`;
      tools = meta.gate === 'write' ? (meta.phaseTools ?? []) : meta.allowedTools;
      phase = meta.gate === 'write' ? 'read' : 'full';
    } else {
      prompt = fresh ? original : `Approved${note ? ` (${note})` : ''}. Carry out the steps that were blocked before, now with the allowed tools.`;
      tools = meta.allowedTools;
      phase = 'full';
    }
    const stamp = now();
    const meta1 = setStatus(project, id, dir, { status: 'running', phase, finished: null, error: null, exitCode: null, pid: process.pid });
    appendLog(project, id, dir, { kind: 'status', text: action === 'revise' ? `revision: ${note}` : 'approved: continuing' });
    const entry = { project, id, dir, prompt, tools, skill: meta.skill, label: meta.skill ?? `agent:${meta.agent}`, card: null, svc: null, by, role: meta.role, cardPrev: null, model: meta.model, provider: meta.provider ?? null, budget: meta.budget, gate: phase === 'read' ? 'write' : null, resume: fresh ? null : meta.sessionId, costBefore: meta.cost ?? 0, cwd: meta.cwd ?? null };
    return launch(entry, { ...meta1, started: meta1.started ?? localTimestamp(stamp) });
  }

  // Closes a waiting job without running it (rejected, expired).
  function close(project, id, status, reason = '') {
    if (!['rejected', 'expired'].includes(status)) throw new JobError('invalid', `bad close status: ${status}`);
    const dir = dirOf(project, id);
    let meta;
    try { meta = readMeta(dir); } catch { throw new JobError('not_found', `unknown job: ${id}`); }
    if (meta.status !== 'waiting_approval') throw new JobError('invalid', `job ${id} is ${meta.status}, not waiting_approval`);
    appendLog(project, id, dir, { kind: 'status', text: `${status}${reason ? `: ${reason}` : ''}` });
    const m = setStatus(project, id, dir, { status, finished: localTimestamp(now()), error: reason || null });
    onEvent({ type: 'activity', project: project.key, event: { ts: m.finished, type: 'job.finished', ref: id, by: 'scheduler', detail: `${m.skill ?? `agent:${m.agent}`} ${status}` } });
    return m;
  }

  // Starts the engine for a job (a slot is free: start() checked).
  function launch(entry, meta0) {
    const { project, id, dir, skill, label, card, by, budget } = entry;
    onEvent({ type: 'activity', project: project.key, event: { ts: meta0.started, type: 'job.started', ref: id, by, detail: card ? `${label} -> ${card}` : label } });

    const key = `${project.key}/${id}`;
    const state = { handle: null, stopRequested: false, timedOut: false, timer: null };
    active.set(key, state);
    let final = null;
    let lastText = '';
    let pushRefused = false;
    const limitMs = budget?.maxMinutes ? budget.maxMinutes * 60000 : timeoutMs;
    const maxUsd = budget?.maxUsd ?? config.jobMaxBudgetUsd;

    const handle = engine.run(
      { prompt: entry.prompt, cwd: entry.cwd ?? project.path, allowedTools: entry.tools, model: entry.model ?? (skill ? config.skills?.[skill]?.model : null) ?? config.model, maxBudgetUsd: maxUsd, ...(entry.provider ? { provider: entry.provider } : {}), ...(entry.resume ? { resume: entry.resume } : {}) },
      (obj) => {
        if (obj.type === 'system' && obj.session_id) setStatus(project, id, dir, { sessionId: obj.session_id });
        if (obj.type === 'result') final = obj;
        for (const e of normalize(obj)) {
          if (e.kind === 'text') lastText = e.text;
          appendLog(project, id, dir, e);
          // Agents never push (S11, AC 21): agentEnv makes git push fail; the attempt is written down once per job.
          if (e.kind === 'tool_result' && !pushRefused && e.text.includes(NO_PUSH_MARK)) {
            pushRefused = true;
            appendLog(project, id, dir, { kind: 'status', text: 'git push refused: agents never push (push from the Worktrees screen)' });
            onEvent({ type: 'activity', project: project.key, event: { ts: localTimestamp(now()), type: 'git.push-refused', ref: id, by: 'agent', detail: `${label} tried to push` } });
          }
        }
      },
    );
    state.handle = handle;
    state.timer = setTimeout(() => { state.timedOut = true; handle.stop(); }, limitMs);

    handle.done.then(({ exitCode, stderrTail }) => {
      clearTimeout(state.timer);
      active.delete(key);
      let status = 'done';
      let error = null;
      let budgetExceeded = false;
      const cost = final?.total_cost_usd != null ? (entry.costBefore ?? 0) + final.total_cost_usd : (entry.costBefore || null);
      const denied = (final?.permission_denials ?? []).map((d) => ({ tool: String(d.tool_name ?? d.tool ?? '?'), input: clip(redact(JSON.stringify(d.tool_input ?? {})), 200) }));
      if (state.stopRequested) status = 'stopped';
      else if (state.timedOut) {
        status = 'failed';
        budgetExceeded = !!budget?.maxMinutes;
        error = budgetExceeded ? `budget: stopped after ${budget.maxMinutes} min (maxMinutes)` : `timeout after ${Math.round(limitMs / 1000)}s`;
      } else if (/budget/i.test(String(final?.subtype ?? '')) || (budget?.maxUsd && cost != null && cost > budget.maxUsd)) {
        status = 'failed';
        budgetExceeded = true;
        error = `budget: cost ${cost ?? '?'} USD is over maxUsd ${budget?.maxUsd ?? maxUsd}`;
      } else if (exitCode !== 0 || !final || final.is_error) {
        status = 'failed';
        error = clip(redact(final?.is_error ? String(final.result ?? final.subtype) : (stderrTail.trim() || lastText || `exit code ${exitCode}`)), ERROR_TAIL).slice(-ERROR_TAIL);
      } else if (entry.gate === 'write' && denied.length) {
        status = 'waiting_approval'; // the read phase wanted to write: nothing was written, ask first (AC 9)
      }
      if (final?.result && (status === 'done' || status === 'waiting_approval')) {
        try { fs.writeFileSync(path.join(dir, 'result.md'), `${redact(String(final.result)).trimEnd()}\n`); } catch { /* best effort */ }
      }
      appendLog(project, id, dir, { kind: 'status', text: status === 'done' ? 'finished' : status === 'waiting_approval' ? `waiting for approval: wanted ${[...new Set(denied.map((d) => d.tool))].join(', ')}` : `${status}${error ? `: ${error}` : ''}` });
      const meta = setStatus(project, id, dir, {
        status, exitCode, error, finished: status === 'waiting_approval' ? null : localTimestamp(now()),
        cost, turns: final?.num_turns ?? null, sessionId: final?.session_id ?? readMeta(dir).sessionId,
        denials: denied.length, ...(entry.gate !== undefined && meta0.agent ? { denied, budgetExceeded } : {}),
      });
      onEvent({ type: 'activity', project: project.key, event: { ts: meta.finished ?? localTimestamp(now()), type: status === 'waiting_approval' ? 'job.waiting' : 'job.finished', ref: id, by: 'agent', detail: `${entry.label ?? skill} ${status}` } });
      if (status !== 'waiting_approval') settleCard(entry, status);
    });
    return meta0;
  }

  function stop(project, id) {
    dirOf(project, id); // validates the id
    const state = active.get(`${project.key}/${id}`);
    if (!state) throw new JobError('not_found', `job is not running: ${id}`);
    state.stopRequested = true;
    state.handle.stop();
    return { id, stopping: true };
  }

  function stopAll() {
    for (const s of active.values()) { s.stopRequested = true; s.handle.stop(); }
  }

  return { start, startCommand, resume, close, stop, stopAll, list, show, log, activeCount: () => active.size, isActive: (project, id) => active.has(`${project.key}/${id}`) };
}
