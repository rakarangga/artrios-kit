// Cognition Tahap 3 (PRD prd-cognition T11-T13): chat sessions on a non-Claude provider (OpenAI-compatible API).
// The app runs the tool loop itself and behaves like the CLI chat: same pending cards (permission, AskUserQuestion),
// same permission modes and settings rules, skills from SKILL.md, /compact, and the Putusan tools.
// Transcript: <workspace>/.artrios/chat/<id>.jsonl in the neutral format of the CLI transcript lines, so
// readTranscript() and the browser show both engines the same way. The provider key never reaches a file or event.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCaller, systemPrompt } from './providers/api-engine.js';
import { createToolbox, globRegex } from './providers/tools.js';
import { numOf } from './providers/config.js';
import { createPutusanTools, PUTUSAN_TOOLS } from './putusan-tools.js';
import { splitFrontmatter } from './skills.js';

const MAX_TURNS = 60;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);
const EDIT_TOOLS = new Set(['Write', 'Edit']);
const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n)}…` : String(s));

const ASK_TOOL = {
  name: 'AskUserQuestion',
  description: 'Ask the user a question that must be answered now, with 2-4 options each. The answer comes back as the tool result. For a decision that can wait, use putusan_ask instead.',
  parameters: {
    type: 'object',
    required: ['questions'],
    properties: {
      questions: {
        type: 'array', minItems: 1, maxItems: 4,
        items: {
          type: 'object', required: ['question', 'header', 'options'],
          properties: {
            question: { type: 'string' }, header: { type: 'string', description: 'very short label' }, multiSelect: { type: 'boolean' },
            options: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'object', required: ['label'], properties: { label: { type: 'string' }, description: { type: 'string' } } } },
          },
        },
      },
    },
  },
};

const MODE_NOTE = {
  plan: 'Permission mode: plan. Do not change any file and run only read-only commands; investigate, then present a plan and stop.',
  acceptEdits: 'Permission mode: accept edits. File edits inside the project run without asking; commands still need approval.',
  auto: 'Permission mode: auto. File edits run without asking; commands still need approval unless a rule allows them.',
  default: 'Permission mode: default. Edits and commands need the user\'s approval unless a rule allows them.',
};

// ---- permission rules (the CLI settings files: permissions.allow / permissions.deny) ----
export function settingsFiles(cwd, home = os.homedir()) {
  return [path.join(home, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json')];
}
export function loadRules(cwd, home) {
  const allow = [];
  const deny = [];
  for (const f of settingsFiles(cwd, home)) {
    try {
      const p = JSON.parse(fs.readFileSync(f, 'utf8'))?.permissions ?? {};
      if (Array.isArray(p.allow)) allow.push(...p.allow.map(String));
      if (Array.isArray(p.deny)) deny.push(...p.deny.map(String));
    } catch { /* missing or broken file: no rules from it */ }
  }
  return { allow, deny };
}

// Rule forms: "Tool", "Bash(prefix:*)", "Bash(exact command)", "Bash(glob*)", "Edit(path/glob/**)".
export function ruleMatches(rule, tool, input = {}, cwd = '.') {
  const m = /^([A-Za-z_][\w]*)(?:\(([\s\S]*)\))?$/.exec(String(rule).trim());
  if (!m || m[1] !== tool) return false;
  if (m[2] === undefined || m[2] === '' || m[2] === '*') return true;
  const spec = m[2];
  if (tool === 'Bash') {
    const cmd = String(input.command ?? '').trim();
    if (spec.endsWith(':*')) { const pre = spec.slice(0, -2).trim(); return cmd === pre || cmd.startsWith(`${pre} `); }
    if (spec.includes('*')) return new RegExp(`^${spec.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(cmd);
    return cmd === spec;
  }
  const file = input.file_path ?? input.path ?? input.pattern;
  if (!file) return false;
  const abs = path.resolve(cwd, String(file));
  const rel = path.relative(cwd, abs).split(path.sep).join('/');
  const g = spec.replace(/^\.?\//, '');
  return globRegex(g).test(rel) || globRegex(spec.replace(/\\/g, '/')).test(abs.split(path.sep).join('/'));
}

