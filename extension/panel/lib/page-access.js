// @ts-check
/**
 * What of the page the AI may see (the "Page access" menu by the message box):
 *   full → the whole page
 *   area → only an area the user marks on the page (areaOverlay in page-scripts.js). The area is kept here, in
 *          the panel, and sent with every call into the page (setPageArea), where everything outside it is left
 *          out. It belongs to one page: after going to another page (the user, or the AI in an agent mode),
 *          nothing is shown until the user confirms the area there; the editor opens with the same shape.
 *   none → "Just answer": no page tools and nothing from the page.
 * The choice and the area are kept per tab (storage.session), so the card, which loads again with each page,
 * keeps them too.
 */

import { callInPage, setPageArea } from './inspected.js';
import { areaCheck, areaCommand, areaOverlay, areaRoots, areaStatus } from './page-scripts.js';
import { t } from '../../shared/i18n.js';

/** @typedef {{ x: number, y: number }} Point */

/** The address without #…: the same page. @param {string} url */
const pageOf = (url) => String(url || '').split('#')[0];
/** Both addresses on the same site (origin). @param {string} a @param {string} b */
const sameSite = (a, b) => {
  try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
};

export class PageAccess {
  /**
   * @param {number} tabId
   * @param {{ onChange: () => void }} hooks  called when the mode or the area changes (to update the UI)
   */
  constructor(tabId, { onChange }) {
    this.tabId = tabId;
    this.onChange = onChange;
    /** @type {'full' | 'area' | 'none'} */
    this.mode = 'full';
    /** @type {Point[]} */
    this.points = [];
    /** The page the area was marked on. */
    this.url = '';
    /** The panel that scrolls around the area (a selector; '' = the page): the area moves with its content. */
    this.anchor = '';
    /** The outermost elements inside the area (selectors): CSS changes are limited to them, scripts get them as $area. */
    this.roots = /** @type {string[]} */ ([]);
    /** The area needs the user's OK on this page (marked on another page, or not marked yet). */
    this.pending = false;
    /** The editor is open on the page. */
    this.editing = false;
    /** "Keep on this site": the same area on every page of the site, without asking again (the user's choice). */
    this.keep = false;
    /** The tab's current address. */
    this.currentUrl = '';
    this.pollTimer = /** @type {ReturnType<typeof setInterval> | undefined} */ (undefined);
  }

  get key() { return `access:${this.tabId}`; }

  /** Ready to send with an area: one is marked and confirmed on this page. */
  get areaReady() { return this.mode === 'area' && !this.pending && this.points.length >= 3; }

  /**
   * Restore the choice for this tab (the card starts again on every page).
   * @param {string} currentUrl
   */
  async load(currentUrl) {
    const saved = (await chrome.storage.session.get(this.key).catch(() => ({})))[this.key];
    if (!saved || !['area', 'none'].includes(saved.mode)) return;
    this.mode = saved.mode;
    if (this.mode === 'area') {
      this.points = Array.isArray(saved.points) ? saved.points : [];
      this.url = saved.url ?? '';
      this.anchor = saved.anchor ?? '';
      this.roots = saved.roots ?? [];
      this.keep = saved.keep === true;
      await this.pageChanged(currentUrl);
    }
    this.onChange();
  }

  async save() {
    await chrome.storage.session.set({ [this.key]: { mode: this.mode, points: this.points, url: this.url, anchor: this.anchor, roots: this.roots, keep: this.keep } }).catch(() => {});
  }

  /** @param {'full' | 'area' | 'none'} mode */
  async setMode(mode) {
    if (mode === this.mode && mode !== 'area') return;
    this.mode = mode;
    if (mode === 'area') {
      await this.save();
      this.onChange();
      await this.edit();
      return;
    }
    // Whole page or Just answer: no area any more.
    this.points = [];
    this.url = '';
    this.anchor = '';
    this.roots = [];
    this.pending = false;
    setPageArea(null);
    this.stopPolling();
    await callInPage(areaOverlay, { mode: 'off' }).catch(() => {});
    await this.save();
    this.onChange();
  }

  /** Open the editor on the page (with the current shape, if any), and wait for Done or Cancel. */
  async edit() {
    this.stopPolling();
    this.editing = true;
    this.onChange();
    try {
      await callInPage(areaOverlay, { mode: 'edit', points: this.points, anchor: this.anchor, labels: this.labels() });
    } catch (err) {
      this.editing = false;
      this.onChange();
      throw err;
    }
    this.pollTimer = setInterval(() => this.poll(), 250);
  }

