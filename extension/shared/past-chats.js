// @ts-check
/**
 * The user's past ChatGPT chats, imported from ChatGPT's own data export (chatgpt-export.js) and kept in this
 * browser (IndexedDB) so the AI can look things up in them (the search_chats tool). A snapshot: it is as new as
 * the export. Nothing here talks to ChatGPT.
 *
 * The options page imports; the service worker searches (so the DevTools panel and the card on the page read the
 * same data).
 */

import { conversationToDoc, exportConversations, savedContext } from './chatgpt-export.js';
import { chatSearcher } from './chat-search.js';

export const CHATS_DB = 'integratedai-chats';
/** What ChatGPT had saved about the user, kept as two documents next to the chats. */
export const MEMORY_ID = 'chatgpt-memory';
export const INSTRUCTIONS_ID = 'chatgpt-instructions';
/** A chat is read back to the AI in parts of this many characters. */
export const CHAT_PART_CHARS = 8000;
const BATCH = 50;

/** @typedef {import('./chatgpt-export.js').ChatDoc} ChatDoc */
/** @typedef {{ count: number, oldest: number, newest: number, importedAt: number, fileName: string, memory: boolean }} ChatsInfo */

/** @template T @param {IDBRequest<T>} req @returns {Promise<T>} */
const done = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
/** @param {IDBTransaction} tx */
const finished = (tx) => new Promise((resolve, reject) => { tx.oncomplete = () => resolve(undefined); tx.onerror = tx.onabort = () => reject(tx.error); });

/** @returns {Promise<IDBDatabase>} */
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(CHATS_DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('chats', { keyPath: 'id' });
      req.result.createObjectStore('meta');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Whether anything was ever imported (without creating the database by asking). */
async function exists() {
  return (await indexedDB.databases()).some((d) => d.name === CHATS_DB);
}

/**
 * Replace what is kept with the chats of an export file.
 * @param {Blob & { name?: string }} file  the ZIP from ChatGPT, or its conversations.json
 * @param {(count: number) => void} [onProgress]
 * @returns {Promise<ChatsInfo>}
 */
export async function importExport(file, onProgress) {
  await clearChats();
  const db = await openDb();
  try {
    /** @type {ChatDoc[]} */
    let batch = [];
    let count = 0;
    let oldest = Infinity;
    let newest = 0;
    /** @type {{ memory?: string, instructions?: string }} */
    let context = {};
    let contextTime = -1;
    const flush = async () => {
      if (!batch.length) return;
      const tx = db.transaction('chats', 'readwrite');
      for (const doc of batch) tx.objectStore('chats').put(doc);
      await finished(tx);
      batch = [];
      onProgress?.(count);
    };
    for await (const conversation of exportConversations(file)) {
      const doc = conversationToDoc(conversation);
      if (!doc) continue;
      batch.push(doc);
      count++;
      if (doc.time) { oldest = Math.min(oldest, doc.time); newest = Math.max(newest, doc.time); }
      // The newest conversation that carries them has the latest saved memory and instructions.
      const saved = savedContext(conversation);
      if ((saved.memory || saved.instructions) && doc.time >= contextTime) { context = { ...context, ...saved }; contextTime = doc.time; }
      if (batch.length >= BATCH) await flush();
    }
    await flush();
    if (!count) throw new Error('No conversations were found in this file.');
    /** @type {ChatsInfo} */
    const info = { count, oldest: Number.isFinite(oldest) ? oldest : 0, newest, importedAt: Date.now(), fileName: String(file.name ?? ''), memory: Boolean(context.memory || context.instructions) };
    const tx = db.transaction(['chats', 'meta'], 'readwrite');
    if (context.memory) tx.objectStore('chats').put({ id: MEMORY_ID, title: 'What ChatGPT remembered about you (saved memory)', time: contextTime, text: context.memory });
    if (context.instructions) tx.objectStore('chats').put({ id: INSTRUCTIONS_ID, title: 'Your custom instructions for ChatGPT', time: contextTime, text: context.instructions });
    tx.objectStore('meta').put(info, 'info');
    await finished(tx);
    return info;
  } catch (err) {
    db.close();
    await clearChats(); // half an import is worse than none
    throw err;
  } finally {
    db.close();
  }
}

/** What is kept, or null. @returns {Promise<ChatsInfo | null>} */
export async function chatsInfo() {
  if (!(await exists())) return null;
  const db = await openDb();
  try {
    return (await done(db.transaction('meta').objectStore('meta').get('info'))) ?? null;
  } finally {
    db.close();
  }
}

/** Delete every imported chat. */
export function clearChats() {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(CHATS_DB);
    req.onsuccess = req.onerror = req.onblocked = () => resolve(undefined);
  });
}

/**
 * The search_chats tool: find chats by words (query), or read one chat (id, in parts).
 * @param {{ query?: string, id?: string, offset?: number, limit?: number }} input
 */
export async function searchChats(input) {
  const info = await chatsInfo();
  if (!info) return { available: false, note: 'The user has not imported their ChatGPT chats (Options → Your ChatGPT history). Say so; do not guess what the chats said.' };
  const db = await openDb();
  try {
    const store = db.transaction('chats').objectStore('chats');
    if (input.id) {
      /** @type {ChatDoc | undefined} */
      const doc = await done(store.get(String(input.id)));
      if (!doc) return { error: `No chat with id "${input.id}". Search first (query) and use an id from the matches.` };
      const offset = Math.max(0, Math.floor(Number(input.offset) || 0));
      const end = Math.min(doc.text.length, offset + CHAT_PART_CHARS);
      return {
        id: doc.id, title: doc.title, date: dateOf(doc.time), length: doc.text.length,
        text: doc.text.slice(offset, end),
        ...(end < doc.text.length ? { nextOffset: end } : {}),
      };
    }
    const limit = Math.min(10, Math.max(1, Math.floor(Number(input.limit) || 5)));
    const search = chatSearcher(String(input.query ?? ''), limit);
    await new Promise((resolve, reject) => {
      const cursor = store.openCursor();
      cursor.onerror = () => reject(cursor.error);
      cursor.onsuccess = () => {
        const at = cursor.result;
        if (!at) { resolve(undefined); return; }
        search.add(at.value);
        at.continue();
      };
    });
    return {
      ...search.results(),
      searched: info.count,
      from: `${dateOf(info.oldest)} to ${dateOf(info.newest)} (a snapshot exported from ChatGPT; nothing newer is here)`,
      ...(info.memory ? { savedMemory: `ChatGPT's saved memory about the user and their custom instructions can be read with id "${MEMORY_ID}" / "${INSTRUCTIONS_ID}".` } : {}),
    };
  } finally {
    db.close();
  }
}

/** @param {number} time */
const dateOf = (time) => (time ? new Date(time).toISOString().slice(0, 10) : '');
