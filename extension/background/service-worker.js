// @ts-check
/**
 * Background service worker.
 *
 * DevTools panel pages can only use a limited set of extension APIs, so the
 * panel asks this worker (via chrome.runtime.sendMessage) to:
 *   - remember which conversation belongs to which tab (until the browser restarts)
 *   - insert/remove CSS in a tab (chrome.scripting, works regardless of the page's CSP)
 *   - store per-tab undo information
 *   - manage persistent CSS patches and reapply them when a matching page loads
 *
 * Messages: { cmd: string, ...args } → response { ok: true, value } | { ok: false, error }
 */

import { scopeMatches } from '../shared/url-scope.js';

/**
 * @typedef {object} Patch
 * @property {string} id
 * @property {string} name
 * @property {string} css
 * @property {import('../shared/url-scope.js').Scope} scope
 * @property {boolean} enabled
 * @property {number} createdAt
 * @property {string} [sourceUrl]   page where it was created
 */

// ─────────────────────────────────────────────────────────── message router

/** @type {Record<string, (msg: any) => Promise<any>>} */
const handlers = {
  // Conversation per tab. storage.session is cleared when the browser restarts,
  // which is exactly the lifetime we want (no automatic restore after restart).
  'conv.get': async ({ tabId }) => (await sessionGet(`conv:${tabId}`)) ?? null,
  'conv.set': async ({ tabId, conversationId }) => sessionSet(`conv:${tabId}`, conversationId),

  // Small per-tab key/value store (used for undo information).
  'kv.get': async ({ key }) => (await sessionGet(`kv:${key}`)) ?? null,
  'kv.set': async ({ key, value }) => sessionSet(`kv:${key}`, value),

  'css.insert': async ({ tabId, css }) => insertCss(tabId, css),
  'css.remove': async ({ tabId, css }) => removeCss(tabId, css),

  'patches.list': async () => getPatches(),
  'patches.add': async ({ patch }) => addPatch(patch),
  'patches.update': async ({ id, changes }) => updatePatch(id, changes),
  'patches.remove': async ({ id }) => removePatch(id),

  'options.open': async () => chrome.runtime.openOptionsPage(),
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false; // only our own extension pages
  const handler = handlers[msg?.cmd];
  if (!handler) {
    sendResponse({ ok: false, error: `Unknown command ${msg?.cmd}` });
    return false;
  }
  handler(msg).then(
    (value) => sendResponse({ ok: true, value }),
    (err) => sendResponse({ ok: false, error: String(err?.message ?? err) }),
  );
  return true; // async response
});

// Forget a tab's conversation and undo info when the tab closes.
// (The conversation itself stays on the server for a future "resume" feature.)
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await chrome.storage.session.remove([`conv:${tabId}`, `kv:undo:${tabId}`]);
});

// ─────────────────────────────────────────────────────────── helpers

/** @param {string} key */
async function sessionGet(key) {
  return (await chrome.storage.session.get(key))[key];
}

/**
 * @param {string} key
 * @param {unknown} value
 */
async function sessionSet(key, value) {
  if (value === null || value === undefined) await chrome.storage.session.remove(key);
  else await chrome.storage.session.set({ [key]: value });
}

/**
 * CSS is inserted as an author stylesheet in the top frame. Injected sheets do
 * not automatically win specificity ties with page styles, so the AI is told to
 * use specific selectors or !important.
 * @param {number} tabId
 * @param {string} css
 */
async function insertCss(tabId, css) {
  await chrome.scripting.insertCSS({ target: { tabId }, css, origin: 'AUTHOR' });
}

/**
 * removeCSS removes a sheet previously inserted with exactly the same text.
 * @param {number} tabId
 * @param {string} css
 */
async function removeCss(tabId, css) {
  await chrome.scripting.removeCSS({ target: { tabId }, css, origin: 'AUTHOR' });
}

// ─────────────────────────────────────────────────────────── persistent patches

/** @returns {Promise<Patch[]>} */
async function getPatches() {
  return (await chrome.storage.local.get('patches')).patches ?? [];
}

/** @param {Patch[]} patches */
async function savePatches(patches) {
  await chrome.storage.local.set({ patches });
}

/**
 * Run `fn` for every open tab whose URL matches the patch scope.
 * @param {Patch} patch
 * @param {(tabId: number) => Promise<void>} fn
 */
async function forMatchingTabs(patch, fn) {
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs
      .filter((t) => t.id !== undefined && t.url && scopeMatches(patch.scope, t.url))
      .map((t) => fn(/** @type {number} */ (t.id)).catch(() => {})),
  );
}

/**
 * Save a new patch. The CSS is usually already live in the current tab (the user
 * applied it before saving), so we don't insert it again here.
 * @param {Omit<Patch, 'id' | 'createdAt'>} patch
 */
async function addPatch(patch) {
  const full = { ...patch, id: crypto.randomUUID(), createdAt: Date.now(), enabled: patch.enabled !== false };
  await savePatches([...(await getPatches()), full]);
  return full;
}

/**
 * Update a patch (name, css, scope, enabled) and sync open tabs.
 * @param {string} id
 * @param {Partial<Patch>} changes
 */
async function updatePatch(id, changes) {
  const patches = await getPatches();
  const index = patches.findIndex((p) => p.id === id);
  if (index < 0) throw new Error('Patch not found');
  const before = patches[index];
  const after = { ...before, ...changes, id: before.id };
  patches[index] = after;
  await savePatches(patches);

  // Remove the old version where it was applied, then apply the new one.
  if (before.enabled) await forMatchingTabs(before, (tabId) => removeCss(tabId, before.css));
  if (after.enabled) await forMatchingTabs(after, (tabId) => insertCss(tabId, after.css));
  return after;
}

/** @param {string} id */
async function removePatch(id) {
  const patches = await getPatches();
  const patch = patches.find((p) => p.id === id);
  if (!patch) return;
  await savePatches(patches.filter((p) => p.id !== id));
  if (patch.enabled) await forMatchingTabs(patch, (tabId) => removeCss(tabId, patch.css));
}

// Reapply enabled patches as soon as a matching page starts loading.
chrome.webNavigation.onCommitted.addListener(async ({ tabId, frameId, url }) => {
  if (frameId !== 0) return;
  const patches = (await getPatches()).filter((p) => p.enabled && scopeMatches(p.scope, url));
  for (const patch of patches) {
    insertCss(tabId, patch.css).catch((err) => console.warn('Patch injection failed', patch.name, err));
  }
});
