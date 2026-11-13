// HTTP adapter: a thin layer over the task service and projects. No business logic here.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createGuard, parseCookies } from './guard.js';
import { createAuth, AuthError, COOKIE, MIN_PASSWORD, USER } from './auth.js';
import { loginPage } from './login-page.js';
import { createProjects } from './projects.js';
import { WebSocketServer } from 'ws';
import { appendActivity } from './activity.js';
import { readFeed, readCombinedFeed } from './feed.js';
import { TaskError } from './task-service.js';
import { createJobRunner, JobError } from './job-runner.js';
import { createTerminalManager, TerminalError } from './terminal.js';
import { createClaudeHeadlessEngine } from './engine.js';
import { listSkills, SkillError } from './skills.js';
import { createAddProject, AddProjectError } from './add-project.js';
import { createExtras } from './extras.js';
import { createGitService } from './git-service.js';
import { createIdeation } from './ideation.js';
import { createBrain } from './brain/index.js';
import { createPulse } from './pulse.js';
import { createProviderLayer, coreFileOf } from './providers/index.js';
import { runOnce } from './oneshot.js';
import { createInboxService, InboxError } from './inbox-service.js';
import { createKitUpdate } from './kit-update.js';
import os from 'node:os';
import { createChatService, ChatError } from './chat-service.js';
import { inboxFileOf, artriosHome, agentsDirOf, schedulerDirOf, schedulesDirOf, createLocations } from './instance.js';
import { createAgentService, AgentError } from './agents.js';
import { createScheduleService } from './schedules.js';
import { createWaitingTasks } from './waiting-tasks.js';
import { createTaskBridge } from './task-bridge.js';
import { STATUSES } from './card.js';
import { readHeartbeat, requestRun, DEFAULT_AGENT } from './scheduler.js';
import { parseCron, nextFire } from './cron.js';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json' };
const FALLBACK = '<!doctype html><meta charset="utf-8"><title>Artrios</title><body style="font:16px system-ui;margin:2rem"><h1>Artrios UI</h1><p>Client not built yet. Run <code>npm run build</code> in the UI folder. The API is up at <code>/api/projects</code>.</p>';
const MAX_BODY = 1024 * 1024;
const PUBLIC_ICONS = new Set(['/favicon.svg', '/favicon-32.png', '/apple-touch-icon.png', '/icon-512.png']);
const STATUS_FOR = { read_only: 409, closed: 409, invalid: 400, not_found: 404, broken: 422, forbidden: 403, conflict: 409, busy: 429, unavailable: 503, unauthorized: 401, locked: 423, must_change: 403 };

function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && body !== null && !Buffer.isBuffer(body);
  res.writeHead(status, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(isObj ? { 'Content-Type': 'application/json' } : {}), ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
}

