// Chat service "Cognition" (PRD prd-cognition T2-T8, T19; spike AIOS-98 spike-cognition.md). Pure library: no HTTP.
// One live `claude -p` process per open chat, speaking stream-json both ways:
//   - turns go in on stdin; events come out on stdout and are passed to onEvent as { type: 'chat', id, ev, ... };
//   - tool permission and AskUserQuestion arrive as control_request "can_use_tool" (--permission-prompt-tool stdio)
//     and wait for the user's answer (answer());
//   - model and permission mode change between turns with control requests; effort restarts the process with --resume.
// Sessions live in the CLI store (~/.claude/projects/<encoded cwd>/<uuid>.jsonl), so a chat can be resumed from the CLI
// and a CLI session can be continued here (AC 1). The UI keeps only small metadata in <chatDir>/sessions.json.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { childEnv } from './child-env.js';
import { killTree } from './engine.js';
import { splitFrontmatter } from './skills.js';
import { createApiChat, transcriptText } from './chat-api.js';
import { chatCompletions } from './providers/chat-completions.js';
import { modelsOf, numOf } from './providers/config.js';

export class ChatError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // invalid | not_found | busy | conflict
  }
}

// No bypass as a choice (PRD T3, fase 1 B4). "auto" = the CLI auto mode: a classifier approves safe actions, risky
// ones still come as a card (owner request, 2026-11-10).
export const MODES = ['default', 'acceptEdits', 'auto', 'plan'];
export const DEFAULT_CONTEXT_WINDOW = 200000;
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODEL_RE = /^[A-Za-z0-9._\[\]-]{1,60}$/;
const API_MODEL_RE = /^[A-Za-z0-9._:/@\[\]-]{1,120}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_TEXT = 100000;
const MAX_ATTACH_BYTES = 10 * 1024 * 1024;
const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
// Skill buttons under the chat: these four are pinned until the user changes the pins; every other
// skill is pinned by hand from the "Pin skills" panel.
export const DEFAULT_PINNED = ['compact', 'compact-project', 'ask-me', 'clear'];
const BUILTIN = [
  { name: 'compact', description: 'Compact the conversation', builtin: true },
  { name: 'clear', description: 'New session', builtin: true },
  { name: 'model', description: 'Change model', builtin: true },
  { name: 'usage', description: 'Plan usage', builtin: true },
];

// Same rule the CLI uses for its project folders: every character that is not a letter or digit becomes "-".
export const encodeCwd = (cwd) => path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

const textOf = (content) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
};
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

// One-line summary of a tool call for the transcript (the full input is still sent to the browser).
export function toolSummary(name, input = {}) {
  const v = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.query ?? input.skill ?? input.description ?? '';
  return clip(String(v).replace(/\s+/g, ' '), 160);
}

// Turns a CLI transcript line (or a live stream event of the same shape) into display items.
export function itemsFromMessage(m) {
  const out = [];
  if (m.type === 'user' && m.message) {
    if (m.isMeta || m.isCompactSummary) return out;
    const c = m.message.content;
    if (typeof c === 'string') {
      const local = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(c);
      if (local) { if (local[1].trim()) out.push({ kind: 'system', text: clip(local[1].trim(), 2000) }); return out; }
      if (/^<(command-name|local-command-caveat)>/.test(c.trim())) {
        const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(c)?.[1];
        const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(c)?.[1];
        if (name) out.push({ kind: 'user', text: `${name}${args ? ` ${args}` : ''}` });
        return out;
      }
      if (c.trim()) out.push({ kind: 'user', text: c });
      return out;
    }
    if (Array.isArray(c)) {
      const texts = [];
      let images = 0;
      for (const b of c) {
        if (b.type === 'tool_result') {
          const t = typeof b.content === 'string' ? b.content : textOf(b.content);
          out.push({ kind: 'tool_result', toolUseId: b.tool_use_id, error: !!b.is_error, text: clip(t, 4000) });
        } else if (b.type === 'text' && !/^\[Request interrupted/.test(b.text)) texts.push(b.text);
        else if (b.type === 'text') out.push({ kind: 'system', text: 'Stopped.' });
        else if (b.type === 'image') images += 1;
      }
      if (texts.length || images) out.push({ kind: 'user', text: texts.join('\n'), images });
    }
    return out;
  }
  if (m.type === 'assistant' && m.message && Array.isArray(m.message.content)) {
    for (const b of m.message.content) {
      if (b.type === 'text' && b.text.trim()) out.push({ kind: 'assistant', text: b.text, model: m.message.model });
      else if (b.type === 'tool_use') out.push({ kind: 'tool_use', id: b.id, name: b.name, summary: toolSummary(b.name, b.input), input: b.input });
    }
  }
  return out;
}

// Reads a CLI transcript. Tolerant: unknown or broken lines are skipped (the format is not an official API).
export function readTranscript(file, { limit = 400 } = {}) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { items: [], title: null }; }
  const items = [];
  let title = null;
  let firstUser = null;
  let last = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.type === 'ai-title' && m.aiTitle) title = m.aiTitle;
    if (m.type === 'custom-title' && m.customTitle) title = m.customTitle;
    if (m.type === 'system' && m.subtype === 'compact_boundary') { items.push({ kind: 'system', text: m.note ?? 'Conversation compacted (/compact).', ...(m.summary ? { summary: m.summary } : {}) }); continue; }
    if (m.isSidechain) continue;
    if (m.type === 'assistant' && m.message?.usage) last = { usage: m.message.usage, model: m.message.model ?? null };
    for (const it of itemsFromMessage(m)) {
      if (!firstUser && it.kind === 'user' && it.text) firstUser = it.text;
      if (m.timestamp) it.ts = m.timestamp;
      items.push(it);
    }
  }
  return { items: items.slice(-limit), title: title ?? (firstUser ? clip(firstUser.replace(/\s+/g, ' '), 80) : null), truncated: items.length > limit, context: contextOf(last) };
}

// Context in use = what the last model call read: fresh input plus cache reads and writes (the CLI's own measure).
export function contextOf(last) {
  if (!last?.usage) return null;
  const u = last.usage;
  return { tokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), model: last.model };
}

// Same, from the tail of a (possibly large) transcript, for the session list.
export function tailContext(file, bytes = 256 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"assistant"') || !lines[i].includes('"usage"')) continue;
      try {
        const m = JSON.parse(lines[i]);
        if (m.type === 'assistant' && m.message?.usage && !m.isSidechain) return contextOf({ usage: m.message.usage, model: m.message.model });
      } catch { /* cut line at the start of the tail */ }
    }
    return null;
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

