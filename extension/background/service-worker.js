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
 *   - keep stored data in the current format after updates, export/import it
 *   - open the card on the page (the basic panel) from the toolbar button, and keep it
 *     open on the tab's next pages
 *
 * Messages: { cmd: string, ...args } → response { ok: true, value } | { ok: false, error }
 */

import { scopeMatches } from '../shared/url-scope.js';
import { buildExport, conversationsToWrite, mergeMemory, mergePatches, mergeTasks, parseImport } from '../shared/data-transfer.js';
import { indexEntry } from '../shared/agent/session-model.js';
import { DB_NAME as DIRECT_DB, openDb as openDirectDb } from '../panel/direct/stores.js';

/**
 * @typedef {object} Patch
 * @property {string} id
 * @property {string} name
 * @property {string} css           as written by the AI (shown and edited in the Patches tab)
 * @property {string} [injectedCss] what is inserted: css with boosted selectors (see shared/css-boost.js);
 *                                  older patches don't have it and use css
 * @property {import('../shared/url-scope.js').Scope} scope
 * @property {boolean} enabled
 * @property {number} createdAt
 * @property {string} [sourceUrl]   page where it was created
 * @property {{ label: string, activeLabel?: string, placeSelector?: string, position?: string }} [toggle]
 *   optional on/off button shown on matching pages (content/patch-toggles.js)
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

  // Screenshot of what the inspected tab shows right now (PNG data URL).
  'tab.capture': async ({ tabId }) => {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active) throw new Error('The inspected tab is not the one showing in its window, so it cannot be captured. Switch to it and ask again.');
    return chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  },

  'css.insert': async ({ tabId, css, frame }) => insertCss(tabId, css, frame),
  // The tab's frames with their real addresses (a frame from another site may have moved on from its src).
  'frames.list': async ({ tabId }) => ((await chrome.webNavigation.getAllFrames({ tabId })) ?? [])
    .filter((f) => f.frameId !== 0).map((f) => ({ url: f.url, parentFrameId: f.parentFrameId })),
  'css.remove': async ({ tabId, css, frame }) => removeCss(tabId, css, frame),

  'patches.list': async () => getPatches(),
  'patches.add': async ({ patch }) => addPatch(patch),
  'patches.update': async ({ id, changes }) => updatePatch(id, changes),
  'patches.remove': async ({ id }) => removePatch(id),

  'options.open': async () => chrome.runtime.openOptionsPage(),

  // The panel's Server button: start / stop / check the local agent server through the native host.
  'services.call': async ({ action }) => servicesCall(action),

  // The setup page's "Try it now": an article with the card open on it.
  'card.tryIt': async () => {
    const tab = await chrome.tabs.create({ url: 'https://en.wikipedia.org/wiki/World_Wide_Web' });
    // Opens on its own once the page has loaded (webNavigation.onDOMContentLoaded, below).
    if (tab.id !== undefined) await sessionSet(`card:${tab.id}`, { open: true, minimized: false });
  },

  // The DevTools panel opened on this tab: the card there steps aside (the conversation continues in DevTools).
  'card.devtoolsOpened': async ({ tabId }) => {
    if ((await sessionGet(`card:${tabId}`))?.open) chrome.tabs.sendMessage(tabId, { type: 'card.devtools' }).catch(() => {});
  },

  // Options → Your data
  'data.summary': async () => ({
    patches: (await getPatches()).length,
    tasks: ((await chrome.storage.local.get('tasks')).tasks ?? []).length,
    storageVersion: STORAGE_VERSION,
    extensionVersion: chrome.runtime.getManifest().version,
    // Direct mode keeps conversations (IndexedDB) and site memory ("memory:<site>" keys) in the extension.
    conversations: await countDirectConversations(),
    memorySites: Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith(MEMORY_PREFIX)).length,
  }),
  'data.export': async () => buildExport({
    patches: await getPatches(),
    settings: (await chrome.storage.local.get('settings')).settings ?? {},
    extensionVersion: chrome.runtime.getManifest().version,
    conversations: await readDirectConversations(),
    memory: Object.entries(await chrome.storage.local.get(null))
      .filter(([key]) => key.startsWith(MEMORY_PREFIX)).map(([, record]) => record),
    tasks: (await chrome.storage.local.get('tasks')).tasks ?? [],
  }),
  'data.import': async ({ data }) => importData(data),
  'data.clear': async () => clearData(),
};

/**
 * Commands a content script (running inside web pages) may send. They only act
 * on the sender's own tab, and only on patches that have a toggle button.
 * Everything else is reserved for extension pages (DevTools panel, options).
 * @type {Record<string, (msg: any, tab: chrome.tabs.Tab) => Promise<any>>}
 */
