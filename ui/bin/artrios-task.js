#!/usr/bin/env node
// artrios-task: CLI over the task service. Works with or without the UI server running
// (cards are written under a file lock, so both can write safely).
// The command set matches the task tracker CLI it replaces (PRD AIOS-61 v2.1 S12 M6): list, add, move, done,
// note, due, rename, prio, show, parent, label, labels.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createTaskService, TaskError } from '../server/task-service.js';
import { appendActivity } from '../server/activity.js';
import { STATUSES, PRIORITIES, LEGACY_HATS, ownerClient } from '../server/card.js';

const HELP = `artrios-task <command> [options]

  list   [PROJ] [--status S] [--client NAME] [--label L]... [--all] [--format tracker]
                       open cards (not done, not archived) unless --all or --status; --client "" = your own cards;
                       --format tracker prints "KEY [status|priority] title (due D)" (waitingTasks config)
  show   KEY
  add    PROJ "title" [--status S] [--priority P] [--due YYYY-MM-DD] [--parent KEY] [--label L]... [--body "..."] [--client NAME]
         (also: add --project PROJ --title "...")
  move   KEY STATUS        STATUS: ${STATUSES.join(' | ')} | progress | cancelled
  done   KEY
  note   KEY "text"        appends a dated line under "## Catatan"
  due    KEY YYYY-MM-DD|none [KEY ...]
  rename KEY "new title"
  prio   KEY ${PRIORITIES.join('|')} [KEY ...]
  parent PARENT|none KEY [KEY ...]   set (or clear) the parent of cards
  label  KEY name|-name [...]        add a label, or remove it with a leading "-"
  labels                             label scheme (config "labels"): name, open card count, meaning

  Legacy forms are accepted: a leading work|self argument ("move work AIOS-1 done", "add self AIOS \\"t\\""),
  --hat work|self (work -> client from --work-client), --state for --status.

Where cards live (first match):
  --root DIR           tasks root holding <PROJ>/<PROJ-N>.md
  env ARTRIOS_TASKS_ROOT
  --instance DIR       an artrios-ui instance: tasksRoot, legacyWorkClient, labels from DIR/data/config.json and
                       workspaces from DIR/data/projects.json (env ARTRIOS_UI_HOME; default: the instance this CLI
                       is installed in, when it has data/config.json)
  ./.artrios/tasks     otherwise

Other options:
  --project-dir DIR  folder holding .artrios/project.json (default: the registered workspace, else current folder)
  --work-client S    client for the legacy hat work (default: instance legacyWorkClient, env ARTRIOS_WORK_CLIENT, "work")
  --by WHO           actor recorded in activity: skill (default) | agent | ui
  --json             machine-readable output
`;

const options = {
  root: { type: 'string' }, instance: { type: 'string' }, 'project-dir': { type: 'string' }, by: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  project: { type: 'string' }, status: { type: 'string' }, state: { type: 'string' }, hat: { type: 'string' }, client: { type: 'string' }, 'work-client': { type: 'string' }, title: { type: 'string' }, priority: { type: 'string' },
  due: { type: 'string' }, parent: { type: 'string' }, label: { type: 'string', multiple: true }, body: { type: 'string' }, all: { type: 'boolean' }, format: { type: 'string' },
};

const STATUS_ALIAS = { progress: 'in_progress', 'in-progress': 'in_progress' };
const OPEN = (c) => c.status !== 'done' && c.status !== 'archived';
const REMOVE = '\u0000remove:';

const fail = (msg) => { throw new TaskError('invalid', msg); };
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const line = (c, now) => `${c.key.padEnd(10)} ${c.status.padEnd(12)} ${c.priority.padEnd(7)} ${(c.due || '-').padEnd(10)}${c.due && c.due < now && OPEN(c) ? ' OVERDUE' : ''} ${c.title}${c.cancelled ? ' [cancelled]' : ''}${c.labels?.length ? `  #${c.labels.join(' #')}` : ''}${c.client ? `  (${c.client})` : ''}`;
// One line per card in the old tracker CLI form, read by server/waiting-tasks.js.
const trackerLine = (c) => `${c.key} [${c.cancelled ? 'cancelled' : c.status}|${c.priority}] ${c.title}${c.due ? ` (due ${c.due})` : ''}`;
const projectOf = (key) => /^([A-Z][A-Z0-9]{0,15})-[1-9]\d*$/.exec(key ?? '')?.[1] ?? fail(`bad task key: ${key}`);
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };

// "-name" after `label KEY` means "remove name"; hide it from parseArgs, which would read it as a short option.
function preprocess(argv) {
  const cmdAt = argv.findIndex((a) => !a.startsWith('-'));
  if (argv[cmdAt] !== 'label') return argv;
  return argv.map((a, i) => (i > cmdAt && /^-[^-\s]/.test(a) && a !== '-h' ? `${REMOVE}${a.slice(1)}` : a));
}

