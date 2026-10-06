// @ts-check
/**
 * <ai-tasks>: saved tasks (steps from an agent turn that worked, see lib/tasks.js). Tasks for this
 * site come first. Run replays the steps without the AI, asking before risky ones (as in Auto mode);
 * the steps can be looked at, and a task can be renamed or deleted.
 */

import { siteKey } from '../../shared/page-groups.js';
import { relativeTime } from './history-view.js';
import { h, setChildren } from '../lib/dom.js';
import { t } from '../../shared/i18n.js';
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
    const here = tasks.filter((task) => task.site === site);
    const elsewhere = tasks.filter((task) => task.site !== site);
    this.app.setTaskCount(here.length);
    setChildren(this,
      h('div', { class: 'list-heading' }, t('thisSiteCount', 'This site ($1)', here.length)),
      here.length ? here.map((task) => this.renderTask(task, true))
        : h('div', { class: 'meta' }, t('noTasks', 'No saved tasks for this site. When the AI has done something on the page in an agent mode, click "Save as task" under its answer to run the same steps again later, without the AI.')),
      elsewhere.length ? h('div', { class: 'list-heading' }, t('otherSitesCount', 'Other sites ($1)', elsewhere.length)) : null,
      elsewhere.map((task) => this.renderTask(task, false)),
    );
  }

  /**
   * @param {import('../lib/tasks.js').Task} task
   * @param {boolean} onThisSite
   */
  renderTask(task, onThisSite) {
    const renaming = this.renaming.has(task.id);
    const nameInput = /** @type {HTMLInputElement} */ (h('input', { type: 'text', value: task.name, 'aria-label': t('taskName', 'Task name') }));
    const busy = Boolean(this.app?.session?.busy || this.app?.replaying);
    return h('div', { class: 'item' },
      h('div', { class: 'row' },
        h('span', { class: 'title', title: task.name }, task.name),
        h('button', {
          type: 'button', class: 'primary', disabled: busy,
          title: onThisSite ? t('runHere', 'Run these steps on this page') : t('runOpens', 'Opens $1 first (asks before leaving this site)', task.startUrl),
          onclick: () => this.app?.runTask(task),
        }, t('run', 'Run')),
        h('button', { type: 'button', onclick: () => { renaming ? this.renaming.delete(task.id) : this.renaming.add(task.id); this.refresh(); } }, renaming ? t('close', 'Close') : t('rename', 'Rename')),
        h('button', {
          type: 'button', class: 'danger',
          // Two clicks to delete (native confirm() dialogs are unreliable inside DevTools).
          onclick: async (/** @type {any} */ e) => {
            if (e.target.dataset.armed) {
              await deleteTask(task.id).catch((err) => this.app?.showError(err.message));
            } else {
              e.target.dataset.armed = '1';
              e.target.textContent = t('clickAgainDelete', 'Click again to delete');
              setTimeout(() => { delete e.target.dataset.armed; e.target.textContent = t('delete', 'Delete'); }, 3000);
            }
          },
        }, t('delete', 'Delete'))),
      h('div', { class: 'meta' },
        task.steps.length === 1 ? t('taskMetaOne', '1 step · starts on $1', shortUrl(task.startUrl)) : t('taskMeta', '$1 steps · starts on $2', task.steps.length, shortUrl(task.startUrl)),
        task.lastRun ? ` · ${t('lastRun', 'last run $1', relativeTime(task.lastRun))}` : ''),
      renaming
        ? h('div', { class: 'row' }, nameInput,
          h('button', {
            type: 'button', class: 'primary',
            onclick: async () => {
              this.renaming.delete(task.id);
              await updateTask(task.id, { name: nameInput.value.trim().slice(0, 80) || task.name });
            },
          }, t('save', 'Save')))
        : null,
      h('details', null,
        h('summary', null, t('steps', 'Steps')),
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