const contentHandlers = {
  // The card on the page (content/card-host.js): its tab, and whether it is open / minimised there.
  'card.get': async (_msg, tab) => ({ tabId: tab.id, ...((await sessionGet(`card:${tab.id}`)) ?? { open: false }) }),
  'card.set': async ({ open, minimized }, tab) => {
    const now = (await sessionGet(`card:${tab.id}`)) ?? { open: true };
    await sessionSet(`card:${tab.id}`, {
      open: typeof open === 'boolean' ? open : now.open,
      minimized: typeof minimized === 'boolean' ? minimized : Boolean(now.minimized),
    });
  },
  'toggles.forTab': async (_msg, tab) =>
    (await getPatches())
      .filter((p) => p.toggle && tab.url && scopeMatches(p.scope, tab.url))
      .map(({ id, name, enabled, toggle }) => ({ id, name, enabled, toggle })),
  'patches.toggle': async ({ id }, tab) => {
    const patch = (await getPatches()).find((p) => p.id === id);
    if (!patch?.toggle || !tab.url || !scopeMatches(patch.scope, tab.url)) throw new Error('Not allowed');
    return updatePatch(id, { enabled: !patch.enabled });
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (typeof msg?.cmd !== 'string') return false; // notes between the page and the panel (card.picked), not commands
  const fromExtensionPage = sender.url?.startsWith(`chrome-extension://${chrome.runtime.id}/`);
  if (!fromExtensionPage) {
    const handler = sender.tab ? contentHandlers[msg?.cmd] : undefined;
    if (!handler) {
      sendResponse({ ok: false, error: 'Not allowed' });
      return false;
    }
    handler(msg, /** @type {chrome.tabs.Tab} */ (sender.tab)).then(
      (value) => sendResponse({ ok: true, value }),
      (err) => sendResponse({ ok: false, error: String(err?.message ?? err) }),
    );
    return true;
  }
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
 * The CSS a patch inserts (boosted copy if it has one).
 * @param {Patch} patch
 */
function patchCss(patch) {
  return patch.injectedCss || patch.css;
}

/**
 * CSS is inserted as an author stylesheet in the top frame. Injected sheets do
 * not automatically win specificity ties with page styles, so the AI is told to
 * use specific selectors or !important.
 * @param {number} tabId
 * @param {string} css
 */
async function insertCss(tabId, css, frame = undefined) {
  await chrome.scripting.insertCSS({ target: await cssTarget(tabId, frame), css, origin: 'AUTHOR' });
}

/**
 * Where CSS goes: the page itself, or the iframe(s) at a URL (CSS changes and patches for content in a frame).
 * A frame counts as the same when its address matches without the query and hash (they change between loads).
 * @param {number} tabId
 * @param {string} [frame]
 */
async function cssTarget(tabId, frame) {
  if (!frame) return { tabId };
  const frames = (await chrome.webNavigation.getAllFrames({ tabId })) ?? [];
  const frameIds = frames.filter((f) => f.frameId !== 0 && sameFrame(f.url, frame)).map((f) => f.frameId);
  if (!frameIds.length) throw new Error(`The frame ${frame} is not on this page (any more)`);
  return { tabId, frameIds };
}

/** @param {string} a @param {string} b */
function sameFrame(a, b) {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.origin === y.origin && x.pathname === y.pathname;
  } catch {
    return a === b;
  }
}

/**
 * removeCSS removes a sheet previously inserted with exactly the same text.
 * @param {number} tabId
 * @param {string} css
 */
async function removeCss(tabId, css, frame = undefined) {
  await chrome.scripting.removeCSS({ target: await cssTarget(tabId, frame), css, origin: 'AUTHOR' });
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
  if (before.enabled) await forMatchingTabs(before, (tabId) => removeCss(tabId, patchCss(before), before.frame).catch(() => {}));
  if (after.enabled) await forMatchingTabs(after, (tabId) => insertCss(tabId, patchCss(after), after.frame).catch(() => {}));
  return after;
}

/** @param {string} id */
async function removePatch(id) {
  const patches = await getPatches();
  const patch = patches.find((p) => p.id === id);
  if (!patch) return;
  await savePatches(patches.filter((p) => p.id !== id));
  if (patch.enabled) await forMatchingTabs(patch, (tabId) => removeCss(tabId, patchCss(patch), patch.frame).catch(() => {}));
}

// Reapply enabled patches as soon as a matching page starts loading; a patch for content in an iframe when
// that frame loads, on pages its scope matches.
chrome.webNavigation.onCommitted.addListener(async ({ tabId, frameId, url }) => {
  if (frameId === 0) {
    const patches = (await getPatches()).filter((p) => p.enabled && !p.frame && scopeMatches(p.scope, url));
    for (const patch of patches) {
      insertCss(tabId, patchCss(patch)).catch((err) => console.warn('Patch injection failed', patch.name, err));
    }
    return;
  }
  const framed = (await getPatches()).filter((p) => p.enabled && p.frame && sameFrame(p.frame, url));
  if (!framed.length) return;
  const top = await chrome.tabs.get(tabId).catch(() => null);
  for (const patch of framed.filter((p) => top?.url && scopeMatches(p.scope, top.url))) {
    chrome.scripting.insertCSS({ target: { tabId, frameIds: [frameId] }, css: patchCss(patch), origin: 'AUTHOR' })
      .catch((err) => console.warn('Patch injection failed', patch.name, err));
  }
});

// ─────────────────────────────────────────────────────────── the local server (Server button)

/** The native messaging host registered by `npm run services:install` (server/native-host/host.js). */
const SERVICES_HOST = 'com.integratedai.server';

/**
 * Ask the helper program to start, stop or check the local agent server. Needs the optional
 * nativeMessaging permission (the panel asks for it on the first click) and the helper registered once.
 * @param {string} cmd
 * @returns {Promise<{ running?: boolean, port?: number, logFile?: string, note?: string, error?: string,
 *   needsPermission?: true, notInstalled?: true, installCommand?: string }>}
 */
async function servicesCall(cmd) {
  if (!['status', 'start', 'stop'].includes(cmd)) throw new Error('Unknown command');
  if (!(await chrome.permissions.contains({ permissions: ['nativeMessaging'] })) || !chrome.runtime.sendNativeMessage) {
    return { needsPermission: true };
  }
  try {
    return await chrome.runtime.sendNativeMessage(SERVICES_HOST, { cmd });
  } catch (err) {
    const message = String(/** @type {any} */ (err)?.message ?? err);
    if (/not found|forbidden|access.*denied/i.test(message)) {
      return { notInstalled: true, installCommand: `npm run services:install -- --id ${chrome.runtime.id}` };
    }
    return { error: message };
  }
}

// ─────────────────────────────────────────────────────────── the card on the page

/** Pages no extension may run on (Chrome's own pages, the Web Store). */
const CARD_BLOCKED = /^(chrome|chrome-extension|chrome-untrusted|devtools|edge|about|view-source|data|file):|^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/;

// The toolbar button (and its shortcut, Alt+Shift+A): open the card on this page, or close it.
chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id === undefined) return;
  if (!tab.url || CARD_BLOCKED.test(tab.url)) {
    await flashNote(tab.id, "IntegratedAI can't open on this page (Chrome doesn't let extensions run here)");
    return;
  }
  const now = await sessionGet(`card:${tab.id}`);
  // Closed → open; open but minimised → shown again; open → closed.
  const next = !now?.open ? { open: true, minimized: false } : now.minimized ? { open: true, minimized: false } : { open: false, minimized: false };
  await sessionSet(`card:${tab.id}`, next);
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/card-host.js'] });
  } catch {
    await sessionSet(`card:${tab.id}`, { open: false, minimized: false });
    await flashNote(tab.id, "IntegratedAI can't open on this page");
  }
});

