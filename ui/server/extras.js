// Read-mostly helpers behind the extra screens: review summary, open in VS Code, changelog, context, roadmap file,
// MCP overview, worktrees, file search, image attachments, folder picker, Claude Code status.
// No HTTP here. Everything runs inside a registered project folder; user text never reaches a shell.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, spawn as realSpawn } from 'node:child_process';
import { TaskError } from './task-service.js';
import { redact } from './job-runner.js';
import { atomicWrite } from './lock.js';

const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n)}…` : String(s));
const git = (dir, args, timeout = 8000) => new Promise((resolve) => {
  execFile('git', ['-C', dir, ...args], { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, out) => resolve(err ? null : out));
});
const artrios = (project, ...p) => path.join(project.path, '.artrios', ...p);

const CONTEXT_FILES = ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', path.join('.artrios', 'README.md'), path.join('.artrios', 'project.json')];
const ROADMAP_TEMPLATE = '# Roadmap\n\n## Now\n\n- [ ] \n\n## Next\n\n- [ ] \n\n## Later\n\n- [ ] \n';
const IMAGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const MAX_IMAGE = 4 * 1024 * 1024;

export function createExtras({ config = {}, spawn = realSpawn } = {}) {
  // ---- review summary for a project folder (Human Review panel)
  async function review(project) {
    const dir = project.path;
    const inside = await git(dir, ['rev-parse', '--is-inside-work-tree']);
    if (!inside || inside.trim() !== 'true') return { git: false };
    const [branch, head, status, numstat, log] = await Promise.all([
      git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
      git(dir, ['rev-parse', '--short', 'HEAD']),
      git(dir, ['status', '--porcelain=v1', '-uall']),
      git(dir, ['diff', '--numstat', 'HEAD']),
      git(dir, ['log', '-5', '--pretty=format:%h%x1f%cs%x1f%s']),
    ]);
    const stat = new Map();
    for (const l of (numstat ?? '').split('\n').filter(Boolean)) {
      const [a, d, ...rest] = l.split('\t');
      stat.set(rest.join('\t'), { added: a === '-' ? null : Number(a), deleted: d === '-' ? null : Number(d) });
    }
    const files = (status ?? '').split('\n').filter(Boolean).filter((l) => !l.slice(3).replace(/^"/, '').startsWith('.artrios/')).slice(0, 200).map((l) => {
      const raw = l.slice(0, 2).trim();
      const code = raw === '??' ? '?' : raw || '?';
      const file = l.slice(3).replace(/^"|"$/g, '');
      return { path: file, code, ...(stat.get(file) ?? { added: null, deleted: null }) };
    });
    const totals = files.reduce((t, f) => ({ added: t.added + (f.added ?? 0), deleted: t.deleted + (f.deleted ?? 0) }), { added: 0, deleted: 0 });
    return {
      git: true,
      branch: (branch ?? '').trim(),
      head: (head ?? '').trim(),
      files,
      totals: { files: files.length, ...totals },
      commits: (log ?? '').split('\n').filter(Boolean).map((l) => { const [hash, date, subject] = l.split('\x1f'); return { hash, date, subject }; }),
    };
  }

  // ---- open a folder in VS Code or the file manager. The path is quoted by us, never by user text.
  // Resolves once the launcher has failed (error or non-zero exit) or has run ~1.5 s without failing, so a missing
  // `code` command is reported to the user instead of a silent 200.
  function launched(child) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok, reason) => { if (!done) { done = true; resolve({ ok, reason }); } };
      if (!child) return finish(false, 'no launcher');
      child.once('error', (e) => finish(false, e.message));
      child.once('exit', (code) => finish(code === 0, `exit ${code}`));
      setTimeout(() => finish(true, 'running'), 1500).unref?.();
      child.unref?.();
    });
  }

  async function openIn(project, target, folder = null) {
    const dir = path.resolve(folder ?? project.path);
    if (/["&|<>^%\r\n]/.test(dir)) throw new TaskError('invalid', 'the folder path has characters that cannot be opened safely');
    if (!fs.existsSync(dir)) throw new TaskError('not_found', `folder not found: ${dir}`);
    let child;
    const win = process.platform === 'win32';
    if (target === 'vscode') child = win ? spawn(`code "${dir}"`, [], { shell: true, detached: true, stdio: 'ignore', windowsHide: true }) : spawn('code', [dir], { detached: true, stdio: 'ignore' });
    else if (target === 'folder') child = win ? spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }) : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [dir], { detached: true, stdio: 'ignore' });
    else throw new TaskError('invalid', 'target must be vscode or folder');
    const result = await launched(child);
    if (!result.ok) throw new TaskError('unavailable', target === 'vscode' ? `could not start VS Code (is the 'code' command on PATH?): ${result.reason}` : `could not open the folder: ${result.reason}`);
    return { ok: true, target, folder: dir };
  }

  // ---- changelog draft: git log of the last days plus finished cards
  async function changelog(project, svc, days = 60) {
    const out = await git(project.path, ['log', `--since=${days}.days`, '-n300', '--pretty=format:%h%x1f%cs%x1f%s']);
    const commits = (out ?? '').split('\n').filter(Boolean).map((l) => { const [hash, date, subject] = l.split('\x1f'); return { hash, date, subject }; });
    const { cards } = svc.list({ project: project.key });
    const done = cards.filter((c) => c.status === 'done' || c.status === 'archived').map((c) => ({ key: c.key, title: c.title, date: String(c.updated ?? '').slice(0, 10), archived: c.status === 'archived' }));
    return { days, commits, done };
  }

  // ---- context: the files the agent reads for this project (fixed list, read only, secrets masked)
  function context(project) {
    const candidates = CONTEXT_FILES.map((rel) => ({ name: rel.replaceAll('\\', '/'), file: path.join(project.path, rel) }));
    if (config.projectLayerFile) candidates.push({ name: `${path.basename(config.projectLayerFile)} (shared layer)`, file: config.projectLayerFile });
    return candidates.flatMap(({ name, file }) => {
      try {
        const st = fs.statSync(file);
        if (!st.isFile()) return [];
        return [{ name, size: st.size, text: redact(fs.readFileSync(file, 'utf8').slice(0, 30000)) }];
      } catch { return []; }
    });
  }

  // ---- roadmap: one Markdown file the user edits
  const roadmapFile = (project) => artrios(project, 'roadmap.md');
  function roadmapGet(project) {
    try { return { text: fs.readFileSync(roadmapFile(project), 'utf8'), exists: true }; } catch { return { text: ROADMAP_TEMPLATE, exists: false }; }
  }
  function roadmapPut(project, text) {
    if (typeof text !== 'string') throw new TaskError('invalid', 'text must be a string');
    if (text.length > 200000) throw new TaskError('invalid', 'roadmap is too large (200 KB max)');
    fs.mkdirSync(artrios(project), { recursive: true });
    atomicWrite(roadmapFile(project), text.endsWith('\n') ? text : `${text}\n`);
    return { ok: true };
  }

  // ---- MCP overview: servers named in the project's .mcp.json. Names and kind only: env and headers are never read out.
  function mcp(project) {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(path.join(project.path, '.mcp.json'), 'utf8')); } catch { return { file: false, servers: [] }; }
    const entries = Object.entries(raw.mcpServers ?? {});
    const servers = entries.map(([name, s]) => {
      let where = '';
      if (s?.url) { try { where = new URL(s.url).host; } catch { where = ''; } } else if (s?.command) where = path.basename(String(s.command));
      return { name, type: s?.type ?? (s?.url ? 'http' : 'stdio'), where };
    });
    return { file: true, servers };
  }

  // ---- worktrees of the project's repository (read only)
  async function worktrees(project) {
    const out = await git(project.path, ['worktree', 'list', '--porcelain']);
    if (!out) return { git: false, worktrees: [] };
    const blocks = out.split(/\r?\n\r?\n/).filter(Boolean).map((b) => {
      const o = {};
      for (const l of b.split(/\r?\n/)) { const [k, ...v] = l.split(' '); o[k] = v.join(' '); }
      return { path: path.resolve(o.worktree ?? ''), head: String(o.HEAD ?? '').slice(0, 7), branch: o.branch ? o.branch.replace('refs/heads/', '') : (o.detached !== undefined ? '(detached)' : '') };
    });
    const list = await Promise.all(blocks.map(async (w) => {
      const st = await git(w.path, ['status', '--porcelain']);
      return { ...w, changes: st === null ? null : st.split('\n').filter(Boolean).length };
    }));
    return { git: true, worktrees: list };
  }

  // ---- file search for "@" mentions and Browse Files
  async function files(project, q = '') {
    let out = await git(project.path, ['ls-files', '-co', '--exclude-standard']);
    if (out === null) out = walk(project.path).join('\n');
    const t = String(q).trim().toLowerCase();
    const list = out.split('\n').filter(Boolean).filter((f) => !t || f.toLowerCase().includes(t));
    return { files: list.slice(0, 40), more: Math.max(0, list.length - 40) };
  }
  function walk(root, rel = '', depth = 0, acc = []) {
    if (depth > 3 || acc.length > 3000) return acc;
    let names = [];
    try { names = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return acc; }
    for (const e of names) {
      if (['node_modules', '.git', '.artrios'].includes(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(root, r, depth + 1, acc); else acc.push(r);
    }
    return acc;
  }

  // ---- pasted images: saved under .artrios/attachments, referenced from the task text
  function saveImage(project, { type, data }) {
    const ext = IMAGE_EXT[type];
    if (!ext) throw new TaskError('invalid', 'only png, jpeg, webp and gif images are accepted');
    const buf = Buffer.from(String(data ?? ''), 'base64');
    if (!buf.length) throw new TaskError('invalid', 'empty image');
    if (buf.length > MAX_IMAGE) throw new TaskError('invalid', 'image is larger than 4 MB');
    const name = `a-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}.${ext}`;
    fs.mkdirSync(artrios(project, 'attachments'), { recursive: true });
    fs.writeFileSync(artrios(project, 'attachments', name), buf);
    return { name, path: `.artrios/attachments/${name}` };
  }
  function readImage(project, name) {
    if (!/^a-[a-z0-9]+-[0-9a-f]{6}\.(png|jpg|webp|gif)$/.test(name)) throw new TaskError('invalid', 'bad attachment name');
    const file = artrios(project, 'attachments', name);
    if (!fs.existsSync(file)) throw new TaskError('not_found', 'attachment not found');
    const mime = Object.entries(IMAGE_EXT).find(([, e]) => e === name.split('.').pop())[0];
    return { mime, data: fs.readFileSync(file) };
  }

  // ---- native folder picker (Windows). The server runs on the user's own PC, so the dialog opens on their screen.
  function browseFolder() {
    return new Promise((resolve, reject) => {
      if (process.platform !== 'win32') return reject(new TaskError('unavailable', 'the folder picker is only available on Windows; type the path instead'));
      // The picker runs in a hidden PowerShell process, so Windows would open it behind the browser. A tiny invisible
      // always-on-top owner window makes the dialog appear in front.
      const script = [
        'Add-Type -AssemblyName System.Windows.Forms',
        'Add-Type -AssemblyName System.Drawing',
        '$o = New-Object System.Windows.Forms.Form',
        '$o.TopMost = $true; $o.ShowInTaskbar = $false; $o.FormBorderStyle = "None"; $o.Opacity = 0; $o.StartPosition = "CenterScreen"; $o.Size = New-Object System.Drawing.Size(1, 1)',
        '$o.Show(); $o.Activate()',
        '$d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = "Choose the project folder"',
        'if ($d.ShowDialog($o) -eq "OK") { $d.SelectedPath }',
        '$o.Close()',
      ].join('; ');
      execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { timeout: 180000, windowsHide: false }, (err, out) => {
        if (err) return reject(new TaskError('unavailable', 'could not open the folder picker; type the path instead'));
        const p = out.trim();
        resolve({ path: p || null });
      });
    });
  }

  // ---- Claude Code status for the sidebar (cached for a minute)
  let cached = null;
  function claudeStatus() {
    if (cached && Date.now() - cached.at < 60000) return Promise.resolve(cached.value);
    return new Promise((resolve) => {
      execFile(config.claudePath ?? 'claude', [...(config.claudeBaseArgs ?? []), '--version'], { timeout: 6000, windowsHide: true }, (err, out) => {
        const value = err ? { ok: false } : { ok: true, version: clip(String(out).trim().split('\n')[0], 60) };
        cached = { at: Date.now(), value };
        resolve(value);
      });
    });
  }

  // The same check for the Codex CLI (Settings > Model test button), cached for a minute.
  let codexCached = null;
  function codexStatus() {
    if (codexCached && Date.now() - codexCached.at < 60000) return Promise.resolve(codexCached.value);
    return new Promise((resolve) => {
      execFile(config.codexPath ?? 'codex', ['--version'], { timeout: 6000, windowsHide: true }, (err, out) => {
        const value = err ? { ok: false } : { ok: true, version: clip(String(out).trim().split('\n')[0], 60) };
        codexCached = { at: Date.now(), value };
        resolve(value);
      });
    });
  }

  return { review, openIn, changelog, context, roadmapGet, roadmapPut, mcp, worktrees, files, saveImage, readImage, browseFolder, claudeStatus, codexStatus };
}
