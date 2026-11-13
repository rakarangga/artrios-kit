// install.py and the bootstrap scripts, run for real against a throwaway clone and home folder.
// The wizard writes into its own kit folder, so these tests work on a copy, never on the kit itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PY = process.platform === 'win32' ? 'python' : 'python3';
const hasPython = spawnSync(PY, ['--version']).status === 0;
// An installed copy of the UI has no kit around it: these tests only mean something in the kit repository.
const inKit = fs.existsSync(path.join(KIT, 'install.py'));
const skipWhy = !inKit ? 'only in the kit repository' : !hasPython ? 'python not found' : false;
const opts = { skip: skipWhy };

function sandbox() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'artrios-inst-')));
  const kit = path.join(root, 'kit');
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(kit, 'artrios'), { recursive: true });
  fs.mkdirSync(home);
  for (const f of ['install.py', 'service.py']) fs.copyFileSync(path.join(KIT, f), path.join(kit, f));
  for (const f of ['core.md', 'profile.md']) fs.copyFileSync(path.join(KIT, 'artrios', f), path.join(kit, 'artrios', f));
  fs.cpSync(path.join(KIT, 'skills'), path.join(kit, 'skills'), { recursive: true });
  return { root, kit, home, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const py = (s, args, input = '') => spawnSync(PY, [path.join(s.kit, 'install.py'), '--home', s.home, ...args], { input, encoding: 'utf8', env: { ...process.env, PATH: process.env.PATH, PYTHONIOENCODING: 'utf-8' } });

// async: spawnSync would block the event loop and the fake endpoint could never answer.
function pyAsync(s, args, input) {
  return new Promise((resolve) => {
    const c = spawn(PY, [path.join(s.kit, 'install.py'), '--home', s.home, ...args], { env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    let out = '';
    c.stdout.setEncoding('utf8').on('data', (d) => { out += d; });
    c.stderr.setEncoding('utf8').on('data', (d) => { out += d; });
    c.on('close', (status) => resolve({ status, stdout: out }));
    c.stdin.end(input);
  });
}

test('dry run writes nothing; --apply installs; second run is idempotent', opts, () => {
  const s = sandbox();
  try {
    let r = py(s, []);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Dry run/);
    assert.deepEqual(fs.readdirSync(s.home), []);
    r = py(s, ['--apply']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(s.home, '.claude', 'skills', 'grill-me', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(s.home, '.codex', 'skills', 'grill-me', 'SKILL.md')));
    r = py(s, ['--apply']);
    assert.ok(!/COPY|ADD/.test(r.stdout));
    assert.equal((fs.readFileSync(path.join(s.home, '.claude', 'CLAUDE.md'), 'utf8').match(/core\.md/g) ?? []).length, 1);
  } finally { s.done(); }
});

test('uninstall: dry run first; removes identical skills and the import; keeps edited skills, the rest of CLAUDE.md, and asks about .env', opts, () => {
  const s = sandbox();
  try {
    const md = path.join(s.home, '.claude', 'CLAUDE.md');
    fs.mkdirSync(path.dirname(md), { recursive: true });
    fs.writeFileSync(md, '# my own rules\n');
    assert.equal(py(s, ['--apply']).status, 0);
    const edited = path.join(s.home, '.claude', 'skills', 'grill-me', 'SKILL.md');
    fs.appendFileSync(edited, '\nmine\n');
    fs.mkdirSync(path.join(s.home, '.claude', 'skills', 'my-own'));
    const env = path.join(s.home, '.artrios', '.env');
    fs.mkdirSync(path.dirname(env));
    fs.writeFileSync(env, 'K=v\n');

    let r = py(s, ['--uninstall']);
    assert.match(r.stdout, /Dry run/);
    assert.ok(fs.existsSync(path.join(s.home, '.claude', 'skills', 'gl')));
    assert.ok(fs.existsSync(env));

    r = py(s, ['--uninstall', '--apply'], 'n\n');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(path.join(s.home, '.claude', 'skills', 'gl')), false);
    assert.equal(fs.existsSync(path.join(s.home, '.codex', 'skills', 'grill-me')), false, 'unedited copy goes');
    assert.ok(fs.existsSync(edited), 'edited skill stays');
    assert.ok(fs.existsSync(path.join(s.home, '.claude', 'skills', 'my-own')), 'a skill the kit does not own stays');
    assert.ok(fs.existsSync(env), 'answering no keeps .env');
    assert.equal(fs.readFileSync(md, 'utf8'), '# my own rules\n');
    assert.ok(fs.existsSync(path.join(s.kit, 'artrios', 'profile.md')));

    r = py(s, ['--uninstall', '--apply', '--remove-env']);
    assert.equal(fs.existsSync(env), false);
  } finally { s.done(); }
});

// provider menu: 3 = done. UI step is answered no. Onboarding answered no.
test('wizard with no provider still installs core and skills, and says how to continue', opts, () => {
  const s = sandbox();
  try {
    const r = py(s, ['--wizard'], '3\nn\nn\n');
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.ok(fs.existsSync(path.join(s.home, '.claude', 'skills', 'grill-me', 'SKILL.md')));
    assert.match(r.stdout, /Primary provider: none/);
    assert.equal(fs.existsSync(path.join(s.kit, 'artrios', 'providers.yaml')), false);
    assert.match(fs.readFileSync(path.join(s.kit, 'artrios', 'profile.md'), 'utf8'), /\| Kit root \| .*kit \|/);
  } finally { s.done(); }
});

test('wizard --lang id speaks Indonesian and the ending says what to do without a provider', opts, () => {
  const s = sandbox();
  try {
    const r = py(s, ['--wizard', '--lang', 'id'], '3\nn\nn\n');
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /== Selesai ==/);
    assert.match(r.stdout, /Provider utama: belum ada/);
    assert.match(r.stdout, /Settings > Model/);
    assert.ok(!/== Done ==/.test(r.stdout));
    assert.ok(fs.existsSync(path.join(s.home, '.claude', 'skills', 'grill-me', 'SKILL.md')));
  } finally { s.done(); }
});