// "Always in this project": one rule in <cwd>/.claude/settings.local.json, other content kept.
export function ruleFor(tool, input = {}) {
  if (tool !== 'Bash') return tool;
  const words = String(input.command ?? '').trim().split(/\s+/).filter(Boolean);
  return words.length > 1 ? `Bash(${words[0]} ${words[1]}:*)` : `Bash(${words[0] ?? ''}:*)`;
}
export function addLocalRule(cwd, rule) {
  const file = path.join(cwd, '.claude', 'settings.local.json');
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* new file */ }
  data.permissions ??= {};
  data.permissions.allow = [...new Set([...(data.permissions.allow ?? []), rule])];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

// ---- skills ----
export function findSkill(name, cwd, { skillDirs = [], home = os.homedir() } = {}) {
  for (const dir of [path.join(cwd, '.claude', 'skills'), ...skillDirs.map((d) => path.resolve(cwd, d)), path.join(home, '.claude', 'skills')]) {
    const file = path.join(dir, name, 'SKILL.md');
    if (fs.existsSync(file)) return { file, dir: path.dirname(file) };
  }
  return null;
}
export function expandSkill(name, args, found) {
  const { body } = splitFrontmatter(fs.readFileSync(found.file, 'utf8'));
  const text = String(body ?? '').includes('$ARGUMENTS') ? body.split('$ARGUMENTS').join(args) : `${body}${args ? `\n\nARGUMENTS: ${args}` : ''}`;
  return `The user ran the skill /${name}${args ? ` with arguments: ${args}` : ''}. Skill folder: ${found.dir}. Follow its instructions:\n\n${text}`;
}

// ---- transcript lines -> provider messages ----
function readLines(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const l of text.split('\n')) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch { /* skip broken line */ } }
  return out;
}

