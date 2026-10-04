// @ts-check
/**
 * Site memory: short notes the AI (or you) keep about a site and its page
 * groups, so a new conversation starts out knowing the site.
 *
 * One JSON file per site: <dataDir>/memory/<site>.json
 *   {
 *     site: "webnovel.com",
 *     groups: [{ id, name: "Chapter reader", pattern: "/book/*\/*" }],
 *     notes:  [{ id, text, scope: "site" | "<pattern>", by: "assistant" | "user", createdAt, conversationId? }]
 *   }
 *
 * A note with scope "site" applies to every page of the site; a note with a
 * pattern scope applies to pages matching that pattern (its page group).
 *
 * Safety: notes are data shown to the model, never instructions. A page can
 * only influence notes for its own site, and every note is visible and
 * deletable in the panel's Memory tab.
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { isValidPattern, matchPattern, pathOf, resolveGroup, siteKey } from '../../../extension/shared/page-groups.js';

export const MEMORY_LIMITS = { noteChars: 300, notesPerSite: 100, contextNotes: 30, groupName: 40 };

/**
 * @typedef {{ id: string, name: string, pattern: string, createdAt?: number }} Group
 * @typedef {{ id: string, text: string, scope: string, by: 'assistant' | 'user', createdAt: number, conversationId?: string }} Note
 * @typedef {{ site: string, groups: Group[], notes: Note[] }} SiteMemory
 */

const newId = () => randomBytes(3).toString('hex'); // short ids the model can quote

export class MemoryStore {
  /** @param {string} dataDir */
  constructor(dataDir) {
    this.dir = join(dataDir, 'memory');
    mkdirSync(this.dir, { recursive: true });
    /** @type {Map<string, SiteMemory>} */
    this.cache = new Map();
  }

  /** @param {string} site */
  file(site) {
    return join(this.dir, `${site.replace(/[^a-z0-9.-]/gi, '_')}.json`);
  }

  /**
   * @param {string} site
   * @returns {SiteMemory}
   */
  load(site) {
    let memory = this.cache.get(site);
    if (!memory) {
      const file = this.file(site);
      memory = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { site, groups: [], notes: [] };
      this.cache.set(site, /** @type {SiteMemory} */ (memory));
    }
    return /** @type {SiteMemory} */ (memory);
  }

  /** @param {SiteMemory} memory */
  save(memory) {
    const file = this.file(memory.site);
    writeFileSync(`${file}.tmp`, JSON.stringify(memory, null, 1));
    renameSync(`${file}.tmp`, file);
  }

  /**
   * Everything about the site of `url`, for the panel's Memory tab.
   * @param {string} url
   */
  forUrl(url) {
    const site = siteKey(url);
    if (!site) return null;
    const memory = this.load(site);
    const path = pathOf(url);
    const group = resolveGroup(memory.groups, path);
    return {
      site,
      path,
      group,
      groups: memory.groups,
      notes: memory.notes.map((n) => ({ ...n, appliesHere: n.scope === 'site' || matchPattern(n.scope, path) })),
    };
  }

  /**
   * The small part sent to the model: the current page group and the notes
   * that apply to this page (site-wide first, then page-group notes).
   * @param {string} url
   */
  contextFor(url) {
    const info = this.forUrl(url);
    if (!info) return null;
    const notes = info.notes
      .filter((n) => n.appliesHere)
      .sort((a, b) => Number(a.scope !== 'site') - Number(b.scope !== 'site') || a.createdAt - b.createdAt)
      .slice(-MEMORY_LIMITS.contextNotes)
      .map((n) => ({ id: n.id, text: n.text, scope: n.scope === 'site' ? 'site' : 'page_group', by: n.by }));
    return {
      site: info.site,
      pageGroup: { name: info.group.name, pattern: info.group.pattern, named: !info.group.auto },
      otherGroups: info.groups.filter((g) => g.pattern !== info.group.pattern).map((g) => `${g.name} = ${g.pattern}`),
      notes,
    };
  }

