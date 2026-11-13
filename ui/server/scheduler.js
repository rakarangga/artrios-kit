// Scheduler core (PRD AIOS-61 v2.1 S2, S2a, S3, §11). A library: the process around it is scheduler-main.js.
// It runs schedules (schedules/<id>.md): a command, or an agent profile (agents/<id>.md) with a skill or prompt.
// One tick does everything, so a test can drive it with a fake clock:
//   1. schedules that fell since the last tick run now when they are fresh (within graceMs), otherwise they become
//      one missed_run item each (never chased automatically; also covers a PC that slept);
//   2. run requests from the UI (requests/*.json) start;
//   3. decided inbox items for the scheduler are applied (run now / skip, approve / revise / reject, rerun / close);
//   4. expired approvals close their job as expired; the heartbeat file is written.
// Files under <dataDir>/scheduler/: state.json (last tick, last run per schedule), heartbeat.json, requests/.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseCron, fireTimes, nextFire } from './cron.js';
import { atomicWrite } from './lock.js';
import { localTimestamp } from './task-service.js';
import { JobError, redact, pidAlive } from './job-runner.js';
import { splitCommand } from './schedules.js';

export const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite'];
export const MISSED_OPTIONS = ['jalankan sekarang', 'lewati'];
export const APPROVAL_OPTIONS = ['setuju', 'revisi', 'tolak'];
export const BUDGET_OPTIONS = ['jalankan ulang', 'tutup'];
// A schedule without an agent runs as this profile: read tools only, report only.
export const DEFAULT_AGENT = { id: 'bawaan', name: 'Agen bawaan', approval: 'report-only', allowedTools: READ_ONLY_TOOLS, budget: { maxUsd: null, maxMinutes: null }, model: null, instructions: '' };
const MAX_MISSED_PER_TICK = 20;
const RECENT = 40;

const pad = (n) => String(n).padStart(2, '0');
export const minuteStamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n)} ...` : String(s));

// report-only keeps only tools that cannot write (§11: "report-only tidak menulis di luar .artrios/").
export const readOnly = (tools) => tools.filter((t) => READ_ONLY_TOOLS.includes(t));

export function schedulerFiles(dir) {
  return { dir, state: path.join(dir, 'state.json'), heartbeat: path.join(dir, 'heartbeat.json'), requests: path.join(dir, 'requests') };
}

export function readHeartbeat(dir, { now = () => new Date(), staleMs = 90000 } = {}) {
  try {
    const hb = JSON.parse(fs.readFileSync(schedulerFiles(dir).heartbeat, 'utf8'));
    const age = now().getTime() - new Date(hb.ts).getTime();
    return { ...hb, ageMs: age, alive: !hb.stopped && age < staleMs && (hb.pid ? pidAlive(hb.pid) : true) };
  } catch {
    return { alive: false, ts: null };
  }
}

// The UI asks the scheduler to run a schedule: one small file per request, picked up at once (watch) or next tick.
export function requestRun(dir, scheduleId, by = 'ui') {
  const f = schedulerFiles(dir);
  fs.mkdirSync(f.requests, { recursive: true });
  const name = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}.json`;
  atomicWrite(path.join(f.requests, name), JSON.stringify({ type: 'run', schedule: scheduleId, by, ts: new Date().toISOString() }));
  return { queued: name };
}

// Profile instructions first (the role), then the schedule's own prompt (the task).
export const joinPrompt = (agent, s) => [agent.instructions?.trim() && `## Peran agen\n\n${agent.instructions.trim()}`, s.prompt?.trim()].filter(Boolean).join('\n\n');