export function toMessages(lines) {
  let start = 0;
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].type === 'system' && lines[i].subtype === 'compact_boundary') { start = i; break; }
  const msgs = [];
  const isTyped = (l) => l.type === 'user' && !(Array.isArray(l.message?.content) && l.message.content.some((b) => b.type === 'tool_result'));
  const lastUser = lines.map((l, i) => (isTyped(l) ? i : -1)).filter((i) => i >= 0).pop();
  lines.slice(start).forEach((l, k) => {
    const i = start + k;
    if (l.type === 'system' && l.subtype === 'compact_boundary' && l.summary) { msgs.push({ role: 'user', content: `Summary of the conversation so far (earlier messages were compacted):\n${l.summary}` }); return; }
    if (l.type === 'assistant') {
      const c = l.message?.content ?? [];
      const text = c.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const calls = c.filter((b) => b.type === 'tool_use');
      msgs.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls.map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } })) } : {}) });
      return;
    }
    if (l.type !== 'user') return;
    const c = l.message?.content;
    if (Array.isArray(c) && c.some((b) => b.type === 'tool_result')) {
      for (const b of c) if (b.type === 'tool_result') msgs.push({ role: 'tool', tool_call_id: b.tool_use_id, content: String(b.content ?? '') });
      return;
    }
    const text = l.expanded ?? (typeof c === 'string' ? c : (c ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n'));
    const images = Array.isArray(c) ? c.filter((b) => b.type === 'image' && b.source?.path) : [];
    if (images.length && i === lastUser) {
      const parts = [{ type: 'text', text: text || '(see image)' }];
      for (const b of images) {
        try {
          if (fs.statSync(b.source.path).size <= MAX_IMAGE_BYTES) parts.push({ type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${fs.readFileSync(b.source.path).toString('base64')}` } });
        } catch { /* image gone */ }
      }
      msgs.push({ role: 'user', content: parts });
    } else msgs.push({ role: 'user', content: `${text}${images.length ? `\n(${images.length} image(s) attached earlier: ${images.map((b) => b.source.path).join(', ')})` : ''}` });
  });
  // Every tool call needs an answer, or the next request fails (a turn stopped in the middle leaves some open).
  const fixed = [];
  for (let i = 0; i < msgs.length; i++) {
    fixed.push(msgs[i]);
    if (msgs[i].role !== 'assistant' || !msgs[i].tool_calls) continue;
    const answered = new Set();
    let j = i + 1;
    while (j < msgs.length && msgs[j].role === 'tool') { answered.add(msgs[j].tool_call_id); fixed.push(msgs[j]); j++; }
    for (const tc of msgs[i].tool_calls) if (!answered.has(tc.id)) fixed.push({ role: 'tool', tool_call_id: tc.id, content: '(not run: the turn was stopped)' });
    i = j - 1;
  }
  return fixed;
}

const transcriptText = (lines, max = 24000) => {
  const out = [];
  for (const l of lines) {
    if (l.type === 'system' && l.summary) out.push(`[earlier summary] ${l.summary}`);
    const c = l.message?.content;
    if (l.type === 'user' && typeof c === 'string') out.push(`User: ${c}`);
    else if (l.type === 'user' && Array.isArray(c)) for (const b of c) { if (b.type === 'text') out.push(`User: ${b.text}`); else if (b.type === 'tool_result') out.push(`Tool result: ${clip(b.content, 400)}`); }
    else if (l.type === 'assistant' && Array.isArray(c)) for (const b of c) { if (b.type === 'text') out.push(`Assistant: ${b.text}`); else if (b.type === 'tool_use') out.push(`Tool call: ${b.name} ${clip(JSON.stringify(b.input), 300)}`); }
  }
  const t = out.join('\n');
  return t.length > max ? `…${t.slice(-max)}` : t;
};
export { transcriptText };

// deps: { live, emit, saveMeta, metaOf, fileOf(wsKey, id), uploadsDir(wsKey), inbox, store, transports, fetchImpl,
//         coreFile, chatRules, home, skillDirs, questionParkMs, toolSummary, itemsFromMessage, saveWindow(model, n) }
export function createApiChat(deps) {
  const { live, emit, saveMeta, metaOf, fileOf, uploadsDir, inbox, store, transports, fetchImpl = fetch, coreFile = null, chatRules = '', home = os.homedir(), skillDirs = [], questionParkMs = 30 * 60 * 1000, toolSummary, itemsFromMessage, saveWindow = () => {}, modelInfo = () => null } = deps;

  const providerOf = (id) => {
    const p = store?.load().providers[id];
    if (!p || p.transport === 'claude_cli') throw Object.assign(new Error(`unknown API provider: ${id}`), { code: 'not_found' });
    const transport = transports[p.transport];
    if (!transport) throw Object.assign(new Error(`unknown transport: ${p.transport}`), { code: 'invalid' });
    return { p, transport };
  };

  function append(s, line) {
    const file = fileOf(s.workspace, s.id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const full = { ...line, uuid: crypto.randomUUID(), sessionId: s.id, timestamp: line.timestamp ?? new Date().toISOString() };
    fs.appendFileSync(file, `${JSON.stringify(full)}\n`);
    return full;
  }
  const show = (s, line) => { for (const item of itemsFromMessage(line)) emit(s.id, 'item', { item: { ...item, ts: line.timestamp } }); };

  function start(ws, m) {
    const s = { id: m.id, api: true, engine: m.engine, workspace: ws.key, cwd: ws.path, addDirs: m.addDirs ?? [], model: m.model ?? null, effort: null, mode: m.mode ?? 'default', status: 'idle', pending: new Map(), resolvers: new Map(), usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, rate: null }, models: null, lastUsed: Date.now(), ctl: null, reqSeq: 0, putusan: inbox ? createPutusanTools({ inbox, workspace: ws.key, session: m.id }) : null };
    try { s.models = store ? modelsList(providerOf(m.engine).p) : null; } catch { /* provider removed: send() reports it */ }
    live.set(s.id, s);
    return s;
  }
  const modelsList = (p) => [...new Set([p.model, ...String(p.models ?? '').split(',')].map((x) => String(x ?? '').trim()).filter(Boolean))].map((v) => ({ value: v, label: v, description: '', efforts: [] }));

  // Waits for the user's answer to a card; interrupt() and park() resolve it too.
  function waitCard(s, card) {
    const requestId = `api-${++s.reqSeq}`;
    const p = { requestId, ...card, ts: new Date().toISOString() };
    s.pending.set(requestId, p);
    emit(s.id, 'pending', { pending: [...s.pending.values()] });
    return new Promise((resolve) => {
      s.resolvers.set(requestId, resolve);
      if (card.kind === 'question' && inbox) setTimeout(() => { if (s.pending.has(requestId)) park(s, requestId, 'Unanswered in Cognition (the user was away).'); }, questionParkMs).unref?.();
    });
  }
  function settle(s, requestId, response) {
    const r = s.resolvers.get(requestId);
    s.pending.delete(requestId);
    s.resolvers.delete(requestId);
    emit(s.id, 'pending', { pending: [...s.pending.values()] });
    r?.(response);
  }
  function park(s, requestId, why) {
    const p = s.pending.get(requestId);
    if (!p || !inbox) return;
    const ids = [];
    for (const q of p.input?.questions ?? []) {
      try {
        const r = inbox.ask({ kind: 'putusan', from: 'claude', workspace: s.workspace, subject: `chat-${s.id.slice(0, 8)}`, topic: String(q.header || q.question).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'pertanyaan', question: q.question, why, options: (q.options ?? []).map((o) => o.label).filter(Boolean).slice(0, 8), links: [], session: s.id, meta: { type: 'Pertanyaan chat', title: String(q.question).slice(0, 200), description: why, related: `${s.workspace} / Cognition ${s.id.slice(0, 8)}` } });
        ids.push(r.item.id);
      } catch (e) { console.error('park question failed', e.message); }
    }
    settle(s, requestId, { behavior: 'deny', message: `The user was not there; the question was moved to the Putusan queue (${ids.join(', ')}). Do not wait for it.` });
    emit(s.id, 'item', { item: { kind: 'system', text: `Question moved to Putusan: ${ids.join(', ')}` } });
  }

  // -> { allow: true } | { allow: false, message }
  async function gate(s, name, input) {
    if (READ_TOOLS.has(name) || name === 'AskUserQuestion' || name.startsWith('putusan_')) {
      const { deny } = loadRules(s.cwd, home);
      if (deny.some((r) => ruleMatches(r, name, input, s.cwd))) return { allow: false, message: `Denied by a permission rule for ${name}.` };
      return { allow: true };
    }
    const { allow, deny } = loadRules(s.cwd, home);
    if (deny.some((r) => ruleMatches(r, name, input, s.cwd))) return { allow: false, message: `Denied by a permission rule for ${name}.` };
    if (s.mode === 'plan' && EDIT_TOOLS.has(name)) return { allow: false, message: 'Plan mode: files are not changed. Present the plan instead.' };
    if (EDIT_TOOLS.has(name) && (s.mode === 'acceptEdits' || s.mode === 'auto')) return { allow: true };
    if (allow.some((r) => ruleMatches(r, name, input, s.cwd))) return { allow: true };
    if (s.mode === 'plan') return { allow: false, message: 'Plan mode: only commands allowed by a permission rule run. Present the plan instead.' };
    const rule = ruleFor(name, input);
    const r = await waitCard(s, { kind: 'permission', tool: name, input, summary: toolSummary(name, input), description: '', suggestions: [{ type: 'addRules', rules: [{ toolName: name, ruleContent: rule }], behavior: 'allow', destination: 'localSettings' }], toolUseId: null });
    if (r.behavior !== 'allow') return { allow: false, message: r.message ?? 'Denied by the user.' };
    if (r.always) { addLocalRule(s.cwd, rule); emit(s.id, 'item', { item: { kind: 'system', text: `Rule added to .claude/settings.local.json: ${rule}` } }); }
    return { allow: true };
  }

  async function runTool(s, toolbox, c) {
    if (c.argsError) return { text: c.argsError, isError: true };
    const g = await gate(s, c.name, c.args);
    if (!g.allow) return { text: g.message, isError: true };
    if (c.name === 'AskUserQuestion') {
      const r = await waitCard(s, { kind: 'question', tool: 'AskUserQuestion', input: c.args, summary: toolSummary('AskUserQuestion', c.args), description: '', suggestions: [], toolUseId: c.id });
      if (r.behavior !== 'allow') return { text: r.message ?? 'The user skipped this question.', isError: true };
      return { text: `User answers:\n${Object.entries(r.answers ?? {}).map(([q, a]) => `- ${q} -> ${a}`).join('\n')}`, isError: false };
    }
    if (c.name.startsWith('putusan_')) {
      if (!s.putusan) return { text: 'the Putusan queue is not available in this install', isError: true };
      try { return { text: JSON.stringify(s.putusan.call(c.name, c.args), null, 2), isError: false }; } catch (e) { return { text: e.message, isError: true }; }
    }
    return toolbox.run(c.name, c.args);
  }

  function account(s, provider, model, usage) {
    if (!usage) return;
    const inT = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
    const outT = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
    // Price per model from the fetched list (e.g. OpenRouter), else the provider's manual price (T13).
    const info = modelInfo(s.engine, model) ?? {};
    const pin = info.priceIn ?? numOf(provider.price_in);
    const pout = info.priceOut ?? numOf(provider.price_out);
    const cost = pin !== null || pout !== null ? (inT * (pin ?? 0) + outT * (pout ?? 0)) / 1e6 : null;
    const prev = metaOf(s.workspace, s.id) ?? {};
    saveMeta(s.workspace, s.id, {
      inTokens: (prev.inTokens ?? 0) + inT,
      outTokens: (prev.outTokens ?? 0) + outT,
      // Without a price list only tokens are counted (T13): cost stays null instead of a wrong 0.
      costUsd: cost === null ? (prev.costUsd ?? null) : (prev.costUsd ?? 0) + cost,
    });
    s.usage.inputTokens += inT;
    s.usage.outputTokens += outT;
    if (cost !== null) s.usage.costUsd += cost;
    const win = info.context ?? numOf(provider.context_window);
    if (win) saveWindow(model, win);
    emit(s.id, 'context', { contextTokens: inT, contextWindow: win ?? null, model });
  }

  async function turn(s, { compact = false } = {}) {
    const { p: provider, transport } = providerOf(s.engine);
    const apiKey = store.keyOf(provider);
    const { call, hide } = createCaller({ provider, apiKey, transport, fetchImpl, retryDelayMs: deps.retryDelayMs ?? 1500 });
    const model = s.model || provider.model;
    const toolbox = createToolbox({ cwd: s.cwd, extraRoots: s.addDirs, fullShell: true });
    s.toolbox = toolbox;
    const defs = compact ? [] : [...toolbox.definitions(), ASK_TOOL, ...(s.putusan ? PUTUSAN_TOOLS.map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema })) : [])];
    const tools = transport.convertTools(defs);
    const system = [systemPrompt({ cwd: s.cwd, coreFile }), s.addDirs.length ? `Extra folders you may use: ${s.addDirs.join(', ')}` : '', MODE_NOTE[s.mode] ?? MODE_NOTE.default, chatRules.replace(/mcp__artrios__/g, '')].filter(Boolean).join('\n\n');
    try {
      if (compact) {
        const lines = readLines(fileOf(s.workspace, s.id));
        const json = await call(transport.buildKwargs({ model, messages: [{ role: 'system', content: 'Summarise the conversation for its own continuation: goals, decisions, files touched, open work, and the next step. Plain text, at most 400 words.' }, { role: 'user', content: transcriptText(lines) || '(empty)' }], tools: [] }), s.ctl.signal);
        const r = transport.normalizeResponse(json);
        account(s, provider, model, r.usage);
        const line = append(s, { type: 'system', subtype: 'compact_boundary', summary: r.text, note: 'Conversation compacted (/compact).' });
        emit(s.id, 'item', { item: { kind: 'system', text: line.note, ts: line.timestamp } });
        return;
      }
      for (let n = 1; n <= MAX_TURNS; n++) {
        const messages = [{ role: 'system', content: system }, ...toMessages(readLines(fileOf(s.workspace, s.id)))];
        const json = await call(transport.buildKwargs({ model, messages: transport.convertMessages(messages), tools }), s.ctl.signal);
        const r = transport.normalizeResponse(json);
        const u = r.usage ?? {};
        const line = append(s, { type: 'assistant', message: { role: 'assistant', model, content: [...(r.text ? [{ type: 'text', text: r.text }] : []), ...r.toolCalls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.args }))], usage: { input_tokens: Number(u.prompt_tokens ?? u.input_tokens ?? 0) || 0, output_tokens: Number(u.completion_tokens ?? u.output_tokens ?? 0) || 0 } } });
        show(s, line);
        account(s, provider, model, r.usage);
        if (!r.toolCalls.length) return;
        for (const c of r.toolCalls) {
          if (s.ctl.signal.aborted) throw new Error('stopped');
          const out = await runTool(s, toolbox, c);
          const res = append(s, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: c.id, is_error: !!out.isError, content: hide(String(out.text)) }] } });
          show(s, res);
        }
      }
      throw new Error(`stopped after ${MAX_TURNS} model calls without a final answer`);
    } catch (e) {
      if (s.ctl.signal.aborted || e.message === 'stopped') emit(s.id, 'item', { item: { kind: 'system', text: 'Stopped.' } });
      else emit(s.id, 'item', { item: { kind: 'error', text: hide(clip(e.message, 2000)) } });
    } finally { s.toolbox = null; }
  }

  // text: what the user typed; attachments: [{ name, mime, data(base64) }]. Images and files are saved under uploads/.
  function send(s, { text, attachments = [] }, { skill = null } = {}) {
    const t = String(text ?? '');
    const blocks = [];
    const files = [];
    for (const a of (attachments ?? []).slice(0, 10)) {
      const name = path.basename(String(a?.name ?? 'lampiran')).replace(/[^\w.\- ]/g, '_').slice(0, 120) || 'lampiran';
      const dir = path.join(uploadsDir(s.workspace), s.id);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${Date.now()}-${name}`);
      fs.writeFileSync(file, Buffer.from(String(a?.data ?? ''), 'base64'));
      if (/^image\//.test(a?.mime ?? '')) blocks.push({ type: 'image', source: { type: 'file', media_type: a.mime, path: file } });
      else files.push(file);
    }
    const note = files.length ? `\n\nAttached files (read them with Read or a fitting command):\n${files.map((p) => `- ${p}`).join('\n')}` : '';
    let expanded;
    let compact = false;
    const cmd = /^\/([a-z0-9][a-z0-9:-]{0,63})(?:\s+([\s\S]*))?$/.exec(t.trim());
    if (cmd && cmd[1] === 'compact') compact = true;
    else if (cmd) {
      const found = skill ?? findSkill(cmd[1], s.cwd, { skillDirs, home });
      if (!found) throw Object.assign(new Error(`unknown command: /${cmd[1]}`), { code: 'invalid' });
      expanded = `${expandSkill(cmd[1], (cmd[2] ?? '').trim(), found)}${note}`;
    }
    s.status = 'running';
    s.lastUsed = Date.now();
    s.ctl = new AbortController();
    emit(s.id, 'status', { status: 'running' });
    if (!compact) {
      const content = blocks.length ? [...blocks, { type: 'text', text: `${t}${note}` }] : `${t}${note}`;
      append(s, { type: 'user', message: { role: 'user', content }, ...(expanded ? { expanded } : {}) });
    } else emit(s.id, 'item', { item: { kind: 'system', text: 'Compacting…' } });
    turn(s, { compact }).finally(() => {
      s.status = 'idle';
      s.ctl = null;
      s.lastUsed = Date.now();
      emit(s.id, 'usage', { usage: s.usage });
      emit(s.id, 'status', { status: 'idle', pending: [], done: true, title: metaOf(s.workspace, s.id)?.title ?? null });
    });
    return { id: s.id, status: 'running' };
  }

  function answer(s, requestId, { decision, answers, message } = {}) {
    const p = s.pending.get(requestId);
    if (!p) return false;
    if (p.kind === 'question') {
      if (decision === 'deny') settle(s, requestId, { behavior: 'deny', message: String(message ?? 'The user skipped this question.') });
      else {
        if (!answers || typeof answers !== 'object') throw Object.assign(new Error('answers required'), { code: 'invalid' });
        settle(s, requestId, { behavior: 'allow', answers });
      }
    } else if (decision === 'once' || decision === 'always') settle(s, requestId, { behavior: 'allow', always: decision === 'always' });
    else if (decision === 'deny') settle(s, requestId, { behavior: 'deny', message: String(message ?? 'Denied by the user.') });
    else throw Object.assign(new Error('decision must be once, always, or deny'), { code: 'invalid' });
    return true;
  }

  function interrupt(s) {
    for (const id of [...s.pending.keys()]) settle(s, id, { behavior: 'deny', message: 'Stopped by the user.' });
    s.ctl?.abort();
    s.toolbox?.stop();
  }

  function stop(s, why) {
    for (const [id, p] of [...s.pending.entries()]) { if (p.kind === 'question') park(s, id, why); else settle(s, id, { behavior: 'deny', message: 'The chat was closed.' }); }
    s.ctl?.abort();
    s.toolbox?.stop();
    live.delete(s.id);
  }

  // One call that writes a summary of a transcript, for moving to another engine (T12). No tools.
  async function summarize(providerId, text) {
    const { p: provider, transport } = providerOf(providerId);
    const { call } = createCaller({ provider, apiKey: store.keyOf(provider), transport, fetchImpl, retryDelayMs: 500 });
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 120000);
    try {
      const json = await call(transport.buildKwargs({ model: provider.model, messages: [{ role: 'system', content: 'Summarise this conversation so another assistant can continue it: goals, decisions, files touched, open work, next step. Plain text, at most 400 words, same language as the user.' }, { role: 'user', content: text }], tools: [] }), ctl.signal);
      return transport.normalizeResponse(json).text;
    } finally { clearTimeout(timer); }
  }

  return { start, send, answer, interrupt, stop, summarize, providerOf, append, readLines };
}
