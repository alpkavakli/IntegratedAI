// @ts-check
/**
 * Export / import of the data the EXTENSION keeps in Chrome: saved patches,
 * settings, from version 2 on direct mode's conversations and site memory
 * (shared and private), and from version 3 on saved tasks. In local server mode, conversations and memory live in
 * the server's data folder instead, which keeps its own backups.
 *
 * Why: Chrome keeps extension storage across updates, but deletes it on
 * uninstall, and a development copy and the Web Store version are separate
 * extensions with separate storage. An export file moves data between them.
 *
 * Secrets are never exported: not the pairing token, not API keys.
 *
 * Version history: 1 = patches + settings; 2 = adds `conversations` and `memory`; 3 = adds `tasks`.
 * Older files still import.
 */

import { validate } from './validate.js';
import { validateTaskSteps } from './actions.js';
import { isSessionId } from './agent/session-model.js';
import { MEMORY_LIMITS } from './agent/memory.js';

export const EXPORT_FORMAT = 'integratedai-extension-data';
export const EXPORT_VERSION = 3;

const SCOPE_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['origin', 'prefix', 'pattern', 'group'] },
    value: { type: 'string' },
    pattern: { type: 'string' },
    name: { type: 'string' },
  },
  required: ['type', 'value'],
};

const PATCH_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    css: { type: 'string' },
    scope: SCOPE_SCHEMA,
    enabled: { type: 'boolean' },
    createdAt: { type: 'number' },
    sourceUrl: { type: 'string' },
    frame: { type: 'string' },
    toggle: {
      type: 'object',
      properties: {
        label: { type: 'string' },
        activeLabel: { type: 'string' },
        placeSelector: { type: 'string' },
        position: { type: 'string', enum: ['append', 'prepend', 'before', 'after'] },
      },
      required: ['label'],
    },
  },
  required: ['id', 'name', 'css', 'scope'],
};

const MEMORY_SCHEMA = {
  type: 'object',
  properties: {
    site: { type: 'string' },
    groups: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, name: { type: 'string' }, pattern: { type: 'string' }, createdAt: { type: 'number' } },
        required: ['id', 'name', 'pattern'],
      },
    },
    notes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          text: { type: 'string' },
          scope: { type: 'string' },
          by: { type: 'string', enum: ['assistant', 'user'] },
          createdAt: { type: 'number' },
          conversationId: { type: 'string' },
        },
        required: ['id', 'text', 'scope', 'by', 'createdAt'],
      },
    },
  },
  required: ['site', 'groups', 'notes'],
};

/** Settings that may be imported (never the token). */
const IMPORTABLE_SETTINGS = ['serverUrl', 'executeJs', 'webTools', 'askBeforeInspections', 'contextDefaults', 'defaultAgentMode', 'ollamaCompact'];

/**
 * @param {{ patches: any[], settings: Record<string, any>, extensionVersion: string,
 *   conversations?: any[], memory?: any[], tasks?: any[] }} data
 */
export function buildExport({ patches, settings, extensionVersion, conversations = [], memory = [], tasks = [] }) {
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    extensionVersion,
    patches,
    settings: Object.fromEntries(IMPORTABLE_SETTINGS.filter((k) => k in settings).map((k) => [k, settings[k]])),
    conversations: conversations.map(({ busy, ...session }) => session), // `busy` is runtime-only
    memory,
    tasks,
  };
}

/**
 * Is an imported saved task well formed, with steps that pass the same checks as the AI's? Its steps run
 * on pages when the user clicks Run, so a damaged or hand-edited file must not get odd steps in.
 * @param {any} t
 */
function taskErrors(t) {
  if (!t || typeof t !== 'object' || typeof t.id !== 'string' || !t.id || t.id.length > 100) return ['no id'];
  if (typeof t.name !== 'string' || !t.name.trim() || t.name.length > 80) return ['no name'];
  if (typeof t.site !== 'string' || typeof t.created !== 'number') return ['damaged'];
  let url = null;
  try { url = new URL(t.startUrl); } catch { /* checked below */ }
  if (!url || !['http:', 'https:'].includes(url.protocol)) return ['the start page must be an http(s) address'];
  return validateTaskSteps(t.steps);
}

/**
 * Does an imported conversation have the fields the panel and agent rely on?
 * (Not checked with validate(): a long conversation legitimately exceeds its
 * array and string limits.)
 * @param {any} s
 */
function isConversation(s) {
  return !!s && typeof s === 'object' && isSessionId(s.id)
    && typeof s.createdAt === 'number' && typeof s.updatedAt === 'number'
    && typeof s.title === 'string' && typeof s.provider === 'string' && typeof s.model === 'string'
    && Array.isArray(s.messages) && s.messages.every((/** @type {any} */ m) => m && typeof m.role === 'string' && Array.isArray(m.content))
    && !!s.actions && typeof s.actions === 'object'
    && (s.memoryMode === undefined || ['shared', 'private', 'off'].includes(s.memoryMode));
}

/**
 * Check an import file and return what it contains. Throws a readable error.
 * @param {unknown} data parsed JSON
 * @returns {{ patches: any[], settings: Record<string, any>, conversations: any[], memory: any[], tasks: any[] }}
 */