// The card stays open on the tab's next pages: put it back once each new page has its DOM.
chrome.webNavigation.onDOMContentLoaded.addListener(async ({ tabId, frameId }) => {
  if (frameId !== 0 || !(await sessionGet(`card:${tabId}`))?.open) return;
  chrome.scripting.executeScript({ target: { tabId }, files: ['content/card-host.js'] }).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => { chrome.storage.session.remove(`card:${tabId}`).catch(() => {}); });

/**
 * Say something on the toolbar button for a few seconds (its tooltip, and a "!" badge).
 * @param {number} tabId
 * @param {string} text
 */
async function flashNote(tabId, text) {
  await chrome.action.setBadgeText({ tabId, text: '!' });
  await chrome.action.setTitle({ tabId, title: text });
  setTimeout(() => {
    chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
    chrome.action.setTitle({ tabId, title: chrome.runtime.getManifest().action?.default_title ?? 'IntegratedAI' }).catch(() => {});
  }, 4000);
}

// ─────────────────────────────────────────────────────────── stored data: versions, migrations, export/import

/**
 * Format version of what this extension keeps in chrome.storage.local.
 * Chrome keeps that storage across extension updates; when a future update changes
 * its shape, add a step to STORAGE_MIGRATIONS and bump STORAGE_VERSION.
 */
const STORAGE_VERSION = 1;

/** @type {{ to: number, run: (data: Record<string, any>) => Record<string, any> }[]} */
const STORAGE_MIGRATIONS = [
  // { to: 2, run: (data) => ({ ...data, patches: data.patches.map(…) }) },
];

/** Bring stored data up to STORAGE_VERSION. Safe to run on every start. */
async function migrateStorage() {
  const data = await chrome.storage.local.get(null);
  const from = Number(data.storageVersion) || 0;
  if (from >= STORAGE_VERSION) return;
  let next = { ...data };
  // Version 0 → 1: data from before versioning. Make sure every patch has the fields we rely on.
  next.patches = (Array.isArray(next.patches) ? next.patches : [])
    .filter((p) => p && typeof p.id === 'string' && typeof p.css === 'string' && p.scope)
    .map((p) => ({ enabled: true, createdAt: Date.now(), name: 'Patch', ...p }));
  for (const migration of STORAGE_MIGRATIONS.filter((m) => m.to > from).sort((a, b) => a.to - b.to)) {
    next = migration.run(next);
  }
  next.storageVersion = STORAGE_VERSION;
  await chrome.storage.local.set(next);
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await migrateStorage();
  // First install: open the options page so the user can connect the agent server.
  if (reason === chrome.runtime.OnInstalledReason.INSTALL) chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(() => { migrateStorage(); });

/**
 * Import patches (merged), settings (never the pairing token), saved tasks (new ones added), and direct
 * mode's conversations and site memory (merged; nothing here is replaced by an older copy).
 * @param {unknown} data parsed export file
 */
async function importData(data) {
  const { patches, settings, conversations, memory, tasks } = parseImport(data);
  const taskResult = mergeTasks((await chrome.storage.local.get('tasks')).tasks ?? [], tasks);
  if (taskResult.added) await chrome.storage.local.set({ tasks: taskResult.merged });
  const imported = conversations.length ? await importDirectConversations(conversations) : { added: 0, updated: 0 };
  let notes = 0;
  for (const record of memory) {
    const key = MEMORY_PREFIX + record.site;
    const { merged, added } = mergeMemory((await chrome.storage.local.get(key))[key] ?? null, record);
    await chrome.storage.local.set({ [key]: merged });
    notes += added;
  }
  const result = mergePatches(await getPatches(), patches);
  await savePatches(result.merged);
  const current = (await chrome.storage.local.get('settings')).settings ?? {};
  await chrome.storage.local.set({ settings: { ...current, ...settings } });
  // Show enabled imported patches right away in open tabs that match.
  for (const patch of patches.filter((p) => p.enabled)) await forMatchingTabs(patch, (tabId) => insertCss(tabId, patchCss(patch), patch.frame).catch(() => {}));
  return {
    added: result.added, updated: result.updated, skipped: result.skipped, settings: Object.keys(settings),
    conversations: imported.added + imported.updated, notes, tasks: taskResult.added,
  };
}

/** Delete everything the extension stored (patches, settings, direct-mode conversations and memory, per-tab data). */
async function clearData() {
  for (const patch of (await getPatches()).filter((p) => p.enabled)) await forMatchingTabs(patch, (tabId) => removeCss(tabId, patchCss(patch), patch.frame).catch(() => {}));
  await chrome.storage.local.clear();
  await chrome.storage.session.clear();
  await new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(DIRECT_DB);
    req.onsuccess = req.onerror = req.onblocked = () => resolve(undefined);
  });
  await chrome.storage.local.set({ storageVersion: STORAGE_VERSION });
}

