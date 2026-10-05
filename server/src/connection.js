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
import { dataInfo } from './storage/data-version.js';
import { createRequestHandler } from '../../extension/shared/agent/requests.js';

const HELLO_TIMEOUT_MS = 5_000;
const TOOL_TIMEOUT_MS = 120_000; // the user may be asked to confirm an inspection
const MAX_TEXT = 20_000;

/** @typedef {import('../../extension/shared/agent/orchestrator.js').Orchestrator} Orchestrator */

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
   *   store: import('./sessions/store.js').SessionStore, registry: import('./providers/registry.js').ProviderRegistry,
   *   memory: import('./memory/store.js').MemoryStore, sourceEditor?: import('./source/source-editor.js').SourceEditor }} deps
   */
  constructor(ws, deps) {
    this.ws = ws;
    this.deps = deps;
    this.authenticated = false;
    /** @type {Map<string, { resolve: (v: any) => void, timer: NodeJS.Timeout }>} */
    this.pendingTools = new Map();
    // Requests answered the same way in the extension's direct mode (sessions, chat, memory, …).
    // Conversations this panel touches get their events routed to it.
    this.shared = createRequestHandler({ ...deps, onSession: (session) => deps.hub.attach(session.id, this) });

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

    const { config, hub, orchestrator, store, registry, memory, sourceEditor } = this.deps;

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

    try {
      const reply = await this.shared(msg);
      if (reply !== undefined) {
        if (reply) this.send({ ...reply, replyTo: msg.id });
        return;
      }
      await this.handle(msg, load, { config, hub, orchestrator, store, registry, memory, sourceEditor });
    } catch (err) {
      // Requests get their error as the answer, so the panel doesn't wait for a timeout.
      this.sendError(err, msg.id);
    }
  }

  /**
   * @param {any} msg
   * @param {() => Promise<import('./sessions/store.js').Session>} load
   * @param {any} deps
   */
  async handle(msg, load, { config, hub, orchestrator, store, registry, memory, sourceEditor }) {
    switch (msg.type) {
      case 'data.info':
        // Where the server keeps your data, and how much (Options → Your data).
        this.send({ type: 'data', replyTo: msg.id, info: dataInfo(config.dataDir) });
        return;

      case 'tool.result': {
        const pending = this.pendingTools.get(String(msg.requestId));
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingTools.delete(String(msg.requestId));
        pending.resolve({ ok: msg.ok === true, result: msg.result, error: msg.error ? String(msg.error) : undefined });
        return;
      }

      // ── Apply to source (see source/source-editor.js) ──
      case 'source.project': {
        const project = sourceEditor?.projectFor(String(msg.url ?? '')) ?? null;
        this.send({ type: 'source.project', replyTo: msg.id, project: project && { name: project.name, path: project.path } });
        return;
      }

      case 'source.propose': {
        if (!sourceEditor) throw new Error('Apply to source is not available');
        const session = await load();
        const action = session.actions[String(msg.actionId)];
        if (action?.name !== 'inject_css' || !['applied', 'saved'].includes(action.status)) {
          throw new Error('Only applied CSS changes can be moved to the source');
        }
        const input = /** @type {any} */ (action.input);
        const proposal = await sourceEditor.propose({ url: session.lastUrl ?? session.url ?? '', css: input.css, description: input.description });
        action.source = { proposalId: proposal.id, status: 'proposed', files: Object.keys(proposal.files) };
        store.save(session);
        const { files, ...visible } = proposal; // whole-file contents stay on the server
        this.send({ type: 'source.proposal', replyTo: msg.id, proposal: visible });
        return;
      }

      case 'source.write':
      case 'source.undo': {
        if (!sourceEditor) throw new Error('Apply to source is not available');
        const session = await load();
        const action = session.actions[String(msg.actionId)];
        if (!action?.source) throw new Error('No source edits for this change');
        let result;
        if (msg.type === 'source.write') {
          result = { files: sourceEditor.write(action.source.proposalId) };
          action.source.status = 'written';
        } else {
          result = sourceEditor.undo(action.source.proposalId);
          action.source.status = 'undone';
        }
        store.save(session);
        this.send({ type: 'source.result', replyTo: msg.id, source: action.source, ...result });
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