export function parseImport(data) {
  const d = /** @type {any} */ (data);
  if (!d || d.format !== EXPORT_FORMAT) throw new Error('This is not an IntegratedAI export file.');
  if (typeof d.version !== 'number' || d.version > EXPORT_VERSION) {
    throw new Error('This export was made by a newer version of the extension. Update the extension first.');
  }
  if (!Array.isArray(d.patches)) throw new Error('The export file has no patch list.');
  const patches = [];
  for (const [i, patch] of d.patches.entries()) {
    const errors = validate(PATCH_SCHEMA, patch, `patches[${i}]`);
    if (errors.length) throw new Error(`Patch ${i + 1} is damaged: ${errors[0]}`);
    patches.push({ enabled: true, createdAt: Date.now(), ...patch });
  }
  const settings = Object.fromEntries(
    Object.entries(d.settings ?? {}).filter(([k]) => IMPORTABLE_SETTINGS.includes(k)),
  );
  const conversations = [];
  for (const [i, session] of (Array.isArray(d.conversations) ? d.conversations : []).entries()) {
    if (!isConversation(session)) throw new Error(`Conversation ${i + 1} is damaged.`);
    conversations.push({ openToolCalls: [], providerState: {}, usage: { inputTokens: 0, outputTokens: 0, costUsd: null }, ...session });
  }
  const memory = [];
  for (const [i, record] of (Array.isArray(d.memory) ? d.memory : []).entries()) {
    const errors = validate(MEMORY_SCHEMA, record, `memory[${i}]`);
    if (errors.length) throw new Error(`Site memory ${i + 1} is damaged: ${errors[0]}`);
    memory.push(record);
  }
  const tasks = [];
  for (const [i, task] of (Array.isArray(d.tasks) ? d.tasks : []).entries()) {
    const errors = taskErrors(task);
    if (errors.length) throw new Error(`Saved task ${i + 1} is damaged: ${errors[0]}`);
    const { id, name, site, startUrl, steps, created, lastRun } = task;
    tasks.push({ id, name, site, startUrl, steps, created, ...(typeof lastRun === 'number' ? { lastRun } : {}) });
  }
  return { patches, settings, conversations, memory, tasks };
}

/**
 * Add imported tasks that aren't here yet (by id); tasks already here are kept as they are.
 * @param {any[]} existing
 * @param {any[]} incoming
 */
export function mergeTasks(existing, incoming) {
  const ids = new Set(existing.map((t) => t.id));
  const added = incoming.filter((t) => !ids.has(t.id));
  return { merged: [...added, ...existing], added: added.length };
}

/**
 * Which imported conversations to write: new ones, and ones newer than the copy
 * already here. An older or identical copy never overwrites what's here.
 * @param {Map<string, number>} existingUpdatedAt  conversation id → updatedAt of the copy here
 * @param {any[]} incoming
 */
export function conversationsToWrite(existingUpdatedAt, incoming) {
  const write = [];
  let added = 0;
  let updated = 0;
  let skipped = 0;
  for (const session of incoming) {
    const here = existingUpdatedAt.get(session.id);
    if (here === undefined) { write.push(session); added++; }
    else if (session.updatedAt > here) { write.push(session); updated++; }
    else skipped++;
  }
  return { write, added, updated, skipped };
}

/**
 * Merge an imported site memory into the one here (null if there is none).
 * Page groups and notes are joined: a group whose id or pattern is already here
 * isn't added again, nor is a note with the same id or the same text and scope.
 * Over the per-site note limit, the oldest notes are dropped.
 * @param {import('./agent/memory.js').SiteMemory | null} existing
 * @param {import('./agent/memory.js').SiteMemory} incoming
 */
export function mergeMemory(existing, incoming) {
  const merged = existing ? structuredClone(existing) : { site: incoming.site, groups: [], notes: [] };
  let added = 0;
  for (const group of incoming.groups) {
    if (!merged.groups.some((g) => g.id === group.id || g.pattern === group.pattern)) merged.groups.push(group);
  }
  for (const note of incoming.notes) {
    if (merged.notes.some((n) => n.id === note.id || (n.text === note.text && n.scope === note.scope))) continue;
    merged.notes.push(note);
    added++;
  }
  merged.notes.sort((a, b) => a.createdAt - b.createdAt);
  if (merged.notes.length > MEMORY_LIMITS.notesPerSite) merged.notes = merged.notes.slice(-MEMORY_LIMITS.notesPerSite);
  return { merged, added };
}

/**
 * Merge imported patches into the existing ones. A patch with the same id replaces
 * the existing one; an identical patch (same CSS and scope) under another id is skipped.
 * @param {any[]} existing
 * @param {any[]} incoming
 */
export function mergePatches(existing, incoming) {
  const merged = [...existing];
  let added = 0;
  let updated = 0;
  let skipped = 0;
  const sameContent = (/** @type {any} */ a, /** @type {any} */ b) => a.css === b.css && JSON.stringify(a.scope) === JSON.stringify(b.scope);
  for (const patch of incoming) {
    const byId = merged.findIndex((p) => p.id === patch.id);
    if (byId >= 0) {
      merged[byId] = patch;
      updated++;
    } else if (merged.some((p) => sameContent(p, patch))) {
      skipped++;
    } else {
      merged.push(patch);
      added++;
    }
  }
  return { merged, added, updated, skipped };
}
