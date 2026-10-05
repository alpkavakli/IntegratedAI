// @ts-check
/**
 * The conversation ("session") data model, shared by both places that store
 * conversations:
 *   - the local agent server (one JSON file per conversation, server/src/sessions/store.js)
 *   - the extension's direct mode (IndexedDB, panel/direct/stores.js)
 *
 * Only plain functions here: no file system, no browser APIs.
 */

/** @typedef {import('../protocol.js').NeutralMessage} NeutralMessage */
/** @typedef {import('../protocol.js').ActionRecord} ActionRecord */
/** @typedef {import('../protocol.js').Usage} Usage */

/**
 * @typedef {ActionRecord & { reportedStatus?: string }} StoredAction
 *   reportedStatus = the last status we told the model about (so status changes get reported once)
 *
 * @typedef {object} Session
 * @property {string} id
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {string} title
 * @property {string} url             URL of the page when the conversation started
 * @property {string} provider
 * @property {string} model
 * @property {NeutralMessage[]} messages
 * @property {Record<string, StoredAction>} actions   keyed by tool call id
 * @property {string[]} openToolCalls  tool calls that still need a tool_result in the next user message
 * @property {Record<string, any>} providerState     per-provider memory, e.g. Claude CLI session id
 * @property {Usage} usage
 * @property {string} [site]          site key of the latest page (e.g. "webnovel.com")
 * @property {string} [groupPattern]  page group pattern of the latest page
 * @property {string} [lastUrl]       latest page URL
 * @property {boolean} [titleFromUser] title was taken from the first message
 * @property {string} [memoryHash]    hash of the site memory last sent to the model
 * @property {Record<string, { content: string, isError?: boolean }>} [pendingResults]
 *   results of server-side actions (memory) waiting to be sent with the next user message
 * @property {boolean} [busy]          runtime only, not persisted
 */

/**
 * A new, empty conversation.
 * @param {{ url?: string, title?: string, provider: string, model: string }} init
 * @returns {Session}
 */
export function newSession({ url = '', title = '', provider, model }) {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    title: title || url || 'New conversation',
    url,
    provider,
    model,
    messages: [],
    actions: {},
    openToolCalls: [],
    providerState: {},
    usage: { inputTokens: 0, outputTokens: 0, costUsd: null },
  };
}

/** Conversation ids are UUIDs (also keeps them safe to use in file names). @param {unknown} id */
export function isSessionId(id) {
  return typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id);
}

/**
 * @typedef {{ id: string, site: string, groupPattern: string, lastUrl: string, title: string,
 *   updatedAt: number, messageCount: number }} IndexEntry
 *
 * History entry for a conversation; null if it has no user message or no site yet.
 * @param {Session} s
 * @returns {IndexEntry | null}
 */
export function indexEntry(s) {
  const messageCount = s.messages.filter((m) => m.role === 'user' && m.content.some((b) => b.type === 'text')).length;
  if (!s.site || !messageCount) return null;
  return {
    id: s.id, site: s.site, groupPattern: s.groupPattern ?? '/', lastUrl: s.lastUrl ?? s.url,
    title: s.title, updatedAt: s.updatedAt, messageCount,
  };
}

/**
 * A message as the panel sees it: no provider-internal raw content, and no image
 * data (screenshots are large and the panel shows them live when they are taken).
 * @param {NeutralMessage} message
 */
export function forPanel({ raw, ...message }) {
  if (!message.content.some((b) => b.type === 'tool_result' && /** @type {any} */ (b).images)) return message;
  return {
    ...message,
    content: message.content.map((b) => {
      if (b.type !== 'tool_result' || !(/** @type {any} */ (b).images)) return b;
      const { images, ...rest } = /** @type {any} */ (b);
      return rest;
    }),
  };
}

/**
 * What the panel is allowed to see: everything except provider internals
 * (raw provider content, CLI session ids).
 * @param {Session} session
 */
export function snapshot(session) {
  return {
    id: session.id,
    title: session.title,
    url: session.url,
    provider: session.provider,
    model: session.model,
    busy: !!session.busy,
    messages: session.messages.map(forPanel),
    actions: Object.fromEntries(
      Object.entries(session.actions).map(([id, { reportedStatus, ...a }]) => [id, a]),
    ),
    usage: session.usage,
    site: session.site,
    groupPattern: session.groupPattern,
  };
}

/**
 * Short, stable fingerprint of some JSON data (FNV-1a, 64-bit as two 32-bit halves).
 * Used to notice when site memory changed; not for security.
 * @param {unknown} data
 */
export function fingerprint(data) {
  const text = JSON.stringify(data) ?? '';
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x811c9dc5);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}
