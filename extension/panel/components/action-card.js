// @ts-check
/**
 * <ai-action-card>: one proposed change, with Preview / Apply / Reject / Undo /
 * Save-as-patch controls.
 *
 * Nothing runs until the user clicks. Before every execution the action is
 * validated again here (the server's validation is not trusted blindly).
 */

import { ACTIONS, validateAction } from '../../shared/actions.js';
import { defaultScopeFor } from '../../shared/url-scope.js';
import { h, setChildren } from '../lib/dom.js';

const STATUS_LABEL = {
  proposed: 'Awaiting your approval',
  previewing: 'Previewing',
  applied: 'Applied',
  rejected: 'Rejected',
  failed: 'Failed',
  undone: 'Undone',
  saved: 'Saved as site patch',
  invalid: 'Invalid',
};

export class ActionCard extends HTMLElement {
  /**
   * @param {import('../panel.js').App} app
   * @param {string} actionId
   * @param {string} name
   * @param {any} input
   */
  bind(app, actionId, name, input) {
    this.app = app;
    this.actionId = actionId;
    this.name = name;
    this.input = input;
    this.busy = false;
    this.showSaveForm = false;
    this.reviewed = false;
    this.className = `risk-${ACTIONS[name]?.risk ?? 'high'}`;
    this.addEventListener('mouseenter', () => {
      const target = this.app.targetFor(this.actionId, this.input);
      if (target && this.name !== 'inject_css') this.app.highlight(target);
    });
    this.update();
    return this;
  }

  /** Re-render from the current state (server status + local undo info). */
  update() {
    const { app, actionId, name, input } = this;
    if (!app) return;
    const def = ACTIONS[name];
    const record = app.session?.actions[actionId];
    const serverStatus = record?.status ?? 'proposed';
    const previewing = app.changes.isPreviewing(actionId);
    const appliedHere = app.changes.isApplied(actionId);
    const status = previewing ? 'previewing' : serverStatus;
    const errors = record?.errors ?? validateAction(name, input, { executeJs: app.settings.executeJs });

    setChildren(this,
      h('div', { class: 'head' },
        def?.label ?? name,
        h('span', { class: `status ${status}` }, STATUS_LABEL[status] ?? status)),
      input?.description ? h('div', { class: 'desc' }, input.description) : null,
      this.renderBody(),
      errors.length ? h('ul', { class: 'errors' }, errors.map((e) => h('li', null, e))) : null,
      record?.detail && serverStatus !== 'proposed' ? h('div', { class: 'note' }, record.detail) : null,
      h('div', { class: 'buttons' }, this.renderButtons(serverStatus, previewing, appliedHere, errors.length > 0)),
      this.showSaveForm ? this.renderSaveForm() : null,
    );
  }

  renderBody() {
    const { name, input } = this;
    const target = this.app.targetFor(this.actionId, input);
    const targetLine = name === 'inject_css' ? null : h('div', { class: 'target' },
      'Target: ', target ? h('code', null, target) : '(element selected in Elements panel)', ' ',
      target ? h('button', { class: 'link', type: 'button', onclick: () => this.app.selectInElements(target) }, 'select') : null);

    if (name === 'inject_css') {
      const t = input.toggle;
      return h('div', null,
        h('pre', null, h('code', null, input.css)),
        t ? h('div', { class: 'note' },
          `Toggle button "${t.label}"${t.activeLabel ? ` / "${t.activeLabel}"` : ''} `,
          t.placeSelector ? ['in ', h('code', null, t.placeSelector), t.position && t.position !== 'append' ? ` (${t.position})` : ''] : '(floating in the corner)',
          '. It appears on the page after you save this as a site patch, and remembers on/off.') : null);
    }

    if (name === 'modify_element') {
      const lines = [
        ...(input.setStyles ?? []).map((s) => `style ${s.property}: ${s.value}${s.important ? ' !important' : ''}`),
        ...(input.removeStyles ?? []).map((p) => `remove style ${p}`),
        ...(input.setAttributes ?? []).map((a) => `set ${a.name}="${a.value}"`),
        ...(input.removeAttributes ?? []).map((a) => `remove attribute ${a}`),
        ...(input.addClasses ?? []).map((c) => `add class .${c}`),
        ...(input.removeClasses ?? []).map((c) => `remove class .${c}`),
        ...(typeof input.textContent === 'string' ? [`text → "${input.textContent.slice(0, 200)}"`] : []),
      ];
      return h('div', null, targetLine, h('ul', { class: 'changes' }, lines.map((l) => h('li', null, l))));
    }

    if (name === 'execute_js') {
      return h('div', null,
        h('div', { class: 'warning' }, '⚠ Runs arbitrary JavaScript in this page, with access to its data and logged-in session.'),
        targetLine,
        h('pre', null, h('code', null, input.code)),
        input.undoCode
          ? h('details', null,
            h('summary', null, 'Undo: model-provided script (best effort, not guaranteed to fully restore)'),
            h('pre', null, h('code', null, input.undoCode)))
          : h('div', { class: 'warning' }, 'Not undoable. To revert, reload the page.'));
    }
    return h('pre', null, JSON.stringify(input, null, 2));
  }

