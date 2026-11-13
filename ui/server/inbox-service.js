// Inbox service: the single writer of the approval queue (PRD AIOS-61 section 7, AIOS-95).
// Pure library: no HTTP, no globals. Append-only JSONL; item status is derived from the last event.
import fs from 'node:fs';
import path from 'node:path';
import { withLock } from './lock.js';
import { localTimestamp } from './task-service.js';

// missed_run: a schedule that fell while the scheduler was off (PRD AIOS-61 v2.0 S2a); like putusan it never expires.
export const DEFAULT_TO = 'administrator'; // the single account (server/auth.js USER); an instance can address items elsewhere with `to`
export const INBOX_KINDS = ['putusan', 'approval_request', 'missed_run'];
export const APPROVAL_DEFAULT_DAYS = 7; // PRD section 13, assumption 5; putusan never expires
export const STALE_DAYS = 3; // PRD AC 12

export class InboxError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // invalid | not_found | closed | forbidden | broken
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^q-(\d{8})-(\d{4})$/;
const pad = (n) => String(n).padStart(2, '0');
const dateOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function text(name, v) {
  const s = String(v ?? '').trim();
  if (!s) throw new InboxError('invalid', `${name} must not be empty`);
  return s;
}

function strList(name, v, { min = 0 } = {}) {
  if (!Array.isArray(v) || v.length < min || v.some((x) => typeof x !== 'string' || !x.trim())) {
    throw new InboxError('invalid', `${name} must be a list of ${min ? 'at least ' + min : ''} non-empty strings`);
  }
  return v.map((x) => x.trim());
}

// Shared schema (putusan and approval_request): validates one stored event.
export function validateEvent(e) {
  if (!e || typeof e !== 'object') throw new InboxError('broken', 'event is not an object');
  if (!ID_RE.test(e.id ?? '')) throw new InboxError('broken', `bad id: ${e.id}`);
  if (!['created', 'decided', 'applied', 'expired', 'reasked'].includes(e.ev)) throw new InboxError('broken', `bad ev: ${e.ev}`);
  if (e.ev === 'created') {
    if (!INBOX_KINDS.includes(e.kind)) throw new InboxError('broken', `bad kind: ${e.kind}`);
    if (!Array.isArray(e.options) || e.options.length < 1) throw new InboxError('broken', 'created needs options');
  }
  return e;
}

