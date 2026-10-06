// @ts-check
/**
 * <ai-console>: console errors/warnings captured on the page (by
 * content/console-capture.js), with "Explain" (asks the AI) and
 * "Open source" (jumps to the location in the Sources panel).
 */

import { callInPage } from '../lib/inspected.js';
import { clearConsole } from '../lib/page-scripts.js';
import { IN_CARD } from '../lib/surface.js';
import { h, setChildren } from '../lib/dom.js';
import { readConsole } from '../lib/page-scripts.js';

const POLL_VISIBLE_MS = 2000;
const POLL_HIDDEN_MS = 6000;

export class ConsoleView extends HTMLElement {
  /** @param {import('../panel.js').App} app */
  bind(app) {
    this.app = app;
    this.visible = false;
    this.showAll = false;
    /** @type {any[]} */
    this.entries = [];
    this.lastSignature = '';
    this.poll();
    return this;
  }

  /** @param {boolean} visible */
  setVisible(visible) {
    this.visible = visible;
    if (visible) this.refresh(true);
  }

  poll() {
    this.refresh().finally(() => setTimeout(() => this.poll(), this.visible ? POLL_VISIBLE_MS : POLL_HIDDEN_MS));
  }

  async refresh(force = false) {
    let result;
    try {
      result = await callInPage(readConsole, { levels: this.showAll ? [] : ['error', 'warn'], limit: 100 });
    } catch {
      return; // page navigating; try again next poll
    }
    const entries = result.available ? result.entries : [];
    this.app?.setErrorCount(entries.filter((e) => e.level === 'error').length);

    // Only re-render when something changed (keeps scroll position and selection).
    const signature = `${this.showAll}|${entries.map((e) => `${e.id}:${e.count}`).join(',')}`;
    if (!force && signature === this.lastSignature) return;
    this.lastSignature = signature;
    this.entries = entries;
    if (this.visible || force) this.render(result.available ? null : result.note);
  }

  /** @param {string | null} note */
  render(note) {
    setChildren(this,
      h('div', { class: 'toolbar-row' },
        h('label', null,
          h('input', { type: 'checkbox', checked: this.showAll, onchange: (/** @type {any} */ e) => { this.showAll = e.target.checked; this.refresh(true); } }),
          ' Include info/log'),
        h('button', {
          type: 'button',
          onclick: async () => {
            await callInPage(clearConsole);
            this.refresh(true);
          },
        }, 'Clear')),
      note ? h('div', { class: 'meta' }, note) : null,
      !note && !this.entries.length ? h('div', { class: 'meta' }, 'No errors or warnings captured on this page.') : null,
      [...this.entries].reverse().map((entry) => this.renderEntry(entry)),
    );
  }

  /** @param {any} entry */
  renderEntry(entry) {
    const location = sourceLocation(entry);
    return h('div', { class: `item level-${entry.level}` },
      h('div', { class: 'row' },
        h('span', { class: 'meta' }, `${entry.level}${entry.count > 1 ? ` ×${entry.count}` : ''} · ${new Date(entry.time).toLocaleTimeString()}`),
        h('span', { class: 'spacer' }),
        location && !IN_CARD // (opening a source file needs DevTools)
          ? h('button', {
            type: 'button',
            title: `${location.url}:${location.line}`,
            onclick: () => chrome.devtools.panels.openResource(location.url, Math.max(location.line - 1, 0), Math.max(location.column - 1, 0), () => {}),
          }, 'Open source')
          : null,
        h('button', { type: 'button', onclick: () => this.app?.explainError(entry) }, 'Explain')),
      h('div', { class: 'message' }, entry.message),
    );
  }
}

/**
 * Where an error came from: the error event's location, or the first URL in the stack.
 * @param {any} entry
 * @returns {{ url: string, line: number, column: number } | null}
 */
export function sourceLocation(entry) {
  if (entry.source?.url && entry.source.line) {
    return { url: entry.source.url, line: entry.source.line, column: entry.source.column || 1 };
  }
  const match = String(entry.stack ?? '').match(/((?:https?|file):\/\/[^\s)]+):(\d+):(\d+)/);
  return match ? { url: match[1], line: Number(match[2]), column: Number(match[3]) } : null;
}

customElements.define('ai-console', ConsoleView);
