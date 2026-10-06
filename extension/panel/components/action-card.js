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
import { IN_CARD } from '../lib/surface.js';
import { t } from '../../shared/i18n.js';
import { actionLabel } from '../lib/action-labels.js';

const STATUS_LABEL = {
  proposed: t('stProposed', 'Awaiting your approval'),
  previewing: t('stPreviewing', 'Previewing'),
  applied: t('stApplied', 'Applied'),
  rejected: t('stRejected', 'Rejected'),
  failed: t('stFailed', 'Failed'),
  undone: t('stUndone', 'Undone'),
  saved: t('stSaved', 'Saved as site patch'),
  invalid: t('stInvalid', 'Invalid'),
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
    /** "Apply to source": the edits proposed in this panel session, while looking, and the last error. */
    this.sourceProposal = /** @type {any} */ (null);
    this.sourceBusy = false;
    this.sourceError = '';
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
    const record = app.session?.actions[actionId];
    const serverStatus = record?.status ?? 'proposed';
    const previewing = app.changes.isPreviewing(actionId);
    const appliedHere = app.changes.isApplied(actionId);
    const status = previewing ? 'previewing' : serverStatus;
    const errors = record?.errors ?? validateAction(name, input, { executeJs: app.settings.executeJs });

    setChildren(this,
      h('div', { class: 'head' },
        actionLabel(name),
        h('span', { class: `status ${status}` }, STATUS_LABEL[status] ?? status)),
      input?.description ? h('div', { class: 'desc' }, input.description) : null,
      this.renderBody(),
      errors.length ? h('ul', { class: 'errors' }, errors.map((e) => h('li', null, e))) : null,
      record?.detail && serverStatus !== 'proposed' ? h('div', { class: 'note' }, record.detail) : null,
      h('div', { class: 'buttons' }, this.renderButtons(serverStatus, previewing, appliedHere, errors.length > 0)),
      this.showSaveForm ? this.renderSaveForm() : null,
      this.renderSource(record?.source),
    );
  }

  renderBody() {
    const { name, input } = this;
    const target = this.app.targetFor(this.actionId, input);
    const targetLine = name === 'inject_css' ? null : h('div', { class: 'target' },
      t('target', 'Target:'), ' ', target ? h('code', null, target) : (IN_CARD ? t('targetPicked', '(the element you picked)') : t('targetSelected', '(element selected in Elements panel)')), ' ',
      target ? h('button', { class: 'link', type: 'button', onclick: () => this.app.selectInElements(target) }, t('selectLink', 'select')) : null);

    if (name === 'inject_css') {
      const toggle = input.toggle;
      return h('div', null,
        h('pre', null, h('code', null, input.css)),
        toggle ? h('div', { class: 'note' },
          t('toggleButton', 'Toggle button "$1"', toggle.label + (toggle.activeLabel ? `" / "${toggle.activeLabel}` : '')), ' ',
          toggle.placeSelector ? [t('toggleIn', 'in'), ' ', h('code', null, toggle.placeSelector), toggle.position && toggle.position !== 'append' ? ` (${toggle.position})` : ''] : t('toggleFloating', '(floating in the corner)'),
          '. ', t('toggleNote', 'It appears on the page after you save this as a site patch, and remembers on/off.')) : null);
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

    if (name === 'interact') {
      const VERB = {
        click: t('vClick', 'Click'), type: t('vType', 'Type into'), select: t('vSelect', 'Choose in'), check: t('vCheck', 'Check'),
        uncheck: t('vUncheck', 'Uncheck'), submit: t('vSubmit', 'Submit the form of'),
        scroll: t('vScroll', 'Scroll'), press: t('vPress', 'Press'), wait: t('vWait', 'Wait for'), hover: t('vHover', 'Point at'),
      };
      const steps = /** @type {any[]} */ (input.steps ?? []);
      const clicks = steps.some((s) => s.action === 'click' || s.action === 'submit');
      return h('div', null,
        h('ol', { class: 'changes' }, steps.map((s) => h('li', null,
          `${VERB[s.action] ?? s.action} `,
          s.text ? `"${s.text}"` : null,
          s.text && s.selector ? ` ${t('toggleIn', 'in')} ` : null,
          s.selector ? h('code', null, s.selector) : null,
          s.ref ? t('refFound', 'the element the AI found ($1)', s.ref) : null,
          s.action === 'type' || s.action === 'select' ? ` → "${String(s.value ?? '').slice(0, 120)}"` : null,
          s.action === 'scroll' || s.action === 'press' ? ` ${s.value ?? t('intoView', 'into view')}` : null,
          s.action === 'wait' && !s.selector && !s.text && !s.ref ? `${s.value} s` : null,
          s.selector || s.ref ? [' ', h('button', { class: 'link', type: 'button', onclick: () => this.app.highlight(s.selector, s.ref, input.frame) }, t('showLink', 'show'))] : null))),
        h('div', { class: 'note' }, clicks
          ? t('interactClicks', 'Uses real clicks and typing, like you would. Clicks and submits cannot be undone.')
          : t('interactTyping', 'Uses real typing and selection, like you would. Can be undone.')));
    }

    if (name === 'navigate') {
      return h('div', null, input.url ? [t('navOpen', 'Open'), ' ', h('code', null, input.url)] : input.go === 'back' ? t('navBack', 'Go back') : input.go === 'forward' ? t('navForward', 'Go forward') : t('navReload', 'Reload'));
    }

    if (name === 'translate_page') {
      return h('div', null,
        h('div', null, t('translateInto', 'Translate the visible text of the page into $1.', input.language)),
        h('div', { class: 'note' }, t('translateNote', 'Uses your AI (a request for every few dozen pieces of text). Only the text changes; Undo restores it.')));
    }

    if (name === 'execute_js') {
      return h('div', null,
        h('div', { class: 'warning' }, t('jsWarning', '⚠ Runs arbitrary JavaScript in this page, with access to its data and logged-in session.')),
        targetLine,
        h('pre', null, h('code', null, input.code)),
        input.undoCode
          ? h('details', null,
            h('summary', null, t('jsUndo', 'Undo: model-provided script (best effort, not guaranteed to fully restore)')),
            h('pre', null, h('code', null, input.undoCode)))
          : h('div', { class: 'warning' }, t('jsNoUndo', 'Not undoable. To revert, reload the page.')));
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

    // Ask the AI to look at the result (screenshot) and fix what still looks wrong.
    const check = name === 'execute_js' ? null : h('button', {
      type: 'button',
      disabled: disabled || app.session?.busy,
      title: t('checkItHelp', 'The AI takes a screenshot of the result and proposes fixes for anything that still looks wrong'),
      onclick: () => app.sendFromUi(checkRequest(this.input?.description || ACTIONS[name]?.label || name)),
    }, t('checkIt', 'Check it'));

    // Put an applied CSS change into the project's own source files (when a project is set up for this site).
    const toSource = name === 'inject_css' && app.sourceProject && !this.sourceBusy && !this.sourceProposal
      && this.app.session?.actions[actionId]?.source?.status !== 'written'
      ? h('button', {
        type: 'button', disabled,
        title: t('toSourceHelp', 'Claude Code looks through $1 and proposes edits. Nothing is written until you click "Write to files".', app.sourceProject.path),
        onclick: () => this.proposeSource(),
      }, t('toSource', 'Apply to source…'))
      : null;

    if (status === 'saved') return [check, toSource, h('span', { class: 'note' }, t('manageInPatches', 'Manage it in the Patches tab.'))];

    if (status === 'applied') {
      if (!appliedHere) {
        return [h('span', { class: 'note' }, t('noLongerActive', 'No longer active on this page (it was reloaded or DevTools lost track of it).'))];
      }
      return [
        check,
        toSource,
        app.changes.canUndo(actionId)
          ? h('button', { type: 'button', disabled, onclick: run(() => app.undoAction(actionId)) }, t('undo', 'Undo'))
          : h('span', { class: 'note' }, t('cannotUndo', 'Cannot be undone automatically; reload the page to revert.')),
        name === 'inject_css'
          ? h('button', { type: 'button', disabled, onclick: () => { this.showSaveForm = !this.showSaveForm; this.update(); } },
            this.input.toggle ? t('savePatchToggle', 'Save as site patch + toggle…') : t('savePatch', 'Save as site patch…'))
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
          ' ', t('reviewedCode', 'I reviewed this code')),
        h('button', { type: 'button', class: 'primary', disabled: disabled || !this.reviewed, onclick: run(() => app.applyAction(actionId)) }, t('runScript', 'Run script')),
      );
    } else if (name === 'translate_page') {
      buttons.push(h('button', { type: 'button', class: 'primary', disabled, onclick: run(() => app.applyAction(actionId)) },
        status === 'proposed' ? t('translate', 'Translate') : t('translateAgain', 'Translate again')));
    } else if (name === 'interact' || name === 'navigate') {
      buttons.push(h('button', { type: 'button', class: 'primary', disabled, onclick: run(() => app.applyAction(actionId)) },
        name === 'navigate' ? (status === 'proposed' ? t('go', 'Go') : t('goAgain', 'Go again')) : status === 'proposed' ? t('runSteps', 'Run steps') : t('runAgain', 'Run again')));
    } else {
      buttons.push(
        h('button', { type: 'button', disabled, onclick: run(() => (previewing ? app.stopPreview(actionId) : app.previewAction(actionId))) },
          previewing ? t('stopPreview', 'Stop preview') : t('preview', 'Preview')),
        h('button', { type: 'button', class: 'primary', disabled, onclick: run(() => app.applyAction(actionId)) },
          status === 'proposed' ? t('apply', 'Apply') : t('applyAgain', 'Apply again')),
      );
    }
    if (status === 'proposed') {
      buttons.push(h('button', { type: 'button', disabled, onclick: run(() => app.rejectAction(actionId)) }, t('reject', 'Reject')));
    }
    return buttons;
  }

  async proposeSource() {
    this.sourceBusy = true;
    this.sourceError = '';
    this.update();
    try {
      this.sourceProposal = await this.app.proposeSource(this.actionId);
    } catch (err) {
      this.sourceError = String(/** @type {any} */ (err)?.message ?? err);
    } finally {
      this.sourceBusy = false;
      this.update();
    }
  }

  /** @param {'write' | 'undo'} op */
  async writeSource(op) {
    this.sourceBusy = true;
    this.sourceError = '';
    this.update();
    try {
      const reply = await this.app.writeSource(this.actionId, op);
      if (op === 'write') this.sourceProposal = null;
      if (reply.skipped?.length) this.sourceError = t('notRestored', 'Not restored because you changed them since: $1', reply.skipped.join(', '));
    } catch (err) {
      this.sourceError = String(/** @type {any} */ (err)?.message ?? err);
    } finally {
      this.sourceBusy = false;
      this.update();
    }
  }

  /**
   * The "Apply to source" part of the card: progress, the proposed diff, or what was written.
   * @param {{ status: string, files: string[] } | undefined} source  state kept by the server
   */
  renderSource(source) {
    const project = this.app.sourceProject;
    const error = this.sourceError ? h('div', { class: 'errors' }, this.sourceError) : null;
    if (this.sourceBusy) {
      return h('div', { class: 'source' }, h('div', { class: 'note' }, t('lookingThrough', 'Looking through $1 for where this belongs… (this can take a minute)', project?.name ?? t('yourProject', 'your project'))));
    }
    const p = this.sourceProposal;
    if (p) {
      const close = () => { this.sourceProposal = null; this.update(); };
      return h('div', { class: 'source' },
        h('div', { class: 'head' }, t('toSourceHead', 'Apply to source: $1', p.project.name)),
        p.summary ? h('div', null, p.summary) : null,
        p.previews.map((/** @type {any} */ e) => h('div', { class: 'edit' },
          h('div', { class: 'file' }, h('code', null, e.file), e.isNew ? ' (new file)' : ` (line ${e.line})`),
          h('pre', { class: 'diff' },
            e.removed.map((/** @type {string} */ l) => h('span', { class: 'del' }, `- ${l}`)),
            e.added.map((/** @type {string} */ l) => h('span', { class: 'ins' }, `+ ${l}`))))),
        p.notes ? h('div', { class: 'note' }, p.notes) : null,
        error,
        h('div', { class: 'buttons' }, p.previews.length
          ? [
            h('button', { type: 'button', class: 'primary', onclick: () => this.writeSource('write') }, p.previews.length === 1 ? t('writeFile', 'Write to file') : t('writeFiles', 'Write to files')),
            h('button', { type: 'button', onclick: close }, t('discard', 'Discard')),
          ]
          : h('button', { type: 'button', onclick: close }, t('close', 'Close'))));
    }
    if (source?.status === 'written') {
      return h('div', { class: 'source' },
        h('div', { class: 'note' }, t('writtenTo', '✓ Written to $1', source.files.join(', '))),
        error,
        h('div', { class: 'buttons' }, h('button', { type: 'button', onclick: () => this.writeSource('undo') }, t('undoSource', 'Undo source edits'))));
    }
    if (source?.status === 'undone') return h('div', { class: 'source' }, h('div', { class: 'note' }, t('sourceUndone', 'Source edits undone.')), error);
    return error ? h('div', { class: 'source' }, error) : null;
  }

  renderSaveForm() {
    const url = this.app.pageUrl;
    const origin = defaultScopeFor(url);
    const pageUrl = url.split(/[?#]/)[0];
    const group = this.app.memoryInfo?.group;
    const name = /** @type {HTMLInputElement} */ (h('input', { type: 'text', value: this.input.description?.slice(0, 80) ?? 'CSS patch' }));
    const pattern = /** @type {HTMLInputElement} */ (h('input', { type: 'text', value: `${new URL(pageUrl).origin}/*`, hidden: true }));
    const scope = /** @type {HTMLSelectElement} */ (h('select', {
      onchange: () => { pattern.hidden = scope.value !== 'pattern'; },
    },
    origin ? h('option', { value: 'origin' }, t('scopeSite', 'Whole site ($1)', origin.value)) : null,
    group && group.pattern !== '/' ? h('option', { value: 'group' }, t('scopeGroup', 'Pages like this: $1 ($2)', group.name ?? t('thisPageType', 'this page type'), group.pattern)) : null,
    h('option', { value: 'prefix' }, t('scopePage', 'This page ($1)', pageUrl)),
    h('option', { value: 'pattern' }, t('scopePattern', 'Custom URL pattern…'))));

    const save = async () => {
      /** @type {import('../../shared/url-scope.js').Scope} */
      const chosen = scope.value === 'origin' && origin ? origin
        : scope.value === 'group' && group ? { type: 'group', value: new URL(pageUrl).origin, pattern: group.pattern, name: group.name ?? undefined }
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
      h('label', null, t('name', 'Name')), name,
      h('label', null, t('applyOn', 'Apply on')), h('div', null, scope, ' ', pattern),
      h('div', { class: 'row-buttons' },
        h('button', { type: 'button', class: 'primary', onclick: save }, t('savePatchButton', 'Save patch')),
        h('button', { type: 'button', onclick: () => { this.showSaveForm = false; this.update(); } }, t('cancel', 'Cancel'))));
  }
}

customElements.define('ai-action-card', ActionCard);

/**
 * The message sent by "Check it".
 * @param {string} description what the applied change does
 */
export function checkRequest(description) {
  return `I applied "${description}". Take a screenshot to see how it looks now, and propose fixes for anything that still looks wrong (for example areas the change missed, unreadable text or broken layout). If it all looks right, just say so.`;
}
