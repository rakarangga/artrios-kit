// Schedules (PRD AIOS-61 v2.1 S2, S3): one screen for routines and agent jobs.
// One Markdown file per schedule, schedules/<id>.md. Two kinds:
//   agent   - calls an agent profile (agents/<id>.md) with a skill and/or a prompt (the body);
//   command - a fixed program run without a shell (the old routines: backup, health, digest).
// Both run at `location`: "artrios" (the Artrios home folder, the default) or a registered workspace key.
import { parseCron, CronError } from './cron.js';
import { AgentError, checkLocation, createMdStore, q } from './agents.js';

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SKILL_RE = /^\/?([a-z0-9][a-z0-9-]{0,63})(?:\s+([\s\S]*))?$/;

// Splits a command line into argv: spaces separate, "double quotes" group, no shell features at all.
export function splitCommand(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  let has = false;
  for (const ch of String(line ?? '').trim()) {
    if (ch === '"') { quoted = !quoted; has = true; continue; }
    if (!quoted && /\s/.test(ch)) { if (has) { out.push(cur); cur = ''; has = false; } continue; }
    cur += ch;
    has = true;
  }
  if (quoted) throw new AgentError('invalid', 'command has an unclosed quote');
  if (has) out.push(cur);
  return out;
}

export function validateSchedule(meta, body = '', { id: fileId } = {}) {
  const bad = (msg) => { throw new AgentError('invalid', msg); };
  const id = String(meta.id ?? fileId ?? '');
  if (!ID_RE.test(id)) bad(`id must be lowercase letters, digits, and dashes (got "${id}")`);
  if (fileId && id !== fileId) bad(`id "${id}" does not match the file name "${fileId}.md"`);
  let cron;
  try { cron = parseCron(meta.schedule); } catch (e) { bad(e instanceof CronError ? e.message : `bad schedule: ${e.message}`); }
  if (meta.enabled != null && typeof meta.enabled !== 'boolean') bad('enabled must be true or false');
  const command = meta.command ? String(meta.command).trim() : '';
  const type = command ? 'command' : 'agent';
  if (meta.type != null && meta.type !== type) bad(meta.type === 'command' ? 'a command schedule needs a command' : `type must be agent or command (got ${meta.type})`);
  let skill = null;
  let args = '';
  if (meta.skill != null && meta.skill !== '') {
    if (type === 'command') bad('a command schedule has no skill');
    const s = SKILL_RE.exec(String(meta.skill).trim());
    if (!s) bad(`skill must be a skill name, optionally with arguments (got "${meta.skill}")`);
    skill = s[1];
    args = (s[2] ?? '').trim();
  }
  const prompt = body.trim();
  if (type === 'agent' && !skill && !prompt) bad('an agent schedule needs a skill or a prompt');
  if (type === 'command') {
    const argv = splitCommand(command);
    if (!argv.length) bad('command is empty');
    if (argv.some((a) => /^(\|\|?|&&?|;|>>?|<|2>&1|1>&2)$/.test(a))) bad('command runs without a shell: no pipes, redirects, or ";"');
  }
  const agent = meta.agent ? String(meta.agent) : null;
  if (agent && !ID_RE.test(agent)) bad(`bad agent id: ${agent}`);
  if (type === 'command' && agent) bad('a command schedule does not call an agent');
  const timeout = meta.timeout == null || meta.timeout === '' ? null : Number(meta.timeout);
  if (timeout !== null && !(timeout > 0 && timeout <= 24 * 3600)) bad('timeout must be seconds, above 0');
  const exitWarn = meta.exitWarn ?? [];
  if (!Array.isArray(exitWarn) || exitWarn.some((n) => !Number.isInteger(n) || n <= 0 || n > 255)) bad('exitWarn must be a list of exit codes, e.g. [1]');
  return {
    id, name: meta.name ? String(meta.name).slice(0, 80) : id, description: meta.description ? String(meta.description).slice(0, 300) : '',
    enabled: meta.enabled !== false, schedule: cron.expr, type, location: checkLocation(meta.location, bad),
    agent, skill, args, prompt, command: command || null, timeout, exitWarn, output: meta.output ? String(meta.output).slice(0, 200) : '', schema: 1,
  };
}

export function renderSchedule(s) {
  const lines = ['---', `id: ${s.id}`, `name: ${JSON.stringify(s.name ?? s.id)}`];
  if (s.description) lines.push(`description: ${JSON.stringify(s.description)}`);
  lines.push(`enabled: ${s.enabled !== false}`, `schedule: "${s.schedule}"`, `location: ${q(s.location)}`);
  if (s.type === 'command') {
    lines.push(`command: ${JSON.stringify(s.command)}`);
    if (s.timeout) lines.push(`timeout: ${s.timeout}`);
    if (s.exitWarn?.length) lines.push(`exitWarn: [${s.exitWarn.join(', ')}]`);
  } else {
    if (s.agent) lines.push(`agent: ${s.agent}`);
    if (s.skill) lines.push(`skill: ${JSON.stringify(`/${s.skill}${s.args ? ` ${s.args}` : ''}`)}`);
  }
  if (s.output) lines.push(`output: ${JSON.stringify(s.output)}`);
  lines.push('schema: 1', '---', '', s.type === 'command' ? '' : (s.prompt ?? ''), '');
  return lines.join('\n');
}

export function createScheduleService({ dir }) {
  const s = createMdStore({
    dir,
    kind: 'schedule',
    render: renderSchedule,
    // The UI sends skill and args apart; the file keeps them together.
    // The type follows from the command field, so switching kinds is just setting or clearing the command.
    validate: (meta, body, opts) => validateSchedule({ ...meta, type: undefined, skill: meta.skill ? `${meta.skill}${meta.args ? ` ${meta.args}` : ''}` : meta.skill, args: undefined }, body, opts),
  });
  return { ...s, list: () => { const r = s.list(); return { schedules: r.items, errors: r.errors }; }, setEnabled: (id, on) => s.update(id, { enabled: on === true }) };
}
