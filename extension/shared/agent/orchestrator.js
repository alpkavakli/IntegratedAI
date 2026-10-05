// @ts-check
/**
 * The orchestrator runs one "turn": the user sends a message, the model answers,
 * possibly after several inspection round-trips.
 *
 *   user message ─► provider.turn() ─► assistant message
 *                        ▲                 │ tool calls?
 *                        │                 ├─ inspection (read-only) ─► run in the panel ─► result
 *                        │                 ├─ change (mutation)      ─► PROPOSED to the panel, never run here
 *                        │                 └─ invalid                ─► error result for the model
 *                        └── loop again while there were inspection results to feed back
 *
 * Proposed changes: if the model ONLY proposed changes in its last step, the
 * turn ends and those tool calls stay "open". The user's decisions (Apply /
 * Reject / Undo / Save) are then sent as the tool results at the start of the
 * next user message, so the model learns what really happened.
 * If proposals were mixed with inspections, the model is told "proposed, awaiting
 * decision" right away and later decisions are reported in an <action_updates> note.
 */

import { ACTION_STATUS } from '../protocol.js';
import { enabledActionNames, isReadOnly, isServerSide, validateAction } from '../actions.js';
import { siteKey } from '../page-groups.js';
import { formatResult } from './format-result.js';
import { fingerprint, forPanel, snapshot } from './session-model.js';
import { buildSystemPrompt } from './system-prompt.js';

/** @typedef {import('./session-model.js').Session} Session */
/** @typedef {import('../protocol.js').NeutralMessage} NeutralMessage */
/** @typedef {import('../protocol.js').ContentBlock} ContentBlock */
/** @typedef {import('../protocol.js').Usage} Usage */

/**
 * Where conversations are stored. Files on the agent server (server/src/sessions/store.js),
 * IndexedDB in the extension's direct mode (panel/direct/stores.js).
 * @typedef {object} SessionStore
 * @property {(id: string) => Promise<Session | null>} get
 * @property {(init: { url?: string, title?: string, provider: string, model: string }) => Session} create
 * @property {(session: Session) => void} save
 */

/**
 * The available AI providers (server: providers/registry.js; direct mode: panel/direct/).
 * @typedef {object} ProviderRegistry
 * @property {(id: string) => any} get
 * @property {(id: string) => Promise<{ available: boolean, reason?: string }>} isAvailable
 * @property {() => Promise<string>} pickDefault
 * @property {(id: string) => import('../providers/base.js').Provider} create
 */

/**
 * How the orchestrator talks to the DevTools panel showing a conversation.
 * Implemented by PanelHub in connection.js (and by fakes in tests).
 * @typedef {object} PanelLink
 * @property {(conversationId: string, msg: object) => void} send
 * @property {(conversationId: string, name: string, input: unknown, signal: AbortSignal)
 *   => Promise<{ ok: boolean, result?: unknown, error?: string }>} requestTool
 */

/**
 * Settings the panel sends with each message.
 * @typedef {{ executeJs?: boolean, webTools?: boolean }} TurnSettings
 */

export const MEMORY_MODES = ['shared', 'private', 'off'];

const STATUS_TEXT = {
  proposed: 'Shown to the user; they have not applied it yet.',
  applied: 'The user applied this change.',
  rejected: 'The user rejected this change. Do not propose it again unless asked.',
  failed: 'The user tried to apply this change but it failed.',
  undone: 'The user applied this change and then undid it.',
  saved: 'The user applied this change and saved it as a persistent patch for this site.',
  invalid: 'This action was invalid and was not shown to the user.',
};

export class Orchestrator {
  /**
   * @param {{ store: SessionStore, registry: ProviderRegistry, config: { maxStepsPerTurn: number } & Record<string, any>, panel: PanelLink,
   *   memory?: import('./memory.js').MemoryStore, pageTools?: any }} deps
   *   pageTools: offers inspections as real tools to providers that support it (Claude Code via MCP)
   */
  constructor({ store, registry, config, panel, memory, pageTools }) {
    this.store = store;
    this.memory = memory ?? null;
    this.pageTools = pageTools ?? null;
    this.registry = registry;
    this.config = config;
    this.panel = panel;
    /** @type {Map<string, AbortController>} running turns by conversation id */
    this.running = new Map();
  }

