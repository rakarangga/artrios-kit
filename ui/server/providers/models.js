// Model lists per provider (models_url per provider + a "Refresh Models" action):
// GET {base_url}/models with the key, normalised to { id, name, context, priceIn, priceOut } (USD per 1M tokens), and
// cached next to the providers file so the picker opens without a network call. The key never leaves the server.
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../lock.js';
import { CATALOG, CLAUDE_MODELS, CODEX_MODELS, extraHeaders } from './catalog.js';
import { modelsOf, numOf } from './config.js';

const MAX_MODELS = 2000;
const perMillion = (v) => { const n = Number(v); return v === undefined || v === null || v === '' || !Number.isFinite(n) || n < 0 ? null : Math.round(n * 1e6 * 1e6) / 1e6; };

export function normalizeModels(json) {
  const rows = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
  const out = [];
  const seen = new Set();
  for (const r of rows.slice(0, MAX_MODELS)) {
    const id = String(r?.id ?? r?.name ?? r?.model ?? '').replace(/^models\//, '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const context = numOf(r.context_length ?? r.context_window ?? r.max_context_length ?? r.top_provider?.context_length ?? r.max_model_len ?? null);
    out.push({
      id,
      name: typeof r.name === 'string' && r.name !== id ? r.name.slice(0, 120) : null,
      context: context && context > 0 ? context : null,
      priceIn: perMillion(r.pricing?.prompt ?? r.pricing?.input),
      priceOut: perMillion(r.pricing?.completion ?? r.pricing?.output),
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export async function fetchModels({ base_url, apiKey = null, fetchImpl = fetch, timeoutMs = 20000 }) {
  const hide = (t) => (apiKey ? String(t).split(apiKey).join('[redacted]') : String(t));
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    let res;
    try {
      res = await fetchImpl(`${String(base_url).replace(/\/+$/, '')}/models`, { headers: { ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), ...extraHeaders(base_url) }, signal: ctl.signal });
    } catch (e) {
      throw new Error(`could not reach ${base_url}: ${e.cause?.code ?? (ctl.signal.aborted ? 'timeout' : e.message)}`);
    }
    const text = await res.text();
    if (!res.ok) throw new Error(hide(`HTTP ${res.status}: ${text.slice(0, 300)}`));
    let json;
    try { json = JSON.parse(text); } catch { throw new Error('the provider returned something that is not JSON'); }
    return normalizeModels(json);
  } finally { clearTimeout(timer); }
}

export function createModelCache({ file }) {
  const load = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
  return {
    get: (id) => load()[id] ?? null,
    set(id, models) {
      const all = load();
      all[id] = { fetchedAt: new Date().toISOString(), models };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      atomicWrite(file, JSON.stringify(all));
      return all[id];
    },
    remove(id) { const all = load(); if (all[id]) { delete all[id]; atomicWrite(file, JSON.stringify(all)); } },
    file,
  };
}

// The picker data (model options): every provider with its models, the main one marked.
// Provider settings win over the fetched list for the default model; manual prices fill gaps the list leaves.
export function modelOptions({ store, cache }) {
  if (!store) {
    return { managed: false, current: { provider: 'claude', model: '' }, providers: [{ id: 'claude', label: 'Claude Code', transport: 'claude_cli', ready: true, hasKey: true, model: '', models: CLAUDE_MODELS.map((m) => ({ ...m, context: null, priceIn: null, priceOut: null })), fetchedAt: null }] };
  }
  const { primary, providers } = store.load();
  const rows = Object.entries(providers).map(([id, p]) => {
    if (p.transport === 'codex_cli') return { id, label: id === 'codex' ? 'Codex (ChatGPT plan)' : id, transport: p.transport, ready: true, hasKey: true, model: p.model ?? '', models: CODEX_MODELS.map((m) => ({ ...m, context: null, priceIn: null, priceOut: null })), fetchedAt: null };
    if (p.transport === 'claude_cli') return { id, label: id === 'claude' ? 'Claude Code' : id, transport: p.transport, ready: true, hasKey: true, model: p.model ?? '', models: CLAUDE_MODELS.map((m) => ({ ...m, context: null, priceIn: null, priceOut: null })), fetchedAt: null };
    const c = cache?.get(id);
    const listed = new Map((c?.models ?? []).map((m) => [m.id, m]));
    for (const m of modelsOf(p)) if (!listed.has(m)) listed.set(m, { id: m, name: null, context: null, priceIn: null, priceOut: null });
    const fill = (m) => ({ ...m, context: m.context ?? numOf(p.context_window), priceIn: m.priceIn ?? numOf(p.price_in), priceOut: m.priceOut ?? numOf(p.price_out) });
    return {
      id, label: CATALOG.find((c) => c.id === id && c.base_url === p.base_url)?.label ?? id, transport: p.transport, base_url: p.base_url ?? '', ready: !p.key_env || Boolean(store.keyOf(p)), hasKey: Boolean(store.keyOf(p)), keyEnv: p.key_env ?? '',
      model: p.model ?? '', models: [...listed.values()].map(fill), fetchedAt: c?.fetchedAt ?? null,
    };
  });
  const cur = primary ? providers[primary] : null;
  return { managed: true, current: { provider: primary ?? null, model: cur?.model ?? '' }, providers: rows };
}

// One model's facts for spend and the context bar: fetched list first, then the provider's manual fields.
export function modelInfo({ store, cache }, providerId, model) {
  const p = store?.load().providers[providerId];
  if (!p) return null;
  const m = cache?.get(providerId)?.models?.find((x) => x.id === model) ?? null;
  return { context: m?.context ?? numOf(p.context_window), priceIn: m?.priceIn ?? numOf(p.price_in), priceOut: m?.priceOut ?? numOf(p.price_out) };
}
