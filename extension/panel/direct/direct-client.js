// @ts-check
/**
 * Direct mode: the AI runs inside the extension, no agent server needed.
 *
 * DirectClient has the same interface as the WebSocket ServerClient
 * (../lib/ws-client.js): connect(), reconnect(), send(), request(), and
 * "status" / "message" events. So the panel works the same in both modes.
 *
 * Inside, it runs the same orchestrator, memory and request handling as the
 * server (../../shared/agent/), with:
 *   - the user's own API keys: Anthropic (vendored official SDK), OpenAI, Gemini, OpenRouter; or Ollama (local, no key)
 *   - conversations in IndexedDB and site memory in chrome.storage.local (./stores.js)
 *
 * Not available in direct mode (they need the local server): the Claude Code
 * provider (subscription), page tools over MCP, and Apply to source.
 */

import { MemoryStore } from '../../shared/agent/memory.js';
import { Orchestrator } from '../../shared/agent/orchestrator.js';
import { createRequestHandler } from '../../shared/agent/requests.js';
import { AnthropicProvider } from '../../shared/providers/anthropic.js';
import { PRESETS, openAICompatibleProvider } from '../../shared/providers/openai-compatible.js';
import { IdbSessionStore, loadMemoryBackend, openDb } from './stores.js';

// Long enough to wait for the user to answer an "Allow?" question (Stop cancels at once).
const TOOL_TIMEOUT_MS = 10 * 60_000;

/** Provider classes available in direct mode (Anthropic via the official SDK; the rest via the OpenAI-compatible API). */
export const DIRECT_PROVIDERS = [
  AnthropicProvider,
  openAICompatibleProvider('openai'),
  openAICompatibleProvider('gemini'),
  openAICompatibleProvider('openrouter'),
  openAICompatibleProvider('deepseek'),
  openAICompatibleProvider('qwen'),
  openAICompatibleProvider('kimi'),
  openAICompatibleProvider('glm'),
  openAICompatibleProvider('minimax'),
  openAICompatibleProvider('custom'),
  openAICompatibleProvider('ollama'),
];

/**
 * Settings → the config shape the shared code expects (like the server's config.json).
 * @param {import('../lib/settings.js').Settings} settings
 */
export function directConfig(settings) {
  /** @type {Record<string, any>} */
  const providers = {
    anthropic: {
      apiKey: settings.anthropicApiKey,
      model: settings.directModel || 'claude-opus-5-5',
      effort: 'medium',
      maxTokens: 32000,
      fallbacks: true,
    },
  };
  for (const id of Object.keys(PRESETS)) {
    providers[id] = {
      apiKey: settings.providerKeys?.[id] ?? '',
      model: settings.providerModels?.[id] ?? '',
      baseUrl: settings.providerUrls?.[id] ?? '',
      ...(id === 'ollama' ? { compact: settings.ollamaCompact === true } : {}),
    };
  }
  return { maxStepsPerTurn: 8, preferredProvider: settings.directProvider || 'anthropic', providers, modelLists: settings.modelLists ?? {} };
}

/** The providers available in direct mode, each usable once its key is set in Options. */
export class DirectRegistry {
  /** @param {ReturnType<typeof directConfig>} config */
  constructor(config) {
    this.config = config;
  }

  /** @param {string} id */
  get(id) {
    return DIRECT_PROVIDERS.find((P) => P.id === id);
  }

  /** @param {string} id */
  async isAvailable(id) {
    const P = this.get(id);
    if (!P) return { available: false, reason: `"${id}" needs the local agent server (Options → Connection).` };
    if (P === AnthropicProvider) {
      return this.config.providers.anthropic.apiKey
        ? { available: true }
        : { available: false, reason: 'Add your Anthropic API key in Options.' };
    }
    return P.checkAvailability(this.config);
  }

  /** The provider chosen in Options if it has a key, otherwise the first one that has a key. */
  async pickDefault() {
    if ((await this.isAvailable(this.config.preferredProvider)).available) return this.config.preferredProvider;
    for (const P of DIRECT_PROVIDERS) {
      if ((await this.isAvailable(P.id)).available) return P.id;
    }
    return this.config.preferredProvider;
  }

  /** @param {string} id */
  create(id) {
    const P = this.get(id);
    if (!P) throw new Error(`Provider "${id}" needs the local agent server`);
    if (P === AnthropicProvider) {
      return new AnthropicProvider(this.config, { browser: true, loadSdk: () => import('../../vendor/anthropic-sdk.mjs') });
    }
    return new P(this.config);
  }

  async list() {
    return Promise.all(DIRECT_PROVIDERS.map(async (P) => {
      const { available, reason } = await this.isAvailable(P.id);
      return {
        id: P.id,
        label: P === AnthropicProvider ? 'Anthropic API (direct)' : P.label,
        available,
        reason,
        // The built-in suggestions, then what the provider itself lists (remembered by Options → Check, and
        // refreshed by the panel), so new models show up without an update of the extension.
        models: [...new Set([...P.models, ...(this.config.modelLists?.[P.id]?.ids ?? [])])],
        defaultModel: P.defaultModel(this.config),
      };
    }));
  }
}

