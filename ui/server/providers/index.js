// Chooses the engine for each run from artrios/providers.yaml, so a change in Settings > Model applies to the next job
// without a restart. There is no hidden default: with a providers file but no primary, a run fails and says what to do.
// An install whose config.json names no providersFile keeps running the local claude CLI as before.
import path from 'node:path';
import { createApiEngine } from './api-engine.js';
import { createCodexEngine } from './codex-engine.js';
import { chatCompletions } from './chat-completions.js';
import { createProviderStore, defaultEnvFile } from './config.js';
import { createModelCache, fetchModels, modelOptions, modelInfo } from './models.js';
import { CATALOG, CLAUDE_MODELS, CODEX_MODELS } from './catalog.js';
import { TaskError } from '../task-service.js';

// sonnet, opus and haiku are Claude aliases and mean nothing to Codex.
const CLAUDE_ALIAS = /^(opus|sonnet|haiku|fable)(\[.*\])?$/;
const TRANSPORTS = { chat_completions: chatCompletions };

export const coreFileOf = (config) => (config.projectLayerFile ? path.join(path.dirname(config.projectLayerFile), 'core.md') : null);

export function createProviderLayer({ config, cliEngine, codexEngine = null, fetchImpl = fetch }) {
  if (!config.providersFile) {
    return { managed: false, store: null, cache: null, engine: cliEngine, active: () => ({ id: 'claude', transport: 'claude_cli', model: '' }), options: () => modelOptions({ store: null }), info: () => null };
  }
  const store = createProviderStore({ file: config.providersFile, envFile: config.envFile ?? defaultEnvFile() });
  const cache = createModelCache({ file: path.join(path.dirname(config.providersFile), 'models-cache.json') });

  const active = () => {
    const { primary, providers } = store.load();
    const p = primary ? providers[primary] : null;
    return p ? { id: primary, transport: p.transport, model: p.model ?? '' } : null;
  };

  const codex = codexEngine ?? createCodexEngine({ command: config.codexPath ?? 'codex', baseArgs: config.codexBaseArgs ?? [] });
  const failing = (message) => ({
    pid: null,
    stop() {},
    done: Promise.resolve({ exitCode: 1, stopped: false, stderrTail: message }),
  });

  const engine = {
    get name() { const a = active(); return a ? `${a.transport}:${a.id}` : 'none'; },
    // opts.provider (an agent profile's engine) picks a listed provider for this run; otherwise the primary one.
    run(opts, onLine) {
      const { primary, providers } = store.load();
      if (opts.provider && !providers[opts.provider]) return failing(`Provider "${opts.provider}" is not in Settings > Model. Pick another one in the agent profile.`);
      const provider = opts.provider ? providers[opts.provider] : primary ? providers[primary] : null;
      if (!provider) return failing('No model provider is set. Add one in Settings > Model, or run the installer wizard again.');
      if (provider.transport === 'claude_cli') return cliEngine.run({ ...opts, model: opts.model ?? provider.model }, onLine);
      if (provider.transport === 'codex_cli') return codex.run({ ...opts, model: opts.model && !CLAUDE_ALIAS.test(opts.model) ? opts.model : provider.model }, onLine);
      const transport = TRANSPORTS[provider.transport];
      if (!transport) return failing(`Unknown transport in the providers file: ${provider.transport}`);
      return createApiEngine({ provider, apiKey: store.keyOf(provider), transport, fetchImpl, coreFile: coreFileOf(config), name: engine.name }).run(opts, onLine);
    },
  };

  // One short call that proves the key, the address and the model. The CLI is only asked for its version: no quota spent.
  async function test(id, claudeStatus, codexStatus = async () => ({ ok: false })) {
    const provider = store.load().providers[id];
    if (!provider) return { ok: false, error: `unknown provider: ${id}` };
    if (provider.transport === 'claude_cli') {
      const s = await claudeStatus();
      return s.ok ? { ok: true, text: s.version ?? 'claude found' } : { ok: false, error: 'the claude command was not found' };
    }
    if (provider.transport === 'codex_cli') {
      const s = await codexStatus();
      return s.ok ? { ok: true, text: s.version ?? 'codex found' } : { ok: false, error: 'the codex command was not found. Install it and run `codex login`.' };
    }
    const handle = createApiEngine({ provider, apiKey: store.keyOf(provider), transport: TRANSPORTS[provider.transport], fetchImpl, retryDelayMs: 500 });
    let result = null;
    const h = handle.run({ prompt: 'Reply with the single word OK.', cwd: process.cwd(), allowedTools: [] }, (o) => { if (o.type === 'result') result = o; });
    await h.done;
    return result && !result.is_error ? { ok: true, text: String(result.result).slice(0, 200) } : { ok: false, error: String(result?.result ?? 'no answer').slice(0, 500) };
  }

  // Live model list of a saved provider (Refresh Models), cached for the pickers.
  async function refreshModels(id) {
    const p = store.load().providers[id];
    if (!p) throw new TaskError('not_found', `unknown provider: ${id}`);
    if (p.transport === 'claude_cli') return { fetchedAt: null, models: CLAUDE_MODELS };
    if (p.transport === 'codex_cli') return { fetchedAt: null, models: CODEX_MODELS };
    try { return cache.set(id, await fetchModels({ base_url: p.base_url, apiKey: store.keyOf(p), fetchImpl })); } catch (e) { throw new TaskError('unavailable', e.message); }
  }
  // Before saving (the add wizard): list the models of an address with a key typed now or one already in .env.
  async function probe({ base_url, key_env, apiKey } = {}) {
    let url;
    try { url = new URL(String(base_url ?? '')); } catch { throw new TaskError('invalid', 'base URL is not a valid URL'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new TaskError('invalid', 'base URL must be http or https');
    const key = apiKey ? String(apiKey).trim() : key_env ? store.keyOf({ key_env }) : null;
    try { return { models: await fetchModels({ base_url: String(base_url).replace(/\/+$/, ''), apiKey: key, fetchImpl }) }; } catch (e) { throw new TaskError('unavailable', e.message); }
  }
  const catalog = () => CATALOG.map((c) => ({ ...c, hasKey: c.key_env ? Boolean(store.keyOf({ key_env: c.key_env })) : false }));

  return {
    managed: true, store, cache, engine, active, test, refreshModels, probe, catalog,
    options: () => modelOptions({ store, cache }),
    info: (id, model) => modelInfo({ store, cache }, id, model),
  };
}
