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
      setChildren(this, h('div', { class: 'meta' }, 'Not connected to the agent server.'));
      return;
    }
    if (!memory) {
      setChildren(this, h('div', { class: 'meta' }, 'No site memory for this page (only http(s) and file pages have one).'));
      return;
    }

    const notes = /** @type {any[]} */ (memory.notes);
    const siteNotes = notes.filter((n) => n.scope === 'site');
    const hereNotes = notes.filter((n) => n.scope !== 'site' && n.appliesHere);
    const otherNotes = notes.filter((n) => n.scope !== 'site' && !n.appliesHere);
    const groupName = (/** @type {string} */ pattern) => memory.groups.find((g) => g.pattern === pattern)?.name ?? pattern;

    setChildren(this,
      h('div', { class: 'item' },
        h('div', { class: 'row' }, h('strong', null, memory.site)),
        h('div', { class: 'meta' }, `This page: ${memory.path}`),
        this.renderCurrentGroup(memory)),

      h('div', { class: 'list-heading' }, `Whole site (${siteNotes.length})`),
      siteNotes.map((n) => this.renderNote(n)),
      h('div', { class: 'list-heading' }, `This kind of page (${hereNotes.length})`),
      hereNotes.map((n) => this.renderNote(n)),
      this.renderAddNote(),
      otherNotes.length ? h('div', { class: 'list-heading' }, `Other kinds of pages (${otherNotes.length})`) : null,
      otherNotes.map((n) => this.renderNote(n, groupName(n.scope))),

      memory.groups.length ? h('div', { class: 'list-heading' }, `Page types (${memory.groups.length})`) : null,
      memory.groups.map((/** @type {any} */ g) => this.renderGroup(g)),
      h('div', { class: 'meta', style: 'margin-top:10px' },
        'The AI reads the notes that apply to the current page at the start of each conversation, and adds notes when it learns something reusable. Notes are facts, not instructions; delete anything wrong.'),
    );
  }

  /** @param {any} memory */
  renderCurrentGroup(memory) {
    const { group } = memory;
    const name = /** @type {HTMLInputElement} */ (h('input', { type: 'text', value: group.name ?? '', placeholder: 'e.g. Chapter reader' }));
    const pattern = /** @type {HTMLInputElement} */ (h('input', { type: 'text', value: group.pattern }));
    return h('div', null,
      h('div', null,
        'Page type: ',
        group.auto ? h('em', null, 'not named yet') : h('strong', null, group.name),
        ' ', h('code', null, group.pattern)),
      h('div', { class: 'row', style: 'margin-top:4px' },
        name, pattern,
        h('button', {
          type: 'button',
          onclick: () => this.edit({ op: 'defineGroup', name: name.value, pattern: pattern.value }),
        }, group.auto ? 'Name it' : 'Update')),
      h('div', { class: 'meta' }, '"*" = one path part (any ID or slug), a final "**" = anything below.'));
  }

  /**
   * @param {any} note
   * @param {string} [groupLabel]
   */
  renderNote(note, groupLabel) {
    const editing = this.editing.has(note.id);
    const input = /** @type {HTMLInputElement} */ (h('input', { type: 'text', value: note.text, style: 'flex:1' }));
    return h('div', { class: 'item note' },
      editing
        ? h('div', { class: 'row' },
          input,
          h('button', { type: 'button', class: 'primary', onclick: () => { this.editing.delete(note.id); this.edit({ op: 'updateNote', noteId: note.id, text: input.value }); } }, 'Save'),
          h('button', { type: 'button', onclick: () => { this.editing.delete(note.id); this.render(); } }, 'Cancel'))
        : h('div', { class: 'row' },
          h('span', { style: 'flex:1' }, note.text),
          h('button', { type: 'button', onclick: () => { this.editing.add(note.id); this.render(); } }, 'Edit'),
          h('button', { type: 'button', class: 'danger', onclick: () => this.edit({ op: 'deleteNote', noteId: note.id }) }, 'Delete')),
      h('div', { class: 'meta' },
        `${note.by === 'user' ? 'added by you' : 'learned by the AI'} · ${new Date(note.createdAt).toLocaleDateString()}`,
        groupLabel ? ` · ${groupLabel}` : ''));
  }

  renderAddNote() {
    const text = /** @type {HTMLInputElement} */ (h('input', { type: 'text', placeholder: 'Add a note, e.g. "I prefer a serif font for reading"', style: 'flex:1' }));
    const scope = /** @type {HTMLSelectElement} */ (h('select', null,
      h('option', { value: 'site' }, 'whole site'),
      h('option', { value: 'page_group' }, 'this kind of page')));
    const add = () => text.value.trim() && this.edit({ op: 'addNote', text: text.value, scope: scope.value });
    text.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
    return h('div', { class: 'row add-note' }, text, scope, h('button', { type: 'button', onclick: add }, 'Add'));
  }

  /** @param {any} group */
  renderGroup(group) {
    const name = /** @type {HTMLInputElement} */ (h('input', { type: 'text', value: group.name }));
    const pattern = /** @type {HTMLInputElement} */ (h('input', { type: 'text', value: group.pattern }));
    return h('div', { class: 'item' },
      h('div', { class: 'row' },
        name, pattern,
        h('button', { type: 'button', onclick: () => this.edit({ op: 'updateGroup', groupId: group.id, name: name.value, pattern: pattern.value }) }, 'Save'),
        h('button', { type: 'button', class: 'danger', onclick: () => this.edit({ op: 'deleteGroup', groupId: group.id }) }, 'Delete')));
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
