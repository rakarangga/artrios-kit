// Add project (PRD F6, B1, B3). Two steps: plan() writes nothing and returns what would change; apply() re-plans,
// refuses if the plan differs from the one the user approved (planId), then writes. No HTTP in here.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { atomicWrite, withLock } from './lock.js';
import { loadJson } from './projects.js';
import { cleanClient, ownerClient, LEGACY_HATS } from './card.js';
import { appendActivity } from './activity.js';

export class AddProjectError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // invalid | conflict
  }
}

const BEGIN_RE = /<!-- artrios:begin[^>]*-->/;
const END = '<!-- artrios:end -->';
const BEGIN = '<!-- artrios:begin (managed by /artrios-ui; edit artrios/project.md instead) -->';
const KEY_RE = /^[A-Z][A-Z0-9]{1,9}$/;
const LOCAL_FILES = ['CLAUDE.local.md', '.artrios/'];

const git = (dir, ...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

function block({ name, key, client }, projectLayer) {
  return [
    BEGIN,
    ...(projectLayer ? [`@${projectLayer.replaceAll('\\', '/')}`, ''] : []),
    '## This project (Artrios)',
    '',
    `- Name: ${name}`,
    `- Client: ${client || 'none (own)'}`,
    `- Tasks: \`${key}\` cards in \`.artrios/tasks/${key}/\` (CLI: \`artrios-task\`)`,
    END,
    '',
  ].join('\n');
}

function mergeBlock(existing, fresh) {
  const m = BEGIN_RE.exec(existing);
  const end = existing.indexOf(END);
  if (m && end > m.index) {
    const tail = existing.slice(end + END.length).replace(/^\r?\n/, '');
    return existing.slice(0, m.index) + fresh + tail;
  }
  return fresh + (existing.trim() ? `\n${existing}` : '');
}

const READMEXT = (key) => `# .artrios

Local working folder of Artrios UI for project ${key}: task cards, job logs, activity, notes.
Kept out of git through \`.git/info/exclude\`. Do not commit it and do not put secrets here.
`;

export function createAddProject({ dataDir, config = {}, now = () => new Date() }) {
  const projectsFile = path.join(dataDir, 'projects.json');
  const restricted = (config.restrictedRemotes ?? []).map((src) => new RegExp(src, 'i'));

  function normalize(input = {}) {
    const bad = (m) => { throw new AddProjectError('invalid', m); };
    if (typeof input.path !== 'string' || !path.isAbsolute(input.path.trim())) bad('path must be an absolute folder path');
    const mode = input.mode === 'new' ? 'new' : input.mode === 'existing' ? 'existing' : bad('mode must be existing or new');
    // The workspace stores only `client` (empty = the owner's own; PRD AIOS-61 v2.1 S12). Callers that still send
    // the old hat field keep working: work -> config.legacyWorkClient, self -> no client.
    let client;
    if (input.client !== undefined) {
      if (/[\u0000-\u001f]/.test(String(input.client ?? '').trim())) bad('client must be a single line');
      client = cleanClient(input.client);
      if (client === null) bad('client must be 80 characters or fewer');
    } else if (LEGACY_HATS.includes(input.hat)) {
      client = ownerClient({ hat: input.hat }, config.legacyWorkClient);
    } else {
      bad('client is required (empty for your own workspace)');
    }
    const key = String(input.key ?? '').trim().toUpperCase();
    if (!KEY_RE.test(key)) bad('key must be 2-10 characters, letters and digits, starting with a letter');
    const dir = path.resolve(input.path.trim());
    const name = String(input.name ?? '').trim() || path.basename(dir);
    return { mode, client, key, dir, name, gitInit: mode === 'new' && input.gitInit !== false };
  }

  // Returns the plan; never writes. `rejected` non-empty means apply is refused.
  function plan(input) {
    const n = normalize(input);
    const rejected = [];
    const warnings = [];
    const writes = [];
    const registered = loadJson(projectsFile, { projects: [] }).projects ?? [];
    const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

    const dup = registered.find((p) => p.key === n.key);
    if (dup) rejected.push(`Key ${n.key} is already used by ${dup.name ?? dup.key} (keys are never reused).`);
    const dupPath = registered.find((p) => samePath(p.path, n.dir));
    if (dupPath) rejected.push(`This folder is already registered as ${dupPath.key}.`);

    let isGit = false;
    let remotes = [];
    const exists = isDir(n.dir);
    if (n.mode === 'existing') {
      if (!exists) rejected.push('Folder does not exist. Use mode new to create it.');
    } else if (exists && fs.readdirSync(n.dir).length > 0) {
      rejected.push('Folder already exists and is not empty. Use mode existing.');
    } else if (!exists && !isDir(path.dirname(n.dir))) {
      rejected.push('Parent folder does not exist.');
    }
    if (exists && n.mode === 'existing') {
      isGit = git(n.dir, 'rev-parse', '--git-dir').status === 0;
      if (isGit) {
        remotes = git(n.dir, 'remote', '-v').stdout.split('\n').filter(Boolean).map((l) => l.split(/\s+/)[1]).filter(Boolean);
        const tracked = LOCAL_FILES.filter((f) => git(n.dir, 'ls-files', '--', f.replace(/\/$/, '')).stdout.trim());
        if (tracked.length) rejected.push(`Already tracked in the project repo: ${tracked.join(', ')}. Ask the owner first.`);
      } else {
        warnings.push('Not a git repo: nothing to exclude, so Artrios files are not protected from a later git init + add.');
      }
    }
    if (n.mode === 'new') isGit = n.gitInit;
    // B1: a workspace with no client (the owner's own) is refused for remotes that match config.restrictedRemotes
    // (regex sources, case-insensitive).
    if (!n.client && restricted.length) {
      const hit = remotes.filter((r) => restricted.some((re) => re.test(r)));
      if (hit.length) rejected.push(`A workspace with no client is refused: remote points to restricted territory (${hit.join(', ')}). Personal content never enters those repos.`);
    }

    const steps = [];
    if (n.mode === 'new' && !exists) steps.push(`create folder ${n.dir}`);
    if (n.mode === 'new' && n.gitInit) steps.push('git init');

    // CLAUDE.local.md
    const localFile = path.join(n.dir, 'CLAUDE.local.md');
    const localOld = read(localFile) ?? '';
    const localNew = mergeBlock(localOld, block(n, config.projectLayerFile));
    writes.push({ file: localFile, action: !localOld ? 'create' : localNew === localOld ? 'unchanged' : 'update', before: localOld, after: localNew });

    // .artrios/
    const aDir = path.join(n.dir, '.artrios');
    const readme = path.join(aDir, 'README.md');
    writes.push({ file: readme, action: fs.existsSync(readme) ? 'unchanged' : 'create', before: read(readme) ?? '', after: read(readme) ?? READMEXT(n.key) });
    const pjFile = path.join(aDir, 'project.json');
    const pjOld = read(pjFile);
    if (pjOld !== null) {
      let stored = null;
      try { stored = JSON.parse(pjOld); } catch { rejected.push('.artrios/project.json exists but is not valid JSON. Fix it by hand first.'); }
      if (stored && stored.key && stored.key !== n.key) rejected.push(`.artrios/project.json already belongs to key ${stored.key}.`);
      writes.push({ file: pjFile, action: 'unchanged', before: pjOld, after: pjOld });
    } else {
      const doc = { key: n.key, name: n.name, client: n.client, registered: now().toISOString(), remote: remotes[0] ?? '', nextIndex: 1, schema: 1 };
      writes.push({ file: pjFile, action: 'create', before: '', after: `${JSON.stringify(doc, null, 2)}\n` });
    }

    // .git/info/exclude (appended lines only)
    if (isGit) {
      let exclude = path.join(n.dir, '.git', 'info', 'exclude');
      let prefix = '';
      if (n.mode === 'existing') {
        const p = git(n.dir, 'rev-parse', '--git-path', 'info/exclude').stdout.trim();
        exclude = path.isAbsolute(p) ? p : path.join(n.dir, p);
        prefix = git(n.dir, 'rev-parse', '--show-prefix').stdout.trim();
      }
      const old = read(exclude) ?? '';
      const have = new Set(old.split(/\r?\n/));
      const lines = LOCAL_FILES.map((f) => `/${prefix}${f}`).filter((l) => !have.has(l));
      writes.push({ file: exclude, action: lines.length ? 'append' : 'unchanged', lines, before: old, after: lines.length ? `${old.replace(/\n?$/, '\n')}# Artrios UI\n${lines.join('\n')}\n` : old });
    }

    // projects.json (instance list)
    const row = { key: n.key, name: n.name, client: n.client, path: n.dir };
    writes.push({ file: projectsFile, action: 'append-row', row, before: '', after: JSON.stringify(row) });

    const planId = crypto.createHash('sha256')
      .update(JSON.stringify({ n, steps, rejected, w: writes.map((w) => [w.file, w.action, w.action === 'append' ? w.lines : w.action === 'unchanged' ? '' : w.after.replace(/"registered":\s*"[^"]*"/, '')]) }))
      .digest('hex').slice(0, 16);
    return { planId, input: { path: n.dir, mode: n.mode, client: n.client, key: n.key, name: n.name, gitInit: n.gitInit }, isGit, remotes, steps, warnings, rejected, writes };
  }

  function apply(input, planId) {
    const p = plan(input);
    if (p.rejected.length) throw new AddProjectError('invalid', p.rejected.join(' '));
    if (!planId || planId !== p.planId) throw new AddProjectError('conflict', 'The plan changed since it was shown. Review the new plan and approve again.');
    const n = p.input;
    if (!isDir(n.path)) fs.mkdirSync(n.path, { recursive: true });
    if (n.mode === 'new' && n.gitInit) {
      const r = git(n.path, 'init');
      if (r.status !== 0) throw new AddProjectError('invalid', `git init failed: ${r.stderr.trim()}`);
    }
    for (const w of p.writes) {
      if (w.action === 'unchanged' || w.action === 'append-row') continue;
      fs.mkdirSync(path.dirname(w.file), { recursive: true });
      if (w.action === 'append') {
        const current = read(w.file) ?? '';
        const have = new Set(current.split(/\r?\n/));
        const lines = w.lines.filter((l) => !have.has(l));
        if (lines.length) fs.appendFileSync(w.file, `${current && !current.endsWith('\n') ? '\n' : ''}# Artrios UI\n${lines.join('\n')}\n`);
      } else {
        atomicWrite(w.file, w.after);
      }
    }
    const row = p.writes.find((w) => w.action === 'append-row').row;
    fs.mkdirSync(dataDir, { recursive: true });
    withLock(path.join(dataDir, '.projects-lock'), () => {
      const doc = loadJson(projectsFile, { projects: [] });
      doc.projects = [...(doc.projects ?? []), row];
      atomicWrite(projectsFile, `${JSON.stringify(doc, null, 2)}\n`);
    });
    appendActivity(row, { ts: now().toISOString(), type: 'project.added', ref: row.key, by: 'ui', detail: `${row.client ? `client ${row.client}` : 'own'} ${p.isGit ? 'git' : 'no-git'}` });
    return { project: row, written: p.writes.filter((w) => !['unchanged', 'append-row'].includes(w.action)).map((w) => w.file) };
  }

  return { plan, apply };
}
