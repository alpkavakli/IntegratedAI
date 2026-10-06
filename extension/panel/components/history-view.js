// @ts-check
/**
 * <ai-history>: earlier conversations on this site, newest first, with the
 * ones about the same kind of page (page group) at the top. Clicking one
 * continues it in this tab (the Claude Code session is resumed too).
 */

import { h, setChildren } from '../lib/dom.js';
import { t } from '../../shared/i18n.js';

export class HistoryView extends HTMLElement {
  /** @param {import('../panel.js').App} app */
  bind(app) {
    this.app = app;
    return this;
  }

  async toggle() {
    if (!this.hidden) {
      this.hidden = true;
      return;
    }
    this.hidden = false;
    setChildren(this, h('div', { class: 'meta' }, t('loading', 'Loading…')));
    try {
      const { site, items } = await this.app.listConversations();
      this.render(site, items);
    } catch (err) {
      setChildren(this, h('div', { class: 'chat-error' }, String(/** @type {any} */ (err).message)));
    }
  }

  /**
   * @param {string | null} site
   * @param {any[]} items
   */
  render(site, items) {
    const app = /** @type {import('../panel.js').App} */ (this.app);
    const currentId = app.session?.id;
    const same = items.filter((i) => i.sameGroup);
    const other = items.filter((i) => !i.sameGroup);
    const row = (/** @type {any} */ item) => h('button', {
      type: 'button',
      class: `history-item${item.id === currentId ? ' current' : ''}`,
      title: item.lastUrl,
      onclick: async () => {
        this.hidden = true;
        if (item.id !== currentId) await app.switchConversation(item.id);
      },
    },
    h('span', { class: 'title' }, item.title),
    h('span', { class: 'meta' },
      `${relativeTime(item.updatedAt)} · ${item.messageCount === 1 ? t('oneMessage', '1 message') : t('messages', '$1 messages', item.messageCount)} · ${shortPath(item.lastUrl)}`,
      item.id === currentId ? ` · ${t('current', 'current')}` : ''));

    setChildren(this,
      h('div', { class: 'row' },
        h('strong', null, site ? t('conversationsOn', 'Conversations on $1', site) : t('noHistory', 'No history for this page')),
        h('span', { class: 'spacer' }),
        h('button', { type: 'button', onclick: () => { this.hidden = true; } }, t('close', 'Close'))),
      !items.length ? h('div', { class: 'meta' }, t('nothingYet', 'Nothing yet. Conversations are saved automatically.')) : null,
      same.length ? h('div', { class: 'list-heading' }, t('thisKindOfPage', 'This kind of page')) : null,
      same.map(row),
      other.length ? h('div', { class: 'list-heading' }, t('elsewhereOn', 'Elsewhere on $1', site)) : null,
      other.map(row),
    );
  }
}

/** "5 min ago", "yesterday", "12 Mar". @param {number} ts */
export function relativeTime(ts) {
  const seconds = (Date.now() - ts) / 1000;
  if (seconds < 60) return t('justNow', 'just now');
  if (seconds < 3600) return t('minAgo', '$1 min ago', Math.round(seconds / 60));
  if (seconds < 86400) return t('hoursAgo', '$1 h ago', Math.round(seconds / 3600));
  if (seconds < 2 * 86400) return t('yesterday', 'yesterday');
  if (seconds < 7 * 86400) return t('daysAgo', '$1 days ago', Math.round(seconds / 86400));
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** @param {string} url */
function shortPath(url) {
  try {
    const path = new URL(url).pathname;
    return path.length > 50 ? `${path.slice(0, 47)}…` : path;
  } catch {
    return url;
  }
}

customElements.define('ai-history', HistoryView);