export function createInboxService({ file, emit = () => {}, now = () => new Date() }) {
  if (!file) throw new Error('file is required');
  const target = path.resolve(file);
  const dir = path.dirname(target);

  function readEvents() {
    let raw;
    try {
      raw = fs.readFileSync(target, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
    const events = [];
    raw.split('\n').forEach((line, i) => {
      if (!line.trim()) return;
      try {
        events.push(validateEvent(JSON.parse(line)));
      } catch (e) {
        throw new InboxError('broken', `${target} line ${i + 1}: ${e.message}`);
      }
    });
    return events;
  }

  function fold(events) {
    const items = new Map();
    for (const e of events) {
      if (e.ev === 'created') {
        const { ev, ...rest } = e;
        items.set(e.id, { ...rest, status: 'pending', decision: null, note: '', decidedBy: null, decidedAt: null, applied: null });
        continue;
      }
      const it = items.get(e.id);
      if (!it) continue;
      if (e.ev === 'decided') Object.assign(it, { status: 'decided', decision: e.decision, note: e.note ?? '', decidedBy: e.by, decidedAt: e.ts });
      else if (e.ev === 'expired') it.status = 'expired';
      else if (e.ev === 'applied') it.applied = { by: e.by, result: e.result, ts: e.ts };
      else if (e.ev === 'reasked') {
        // Same case asked again (PRD Cognition §11): count it, remember the last session, keep earlier wordings.
        it.reasked = (it.reasked ?? 0) + 1;
        it.lastSession = e.session ?? it.lastSession ?? null;
        it.lastAsked = e.ts;
        if (e.question && e.question !== it.question) {
          it.versions = [...(it.versions ?? []), { question: it.question, ts: it.lastQuestionTs ?? it.ts }];
          it.question = e.question;
          it.lastQuestionTs = e.ts;
        }
      }
    }
    return items;
  }

  const append = (e) => {
    fs.appendFileSync(target, `${JSON.stringify(e)}\n`, 'utf8');
    emit({ type: 'inbox', ...e });
    return e;
  };

  // Case key fields (PRD Cognition §7, §11): workspace + subject + topic, each one path-free segment.
  function caseFields(input) {
    const seg = (name, v) => {
      const s = String(v ?? '').trim();
      if (!s || s.length > 80 || s.includes('/')) throw new InboxError('invalid', `${name} must be 1-80 characters without "/"`);
      return s;
    };
    if (input.workspace == null && input.subject == null && input.topic == null) return null;
    const workspace = seg('workspace', input.workspace);
    const subject = seg('subject', input.subject);
    const topic = seg('topic', input.topic);
    const opt = (name, v, n) => (v == null || v === '' ? null : String(v).trim().slice(0, n));
    return { key: `${workspace}/${subject}/${topic}`, workspace, subject, topic, why: opt('why', input.why, 600), session: opt('session', input.session, 80), supersedes: opt('supersedes', input.supersedes, 40) };
  }

  function create(input) {
    return withLock(dir, () => createLocked(input, readEvents()));
  }

  // Ask once per case (AC 7-8): an open item with the same key is re-asked, not duplicated; a decided key returns the
  // old answer unless the caller says the context changed, and then the new item links the old one (supersedes).
  function ask(input) {
    if ((input.kind ?? 'putusan') !== 'putusan') throw new InboxError('invalid', 'ask is for putusan items');
    const c = caseFields(input);
    if (!c) throw new InboxError('invalid', 'ask needs workspace, subject, and topic');
    return withLock(dir, () => {
      const events = readEvents();
      const same = [...fold(events).values()].filter((i) => i.key === c.key && i.kind === 'putusan');
      const open = same.find((i) => i.status === 'pending');
      if (open) {
        const q = String(input.question ?? '').trim();
        append({ ev: 'reasked', id: open.id, session: c.session, ...(q && q !== open.question ? { question: q } : {}), ts: localTimestamp(now()) });
        return { result: 'reasked', item: fold(readEvents()).get(open.id) };
      }
      const decided = same.filter((i) => i.status === 'decided').sort((a, b) => b.id.localeCompare(a.id))[0];
      if (decided && !input.contextChanged) return { result: 'decided', item: decided };
      const created = createLocked({ ...input, kind: 'putusan', supersedes: decided?.id ?? null }, events);
      return { result: 'created', item: fold(readEvents()).get(created.id) };
    });
  }

  function createLocked(input, events) {
    const kind = input.kind;
    if (!INBOX_KINDS.includes(kind)) throw new InboxError('invalid', `kind must be one of ${INBOX_KINDS.join(', ')}`);
    const from = text('from', input.from);
    if (!/^(claude|skrip|scheduler|agent:[\w-]+)$/.test(from)) throw new InboxError('invalid', `bad from: ${from}`);
    const question = text('question', input.question);
    const options = strList('options', input.options, { min: 1 });
    const links = strList('links', input.links ?? []);
    const to = strList('to', input.to ?? [DEFAULT_TO], { min: 1 });
    // Optional display data for the list: { title, description, related, suggestion } (strings only, kept short).
    let meta = null;
    if (input.meta != null) {
      if (typeof input.meta !== 'object' || Array.isArray(input.meta)) throw new InboxError('invalid', 'meta must be an object');
      meta = {};
      for (const k of ['type', 'title', 'description', 'related', 'suggestion', 'outcome']) {
        if (input.meta[k] == null) continue;
        if (typeof input.meta[k] !== 'string') throw new InboxError('invalid', `meta.${k} must be a string`);
        meta[k] = input.meta[k].trim().slice(0, 600);
      }
    }
    const jobId = input.jobId ?? null;
    const agent = input.agent ?? null;
    if (kind === 'approval_request' && !jobId && !agent) throw new InboxError('invalid', 'approval_request needs jobId or agent');
    if (kind === 'missed_run' && !input.subject) throw new InboxError('invalid', 'missed_run needs its schedule as subject');
    if (kind === 'missed_run' && input.expires != null) throw new InboxError('invalid', 'missed_run never expires');
    const t = now();
    let expires = input.expires ?? null;
    if (expires === null && kind === 'approval_request') {
      const d = new Date(t);
      d.setDate(d.getDate() + APPROVAL_DEFAULT_DAYS);
      expires = dateOf(d);
    }
    if (expires !== null && !DATE_RE.test(expires)) throw new InboxError('invalid', `expires must be YYYY-MM-DD (got ${expires})`);
    const c = caseFields(input);
    const day = dateOf(t).replaceAll('-', '');
    const n = events.filter((e) => e.ev === 'created' && e.id.startsWith(`q-${day}-`)).length + 1;
    const id = `q-${day}-${String(n).padStart(4, '0')}`;
    return append({ ev: 'created', id, kind, from, question, options, links, ...(meta ? { meta } : {}), ...(c ?? {}), jobId, agent, to, expires, ts: localTimestamp(t) });
  }

  function decide(id, { by, decision, note = '', role = 'admin' }) {
    return withLock(dir, () => {
      const item = fold(readEvents()).get(id);
      if (!item) throw new InboxError('not_found', `no item ${id}`);
      if (item.status !== 'pending') throw new InboxError('closed', `${id} is already ${item.status}`);
      const who = text('by', by);
      if (role === 'viewer') throw new InboxError('forbidden', 'viewer cannot decide');
      if (role === 'operator' && !item.to.includes(who)) throw new InboxError('forbidden', `${id} is not addressed to ${who}`);
      if (!item.options.includes(decision)) throw new InboxError('invalid', `decision must be one of ${item.options.join(', ')}`);
      return append({ ev: 'decided', id, by: who, decision, note: String(note ?? ''), ts: localTimestamp(now()) });
    });
  }

  function markApplied(id, { by, result = 'ok' }) {
    return withLock(dir, () => {
      const item = fold(readEvents()).get(id);
      if (!item) throw new InboxError('not_found', `no item ${id}`);
      if (item.status !== 'decided') throw new InboxError('closed', `${id} is ${item.status}, not decided`);
      if (item.applied) throw new InboxError('closed', `${id} is already applied`);
      return append({ ev: 'applied', id, by: text('by', by), result: text('result', result), ts: localTimestamp(now()) });
    });
  }

  // Closes pending items whose expires date has passed. Never runs anything; putusan has no expires.
  function expire() {
    const today = dateOf(now());
    return withLock(dir, () => {
      const out = [];
      for (const it of fold(readEvents()).values()) {
        if (it.status === 'pending' && it.expires && it.expires < today) {
          out.push(append({ ev: 'expired', id: it.id, ts: localTimestamp(now()) }));
        }
      }
      return out;
    });
  }

  function list({ status, kind, to } = {}) {
    return [...fold(readEvents()).values()]
      .filter((i) => (!status || i.status === status) && (!kind || i.kind === kind) && (!to || i.to.includes(to)))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  const get = (id) => fold(readEvents()).get(id) ?? null;
  // Items with this case key, any status (the scheduler uses it so a missed run is never filed twice, AC 8).
  const byKey = (key) => [...fold(readEvents()).values()].filter((i) => i.key === key);
  // Create unless an item with the same key exists; one lock for check and write, so two writers cannot both file it.
  function createOnce(input) {
    const c = caseFields(input);
    if (!c) throw new InboxError('invalid', 'createOnce needs workspace, subject, and topic');
    return withLock(dir, () => {
      const events = readEvents();
      const found = [...fold(events).values()].find((i) => i.key === c.key);
      if (found) return { result: 'exists', item: found };
      const e = createLocked(input, events);
      return { result: 'created', item: fold(readEvents()).get(e.id) };
    });
  }
  const pendingCount = (filter = {}) => list({ ...filter, status: 'pending' }).length;

  // Pending items older than `days` (AC 12, read by artrios-health).
  function stale(days = STALE_DAYS) {
    const limit = now().getTime() - days * 86400000;
    return list({ status: 'pending' }).filter((i) => new Date(i.ts).getTime() < limit);
  }

  return { create, createOnce, ask, decide, markApplied, expire, list, get, byKey, pendingCount, stale };
}