test('wizard onboarding form asks the seven questions in Indonesian and defaults the reply language', opts, () => {
  const s = sandbox();
  try {
    const answers = ['3', 'n', 'y', '', '', 'Saya pemilik toko', '.', '', '.', 'Satu, dua', '.', '', '.', '', '.', '', '.', '', '.'].join('\n') + '\n';
    const r = py(s, ['--wizard', '--lang', 'id'], answers);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /Siapa Anda, apa yang Anda tawarkan/);
    assert.match(r.stdout, /Nama Anda/);
    assert.match(fs.readFileSync(path.join(s.kit, 'artrios', 'profile.md'), 'utf8'), /\| Reply language \| Bahasa Indonesia \|/);
  } finally { s.done(); }
});

test('wizard stays English without --lang when input is piped', opts, () => {
  const s = sandbox();
  try {
    const r = py(s, ['--wizard'], '3\nn\nn\n');
    assert.match(r.stdout, /== Done ==/);
    assert.match(r.stdout, /The UI was not installed|Next: no provider yet/);
  } finally { s.done(); }
});

test('WSL: node or npm found only under /mnt/<drive>/ counts as missing; a Linux path is kept', opts, () => {
  const code = [
    'import sys, shutil',
    `sys.path.insert(0, ${JSON.stringify(KIT)})`,
    'import service',
    'service.is_wsl = lambda: True',
    'paths = {"node": "/mnt/c/Program Files/nodejs/node.exe", "npm": "/usr/bin/npm"}',
    'shutil.which = lambda n: paths.get(n)',
    'print(service.which("node"), service.which("npm"), service.HOST_ONLY)',
    'service.is_wsl = lambda: False',
    'service.HOST_ONLY.clear()',
    'print(service.which("node"))',
  ].join('\n');
  const r = spawnSync(PY, ['-c', code], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const [a, b] = r.stdout.trim().split(/\r?\n/);
  assert.match(a, /^None \/usr\/bin\/npm \{'node': '\/mnt\/c\/Program Files\/nodejs\/node\.exe'\}$/);
  assert.equal(b, '/mnt/c/Program Files/nodejs/node.exe');
});

test('wizard end to end: API provider tested against a real local endpoint, key only in .env, form writes first-day files, re-run keeps answers', opts, async () => {
  const s = sandbox();
  const seen = [];
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(b) });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: seen.length === 1 ? 'OK' : 'A short summary.' } }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  const secret = 'sk-wizard-test-secret-12345';
  try {
    const answers = [
      '2', '4', base, 'MY_KEY', 'my-gw', 'model-x', secret, // API provider, preset "other"
      '3', // done with providers
      'n', // no UI
      'y', 'Ana', 'English', // onboarding
      'Founder of a small shop.', '.', 'Hi team, numbers attached.', '.', '.', '1. Ship v2 by March\n2) Reach 100 customers', '.',
      'Bank and a spreadsheet.', '.', 'Gmail and WhatsApp.', '.', 'A shared drive.', '.', 'Weekly reports; a notebook.', '.',
    ].join('\n') + '\n';
    const r = await pyAsync(s, ['--wizard'], answers);
    assert.equal(r.status, 0, r.stdout);
    assert.ok(!r.stdout.includes(secret), 'the key is never printed');

    const yaml = fs.readFileSync(path.join(s.kit, 'artrios', 'providers.yaml'), 'utf8');
    assert.match(yaml, /^primary: my-gw$/m);
    assert.ok(yaml.includes(`"${base}"`));
    assert.ok(!yaml.includes(secret));
    assert.match(fs.readFileSync(path.join(s.home, '.artrios', '.env'), 'utf8'), new RegExp(`^MY_KEY=${secret}$`, 'm'));

    assert.equal(seen[0].url, '/v1/chat/completions');
    assert.equal(seen[0].auth, `Bearer ${secret}`);
    assert.equal(seen[0].body.model, 'model-x');
    assert.match(seen[1].body.messages[0].content, /Ship v2/, 'the summary call uses the answers');

    const read = (f) => fs.readFileSync(path.join(s.kit, f), 'utf8');
    assert.match(read('context/about-me.md'), /Founder of a small shop/);
    assert.match(read('context/about-business.md'), /Bank and a spreadsheet/);
    assert.match(read('context/priorities.md'), /^1\. Ship v2 by March\n2\. Reach 100 customers$/m);
    assert.match(read('references/voice.md'), /Hi team, numbers attached\./);
    assert.match(read('connections.md'), /\| Tasks \| Weekly reports; a notebook\. \| not yet connected/);
    assert.match(read('context/summary.md'), /A short summary\./);
    assert.match(read('artrios/profile.md'), /\| Owner name \| Ana \|/);
    assert.match(read('aios-intake.md'), /```\nGmail and WhatsApp\.\n```/);
    assert.ok(!read('aios-intake.md').includes('[Your answer here]'));

    // Same machine, second run: answers are kept, nothing is asked again, unchanged files are not rewritten.
    const again = await pyAsync(s, ['--wizard'], ['3', 'n', 'y', '', ''].join('\n') + '\n');
    assert.equal(again.status, 0, again.stdout);
    assert.match(again.stdout, /Q7: already answered, kept\./);
    assert.match(again.stdout, /Written: nothing changed/);
    assert.equal(fs.existsSync(path.join(s.kit, 'archives')), false);

    // The Node side reads what Python wrote.
    const { parseProviders } = await import('../server/providers/config.js');
    assert.equal(parseProviders(yaml).providers['my-gw'].base_url, base);
  } finally { server.close(); s.done(); }
});