  // ───────────────────────────────────────────────────────────── sessions

  /**
   * Return the conversation with this id, or create a new one.
   * @param {{ conversationId?: string, url?: string, title?: string }} p
   */
  async openSession({ conversationId, url, title }) {
    if (conversationId) {
      const existing = await this.store.get(conversationId);
      if (existing) return existing;
    }
    const provider = await this.registry.pickDefault();
    const P = this.registry.get(provider);
    return this.store.create({ url, title, provider, model: P ? P.defaultModel(this.config) : '' });
  }

  /**
   * Change provider/model/memory mode for a conversation (history is kept).
   * @param {Session} session
   * @param {{ provider?: string, model?: string, memoryMode?: string }} p
   */
  configure(session, { provider, model, memoryMode }) {
    if (session.busy) throw new Error('Wait for the current answer to finish');
    if (provider && provider !== session.provider) {
      const P = this.registry.get(provider);
      if (!P) throw new Error(`Unknown provider "${provider}"`);
      session.provider = provider;
      session.model = P.defaultModel(this.config);
    }
    if (model) session.model = model;
    if (memoryMode !== undefined) {
      if (!MEMORY_MODES.includes(memoryMode)) throw new Error(`Unknown memory mode "${memoryMode}"`);
      session.memoryMode = /** @type {any} */ (memoryMode);
      session.memoryHash = undefined; // send the (other) memory with the next message
    }
    this.store.save(session);
  }

  /**
   * The memory a conversation uses:
   *   shared  → the site's memory, the same for every conversation on the site (default)
   *   private → a memory of its own, separate from the site's shared memory
   *   off     → none (nothing is read or saved)
   * @param {Session} session
   * @returns {import('./memory.js').MemoryStore | null}
   */
  memoryFor(session) {
    if (!this.memory || session.memoryMode === 'off') return null;
    return session.memoryMode === 'private' ? this.memory.scoped(`private~${session.id}~`) : this.memory;
  }

  /** @param {string} conversationId */
  cancel(conversationId) {
    this.running.get(conversationId)?.abort();
  }

  /**
   * The panel reports what happened to a proposed change (applied, rejected, undone, …).
   * @param {Session} session
   * @param {string} actionId
   * @param {string} status
   * @param {string} [detail]
   */
  setActionStatus(session, actionId, status, detail) {
    const action = session.actions[actionId];
    if (!action) throw new Error('Unknown action');
    if (!Object.hasOwn(ACTION_STATUS, status) || status === 'invalid' || status === 'proposed') {
      throw new Error(`Invalid status "${status}"`);
    }
    action.status = /** @type {any} */ (status);
    action.detail = detail ? String(detail).slice(0, 2000) : undefined;
    this.store.save(session);
  }

  // ───────────────────────────────────────────────────────────── turns