  /**
   * @param {string} status   status known by the server
   * @param {boolean} previewing
   * @param {boolean} appliedHere  this page load still has the change applied
   * @param {boolean} invalid
   */
  renderButtons(status, previewing, appliedHere, invalid) {
    const { app, actionId, name } = this;
    const disabled = this.busy || !app.connected;
    const run = (/** @type {() => Promise<void>} */ fn) => async () => {
      this.busy = true;
      this.update();
      try {
        await fn();
      } catch (err) {
        app.showError(String(/** @type {any} */ (err)?.message ?? err));
      } finally {
        this.busy = false;
        this.update();
      }
    };

    if (status === 'invalid' || (invalid && !appliedHere)) return [];

    if (status === 'saved') return [h('span', { class: 'note' }, 'Manage it in the Patches tab.')];

    if (status === 'applied') {
      if (!appliedHere) {
        return [h('span', { class: 'note' }, 'No longer active on this page (it was reloaded or DevTools lost track of it).')];
      }
      return [
        app.changes.canUndo(actionId)
          ? h('button', { type: 'button', disabled, onclick: run(() => app.undoAction(actionId)) }, 'Undo')
          : h('span', { class: 'note' }, 'Cannot be undone automatically; reload the page to revert.'),
        name === 'inject_css'
          ? h('button', { type: 'button', disabled, onclick: () => { this.showSaveForm = !this.showSaveForm; this.update(); } },
            this.input.toggle ? 'Save as site patch + toggle…' : 'Save as site patch…')
          : null,
      ];
    }

    // proposed, rejected, undone, failed → can be (re)applied
    /** @type {(HTMLElement | null)[]} */
    const buttons = [];
    if (name === 'execute_js') {
      buttons.push(
        h('label', null,
          h('input', { type: 'checkbox', checked: this.reviewed, onchange: (/** @type {any} */ e) => { this.reviewed = e.target.checked; this.update(); } }),
          ' I reviewed this code'),
        h('button', { type: 'button', class: 'primary', disabled: disabled || !this.reviewed, onclick: run(() => app.applyAction(actionId)) }, 'Run script'),
      );
    } else {
      buttons.push(
        h('button', { type: 'button', disabled, onclick: run(() => (previewing ? app.stopPreview(actionId) : app.previewAction(actionId))) },
          previewing ? 'Stop preview' : 'Preview'),
        h('button', { type: 'button', class: 'primary', disabled, onclick: run(() => app.applyAction(actionId)) },
          status === 'proposed' ? 'Apply' : 'Apply again'),
      );
    }
    if (status === 'proposed') {
      buttons.push(h('button', { type: 'button', disabled, onclick: run(() => app.rejectAction(actionId)) }, 'Reject'));
    }
    return buttons;
  }

  renderSaveForm() {
    const url = this.app.pageUrl;
    const origin = defaultScopeFor(url);
    const pageUrl = url.split(/[?#]/)[0];
    const name = /** @type {HTMLInputElement} */ (h('input', { type: 'text', value: this.input.description?.slice(0, 80) ?? 'CSS patch' }));
    const pattern = /** @type {HTMLInputElement} */ (h('input', { type: 'text', value: `${new URL(pageUrl).origin}/*`, hidden: true }));
    const scope = /** @type {HTMLSelectElement} */ (h('select', {
      onchange: () => { pattern.hidden = scope.value !== 'pattern'; },
    },
    origin ? h('option', { value: 'origin' }, `Whole site (${origin.value})`) : null,
    h('option', { value: 'prefix' }, `This page (${pageUrl})`),
    h('option', { value: 'pattern' }, 'Custom URL pattern…')));

    const save = async () => {
      /** @type {import('../../shared/url-scope.js').Scope} */
      const chosen = scope.value === 'origin' && origin ? origin
        : scope.value === 'prefix' ? { type: 'prefix', value: pageUrl }
          : { type: 'pattern', value: pattern.value.trim() };
      if (!chosen.value) return;
      this.busy = true;
      try {
        await this.app.saveAsPatch(this.actionId, { name: name.value.trim() || 'CSS patch', scope: chosen });
        this.showSaveForm = false;
      } catch (err) {
        this.app.showError(String(/** @type {any} */ (err)?.message ?? err));
      } finally {
        this.busy = false;
        this.update();
      }
    };

    return h('div', { class: 'save-form' },
      h('label', null, 'Name'), name,
      h('label', null, 'Apply on'), h('div', null, scope, ' ', pattern),
      h('div', { class: 'row-buttons' },
        h('button', { type: 'button', class: 'primary', onclick: save }, 'Save patch'),
        h('button', { type: 'button', onclick: () => { this.showSaveForm = false; this.update(); } }, 'Cancel')));
  }
}

customElements.define('ai-action-card', ActionCard);
