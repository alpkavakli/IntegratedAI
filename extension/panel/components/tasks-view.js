// @ts-check
/**
 * <ai-tasks>: saved tasks (steps from an agent turn that worked, see lib/tasks.js). Tasks for this
 * site come first. Run replays the steps without the AI, asking before risky ones (as in Auto mode);
 * the steps can be looked at, and a task can be renamed or deleted.
 */

import { siteKey } from '../../shared/page-groups.js';
import { relativeTime } from './history-view.js';
import { h, setChildren } from '../lib/dom.js';
import { deleteTask, describeStep, listTasks, updateTask } from '../lib/tasks.js';

export class TasksView extends HTMLElement {
  /** @param {import('../panel.js').App} app */
  bind(app) {
    this.app = app;
    /** @type {Set<string>} ids of tasks being renamed */
    this.renaming = new Set();
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.tasks) this.refresh();
    });
    this.refresh();
    return this;
  }

  async refresh() {
    if (!this.app) return;
    const tasks = await listTasks();
    const site = siteKey(this.app.pageUrl);
    const here = tasks.filter((t) => t.site === site);
    const elsewhere = tasks.filter((t) => t.site !== site);
    this.app.setTaskCount(here.length);
    setChildren(this,
      h('div', { class: 'list-heading' }, `This site (${here.length})`),
      here.length ? here.map((t) => this.renderTask(t, true))
        : h('div', { class: 'meta' }, 'No saved tasks for this site. When the AI has done something on the page in an agent mode, click "Save as task" under its answer to run the same steps again later, without the AI.'),
      elsewhere.length ? h('div', { class: 'list-heading' }, `Other sites (${elsewhere.length})`) : null,
      elsewhere.map((t) => this.renderTask(t, false)),
    );
  }

  /**
   * @param {import('../lib/tasks.js').Task} task
   * @param {boolean} onThisSite
   */
  renderTask(task, onThisSite) {
    const renaming = this.renaming.has(task.id);
    const nameInput = /** @type {HTMLInputElement} */ (h('input', { type: 'text', value: task.name, 'aria-label': 'Task name' }));
    const busy = Boolean(this.app?.session?.busy || this.app?.replaying);
    return h('div', { class: 'item' },
      h('div', { class: 'row' },
        h('span', { class: 'title', title: task.name }, task.name),
        h('button', {
          type: 'button', class: 'primary', disabled: busy,
          title: onThisSite ? 'Run these steps on this page' : `Opens ${task.startUrl} first (asks before leaving this site)`,
          onclick: () => this.app?.runTask(task),
        }, 'Run'),
        h('button', { type: 'button', onclick: () => { renaming ? this.renaming.delete(task.id) : this.renaming.add(task.id); this.refresh(); } }, renaming ? 'Close' : 'Rename'),
        h('button', {
          type: 'button', class: 'danger',
          // Two clicks to delete (native confirm() dialogs are unreliable inside DevTools).
          onclick: async (/** @type {any} */ e) => {
            if (e.target.dataset.armed) {
              await deleteTask(task.id).catch((err) => this.app?.showError(err.message));
            } else {
              e.target.dataset.armed = '1';
              e.target.textContent = 'Click again to delete';
              setTimeout(() => { delete e.target.dataset.armed; e.target.textContent = 'Delete'; }, 3000);
            }
          },
        }, 'Delete')),
      h('div', { class: 'meta' },
        `${task.steps.length} step${task.steps.length === 1 ? '' : 's'} · starts on ${shortUrl(task.startUrl)}`,
        task.lastRun ? ` · last run ${relativeTime(task.lastRun)}` : ''),
      renaming
        ? h('div', { class: 'row' }, nameInput,
          h('button', {
            type: 'button', class: 'primary',
            onclick: async () => {
              this.renaming.delete(task.id);
              await updateTask(task.id, { name: nameInput.value.trim().slice(0, 80) || task.name });
            },
          }, 'Save'))
        : null,
      h('details', null,
        h('summary', null, 'Steps'),
        h('ol', { class: 'changes' }, task.steps.map((s) => h('li', null, describeStep(s))))),
    );
  }
}

/** @param {string} url */
function shortUrl(url) {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname === '/' ? '' : u.pathname}`;
  } catch {
    return url;
  }
}

customElements.define('ai-tasks', TasksView);
