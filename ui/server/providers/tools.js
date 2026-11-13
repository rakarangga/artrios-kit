// Tools for the API engine. The CLI brings its own tools and permissions; here the app is the enforcer:
// - only tools named in allowedTools exist for the model,
// - file tools stay inside the project folder (symlinks included) and never touch .env files or .git,
// - Bash runs without a shell, only for a prefix written as Bash(prefix:*) or an exact Bash(command); bare "Bash" grants nothing.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { atomicWrite } from '../lock.js';
import { agentEnv } from '../child-env.js';
import { killTree } from '../engine.js';

const MAX_READ = 256 * 1024;
const MAX_OUTPUT = 64 * 1024;
const MAX_MATCHES = 200;
const MAX_FILES = 20000;
const MAX_GREP_FILE = 1024 * 1024;
const BASH_TIMEOUT_MS = 120 * 1000;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.artrios']);
const SHELL_CHARS = /[;&|<>`$\r\n]/;

const isEnvFile = (p) => /^\.env(\..*)?$/.test(path.basename(p));

export class ToolError extends Error {}

// Shell for the chat Bash tool: bash like the CLI (Git Bash on Windows), else the system shell.
export function shellOf(env = process.env) {
  if (env.ARTRIOS_CHAT_SHELL) return [env.ARTRIOS_CHAT_SHELL, '-c'];
  if (process.platform !== 'win32') return ['/bin/bash', '-c'];
  for (const p of [path.join(env.ProgramFiles ?? 'C:/Program Files', 'Git', 'bin', 'bash.exe'), 'C:/Program Files/Git/bin/bash.exe']) if (fs.existsSync(p)) return [p, '-c'];
  return [env.ComSpec ?? 'cmd.exe', '/d', '/s', '/c'];
}

// Double and single quotes group words; anything a shell would interpret was refused before this runs.
export function splitCommand(command) {
  const out = [];
  let cur = '';
  let quote = null;
  let started = false;
  for (const ch of String(command)) {
    if (quote) { if (ch === quote) quote = null; else cur += ch; } else if (ch === '"' || ch === "'") { quote = ch; started = true; } else if (/\s/.test(ch)) {
      if (started) { out.push(cur); cur = ''; started = false; }
    } else { cur += ch; started = true; }
  }
  if (quote) throw new ToolError('unbalanced quote in the command');
  if (started) out.push(cur);
  return out;
}

export function parseBashRules(allowedTools) {
  return allowedTools.flatMap((t) => {
    const m = /^Bash\((.+)\)$/.exec(t);
    if (!m) return [];
    const wild = m[1].endsWith(':*');
    return [{ words: splitCommand(wild ? m[1].slice(0, -2) : m[1]), wild }];
  });
}

export function bashAllowed(rules, argv) {
  return rules.some((r) => {
    if (argv.length < r.words.length || (!r.wild && argv.length !== r.words.length)) return false;
    return r.words.every((w, i) => w === argv[i]);
  });
}

// Glob to regex: ** spans folders, * and ? stay inside one path segment.
export function globRegex(glob) {
  let re = '';
  const g = String(glob).replace(/\\/g, '/');
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, process.platform === 'win32' ? 'i' : '');
}

const DEFINITIONS = {
  Read: { description: 'Read a text file in the project. Optional 1-based offset and line limit.', parameters: { type: 'object', properties: { file_path: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } }, required: ['file_path'] } },
  Grep: { description: 'Search file contents with a regular expression. Returns path:line:text.', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string', description: 'file or folder, default the project' }, glob: { type: 'string' } }, required: ['pattern'] } },
  Glob: { description: 'List project files matching a glob such as src/**/*.js.', parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } },
  Write: { description: 'Create or replace a file in the project.', parameters: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] } },
  Edit: { description: 'Replace one exact, unique string in a file.', parameters: { type: 'object', properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['file_path', 'old_string', 'new_string'] } },
  Bash: { description: 'Run one allowed command without a shell (no pipes, redirects or variables). Allowed: ', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
};

// Jobs: only allowedTools, Bash without a shell. Cognition chat (fullShell): every tool exists and Bash runs in a shell,
// because the chat asks the user per call (permission card) like the CLI does; extraRoots = folders added with /add-dir.
export function createToolbox({ cwd, allowedTools = [], env = process.env, extraRoots = [], fullShell = false }) {
  const root = fs.realpathSync(cwd);
  const roots = [root, ...extraRoots.flatMap((d) => { try { return [fs.realpathSync(d)]; } catch { return []; } })];
  const rules = parseBashRules(allowedTools);
  const names = fullShell ? Object.keys(DEFINITIONS) : Object.keys(DEFINITIONS).filter((n) => (n === 'Bash' ? rules.length > 0 : allowedTools.includes(n)));
  let current = null; // running Bash child, so Stop can kill it

  const inside = (p) => roots.some((r) => p === r || p.startsWith(r + path.sep));

  // The deepest existing parent decides, so a symlink cannot lead out for a file that does not exist yet.
  function resolve(p, { write = false } = {}) {
    if (typeof p !== 'string' || !p) throw new ToolError('a path is required');
    const abs = path.resolve(root, p);
    let probe = abs;
    let rest = '';
    while (!fs.existsSync(probe)) {
      const parent = path.dirname(probe);
      if (parent === probe) break;
      rest = path.join(path.basename(probe), rest);
      probe = parent;
    }
    const real = path.join(fs.realpathSync(probe), rest);
    const clean = real.endsWith(path.sep) ? real.slice(0, -1) : real;
    if (!inside(clean)) throw new ToolError(`outside the project folder: ${p}`);
    if (isEnvFile(clean)) throw new ToolError('.env files are off limits');
    if (write && clean.split(path.sep).includes('.git')) throw new ToolError('.git is off limits');
    return clean;
  }

  function* walk(dir) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) yield* walk(full); } else if (e.isFile() && !isEnvFile(e.name)) yield full;
    }
  }
  const rel = (p) => path.relative(root, p).split(path.sep).join('/');

  const impl = {
    Read({ file_path: f, offset, limit }) {
      const file = resolve(f);
      const size = fs.statSync(file).size;
      if (size > MAX_READ && !offset && !limit) throw new ToolError(`file is ${size} bytes; read a part with offset and limit`);
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      const from = Math.max(1, offset ?? 1);
      const to = limit ? from - 1 + limit : lines.length;
      return lines.slice(from - 1, to).map((l, i) => `${from + i}\t${l}`).join('\n').slice(0, MAX_READ);
    },
    Grep({ pattern, path: p, glob }) {
      let re;
      try { re = new RegExp(pattern); } catch { throw new ToolError('invalid regular expression'); }
      const start = p ? resolve(p) : root;
      const filter = glob ? globRegex(glob) : null;
      const files = fs.statSync(start).isFile() ? [start] : walk(start);
      const out = [];
      let seen = 0;
      for (const file of files) {
        if (++seen > MAX_FILES || out.length >= MAX_MATCHES) break;
        const name = rel(file);
        if (filter && !filter.test(name) && !filter.test(path.basename(file))) continue;
        try {
          if (fs.statSync(file).size > MAX_GREP_FILE) continue;
          const text = fs.readFileSync(file, 'utf8');
          if (text.includes('\0')) continue;
          text.split(/\r?\n/).forEach((line, i) => { if (out.length < MAX_MATCHES && re.test(line)) out.push(`${name}:${i + 1}:${line.slice(0, 300)}`); });
        } catch { /* unreadable file: skip */ }
      }
      return out.join('\n') || 'no matches';
    },
    Glob({ pattern }) {
      const re = globRegex(pattern);
      const out = [];
      let seen = 0;
      for (const file of walk(root)) {
        if (++seen > MAX_FILES || out.length >= MAX_MATCHES) break;
        if (re.test(rel(file))) out.push(rel(file));
      }
      return out.join('\n') || 'no matches';
    },
    Write({ file_path: f, content }) {
      const file = resolve(f, { write: true });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      atomicWrite(file, String(content ?? ''));
      return `wrote ${rel(file)}`;
    },
    Edit({ file_path: f, old_string: a, new_string: b }) {
      const file = resolve(f, { write: true });
      const text = fs.readFileSync(file, 'utf8');
      if (!a) throw new ToolError('old_string is empty');
      const first = text.indexOf(a);
      if (first < 0) throw new ToolError('old_string was not found');
      if (text.indexOf(a, first + a.length) >= 0) throw new ToolError('old_string is not unique');
      atomicWrite(file, text.slice(0, first) + String(b ?? '') + text.slice(first + a.length));
      return `edited ${rel(file)}`;
    },
    Bash({ command }) {
      if (typeof command !== 'string' || !command.trim()) throw new ToolError('a command is required');
      let argv;
      const opts = { shell: false };
      if (fullShell) {
        const sh = shellOf(env);
        argv = [...sh, command];
      } else {
        if (SHELL_CHARS.test(command)) throw new ToolError('shell operators are not allowed: run one plain command');
        argv = splitCommand(command);
        if (!bashAllowed(rules, argv)) throw new ToolError(`command not allowed by this skill: ${argv.slice(0, 3).join(' ')}`);
      }
      return new Promise((done) => {
        const child = spawn(argv[0], argv.slice(1), { cwd: root, env: agentEnv(env), ...opts, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
        current = child;
        let out = '';
        const add = (c) => { if (out.length < MAX_OUTPUT) out += c; };
        child.stdout.setEncoding('utf8').on('data', add);
        child.stderr.setEncoding('utf8').on('data', add);
        const timer = setTimeout(() => killTree(child.pid), BASH_TIMEOUT_MS);
        const finish = (text) => { clearTimeout(timer); current = null; done(text); };
        child.on('error', (e) => finish({ error: `could not run ${argv[0]}: ${e.message}` }));
        child.on('close', (code) => finish(code === 0 ? out.slice(0, MAX_OUTPUT) || '(no output)' : { error: `exit code ${code}\n${out.slice(0, MAX_OUTPUT)}` }));
      });
    },
  };

  return {
    definitions: () => names.map((name) => {
      const d = DEFINITIONS[name];
      if (name === 'Bash' && fullShell) return { name, description: 'Run a shell command in the project folder (bash; the user approves it unless a permission rule allows it).', parameters: d.parameters };
      const description = name === 'Bash' ? `${d.description}${rules.map((r) => r.words.join(' ') + (r.wild ? ' ...' : '')).join('; ')}` : d.description;
      return { name, description, parameters: d.parameters };
    }),
    // -> { text, isError }. A refusal goes back to the model as a tool error, never thrown past the loop.
    async run(name, args) {
      if (!names.includes(name)) return { text: `tool not allowed: ${name}`, isError: true };
      try {
        const r = await impl[name](args ?? {});
        if (r && typeof r === 'object') return { text: r.error, isError: true };
        return { text: String(r), isError: false };
      } catch (e) {
        return { text: e instanceof ToolError ? e.message : `tool failed: ${e.code ?? e.message}`, isError: true };
      }
    },
    stop() { if (current) killTree(current.pid); },
  };
}