/** Direct mode's site memory keys in chrome.storage.local (see panel/direct/stores.js). */
const MEMORY_PREFIX = 'memory:';

/** @template T @param {IDBRequest<T>} req @returns {Promise<T>} */
const idb = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });

/** All direct-mode conversations ([] if direct mode was never used; doesn't create the database). */
async function readDirectConversations() {
  if (!(await indexedDB.databases()).some((d) => d.name === DIRECT_DB)) return [];
  const db = await openDirectDb();
  try {
    return await idb(db.transaction('conversations').objectStore('conversations').getAll());
  } finally {
    db.close();
  }
}

/**
 * Write imported conversations (and their History entries) unless the copy here is newer.
 * An open panel shows them in its History list.
 * @param {any[]} incoming
 */
async function importDirectConversations(incoming) {
  const db = await openDirectDb();
  try {
    const here = await idb(db.transaction('conversations').objectStore('conversations').getAll());
    const result = conversationsToWrite(new Map(here.map((s) => [s.id, s.updatedAt])), incoming);
    const tx = db.transaction(['conversations', 'history'], 'readwrite');
    for (const session of result.write) {
      tx.objectStore('conversations').put(session);
      const entry = indexEntry(session);
      if (entry) tx.objectStore('history').put(entry);
    }
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error); });
    return result;
  } finally {
    db.close();
  }
}

/** Number of direct-mode conversations with at least one message (0 if direct mode was never used). */
async function countDirectConversations() {
  if (!(await indexedDB.databases()).some((d) => d.name === DIRECT_DB)) return 0;
  return new Promise((resolve) => {
    const open = indexedDB.open(DIRECT_DB);
    open.onerror = () => resolve(0);
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains('history')) { db.close(); resolve(0); return; }
      const req = db.transaction('history').objectStore('history').count();
      req.onsuccess = () => { db.close(); resolve(req.result); };
      req.onerror = () => { db.close(); resolve(0); };
    };
  });
}
