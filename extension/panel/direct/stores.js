// @ts-check
/**
 * Storage for direct mode (no agent server): the same data the server keeps in
 * ~/.integratedai, kept inside the extension instead.
 *
 *   conversations  IndexedDB "integratedai" → object store "conversations" (whole conversations)
 *                                           → object store "history" (small entries for the History list)
 *   site memory    chrome.storage.local, one key per site: "memory:<site>"
 *
 * The data model and logic are shared with the server (../../shared/agent/).
 */

import { indexEntry, isSessionId, newSession } from '../../shared/agent/session-model.js';

/** @typedef {import('../../shared/agent/session-model.js').Session} Session */
/** @typedef {import('../../shared/agent/memory.js').SiteMemory} SiteMemory */

export const DB_NAME = 'integratedai';
const DB_VERSION = 1;
const MEMORY_PREFIX = 'memory:';

/** @returns {Promise<IDBDatabase>} */
export function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // Future format changes: bump DB_VERSION and migrate here (old versions → new stores/indexes).
      if (!db.objectStoreNames.contains('conversations')) db.createObjectStore('conversations', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('history')) {
        db.createObjectStore('history', { keyPath: 'id' }).createIndex('site', 'site');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * @template T
 * @param {IDBRequest<T>} req
 * @returns {Promise<T>}
 */
function done(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Conversations in IndexedDB. Same interface as the server's SessionStore. */
export class IdbSessionStore {
  /** @param {IDBDatabase} db */
  constructor(db) {
    this.db = db;
    /** @type {Map<string, Session>} */
    this.cache = new Map();
    /** @type {Map<string, number>} */
    this.pendingWrites = new Map();
  }

  /**
   * @param {{ url?: string, title?: string, provider: string, model: string }} init
   * @returns {Session}
   */
  create(init) {
    const session = newSession(init);
    this.cache.set(session.id, session);
    this.save(session);
    return session;
  }

  /**
   * @param {string} id
   * @returns {Promise<Session | null>}
   */
  async get(id) {
    if (!isSessionId(id)) return null;
    const cached = this.cache.get(id);
    if (cached) return cached;
    const session = await done(this.db.transaction('conversations').objectStore('conversations').get(id));
    if (!session) return null;
    session.busy = false;
    this.cache.set(id, session);
    return session;
  }

  /**
   * Debounced write, so streaming doesn't write on every token.
   * @param {Session} session
   */
  save(session) {
    session.updatedAt = Date.now();
    clearTimeout(this.pendingWrites.get(session.id));
    this.pendingWrites.set(session.id, /** @type {any} */ (setTimeout(() => this.write(session), 250)));
  }

  /** @param {Session} session */
  async write(session) {
    this.pendingWrites.delete(session.id);
    const { busy, ...data } = session;
    const tx = this.db.transaction(['conversations', 'history'], 'readwrite');
    tx.objectStore('conversations').put(structuredClone(data));
    const entry = indexEntry(session);
    if (entry) tx.objectStore('history').put(entry);
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
  }

  /** Write everything that is pending now (the panel is closing). */
  async flush() {
    const ids = [...this.pendingWrites.keys()];
    await Promise.all(ids.map((id) => {
      clearTimeout(this.pendingWrites.get(id));
      const session = this.cache.get(id);
      return session ? this.write(session) : undefined;
    }));
  }

  /**
   * Conversations on a site, newest first.
   * @param {string} site
   * @param {number} [limit]
   */
  async listForSite(site, limit = 30) {
    const entries = await done(this.db.transaction('history').objectStore('history').index('site').getAll(site));
    return entries.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
  }
}

/**
 * Site memory backend over chrome.storage.local. Everything is loaded up front
 * (memory is small) so reads are synchronous, as the shared MemoryStore expects.
 * Changes made in another DevTools window are picked up through storage events.
 * @param {(site: string) => void} [onExternalChange]  e.g. drop the MemoryStore's cached copy
 */
export async function loadMemoryBackend(onExternalChange = () => {}) {
  const all = await chrome.storage.local.get(null);
  /** @type {Map<string, SiteMemory>} */
  const sites = new Map();
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(MEMORY_PREFIX)) sites.set(key.slice(MEMORY_PREFIX.length), value);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const [key, change] of Object.entries(changes)) {
      if (!key.startsWith(MEMORY_PREFIX)) continue;
      const site = key.slice(MEMORY_PREFIX.length);
      if (change.newValue) sites.set(site, change.newValue);
      else sites.delete(site);
      onExternalChange(site);
    }
  });

  return {
    /** @param {string} site */
    read: (site) => structuredClone(sites.get(site) ?? null),
    /** @param {SiteMemory} memory */
    write: (memory) => {
      sites.set(memory.site, structuredClone(memory));
      chrome.storage.local.set({ [MEMORY_PREFIX + memory.site]: memory });
    },
  };
}