  /**
   * @param {string} url
   * @param {{ text: string, scope: 'site' | 'page_group', by: 'assistant' | 'user', conversationId?: string }} n
   */
  addNote(url, { text, scope, by, conversationId }) {
    const info = this.requireSite(url);
    const memory = this.load(info.site);
    const clean = String(text).trim().slice(0, MEMORY_LIMITS.noteChars);
    if (!clean) throw new Error('Empty note');
    const noteScope = scope === 'page_group' ? info.group.pattern : 'site';
    const duplicate = memory.notes.find((n) => n.scope === noteScope && n.text.toLowerCase() === clean.toLowerCase());
    if (duplicate) return duplicate;
    if (memory.notes.length >= MEMORY_LIMITS.notesPerSite) {
      throw new Error(`This site already has ${MEMORY_LIMITS.notesPerSite} notes; forget some first.`);
    }
    /** @type {Note} */
    const note = { id: newId(), text: clean, scope: noteScope, by, createdAt: Date.now(), ...(conversationId ? { conversationId } : {}) };
    memory.notes.push(note);
    this.save(memory);
    return note;
  }

  /**
   * @param {string} site
   * @param {string} id
   * @param {string} text
   */
  updateNote(site, id, text) {
    const memory = this.load(site);
    const note = memory.notes.find((n) => n.id === id);
    if (!note) throw new Error('Note not found');
    const clean = String(text).trim().slice(0, MEMORY_LIMITS.noteChars);
    if (!clean) throw new Error('Empty note');
    note.text = clean;
    this.save(memory);
    return note;
  }

  /**
   * @param {string} site
   * @param {string} id
   */
  deleteNote(site, id) {
    const memory = this.load(site);
    const note = memory.notes.find((n) => n.id === id);
    if (!note) throw new Error(`No note with id ${id}`);
    memory.notes = memory.notes.filter((n) => n.id !== id);
    this.save(memory);
    return note;
  }

  /**
   * Name a page group (or rename/re-pattern an existing one). The pattern must
   * match the page the request came from, so groups always describe real pages.
   * @param {string} url
   * @param {{ name: string, pattern: string }} g
   */
  defineGroup(url, { name, pattern }) {
    const info = this.requireSite(url);
    const cleanName = String(name).trim().slice(0, MEMORY_LIMITS.groupName);
    if (!cleanName) throw new Error('Empty group name');
    if (!isValidPattern(pattern)) throw new Error(`Invalid pattern "${pattern}" (use /segments with * or a final **)`);
    if (!matchPattern(pattern, info.path)) throw new Error(`Pattern ${pattern} does not match the current page path ${info.path}`);

    const memory = this.load(info.site);
    // Same pattern → rename. Same name → change its pattern (and move its notes).
    let group = memory.groups.find((g) => g.pattern === pattern) ?? memory.groups.find((g) => g.name === cleanName);
    if (group) {
      this.moveNotes(memory, group.pattern, pattern);
      group.name = cleanName;
      group.pattern = pattern;
    } else {
      // Notes made under the old automatic pattern of this page follow the new group.
      this.moveNotes(memory, info.group.auto ? info.group.pattern : '', pattern);
      group = { id: newId(), name: cleanName, pattern, createdAt: Date.now() };
      memory.groups.push(group);
    }
    this.save(memory);
    return group;
  }

  /**
   * User edit from the Memory tab.
   * @param {string} site
   * @param {string} id
   * @param {{ name?: string, pattern?: string }} changes
   */
  updateGroup(site, id, changes) {
    const memory = this.load(site);
    const group = memory.groups.find((g) => g.id === id);
    if (!group) throw new Error('Group not found');
    if (changes.pattern !== undefined) {
      if (!isValidPattern(changes.pattern)) throw new Error('Invalid pattern');
      this.moveNotes(memory, group.pattern, changes.pattern);
      group.pattern = changes.pattern;
    }
    if (changes.name !== undefined) group.name = String(changes.name).trim().slice(0, MEMORY_LIMITS.groupName) || group.name;
    this.save(memory);
    return group;
  }

  /**
   * Delete a group. Its notes stay attached to the pattern (still shown on matching pages).
   * @param {string} site
   * @param {string} id
   */
  deleteGroup(site, id) {
    const memory = this.load(site);
    memory.groups = memory.groups.filter((g) => g.id !== id);
    this.save(memory);
  }

  /**
   * @param {SiteMemory} memory
   * @param {string} from
   * @param {string} to
   */
  moveNotes(memory, from, to) {
    if (!from || from === to) return;
    for (const n of memory.notes) if (n.scope === from) n.scope = to;
  }

  /** @param {string} url */
  requireSite(url) {
    const info = this.forUrl(url);
    if (!info) throw new Error('This page has no site memory (not an http(s) or file page)');
    return info;
  }
}
