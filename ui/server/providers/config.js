// Provider settings: artrios/providers.yaml (no secrets) and the user's .env (keys only).
// The YAML is a fixed two-level subset, also written by install.py, so no YAML dependency is needed:
//   primary: my-gateway
//   providers:
//     my-gateway:
//       transport: chat_completions
//       base_url: "https://example.test/v1"
//       key_env: MY_GATEWAY_KEY
//       model: "some/model"
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWrite } from '../lock.js';
import { TaskError } from '../task-service.js';

export const TRANSPORTS = ['chat_completions', 'claude_cli', 'codex_cli'];
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const KEY_ENV_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const FIELDS = ['transport', 'base_url', 'key_env', 'model', 'models', 'price_in', 'price_out', 'context_window'];
// Optional per provider (PRD Cognition T13): price_in/price_out = USD per 1M tokens, context_window = tokens,
// models = more model names for the Cognition picker, comma separated.
const NUM_FIELDS = ['price_in', 'price_out', 'context_window'];

const unquote = (v) => {
  const s = v.trim();
  if (s.startsWith('"')) { try { return JSON.parse(s); } catch { return s.slice(1, -1); } }
  return s;
};

export function parseProviders(text) {
  const out = { primary: null, providers: {} };
  let inProviders = false;
  let current = null;
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const m = /^(\s*)([A-Za-z0-9_-]+):\s*(.*)$/.exec(raw);
    if (!m) continue;
    const depth = m[1].length;
    if (depth === 0) {
      inProviders = m[2] === 'providers';
      current = null;
      if (m[2] === 'primary') out.primary = unquote(m[3]) || null;
    } else if (inProviders && depth === 2) {
      current = m[2];
      out.providers[current] = {};
    } else if (inProviders && current && depth >= 4 && FIELDS.includes(m[2])) {
      out.providers[current][m[2]] = unquote(m[3]);
    }
  }
  return out;
}

export function stringifyProviders({ primary, providers }) {
  const lines = ['# Written by the Artrios installer and Settings > Model. No secrets here: keys live in .env.', `primary: ${primary ?? ''}`.trimEnd(), 'providers:'];
  for (const [id, p] of Object.entries(providers)) {
    lines.push(`  ${id}:`);
    for (const f of FIELDS) if (p[f]) lines.push(`    ${f}: ${JSON.stringify(p[f])}`);
  }
  return `${lines.join('\n')}\n`;
}

export function parseEnv(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

export const defaultEnvFile = () => path.join(os.homedir(), '.artrios', '.env');

// Set or replace one key, keeping every other line. Owner-only permissions where the OS has them.
function setEnvKey(file, name, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l, i, a) => l || i < a.length - 1) : [];
  const line = `${name}=${value}`;
  const at = lines.findIndex((l) => new RegExp(`^\\s*(export\\s+)?${name}=`).test(l));
  if (at >= 0) lines[at] = line; else lines.push(line);
  atomicWrite(file, `${lines.join('\n')}\n`);
  try { fs.chmodSync(file, 0o600); } catch { /* not supported on this file system */ }
}

export const numOf = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
export const modelsOf = (p) => [...new Set([p?.model, ...String(p?.models ?? '').split(',')].map((m) => String(m ?? '').trim()).filter(Boolean))];

// Optional fields shared by both transports; an empty value removes the field.
function optional(p, body) {
  for (const f of NUM_FIELDS) {
    if (body[f] === undefined || body[f] === null || body[f] === '') continue;
    const n = Number(body[f]);
    if (!Number.isFinite(n) || n < 0) throw new TaskError('invalid', `${f} must be a number of zero or more`);
    p[f] = String(n);
  }
  if (body.models !== undefined && body.models !== null && String(body.models).trim()) {
    const list = (Array.isArray(body.models) ? body.models : String(body.models).split(',')).map((m) => String(m).trim()).filter(Boolean);
    if (list.some((m) => !/^[A-Za-z0-9._:/@\[\]-]{1,120}$/.test(m))) throw new TaskError('invalid', 'model names: letters, digits and . _ : / @ - only');
    p.models = list.join(',');
  }
}