  /**
   * Handle one user message. Resolves when the turn is over (never throws;
   * errors are sent to the panel).
   * @param {Session} session
   * @param {{ text: string, context?: unknown, settings?: TurnSettings }} msg
   */
  async chat(session, { text, context, settings = {} }) {
    const id = session.id;
    if (session.busy) {
      this.panel.send(id, { type: 'error', conversationId: id, message: 'Still working on the previous message.' });
      return;
    }

    const abort = new AbortController();
    this.running.set(id, abort);
    session.busy = true;
    this.panel.send(id, { type: 'turn.started', conversationId: id });

    /** @type {Usage} */
    const turnUsage = { inputTokens: 0, outputTokens: 0, costUsd: null };
    let stopReason = 'end_turn';

    try {
      const available = await this.registry.isAvailable(session.provider);
      if (!available.available) throw new Error(`Provider unavailable: ${available.reason}`);
      const provider = this.registry.create(session.provider);
      const P = /** @type {any} */ (provider.constructor);

      const actionNames = enabledActionNames(settings);
      const webTools = settings.webTools === true;
      const pageTools = Boolean(this.pageTools && P.pageToolsViaMcp);
      const system = buildSystemPrompt({ actionNames, webTools, pageTools, structuredEnvelope: Boolean(P.structuredEnvelope) });

      this.trackPage(session, context, text);
      this.append(session, this.buildUserMessage(session, text, context));

      for (let step = 0; step < this.config.maxStepsPerTurn; step++) {
        const { message, toolCalls, usage, stopReason: sr } = await this.callModel(session, provider, {
          system, actionNames, webTools, pageTools, signal: abort.signal,
        });
        addUsage(turnUsage, usage);
        stopReason = sr;
        this.append(session, message);
        // pause_turn: the API paused a long server-side tool run (web search); call again to let it continue.
        if (!toolCalls.length) { if (sr === 'pause_turn') continue; break; }

        // Until results are recorded, these calls are "open" (keeps history valid if we stop early).
        session.openToolCalls = toolCalls.map((c) => c.id);
        const continueLoop = await this.handleToolCalls(session, toolCalls, settings, abort.signal);
        if (!continueLoop) break; // only proposals: wait for the user's decisions

        if (step === this.config.maxStepsPerTurn - 1) {
          stopReason = 'max_steps';
          this.panel.send(id, { type: 'error', conversationId: id, message: `Stopped after ${this.config.maxStepsPerTurn} steps. Send a message to continue.` });
        }
      }
    } catch (err) {
      stopReason = abort.signal.aborted ? 'cancelled' : 'error';
      if (!abort.signal.aborted) {
        this.panel.send(id, { type: 'error', conversationId: id, message: String(/** @type {any} */ (err)?.message ?? err) });
      }
    } finally {
      session.busy = false;
      this.running.delete(id);
      addUsage(session.usage, turnUsage);
      this.store.save(session);
      this.panel.send(id, { type: 'turn.done', conversationId: id, usage: turnUsage, sessionUsage: session.usage, stopReason });
    }
  }

  /**
   * Run one provider call and assemble the assistant message.
   * @param {Session} session
   * @param {import('../providers/base.js').Provider} provider
   * @param {{ system: string, actionNames: string[], webTools: boolean, pageTools?: boolean, signal: AbortSignal }} o
   */
  async callModel(session, provider, { system, actionNames, webTools, pageTools = false, signal }) {
    const providerId = /** @type {any} */ (provider.constructor).id;
    const state = (session.providerState[providerId] ??= {});

    let text = '';
    let previewed = false;
    /** @type {{ id: string, name: string, input: unknown }[]} */
    const toolCalls = [];
    /** @type {unknown} */
    let raw;
    /** @type {Usage} */
    const usage = { inputTokens: 0, outputTokens: 0, costUsd: null };
    let stopReason = 'end_turn';

    // Inspections as real tools: a token valid only while this call runs.
    const grant = pageTools && this.pageTools ? this.pageTools.grant(session.id, actionNames, signal) : null;
    const events = provider.turn({
      messages: session.messages, system, actionNames, webTools, model: session.model, state, signal,
      ...(grant ? { pageTools: { url: mcpUrl(this.config), token: grant.token } } : {}),
    });
    try {
      for await (const ev of events) {
        if (signal.aborted) throw new Error('Cancelled');
        switch (ev.type) {
          case 'text_delta':
            text += ev.text;
            if (!previewed) this.panel.send(session.id, { type: 'chat.delta', conversationId: session.id, text: ev.text });
            break;
          case 'preview_delta':
            // Live display only; the final text arrives as text_delta (not re-sent, it's already on screen).
            previewed = true;
            this.panel.send(session.id, { type: 'chat.delta', conversationId: session.id, text: ev.text });
            break;
          case 'tool_call':
            toolCalls.push({ id: ev.id, name: ev.name, input: ev.input });
            break;
          case 'usage':
            addUsage(usage, ev);
            break;
          case 'raw':
            raw = ev.content;
            break;
          case 'done':
            stopReason = ev.stopReason;
            break;
        }
      }
    } finally {
      grant?.revoke();
    }

    /** @type {NeutralMessage} */
    const message = {
      role: 'assistant',
      content: [
        // Inspections the model ran itself (MCP), so the chat still shows what it looked at.
        ...(grant?.calls ?? []).map((c) => ({ type: /** @type {const} */ ('inspection'), ...c })),
        ...(text ? [{ type: /** @type {const} */ ('text'), text }] : []),
        ...toolCalls.map((c) => ({ type: /** @type {const} */ ('tool_call'), ...c })),
      ],
      ts: Date.now(),
    };
    if (raw !== undefined) message.raw = { provider: providerId, content: raw };
    return { message, toolCalls, usage, stopReason };
  }

