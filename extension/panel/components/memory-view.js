// @ts-check
/**
 * <ai-memory>: everything the AI remembers about this site, editable.
 *
 *   - which kind of page this is (page group) and its URL pattern
 *   - notes for the whole site, for this kind of page, and for other page kinds
 *   - known page groups
 *
 * Every change goes to the server (memory.edit) and the view re-renders from
 * the server's answer.
 */

import { h, setChildren } from '../lib/dom.js';
import { t } from '../../shared/i18n.js';

export class MemoryView extends HTMLElement {
  /** @param {import('../panel.js').App} app */
  bind(app) {
    this.app = app;
    /** @type {Set<string>} ids of notes/groups being edited */
    this.editing = new Set();
    return this;
  }

  /** Re-render from app.memoryInfo (loaded by the app). */
  render() {
    const app = /** @type {import('../panel.js').App} */ (this.app);
    const memory = app.memoryInfo;
    if (!app.connected) {
      setChildren(this, h('div', { class: 'meta' }, t('notConnectedServer', 'Not connected to the agent server.')));
      return;
    }
    // Which memory this conversation uses.
    const mode = app.memoryMode ?? 'shared';
    const modeSelect = /** @type {HTMLSelectElement} */ (h('select', {
      'aria-label': t('memoryForConversation', 'Memory for this conversation'),
      onchange: () => app.configure({ memoryMode: modeSelect.value }),
    },
    h('option', { value: 'shared' }, t('memShared', 'Shared with this site (every conversation here)')),
    h('option', { value: 'private' }, t('memPrivate', 'Private to this conversation')),
    h('option', { value: 'off' }, t('memOff', 'Off (nothing is remembered)'))));
    modeSelect.value = mode;
    const modeRow = h('div', { class: 'item' },
      h('div', { class: 'row' }, h('strong', null, t('memoryForConversation', 'Memory for this conversation')), modeSelect),
      h('div', { class: 'meta' }, mode === 'private'
        ? t('memPrivateText', "This conversation keeps its own notes. They don't mix with the site's shared memory or other conversations.")
        : mode === 'off'
          ? t('memOffText', 'Nothing is read or saved for this conversation.')
          : t('memSharedText', 'Notes are shared by all conversations on this site.')));

    if (!memory) {
      setChildren(this, modeRow, mode === 'off' ? null
        : h('div', { class: 'meta' }, t('noSiteMemory', 'No site memory for this page (only http(s) and file pages have one).')));
      return;
    }

    const notes = /** @type {any[]} */ (memory.notes);
    const siteNotes = notes.filter((n) => n.scope === 'site');
    const hereNotes = notes.filter((n) => n.scope !== 'site' && n.appliesHere);
    const otherNotes = notes.filter((n) => n.scope !== 'site' && !n.appliesHere);
    const groupName = (/** @type {string} */ pattern) => memory.groups.find((g) => g.pattern === pattern)?.name ?? pattern;

    setChildren(this,
      modeRow,
      h('div', { class: 'item' },
        h('div', { class: 'row' }, h('strong', null, mode === 'private' ? t('sitePrivate', '$1 (private)', memory.site) : memory.site)),
        h('div', { class: 'meta' }, t('thisPagePath', 'This page: $1', memory.path)),
        this.renderCurrentGroup(memory)),

      h('div', { class: 'list-heading' }, t('wholeSiteCount', 'Whole site ($1)', siteNotes.length)),
      siteNotes.map((n) => this.renderNote(n)),
      h('div', { class: 'list-heading' }, t('thisKindCount', 'This kind of page ($1)', hereNotes.length)),
      hereNotes.map((n) => this.renderNote(n)),
      this.renderAddNote(),
      otherNotes.length ? h('div', { class: 'list-heading' }, t('otherKindsCount', 'Other kinds of pages ($1)', otherNotes.length)) : null,
      otherNotes.map((n) => this.renderNote(n, groupName(n.scope))),

      memory.groups.length ? h('div', { class: 'list-heading' }, t('pageTypesCount', 'Page types ($1)', memory.groups.length)) : null,
      memory.groups.map((/** @type {any} */ g) => this.renderGroup(g)),
      h('div', { class: 'meta', style: 'margin-top:10px' },
        t('memoryHelp', 'The AI reads the notes that apply to the current page at the start of each conversation, and adds notes when it learns something reusable. Notes are facts, not instructions; delete anything wrong.')),
    );
  }