export function createScheduler({ dir, schedules, agents, locate, allLocations, jobs, inbox, now = () => new Date(), graceMs = 120000, log = () => {} }) {
  const files = schedulerFiles(dir);
  fs.mkdirSync(files.requests, { recursive: true });
  const started = now();
  const recent = [];
  const seenErrors = new Set();
  let state = { lastTick: null, schedules: {} };
  try { state = { ...state, ...JSON.parse(fs.readFileSync(files.state, 'utf8')) }; state.schedules ??= {}; } catch { /* first start */ }

  const note = (sched, text, extra = {}) => {
    const e = { ts: localTimestamp(now()), schedule: sched, text: redact(text), ...extra };
    recent.unshift(e);
    recent.length = Math.min(recent.length, RECENT);
    log(`${sched ?? '-'}: ${e.text}`);
    return e;
  };
  const saveState = () => atomicWrite(files.state, `${JSON.stringify(state, null, 2)}\n`);

  // Refuses to run beside another live scheduler of the same instance (two would run every job twice).
  function claim() {
    const hb = readHeartbeat(dir, { now });
    if (hb.alive && hb.pid && hb.pid !== process.pid) throw new Error(`another scheduler (pid ${hb.pid}) is running for this instance`);
  }

  function lastMeta(id) {
    const last = state.schedules[id];
    if (!last?.jobId) return null;
    const loc = locate(last.location);
    if (!loc) return null;
    try { return jobs.show(loc, last.jobId).meta; } catch { return null; }
  }
  // A run that waits for approval also counts: a new one would pile up behind the same question.
  const busyNow = (id) => ['running', 'queued', 'waiting_approval'].includes(lastMeta(id)?.status);

  function profileOf(s) {
    if (!s.agent) return DEFAULT_AGENT;
    return agents.get(s.agent); // throws not_found / invalid with a plain message
  }

  // Starts one run of a schedule. Returns { jobId } or { error, busy }.
  function runSchedule(s, { reason, by = 'scheduler' }) {
    const loc = locate(s.location);
    if (!loc) { note(s.id, `not run (${reason}): location "${s.location}" is not registered`); return { error: `lokasi ${s.location} tidak terdaftar` }; }
    if (busyNow(s.id)) { note(s.id, `not run (${reason}): the previous run is still going or waits for approval`); return { error: 'run sebelumnya belum selesai', busy: true }; }
    try {
      let meta;
      let agent = null;
      if (s.type === 'command') {
        meta = jobs.startCommand(loc, { argv: splitCommand(s.command), timeoutSec: s.timeout, exitWarn: s.exitWarn, schedule: s.id, by });
      } else {
        agent = profileOf(s);
        const gate = agent.approval === 'ask-before-write' ? 'write' : agent.approval === 'ask-before-run' ? 'run' : null;
        const allowedTools = agent.approval === 'report-only' ? readOnly(agent.allowedTools) : agent.allowedTools;
        meta = jobs.start(loc, {
          skill: s.skill, args: s.args, agent: agent.id, schedule: s.id, allowedTools, phaseTools: gate === 'write' ? readOnly(agent.allowedTools) : null,
          instructions: joinPrompt(agent, s), budget: agent.budget, gate, role: 'agent', by, model: agent.model, provider: agent.engine,
        });
        if (gate === 'run') askApproval(s, agent, loc, meta, 'before');
      }
      state.schedules[s.id] = { jobId: meta.id, location: s.location, at: meta.started, reason };
      saveState();
      note(s.id, `started ${meta.id} (${reason})`, { jobId: meta.id });
      return { jobId: meta.id };
    } catch (e) {
      note(s.id, `not run (${reason}): ${e.message}`);
      return { error: e.message, busy: e instanceof JobError && e.code === 'busy' };
    }
  }

  function fileMissed(s, at, why) {
    const r = inbox.createOnce({
      kind: 'missed_run', from: 'scheduler', agent: s.agent, workspace: 'jadwal', subject: s.id, topic: minuteStamp(at),
      question: `Jadwal "${s.name}" (${s.schedule}) pada ${minuteStamp(at).replace('T', ' ')} tidak dijalankan: ${why}. Jalankan sekarang?`,
      options: MISSED_OPTIONS, links: [], meta: { type: 'Jadwal terlewat', title: s.name, related: s.location },
    });
    if (r.result === 'created') note(s.id, `missed ${minuteStamp(at)}: ${why}`, { item: r.item.id });
  }

  function askApproval(s, agent, loc, meta, phase) {
    const wanted = [...new Set((meta.denied ?? []).map((d) => d.tool))];
    const detail = (meta.denied ?? []).slice(0, 5).map((d) => `${d.tool} ${d.input}`).join('; ');
    const who = agent?.name ?? meta.agent;
    const question = phase === 'before'
      ? `Agen ${who} minta izin untuk mulai jadwal "${s?.name ?? meta.schedule}" (${loc.name ?? loc.key}). Jalankan?`
      : `Agen ${who} (jadwal "${s?.name ?? meta.schedule}") ingin menulis: ${wanted.join(', ')}. ${detail ? `Rinciannya: ${detail}. ` : ''}Belum ada yang ditulis. Izinkan?`;
    inbox.create({
      kind: 'approval_request', from: `agent:${meta.agent}`, agent: meta.agent, jobId: meta.id,
      question: clip(redact(question), 1500), options: APPROVAL_OPTIONS, links: [`.artrios/jobs/${meta.id}/result.md`],
      meta: { type: 'Izin agen', title: s?.name ?? who, related: loc.name ?? loc.key },
    });
    note(meta.schedule ?? null, `${meta.id} waits for approval (${phase === 'before' ? 'before run' : `wants ${wanted.join(', ')}`})`, { jobId: meta.id });
  }

  const scheduleOf = (id) => { try { return schedules.get(id); } catch { return null; } };
  const agentOf = (id) => { if (!id || id === DEFAULT_AGENT.id) return DEFAULT_AGENT; try { return agents.get(id); } catch { return null; } };

  // Called by the process for every job event of its runner.
  function onJobEvent(e) {
    if (e.type !== 'job.status' || !e.meta?.schedule) return;
    const m = e.meta;
    const loc = allLocations().find((l) => l.key === e.project);
    if (!loc) return;
    const s = scheduleOf(m.schedule);
    if (m.status === 'waiting_approval' && m.phase !== 'before-run') askApproval(s, agentOf(m.agent), loc, m, 'write');
    else if (m.status === 'failed' && m.budgetExceeded) {
      inbox.create({
        kind: 'approval_request', from: `agent:${m.agent}`, agent: m.agent, jobId: m.id,
        question: clip(redact(`Jadwal "${s?.name ?? m.schedule}" dihentikan karena melewati budget (${m.error}). Jalankan ulang?`), 1500),
        options: BUDGET_OPTIONS, links: [`.artrios/jobs/${m.id}/log.jsonl`], meta: { type: 'Budget terlewati', title: s?.name ?? m.schedule, related: loc.name ?? loc.key },
      });
      note(m.schedule, `${m.id} stopped: ${m.error}`, { jobId: m.id });
    } else if (['done', 'failed', 'stopped'].includes(m.status)) {
      note(m.schedule, `${m.id} ${m.warning ? 'selesai dengan peringatan' : m.status}${m.error ? `: ${clip(m.error, 200)}` : ''}`, { jobId: m.id });
    }
  }

  function locationOfJob(jobId) {
    for (const l of allLocations()) if (fs.existsSync(path.join(l.path, '.artrios', 'jobs', jobId))) return l;
    return null;
  }

  function applyDecisions() {
    const mine = inbox.list({ status: 'decided' }).filter((i) => !i.applied && (i.kind === 'missed_run' || (i.kind === 'approval_request' && i.from?.startsWith('agent:'))));
    for (const it of mine) {
      let result;
      try {
        const rerun = it.options.includes('jalankan ulang');
        if (it.kind === 'missed_run' || rerun) {
          if (it.decision === 'lewati' || it.decision === 'tutup') result = 'skipped';
          else {
            let sid = it.subject;
            if (rerun) { const loc = locationOfJob(it.jobId); sid = loc ? jobs.show(loc, it.jobId).meta.schedule : null; }
            const s = sid ? scheduleOf(sid) : null;
            if (!s) result = 'failed: jadwal tidak ditemukan';
            else {
              const r = runSchedule(s, { reason: it.kind === 'missed_run' ? `missed ${it.topic}` : `rerun after ${it.jobId}`, by: 'ui' });
              if (r.busy) continue; // slots full or still running: try again on the next tick
              result = r.jobId ? `started ${r.jobId}` : `failed: ${r.error}`;
            }
          }
        } else {
          const loc = locationOfJob(it.jobId);
          if (!loc) result = 'failed: job not found';
          else {
            const meta = jobs.show(loc, it.jobId).meta;
            if (meta.status !== 'waiting_approval') result = `ignored: job is ${meta.status}`;
            else if (it.decision === 'tolak') { jobs.close(loc, it.jobId, 'rejected', it.note); result = 'rejected'; }
            else {
              try { jobs.resume(loc, it.jobId, { action: it.decision === 'revisi' ? 'revise' : 'approve', note: it.note }); }
              catch (e) { if (e instanceof JobError && e.code === 'busy') continue; throw e; }
              result = it.decision === 'revisi' ? 'revising' : 'continued';
              note(meta.schedule ?? null, `${it.jobId} ${result}`, { jobId: it.jobId });
            }
          }
        }
      } catch (e) {
        result = `failed: ${e.message}`;
      }
      inbox.markApplied(it.id, { by: 'scheduler', result: clip(result, 200) });
    }
  }

  function closeExpired() {
    inbox.expire();
    for (const it of inbox.list({ status: 'expired', kind: 'approval_request' })) {
      if (!it.jobId || !it.from?.startsWith('agent:')) continue;
      const loc = locationOfJob(it.jobId);
      if (!loc) continue;
      try {
        const m = jobs.show(loc, it.jobId).meta;
        if (m.status === 'waiting_approval') {
          jobs.close(loc, it.jobId, 'expired', `no answer by ${it.expires}`);
          note(m.schedule ?? null, `${it.jobId} expired without running`, { jobId: it.jobId });
        }
      } catch { /* job gone */ }
    }
  }

  function takeRequests(byId) {
    let names = [];
    try { names = fs.readdirSync(files.requests).filter((n) => n.endsWith('.json')).sort(); } catch { return; }
    for (const n of names) {
      const file = path.join(files.requests, n);
      let req = null;
      try { req = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* broken request: dropped below */ }
      try { fs.unlinkSync(file); } catch { continue; } // another tick took it
      if (req?.type !== 'run') continue;
      const s = byId.get(req.schedule);
      if (!s) { note(req.schedule ?? null, 'run request for an unknown or broken schedule'); continue; }
      runSchedule(s, { reason: 'jalankan sekarang', by: req.by ?? 'ui' });
    }
  }

  function heartbeat(list, errors, t) {
    const next = {};
    for (const s of list) if (s.enabled) { const n = nextFire(parseCron(s.schedule), t); next[s.id] = n ? n.toISOString() : null; }
    const hb = { pid: process.pid, ts: t.toISOString(), started: started.toISOString(), schedules: list.length, enabled: list.filter((s) => s.enabled).length, errors, next, last: state.schedules, recent, running: jobs.activeCount() };
    atomicWrite(files.heartbeat, `${JSON.stringify(hb, null, 2)}\n`);
    return hb;
  }

  function tick() {
    const t = now();
    const { schedules: list, errors: sErr } = schedules.list();
    const { errors: aErr } = agents.list();
    const errors = [...sErr.map((e) => ({ ...e, kind: 'schedule' })), ...aErr.map((e) => ({ ...e, kind: 'agent' }))];
    for (const e of errors) {
      const k = `${e.kind}:${e.file}:${e.error}`;
      if (!seenErrors.has(k)) { seenErrors.add(k); note(null, `${e.kind} ${e.file} skipped: ${e.error}`); }
    }
    const byId = new Map(list.map((s) => [s.id, s]));
    const last = state.lastTick ? new Date(state.lastTick) : null;
    if (last && last < t) {
      for (const s of list) {
        if (!s.enabled) continue;
        const fires = fireTimes(parseCron(s.schedule), last, t);
        const late = fires.filter((f) => t - f > graceMs);
        const fresh = fires.filter((f) => t - f <= graceMs);
        for (const f of late.slice(-MAX_MISSED_PER_TICK)) fileMissed(s, f, 'scheduler tidak menyala saat itu');
        if (late.length > MAX_MISSED_PER_TICK) note(s.id, `${late.length - MAX_MISSED_PER_TICK} older missed runs not filed`);
        if (fresh.length) {
          const r = runSchedule(s, { reason: `jadwal ${minuteStamp(fresh[fresh.length - 1])}` });
          if (r.error && !r.jobId) fileMissed(s, fresh[fresh.length - 1], r.error);
        }
      }
    }
    state.lastTick = t.toISOString();
    saveState();
    takeRequests(byId);
    applyDecisions();
    closeExpired();
    return heartbeat(list, errors, t);
  }

  function stop() {
    try {
      const hb = JSON.parse(fs.readFileSync(files.heartbeat, 'utf8'));
      atomicWrite(files.heartbeat, `${JSON.stringify({ ...hb, ts: now().toISOString(), stopped: true }, null, 2)}\n`);
    } catch { /* never ticked */ }
  }

  return { claim, tick, onJobEvent, runSchedule, stop, recent: () => recent, requestsDir: files.requests };
}