  /**
   * Validate and dispatch the tool calls of one assistant message.
   * @param {Session} session
   * @param {{ id: string, name: string, input: unknown }[]} calls
   * @param {TurnSettings} settings
   * @param {AbortSignal} signal
   * @returns {Promise<boolean>} true if the model should be called again with results
   */
  async handleToolCalls(session, calls, settings, signal) {
    /** @type {ContentBlock[]} */
    const results = [];
    /** @type {string[]} */
    const proposals = [];
    /** @type {ContentBlock[]} */
    const serverResults = [];
    let needsResults = false;

    for (const call of calls) {
      const errors = validateAction(call.name, call.input, settings);
      if (errors.length) {
        needsResults = true;
        if (!isReadOnly(call.name)) {
          session.actions[call.id] = { name: call.name, input: call.input, status: 'invalid', errors, reportedStatus: 'invalid' };
        }
        results.push({ type: 'tool_result', toolCallId: call.id, isError: true, content: `Invalid action: ${errors.join('; ')}` });
        continue;
      }

      if (isServerSide(call.name)) {
        // Site memory: done right here. The result goes back with the other results,
        // or (if nothing else needs an answer) at the start of the next user message.
        const result = this.runMemoryAction(session, call);
        serverResults.push({ type: 'tool_result', toolCallId: call.id, ...result });
        continue;
      }

      if (isReadOnly(call.name)) {
        needsResults = true;
        const res = await this.panel.requestTool(session.id, call.name, call.input, signal);
        if (res.ok) {
          const { text, images } = formatResult(res.result);
          results.push({ type: 'tool_result', toolCallId: call.id, content: text, ...(images ? { images } : {}) });
        } else {
          results.push({ type: 'tool_result', toolCallId: call.id, isError: true, content: `Inspection failed: ${res.error ?? 'unknown error'}` });
        }
      } else {
        session.actions[call.id] = { name: call.name, input: call.input, status: 'proposed' };
        proposals.push(call.id);
        this.panel.send(session.id, {
          type: 'action.proposed', conversationId: session.id, actionId: call.id, name: call.name, input: call.input,
        });
      }
    }

    if (!needsResults) {
      // Only proposals and memory updates: end the turn. Their results are sent with the next user message.
      session.pendingResults = Object.fromEntries(
        serverResults.map((r) => [/** @type {any} */ (r).toolCallId, { content: /** @type {any} */ (r).content, isError: /** @type {any} */ (r).isError }]),
      );
      return false;
    }
    results.push(...serverResults);

    for (const id of proposals) {
      session.actions[id].reportedStatus = 'proposed';
      results.push({ type: 'tool_result', toolCallId: id, content: 'Proposed to the user; awaiting their decision. You will be told what they decide.' });
    }
    session.openToolCalls = [];
    this.append(session, { role: 'user', content: results, ts: Date.now() });
    return true;
  }

  /**
   * Build the next user message: results for open tool calls, updates on earlier
   * proposals, the page context and the user's text.
   * @param {Session} session
   * @param {string} text
   * @param {unknown} context
   * @returns {NeutralMessage}
   */
  buildUserMessage(session, text, context) {
    /** @type {ContentBlock[]} */
    const content = [];

    for (const id of session.openToolCalls) {
      const action = session.actions[id];
      const pending = session.pendingResults?.[id];
      if (action) action.reportedStatus = action.status;
      content.push({
        type: 'tool_result',
        toolCallId: id,
        content: pending?.content ?? (action ? describeAction(action) : 'Not executed: the previous answer was interrupted.'),
        ...(pending?.isError ? { isError: true } : {}),
      });
    }
    session.openToolCalls = [];
    session.pendingResults = {};

    const updates = [];
    for (const [id, action] of Object.entries(session.actions)) {
      if (action.reportedStatus && action.reportedStatus !== action.status) {
        updates.push(`- ${action.name} (${id}): ${describeAction(action)}`);
        action.reportedStatus = action.status;
      }
    }
    if (updates.length) content.push({ type: 'note', text: updates.join('\n') });

    // Site memory is sent when it differs from what this conversation last saw.
    const memory = this.memoryContext(session);
    if (memory) content.push({ type: 'memory', data: memory });
    if (context) content.push({ type: 'context', data: context });
    content.push({ type: 'text', text: String(text ?? '') });
    return { role: 'user', content, ts: Date.now() };
  }