test('changed answer: the old file is backed up to archives/intake-*', opts, async () => {
  const s = sandbox();
  try {
    const form = ['3', 'n', 'y', 'Ana', 'English', 'Me.', '.', 'Sample.', '.', '.', '1. One', '.', 'R', '.', 'C', '.', 'D', '.', 'T', '.'].join('\n') + '\n';
    assert.equal((await pyAsync(s, ['--wizard'], form)).status, 0);
    const intake = path.join(s.kit, 'aios-intake.md');
    fs.writeFileSync(intake, fs.readFileSync(intake, 'utf8').replace('1. One', '1. Two'));
    assert.equal((await pyAsync(s, ['--wizard'], ['3', 'n', 'y', '', ''].join('\n') + '\n')).status, 0);
    assert.match(fs.readFileSync(path.join(s.kit, 'context', 'priorities.md'), 'utf8'), /1\. Two/);
    const backups = fs.readdirSync(path.join(s.kit, 'archives'));
    assert.equal(backups.length, 1);
    assert.match(fs.readFileSync(path.join(s.kit, 'archives', backups[0], 'context', 'priorities.md'), 'utf8'), /1\. One/);
    assert.equal(fs.existsSync(path.join(s.kit, 'archives', backups[0], 'references', 'voice.md')), false, 'only what changed is backed up');
  } finally { s.done(); }
});

