// @ts-check
/**
 * WebSocket protocol between the DevTools panel and the local agent server.
 *
 * Every message is a JSON object with a `type` field. Requests that expect a
 * direct answer carry an `id`; the answer carries `replyTo` with that id.
 *
 * Connection lifecycle:
 *   1. Panel opens ws://127.0.0.1:<port>/ws  (server checks Origin + Host headers)
 *   2. Panel sends  { type: 'hello', token, protocol }   (pairing token)
 *   3. Server sends { type: 'welcome', ... } or closes the socket.
 *
 * ── Panel → Server ─────────────────────────────────────────────────────────
 *   hello            { token, protocol }
 *   session.open     { id, conversationId?, url, title }       → session.state
 *   session.reset    { id, url, title }                        → session.state (new conversation)
 *   session.config   { conversationId, provider?, model? }     → session.state
 *   providers.list   { id }                                    → providers
 *   chat.send        { conversationId, text, context, settings }
 *   chat.cancel      { conversationId }
 *   tool.result      { requestId, ok, result?, error? }        (answer to tool.request)
 *   action.status    { conversationId, actionId, status, detail? }
 *   sessions.list    { id, url }                               → sessions (conversations on this site)
 *   memory.get       { id, url }                               → memory   (site memory for this page)
 *   memory.edit      { id, url, op, … }                        → memory   (op: addNote | updateNote | deleteNote |
 *                                                                          defineGroup | updateGroup | deleteGroup)
 *
 * ── Server → Panel ─────────────────────────────────────────────────────────
 *   welcome          { serverVersion, protocol }
 *   session.state    { replyTo?, session }                     (full conversation snapshot)
 *   providers        { replyTo, providers: ProviderInfo[] }
 *   turn.started     { conversationId }
 *   chat.delta       { conversationId, text }                  (streamed assistant text)
 *   chat.message     { conversationId, message }               (a finished message appended to history)
 *   tool.request     { conversationId, requestId, name, input }  (read-only inspection to run in the page)
 *   action.proposed  { conversationId, actionId, name, input }   (mutation awaiting approval)
 *   turn.done        { conversationId, usage, sessionUsage, stopReason }
 *   sessions         { replyTo, site, items: [{ id, title, lastUrl, groupPattern, updatedAt, messageCount, sameGroup }] }
 *   memory           { replyTo, memory: { site, path, group, groups, notes } | null }
 *   memory.changed   { conversationId, site, change: { kind: 'note_added'|'note_deleted'|'group_defined', note?, group? } }
 *   error            { replyTo?, conversationId?, message }
 */

export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 7823;

/** Status values for a proposed (mutating) action, as tracked by the server. */
export const ACTION_STATUS = /** @type {const} */ ({
  proposed: 'proposed',   // shown to the user, no decision yet
  applied: 'applied',     // user clicked Apply and it succeeded
  rejected: 'rejected',   // user clicked Reject
  failed: 'failed',       // user clicked Apply but execution failed
  undone: 'undone',       // applied, then undone by the user
  saved: 'saved',         // applied and saved as a persistent site patch
  invalid: 'invalid',     // failed validation, never shown as applicable
});

/**
 * Shape of a conversation as sent to the panel (session.state).
 * @typedef {object} SessionSnapshot
 * @property {string} id
 * @property {string} title
 * @property {string} provider
 * @property {string} model
 * @property {boolean} busy
 * @property {NeutralMessage[]} messages
 * @property {Record<string, ActionRecord>} actions
 * @property {Usage} usage
 */

/**
 * Provider-neutral conversation message. Stored by the server and rendered by the panel.
 * @typedef {object} NeutralMessage
 * @property {'user'|'assistant'} role
 * @property {ContentBlock[]} content
 * @property {number} ts
 * @property {{ provider: string, content: unknown }} [raw]  provider-native content (e.g. thinking blocks), server-only
 */

/**
 * @typedef {{ type: 'text', text: string }
 *   | { type: 'context', data: unknown }
 *   | { type: 'memory', data: unknown }      site memory (notes + page group), sent when it changed
 *   | { type: 'note', text: string }
 *   | { type: 'tool_call', id: string, name: string, input: unknown }
 *   | { type: 'inspection', name: string, input: unknown }  an inspection the model ran itself during
 *                                            the call (Claude Code via MCP); display only, not sent back
 *   | { type: 'tool_result', toolCallId: string, content: string, isError?: boolean }} ContentBlock
 */

/**
 * @typedef {object} ActionRecord
 * @property {string} name
 * @property {unknown} input
 * @property {keyof typeof ACTION_STATUS} status
 * @property {string} [detail]
 * @property {string[]} [errors]
 */

/**
 * @typedef {object} Usage
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number|null} costUsd   null when the provider reports no cost
 */

/**
 * @typedef {object} ProviderInfo
 * @property {string} id
 * @property {string} label
 * @property {boolean} available
 * @property {string} [reason]       why it is unavailable
 * @property {string[]} models
 * @property {string} defaultModel
 */