  // ───────────────────────────────────────────────────────────── site memory

  /**
   * Remember which site / page group the conversation is about (for History),
   * and title the conversation after its first message.
   * @param {Session} session
   * @param {any} context
   * @param {string} text
   */
  trackPage(session, context, text) {
    const url = typeof context?.page?.url === 'string' ? context.page.url : session.lastUrl;
    if (url) {
      session.lastUrl = url;
      session.site = siteKey(url) ?? session.site;
      const info = (this.memoryFor(session) ?? this.memory)?.forUrl(url);
      if (info) session.groupPattern = info.group.pattern;
    }
    if (!session.titleFromUser && text.trim()) {
      session.title = text.trim().replace(/\s+/g, ' ').slice(0, 80);
      session.titleFromUser = true;
    }
  }

  /**
   * The memory block for the next user message, or null if unchanged since last sent.
   * @param {Session} session
   */
  memoryContext(session) {
    const memory = this.memoryFor(session);
    if (!memory || !session.lastUrl) return null;
    const data = memory.contextFor(session.lastUrl);
    if (!data) return null;
    const hash = fingerprint(data);
    if (hash === session.memoryHash) return null;
    session.memoryHash = hash;
    return data;
  }

  /**
   * Run remember / forget / define_page_group and tell the panel.
   * @param {Session} session
   * @param {{ id: string, name: string, input: any }} call
   * @returns {{ content: string, isError?: boolean }}
   */
  runMemoryAction(session, { name, input }) {
    const memory = this.memoryFor(session);
    if (session.memoryMode === 'off') return { content: 'Memory is turned off for this conversation; nothing was saved.', isError: true };
    if (!memory || !session.lastUrl) return { content: 'Site memory is not available for this page.', isError: true };
    try {
      let change;
      if (name === 'remember') {
        const note = memory.addNote(session.lastUrl, { text: input.note, scope: input.scope, by: 'assistant', conversationId: session.id });
        change = { kind: 'note_added', note };
      } else if (name === 'forget') {
        const note = memory.deleteNote(/** @type {string} */ (siteKey(session.lastUrl)), input.id);
        change = { kind: 'note_deleted', note };
      } else {
        const group = memory.defineGroup(session.lastUrl, { name: input.name, pattern: input.pattern });
        session.groupPattern = group.pattern;
        change = { kind: 'group_defined', group };
      }
      // The model already knows about its own change; don't resend memory just for that.
      const data = memory.contextFor(session.lastUrl);
      session.memoryHash = fingerprint(data);
      this.panel.send(session.id, { type: 'memory.changed', conversationId: session.id, site: siteKey(session.lastUrl), change });
      const id = change.note?.id ?? change.group?.id;
      return { content: `Saved (${change.kind.replace('_', ' ')}, id ${id}).` };
    } catch (err) {
      return { content: String(/** @type {any} */ (err)?.message ?? err), isError: true };
    }
  }

  /**
   * Append a message and tell the panel (without provider-internal raw content).
   * @param {Session} session
   * @param {NeutralMessage} message
   */
  append(session, message) {
    session.messages.push(message);
    this.store.save(session);
    this.panel.send(session.id, { type: 'chat.message', conversationId: session.id, message: forPanel(message) });
  }

  /** @param {Session} session */
  snapshot(session) {
    return snapshot(session);
  }
}

/** @param {import('./session-model.js').StoredAction} action */
function describeAction(action) {
  let text = STATUS_TEXT[action.status] ?? action.status;
  if (action.detail) text += ` Details: ${action.detail}`;
  return text;
}

/**
 * @param {Usage} total
 * @param {{ inputTokens: number, outputTokens: number, costUsd: number | null }} add
 */
function addUsage(total, add) {
  total.inputTokens += add.inputTokens;
  total.outputTokens += add.outputTokens;
  if (add.costUsd !== null && add.costUsd !== undefined) total.costUsd = (total.costUsd ?? 0) + add.costUsd;
}

/**
 * Where Claude Code reaches the MCP endpoint of this server.
 * @param {{ host: string, port: number }} config
 */
function mcpUrl({ host, port }) {
  const h = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;
  return `http://${h}:${port}/mcp`;
}