// Title and first prompt from the head of a transcript, without reading the whole (possibly large) file.
function peekTitle(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(96 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    let title = null;
    let first = null;
    for (const line of buf.subarray(0, n).toString('utf8').split('\n')) {
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.type === 'ai-title' && m.aiTitle) title = m.aiTitle;
      if (m.type === 'custom-title' && m.customTitle) title = m.customTitle;
      if (!first && m.type === 'user' && !m.isMeta) {
        const it = itemsFromMessage(m).find((x) => x.kind === 'user' && x.text);
        if (it) first = it.text;
      }
      if (title) break;
    }
    return title ?? (first ? clip(first.replace(/\s+/g, ' '), 80) : null);
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function readCliLines(file) {
  const out = [];
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    try { const x = JSON.parse(l); if (!x.isSidechain && !x.isMeta) out.push(x); } catch { /* skip */ }
  }
  return out;
}

// Skill names from SKILL.md folders: the workspace, extra skill dirs from config, and the user's global skills.
export function workspaceSkills(cwd, { skillDirs = [], home = os.homedir() } = {}) {
  const dirs = [path.join(cwd, '.claude', 'skills'), ...skillDirs.map((d) => path.resolve(cwd, d)), path.join(home, '.claude', 'skills')];
  const found = new Map();
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (found.has(name)) continue;
      try {
        const { meta } = splitFrontmatter(fs.readFileSync(path.join(dir, name, 'SKILL.md'), 'utf8'));
        const text = fs.readFileSync(path.join(dir, name, 'SKILL.md'), 'utf8');
        const argumentHint = meta['argument-hint'] ?? '';
        // A skill takes arguments when it says so (argument-hint) or uses $ARGUMENTS; the UI asks for them in a popup.
        found.set(name, { name, description: (meta.description ?? '').slice(0, 300), argumentHint, takesArgs: Boolean(argumentHint) || text.includes('$ARGUMENTS') });
      } catch { /* not a skill folder */ }
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Slash command usage counts from the CLI history (all projects) plus UI turns.
export function skillUsage(historyFile, extra = {}) {
  const counts = { ...extra };
  let text = '';
  try { text = fs.readFileSync(historyFile, 'utf8'); } catch { return counts; }
  for (const line of text.split('\n')) {
    const m = /"display":"\/([a-z0-9][a-z0-9:-]{0,63})/.exec(line);
    if (m) counts[m[1]] = (counts[m[1]] ?? 0) + 1;
  }
  return counts;
}

const MCP_PUTUSAN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp-putusan.js');
const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'pertanyaan';
// Appended to the system prompt of every chat (PRD T9, T10, T14, T15).
export const CHAT_RULES = [
  'You run inside the Artrios UI chat "Cognition". The user reads your replies in a browser.',
  'Decisions that can wait, or that the user should take later, go to the Putusan queue: call mcp__artrios__putusan_list first, then mcp__artrios__putusan_ask once per case (subject = task key, file, or PRD section; topic = short slug). Never ask the same open or decided case again. For a decision needed now, use AskUserQuestion.',
  'Brain pages attached by the user are context only. When you quote or use one, cite it as [title](path) and name its hat label as given.',
  'Do not write to the knowledge vault except through a skill made for it (/ingest-wiki, /remember).',
].join('\n');

export const CLAUDE_ENGINE = 'claude_cli';

// providerStore (providers/config.js) lists the API providers a chat can use (Tahap 3, T11); without it only claude.
// summarizeClaude(text, cwd) -> summary, used when a chat moves from an API provider to claude (T12).
export function createChatService({ config = {}, chatDir = null, fallbackDir = null, projects, onEvent = () => {}, home = os.homedir(), spawnImpl = spawn, idleMs = 30 * 60 * 1000, maxLive = 6, inbox = null, inboxFile = null, questionParkMs = 30 * 60 * 1000, providerStore = null, fetchImpl = fetch, coreFile = null, summarizeClaude = null, apiRetryDelayMs = 1500, modelInfo = () => null, worktrees = null }) {
  const command = config.claudePath ?? 'claude';
  const baseArgs = config.claudeBaseArgs ?? [];
  const storeRoot = path.join(home, '.claude', 'projects');
  const live = new Map(); // id -> live process state
  const emit = (id, ev, extra = {}) => onEvent({ type: 'chat', id, ev, workspace: live.get(id)?.workspace ?? extra.workspace ?? null, ...extra });

  // Cognition = the Artrios home folder only (owner decision 2026-11-10); Insights = the same chat per registered
  // workspace. config.cognitionHome = { key, name, path }; the older chatWorkspaces[0] still works.
  const homeWs = (() => {
    const h = config.cognitionHome ?? (Array.isArray(config.chatWorkspaces) ? config.chatWorkspaces[0] : null);
    return h && typeof h.key === 'string' && typeof h.path === 'string' ? { key: h.key, name: h.name ?? h.key, path: path.resolve(h.path), hat: h.hat ?? null, home: true } : null;
  })();
  // UI data per workspace (PRD §7): <workspace>/.artrios/chat/ (kept out of git through .git/info/exclude).
  // chatDir overrides it for every workspace (tests, or an install that wants one folder).
  const dirOf = (wsKey) => chatDir ?? path.join(workspace(wsKey).path, '.artrios', 'chat');
  const accountDir = chatDir ?? (homeWs ? path.join(homeWs.path, '.artrios', 'chat') : (fallbackDir ?? path.join(home, '.artrios', 'chat')));
  const metaFile = (wsKey) => path.join(dirOf(wsKey), 'sessions.json');
  const quickFile = (wsKey) => path.join(dirOf(wsKey), 'quick-actions.json');
  const uploadsDir = (wsKey) => path.join(dirOf(wsKey), 'uploads');

  const loadMeta = (wsKey) => readJson(metaFile(wsKey), { sessions: {} });
  function saveMeta(wsKey, id, patch) {
    const all = loadMeta(wsKey);
    const cur = all.sessions[id] ?? { id, created: new Date().toISOString() };
    all.sessions[id] = { ...cur, ...patch, updated: new Date().toISOString() };
    writeJson(metaFile(wsKey), all);
    return all.sessions[id];
  }
  const metaOf = (wsKey, id) => loadMeta(wsKey).sessions[id] ?? null;

  // Plan limits (last rate_limit_event of any chat) and the context window per model learned from result lines, kept
  // on disk so Usage and the session bars show data also when no chat process is running. One per account.
  const usageFile = path.join(accountDir, 'usage.json');
  const loadUsage = () => readJson(usageFile, { rate: null, rateTs: null, windows: {} });
  function saveUsage(patch) { const u = { ...loadUsage(), ...patch }; writeJson(usageFile, u); return u; }
  // A model not seen yet takes the largest window learned on this account (same plan), then config, then 200k.
  const windowOf = (model, u = loadUsage()) => (model && u.windows?.[model]) || Math.max(0, ...Object.values(u.windows ?? {})) || config.chatContextWindow || DEFAULT_CONTEXT_WINDOW;
  function statsFor(m, ctx, u = loadUsage()) {
    return {
      contextTokens: ctx?.tokens ?? null,
      contextWindow: windowOf(ctx?.model, u),
      model: ctx?.model ?? null,
      costUsd: m?.costUsd ?? null, // only turns run from the UI are priced; CLI turns have no cost in the transcript
      inputTokens: m?.inTokens ?? null,
      outputTokens: m?.outTokens ?? null,
    };
  }
  const tailCache = new Map(); // id -> { mtime, ctx }
  function cachedTail(file, id, mtime) {
    const c = tailCache.get(id);
    if (c && c.mtime === mtime) return c.ctx;
    const ctx = tailContext(file);
    tailCache.set(id, { mtime, ctx });
    return ctx;
  }
  function usage() { const u = loadUsage(); return { rate: u.rate, rateTs: u.rateTs, windows: u.windows ?? {} }; }

  // ---- engines (T11) ----
  const isApi = (m) => Boolean(m?.engine && m.engine !== CLAUDE_ENGINE);
  const apiFile = (wsKey, id) => path.join(dirOf(wsKey), `${id}.jsonl`);
  const api = createApiChat({
    live, emit: (id, ev, extra) => emit(id, ev, extra), saveMeta, metaOf, fileOf: apiFile, uploadsDir, inbox, store: providerStore,
    transports: { chat_completions: chatCompletions }, fetchImpl, coreFile, chatRules: CHAT_RULES, home, skillDirs: config.skillDirs ?? [],
    questionParkMs, toolSummary, itemsFromMessage, retryDelayMs: apiRetryDelayMs, modelInfo,
    saveWindow: (model, n) => { const w = loadUsage().windows ?? {}; if (w[model] !== n) saveUsage({ windows: { ...w, [model]: n } }); },
  });
  // What the engine picker shows: claude first, then every API provider in Settings > Model.
  function engines() {
    const out = [{ id: CLAUDE_ENGINE, label: 'Claude Code', transport: CLAUDE_ENGINE, models: [], ready: true, priced: true }];
    if (!providerStore) return { engines: out, managed: false };
    for (const [id, p] of Object.entries(providerStore.load().providers)) {
      if (p.transport === 'claude_cli' || p.transport === 'codex_cli') continue; // Codex runs jobs, not the Cognition chat (yet)
      out.push({ id, label: id, transport: p.transport, model: p.model ?? '', models: modelsOf(p), ready: !p.key_env || Boolean(providerStore.keyOf(p)), priced: numOf(p.price_in) !== null || numOf(p.price_out) !== null, contextWindow: numOf(p.context_window) });
    }
    return { engines: out, managed: true };
  }
  function checkEngine(engine) {
    if (!engine || engine === CLAUDE_ENGINE) return CLAUDE_ENGINE;
    const p = providerStore?.load().providers[engine];
    if (!p) throw new ChatError('invalid', `unknown engine: ${engine}`);
    if (p.transport === 'codex_cli') throw new ChatError('invalid', 'The Codex subscription runs skills and jobs, not this chat yet. Pick Claude Code or an API provider.');
    return p.transport === 'claude_cli' ? CLAUDE_ENGINE : engine;
  }

  // worktrees (git-service): a worktree of a workspace opens as its own chat folder under the parent (S11).
  function workspace(key) {
    const p = homeWs && homeWs.key === key ? homeWs : projects.find(key) ?? worktrees?.workspaceOf(key, projects) ?? null;
    if (!p) throw new ChatError('not_found', `unknown workspace: ${key}`);
    return p;
  }
  // home = the Cognition folder; workspaces = what Insights and "add folder" can pick from.
  function workspaces() {
    const list = (projects.all?.() ?? []).map((p) => ({ key: p.key, name: p.name ?? p.key, path: p.path, hat: p.hat ?? null }));
    let wts = [];
    try { wts = worktrees?.workspacesOf(projects) ?? []; } catch { /* git missing: no worktrees */ }
    return { home: homeWs, workspaces: list, worktrees: wts, default: homeWs?.key ?? list[0]?.key ?? null };
  }
  const transcriptFile = (cwd, id) => path.join(storeRoot, encodeCwd(cwd), `${id}.jsonl`);
  const checkId = (id) => { if (!UUID_RE.test(id ?? '')) throw new ChatError('invalid', 'bad session id'); };

  // Sessions of one workspace: every CLI transcript in its folder (sessions started in the CLI included), newest first.
  function list(wsKey, { limit = 60 } = {}) {
    const ws = workspace(wsKey);
    const dir = path.join(storeRoot, encodeCwd(ws.path));
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { /* no sessions yet */ }
    const meta = loadMeta(wsKey).sessions;
    const rows = files.map((f) => {
      const id = f.slice(0, -6);
      let st;
      try { st = fs.statSync(path.join(dir, f)); } catch { return null; }
      return { id, mtime: st.mtimeMs, size: st.size };
    }).filter(Boolean).filter((r) => UUID_RE.test(r.id) && r.size > 0);
    // UI sessions that have not written a transcript yet still show.
    for (const m of Object.values(meta)) if (m.workspace === wsKey && !rows.some((r) => r.id === m.id)) rows.push({ id: m.id, mtime: Date.parse(m.updated) || 0, size: 0 });
    rows.sort((a, b) => (meta[b.id]?.pinned ? 1 : 0) - (meta[a.id]?.pinned ? 1 : 0) || b.mtime - a.mtime);
    const u = loadUsage();
    return rows.slice(0, limit).map((r) => {
      const m = meta[r.id] ?? {};
      const l = live.get(r.id);
      const own = isApi(m) ? apiFile(wsKey, r.id) : null;
      const ctx = own ? tailContext(own) : r.size ? cachedTail(path.join(dir, `${r.id}.jsonl`), r.id, r.mtime) : null;
      return {
        stats: statsFor(m, ctx, u),
        engine: m.engine ?? CLAUDE_ENGINE,
        id: r.id,
        title: m.title ?? (r.size ? peekTitle(path.join(dir, `${r.id}.jsonl`)) : null) ?? '(new session)',
        updated: new Date(r.mtime).toISOString(),
        source: m.origin ?? 'cli',
        pinned: !!m.pinned,
        status: l ? l.status : 'idle',
        pending: l ? l.pending.size : 0,
      };
    });
  }

  function create(wsKey, { model, effort, mode, addDirs, engine } = {}) {
    const ws = workspace(wsKey);
    const id = crypto.randomUUID();
    const eng = checkEngine(engine);
    const apiModel = eng !== CLAUDE_ENGINE ? (model && API_MODEL_RE.test(model) ? model : providerStore.load().providers[eng].model ?? null) : null;
    const m = saveMeta(wsKey, id, {
      engine: eng, claudeSessionId: eng === CLAUDE_ENGINE ? id : null, workspace: wsKey, cwd: ws.path, origin: 'ui',
      model: eng !== CLAUDE_ENGINE ? apiModel : model && MODEL_RE.test(model) ? model : (config.chatModel ?? null),
      effort: eng !== CLAUDE_ENGINE ? null : EFFORTS.includes(effort) ? effort : (config.chatEffort ?? null),
      mode: MODES.includes(mode) ? mode : 'default',
      addDirs: addDirs ? checkDirs(addDirs) : [],
      title: null, pinned: false, linkedFrom: null,
    });
    return m;
  }

  // Folders added to a session must exist; at most 20, absolute, no duplicates.
  function checkDirs(list) {
    if (!Array.isArray(list) || list.length > 20) throw new ChatError('invalid', 'addDirs must be a list of at most 20 folders');
    const out = [];
    for (const d of list) {
      const p = path.resolve(String(d ?? '').trim());
      let st = null;
      try { st = fs.statSync(p); } catch { /* missing */ }
      if (!st?.isDirectory()) throw new ChatError('invalid', `not a folder: ${d}`);
      if (!out.some((x) => x.toLowerCase() === p.toLowerCase())) out.push(p);
    }
    return out;
  }

  function sessionMeta(wsKey, id) {
    checkId(id);
    const ws = workspace(wsKey);
    const m = metaOf(wsKey, id);
    if (m && m.workspace !== wsKey) throw new ChatError('not_found', `session ${id} belongs to workspace ${m.workspace}`);
    return { ws, m: m ?? { id, engine: 'claude_cli', claudeSessionId: id, workspace: wsKey, cwd: ws.path, origin: 'cli', model: null, effort: null, mode: null } };
  }

  function get(wsKey, id) {
    const { ws, m } = sessionMeta(wsKey, id);
    const own = isApi(m) ? apiFile(wsKey, id) : transcriptFile(ws.path, id);
    // A fresh copy shows the source history until its first turn writes its own transcript.
    const t = readTranscript(!fs.existsSync(own) && m.forkFrom ? transcriptFile(ws.path, m.forkFrom) : own);
    const l = live.get(id);
    return {
      ...m,
      title: m.title ?? t.title ?? '(new session)',
      items: t.items,
      truncated: t.truncated,
      stats: statsFor(metaOf(wsKey, id) ?? m, t.context),
      rate: loadUsage().rate,
      status: l ? l.status : 'idle',
      pending: l ? [...l.pending.values()] : [],
      model: l?.model ?? m.model ?? null,
      effort: l?.effort ?? m.effort ?? null,
      mode: l?.mode ?? m.mode ?? 'default',
      usage: l?.usage ?? null,
      models: l?.models ?? (isApi(m) ? apiModels(m.engine) : null),
      engine: m.engine ?? CLAUDE_ENGINE,
      linkedFrom: m.linkedFrom ?? null,
      linkedTo: m.linkedTo ?? null,
    };
  }
  function apiModels(engine) {
    const p = providerStore?.load().providers[engine];
    return p ? modelsOf(p).map((v) => ({ value: v, label: v, description: '', efforts: [] })) : null;
  }

  function buildArgs(s, resume) {
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-prompt-tool', 'stdio'];
    // Extra folders (the CLI /add-dir, which headless does not run): every following token is a flag, so the list ends.
    if (s.addDirs?.length) args.push('--add-dir', ...s.addDirs);
    if (s.model) args.push('--model', s.model);
    if (s.effort) args.push('--effort', s.effort);
    if (s.mode && s.mode !== 'default') args.push('--permission-mode', s.mode);
    if (resume) args.push('--resume', s.id);
    else if (s.forkFrom) args.push('--resume', s.forkFrom, '--fork-session', '--session-id', s.id);
    else args.push('--session-id', s.id);
    // Tahap 2: the Putusan tools (own small MCP server; the user's MCP servers still load) and the house rules.
    if (inboxFile) {
      const server = { command: process.execPath, args: [MCP_PUTUSAN, '--inbox', inboxFile, '--workspace', s.workspace, '--session', s.id] };
      args.push('--mcp-config', JSON.stringify({ mcpServers: { artrios: server } }));
      args.push('--allowedTools', 'mcp__artrios__putusan_list,mcp__artrios__putusan_ask');
      args.push('--append-system-prompt', CHAT_RULES);
    }
    return args;
  }

  // Questions still open when a chat ends or is left alone go to Putusan with a link to the session (AC 10).
  function park(s, why) {
    if (!inbox) return;
    for (const p of [...s.pending.values()]) {
      if (p.kind !== 'question') continue;
      const ids = [];
      for (const q of p.input?.questions ?? []) {
        try {
          const r = inbox.ask({
            kind: 'putusan', from: 'claude', workspace: s.workspace, subject: `chat-${s.id.slice(0, 8)}`, topic: slug(q.header || q.question),
            question: q.question, why, options: (q.options ?? []).map((o) => o.label).filter(Boolean).slice(0, 8), links: [], session: s.id,
            meta: { type: 'Pertanyaan chat', title: q.question.slice(0, 200), description: why, related: `${s.workspace} / Cognition ${s.id.slice(0, 8)}` },
          });
          ids.push(r.item.id);
        } catch (e) { console.error('park question failed', e.message); }
      }
      s.pending.delete(p.requestId);
      write(s, { type: 'control_response', response: { subtype: 'success', request_id: p.requestId, response: { behavior: 'deny', message: `The user was not there; the question was moved to the Putusan queue (${ids.join(', ')}). Do not wait for it.` } } });
      emit(s.id, 'item', { item: { kind: 'system', text: `Question moved to Putusan: ${ids.join(', ')}` } });
    }
    emit(s.id, 'pending', { pending: [...s.pending.values()] });
  }

  function evictIdle() {
    if (live.size < maxLive) return;
    const idle = [...live.values()].filter((l) => l.status === 'idle' && !l.pending.size).sort((a, b) => a.lastUsed - b.lastUsed);
    if (!idle.length) throw new ChatError('busy', `at most ${maxLive} chats can run at once; wait for one to finish`);
    stopProcess(idle[0].id);
  }

  function start(ws, m) {
    evictIdle();
    const resume = fs.existsSync(transcriptFile(ws.path, m.id));
    // A fork that has not written its own transcript yet starts from the source session (--fork-session).
    const forkFrom = !resume && m.forkFrom && fs.existsSync(transcriptFile(ws.path, m.forkFrom)) ? m.forkFrom : null;
    const s = { id: m.id, forkFrom, addDirs: m.addDirs ?? [], workspace: ws.key, cwd: ws.path, model: m.model ?? null, effort: m.effort ?? null, mode: m.mode ?? 'default', status: 'idle', pending: new Map(), usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, rate: null }, models: null, commands: null, lastUsed: Date.now(), buf: '', stderr: '', reqSeq: 0, waiters: new Map() };
    const child = spawnImpl(command, [...baseArgs, ...buildArgs(s, resume)], {
      cwd: ws.path, env: childEnv(process.env), windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    });
    s.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      s.buf += chunk;
      let i;
      while ((i = s.buf.indexOf('\n')) >= 0) {
        const line = s.buf.slice(0, i).trim();
        s.buf = s.buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        try { onMessage(s, msg); } catch (e) { console.error('chat event error', e); }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => { s.stderr = (s.stderr + c).slice(-4000); });
    child.stdin.on('error', () => {});
    child.on('error', (e) => { s.stderr += e.message; });
    child.on('close', (code) => {
      if (live.get(s.id) !== s) return;
      live.delete(s.id);
      clearTimeout(s.idleTimer);
      const wasBusy = s.status === 'running';
      for (const w of s.waiters.values()) w.reject(new ChatError('conflict', 'chat process ended'));
      if (s.interrupting) emit(s.id, 'item', { item: { kind: 'system', text: 'Stopped.' } });
      else if (/running in the background|claude attach/i.test(s.stderr)) {
        // The session is held by another claude process (a background job): it can only be continued as a copy.
        emit(s.id, 'error', { message: 'This session is still running in another claude process (a background job), so it cannot be continued here. Continue it as a copy, or wait until that job ends.', canFork: true });
      } else if (wasBusy || (code && !s.stopping)) emit(s.id, 'error', { message: `claude stopped (code ${code}). ${s.stderr.trim().split('\n').slice(-3).join(' ')}`.trim() });
      emit(s.id, 'status', { status: 'idle', pending: [] });
    });
    live.set(s.id, s);
    control(s, { subtype: 'initialize' }).then((r) => {
      s.commands = (r?.commands ?? []).map((c) => ({ name: c.name, description: String(c.description ?? '').slice(0, 300), argumentHint: c.argumentHint ?? '' }));
      s.models = (r?.models ?? []).map((x) => ({ value: x.value, label: x.displayName ?? x.value, description: x.description ?? '', efforts: x.supportedEffortLevels ?? [] }));
      emit(s.id, 'init', { models: s.models });
    }).catch(() => {});
    return s;
  }

  const write = (s, obj) => { try { s.child.stdin.write(`${JSON.stringify(obj)}\n`); } catch { /* process gone: close handler reports */ } };
  function control(s, request) {
    const request_id = `ui-${++s.reqSeq}`;
    return new Promise((resolve, reject) => {
      s.waiters.set(request_id, { resolve, reject });
      write(s, { type: 'control_request', request_id, request });
      setTimeout(() => { if (s.waiters.delete(request_id)) reject(new ChatError('conflict', `no answer to ${request.subtype}`)); }, 30000);
    });
  }

  function onMessage(s, m) {
    if (m.type === 'control_response') {
      const r = m.response ?? {};
      const w = s.waiters.get(r.request_id);
      if (w) { s.waiters.delete(r.request_id); if (r.subtype === 'error') w.reject(new ChatError('conflict', r.error ?? 'control request failed')); else w.resolve(r.response); }
      return;
    }
    if (m.type === 'control_request' && m.request?.subtype === 'can_use_tool') {
      const r = m.request;
      const kind = r.tool_name === 'AskUserQuestion' ? 'question' : 'permission';
      const p = { requestId: m.request_id, kind, tool: r.tool_name, input: r.input, summary: toolSummary(r.tool_name, r.input), description: r.description ?? '', suggestions: r.permission_suggestions ?? [], toolUseId: r.tool_use_id ?? null, ts: new Date().toISOString() };
      s.pending.set(m.request_id, p);
      // A question nobody answers within questionParkMs moves to Putusan, so the chat does not hang (AC 10).
      if (kind === 'question' && inbox) setTimeout(() => { if (live.get(s.id) === s && s.pending.has(m.request_id)) park(s, 'Unanswered in Cognition (the user was away).'); }, questionParkMs).unref?.();
      emit(s.id, 'pending', { pending: [...s.pending.values()] });
      return;
    }
    if (m.type === 'control_request' && m.request?.subtype === 'interrupt') return;
    if (m.type === 'control_cancel_request') {
      if (s.pending.delete(m.request_id)) emit(s.id, 'pending', { pending: [...s.pending.values()] });
      return;
    }
    if (m.type === 'stream_event') {
      const e = m.event;
      if (m.parent_tool_use_id) return;
      if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') emit(s.id, 'delta', { text: e.delta.text });
      return;
    }
    if (m.type === 'rate_limit_event') {
      s.usage.rate = m.rate_limit_info ?? null;
      if (s.usage.rate) saveUsage({ rate: s.usage.rate, rateTs: new Date().toISOString() });
      emit(s.id, 'usage', { usage: s.usage, rate: s.usage.rate });
      return;
    }
    if (m.type === 'system') {
      // init: keep the model alias the user picked (e.g. "haiku") rather than the full name the CLI reports.
      if (m.subtype === 'init') { s.model = s.model ?? m.model ?? null; s.mode = m.permissionMode ?? s.mode; emit(s.id, 'meta', { model: s.model, mode: s.mode }); }
      else if (m.subtype === 'status' && m.permissionMode) { s.mode = m.permissionMode; emit(s.id, 'meta', { mode: s.mode }); }
      else if (m.subtype === 'status' && m.status === 'compacting') emit(s.id, 'item', { item: { kind: 'system', text: 'Compacting…' } });
      else if (m.subtype === 'compact_boundary') { s.lastCtx = 0; emit(s.id, 'item', { item: { kind: 'system', text: 'Conversation compacted (/compact).' } }); }
      else if (m.subtype === 'permission_denied') emit(s.id, 'item', { item: { kind: 'system', text: `Denied: ${m.tool_name}` } });
      return;
    }
    if (m.type === 'user' || m.type === 'assistant') {
      if (m.parent_tool_use_id) return; // subagent traffic stays out of the main transcript
      if (m.type === 'assistant' && m.message?.usage) {
        const ctx = contextOf({ usage: m.message.usage, model: m.message.model });
        if (ctx?.tokens) s.lastCtx = ctx.tokens;
        if (ctx?.tokens) emit(s.id, 'context', { contextTokens: ctx.tokens, contextWindow: windowOf(ctx.model), model: ctx.model });
      }
      const ts = m.timestamp ?? new Date().toISOString();
      for (const item of itemsFromMessage(m)) {
        if (item.kind === 'user' && !m.isReplay) continue; // the browser already shows what it sent
        emit(s.id, 'item', { item: { ...item, ts } });
      }
      return;
    }
    if (m.type === 'result') {
      const u = m.usage ?? {};
      s.usage.costUsd += Number(m.total_cost_usd) || 0;
      s.usage.inputTokens += (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      s.usage.outputTokens += u.output_tokens ?? 0;
      // Persist per-session spend and learn each model's context window (modelUsage.contextWindow).
      const prev = metaOf(s.workspace, s.id) ?? {};
      saveMeta(s.workspace, s.id, {
        costUsd: (prev.costUsd ?? 0) + (Number(m.total_cost_usd) || 0),
        inTokens: (prev.inTokens ?? 0) + (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        outTokens: (prev.outTokens ?? 0) + (u.output_tokens ?? 0),
      });
      const learned = {};
      for (const [model, mu] of Object.entries(m.modelUsage ?? {})) if (Number(mu?.contextWindow) > 0) learned[model] = Number(mu.contextWindow);
      if (Object.keys(learned).length) saveUsage({ windows: { ...(loadUsage().windows ?? {}), ...learned } });
      s.status = 'idle';
      s.lastUsed = Date.now();
      if (m.is_error && m.result) emit(s.id, 'item', { item: { kind: 'error', text: String(m.result).slice(0, 2000) } });
      emit(s.id, 'usage', { usage: s.usage });
      emit(s.id, 'status', { status: 'idle', pending: [], done: true, title: metaOf(s.workspace, s.id)?.title ?? null });
      armIdle(s);
      maybeAutoCompact(s, m);
    }
  }

  // Auto-compact: when a turn ends with a context above config.autoCompactTokens (default 150k, 0 = off), run /compact
  // before the next message so every later tool call re-reads a small context. Never twice in a row.
  function maybeAutoCompact(s, result) {
    const limit = Number(config.autoCompactTokens ?? 150_000);
    const wasAuto = s.autoCompacting;
    s.autoCompacting = false;
    if (wasAuto || !(limit > 0) || result.is_error || s.stopping || s.pending.size || !((s.lastCtx ?? 0) >= limit)) return;
    s.autoCompacting = true;
    s.status = 'running';
    clearTimeout(s.idleTimer);
    emit(s.id, 'item', { item: { kind: 'system', text: `Context reached ${Math.round(s.lastCtx / 1000)}k tokens: compacting automatically.` } });
    emit(s.id, 'status', { status: 'running' });
    write(s, { type: 'user', message: { role: 'user', content: '/compact' }, parent_tool_use_id: null, session_id: s.id });
  }

  function armIdle(s) {
    clearTimeout(s.idleTimer);
    s.idleTimer = setTimeout(() => { if (s.status === 'idle' && !s.pending.size) stopProcess(s.id); }, idleMs);
    s.idleTimer.unref?.();
  }

  function ensure(wsKey, id) {
    const { ws, m } = sessionMeta(wsKey, id);
    let s = live.get(id);
    // A process that is shutting down (effort change, idle stop) must not take the next turn: start a fresh one.
    if (s?.stopping) { live.delete(id); clearTimeout(s.idleTimer); s = null; }
    if (!s) {
      if (!metaOf(wsKey, id)) saveMeta(wsKey, id, { engine: 'claude_cli', claudeSessionId: id, workspace: wsKey, cwd: ws.path, origin: m.origin ?? 'cli' });
      const meta = metaOf(wsKey, id);
      if (isApi(meta)) { evictIdle(); s = api.start(ws, meta); } else s = start(ws, meta);
    }
    return s;
  }

  // Attachments: images go to Claude as image blocks; other files are saved under uploads/ and named by path.
  function contentFor(wsKey, id, text, attachments = []) {
    if (!Array.isArray(attachments) || !attachments.length) return { content: text, names: [] };
    const blocks = [];
    const paths = [];
    let total = 0;
    for (const a of attachments.slice(0, 10)) {
      const name = path.basename(String(a?.name ?? 'lampiran')).replace(/[^\w.\- ]/g, '_').slice(0, 120) || 'lampiran';
      const data = String(a?.data ?? '');
      const bytes = Math.floor((data.length * 3) / 4);
      total += bytes;
      if (total > MAX_ATTACH_BYTES) throw new ChatError('invalid', 'attachments larger than 10 MB in total');
      if (IMAGE_MIME.has(a?.mime)) blocks.push({ type: 'image', source: { type: 'base64', media_type: a.mime, data } });
      else {
        const dir = path.join(uploadsDir(wsKey), id);
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${Date.now()}-${name}`);
        fs.writeFileSync(file, Buffer.from(data, 'base64'));
        paths.push(file);
      }
    }
    const note = paths.length ? `\n\nAttached files (read them with Read or a fitting script):\n${paths.map((p) => `- ${p}`).join('\n')}` : '';
    const full = `${text}${note}`;
    return { content: blocks.length ? [...blocks, { type: 'text', text: full || '(see image)' }] : full, names: paths };
  }

  function send(wsKey, id, { text, attachments, context } = {}) {
    let t = String(text ?? '').trim();
    // Brain chips (T14): sent as a tagged block the browser shows as chips again; each carries its hat label.
    if (Array.isArray(context) && context.length) {
      const page = (c, indent = '') => {
        const title = String(c?.title ?? '').replace(/[\[\]\n]/g, ' ').trim().slice(0, 160) || 'untitled';
        const file = String(c?.file ?? c?.path ?? '').replace(/[()\n]/g, '').slice(0, 400);
        const hat = String(c?.hat ?? '').replace(/\n/g, ' ').trim().slice(0, 60) || 'own (no hat)';
        return `${indent}- [${title}](${file}) · hat: ${hat}${c?.node ? ` · node: ${String(c.node).slice(0, 200)}` : ''}`;
      };
      // A Brain filter (area > entity > type) is one chip that carries its pages (at most 40 listed).
      const lines = context.slice(0, 20).flatMap((c) => {
        if (!Array.isArray(c?.pages)) return [page(c)];
        const label = String(c.title ?? 'filter').replace(/\n/g, ' ').slice(0, 160);
        return [`- filter: ${label} · ${c.pages.length} pages`, ...c.pages.slice(0, 40).map((p) => page(p, '  '))];
      });
      t = `${t}\n\n<brain-context>\nAttached Brain pages (context; cite as [title](path) with the hat label):\n${lines.join('\n')}\n</brain-context>`;
    }
    if (!t && !attachments?.length) throw new ChatError('invalid', 'empty message');
    if (t.length > MAX_TEXT) throw new ChatError('invalid', `message longer than ${MAX_TEXT} characters`);
    if (/^\/clear\b/.test(t)) throw new ChatError('invalid', '/clear starts a new session: use the "New session" button');
    const s = ensure(wsKey, id);
    if (s.status === 'running') throw new ChatError('busy', 'a turn is still running; wait or stop it');
    const m = metaOf(wsKey, id);
    if (!m.title && t) saveMeta(wsKey, id, { title: clip(String(text ?? t).trim().replace(/\s+/g, ' '), 80) || null });
    // A chat moved here from another engine starts with the summary of the old session (T12), once.
    if (m.seed && !m.seeded) { t = `<previous-session id="${m.linkedFrom}" engine="${m.seedEngine ?? ''}">\n${m.seed}\n</previous-session>\n\n${t}`; saveMeta(wsKey, id, { seeded: true }); }
    if (s.api) {
      countSkill(wsKey, t);
      try { return api.send(s, { text: t, attachments }); } catch (e) { throw new ChatError(e.code ?? 'invalid', e.message); }
    }
    const { content } = contentFor(wsKey, id, t, attachments);
    countSkill(wsKey, t);
    s.status = 'running';
    s.interrupting = false;
    s.lastUsed = Date.now();
    clearTimeout(s.idleTimer);
    write(s, { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: id });
    emit(id, 'status', { status: 'running' });
    return { id, status: 'running' };
  }

  function countSkill(wsKey, t) {
    const skill = /^\/([a-z0-9][a-z0-9:-]{0,63})/.exec(t)?.[1];
    if (!skill) return;
    const q = readJson(quickFile(wsKey), { uiUsage: {} });
    q.uiUsage = { ...(q.uiUsage ?? {}), [skill]: (q.uiUsage?.[skill] ?? 0) + 1 };
    writeJson(quickFile(wsKey), q);
  }

  // Answer one pending card. decision: once | always | deny; answers: { question: label } for AskUserQuestion.
  function answer(wsKey, id, { requestId, decision, answers, message } = {}) {
    sessionMeta(wsKey, id);
    const s = live.get(id);
    const p = s?.pending.get(requestId);
    if (!p) throw new ChatError('not_found', 'no such pending request (already answered or the chat ended)');
    if (s.api) { try { api.answer(s, requestId, { decision, answers, message }); } catch (e) { throw new ChatError(e.code ?? 'invalid', e.message); } return { ok: true }; }
    let response;
    if (p.kind === 'question') {
      if (decision === 'deny') response = { behavior: 'deny', message: String(message ?? 'The user skipped this question.') };
      else {
        if (!answers || typeof answers !== 'object') throw new ChatError('invalid', 'answers required');
        response = { behavior: 'allow', updatedInput: { ...p.input, answers } };
      }
    } else if (decision === 'once' || decision === 'always') {
      response = { behavior: 'allow', updatedInput: p.input };
      if (decision === 'always') {
        const fromCli = (p.suggestions ?? []).filter((x) => x.type === 'addRules').map((x) => ({ ...x, destination: 'localSettings' }));
        response.updatedPermissions = fromCli.length ? fromCli : [{ type: 'addRules', rules: [{ toolName: p.tool }], behavior: 'allow', destination: 'localSettings' }];
      }
    } else if (decision === 'deny') response = { behavior: 'deny', message: String(message ?? 'Denied by the user.') };
    else throw new ChatError('invalid', 'decision must be once, always, or deny');
    s.pending.delete(requestId);
    write(s, { type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
    emit(id, 'pending', { pending: [...s.pending.values()] });
    return { ok: true };
  }

  async function setOptions(wsKey, id, { model, mode, effort, title, pinned, addDirs } = {}) {
    sessionMeta(wsKey, id);
    const patch = {};
    if (title !== undefined) patch.title = clip(String(title).trim(), 120) || null;
    if (pinned !== undefined) patch.pinned = !!pinned;
    const cur = metaOf(wsKey, id);
    if (model !== undefined) { if (model && !(isApi(cur) ? API_MODEL_RE : MODEL_RE).test(model)) throw new ChatError('invalid', 'bad model name'); patch.model = model || null; }
    if (mode !== undefined) { if (!MODES.includes(mode)) throw new ChatError('invalid', `mode must be one of ${MODES.join(', ')}`); patch.mode = mode; }
    if (addDirs !== undefined) patch.addDirs = checkDirs(addDirs);
    if (effort !== undefined) { if (effort && !EFFORTS.includes(effort)) throw new ChatError('invalid', 'bad effort'); patch.effort = effort || null; }
    if (!metaOf(wsKey, id)) { const { m } = sessionMeta(wsKey, id); saveMeta(wsKey, id, { ...m, origin: m.origin ?? 'cli' }); }
    const m = saveMeta(wsKey, id, patch);
    const s = live.get(id);
    if (s?.api) {
      if (patch.model !== undefined) s.model = patch.model;
      if (patch.mode !== undefined) s.mode = patch.mode;
      if (patch.addDirs !== undefined) s.addDirs = patch.addDirs;
    } else if (s) {
      if (patch.model !== undefined && patch.model) { await control(s, { subtype: 'set_model', model: patch.model }); s.model = patch.model; }
      if (patch.mode !== undefined) { await control(s, { subtype: 'set_permission_mode', mode: patch.mode }); s.mode = patch.mode; }
      // Effort has no control request: the process restarts with --resume on the next turn (spike AIOS-98).
      if ((patch.effort !== undefined || patch.addDirs !== undefined) && s.status === 'idle' && !s.pending.size) stopProcess(id);
    }
    emit(id, 'meta', { model: m.model, mode: m.mode, effort: m.effort, title: m.title, pinned: m.pinned, addDirs: m.addDirs ?? [] });
    return m;
  }

  async function interrupt(wsKey, id) {
    sessionMeta(wsKey, id);
    const s = live.get(id);
    if (!s || s.status !== 'running') return { ok: true, running: false };
    if (s.api) { api.interrupt(s); return { ok: true }; }
    for (const p of s.pending.values()) write(s, { type: 'control_response', response: { subtype: 'success', request_id: p.requestId, response: { behavior: 'deny', message: 'Stopped by the user.' } } });
    s.pending.clear();
    s.interrupting = true;
    try { await control(s, { subtype: 'interrupt' }); } catch { stopProcess(id); }
    // Some CLI versions end the turn without a result line after an interrupt: do not leave the chat "running".
    setTimeout(() => {
      if (live.get(id) === s && s.status === 'running') { s.status = 'idle'; emit(id, 'status', { status: 'idle', pending: [], done: true }); armIdle(s); }
    }, 5000).unref?.();
    return { ok: true };
  }

  function stopProcess(id) {
    const s = live.get(id);
    if (!s) return;
    if (s.api) { api.stop(s, 'Unanswered when the Cognition session was closed.'); emit(id, 'status', { status: 'idle', pending: [] }); return; }
    if (s.pending.size) park(s, 'Unanswered when the Cognition session was closed.');
    s.stopping = true;
    try { s.child.stdin.end(); } catch { /* gone */ }
    const pid = s.child.pid;
    setTimeout(() => { if (live.get(id) === s) killTree(pid); }, 3000).unref?.();
  }

  function close(wsKey, id) { sessionMeta(wsKey, id); stopProcess(id); return { ok: true }; }

  function stopAll() { for (const s of [...live.values()]) { if (s.api) { api.stop(s, 'Unanswered when the Artrios UI server stopped.'); continue; } if (s.pending.size) park(s, 'Unanswered when the Artrios UI server stopped.'); live.delete(s.id); killTree(s.child.pid); } }

  // Slash commands for autocomplete: built-ins plus skills of the workspace; live process list wins when known.
  function commands(wsKey, id = null) {
    const ws = workspace(wsKey);
    const s = id ? live.get(id) : null;
    const files = workspaceSkills(ws.path, { skillDirs: config.skillDirs ?? [], home });
    const byName = new Map(files.map((f) => [f.name, f]));
    // The live list also has plugin and built-in commands; argument info comes from SKILL.md when there is one.
    const skills = s?.commands?.length
      ? s.commands.map((c) => ({ ...c, takesArgs: byName.get(c.name)?.takesArgs ?? Boolean(c.argumentHint), argumentHint: c.argumentHint || byName.get(c.name)?.argumentHint || '' }))
      : files;
    return [...BUILTIN, ...skills.filter((c) => !BUILTIN.some((b) => b.name === c.name))];
  }

  // Quick actions (T8): only the pinned skills; with no saved pins the four defaults. Built-ins (compact, clear) can be pinned too.
  function quickActions(wsKey) {
    const ws = workspace(wsKey);
    const all = workspaceSkills(ws.path, { skillDirs: config.skillDirs ?? [], home });
    const info = new Map([...BUILTIN.map((b) => [b.name, { description: b.description, takesArgs: false, argumentHint: '' }]), ...all.map((s) => [s.name, s])]);
    const available = new Set(info.keys());
    const q = readJson(quickFile(wsKey), { uiUsage: {} });
    const usage = skillUsage(path.join(home, '.claude', 'history.jsonl'), q.uiUsage ?? {});
    const pinned = (Array.isArray(q.pinned) ? q.pinned : DEFAULT_PINNED).filter((n) => available.has(n));
    const row = (name) => ({ name, pinned: pinned.includes(name), uses: usage[name] ?? 0, takesArgs: info.get(name)?.takesArgs ?? false, argumentHint: info.get(name)?.argumentHint ?? '', description: info.get(name)?.description ?? '' });
    // all: every skill of the workspace for the pin panel, most used first.
    const allRows = [...available].sort((a, b) => (usage[b] ?? 0) - (usage[a] ?? 0) || a.localeCompare(b)).map(row);
    return { items: pinned.map(row), all: allRows };
  }

  function pin(wsKey, name, on) {
    workspace(wsKey);
    if (!/^[a-z0-9][a-z0-9:-]{0,63}$/.test(name ?? '')) throw new ChatError('invalid', 'bad skill name');
    const q = readJson(quickFile(wsKey), { uiUsage: {} });
    const set = new Set(Array.isArray(q.pinned) ? q.pinned : DEFAULT_PINNED);
    if (on) set.add(name); else set.delete(name);
    q.pinned = [...set];
    writeJson(quickFile(wsKey), q);
    return { pinned: q.pinned };
  }

  // Continue a session as a copy (new id, history copied by the CLI on the first turn); both stay linked.
  function fork(wsKey, id) {
    const { ws, m } = sessionMeta(wsKey, id);
    if (isApi(m)) throw new ChatError('invalid', 'only Claude Code sessions can be continued as a copy');
    if (!fs.existsSync(transcriptFile(ws.path, id))) throw new ChatError('not_found', 'the session has no transcript to copy');
    const n = create(wsKey, { model: m.model ?? undefined, effort: m.effort ?? undefined, mode: m.mode ?? undefined });
    const title = m.title ?? peekTitle(transcriptFile(ws.path, id));
    return saveMeta(wsKey, n.id, { forkFrom: id, linkedFrom: id, title: title ? clip(`${title} (salinan)`, 120) : null });
  }

  // Move a chat to another engine (T12). Same engine: only the model changes. Claude <-> API, or one API provider to
  // another: a new session in the same folder that starts with a summary of the old one; both sessions link.
  async function switchEngine(wsKey, id, { engine, model } = {}) {
    const { ws, m } = sessionMeta(wsKey, id);
    const target = checkEngine(engine);
    const from = m.engine ?? CLAUDE_ENGINE;
    if (target === from) { if (model) await setOptions(wsKey, id, { model }); return { ...get(wsKey, id), switched: false }; }
    if (live.get(id)?.status === 'running') throw new ChatError('busy', 'wait until the turn ends before moving the chat');
    const lines = isApi(m) ? api.readLines(apiFile(wsKey, id)) : readCliLines(transcriptFile(ws.path, id));
    const text = transcriptText(lines);
    let summary = null;
    let how = 'model';
    if (text.trim()) {
      try {
        summary = target === CLAUDE_ENGINE ? (summarizeClaude ? await summarizeClaude(text, ws.path) : null) : await api.summarize(target, text);
      } catch (e) { console.error('chat summary failed', e.message); }
      // No summary from a model: the end of the transcript itself carries the context.
      if (!summary) { summary = text.slice(-8000); how = 'transcript'; }
    }
    const title = m.title ?? get(wsKey, id).title;
    const n = create(wsKey, { engine: target, model, mode: m.mode ?? undefined, effort: m.effort ?? undefined, addDirs: m.addDirs ?? undefined });
    const meta = saveMeta(wsKey, n.id, { linkedFrom: id, seed: summary, seedEngine: from, seedHow: summary ? how : null, title: title && title !== '(new session)' ? clip(`${title} (${target === CLAUDE_ENGINE ? 'Claude' : target})`, 120) : null });
    saveMeta(wsKey, id, { linkedTo: n.id });
    if (isApi(meta) && summary) {
      api.append({ id: n.id, workspace: wsKey }, { type: 'system', subtype: 'compact_boundary', summary: `Continued from session ${id} (${from}). ${summary}`, note: `Continued from session ${id.slice(0, 8)} (${from}) with a summary.` });
      saveMeta(wsKey, n.id, { seeded: true });
    }
    stopProcess(id);
    return { ...metaOf(wsKey, n.id), switched: true };
  }

  return { workspaces, usage, engines, list, create, get, send, fork, switchEngine, answer, setOptions, interrupt, close, stopAll, commands, quickActions, pin, liveCount: () => live.size };
}