export function createProviderStore({ file, envFile = defaultEnvFile() }) {
  const load = () => {
    try { return parseProviders(fs.readFileSync(file, 'utf8')); } catch (e) {
      if (e.code === 'ENOENT') return { primary: null, providers: {} };
      throw e;
    }
  };
  const save = (data) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    atomicWrite(file, stringifyProviders(data));
  };
  const env = () => { try { return parseEnv(fs.readFileSync(envFile, 'utf8')); } catch { return {}; } };
  const keyOf = (provider) => (provider?.key_env ? env()[provider.key_env] ?? process.env[provider.key_env] ?? null : null);

  // What the browser may see: never the key itself.
  function list() {
    const { primary, providers } = load();
    return {
      primary,
      providers: Object.entries(providers).map(([id, p]) => ({
        id, transport: p.transport, base_url: p.base_url ?? '', key_env: p.key_env ?? '', model: p.model ?? '', hasKey: !!keyOf(p),
        models: modelsOf(p), price_in: numOf(p.price_in), price_out: numOf(p.price_out), context_window: numOf(p.context_window),
      })),
    };
  }

  // One provider becomes primary only by explicit choice, except the first one: alone, it is the primary (Q8).
  function put(id, body = {}) {
    if (!ID_RE.test(id ?? '')) throw new TaskError('invalid', 'provider name: lowercase letters, digits and dashes');
    if (['catalog', 'probe', 'main'].includes(id)) throw new TaskError('invalid', `"${id}" is a reserved name`);
    const transport = body.transport;
    if (!TRANSPORTS.includes(transport)) throw new TaskError('invalid', `transport must be one of ${TRANSPORTS.join(', ')}`);
    const p = { transport };
    if (transport === 'chat_completions') {
      let url;
      try { url = new URL(String(body.base_url ?? '')); } catch { throw new TaskError('invalid', 'base URL is not a valid URL'); }
      if (!['http:', 'https:'].includes(url.protocol)) throw new TaskError('invalid', 'base URL must be http or https');
      const model = String(body.model ?? '').trim();
      if (!model) throw new TaskError('invalid', 'model is required for this provider');
      p.base_url = String(body.base_url).replace(/\/+$/, '');
      p.model = model;
      if (body.key_env) {
        if (!KEY_ENV_RE.test(body.key_env)) throw new TaskError('invalid', 'key variable: uppercase letters, digits and underscores');
        p.key_env = body.key_env;
      }
      if (body.apiKey) {
        if (!p.key_env) throw new TaskError('invalid', 'a key needs a key variable name');
        if (/[\r\n]/.test(body.apiKey)) throw new TaskError('invalid', 'the key has a line break');
        setEnvKey(envFile, p.key_env, String(body.apiKey).trim());
      }
    } else if (body.model) {
      p.model = String(body.model).trim();
    }
    optional(p, body);
    const data = load();
    data.providers[id] = p;
    if (!data.primary || Object.keys(data.providers).length === 1) data.primary = id;
    save(data);
    return list();
  }

  // The key stays in .env: another provider may share it, and the uninstaller asks about that file.
  function remove(id) {
    const data = load();
    if (!data.providers[id]) throw new TaskError('not_found', `unknown provider: ${id}`);
    delete data.providers[id];
    const left = Object.keys(data.providers);
    if (left.length === 1) data.primary = left[0];
    else if (data.primary === id) data.primary = null;
    save(data);
    return list();
  }

  function setPrimary(id) {
    const data = load();
    if (!data.providers[id]) throw new TaskError('not_found', `unknown provider: ${id}`);
    data.primary = id;
    save(data);
    return list();
  }

  // Main model ("Main model": provider + model for skills, jobs and new chats) in one write.
  function setMain(id, model) {
    const data = load();
    const p = data.providers[id];
    if (!p) throw new TaskError('not_found', `unknown provider: ${id}`);
    const m = String(model ?? '').trim();
    if (m && !/^[A-Za-z0-9._:/@\[\]-]{1,120}$/.test(m)) throw new TaskError('invalid', 'bad model name');
    if (p.transport === 'chat_completions' && !m) throw new TaskError('invalid', 'pick a model for this provider');
    if (m) p.model = m; else delete p.model;
    data.primary = id;
    save(data);
    return list();
  }

  return { load, list, put, remove, setPrimary, setMain, keyOf };
}
