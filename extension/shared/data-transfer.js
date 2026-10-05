// @ts-check
/**
 * Export / import of the data the EXTENSION keeps in Chrome (saved patches and
 * settings). Conversations and site memory live on the server, in its data
 * folder, and are not part of this file.
 *
 * Why: Chrome keeps extension storage across updates, but deletes it on
 * uninstall, and a development copy and the Web Store version are separate
 * extensions with separate storage. An export file moves patches between them.
 *
 * The pairing token is never exported (it's a secret for this machine's server).
 */

import { validate } from './validate.js';

export const EXPORT_FORMAT = 'integratedai-extension-data';
export const EXPORT_VERSION = 1;

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

/** Settings that may be imported (never the token). */
const IMPORTABLE_SETTINGS = ['serverUrl', 'executeJs', 'webTools', 'askBeforeInspections', 'contextDefaults'];

/**
 * @param {{ patches: any[], settings: Record<string, any>, extensionVersion: string }} data
 */
export function buildExport({ patches, settings, extensionVersion }) {
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    extensionVersion,
    patches,
    settings: Object.fromEntries(IMPORTABLE_SETTINGS.filter((k) => k in settings).map((k) => [k, settings[k]])),
  };
}

/**
 * Check an import file and return what it contains. Throws a readable error.
 * @param {unknown} data parsed JSON
 * @returns {{ patches: any[], settings: Record<string, any> }}
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
  return { patches, settings };
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
