// @ts-check
/**
 * <ai-patches>: persistent CSS patches saved from applied inject_css actions.
 * Patches for the current page are listed first. Each can be enabled/disabled,
 * edited (name, CSS) or deleted. The service worker reapplies enabled patches
 * whenever a matching page loads.
 */

import { describeScope, scopeMatches } from '../../shared/url-scope.js';
import { bg } from '../lib/bg.js';
import { h, setChildren } from '../lib/dom.js';
import { boostCss } from '../../shared/css-boost.js';

export class PatchesView extends HTMLElement {
  /** @param {import('../panel.js').App} app */
  bind(app) {
    this.app = app;
    /** @type {Set<string>} ids of patches being edited */
    this.editing = new Set();
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.patches) this.refresh();
    });
    this.refresh();
    return this;
  }

  async refresh() {
    if (!this.app) return;
    /** @type {any[]} */
    const patches = await bg('patches.list');
    const url = this.app.pageUrl;
    const here = patches.filter((p) => scopeMatches(p.scope, url));
    const elsewhere = patches.filter((p) => !scopeMatches(p.scope, url));
    this.app.setPatchCount(here.filter((p) => p.enabled).length);

    setChildren(this,
      h('div', { class: 'list-heading' }, `This page (${here.length})`),
      here.length ? here.map((p) => this.renderPatch(p)) : h('div', { class: 'meta' }, 'No patches apply to this page. Apply a CSS change in the chat, then click "Save as site patch…".'),
      elsewhere.length ? h('div', { class: 'list-heading' }, `Other sites (${elsewhere.length})`) : null,
      elsewhere.map((p) => this.renderPatch(p)),
    );
  }

  /** @param {any} patch */
  renderPatch(patch) {
    const editing = this.editing.has(patch.id);
    const update = (/** @type {object} */ changes) => bg('patches.update', { id: patch.id, changes }).catch((err) => this.app?.showError(err.message));

    const nameInput = /** @type {HTMLInputElement} */ (h('input', { type: 'text', value: patch.name }));
    const cssInput = /** @type {HTMLTextAreaElement} */ (h('textarea', { value: patch.css }));

    return h('div', { class: 'item' },
      h('div', { class: 'row' },
        h('input', {
          type: 'checkbox', checked: patch.enabled, title: patch.enabled ? 'Enabled' : 'Disabled',
          onchange: (/** @type {any} */ e) => update({ enabled: e.target.checked }),
        }),
        h('span', { class: 'title', title: patch.name }, patch.name),
        h('button', { type: 'button', onclick: () => { editing ? this.editing.delete(patch.id) : this.editing.add(patch.id); this.refresh(); } }, editing ? 'Close' : 'Edit'),
        h('button', {
          type: 'button', class: 'danger',
          // Two clicks to delete (native confirm() dialogs are unreliable inside DevTools).
          onclick: async (/** @type {any} */ e) => {
            if (e.target.dataset.armed) {
              await bg('patches.remove', { id: patch.id }).catch((err) => this.app?.showError(err.message));
            } else {
              e.target.dataset.armed = '1';
              e.target.textContent = 'Click again to delete';
              setTimeout(() => { delete e.target.dataset.armed; e.target.textContent = 'Delete'; }, 3000);
            }
          },
        }, 'Delete')),
      h('div', { class: 'meta' },
        `Applies to ${describeScope(patch.scope)} · ${patch.enabled ? 'enabled' : 'disabled'}`,
        patch.toggle ? ` · page button "${patch.toggle.label}"` : ''),
      editing
        ? h('div', null,
          nameInput,
          cssInput,
          h('div', { class: 'row' },
            h('button', {
              type: 'button', class: 'primary',
              onclick: async () => {
                this.editing.delete(patch.id);
                await update({ name: nameInput.value.trim() || patch.name, css: cssInput.value, injectedCss: boostCss(cssInput.value) });
              },
            }, 'Save')))
        : h('pre', null, h('code', null, patch.css.length > 600 ? `${patch.css.slice(0, 600)}…` : patch.css)),
    );
  }
}

customElements.define('ai-patches', PatchesView);
