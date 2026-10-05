// @ts-check
/**
 * Executes APPROVED changes and keeps what is needed to undo them.
 *
 *   inject_css      → inserted with chrome.scripting.insertCSS (via the service worker), with
 *                     selectors boosted so they win ties with the page (../../shared/css-boost.js);
 *                     undo = removeCSS with the same text. Fully undoable.
 *   modify_element  → applied by a page function that snapshots the element first;
 *                     undo restores the snapshot. Fully undoable while the page is loaded.
 *   execute_js      → runs the approved code; undo runs the model's undoCode if it gave one
 *                     (best effort), otherwise it's not undoable (reload the page).
 *   interact        → clicks/typing/selection with real events (page-interact.js), one step
 *                     at a time; typed values, selections and checkboxes can be undone, clicks
 *                     and submits cannot.
 *
 * Preview = apply without committing; "Stop preview" = undo.
 *
 * Undo information is stored per tab in the service worker (chrome.storage.session),
 * so it survives closing and reopening DevTools. It is tied to one page load
 * (performance.timeOrigin): after a reload or navigation the page is fresh and
 * nothing is left to undo, so the stored info is discarded.
 */

import { bg } from './bg.js';
import { callInPage, evalInPage, runApprovedScript } from './inspected.js';
import { applyModify, revertModify } from './page-scripts.js';
import { interactStep, revertInteract } from './page-interact.js';
import { boostCss } from '../../shared/css-boost.js';

const STEP_TIMEOUT_MS = 5000;   // how long a step waits for its element to appear
const STEP_POLL_MS = 250;
const STEP_PAUSE_MS = 300;      // pause between steps so the page can react

/**
 * @typedef {object} AppliedChange
 * @property {string} name
 * @property {string} [css]        inject_css
 * @property {string} [undoCode]   execute_js
 * @property {boolean} [undoable]  interact: false if it clicked or submitted
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
    if (!change?.committed) return false;
    if (change.name === 'execute_js') return Boolean(change.undoCode);
    if (change.name === 'interact' || change.name === 'navigate') return Boolean(change.undoable);
    return true;
  }

  /**
   * Show a change without committing it (CSS and DOM changes only).
   * @param {string} id
   * @param {string} name
   * @param {any} input  validated action input (selector already resolved)
   */
  async preview(id, name, input) {
    if (name === 'execute_js' || name === 'interact') throw new Error('This change cannot be previewed');
    if (this.data.changes[id]) return;
    await this.execute(id, name, input);
    this.data.changes[id] = { name, css: injectedCss(name, input), committed: false };
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
    let undoable;
    if (name === 'interact') {
      ({ detail, undoable } = await this.runSteps(id, input.steps));
    } else if (name === 'navigate') {
      if (input.url) await evalInPage(`location.href = ${JSON.stringify(input.url)}`);
      else if (input.go === 'reload') chrome.devtools.inspectedWindow.reload({});
      else await evalInPage(input.go === 'back' ? 'history.back()' : 'history.forward()');
      detail = input.url ? `Opened ${input.url}` : `Went ${input.go}`;
      undoable = false;
    } else if (!this.isPreviewing(id)) {
      detail = await this.execute(id, name, input);
    }
    this.data.changes[id] = { name, css: injectedCss(name, input), undoCode: input.undoCode, undoable, committed: true };
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
        await bg('css.insert', { tabId: this.tabId, css: injectedCss(name, input) });
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

  /**
   * Run interact steps in order. Each step waits up to STEP_TIMEOUT_MS for its element.
   * @param {string} id
   * @param {{ action: string, selector?: string, text?: string, value?: string }[]} steps
   * @returns {Promise<{ detail: string, undoable: boolean }>}
   */
  async runSteps(id, steps) {
    /** @type {string[]} */
    const done = [];
    let undoable = true;
    for (const [index, step] of steps.entries()) {
      // A plain pause (wait without a target).
      if (step.action === 'wait' && !step.selector && !step.text) await sleep(Math.min(Number(step.value) * 1000, 10_000));
      const deadline = Date.now() + (step.action === 'wait' ? 10_000 : STEP_TIMEOUT_MS);
      let result;
      try {
        while (true) {
          result = await callInPage(interactStep, { actionId: id, step });
          if (result?.found || Date.now() > deadline) break;
          await sleep(STEP_POLL_MS);
        }
      } catch (err) {
        throw new Error(`Step ${index + 1} failed: ${/** @type {any} */ (err).message}${progress(done)}`);
      }
      if (!result?.found) {
        const what = [step.selector, step.text && `"${step.text}"`].filter(Boolean).join(' ');
        throw new Error(`Step ${index + 1} (${step.action} ${what}): no matching element on the page.${progress(done)}`);
      }
      done.push(result.did);
      if (!result.undoable) undoable = false;
      if (index < steps.length - 1) await sleep(STEP_PAUSE_MS);
    }
    return { detail: `Done: ${done.map((d, i) => `${i + 1}) ${d}`).join('; ')}`, undoable };
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
      case 'interact':
        await callInPage(revertInteract, { actionId: id });
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

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** "Steps done before the failure" for error messages. @param {string[]} done */
function progress(done) {
  return done.length ? ` Done before that: ${done.join('; ')}.` : '';
}

/**
 * The CSS actually inserted for an inject_css change: the AI's CSS with boosted selectors.
 * (Stored with the change so undo removes exactly the same text.)
 * @param {string} name
 * @param {any} input
 */
function injectedCss(name, input) {
  return name === 'inject_css' ? boostCss(input.css) : undefined;
}