function locate(v) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const explicitRoot = v.root ?? process.env.ARTRIOS_TASKS_ROOT;
  let instanceDir = v.instance ?? process.env.ARTRIOS_UI_HOME;
  if (!instanceDir && !explicitRoot && fs.existsSync(path.join(here, '..', 'data', 'config.json'))) instanceDir = path.join(here, '..');
  const config = instanceDir ? readJson(path.join(instanceDir, 'data', 'config.json'), null) : null;
  if (instanceDir && !config) fail(`no readable data/config.json in instance ${instanceDir}`);
  const projects = instanceDir ? readJson(path.join(instanceDir, 'data', 'projects.json'), { projects: [] }).projects ?? [] : [];
  let tasksRoot = explicitRoot;
  if (!tasksRoot && config) {
    if (!config.tasksRoot) fail('the instance keeps tasks per workspace (no central tasksRoot); pass --root');
    if (config.tasksRoot.includes('{hat}')) fail(`the instance tasksRoot still uses {hat} (${config.tasksRoot}); pass --root`);
    tasksRoot = config.tasksRoot;
  }
  const projectDirArg = v['project-dir'];
  tasksRoot ??= path.join(path.resolve(projectDirArg ?? process.cwd()), '.artrios', 'tasks');
  return {
    tasksRoot: path.resolve(tasksRoot),
    projects,
    projectDirArg,
    labels: config?.labels ?? {},
    workClient: v['work-client'] ?? config?.legacyWorkClient ?? process.env.ARTRIOS_WORK_CLIENT,
    instance: Boolean(instanceDir),
  };
}