// A real clone from a local bare repo with a tag, as a user would get it.
function gitFixture() {
  const s = sandbox();
  const git = (...a) => { const r = spawnSync('git', a, { cwd: s.kit, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  fs.copyFileSync(path.join(KIT, 'install.sh'), path.join(s.kit, 'install.sh'));
  fs.copyFileSync(path.join(KIT, 'install.ps1'), path.join(s.kit, 'install.ps1'));
  git('init', '-q'); git('add', '-A'); git('-c', 'user.name=t', '-c', 'user.email=t@t.test', 'commit', '-qm', 'x'); git('tag', 'kit-test');
  return s;
}
const bootEnv = (s) => ({ ...process.env, ARTRIOS_KIT_REPO: s.kit, ARTRIOS_KIT_TAG: 'kit-test', ARTRIOS_KIT_DIR: path.join(s.root, 'cloned'), ARTRIOS_KIT_ARGS: `--home ${s.home}`, PYTHONIOENCODING: 'utf-8' });

test('install.ps1 clones the tag and starts the wizard; a second run reuses the clone', { skip: skipWhy || (process.platform === 'win32' ? false : 'windows only') }, () => {
  const s = gitFixture();
  try {
    const run = () => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-Content -Raw '${path.join(s.kit, 'install.ps1')}' | Invoke-Expression`], { env: bootEnv(s), input: '3\nn\nn\n', encoding: 'utf8' });
    let r = run();
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /Cloning the kit/);
    assert.match(r.stdout, /Artrios kit setup/);
    assert.ok(fs.existsSync(path.join(s.home, '.claude', 'skills', 'grill-me', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(s.root, 'cloned', 'install.py')));
    r = run();
    assert.match(r.stdout, /Using the kit in/);
  } finally { s.done(); }
});

const hasBash = spawnSync('bash', ['--version']).status === 0;
test('install.sh piped into bash clones the tag and starts the wizard', { skip: skipWhy || (hasBash ? false : 'needs bash') }, () => {
  const s = gitFixture();
  try {
    const script = fs.readFileSync(path.join(s.kit, 'install.sh'), 'utf8');
    const r = spawnSync('bash', ['-c', 'bash -s'], { input: script, env: { ...bootEnv(s), ARTRIOS_KIT_REPO: s.kit.replace(/\\/g, '/'), ARTRIOS_KIT_DIR: path.join(s.root, 'cloned').replace(/\\/g, '/'), ARTRIOS_KIT_ARGS: `--home ${s.home.replace(/\\/g, '/')}` }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /Cloning the kit/);
    assert.match(r.stdout, /Artrios kit setup/);
  } finally { s.done(); }
});

// A flag named --env-file would be taken by node itself, before the script ever runs.
test('scaffold command line accepts the keys file', { skip: inKit ? false : 'only in the kit repository' }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'artrios-sc3-'));
  try {
    const r = spawnSync(process.execPath, [path.join(KIT, 'ui', 'bin', 'scaffold.js'), '--target', path.join(tmp, 'ui'), '--kit', path.join(tmp, 'kit'), '--keys-file', path.join(tmp, 'k', '.env')], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'ui', 'data', 'config.json'), 'utf8')).envFile, path.join(tmp, 'k', '.env'));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('real kit: scaffold config names the providers file', { skip: inKit ? false : 'only in the kit repository' }, async () => {
  const { scaffold } = await import('../bin/scaffold.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'artrios-sc2-'));
  try {
    const r = await scaffold({ template: path.join(KIT, 'ui'), target: path.join(tmp, 'ui'), kit: path.join(tmp, 'kit'), envFile: path.join(tmp, 'e', '.env') });
    assert.equal(r.config.providersFile, path.join(tmp, 'kit', 'artrios', 'providers.yaml'));
    assert.equal(r.config.envFile, path.join(tmp, 'e', '.env'));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// --service: the launcher runs detached, status sees it, stop ends it cleanly through the stop file (stubbed UI, no real server).
test('--service start/status/stop/restart/remove with a stubbed UI; autostart status reads', opts, () => {
  const s = sandbox();
  try {
    const ui = path.join(s.kit, 'apps', 'artrios-ui');
    fs.mkdirSync(path.join(ui, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(ui, 'server'));
    fs.copyFileSync(path.join(KIT, 'ui', 'bin', 'start.js'), path.join(ui, 'bin', 'start.js'));
    fs.writeFileSync(path.join(ui, 'package.json'), '{"type":"module"}');
    fs.writeFileSync(path.join(ui, 'server', 'engine.js'), 'export const killTree = () => {};');
    for (const f of ['index.js', 'scheduler-main.js']) fs.writeFileSync(path.join(ui, 'server', f), 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0)); setInterval(() => {}, 1000);');
    const run = (a) => py(s, ['--service', a]);
    assert.equal(run('status').status, 3);
    let r = run('start');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(run('status').stdout, /running, pid \d+/);
    assert.match(run('start').stdout, /Already running/);
    r = run('stop');
    assert.match(r.stdout, /Stopped/);
    assert.doesNotMatch(r.stdout, /ending the process tree/);
    assert.equal(run('status').status, 3);
    assert.equal(run('restart').status, 0);
    assert.match(run('status').stdout, /running/);
    assert.equal(run('remove').status, 0);
    assert.equal(run('status').status, 3);
    assert.match(py(s, ['--autostart', 'status']).stdout, /^(on|off)/);
  } finally {
    s.done();
  }
});

test('--apply rebuilds apps/artrios-ui when the version changed, keeps data/ and config, and is a no-op when current', opts, () => {
  const s = sandbox();
  try {
    const ui = path.join(s.kit, 'ui');
    fs.mkdirSync(path.join(ui, 'bin'), { recursive: true });
    fs.copyFileSync(path.join(KIT, 'ui', 'bin', 'scaffold.js'), path.join(ui, 'bin', 'scaffold.js'));
    const pkg = (v) => JSON.stringify({ name: 'fake-ui', version: v, type: 'module', scripts: { build: 'node -e "require(\'fs\').mkdirSync(\'client/dist\',{recursive:true})"' } });
    fs.writeFileSync(path.join(ui, 'package.json'), pkg('0.2.1'));
    fs.writeFileSync(path.join(ui, 'marker.txt'), 'new');
    const target = path.join(s.kit, 'apps', 'artrios-ui');
    fs.mkdirSync(path.join(target, 'data'), { recursive: true });
    fs.writeFileSync(path.join(target, 'package.json'), pkg('0.2.0'));
    fs.writeFileSync(path.join(target, 'data', 'config.json'), '{"port":4999}\n');
    fs.writeFileSync(path.join(target, 'data', 'users.json'), '{"keep":true}\n');

    let r = py(s, []);
    assert.match(r.stdout, /would update UI 0\.2\.0 -> 0\.2\.1/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8')).version, '0.2.0', 'dry run changes nothing');

    r = py(s, ['--apply']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /UI rebuilt to 0\.2\.1/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8')).version, '0.2.1');
    assert.equal(fs.readFileSync(path.join(target, 'marker.txt'), 'utf8'), 'new');
    assert.ok(fs.existsSync(path.join(target, 'client', 'dist')));
    assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'data', 'config.json'), 'utf8')).port, 4999, 'port kept');
    assert.ok(fs.existsSync(path.join(target, 'data', 'users.json')), 'password data kept');

    r = py(s, ['--apply']);
    assert.match(r.stdout, /already current/);
  } finally { s.done(); }
});

// --update TAG: a real git origin with three tags; the kit is a clone with the fake UI built at the first tag.
const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

function updateSandbox() {
  const s = sandbox();
  const work = path.join(s.root, 'work');
  const origin = path.join(s.root, 'origin.git');
  fs.cpSync(s.kit, work, { recursive: true });
  const ui = path.join(work, 'ui');
  fs.mkdirSync(path.join(ui, 'bin'), { recursive: true });
  fs.copyFileSync(path.join(KIT, 'ui', 'bin', 'scaffold.js'), path.join(ui, 'bin', 'scaffold.js'));
  const ok = 'node -e "require(\'fs\').mkdirSync(\'client/dist\',{recursive:true})"';
  const pkg = (v, build = ok) => JSON.stringify({ name: 'fake-ui', version: v, type: 'module', scripts: { build } });
  for (const f of ['profile.md', 'registry.md', 'inbox.md', 'activity.md', 'project.md']) fs.writeFileSync(path.join(work, 'artrios', f), `template ${f}\n`);
  fs.writeFileSync(path.join(work, '.gitignore'), '/apps/\n__pycache__/\n');
  git(s.root, 'init', '-q', '-b', 'main', work);
  const release = (v, build) => {
    fs.writeFileSync(path.join(ui, 'package.json'), pkg(v, build));
    fs.writeFileSync(path.join(ui, 'marker.txt'), `ui ${v}`);
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', `release ${v}`);
    git(work, 'tag', '-a', `kit-v${v}`, '-m', `kit-v${v}`);
  };
  release('0.2.0');
  release('0.2.1');
  release('0.2.2', 'node -e "process.exit(1)"'); // a release whose UI build fails
  git(s.root, 'clone', '-q', '--bare', work, origin);
  fs.rmSync(s.kit, { recursive: true, force: true });
  git(s.root, 'clone', '-q', origin, s.kit);
  git(s.kit, 'checkout', '-q', 'kit-v0.2.0');
  const target = path.join(s.kit, 'apps', 'artrios-ui');
  fs.mkdirSync(path.join(target, 'data'), { recursive: true });
  fs.writeFileSync(path.join(target, 'package.json'), pkg('0.2.0'));
  fs.mkdirSync(path.join(target, 'client', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(target, 'data', 'config.json'), '{"port":4999}\n');
  const result = () => JSON.parse(fs.readFileSync(path.join(s.home, '.artrios', 'update-result.json'), 'utf8'));
  return { ...s, target, result, head: () => git(s.kit, 'describe', '--tags', '--exact-match') };
}

test('--update TAG: switches the tag, keeps edited local files, rebuilds the UI, backs up, reports ok', opts, () => {
  const s = updateSandbox();
  try {
    fs.writeFileSync(path.join(s.kit, 'artrios', 'profile.md'), 'my own profile\n');
    const r = py(s, ['--update', 'kit-v0.2.1']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(s.head(), 'kit-v0.2.1');
    assert.equal(fs.readFileSync(path.join(s.kit, 'artrios', 'profile.md'), 'utf8'), 'my own profile\n', 'local file kept');
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.target, 'package.json'), 'utf8')).version, '0.2.1');
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.target, 'data', 'config.json'), 'utf8')).port, 4999);
    const res = s.result();
    assert.equal(res.ok, true);
    assert.equal(res.tag, 'kit-v0.2.1');
    assert.equal(fs.readFileSync(path.join(res.backup, 'profile.md'), 'utf8'), 'my own profile\n');
  } finally { s.done(); }
});

test('--update TAG: a failing UI build rolls back to the previous tag, local files and old UI intact', opts, () => {
  const s = updateSandbox();
  try {
    fs.writeFileSync(path.join(s.kit, 'artrios', 'registry.md'), 'my registry\n');
    const r = py(s, ['--update', 'kit-v0.2.2']);
    assert.equal(r.status, 1, r.stdout);
    assert.equal(s.head(), 'kit-v0.2.0', 'back on the previous tag');
    assert.equal(fs.readFileSync(path.join(s.kit, 'artrios', 'registry.md'), 'utf8'), 'my registry\n');
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.target, 'package.json'), 'utf8')).version, '0.2.0');
    const res = s.result();
    assert.equal(res.ok, false);
    assert.equal(res.rolledBack, true);
    assert.ok(res.error);
  } finally { s.done(); }
});

test('--update TAG: refuses a dirty tree outside the local files, and a bad or unknown tag, and changes nothing', opts, () => {
  const s = updateSandbox();
  try {
    fs.appendFileSync(path.join(s.kit, 'artrios', 'core.md'), 'edited\n');
    let r = py(s, ['--update', 'kit-v0.2.1']);
    assert.equal(r.status, 1);
    assert.match(s.result().error, /artrios\/core\.md/);
    assert.equal(s.head(), 'kit-v0.2.0');
    git(s.kit, 'checkout', '--', 'artrios/core.md');
    r = py(s, ['--update', 'main']);
    assert.equal(r.status, 2);
    r = py(s, ['--update', 'kit-v9.9.9']);
    assert.equal(r.status, 1);
    assert.match(s.result().error, /not found/);
    assert.equal(s.head(), 'kit-v0.2.0');
  } finally { s.done(); }
});