export class DirectClient extends EventTarget {
  /** @param {() => Promise<import('../lib/settings.js').Settings>} getSettings */
  constructor(getSettings) {
    super();
    this.getSettings = getSettings;
    this.status = 'disconnected';
    this.lastError = '';
    /** @type {((msg: any) => Promise<any>) | null} */
    this.handle = null;
    /** @type {Map<string, (v: any) => void>} */
    this.pendingTools = new Map();
    /** @type {IdbSessionStore | null} */
    this.store = null;
    // Save conversations still waiting to be written when DevTools closes.
    addEventListener('pagehide', () => { this.store?.flush(); });
  }

  async connect() {
    const settings = await this.getSettings();
    // Ollama needs no key (a chosen model means it's set up), and a Custom service may not need one either.
    const keyless = settings.providerModels?.ollama || (settings.providerUrls?.custom && settings.providerModels?.custom);
    if (!settings.anthropicApiKey && !Object.values(settings.providerKeys ?? {}).some(Boolean) && !keyless) {
      this.setStatus('unauthorized', 'Direct mode needs an API key, Ollama, or your own service. Set one up in Options.');
      return;
    }
    this.setStatus('connecting');
    try {
      const config = directConfig(settings);
      /** Live: the panel updates config.modelLists when it learns a provider's models (no reconnect needed). */
      this.config = config;
      this.store = new IdbSessionStore(await openDb());
      /** @type {MemoryStore | null} */
      let memory = null;
      const backend = await loadMemoryBackend((site) => memory?.invalidate(site));
      memory = new MemoryStore(backend);
      const registry = new DirectRegistry(config);
      const orchestrator = new Orchestrator({ store: this.store, registry, config, panel: this.panelLink(), memory });
      this.handle = createRequestHandler({ orchestrator, store: this.store, registry, memory });
      this.setStatus('connected');
    } catch (err) {
      this.setStatus('disconnected', `Direct mode could not start: ${/** @type {any} */ (err)?.message ?? err}`);
    }
  }

  /** Settings changed (new key or model): start over. */
  reconnect() {
    this.connect();
  }

  /**
   * @param {string} status
   * @param {string} [error]
   */
  setStatus(status, error = '') {
    this.status = status;
    this.lastError = error;
    this.dispatchEvent(new CustomEvent('status', { detail: { status, error } }));
  }

  /** Fire-and-forget message; errors come back as an "error" message, like from the server. @param {any} msg */
  send(msg) {
    if (this.status !== 'connected') throw new Error('Not connected (direct mode)');
    this.process(msg).catch((err) => this.emit({ type: 'error', conversationId: msg.conversationId, message: String(err?.message ?? err) }));
  }

  /**
   * Send a request and get the reply (rejects on error).
   * @param {Record<string, any>} msg
   */
  async request(msg) {
    if (this.status !== 'connected') throw new Error('Not connected (direct mode)');
    return this.process(msg);
  }

  /** @param {any} msg */
  async process(msg) {
    if (msg.type === 'tool.result') {
      const resolve = this.pendingTools.get(String(msg.requestId));
      this.pendingTools.delete(String(msg.requestId));
      resolve?.({ ok: msg.ok === true, result: msg.result, error: msg.error ? String(msg.error) : undefined });
      return null;
    }
    const reply = await /** @type {any} */ (this.handle)(msg);
    if (reply !== undefined) return reply;
    // Server-only features.
    if (msg.type === 'source.project') return { type: 'source.project', project: null };
    if (msg.type.startsWith('source.')) throw new Error('Apply to source needs the local agent server (Options → Connection).');
    throw new Error(`"${msg.type}" is not available in direct mode`);
  }

  /** Deliver an event to the panel asynchronously, like a message arriving over a socket. @param {object} msg */
  emit(msg) {
    queueMicrotask(() => this.dispatchEvent(new CustomEvent('message', { detail: msg })));
  }

  /** How the orchestrator reaches the panel (on the server this goes over the WebSocket). */
  panelLink() {
    return {
      send: (/** @type {string} */ _conversationId, /** @type {object} */ msg) => this.emit(msg),
      requestTool: (/** @type {string} */ conversationId, /** @type {string} */ name, /** @type {unknown} */ input, /** @type {AbortSignal} */ signal) =>
        new Promise((resolve) => {
          const requestId = crypto.randomUUID();
          const finish = (/** @type {any} */ value) => {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            this.pendingTools.delete(requestId);
            resolve(value);
          };
          const onAbort = () => finish({ ok: false, error: 'Cancelled' });
          const timer = setTimeout(() => finish({ ok: false, error: 'The panel did not answer in time.' }), TOOL_TIMEOUT_MS);
          signal.addEventListener('abort', onAbort, { once: true });
          this.pendingTools.set(requestId, finish);
          this.emit({ type: 'tool.request', conversationId, requestId, name, input });
        }),
    };
  }
}