function main(argv) {
  const { values: v, positionals } = parseArgs({ args: preprocess(argv), options, allowPositionals: true });
  const [cmd, ...pos] = positionals;
  if (v.help || !cmd) { console.log(HELP); return cmd ? 0 : 1; }
  if (v.state != null) v.status ??= v.state;
  // Legacy hat as the first argument (old tracker CLI form): a filter for list, the owner for add, ignored otherwise.
  if (LEGACY_HATS.includes(pos[0]) && (cmd === 'list' || pos.length > 1)) {
    const h = pos.shift();
    if (cmd === 'add' || cmd === 'list') v.hat ??= h;
  }
  const loc = locate(v);
  const rowOf = (project) => loc.projects.find((p) => p.key === project) ?? null;

  // One service per project: activity goes to the registered workspace, which also holds project.json.
  const services = new Map();
  const svcFor = (project) => {
    if (services.has(project)) return services.get(project);
    const row = project ? rowOf(project) : null;
    const projectDir = loc.projectDirArg ? path.resolve(loc.projectDirArg) : row?.path ?? (loc.instance ? null : process.cwd());
    const emit = (e) => {
      const key = e.ref.replace(/-\d+$/, '');
      const target = rowOf(key) ?? (projectDir ? { key, path: projectDir } : null);
      if (target) appendActivity(target, e);
    };
    const svc = createTaskService({ tasksRoot: loc.tasksRoot, projectDir, workClient: loc.workClient, emit });
    services.set(project, svc);
    return svc;
  };
  const ctx = { by: v.by ?? 'skill' };
  const out = (data, text) => console.log(v.json ? JSON.stringify(data, null, 2) : text);
  const status = (s) => STATUS_ALIAS[s] ?? s;
  const need = (x, what) => x || fail(`${cmd}: ${what} missing`);

  // Owner of a new card when none is given: the registered workspace, else project.json, else existing cards.
  function defaultClient(project) {
    if (v.client != null || v.hat != null) return v.client;
    const row = rowOf(project);
    if (row) return ownerClient(row, loc.workClient);
    const { cards } = svcFor(project).list({ project });
    if (!cards.length) return undefined;
    return [...cards].sort((a, b) => String(b.updated).localeCompare(String(a.updated)))[0].client;
  }

  // The same patch on several cards; one line each.
  function each(list, patch, describe) {
    if (!list.length || !list[0]) fail(`${cmd}: card key missing`);
    const done = list.map((k) => svcFor(projectOf(k)).update(k, patch, ctx));
    out(done, done.map(describe).join('\n'));
    return 0;
  }

  switch (cmd) {
    case 'list': {
      const project = v.project ?? pos[0];
      const want = v.status ? status(v.status) : undefined;
      const { cards, broken } = svcFor(project).list({ project, status: want, client: v.client, hat: v.hat });
      const shown = cards.filter((c) => (v.all || want || OPEN(c)) && (v.label ?? []).every((l) => c.labels?.includes(l)));
      const now = today();
      if (v.format && v.format !== 'tracker') fail(`unknown format: ${v.format}`);
      const fmt = v.format === 'tracker' ? trackerLine : (c) => line(c, now);
      out({ cards: shown, broken }, [...shown.map(fmt), ...broken.map((b) => `BROKEN     ${b.file}: ${b.error}`)].join('\n') || '(no cards)');
      return broken.length ? 2 : 0;
    }
    case 'show': {
      const key = need(pos[0], 'card key');
      const c = svcFor(projectOf(key)).show(key);
      out(c, fs.readFileSync(c.file, 'utf8'));
      return 0;
    }
    case 'add': {
      const project = need(v.project ?? pos[0], 'project');
      const title = v.title ?? (v.project ? pos.join(' ') : pos.slice(1).join(' '));
      let st = v.status ? status(v.status) : undefined;
      const cancelled = st === 'cancelled';
      if (cancelled) st = 'done';
      const svc = svcFor(project);
      let c = svc.create({ project, title, status: st, priority: v.priority, due: v.due, parent: v.parent, labels: v.label, body: v.body, client: defaultClient(project), hat: v.hat }, ctx);
      if (cancelled) c = svc.update(c.key, { cancelled: true }, ctx);
      out(c, `created ${c.key}  ${c.title}${c.client ? `  (${c.client})` : ''}`);
      return 0;
    }
    case 'move':
    case 'done': {
      const key = need(pos[0], 'card key');
      const s = status(cmd === 'done' ? 'done' : need(pos[1], 'target status'));
      const c = svcFor(projectOf(key)).update(key, s === 'cancelled' ? { cancelled: true } : { status: s }, ctx);
      out(c, `${c.key} -> ${c.cancelled ? 'cancelled' : c.status}  ${c.title}`);
      return 0;
    }
    case 'note': {
      const key = need(pos[0], 'card key');
      const c = svcFor(projectOf(key)).note(key, pos.slice(1).join(' '), ctx);
      out(c, `noted ${c.key}  ${c.title}`);
      return 0;
    }
    case 'rename': {
      const key = need(pos[0], 'card key');
      const c = svcFor(projectOf(key)).update(key, { title: pos.slice(1).join(' ') }, ctx);
      out(c, `${c.key} title -> ${c.title}`);
      return 0;
    }
    case 'due': {
      const [key, date, ...more] = pos;
      need(date, 'YYYY-MM-DD or none');
      return each([key, ...more], { due: date.toLowerCase() === 'none' ? '' : date }, (c) => `${c.key} due -> ${c.due || 'none'}  ${c.title}`);
    }
    case 'prio': {
      const [key, p, ...more] = pos;
      need(p, 'priority');
      return each([key, ...more], { priority: p.toLowerCase() }, (c) => `${c.key} priority -> ${c.priority}  ${c.title}`);
    }
    case 'parent': {
      const [parent, ...children] = pos;
      need(parent, 'parent key');
      const clear = parent.toLowerCase() === 'none';
      if (!clear) svcFor(projectOf(parent)).show(parent); // the parent must exist
      if (children.includes(parent)) fail('parent: a card cannot be its own parent');
      return each(children, { parent: clear ? '' : parent }, (c) => `${c.key} parent -> ${c.parent || 'none'}  ${c.title}`);
    }
    case 'label': {
      const [key, ...names] = pos;
      need(key, 'card key');
      need(names.length, 'label name');
      const svc = svcFor(projectOf(key));
      const labels = [...(svc.show(key).labels ?? [])];
      const warn = [];
      for (const n of names) {
        if (n.startsWith(REMOVE)) {
          const at = labels.indexOf(n.slice(REMOVE.length));
          if (at >= 0) labels.splice(at, 1);
          continue;
        }
        if (!/^[\w.-]+$/.test(n)) fail(`label: bad label name: ${n}`);
        if (Object.keys(loc.labels).length && !(n in loc.labels)) warn.push(`warning: '${n}' is not in the label scheme`);
        if (!labels.includes(n)) labels.push(n);
      }
      const c = svc.update(key, { labels }, ctx);
      for (const w of warn) console.error(w);
      out(c, `${c.key} labels: ${c.labels.join(', ') || '(none)'}  ${c.title}`);
      return 0;
    }
    case 'labels': {
      const { cards } = svcFor(null).list({});
      const count = {};
      for (const c of cards.filter(OPEN)) for (const l of c.labels ?? []) count[l] = (count[l] ?? 0) + 1;
      const names = [...new Set([...Object.keys(loc.labels), ...Object.keys(count).sort()])];
      const rows = names.map((n) => ({ name: n, open: count[n] ?? 0, meaning: loc.labels[n] ?? '' }));
      out(rows, rows.map((r) => `${r.name}\t${r.open} open\t${r.meaning || '-'}`).join('\n') || '(no labels)');
      return 0;
    }
    default:
      console.error(`unknown command: ${cmd}\n\n${HELP}`);
      return 1;
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  if (e instanceof TaskError || String(e?.code).startsWith('ERR_PARSE_ARGS')) {
    console.error(`error: ${e.message}`);
    process.exitCode = 1;
  } else {
    throw e;
  }
}
