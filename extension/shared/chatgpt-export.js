// @ts-check
/**
 * ChatGPT's own data export (ChatGPT → Settings → Data controls → Export data: a ZIP with conversations.json),
 * turned into plain documents the AI can search (chat-search.js). Read as a stream, one conversation at a time:
 * the file can be hundreds of MB.
 *
 * A conversation in the export is a tree of messages ("mapping": id → { message, parent, children }); the thread
 * the user sees runs from "current_node" up through the parents.
 */

import { zipEntries, zipEntryStream } from './zip-read.js';

/** A conversation's text is kept up to this many characters (a very long one is cut at the end). */
export const MAX_CHAT_CHARS = 200_000;

/** @typedef {{ id: string, title: string, time: number, text: string }} ChatDoc */

/**
 * The elements of a JSON array, one at a time, from its text as a stream (each as its own JSON text): the
 * top-level array is never held in memory as a whole.
 * @param {ReadableStream<string> | AsyncIterable<string>} chunks
 * @returns {AsyncGenerator<string>}
 */
export async function* splitJsonArray(chunks) {
  let depth = 0;          // inside the top-level array: 1; inside an element: 2 and more
  let inString = false;
  let escaped = false;
  let element = '';
  let started = false;    // an element is being collected
  const reader = /** @type {any} */ (chunks)[Symbol.asyncIterator] ? /** @type {AsyncIterable<string>} */ (chunks) : streamChunks(/** @type {ReadableStream<string>} */ (chunks));
  for await (const chunk of reader) {
    let from = 0;         // start of the part of this chunk that belongs to the current element
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk.charCodeAt(i);
      if (inString) {
        if (escaped) escaped = false;
        else if (c === 92) escaped = true;      // backslash
        else if (c === 34) inString = false;    // "
        continue;
      }
      if (c === 34) { inString = true; if (depth === 1 && !started) { started = true; from = i; } continue; }
      if (c === 123 || c === 91) {              // { [
        depth++;
        if (depth === 2 && !started) { started = true; from = i; }
        continue;
      }
      if (c === 125 || c === 93) {              // } ]
        depth--;
        if (depth === 1 && started) {
          yield element + chunk.slice(from, i + 1);
          element = '';
          started = false;
        } else if (depth === 0 && started) {
          // The array's own "]" right after a bare value (a number, true, …).
          const text = (element + chunk.slice(from, i)).trim();
          if (text) yield text;
          element = '';
          started = false;
        }
        continue;
      }
      if (depth === 1) {
        if (c === 44) {                         // , between elements
          if (started) { const text = (element + chunk.slice(from, i)).trim(); if (text) yield text; element = ''; started = false; }
        } else if (!started && c > 32) { started = true; from = i; } // a bare value starts
      }
    }
    if (started) element += chunk.slice(from);
  }
}

/** @param {ReadableStream<string>} stream */
async function* streamChunks(stream) {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/** The text of one exported message, or '' for what isn't text (images, tool output, hidden context). @param {any} message */
function messageText(message) {
  const content = message?.content;
  if (!content) return '';
  if (content.content_type === 'text' || content.content_type === 'multimodal_text') {
    return (content.parts ?? []).filter((/** @type {unknown} */ p) => typeof p === 'string').join('\n').trim();
  }
  if (content.content_type === 'code' && typeof content.text === 'string') return content.text.trim();
  return '';
}

/**
 * One exported conversation → a document: who said what, in order, as plain text. Null when there is nothing to
 * search in it.
 * @param {any} conversation
 * @returns {ChatDoc | null}
 */
export function conversationToDoc(conversation) {
  const mapping = conversation?.mapping;
  if (!mapping || typeof mapping !== 'object') return null;
  // The visible thread: from the current node up to the root. (No current node: every message, by time.)
  /** @type {any[]} */
  let nodes = [];
  const seen = new Set();
  for (let id = conversation.current_node; id && mapping[id] && !seen.has(id); id = mapping[id].parent) {
    seen.add(id);
    nodes.unshift(mapping[id]);
  }
  if (!nodes.length) {
    nodes = Object.values(mapping).filter((n) => n?.message).sort((a, b) => (a.message.create_time ?? 0) - (b.message.create_time ?? 0));
  }
  /** @type {string[]} */
  const lines = [];
  let size = 0;
  for (const node of nodes) {
    const message = node?.message;
    const role = message?.author?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    if (message.metadata?.is_visually_hidden_from_conversation) continue;
    const text = messageText(message);
    if (!text) continue;
    const line = `${role === 'user' ? 'You' : 'ChatGPT'}: ${text}`;
    if (size + line.length > MAX_CHAT_CHARS) { lines.push(`${line.slice(0, Math.max(0, MAX_CHAT_CHARS - size))}… (cut: a very long conversation)`); break; }
    lines.push(line);
    size += line.length + 2;
  }
  if (!lines.length) return null;
  const time = Math.round(((conversation.update_time ?? conversation.create_time ?? 0)) * 1000);
  return {
    id: String(conversation.conversation_id ?? conversation.id ?? `${time}-${lines[0].length}`),
    title: String(conversation.title ?? '').trim() || 'Untitled',
    time,
    text: lines.join('\n\n'),
  };
}

/**
 * What ChatGPT had saved about the user when this conversation happened (its "memory", and the user's custom
 * instructions), if the export carries it: some exports keep it as hidden context messages.
 * @param {any} conversation
 * @returns {{ memory?: string, instructions?: string }}
 */
export function savedContext(conversation) {
  /** @type {{ memory?: string, instructions?: string }} */
  const out = {};
  for (const node of Object.values(conversation?.mapping ?? {})) {
    const content = /** @type {any} */ (node)?.message?.content;
    if (content?.content_type === 'model_editable_context' && typeof content.model_set_context === 'string' && content.model_set_context.trim()) {
      out.memory = content.model_set_context.trim();
    }
    if (content?.content_type === 'user_editable_context') {
      const text = [content.user_profile, content.user_instructions].filter((t) => typeof t === 'string' && t.trim()).join('\n\n').trim();
      if (text) out.instructions = text;
    }
  }
  return out;
}

/**
 * The conversations in an export file: the ZIP from ChatGPT, or the conversations.json from inside it.
 * @param {Blob & { name?: string }} file
 * @returns {AsyncGenerator<any>}  each exported conversation, as parsed JSON
 */
export async function* exportConversations(file) {
  /** @type {ReadableStream<Uint8Array>[]} */
  const streams = [];
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (head[0] === 0x50 && head[1] === 0x4b) {
    const entries = (await zipEntries(file)).filter((e) => /(^|\/)conversations(-\d+)?\.json$/i.test(e.name)).sort((a, b) => a.name.localeCompare(b.name));
    if (!entries.length) throw new Error('No conversations.json in this ZIP. Is it the export from ChatGPT (Settings → Data controls → Export data)?');
    for (const entry of entries) streams.push(await zipEntryStream(file, entry));
  } else {
    streams.push(/** @type {ReadableStream<Uint8Array>} */ (file.stream()));
  }
  for (const stream of streams) {
    const text = stream.pipeThrough(/** @type {any} */ (new TextDecoderStream()));
    for await (const json of splitJsonArray(/** @type {any} */ (text))) {
      let conversation;
      try { conversation = JSON.parse(json); } catch { continue; } // one damaged conversation doesn't stop the rest
      if (conversation && typeof conversation === 'object') yield conversation;
    }
  }
}
