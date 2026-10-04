// @ts-check
/**
 * Executes APPROVED changes and keeps what is needed to undo them.
 *
 *   inject_css      → inserted with chrome.scripting.insertCSS (via the service worker);
 *                     undo = removeCSS with the same text. Fully undoable.
 *   modify_element  → applied by a page function that snapshots the element first;
 *                     undo restores the snapshot. Fully undoable while the page is loaded.
 *   execute_js      → runs the approved code; undo runs the model's undoCode if it gave one
 *                     (best effort), otherwise it's not undoable (reload the page).
 *
 * Preview = apply without committing; "Stop preview" = undo.
 *
 * Undo information is stored per tab in the service worker (chrome.storage.session),
 * so it survives closing and reopening DevTools. It is tied to one page load
 * (performance.timeOrigin): after a reload or navigation the page is fresh and
 * nothing is left to undo, so the stored info is discarded.
 */

import { bg } from './bg.js';
import { callInPage, runApprovedScript } from './inspected.js';
import { applyModify, revertModify } from './page-scripts.js';

/**
 * @typedef {object} AppliedChange
 * @property {string} name
 * @property {string} [css]        inject_css
 * @property {string} [undoCode]   execute_js
 * @property {boolean} committed   false while only previewing
 */

export class ChangeManager {
  /** @param {number} tabId */
  constructor(tabId) {
    this.tabId = tabId;
    this.key = `undo:${tabId}`;
    /** @type {{ timeOrigin: number | null, changes: Record<string, AppliedChange> }} */
    this.data = { timeOrigin: null, changes: {} };
  }

  /**
   * Load stored undo info; drop it if the page has been reloaded since.
   * @param {number} timeOrigin current page load id
   */
  async load(timeOrigin) {
    const stored = await bg('kv.get', { key: this.key });
    this.data = stored && stored.timeOrigin === timeOrigin ? stored : { timeOrigin, changes: {} };
    // Previews are never kept across panel restarts: treat them as gone.
    for (const [id, change] of Object.entries(this.data.changes)) if (!change.committed) delete this.data.changes[id];
    await this.persist();
  }

  /** The page navigated or reloaded: everything we changed is gone. */
  async reset(timeOrigin) {
    this.data = { timeOrigin, changes: {} };
    await this.persist();
  }

  async persist() {
    await bg('kv.set', { key: this.key, value: this.data });
  }

  /** @param {string} id */
  isApplied(id) {
    return Boolean(this.data.changes[id]?.committed);
  }

  /** @param {string} id */
  isPreviewing(id) {
    return Boolean(this.data.changes[id] && !this.data.changes[id].committed);
  }

  /** @param {string} id */
  canUndo(id) {
    const change = this.data.changes[id];
    return Boolean(change?.committed && (change.name !== 'execute_js' || change.undoCode));
  }

  /**
   * Show a change without committing it (CSS and DOM changes only).
   * @param {string} id
   * @param {string} name
   * @param {any} input  validated action input (selector already resolved)
   */
  async preview(id, name, input) {
    if (name === 'execute_js') throw new Error('Scripts cannot be previewed');
    if (this.data.changes[id]) return;
    await this.execute(id, name, input);
    this.data.changes[id] = { name, css: input.css, committed: false };
    await this.persist();
  }

  /** @param {string} id */
  async stopPreview(id) {
    if (!this.isPreviewing(id)) return;
    await this.revert(id);
  }

  /**
   * Apply (commit) a change. If it is being previewed, it's already in the page.
   * @param {string} id
   * @param {string} name
   * @param {any} input
   * @returns {Promise<string | undefined>} optional detail (e.g. script result)
   */
  async apply(id, name, input) {
    let detail;
    if (!this.isPreviewing(id)) detail = await this.execute(id, name, input);
    this.data.changes[id] = { name, css: input.css, undoCode: input.undoCode, committed: true };
    await this.persist();
    return detail;
  }

  /** @param {string} id */
  async undo(id) {
    if (!this.canUndo(id)) throw new Error('This change cannot be undone');
    await this.revert(id);
  }

  /**
   * Stop tracking a change without reverting it (used after saving it as a patch).
   * @param {string} id
   */
  async forget(id) {
    delete this.data.changes[id];
    await this.persist();
  }

  // ─────────────────────────────────────────────────────── internals

  /**
   * @param {string} id
   * @param {string} name
   * @param {any} input
   */
  async execute(id, name, input) {
    switch (name) {
      case 'inject_css':
        await bg('css.insert', { tabId: this.tabId, css: input.css });
        return undefined;
      case 'modify_element':
        await callInPage(applyModify, { actionId: id, input });
        return undefined;
      case 'execute_js': {
        const res = await runApprovedScript(input.code);
        if (!res?.ok) throw new Error(res?.error ?? 'Script failed');
        return res.value === null || res.value === undefined ? undefined : `Script returned: ${JSON.stringify(res.value).slice(0, 1000)}`;
      }
      default:
        throw new Error(`Not a change action: ${name}`);
    }
  }

  /** @param {string} id */
  async revert(id) {
    const change = this.data.changes[id];
    if (!change) return;
    switch (change.name) {
      case 'inject_css':
        await bg('css.remove', { tabId: this.tabId, css: change.css });
        break;
      case 'modify_element':
        await callInPage(revertModify, { actionId: id });
        break;
      case 'execute_js': {
        const res = await runApprovedScript(/** @type {string} */ (change.undoCode));
        if (!res?.ok) throw new Error(`Undo script failed: ${res?.error}`);
        break;
      }
    }
    delete this.data.changes[id];
    await this.persist();
  }
}
