// @ts-check
/**
 * Conversation storage.
 *
 * Each conversation is one JSON file: <dataDir>/conversations/<id>.json
 * Conversations are kept after the browser tab closes. A small index
 * (conversations/index.json) lists them per site for the panel's History.
 *
 * The extension decides which conversation belongs to which tab (it keeps a
 * tabId → conversationId map that lives as long as the browser session).
 * The server just stores conversations by id.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

/** @typedef {import('../../../extension/shared/protocol.js').NeutralMessage} NeutralMessage */
/** @typedef {import('../../../extension/shared/protocol.js').ActionRecord} ActionRecord */
/** @typedef {import('../../../extension/shared/protocol.js').Usage} Usage */

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

export class SessionStore {
  /** @param {string} dataDir */
  constructor(dataDir) {
    this.dir = join(dataDir, 'conversations');
    mkdirSync(this.dir, { recursive: true });
    /** @type {Map<string, Session>} */
    this.cache = new Map();
    /** @type {Map<string, NodeJS.Timeout>} */
    this.pendingWrites = new Map();
    /** @type {Map<string, IndexEntry> | null} */
    this.indexCache = null;
  }

  /**
   * @param {{ url?: string, title?: string, provider: string, model: string }} init
   * @returns {Session}
   */
  create({ url = '', title = '', provider, model }) {
    const now = Date.now();
    /** @type {Session} */
    const session = {
      id: randomUUID(),
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
    this.cache.set(session.id, session);
    this.save(session);
    return session;
  }

  /**
   * @param {string} id
   * @returns {Promise<Session | null>}
   */
  async get(id) {
    if (!/^[0-9a-f-]{36}$/.test(id)) return null; // ids are UUIDs; also prevents path tricks
    const cached = this.cache.get(id);
    if (cached) return cached;
    try {
      const session = JSON.parse(await readFile(this.file(id), 'utf8'));
      session.busy = false;
      this.cache.set(id, session);
      return session;
    } catch {
      return null;
    }
  }

  /**
   * Schedule a write (debounced so streaming doesn't hammer the disk).
   * @param {Session} session
   */
  save(session) {
    session.updatedAt = Date.now();
    clearTimeout(this.pendingWrites.get(session.id));
    this.pendingWrites.set(
      session.id,
      setTimeout(() => this.write(session), 250),
    );
  }

  /** Write everything that is pending now (used on shutdown and in tests). */
  async flush() {
    const ids = [...this.pendingWrites.keys()];
    await Promise.all(
      ids.map((id) => {
        clearTimeout(this.pendingWrites.get(id));
        const session = this.cache.get(id);
        return session ? this.write(session) : undefined;
      }),
    );
  }

  /** @param {Session} session */
  async write(session) {
    this.pendingWrites.delete(session.id);
    const { busy, ...data } = session;
    const tmp = this.file(session.id) + '.tmp';
    await writeFile(tmp, JSON.stringify(data));
    await rename(tmp, this.file(session.id)); // atomic replace
    this.updateIndex(session);
  }

  // ─────────────────────────────────────────── index (for "recent conversations")

  /**
   * A small index of all conversations (conversations/index.json), so the panel
   * can list them per site without reading every file. Rebuilt from the files
   * if missing.
   * @returns {Map<string, IndexEntry>}
   */
  index() {
    if (this.indexCache) return this.indexCache;
    /** @type {Map<string, IndexEntry>} */
    const map = new Map();
    const file = join(this.dir, 'index.json');
    if (existsSync(file)) {
      for (const entry of JSON.parse(readFileSync(file, 'utf8'))) map.set(entry.id, entry);
    } else {
      for (const f of readdirSync(this.dir).filter((name) => /^[0-9a-f-]{36}\.json$/.test(name))) {
        try {
          const entry = indexEntry(JSON.parse(readFileSync(join(this.dir, f), 'utf8')));
          if (entry) map.set(entry.id, entry);
        } catch { /* skip unreadable files */ }
      }
    }
    this.indexCache = map;
    return map;
  }

  /** @param {Session} session */
  updateIndex(session) {
    const entry = indexEntry(session);
    if (!entry) return;
    const map = this.index();
    map.set(entry.id, entry);
    const file = join(this.dir, 'index.json');
    writeFileSync(`${file}.tmp`, JSON.stringify([...map.values()]));
    renameSync(`${file}.tmp`, file);
  }

  /**
   * Conversations on a site, newest first.
   * @param {string} site
   * @param {number} [limit]
   */
  listForSite(site, limit = 30) {
    return [...this.index().values()]
      .filter((e) => e.site === site)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  }

  /** @param {string} id */
  file(id) {
    return join(this.dir, `${id}.json`);
  }
}

/**
 * @typedef {{ id: string, site: string, groupPattern: string, lastUrl: string, title: string,
 *   updatedAt: number, messageCount: number }} IndexEntry
 *
 * Index entry for a conversation; null if it has no user message or no site yet.
 * @param {Session} s
 * @returns {IndexEntry | null}
 */
function indexEntry(s) {
  const messageCount = s.messages.filter((m) => m.role === 'user' && m.content.some((b) => b.type === 'text')).length;
  if (!s.site || !messageCount) return null;
  return {
    id: s.id, site: s.site, groupPattern: s.groupPattern ?? '/', lastUrl: s.lastUrl ?? s.url,
    title: s.title, updatedAt: s.updatedAt, messageCount,
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
    messages: session.messages.map(({ raw, ...m }) => m),
    actions: Object.fromEntries(
      Object.entries(session.actions).map(([id, { reportedStatus, ...a }]) => [id, a]),
    ),
    usage: session.usage,
    site: session.site,
    groupPattern: session.groupPattern,
  };
}
