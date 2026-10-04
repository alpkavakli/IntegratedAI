// @ts-check
/**
 * WebSocket connections from DevTools panels.
 *
 * Connection  one socket = one open AI panel (one inspected tab).
 * PanelHub    routes messages for a conversation to the panel currently showing it.
 *             If DevTools is closed and reopened, the new socket takes over the
 *             conversation, even in the middle of a turn.
 */

import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION } from '../../extension/shared/protocol.js';
import { tokenMatches } from './auth.js';

const HELLO_TIMEOUT_MS = 5_000;
const TOOL_TIMEOUT_MS = 120_000; // the user may be asked to confirm an inspection
const MAX_TEXT = 20_000;

/** @typedef {import('./agent/orchestrator.js').Orchestrator} Orchestrator */

export class PanelHub {
  constructor() {
    /** @type {Map<string, Connection>} conversationId → connection */
    this.byConversation = new Map();
  }

  /**
   * @param {string} conversationId
   * @param {Connection} conn
   */
  attach(conversationId, conn) {
    this.byConversation.set(conversationId, conn);
  }

  /** @param {Connection} conn */
  detach(conn) {
    for (const [id, c] of this.byConversation) if (c === conn) this.byConversation.delete(id);
  }

  /**
   * @param {string} conversationId
   * @param {object} msg
   */
  send(conversationId, msg) {
    this.byConversation.get(conversationId)?.send(msg);
  }

  /**
   * Ask the panel to run a read-only inspection in the inspected page.
   * @param {string} conversationId
   * @param {string} name
   * @param {unknown} input
   * @param {AbortSignal} signal
   * @returns {Promise<{ ok: boolean, result?: unknown, error?: string }>}
   */
  requestTool(conversationId, name, input, signal) {
    const conn = this.byConversation.get(conversationId);
    if (!conn) return Promise.resolve({ ok: false, error: 'The DevTools AI panel is not connected.' });
    return conn.requestTool(conversationId, name, input, signal);
  }
}

export class Connection {
  /**
   * @param {import('ws').WebSocket} ws
   * @param {{ config: import('./config.js').Config, hub: PanelHub, orchestrator: Orchestrator,
   *   store: import('./sessions/store.js').SessionStore, registry: import('./providers/registry.js').ProviderRegistry }} deps
   */
  constructor(ws, deps) {
    this.ws = ws;
    this.deps = deps;
    this.authenticated = false;
    /** @type {Map<string, { resolve: (v: any) => void, timer: NodeJS.Timeout }>} */
    this.pendingTools = new Map();

    const helloTimer = setTimeout(() => {
      if (!this.authenticated) ws.close(4401, 'No hello received');
    }, HELLO_TIMEOUT_MS);

    ws.on('message', (data) => this.onMessage(String(data)).catch((err) => this.sendError(err)));
    ws.on('close', () => {
      clearTimeout(helloTimer);
      deps.hub.detach(this);
      for (const { resolve, timer } of this.pendingTools.values()) {
        clearTimeout(timer);
        resolve({ ok: false, error: 'The DevTools panel disconnected.' });
      }
      this.pendingTools.clear();
    });
  }

  /** @param {object} msg */
  send(msg) {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /**
   * @param {unknown} err
   * @param {any} [replyTo]
   */
  sendError(err, replyTo) {
    this.send({ type: 'error', replyTo, message: String(/** @type {any} */ (err)?.message ?? err) });
  }

  /** @param {string} raw */
  async onMessage(raw) {
    /** @type {any} */
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return this.sendError('Invalid JSON');
    }
    if (!msg || typeof msg.type !== 'string') return this.sendError('Missing message type');

    const { config, hub, orchestrator, store, registry } = this.deps;

    // ── authentication: the first message must be a valid hello ──
    if (!this.authenticated) {
      if (msg.type !== 'hello' || !tokenMatches(msg.token, config.token)) {
        this.send({ type: 'error', message: 'Invalid pairing token. Copy it from the server console into the extension options.' });
        this.ws.close(4401, 'Unauthorized');
        return;
      }
      if (msg.protocol !== PROTOCOL_VERSION) {
        this.send({ type: 'error', message: `Protocol mismatch: server ${PROTOCOL_VERSION}, extension ${msg.protocol}. Update both.` });
        this.ws.close(4400, 'Protocol mismatch');
        return;
      }
      this.authenticated = true;
      this.send({ type: 'welcome', protocol: PROTOCOL_VERSION });
      return;
    }

    /** Load a conversation by id or fail. */
    const load = async () => {
      const session = await store.get(String(msg.conversationId ?? ''));
      if (!session) throw new Error('Conversation not found');
      return session;
    };

    switch (msg.type) {
      case 'session.open':
      case 'session.reset': {
        const session = await orchestrator.openSession({
          conversationId: msg.type === 'session.open' ? msg.conversationId : undefined,
          url: String(msg.url ?? ''),
          title: String(msg.title ?? ''),
        });
        hub.attach(session.id, this);
        this.send({ type: 'session.state', replyTo: msg.id, session: orchestrator.snapshot(session) });
        return;
      }

      case 'session.config': {
        const session = await load();
        orchestrator.configure(session, { provider: msg.provider, model: msg.model });
        this.send({ type: 'session.state', replyTo: msg.id, session: orchestrator.snapshot(session) });
        return;
      }

      case 'providers.list':
        this.send({ type: 'providers', replyTo: msg.id, providers: await registry.list() });
        return;

      case 'chat.send': {
        const session = await load();
        const text = String(msg.text ?? '').slice(0, MAX_TEXT);
        if (!text.trim()) throw new Error('Empty message');
        hub.attach(session.id, this);
        // Not awaited: the turn streams events back while it runs.
        orchestrator.chat(session, {
          text,
          context: msg.context,
          settings: { executeJs: msg.settings?.executeJs === true, webTools: msg.settings?.webTools === true },
        });
        return;
      }

      case 'chat.cancel':
        orchestrator.cancel(String(msg.conversationId));
        return;

      case 'tool.result': {
        const pending = this.pendingTools.get(String(msg.requestId));
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingTools.delete(String(msg.requestId));
        pending.resolve({ ok: msg.ok === true, result: msg.result, error: msg.error ? String(msg.error) : undefined });
        return;
      }

      case 'action.status': {
        const session = await load();
        orchestrator.setActionStatus(session, String(msg.actionId), String(msg.status), msg.detail);
        return;
      }

      default:
        throw new Error(`Unknown message type "${msg.type}"`);
    }
  }

  /**
   * @param {string} conversationId
   * @param {string} name
   * @param {unknown} input
   * @param {AbortSignal} signal
   * @returns {Promise<{ ok: boolean, result?: unknown, error?: string }>}
   */
  requestTool(conversationId, name, input, signal) {
    return new Promise((resolve) => {
      const requestId = randomUUID();
      const done = (/** @type {any} */ value) => {
        clearTimeout(timer);
        this.pendingTools.delete(requestId);
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const onAbort = () => done({ ok: false, error: 'Cancelled' });
      const timer = setTimeout(() => done({ ok: false, error: 'The panel did not answer in time.' }), TOOL_TIMEOUT_MS);
      signal.addEventListener('abort', onAbort, { once: true });
      this.pendingTools.set(requestId, { resolve: done, timer });
      this.send({ type: 'tool.request', conversationId, requestId, name, input });
    });
  }
}