function readJson(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return reject(new TaskError('invalid', 'content-type must be application/json'));
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new TaskError('invalid', 'body too large')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new TaskError('invalid', 'invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, clientDir, pathname) {
  const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  const file = path.resolve(clientDir, `.${rel}`);
  if (file !== clientDir && !file.startsWith(clientDir + path.sep)) return send(res, 403, 'forbidden');
  if (!fs.existsSync(clientDir)) return send(res, 200, FALLBACK, { 'Content-Type': MIME['.html'] });
  const target = fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(clientDir, 'index.html');
  if (!fs.existsSync(target)) return send(res, 200, FALLBACK, { 'Content-Type': MIME['.html'] });
  return send(res, 200, fs.readFileSync(target), { 'Content-Type': MIME[path.extname(target)] ?? 'application/octet-stream' });
}

export function createApp({ config, dataDir, port, clientDir, engine = null, ptyLib = null, fetchImpl = fetch, usersFile = null, configFile = null, taskBridge = null }) {
  const guard = createGuard({ port, host: config.host ?? null, extraHosts: config.allowedHosts ?? [] });
  // Audit log (PRD AIOS-61 v2.0 S6, §17): sign-ins, password changes, terminal switch and terminal sessions. Append-only.
  const auditFile = path.join(dataDir, 'audit.jsonl');
  const audit = (e) => {
    try { fs.mkdirSync(dataDir, { recursive: true }); fs.appendFileSync(auditFile, `${JSON.stringify({ ts: new Date().toISOString(), ...e })}\n`); } catch (err) { console.error(`audit log: ${err.message}`); }
  };
  const auth = createAuth({ file: usersFile ?? path.join(dataDir, 'users.json'), config, audit });
  const cfgFile = configFile ?? path.join(dataDir, 'config.json');
  // Settings writes one key back to data/config.json and leaves every other key as it is.
  function saveConfigKey(key, value) {
    let cur = {};
    try { cur = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch { /* new file */ }
    cur[key] = value;
    fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
    fs.writeFileSync(cfgFile, `${JSON.stringify(cur, null, 2)}\n`);
    config[key] = value;
  }
  const sidOf = (req) => parseCookies(req.headers.cookie)[COOKIE] ?? null;
  const metaOf = (req) => ({ ip: req.socket?.remoteAddress ?? null });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  // Push every event (card activity, job status, job log) to connected browsers. Jobs do not depend on this.
  const broadcast = (msg) => {
    const text = JSON.stringify(msg);
    for (const c of wss.clients) if (c.readyState === 1) c.send(text);
  };
  const projects = createProjects({
    dataDir,
    config,
    onActivity: (project, event) => broadcast({ type: 'activity', project: project.key, event: { ...event, project: project.key } }),
  });
  const cliEngine = engine ?? createClaudeHeadlessEngine({ command: config.claudePath ?? 'claude', baseArgs: config.claudeBaseArgs ?? [] });
  const providers = createProviderLayer({ config, cliEngine, fetchImpl });
  const eng = providers.engine;
  const jobs = createJobRunner({
    engine: eng,
    config,
    onEvent: (e) => {
      if (e.type === 'activity') {
        const project = projects.find(e.project);
        if (project) appendActivity(project, e.event);
      }
      broadcast(e);
    },
  });
  const wssTerm = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
  // Terminal is off unless config.terminal is true (PRD AIOS-61 v2.0 S6, AC 5): Agent Terminals is hidden and its API
  // refused. Settings can switch it on with a warning; the switch and every terminal session go to the audit log.
  let terminalOn = config.terminal === true;
  const terminals = createTerminalManager({ config, ptyLib, onEvent: broadcast });
  const addProject = createAddProject({ dataDir, config });
  const extras = createExtras({ config });
  // Git and worktrees (PRD AIOS-61 v2.1 S11): every action goes to the project's activity log and to open browsers.
  const gitSvc = createGitService({
    config,
    onActivity: (project, event) => { appendActivity(project, event); broadcast({ type: 'activity', project: project.key, event: { ...event, project: project.key } }); },
  });
  const ideation = createIdeation({ engine: eng, config, onEvent: broadcast });
  const pulse = createPulse({ config });
  const waitingTasks = createWaitingTasks({ config });
  // Read-only bridge to an outside task tool (S12 M1): its tasks on the board, every write refused.
  const bridge = taskBridge ?? createTaskBridge({ config });
  // Project list with bridged counts; projects only the tool knows come last, marked bridgeOnly.
  const listProjects = (snap) => {
    const countOf = (svc) => {
      const counts = Object.fromEntries(STATUSES.map((st) => [st, 0]));
      const r = svc.list();
      for (const c of r.cards) counts[c.status] += 1;
      return { counts, broken: r.broken.length };
    };
    const out = projects.all().map((p) => {
      const base = projects.summary(p);
      if (!snap?.projects.has(p.key)) return base;
      try { return { ...base, ...countOf(bridge.wrap(projects.service(p), p.key, snap)), bridged: true }; } catch { return base; }
    });
    const known = new Set(out.map((p) => p.key));
    for (const key of snap ? [...snap.projects.keys()].sort() : []) {
      if (known.has(key)) continue;
      const v = bridge.virtualProject(key, snap);
      out.push({ key, name: v.name, hat: v.hat, client: v.client, path: null, bridgeOnly: true, bridged: true, ...countOf(bridge.wrap(bridge.emptySvc(key), key, snap)) });
    }
    return out;
  };
  const brain = createBrain({ config, dataDir, pulse });
  const inboxFile = inboxFileOf(config, dataDir);
  fs.mkdirSync(path.dirname(inboxFile), { recursive: true });
  const inbox = createInboxService({ file: inboxFile, emit: broadcast });
  // Update kit (AIOS-130): only active when the instance root is a kit checkout (install.py, .git, ui/); never in a non-kit install.
  const kitUpdate = createKitUpdate({ kitRoot: config.kitRoot ? path.resolve(config.kitRoot) : artriosHome(config)?.path ?? null, uiDir: path.resolve(dataDir, '..'), dataDir, home: config.homeDir ? path.resolve(config.homeDir) : os.homedir() });
  if (kitUpdate.enabled()) { kitUpdate.check().catch(() => {}); setInterval(() => kitUpdate.check().catch(() => {}), 3600000).unref(); }
  // Cognition (PRD prd-cognition): metadata next to the instance data, sessions stay in the CLI store; unanswered
  // questions are parked in this inbox and the Putusan tools write to it.
  // Tahap 3: API providers from Settings > Model can run a chat too; moving a chat to claude asks claude for the summary.
  const summarizeClaude = async (text, cwd) => {
    const r = await runOnce(cliEngine, config, { prompt: `Summarise this conversation so another assistant can continue it: goals, decisions, files touched, open work, next step. Plain text, at most 400 words, same language as the user.\n\n${text}`, cwd, allowedTools: [], model: config.chatSummaryModel ?? 'haiku' });
    return r.ok ? r.text : null;
  };
  // Prompt suggestions: after a turn, a light model proposes short replies the user may send next.
  const SUGGEST_MODELS = /^[\w.\-\[\]\/:]{1,80}$/;
  const SUGGEST_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
  const suggestReplies = async (b) => {
    const text = String(b?.text ?? '').slice(-3000);
    if (!text.trim()) return { suggestions: [] };
    const model = SUGGEST_MODELS.test(b?.model ?? '') ? b.model : 'haiku';
    const effort = SUGGEST_EFFORTS.includes(b?.effort) ? b.effort : undefined;
    const provider = /^[\w.\-]{1,60}$/.test(b?.provider ?? '') ? b.provider : undefined;
    const language = /^[\p{L} ()\-]{2,40}$/u.test(String(b?.language ?? '').trim()) ? String(b.language).trim() : 'English';
    const prompt = `Below is the end of a conversation between a user and an assistant. Propose 2 or 3 short replies the user is most likely to send next, in ${language}, each at most 8 words, first person as the user. Answer with only a JSON array of strings.

${text}`;
    const r = await runOnce(provider ? eng : cliEngine, config, { prompt, cwd: dataDir, allowedTools: [], model, effort, noMcp: true, ...(provider ? { provider } : {}) });
    if (!r.ok) return { suggestions: [] };
    const m = /\[[\s\S]*\]/.exec(r.text);
    try { return { suggestions: JSON.parse(m?.[0] ?? '[]').filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().slice(0, 120)).slice(0, 3) }; } catch { return { suggestions: [] }; }
  };
  const chat = createChatService({ config, chatDir: config.chatDir ? path.resolve(config.chatDir) : null, fallbackDir: path.join(dataDir, 'chat'), projects, onEvent: broadcast, inbox: config.chatPutusan === false ? null : inbox, inboxFile: config.chatPutusan === false ? null : inboxFile, providerStore: providers.store, fetchImpl, coreFile: coreFileOf(config), summarizeClaude, modelInfo: providers.info, worktrees: gitSvc });
  // Preview reads a linked file, but only inside the folders listed in config.inboxPreviewRoots.
  const previewRoots = (config.inboxPreviewRoots ?? []).map((r) => path.resolve(r));
  function inboxPreview(item) {
    const rel = item.links[0];
    if (!rel) throw new InboxError('not_found', 'item has no linked file');
    for (const root of previewRoots) {
      const file = path.resolve(root, rel);
      if (file !== root && !file.startsWith(root + path.sep)) continue;
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
      const buf = fs.readFileSync(file);
      return { path: file, truncated: buf.length > 200000, text: buf.subarray(0, 200000).toString('utf8') };
    }
    throw new InboxError('not_found', 'linked file is not readable from the allowed preview folders');
  }
  const inboxUser = config.inboxUser ?? USER;
  // Routines (PRD AIOS-61 v2.1 S3, S7): schedules (schedules/<id>.md) call agent profiles (agents/<id>.md) or run a
  // command, at "artrios" (the home folder) or a workspace. The UI only reads and edits the files; the scheduler (its
  // own process) runs them, and "run now" is a request file it picks up at once.
  const agentSvc = createAgentService({ dir: agentsDirOf(config, dataDir) });
  const scheduleSvc = createScheduleService({ dir: schedulesDirOf(config, dataDir) });
  const locations = createLocations({ config, projects });
  const schedDir = schedulerDirOf(dataDir);
  const locName = (key) => (key === 'artrios' ? locations.home()?.name ?? 'Artrios' : projects.find(key)?.name ?? key);
  function routinesOverview() {
    const { schedules, errors: sErr } = scheduleSvc.list();
    const { agents, errors: aErr } = agentSvc.list();
    const hb = readHeartbeat(schedDir);
    const now = new Date();
    const rows = schedules.map((s) => {
      const loc = locations.locate(s.location);
      let last = hb.last?.[s.id] ?? null;
      if (last) {
        const l = locations.locate(last.location);
        try { const m = jobs.show(l, last.jobId).meta; last = { ...last, project: l.key, status: m.status, warning: !!m.warning, finished: m.finished, cost: m.cost, error: m.error, exitCode: m.exitCode }; } catch { /* job folder gone */ }
      }
      const next = s.enabled ? nextFire(parseCron(s.schedule), now) : null;
      const agent = s.type === 'agent' ? (s.agent ? agents.find((a) => a.id === s.agent) ?? null : DEFAULT_AGENT) : null;
      return { ...s, locationName: locName(s.location), locationFound: !!loc, agentName: agent?.name ?? null, agentFound: s.type !== 'agent' || !!agent, next: next ? next.toISOString() : null, last };
    });
    const used = (id) => schedules.filter((s) => s.agent === id).map((s) => s.id);
    const { last: _l, ...scheduler } = hb;
    // Routines of other machines (artrios/routines.yaml, e.g. the VPS) are shown read-only from their own logs.
    const here = config.routineHost ?? 'pc';
    let remote = [];
    try { remote = pulse.routines().board.filter((r) => r.host !== here); } catch { /* no home routines file */ }
    return {
      schedules: rows, agents: agents.map((a) => ({ ...a, usedBy: used(a.id), locationName: locName(a.location) })), defaultAgent: DEFAULT_AGENT,
      errors: [...sErr.map((e) => ({ ...e, kind: 'schedule' })), ...aErr.map((e) => ({ ...e, kind: 'agent' }))],
      scheduler, remote, dirs: { schedules: scheduleSvc.dir, agents: agentSvc.dir },
      locations: locations.allLocations().map((l) => ({ key: l.home ? 'artrios' : l.key, name: l.name ?? l.key, home: !!l.home })),
    };
  }
  function scheduleJobs(id) {
    const s = scheduleSvc.get(id);
    const loc = locations.locate(s.location);
    if (!loc) return { jobs: [], project: null };
    return { project: loc.key, jobs: jobs.list(loc, 300).filter((j) => j.schedule === id).slice(0, 30) };
  }
  // Optional apply hook: config.inboxOnDecide = ["program", "arg", ...] runs after every decision (no shell, fixed
  // argv from config only). The program applies the decision and may append "applied" events; the UI is told to refresh.
  const onDecide = Array.isArray(config.inboxOnDecide) && config.inboxOnDecide.length && config.inboxOnDecide.every((x) => typeof x === 'string')
    ? config.inboxOnDecide : null;
  function runOnDecide() {
    if (!onDecide) return;
    execFile(onDecide[0], onDecide.slice(1), { timeout: 30000, windowsHide: true }, (err, _out, errOut) => {
      if (err) console.error(`inboxOnDecide failed: ${err.message}${errOut ? ` | ${String(errOut).slice(0, 300)}` : ''}`);
      broadcast({ type: 'inbox', ev: 'applied-hook' });
    });
  }
  // Cognition (PRD prd-cognition): metadata next to the instance data; sessions themselves stay in the CLI store.
  const MODEL_RE = /^[A-Za-z0-9._\[\]-]{1,60}$/;
  const PROV_RE = /^[\w.\-]{1,60}$/;
  const client = clientDir ? path.resolve(clientDir) : null;

  // Sign-in routes work without a session (login) or with a session that still must change its password.
  async function authApi(req, res, parts, sess) {
    const method = req.method;
    const meta = metaOf(req);
    if (parts[1] === 'login' && method === 'POST') {
      const b = await readJson(req, 4096);
      const r = auth.login(b.name ?? USER, b.password, meta);
      if (sess) auth.logout(sess.sid);
      return send(res, 200, { user: r.user, mustChange: r.mustChange }, { 'Set-Cookie': auth.cookieHeader(r.sid) });
    }
    if (parts[1] === 'logout' && method === 'POST') {
      if (sess) { auth.logout(sess.sid); audit({ ev: 'logout', ...meta }); }
      return send(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie() });
    }
    if (!sess) return send(res, 401, { error: 'sign in first', code: 'unauthorized' });
    if (parts[1] === 'me' && method === 'GET') return send(res, 200, { user: sess.user, mustChange: sess.mustChange, minLength: MIN_PASSWORD });
    if (parts[1] === 'password' && method === 'POST') {
      const b = await readJson(req, 4096);
      return send(res, 200, auth.changePassword(sess.sid, b.current, b.next, meta));
    }
    return send(res, 404, { error: 'not found' });
  }

  function setTerminal(on, req) {
    const next = on === true;
    if (next === terminalOn) return;
    saveConfigKey('terminal', next);
    terminalOn = next;
    if (!next) { terminals.closeAll(); for (const c of wssTerm.clients) c.terminate(); }
    audit({ ev: next ? 'terminal-enable' : 'terminal-disable', ...metaOf(req) });
    broadcast({ type: 'settings', terminal: terminalOn });
  }

  async function api(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean).slice(1); // after "api"
    const method = req.method;
    if (parts[0] === 'settings' && parts[1] === 'general' && !parts[2]) {
      if (method === 'GET') return send(res, 200, { terminal: terminalOn, host: config.host ?? '127.0.0.1', port, user: USER });
      if (method === 'PUT') {
        const b = await readJson(req);
        if (b.terminal !== undefined) {
          if (typeof b.terminal !== 'boolean') throw new TaskError('invalid', 'terminal must be true or false');
          setTerminal(b.terminal, req);
        }
        return send(res, 200, { terminal: terminalOn, host: config.host ?? '127.0.0.1', port, user: USER });
      }
      return send(res, 404, { error: 'not found' });
    }
    if (parts[0] === 'settings' && parts[1] === 'git' && parts[2] === 'github') {
      if (!parts[3] && method === 'GET') return send(res, 200, gitSvc.githubLoginState());
      if (parts[3] === 'connect' && method === 'POST') { audit({ ev: 'github-connect', ...metaOf(req) }); return send(res, 200, await gitSvc.githubLogin()); }
      if (parts[3] === 'cancel' && method === 'POST') return send(res, 200, gitSvc.githubLoginCancel());
      if (parts[3] === 'disconnect' && method === 'POST') { audit({ ev: 'github-disconnect', ...metaOf(req) }); return send(res, 200, await gitSvc.githubLogout()); }
      return send(res, 404, { error: 'not found' });
    }
    if (parts[0] === 'settings' && parts[1] === 'git' && !parts[2]) {
      if (method === 'GET') return send(res, 200, await gitSvc.settings());
      if (method === 'PUT') {
        const b = await readJson(req, 4096);
        if (b.allowPush !== undefined) {
          if (typeof b.allowPush !== 'boolean') throw new TaskError('invalid', 'allowPush must be true or false');
          if (b.allowPush !== (config.git?.allowPush === true)) {
            saveConfigKey('git', { ...(config.git ?? {}), allowPush: b.allowPush });
            audit({ ev: b.allowPush ? 'git-push-enable' : 'git-push-disable', ...metaOf(req) });
          }
        }
        if (b.name !== undefined || b.email !== undefined) {
          await gitSvc.setIdentity({ name: b.name, email: b.email });
          audit({ ev: 'git-identity', ...metaOf(req) });
        }
        return send(res, 200, await gitSvc.settings());
      }
      return send(res, 404, { error: 'not found' });
    }
    if (parts[0] === 'routines' && !parts[1] && method === 'GET') return send(res, 200, routinesOverview());
    if (parts[0] === 'agents') {
      const id = parts[1];
      if (!id && method === 'POST') return send(res, 201, agentSvc.create(await readJson(req)));
      if (id && !parts[2] && method === 'GET') return send(res, 200, agentSvc.get(id));
      if (id && !parts[2] && method === 'PUT') return send(res, 200, agentSvc.update(id, await readJson(req)));
      if (id && !parts[2] && method === 'DELETE') {
        const users = scheduleSvc.list().schedules.filter((s) => s.agent === id).map((s) => s.id);
        if (users.length) throw new TaskError('conflict', `agen ini masih dipakai jadwal: ${users.join(', ')}`);
        return send(res, 200, agentSvc.remove(id));
      }
      return send(res, 404, { error: 'not found' });
    }
    if (parts[0] === 'schedules') {
      const id = parts[1];
      if (!id && method === 'POST') return send(res, 201, scheduleSvc.create(await readJson(req)));
      if (id && !parts[2] && method === 'GET') return send(res, 200, scheduleSvc.get(id));
      if (id && !parts[2] && method === 'PUT') return send(res, 200, scheduleSvc.update(id, await readJson(req)));
      if (id && !parts[2] && method === 'DELETE') return send(res, 200, scheduleSvc.remove(id));
      if (id && parts[2] === 'enabled' && method === 'POST') {
        const b = await readJson(req);
        if (typeof b.enabled !== 'boolean') throw new TaskError('invalid', 'enabled must be true or false');
        return send(res, 200, scheduleSvc.setEnabled(id, b.enabled));
      }
      if (id && parts[2] === 'jobs' && method === 'GET') return send(res, 200, scheduleJobs(id));
      if (id && parts[2] === 'run' && method === 'POST') {
        scheduleSvc.get(id); // 404 for an unknown schedule
        if (!readHeartbeat(schedDir).alive) throw new TaskError('unavailable', 'scheduler tidak menyala; jalankan `npm start` (atau `npm run scheduler`)');
        return send(res, 202, requestRun(schedDir, id, 'ui'));
      }
      return send(res, 404, { error: 'not found' });
    }
    if (parts[0] === 'activity' && method === 'GET') return send(res, 200, { events: await readCombinedFeed(projects.all(), Number(url.searchParams.get('limit')) || 100) });
    if (parts[0] === 'status' && method === 'GET') return send(res, 200, { claude: await extras.claudeStatus(), provider: providers.active(), terminal: terminalOn });
    // Picker data for Settings (main model) and Cognition (per session).
    if (parts[0] === 'models' && !parts[1] && method === 'GET') return send(res, 200, providers.options());
    if (parts[0] === 'settings' && parts[1] === 'providers') {
      if (!providers.managed) {
        if (method === 'GET') return send(res, 200, { managed: false, primary: null, providers: [] });
        throw new TaskError('conflict', 'this install has no providersFile in data/config.json; it runs the local claude CLI');
      }
      const id = parts[2];
      if (!id && method === 'GET') return send(res, 200, { managed: true, ...providers.store.list() });
      if (id === 'catalog' && !parts[3] && method === 'GET') return send(res, 200, { catalog: providers.catalog() });
      if (id === 'probe' && !parts[3] && method === 'POST') return send(res, 200, await providers.probe(await readJson(req)));
      if (id === 'main' && !parts[3] && method === 'PUT') { const b = await readJson(req); return send(res, 200, { managed: true, ...providers.store.setMain(b.provider, b.model) }); }
      if (id && parts[3] === 'models' && method === 'POST') return send(res, 200, await providers.refreshModels(id));
      if (id && !parts[3] && method === 'PUT') return send(res, 200, { managed: true, ...providers.store.put(id, await readJson(req)) });
      if (id && !parts[3] && method === 'DELETE') return send(res, 200, { managed: true, ...providers.store.remove(id) });
      if (id && parts[3] === 'primary' && method === 'POST') return send(res, 200, { managed: true, ...providers.store.setPrimary(id) });
      if (id && parts[3] === 'test' && method === 'POST') return send(res, 200, await providers.test(id, extras.claudeStatus, extras.codexStatus));
      return send(res, 404, { error: 'not found' });
    }
    if (parts[0] === 'kit' && parts[1] === 'update') {
      if (!parts[2] && method === 'GET') return send(res, 200, kitUpdate.status());
      if (parts[2] === 'check' && method === 'POST') return send(res, 200, await kitUpdate.check({ force: true }));
      if (parts[2] === 'prepare' && method === 'POST') return send(res, 200, await kitUpdate.prepare(inbox));
      if (parts[2] === 'ack' && method === 'POST') return send(res, 200, kitUpdate.ack());
      return send(res, 404, { error: 'not found' });
    }
    if (parts[0] === 'inbox') {
      const id = parts[1];
      if (!id && method === 'GET') {
        inbox.expire();
        const q = url.searchParams;
        const items = inbox.list({ status: q.get('status') ?? undefined, kind: q.get('kind') ?? undefined });
        return send(res, 200, { items, pending: inbox.pendingCount(), stale: inbox.stale().map((i) => i.id) });
      }
      if (!id && method === 'POST') return send(res, 201, inbox.create(await readJson(req)));
      if (id && parts[2] === 'decide' && method === 'POST') {
        const b = await readJson(req);
        const decided = inbox.decide(id, { by: inboxUser, decision: b.decision, note: b.note });
        runOnDecide();
        await kitUpdate.decided(inbox.get(id));
        return send(res, 200, decided);
      }
      if (id && parts[2] === 'preview' && method === 'GET') {
        const it = inbox.get(id);
        return it ? send(res, 200, inboxPreview(it)) : send(res, 404, { error: `no item ${id}` });
      }
      if (id && !parts[2] && method === 'GET') {
        const it = inbox.get(id);
        return it ? send(res, 200, it) : send(res, 404, { error: `no item ${id}` });
      }
      return send(res, 404, { error: 'not found' });
    }
    if (parts[0] === 'chat') {
      if (parts[1] === 'workspaces' && !parts[2] && method === 'GET') return send(res, 200, chat.workspaces());
      if (parts[1] === 'usage' && !parts[2] && method === 'GET') return send(res, 200, chat.usage());
      if (parts[1] === 'engines' && !parts[2] && method === 'GET') return send(res, 200, chat.engines());
      if (parts[1] === 'suggest' && !parts[2] && method === 'POST') return send(res, 200, await suggestReplies(await readJson(req)));
      const ws = parts[1];
      if (!ws) return send(res, 404, { error: 'not found' });
      if (parts[2] === 'commands' && method === 'GET') return send(res, 200, { commands: chat.commands(ws, url.searchParams.get('session')) });
      if (parts[2] === 'quick' && !parts[3] && method === 'GET') return send(res, 200, chat.quickActions(ws));
      if (parts[2] === 'quick' && parts[3] === 'pin' && method === 'POST') { const b = await readJson(req); return send(res, 200, chat.pin(ws, b.name, b.on !== false)); }
      if (parts[2] !== 'sessions') return send(res, 404, { error: 'not found' });
      const sid = parts[3];
      if (!sid && method === 'GET') return send(res, 200, { sessions: chat.list(ws) });
      if (!sid && method === 'POST') return send(res, 201, chat.create(ws, await readJson(req).catch(() => ({}))));
      if (sid && !parts[4] && method === 'GET') return send(res, 200, chat.get(ws, sid));
      if (sid && !parts[4] && method === 'PATCH') return send(res, 200, await chat.setOptions(ws, sid, await readJson(req)));
      if (sid && parts[4] === 'messages' && method === 'POST') return send(res, 202, chat.send(ws, sid, await readJson(req, 16 * 1024 * 1024)));
      if (sid && parts[4] === 'answer' && method === 'POST') return send(res, 200, chat.answer(ws, sid, await readJson(req)));
      if (sid && parts[4] === 'stop' && method === 'POST') return send(res, 200, await chat.interrupt(ws, sid));
      if (sid && parts[4] === 'fork' && method === 'POST') return send(res, 201, chat.fork(ws, sid));
      if (sid && parts[4] === 'switch' && method === 'POST') return send(res, 201, await chat.switchEngine(ws, sid, await readJson(req)));
      if (sid && parts[4] === 'close' && method === 'POST') return send(res, 200, chat.close(ws, sid));
      return send(res, 404, { error: 'not found' });
    }
    if (parts[0] === 'browse-folder' && method === 'POST') return send(res, 200, await extras.browseFolder());
    if (parts[0] === 'pulse') {
      // Separate from the overview: the task tool can take seconds, the rest of Today must not wait for it.
      if (parts[1] === 'tasks' && !parts[2] && method === 'GET') return send(res, 200, await waitingTasks.list());
      if (parts[1] === 'tasks' && parts[2] && parts[3] === 'done' && method === 'POST') {
        const b = await readJson(req).catch(() => ({}));
        const r = await waitingTasks.done(parts[2], b.hat ?? '');
        audit({ ev: 'task-done', key: parts[2], ...metaOf(req) });
        return send(res, 200, r);
      }
      if (!parts[1] && method === 'GET') {
        // "Waiting for you" = what needs the owner: pending Decision Required items (answered right there) and tasks that need
        // his own hands (config.waitingTasks, closed with Done). Nothing is guessed from logs.
        const o = pulse.overview();
        const stale = new Set(inbox.stale().map((i) => i.id));
        const pending = inbox.list({ status: 'pending' });
        o.waiting = {
          ...o.waiting,
          items: pending.slice(0, 8).map((i) => ({ id: i.id, kind: i.kind, date: String(i.ts).slice(0, 10), title: i.meta?.title ?? null, text: String(i.question).slice(0, 240), stale: stale.has(i.id), options: i.options })),
          total: pending.length,
          builtAt: new Date().toISOString(),
          stale: false,
        };
        return send(res, 200, o);
      }
      if (parts[1] === 'queue' && method === 'POST') return send(res, 201, pulse.enqueue((await readJson(req)).name));
      return send(res, 404, { error: 'not found' });
    }
    if (parts[0] === 'brain' && method === 'GET') {
      if (parts[1] === 'graph') return send(res, 200, await brain.graph(url.searchParams.get('rebuild') === '1'));
      if (parts[1] === 'node') return send(res, 200, await brain.node(url.searchParams.get('id')));
      if (parts[1] === 'reveal') return send(res, 200, await brain.reveal(url.searchParams.get('id')));
      return send(res, 404, { error: 'not found' });
    }
    if (parts[0] !== 'projects') return send(res, 404, { error: 'not found' });
    const snap = bridge.enabled ? await bridge.snapshot({ force: url.searchParams.get('refresh') === '1' }) : null;
    if (parts.length === 1 && method === 'GET') return send(res, 200, { projects: listProjects(snap), ...(bridge.enabled ? { bridge: bridge.info() } : {}) });
    // Add project (F6): plan writes nothing; the POST applies only the plan the user approved (planId).
    if (parts.length === 2 && parts[1] === 'plan' && method === 'POST') return send(res, 200, addProject.plan(await readJson(req)));
    if (parts.length === 1 && method === 'POST') {
      const b = await readJson(req);
      return send(res, 201, addProject.apply(b, b.planId));
    }
    // The Artrios home folder is not a workspace, but its schedule jobs are read through the same jobs routes.
    const home = locations.home();
    const project = projects.find(parts[1]) ?? (parts[2] === 'jobs' && method === 'GET' && home?.key === parts[1] ? home : null) ?? bridge.virtualProject(parts[1], snap);
    if (!project) return send(res, 404, { error: `unknown project: ${parts[1]}` });
    const sub = parts[2];
    if (project.bridgeOnly) {
      // No folder behind it: the board (read-only) and empty feeds, nothing that needs a workspace.
      if (sub === 'activity' && method === 'GET') return send(res, 200, { events: [] });
      if (sub === 'jobs' && !parts[3] && method === 'GET') return send(res, 200, { jobs: [] });
      if (sub === 'skills' && method === 'GET') return send(res, 200, { skills: [] });
      if (sub !== 'cards' || method !== 'GET') throw bridge.refuse(`Proyek ${project.key}`);
    }
    const svc = project.bridgeOnly ? bridge.wrap(bridge.emptySvc(project.key), project.key, snap) : bridge.wrap(projects.service(project), project.key, snap);
    if (sub === 'activity' && method === 'GET') return send(res, 200, { events: await readFeed(project, Number(url.searchParams.get('limit')) || 100) });
    if (sub === 'skills' && method === 'GET') return send(res, 200, { skills: listSkills(project, config) });
    if (sub === 'review' && method === 'GET') return send(res, 200, await extras.review(project));
    if (sub === 'open' && method === 'POST') {
      const b = await readJson(req);
      let folder = null;
      if (b.worktree) folder = (await gitSvc.find(project, String(b.worktree))).w.path;
      return send(res, 200, await extras.openIn(project, b.target, folder));
    }
    if (sub === 'changelog' && method === 'GET') return send(res, 200, await extras.changelog(project, svc, Math.min(365, Number(url.searchParams.get('days')) || 60)));
    if (sub === 'context' && method === 'GET') return send(res, 200, { files: extras.context(project) });
    if (sub === 'roadmap' && method === 'GET') return send(res, 200, extras.roadmapGet(project));
    if (sub === 'roadmap' && method === 'PUT') return send(res, 200, extras.roadmapPut(project, (await readJson(req)).text));
    if (sub === 'mcp' && method === 'GET') return send(res, 200, extras.mcp(project));
    if (sub === 'worktrees') {
      const act = parts[3];
      if (!act && method === 'GET') return send(res, 200, await gitSvc.list(project, svc));
      if (!act && method === 'POST') { const b = await readJson(req, 4096); return send(res, 201, await gitSvc.create(project, { branch: b.branch, from: b.from || null })); }
      if (act === 'remove' && method === 'POST') { const b = await readJson(req, 4096); return send(res, 200, await gitSvc.remove(project, b.path, { force: b.force === true })); }
      if (act === 'conflicts' && method === 'POST') return send(res, 200, await gitSvc.conflicts(project, (await readJson(req, 4096)).branch));
      if (act === 'merge' && method === 'POST') {
        const b = await readJson(req, 4096);
        const r = await gitSvc.merge(project, b.branch);
        if (b.card) { try { if (['human_review', 'pr_created', 'ai_review'].includes(svc.show(b.card).status)) svc.move(b.card, 'done', { by: 'ui' }); } catch { /* card gone: the merge stands */ } }
        return send(res, 200, r);
      }
      if (act === 'pr' && method === 'POST') {
        const b = await readJson(req, 4096);
        let title = b.title;
        let body = b.body ?? '';
        if (b.card) { const c = svc.show(b.card); title = title || `${c.key} ${c.title}`; body = body || `${c.key}: ${c.title}

${c.body ?? ''}`; }
        const r = await gitSvc.createPr(project, b.branch, { title, body });
        if (b.card) { try { svc.move(b.card, 'pr_created', { by: 'ui' }); } catch { /* card gone */ } }
        audit({ ev: 'git-pr', project: project.key, branch: r.branch, ...metaOf(req) });
        return send(res, 200, r);
      }
      return send(res, 404, { error: 'not found' });
    }
    if (sub === 'git') {
      if (!parts[3] && method === 'GET') return send(res, 200, await gitSvc.status(project));
      if (parts[3] === 'fetch' && method === 'POST') return send(res, 200, await gitSvc.fetch(project));
      if (parts[3] === 'pull' && method === 'POST') return send(res, 200, await gitSvc.pull(project));
      if (parts[3] === 'test' && method === 'POST') return send(res, 200, await gitSvc.testConnection(project));
      return send(res, 404, { error: 'not found' });
    }
    if (sub === 'files' && method === 'GET') return send(res, 200, await extras.files(project, url.searchParams.get('q') ?? ''));
    if (sub === 'attachments') {
      if (!parts[3] && method === 'POST') return send(res, 201, extras.saveImage(project, await readJson(req, 8 * 1024 * 1024)));
      if (parts[3] && method === 'GET') { const im = extras.readImage(project, parts[3]); return send(res, 200, im.data, { 'Content-Type': im.mime }); }
      return send(res, 404, { error: 'not found' });
    }
    if (sub === 'ideation') {
      const xid = parts[3];
      if (!xid && method === 'GET') return send(res, 200, ideation.list(project));
      if (xid === 'generate' && method === 'POST') return send(res, 200, await ideation.generate(project, await readJson(req).catch(() => ({}))));
      if (xid && !parts[4] && method === 'PATCH') return send(res, 200, ideation.setStatus(project, xid, (await readJson(req)).status));
      if (xid && parts[4] === 'convert' && method === 'POST') return send(res, 201, ideation.convert(project, xid, svc));
      return send(res, 404, { error: 'not found' });
    }
    if (sub === 'terminals') {
      if (!terminalOn) return send(res, 403, { error: 'terminals are turned off (config.terminal: false)', code: 'forbidden' });
      const tid = parts[3];
      if (!tid && method === 'GET') return send(res, 200, { terminals: terminals.list(project), max: config.maxTerminals ?? 12 });
      if (!tid && method === 'POST') {
        const b = await readJson(req).catch(() => ({}));
        const wt = b.worktree ? (await gitSvc.find(project, String(b.worktree))).w : null;
        const t = await terminals.open(project, { cols: b.cols, rows: b.rows, worktree: wt && wt.path.toLowerCase() !== path.resolve(project.path).toLowerCase() ? { path: wt.path, branch: wt.branch } : null });
        audit({ ev: 'terminal-open', project: project.key, terminal: t.id, ...metaOf(req) });
        return send(res, 201, t);
      }
      if (tid && method === 'DELETE') {
        if (terminals.get(tid).project !== project.key) return send(res, 404, { error: `unknown terminal: ${tid}` });
        const r = terminals.close(tid);
        audit({ ev: 'terminal-close', project: project.key, terminal: tid, ...metaOf(req) });
        return send(res, 200, r);
      }
      return send(res, 404, { error: 'not found' });
    }
    if (sub === 'jobs') {
      const jid = parts[3];
      if (!jid && method === 'GET') return send(res, 200, { jobs: jobs.list(project) });
      if (!jid && method === 'POST') {
        const b = await readJson(req);
        if (b.model != null && b.model !== '' && !MODEL_RE.test(String(b.model))) throw new TaskError('invalid', 'bad model name');
        if (b.card && svc.isBridged?.(b.card)) throw bridge.refuse(b.card);
        // "Run in worktree" (S11, AC 22): the card gets its own branch and worktree; the job writes only there.
        let cwd = null;
        if (b.worktree === true) {
          if (!b.card) throw new TaskError('invalid', 'run in worktree needs a card');
          svc.show(b.card); // 404 before any git work
          cwd = (await gitSvc.forCard(project, svc, b.card)).path;
        }
        // No skill: the card's own text is the prompt (a skill is optional); tools come from config.cardTools.
        if (!b.skill) {
          const text = String(b.args ?? '').trim();
          if (!text) throw new TaskError('invalid', 'a job needs a skill or a prompt');
          const tools = Array.isArray(config.cardTools) ? config.cardTools : ['Read', 'Glob', 'Grep', 'Edit', 'Write'];
          return send(res, 201, jobs.start(project, { agent: 'card', instructions: text, allowedTools: tools, card: b.card || null, svc, by: 'ui', model: b.model || null, provider: PROV_RE.test(String(b.provider ?? '')) ? b.provider : null, cwd }));
        }
        return send(res, 201, jobs.start(project, { skill: b.skill, args: b.args, card: b.card || null, svc, by: 'ui', model: b.model || null, provider: PROV_RE.test(String(b.provider ?? '')) ? b.provider : null, cwd }));
      }
      if (jid && !parts[4] && method === 'GET') return send(res, 200, jobs.show(project, jid));
      if (jid && parts[4] === 'log' && method === 'GET') return send(res, 200, { entries: jobs.log(project, jid) });
      if (jid && parts[4] === 'stop' && method === 'POST') return send(res, 200, jobs.stop(project, jid));
      return send(res, 404, { error: 'not found' });
    }
    if (sub !== 'cards') return send(res, 404, { error: 'not found' });
    const id = parts[3];
    const ctx = { by: 'ui' };
    if (!id && method === 'GET') {
      const r = svc.list({ project: project.key, status: url.searchParams.get('status') ?? undefined });
      return send(res, 200, r);
    }
    if (!id && method === 'POST') return send(res, 201, svc.create({ ...(await readJson(req)), project: project.key }, ctx));
    if (id && !parts[4] && method === 'GET') return send(res, 200, svc.show(id));
    if (id && !parts[4] && method === 'PATCH') return send(res, 200, svc.update(id, await readJson(req), ctx));
    if (id && parts[4] === 'move' && method === 'POST') return send(res, 200, svc.move(id, (await readJson(req)).status, ctx));
    if (id && parts[4] === 'note' && method === 'POST') return send(res, 200, svc.note(id, (await readJson(req)).text, ctx));
    return send(res, 404, { error: 'not found' });
  }

  async function handler(req, res) {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const denied = guard.check(req);
      if (denied) return send(res, 403, { error: `forbidden: ${denied}` });
      // The app icons carry no data: the sign-in page and the browser tab may load them before a session exists.
      if (req.method === 'GET' && PUBLIC_ICONS.has(url.pathname)) {
        const file = client ? path.join(client, url.pathname.slice(1)) : null;
        if (!file || !fs.existsSync(file)) return send(res, 404, { error: 'not found' }); // never the app shell before sign-in
        return send(res, 200, fs.readFileSync(file), { 'Content-Type': url.pathname.endsWith('.svg') ? MIME['.svg'] : MIME['.png'], 'Cache-Control': 'public, max-age=86400' });
      }
      const sess = auth.session(sidOf(req));
      const isApi = url.pathname.startsWith('/api/');
      if (isApi && url.pathname.split('/')[2] === 'auth') return await authApi(req, res, url.pathname.split('/').filter(Boolean).slice(1), sess);
      // No session: nothing but the sign-in page (HTML) or a bare 401 (API), so nothing leaks (AC 2).
      if (!sess) {
        if (isApi || req.method !== 'GET') return send(res, 401, { error: 'sign in first', code: 'unauthorized' });
        return send(res, 401, loginPage({ user: USER, minLength: MIN_PASSWORD }), { 'Content-Type': MIME['.html'] });
      }
      // First sign-in: only the password change is open until it is done (AC 4).
      if (sess.mustChange) {
        if (isApi || req.method !== 'GET') return send(res, 403, { error: 'change the password first', code: 'must_change' });
        return send(res, 200, loginPage({ mustChange: true, minLength: MIN_PASSWORD }), { 'Content-Type': MIME['.html'] });
      }
      if (isApi) return await api(req, res, url);
      if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
      return client ? serveStatic(res, client, url.pathname) : send(res, 200, FALLBACK, { 'Content-Type': MIME['.html'] });
    } catch (e) {
      if (e instanceof AuthError) return send(res, STATUS_FOR[e.code] ?? 400, { error: e.message, code: e.code, ...(e.until ? { until: e.until } : {}) });
      if (e instanceof TaskError && e.needsConfirm) return send(res, 409, { error: e.message, code: e.code, needsConfirm: true });
      if (e instanceof TaskError || e instanceof JobError || e instanceof SkillError || e instanceof TerminalError || e instanceof AddProjectError || e instanceof InboxError || e instanceof ChatError || e instanceof AgentError) return send(res, STATUS_FOR[e.code] ?? 400, { error: e.message, code: e.code });
      console.error(e);
      return send(res, 500, { error: 'internal error' });
    }
  }

  const server = http.createServer(handler);
  // Every WebSocket upgrade passes the same guard and session check as HTTP (AC 2). /ws = server push, /term/<id> = terminal.
  server.on('upgrade', (req, socket, head) => {
    const reject = (line) => { socket.write(`HTTP/1.1 ${line}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
    if (guard.check(req)) return reject('403 Forbidden');
    const sess = auth.session(sidOf(req));
    if (!sess) return reject('401 Unauthorized');
    if (sess.mustChange) return reject('403 Forbidden');
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    const m = /^\/term\/(t-[0-9a-f]{12})$/.exec(pathname);
    if (m) {
      if (!terminalOn) return reject('403 Forbidden');
      try { terminals.get(m[1]); } catch { return reject('404 Not Found'); }
      return wssTerm.handleUpgrade(req, socket, head, (ws) => attachTerminal(ws, m[1]));
    }
    if (pathname !== '/ws') return reject('404 Not Found');
    wss.handleUpgrade(req, socket, head, (ws) => { ws.on('error', () => {}); });
  });
  // Terminal socket: first message = replay of the scrollback, then live output; input and resize come back as JSON.
  function attachTerminal(ws, id) {
    ws.on('error', () => {});
    const sendJson = (msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };
    const a = terminals.attach(id, sendJson);
    sendJson({ type: 'replay', data: a.replay });
    if (a.exited) sendJson({ type: 'exit', code: a.exitCode });
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      try {
        if (m.type === 'input') terminals.write(id, m.data);
        else if (m.type === 'resize') terminals.resize(id, m.cols, m.rows);
      } catch { /* terminal closed or bad input: ignore, the exit message already told the client */ }
    });
    ws.on('close', a.detach);
  }
  const close = () => { terminals.closeAll(); for (const c of wssTerm.clients) c.terminate(); wssTerm.close(); jobs.stopAll(); chat.stopAll(); for (const c of wss.clients) c.terminate(); wss.close(); };
  return { server, guard, auth, projects, jobs, terminals, chat, close };
}