  async poll() {
    let status;
    try {
      status = await callInPage(areaStatus);
    } catch {
      return; // the page is loading: look again
    }
    if (!status) return; // still editing
    this.stopPolling();
    this.editing = false;
    if (status.result === 'done' && status.points?.length >= 3) {
      this.points = status.points;
      this.url = pageOf(status.url);
      this.anchor = status.anchor ?? '';
      this.pending = false;
      setPageArea(this.points, this.url, this.anchor, this.keep);
      this.roots = await callInPage(areaRoots).catch(() => []);
    } else if (this.points.length >= 3 && !this.pending) {
      // Cancelled while changing it: the area stays as it was, outline included.
      await this.show();
    } else if (!this.points.length) {
      // Cancelled before marking anything: back to the whole page.
      this.mode = 'full';
      this.anchor = '';
      setPageArea(null);
    }
    await this.save();
    this.onChange();
  }

  stopPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  /**
   * A key for the editor on the page, pressed in the panel (where the keyboard usually is while marking: clicks
   * on the page don't take it). @param {'cancel' | 'done' | 'undo' | 'redo'} command
   */
  async command(command) {
    if (this.editing) await callInPage(areaCommand, { command }).catch(() => {});
  }

  /** The outline of the confirmed area on the page (after a reload, it is drawn again). */
  async show() {
    if (this.points.length < 3) return;
    await callInPage(areaOverlay, { mode: 'show', points: this.points, anchor: this.anchor, labels: this.labels() }).catch(() => {});
  }

  /**
   * The tab shows another page (or the same one again). The same page: the area stays (its outline is drawn
   * again). Another page: nothing is shown until the user confirms the area there; the editor opens with the
   * same shape. (The page helpers refuse on a page other than `url` anyway, so nothing slips through meanwhile.)
   * @param {string} url
   */
  async pageChanged(url) {
    this.currentUrl = url;
    if (this.mode !== 'area') return;
    const kept = this.keep && sameSite(url, this.url);
    if (this.points.length >= 3 && (pageOf(url) === this.url || kept)) {
      if (kept) this.url = pageOf(url);
      this.pending = false;
      setPageArea(this.points, this.url, this.anchor, this.keep);
      await this.show();
      // Kept on a new page: its scrolling panel must be there too (a moment to load), or the user marks it again.
      if (kept && !(await this.applies())) {
        this.pending = true;
        this.onChange();
        await this.edit().catch(() => {});
      }
      await this.save();
    } else {
      this.pending = true;
      setPageArea(this.points, this.url, this.anchor, this.keep); // still the old page's: refused here
      this.onChange();
      await this.edit().catch(() => {}); // the page may still be loading; Send opens it again
    }
    this.onChange();
  }

  /** Does the area apply on the page now? Asked a few times while the page loads. */
  async applies() {
    for (let i = 0; i < 6; i++) {
      if (await callInPage(areaCheck).catch(() => false)) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  /**
   * "Keep on this site", ticked or not. Ticked while the area waits to be confirmed on another page of the site:
   * it applies there right away.
   * @param {boolean} keep
   */
  async setKeep(keep) {
    this.keep = keep;
    if (keep && this.pending && this.points.length >= 3 && sameSite(this.currentUrl, this.url)) {
      this.stopPolling();
      this.editing = false;
      this.url = pageOf(this.currentUrl);
      this.pending = false;
      setPageArea(this.points, this.url, this.anchor, true);
      await this.show();
      if (!(await this.applies())) { this.pending = true; await this.edit().catch(() => {}); }
    } else if (this.points.length >= 3) {
      setPageArea(this.points, this.url, this.anchor, keep);
    }
    await this.save();
    this.onChange();
  }

  /** The page context for a message: less (or nothing) with an area or "Just answer". @param {Record<string, any>} context */
  limitContext(context) {
    if (this.mode === 'none') return {};
    if (this.mode !== 'area') return context;
    const { page, selected } = context;
    let site = '';
    try { site = new URL(page?.url).origin; } catch { /* not a web page */ }
    return {
      page: { site, viewport: page?.viewport, area: 'Only an area the user marked is shared (see the tools)' },
      ...(selected ? { selected } : {}),
    };
  }

  /** The overlay's texts, in the interface language. */
  labels() {
    return {
      draw: t('areaDraw', 'Drag to mark the area the AI may see, or click an element'),
      edit: t('areaEdit', 'Drag the corners to shape it. Drag a dot between corners to add one, drag inside to move it, double-click a corner to remove it.'),
      done: t('done', 'Done'),
      redraw: t('areaRedraw', 'Redraw'),
      cancel: t('cancel', 'Cancel'),
      undo: t('undo', 'Undo'),
      redo: t('redo', 'Redo'),
      shown: t('areaTag', 'The AI sees only this'),
    };
  }
}
