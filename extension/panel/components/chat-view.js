// @ts-check
/**
 * <ai-chat>: the conversation. Renders messages from the server's provider-neutral
 * format, streams the reply as it arrives, and hosts action cards.
 */

import { ACTIONS, isReadOnly } from '../../shared/actions.js';
import { h } from '../lib/dom.js';
import { renderMarkdown } from '../lib/markdown.js';
import { ActionCard } from './action-card.js';

/** @typedef {import('../../shared/protocol.js').NeutralMessage} NeutralMessage */

const SUGGESTIONS = [
  'Why is this overflowing?',
  'Make this look better',
  'Hide this',
  'Make this dark',
  'Explain the console errors',
];

export class ChatView extends HTMLElement {
  /** @param {import('../panel.js').App} app */
  bind(app) {
    this.app = app;
    /** @type {Map<string, ActionCard>} */
    this.cards = new Map();
    /** @type {HTMLElement | null} */
    this.streamingEl = null;
    /** @type {HTMLElement | null} */
    this.thinkingEl = null;
    /** @type {number | undefined} */
    this.thinkingTimer = undefined;
    return this;
  }

  /** Render a whole conversation (on open / reconnect). */
  renderAll() {
    const session = this.app?.session;
    this.cards.clear();
    this.replaceChildren();
    this.streamingEl = null;
    if (!session || !session.messages.some((m) => m.role === 'user' && m.content.some((b) => b.type === 'text'))) {
      this.renderEmpty();
    }
    for (const message of session?.messages ?? []) this.appendMessage(message, false);
    this.setBusy(Boolean(session?.busy));
    this.scrollToBottom();
  }

  renderEmpty() {
    this.append(h('div', { class: 'empty' },
      h('div', null, 'Select an element in the Elements panel, then ask something about it.'),
      h('div', { class: 'suggestions' },
        SUGGESTIONS.map((text) => h('button', { type: 'button', onclick: () => this.app?.sendFromUi(text) }, text)))));
  }

  /**
   * Add one message to the view.
   * @param {Omit<NeutralMessage, 'raw'>} message
   * @param {boolean} [scroll]
   */
  appendMessage(message, scroll = true) {
    const stick = this.isNearBottom();
    this.querySelector('.empty')?.remove();

    if (message.role === 'user') {
      const text = message.content.filter((b) => b.type === 'text').map((b) => /** @type {any} */ (b).text).join('\n');
      if (!text) return; // a message carrying only inspection results: internal
      const context = /** @type {any} */ (message.content.find((b) => b.type === 'context'))?.data;
      this.insert(h('div', { class: 'msg user' }, text, this.contextCaption(context)));
    } else {
      // The streamed text is replaced by the final, formatted message.
      this.streamingEl?.remove();
      this.streamingEl = null;
      const el = h('div', { class: 'msg assistant' });
      for (const block of message.content) {
        if (block.type === 'text') el.append(renderMarkdown(block.text));
        if (block.type === 'tool_call') el.append(this.renderToolCall(block));
      }
      if (el.childNodes.length) this.insert(el);
    }
    if (scroll && stick) this.scrollToBottom();
  }

  /**
   * @param {{ id: string, name: string, input: any }} call
   */
  renderToolCall(call) {
    if (isReadOnly(call.name) || !ACTIONS[call.name]) {
      const details = call.input?.include?.join(', ') || call.input?.urlContains || call.input?.readContentOf || call.input?.selector || '';
      return h('div', { class: 'inspection' }, `${ACTIONS[call.name]?.label ?? call.name}${details ? ` (${details})` : ''}`);
    }
    const card = /** @type {ActionCard} */ (document.createElement('ai-action-card'));
    card.bind(/** @type {any} */ (this.app), call.id, call.name, call.input);
    this.cards.set(call.id, card);
    return card;
  }

  /** "with $0 div.card > h2 · console" under a user message. */
  contextCaption(context) {
    if (!context) return null;
    const parts = [];
    if (context.selected?.selector) parts.push(`$0 ${context.selected.selector}`);
    if (context.console) parts.push('console');
    if (context.network) parts.push('network');
    if (context.consoleError) parts.push(`error: ${String(context.consoleError.message).slice(0, 80)}`);
    return parts.length ? h('div', { class: 'caption' }, `with ${parts.join(' · ')}`) : null;
  }

  /** @param {string} text streamed reply text */
  appendDelta(text) {
    const stick = this.isNearBottom();
    if (!this.streamingEl) {
      this.streamingEl = h('div', { class: 'msg assistant streaming' });
      this.insert(this.streamingEl);
    }
    this.streamingEl.append(text);
    if (stick) this.scrollToBottom();
  }

  /** @param {string} text */
  showError(text) {
    this.insert(h('div', { class: 'chat-error' }, text));
    this.scrollToBottom();
  }

  /**
   * Ask the user to allow an inspection (when "ask before inspections" is on).
   * @param {string} description
   * @returns {Promise<boolean>}
   */
  askPermission(description) {
    return new Promise((resolve) => {
      const done = (/** @type {boolean} */ ok) => { row.remove(); resolve(ok); };
      const row = h('div', { class: 'ask-row' },
        h('span', null, `AI wants to: ${description}`),
        h('button', { type: 'button', class: 'primary', onclick: () => done(true) }, 'Allow'),
        h('button', { type: 'button', onclick: () => done(false) }, 'Deny'));
      this.insert(row);
      this.scrollToBottom();
    });
  }

  /** @param {boolean} busy */
  setBusy(busy) {
    clearInterval(this.thinkingTimer);
    this.thinkingEl?.remove();
    this.thinkingEl = null;
    if (!busy) return;
    const started = Date.now();
    this.thinkingEl = h('div', { class: 'thinking' }, 'Thinking…');
    this.append(this.thinkingEl);
    this.thinkingTimer = setInterval(() => {
      if (this.thinkingEl) this.thinkingEl.textContent = `Thinking… ${Math.round((Date.now() - started) / 1000)}s`;
    }, 1000);
    this.scrollToBottom();
  }

  /** Re-render all action cards (after status or settings changes). */
  refreshCards() {
    for (const card of this.cards.values()) card.update();
  }

  /** @param {string} id */
  refreshCard(id) {
    this.cards.get(id)?.update();
  }

  /** Insert before the "Thinking…" indicator so it stays last. @param {Node} node */
  insert(node) {
    if (this.thinkingEl?.parentNode === this) this.insertBefore(node, this.thinkingEl);
    else this.append(node);
  }

  isNearBottom() {
    return this.scrollHeight - this.scrollTop - this.clientHeight < 60;
  }

  scrollToBottom() {
    this.scrollTop = this.scrollHeight;
  }
}

customElements.define('ai-chat', ChatView);
