// @ts-check
/**
 * <ai-chat>: the conversation. Renders messages from the server's provider-neutral
 * format, streams the reply as it arrives, and hosts action cards.
 */

import { ACTIONS, isPageAction, isReadOnly, isServerSide, runsLive, validateAction } from '../../shared/actions.js';
import { h } from '../lib/dom.js';
import { renderMarkdown } from '../lib/markdown.js';
import { ActionCard } from './action-card.js';

/** @typedef {import('../../shared/protocol.js').NeutralMessage} NeutralMessage */

/** Starting points on a new conversation. */
const SUGGESTIONS = [
  'Why is this overflowing?',
  'Make this look better',
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
    /** Open "Allow?" questions, answered "deny" when the turn ends. @type {Set<(answer: 'deny') => void>} */
    this.pendingAsks = new Set();
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
      h('div', { class: 'empty-title' }, 'Ask about this page'),
      h('div', null, 'Select an element in the Elements panel, or ask about the whole page.'),
      h('div', { class: 'suggestions' },
        SUGGESTIONS.map((text) => h('button', { type: 'button', onclick: () => this.app?.sendFromUi(text) }, text))),
      h('div', { class: 'welcome' })));
    this.app?.updateWelcome();
  }

  /**
   * Shown instead of the conversation while no AI is connected yet (direct mode, first run).
   * @param {() => void} openSettings
   */
  renderSetup(openSettings) {
    this.cards.clear();
    this.streamingEl = null;
    this.replaceChildren(h('div', { class: 'setup' },
      h('h2', null, 'Connect an AI to get started'),
      h('p', null, 'This panel explains and fixes the page you are inspecting. It needs one of these:'),
      h('ul', null,
        h('li', null, h('strong', null, 'An API key'), ' from Anthropic (Claude), OpenAI, Google Gemini or OpenRouter. Usage is billed to your account there.'),
        h('li', null, h('strong', null, 'Ollama'), ': free models that run on your own computer, no key.'),
        h('li', null, h('strong', null, 'The local agent server'), ' (for developers): use your Claude subscription through Claude Code.')),
      h('button', { type: 'button', class: 'primary', onclick: openSettings }, 'Open settings')));
  }

  /**
   * Fill the welcome area of the empty state ("Continue …", "I remember …").
   * @param {(Node | null)[]} nodes
   */
  setWelcome(nodes) {
    const box = this.querySelector('.empty .welcome');
    if (box) box.replaceChildren(...nodes.filter((n) => n !== null));
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
      const memory = /** @type {any} */ (message.content.find((b) => b.type === 'memory'))?.data;
      this.insert(h('div', { class: 'msg user' }, text, this.contextCaption(context, memory)));
    } else {
      // The streamed text is replaced by the final, formatted message.
      this.streamingEl?.remove();
      this.streamingEl = null;
      const el = h('div', { class: 'msg assistant' });
      for (const block of message.content) {
        // Tools the model already ran during the call (Claude Code over MCP), page steps included.
        if (block.type === 'inspection') {
          el.append(isPageAction(block.name)
            ? this.renderLiveLine({ id: '', ...block }, { status: block.ok === false ? 'failed' : 'applied' })
            : this.renderToolCall({ id: '', ...block }));
        }
        if (block.type === 'text') el.append(renderMarkdown(block.text));
        if (block.type === 'tool_call') el.append(this.renderToolCall(block));
      }
      foldInspections(el);
      if (el.childNodes.length) this.insert(el);
    }
    if (scroll && stick) this.scrollToBottom();
  }

  /**
   * @param {{ id: string, name: string, input: any }} call
   */
  renderToolCall(call) {
    if (isServerSide(call.name)) return this.renderMemoryLine(call);
    // A page action the AI ran itself (agent mode): one line. While it runs, activity lines show the steps.
    const record = /** @type {any} */ (this.app?.session?.actions[call.id]);
    if (record?.live) return this.renderLiveLine(call, record);
    // Not run yet: the message arrives before the step runs. In an agent mode it runs now, not as a card.
    if (!record && this.app && runsLive(call.name, this.app.agentMode())) return this.renderLiveLine(call, { status: 'running' });
    if (isReadOnly(call.name) || !ACTIONS[call.name]) {
      const i = call.input ?? {};
      const details = i.include?.join(', ') || i.urlContains || i.readContentOf || i.selector || (i.text ? `"${i.text}"` : '') || i.query
        || (i.fullViewport ? 'visible page' : '');
      return h('div', { class: 'inspection' }, `${ACTIONS[call.name]?.label ?? call.name}${details ? ` (${details})` : ''}`);
    }
    const card = /** @type {ActionCard} */ (document.createElement('ai-action-card'));
    card.bind(/** @type {any} */ (this.app), call.id, call.name, call.input);
    this.cards.set(call.id, card);
    return card;
  }

  /**
   * A page action the AI ran during its turn, as one line (with what happened).
   * @param {{ id: string, name: string, input: any }} call
   * @param {any} record
   */
  renderLiveLine(call, record) {
    const icon = { applied: '✓', rejected: '×', failed: '!', invalid: '!' }[/** @type {string} */ (record.status)] ?? '…';
    const what = call.input?.description || ACTIONS[call.name]?.label || call.name;
    return h('div', { class: `activity ${record.status}`, 'data-action': call.id },
      `${icon} ${what}`, record.detail ? h('span', { class: 'detail' }, ` · ${record.detail}`) : null);
  }

  /** Replace a page action's line once its result is known (action.live). @param {string} actionId */
  refreshLiveLine(actionId) {
    const old = this.querySelector(`[data-action="${CSS.escape(actionId)}"]`);
    const record = /** @type {any} */ (this.app?.session?.actions[actionId]);
    if (old && record) old.replaceWith(this.renderLiveLine({ id: actionId, name: record.name, input: record.input }, record));
  }

  /**
   * One line of what the AI is doing on the page right now ("Clicking …"), updated when the step is done.
   * @param {string} text
   */
  activity(text) {
    const stick = this.isNearBottom();
    const line = h('div', { class: 'activity running' }, `▶ ${text}…`);
    this.insert(line);
    if (stick) this.scrollToBottom();
    return {
      done: (/** @type {string} */ result, ok = true) => {
        line.className = `activity ${ok ? 'applied' : 'failed'}`;
        line.textContent = `${ok ? '✓' : '!'} ${result}`;
      },
    };
  }

  /**
   * Ask before a page step (agent modes). Resolves 'allow', 'all' (stop asking for this task) or 'deny'.
   * @param {string} what  e.g. 'click button "Send"'
   * @param {string} risky why it needs a yes even in Auto mode, or ''
   * @param {boolean} offerAll show "Allow all for this task"
   * @returns {Promise<'allow' | 'all' | 'deny'>}
   */
  askStep(what, risky, offerAll) {
    return new Promise((resolve) => {
      const done = (/** @type {'allow' | 'all' | 'deny'} */ answer) => {
        this.pendingAsks.delete(done);
        box.remove();
        resolve(answer);
      };
      const box = h('div', { class: `ask-step${risky ? ' risky' : ''}` },
        h('div', { class: 'ask-what' }, `Allow the AI to ${what}?`),
        risky ? h('div', { class: 'ask-why' }, `This ${risky}.`) : null,
        h('div', { class: 'buttons' },
          h('button', { type: 'button', class: 'primary', onclick: () => done('allow') }, 'Allow'),
          offerAll && !risky ? h('button', { type: 'button', onclick: () => done('all') }, 'Allow all for this task') : null,
          h('button', { type: 'button', onclick: () => done('deny') }, 'Deny')));
      this.pendingAsks.add(done);
      this.insert(box);
      this.scrollToBottom();
      /** @type {HTMLElement | null} */ (box.querySelector('button.primary'))?.focus();
    });
  }

  /** The turn ended (or was stopped): unanswered questions count as "no". */
  cancelAsks() {
    for (const done of [...this.pendingAsks]) done('deny');
  }

  /**
   * One line for a site-memory update ("Remembered …"). Managed in the Memory tab.
   * @param {{ name: string, input: any }} call
   */
  renderMemoryLine({ name, input }) {
    // An invalid request was refused by the agent (the model is told); don't show it as done.
    if (validateAction(name, input).length) {
      return h('div', { class: 'memory-line failed' }, `The AI's ${ACTIONS[name]?.label.toLowerCase() ?? name} request was invalid, so nothing was saved.`);
    }
    const text = name === 'remember'
      ? `Remembered (${input.scope === 'site' ? 'whole site' : 'this kind of page'}): ${input.note}`
      : name === 'forget'
        ? `Forgot a note (${input.id})`
        : `Named this kind of page "${input.name}" (${input.pattern})`;
    return h('div', { class: 'memory-line' }, text, ' ',
      h('button', { type: 'button', class: 'link', onclick: () => this.app?.showTab('memory') }, 'manage'));
  }

  /** "with $0 div.card > h2 · console" under a user message. */
  contextCaption(context, memory) {
    const parts = [];
    if (memory?.notes?.length) parts.push(`site memory (${memory.notes.length} note${memory.notes.length === 1 ? '' : 's'})`);
    if (!context) return parts.length ? h('div', { class: 'caption' }, `with ${parts.join(' · ')}`) : null;
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
   * A screenshot the AI just took, so the user sees what it looked at.
   * Shown during this session only; the conversation keeps the "Screenshot" line.
   * @param {string} label what was captured
   * @param {string} src data URL
   */
  addScreenshot(label, src) {
    const stick = this.isNearBottom();
    const img = h('img', {
      src, alt: `Screenshot of ${label}`, title: 'Click to enlarge',
      onclick: (/** @type {Event} */ e) => /** @type {HTMLElement} */ (e.currentTarget).classList.toggle('large'),
    });
    this.insert(h('div', { class: 'screenshot' }, h('div', { class: 'caption' }, `Looked at ${label}`), img));
    if (stick) this.scrollToBottom();
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

/**
 * Fold runs of two or more inspection lines ("Inspect element …") into one
 * expandable "Looked at the page · 5 steps" line, so the answer stays in front.
 * @param {HTMLElement} el an assistant message
 */
function foldInspections(el) {
  /** @type {Element[]} */
  let run = [];
  const flush = () => {
    if (run.length >= 2) {
      const steps = h('details', { class: 'steps' }, h('summary', null, `Looked at the page · ${run.length} steps`));
      run[0].before(steps);
      steps.append(...run);
    }
    run = [];
  };
  for (const child of [...el.children]) {
    if (child.classList.contains('inspection')) run.push(child);
    else flush();
  }
  flush();
}

customElements.define('ai-chat', ChatView);
