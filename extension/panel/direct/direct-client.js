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
 *   - the Anthropic API provider, using the vendored official SDK and the user's own API key
 *   - conversations in IndexedDB and site memory in chrome.storage.local (./stores.js)
 *
 * Not available in direct mode (they need the local server): the Claude Code
 * provider (subscription), page tools over MCP, and Apply to source.
 */

import { MemoryStore } from '../../shared/agent/memory.js';
import { Orchestrator } from '../../shared/agent/orchestrator.js';
import { createRequestHandler } from '../../shared/agent/requests.js';
import { AnthropicProvider } from '../../shared/providers/anthropic.js';
import { IdbSessionStore, loadMemoryBackend, openDb } from './stores.js';

const TOOL_TIMEOUT_MS = 120_000;

/**
 * Settings → the config shape the shared code expects (like the server's config.json).
 * @param {import('../lib/settings.js').Settings} settings
 */
export function directConfig(settings) {
  return {
    maxStepsPerTurn: 8,
    providers: {
      anthropic: {
        apiKey: settings.anthropicApiKey,
        model: settings.directModel || 'claude-opus-5-5',
        effort: 'medium',
        maxTokens: 32000,
        fallbacks: true,
      },
    },
  };
}

/** The providers available in direct mode (only the Anthropic API for now). */
export class DirectRegistry {
  /** @param {ReturnType<typeof directConfig>} config */
  constructor(config) {
    this.config = config;
  }

  /** @param {string} id */
  get(id) {
    return id === AnthropicProvider.id ? AnthropicProvider : undefined;
  }

  /** @param {string} id */
  async isAvailable(id) {
    if (id !== AnthropicProvider.id) return { available: false, reason: 'Only the Anthropic API is available in direct mode.' };
    return this.config.providers.anthropic.apiKey
      ? { available: true }
      : { available: false, reason: 'Add your Anthropic API key in Options.' };
  }

  async pickDefault() {
    return AnthropicProvider.id;
  }

  /** @param {string} id */
  create(id) {
    if (id !== AnthropicProvider.id) throw new Error(`Provider "${id}" needs the local agent server`);
    return new AnthropicProvider(this.config, {
      browser: true,
      loadSdk: () => import('../../vendor/anthropic-sdk.mjs'),
    });
  }

  async list() {
    const { available, reason } = await this.isAvailable(AnthropicProvider.id);
    return [{
      id: AnthropicProvider.id,
      label: 'Anthropic API (direct)',
      available,
      reason,
      models: AnthropicProvider.models,
      defaultModel: this.config.providers.anthropic.model,
    }];
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
    if (!settings.anthropicApiKey) {
      this.setStatus('unauthorized', 'Direct mode needs your Anthropic API key. Add it in Options.');
      return;
    }
    this.setStatus('connecting');
    try {
      const config = directConfig(settings);
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
