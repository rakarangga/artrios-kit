// Update kit (AIOS-130): finds a newer release tag of the kit this UI was installed from, prepares the Putusan case,
// and starts `install.py --update TAG` in a process that outlives this server (the update stops the service this
// server runs in). Pure library: git and the process launcher are injected, so tests use a real local origin.
// Only release tags (kit-vX.Y.Z) trigger the button; commits on main beyond the last tag are information only.
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { loadJson } from './projects.js';

export const TAG_RE = /^kit-v(\d+)\.(\d+)\.(\d+)$/;
export const semver = (tag) => (TAG_RE.exec(tag) ?? []).slice(1).map(Number);
export function newer(a, b) { // is tag a newer than tag b
  const x = semver(a);
  const y = semver(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

const gitExec = (cwd, args, timeout = 30000) => new Promise((resolve, reject) => {
  execFile('git', args, { cwd, timeout, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) reject(new Error(String(stderr || err.message).trim().slice(0, 300)));
    else resolve(String(stdout));
  });
});

// Starts the updater so that it is not a child of this server: python starts it and exits, which keeps `taskkill /T`
// (the service's fallback stop) from ending it together with the UI.
const LAUNCH_CODE = 'import subprocess,sys;kw={"creationflags":0x00000008|0x00000200|0x08000000} if sys.platform=="win32" else {"start_new_session":True};subprocess.Popen([sys.executable,"install.py","--update",sys.argv[1],"--home",sys.argv[2]],cwd=sys.argv[3],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,**kw)';
function launchDetached({ python, kitRoot, tag, home }) {
  return new Promise((resolve, reject) => {
    const c = spawn(python, ['-c', LAUNCH_CODE, tag, home, kitRoot], { stdio: 'ignore', windowsHide: true });
    c.on('error', reject);
    c.on('exit', (status) => (status === 0 ? resolve() : reject(new Error(`could not start the updater (python exit ${status})`))));
  });
}

export function createKitUpdate({ kitRoot, uiDir, dataDir, home, ttlMs = 6 * 3600 * 1000, git = gitExec, launch = launchDetached, python, now = () => Date.now() }) {
  const stateFile = path.join(dataDir, 'kit-update.json');
  const resultFile = path.join(home, '.artrios', 'update-result.json');
  const py = python ?? (process.platform === 'win32' ? 'python' : 'python3');
  let cache = null; // { at, latest, unreleased, error }
  let runningSince = 0; // an update that never reports back (UI started by hand) stops counting after 15 minutes
  const isRunning = () => runningSince > 0 && now() - runningSince < 15 * 60 * 1000;

  // The button belongs to a UI installed from the kit: its root is a git checkout with install.py and the ui template.
  const enabled = () => !!kitRoot && fs.existsSync(path.join(kitRoot, 'install.py')) && fs.existsSync(path.join(kitRoot, '.git')) && fs.existsSync(path.join(kitRoot, 'ui', 'package.json'));
  const installed = () => {
    const v = loadJson(path.join(uiDir, 'package.json'), {}).version;
    return v ? `kit-v${v}` : null;
  };
  const state = () => loadJson(stateFile, {});
  const saveState = (s) => fs.writeFileSync(stateFile, `${JSON.stringify(s, null, 2)}\n`);

  async function remote() {
    const out = await git(kitRoot, ['ls-remote', '--tags', '--refs', 'origin', 'kit-v*']);
    const tags = out.split('\n').map((l) => l.split('\t')[1]?.replace('refs/tags/', '')).filter((t) => t && TAG_RE.test(t));
    tags.sort((a, b) => (newer(a, b) ? 1 : newer(b, a) ? -1 : 0));
    return tags;
  }

  async function check({ force = false } = {}) {
    if (!enabled()) return status();
    if (!force && cache && now() - cache.at < ttlMs) return status();
    try {
      const tags = await remote();
      const latest = tags.at(-1) ?? null;
      let unreleased = 0;
      if (latest) {
        try {
          await git(kitRoot, ['fetch', '--tags', '--quiet', 'origin']);
          unreleased = Number((await git(kitRoot, ['rev-list', '--count', `${latest}..origin/main`])).trim()) || 0;
        } catch { /* the count is information only */ }
      }
      cache = { at: now(), latest, tags, unreleased, error: null };
    } catch (e) {
      cache = { at: now(), latest: cache?.latest ?? null, tags: cache?.tags ?? [], unreleased: cache?.unreleased ?? 0, error: e.message };
    }
    if (force) { const s = state(); delete s.dismissed; saveState(s); }
    return status();
  }

  function status() {
    if (!enabled()) return { enabled: false };
    const cur = installed();
    const latest = cache?.latest ?? null;
    const behind = !!(latest && cur && newer(latest, cur));
    const dismissed = state().dismissed;
    let result = null;
    try { result = JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch { /* none */ }
    return {
      enabled: true, installed: cur, latest, available: behind && dismissed !== latest, behind, unreleased: cache?.unreleased ?? 0,
      checked: cache ? new Date(cache.at).toISOString() : null, error: cache?.error ?? null, running: isRunning(), result,
    };
  }

  // CHANGELOG sections newer than the installed tag, up to and including the target tag, read from the tag itself.
  async function changelog(tag) {
    const text = await git(kitRoot, ['show', `${tag}:CHANGELOG.md`]);
    const cur = installed();
    const out = [];
    let keep = false;
    for (const line of text.split('\n')) {
      const m = /^## (kit-v\d+\.\d+\.\d+)/.exec(line);
      if (m) keep = newer(m[1], cur) && !newer(m[1], tag);
      else if (/^## /.test(line)) keep = false;
      if (keep) out.push(line.replace(/^## /, ''));
    }
    return out.join('\n').trim();
  }

  const LOCAL = 'profile.md, registry.md, inbox.md, activity.md';
  async function prepare(inbox) {
    await check({ force: false });
    const s = status();
    if (!s.available) throw Object.assign(new Error('no update to offer'), { code: 'invalid' });
    const tag = s.latest;
    let notes = '';
    try { notes = await changelog(tag); } catch { notes = '(CHANGELOG not readable for this tag)'; }
    const question = `Update the kit from ${s.installed} to ${tag}?\n\n${notes || '(no CHANGELOG entry)'}`.slice(0, 4000);
    const why = `Your own files (${LOCAL}) are backed up first and put back after the switch. Skills and the UI are rebuilt; the service restarts. If anything fails, the previous version comes back.`;
    return inbox.ask({ from: 'skrip', workspace: 'artrios', subject: 'kit', topic: `update-${tag}`, question, why, options: ['Update', 'Later'], meta: { type: 'Update kit' }, contextChanged: true });
  }

  // Called after a decision on a kit-update case. Only "Update" starts anything.
  async function decided(item) {
    const m = /^artrios\/kit\/update-(kit-v\d+\.\d+\.\d+)$/.exec(item?.key ?? '');
    if (!m) return null;
    const tag = m[1];
    if (item.decision === 'Later') { saveState({ ...state(), dismissed: tag }); return { started: false }; }
    if (item.decision !== 'Update') return null;
    return run(tag);
  }

  async function run(tag) {
    if (!enabled()) throw Object.assign(new Error('kit update is not available here'), { code: 'invalid' });
    if (isRunning()) throw Object.assign(new Error('an update is already running'), { code: 'invalid' });
    if (!TAG_RE.test(tag)) throw Object.assign(new Error('not a release tag'), { code: 'invalid' });
    const tags = await remote();
    if (!tags.includes(tag)) throw Object.assign(new Error(`tag ${tag} not found`), { code: 'invalid' });
    try { fs.rmSync(resultFile, { force: true }); } catch { /* ignore */ }
    runningSince = now();
    try {
      await launch({ python: py, kitRoot, tag, home });
    } catch (e) {
      runningSince = 0;
      throw e;
    }
    return { started: true, tag };
  }

  function ack() {
    try { fs.renameSync(resultFile, resultFile.replace('.json', '.seen.json')); } catch { /* none */ }
    return status();
  }

  return { enabled, check, status, prepare, decided, run, ack, changelog };
}