  /** @param {any} memory */
  renderCurrentGroup(memory) {
    const { group } = memory;
    const name = /** @type {HTMLInputElement} */ (h('input', { type: 'text', value: group.name ?? '', placeholder: t('pageTypeExample', 'e.g. Chapter reader'), 'aria-label': t('pageTypeName', 'Page type name') }));
    const pattern = /** @type {HTMLInputElement} */ (h('input', { type: 'text', value: group.pattern, 'aria-label': t('pageTypePattern', 'Page type URL pattern') }));
    return h('div', null,
      h('div', null,
        t('pageType', 'Page type:'), ' ',
        group.auto ? h('em', null, t('notNamedYet', 'not named yet')) : h('strong', null, group.name),
        ' ', h('code', null, group.pattern)),
      h('div', { class: 'row', style: 'margin-top:4px' },
        name, pattern,
        h('button', {
          type: 'button',
          onclick: () => this.edit({ op: 'defineGroup', name: name.value, pattern: pattern.value }),
        }, group.auto ? t('nameIt', 'Name it') : t('update', 'Update'))),
      h('div', { class: 'meta' }, t('patternHelp', '"*" = one path part (any ID or slug), a final "**" = anything below.')));
  }

  /**
   * @param {any} note
   * @param {string} [groupLabel]
   */
  renderNote(note, groupLabel) {
    const editing = this.editing.has(note.id);
    const input = /** @type {HTMLInputElement} */ (h('input', { type: 'text', value: note.text, style: 'flex:1', 'aria-label': t('note', 'Note') }));
    return h('div', { class: 'item note' },
      editing
        ? h('div', { class: 'row' },
          input,
          h('button', { type: 'button', class: 'primary', onclick: () => { this.editing.delete(note.id); this.edit({ op: 'updateNote', noteId: note.id, text: input.value }); } }, t('save', 'Save')),
          h('button', { type: 'button', onclick: () => { this.editing.delete(note.id); this.render(); } }, t('cancel', 'Cancel')))
        : h('div', { class: 'row' },
          h('span', { style: 'flex:1' }, note.text),
          h('button', { type: 'button', onclick: () => { this.editing.add(note.id); this.render(); } }, t('edit', 'Edit')),
          h('button', { type: 'button', class: 'danger', onclick: () => this.edit({ op: 'deleteNote', noteId: note.id }) }, t('delete', 'Delete'))),
      h('div', { class: 'meta' },
        `${note.by === 'user' ? t('addedByYou', 'added by you') : t('learnedByAi', 'learned by the AI')} · ${new Date(note.createdAt).toLocaleDateString()}`,
        groupLabel ? ` · ${groupLabel}` : ''));
  }

  renderAddNote() {
    const text = /** @type {HTMLInputElement} */ (h('input', { type: 'text', placeholder: t('addNoteExample', 'Add a note, e.g. "I prefer a serif font for reading"'), style: 'flex:1', 'aria-label': t('newNote', 'New note') }));
    const scope = /** @type {HTMLSelectElement} */ (h('select', { 'aria-label': t('appliesToLabel', 'Applies to') },
      h('option', { value: 'site' }, t('wholeSiteLower', 'whole site')),
      h('option', { value: 'page_group' }, t('thisKindLower', 'this kind of page'))));
    const add = () => text.value.trim() && this.edit({ op: 'addNote', text: text.value, scope: scope.value });
    text.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
    return h('div', { class: 'row add-note' }, text, scope, h('button', { type: 'button', onclick: add }, t('add', 'Add')));
  }

  /** @param {any} group */
  renderGroup(group) {
    const name = /** @type {HTMLInputElement} */ (h('input', { type: 'text', value: group.name, 'aria-label': t('pageTypeName', 'Page type name') }));
    const pattern = /** @type {HTMLInputElement} */ (h('input', { type: 'text', value: group.pattern, 'aria-label': t('pageTypePattern', 'Page type URL pattern') }));
    return h('div', { class: 'item' },
      h('div', { class: 'row' },
        name, pattern,
        h('button', { type: 'button', onclick: () => this.edit({ op: 'updateGroup', groupId: group.id, name: name.value, pattern: pattern.value }) }, t('save', 'Save')),
        h('button', { type: 'button', class: 'danger', onclick: () => this.edit({ op: 'deleteGroup', groupId: group.id }) }, t('delete', 'Delete'))));
  }

  /** @param {Record<string, unknown>} change */
  async edit(change) {
    try {
      await this.app?.editMemory(change);
    } catch (err) {
      this.app?.showError(String(/** @type {any} */ (err).message ?? err));
    }
    this.render();
  }
}

customElements.define('ai-memory', MemoryView);
