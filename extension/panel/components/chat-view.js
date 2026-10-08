// @ts-check
/**
 * <ai-chat>: the conversation. Renders messages from the server's provider-neutral
 * format, streams the reply as it arrives, and hosts action cards.
 */

import { ACTIONS, isPageAction, isReadOnly, isServerSide, runsLive, validateAction } from '../../shared/actions.js';
import { h, setChildren } from '../lib/dom.js';
import { IN_CARD } from '../lib/surface.js';
import { t } from '../../shared/i18n.js';
import { actionLabel } from '../lib/action-labels.js';
import { renderMarkdown } from '../lib/markdown.js';
import { ActionCard } from './action-card.js';

/** @typedef {import('../../shared/protocol.js').NeutralMessage} NeutralMessage */

/** Starting points on a new conversation: for developers in DevTools, for reading and quick fixes in the card. */
const SUGGESTIONS = IN_CARD
  ? [t('sugSummarize', 'Summarize this page'), 'translate', t('sugExplainPicked', 'Explain what I picked'), t('sugEasier', 'Make this easier to read')]
  : [t('sugOverflow', 'Why is this overflowing?'), t('sugBetter', 'Make this look better'), t('sugDark', 'Make this dark'), t('sugConsole', 'Explain the console errors')];

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
    /** Who "Allow … to click …?" asks for: the AI ('ai'), or a saved task being run ('task'). */
    this.askSubject = 'ai';
    return this;
  }

  /** The page's language (its <html lang>), for the "Translate this page into …" suggestion. @param {string} lang */
  setPageLang(lang) {
    this.pageLang = lang;
    const chip = this.querySelector('[data-suggestion=translate]');
    if (chip) chip.textContent = translateSuggestion(lang);
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
      h('div', { class: 'empty-title' }, t('emptyTitle', 'Ask about this page')),
      h('div', null, IN_CARD ? t('emptyCard', 'Pick an element on the page, or ask about the whole page.') : t('emptyDevtools', 'Select an element in the Elements panel, or ask about the whole page.')),
      h('div', { class: 'suggestions' },
        SUGGESTIONS.map((text) => (text === 'translate'
          ? h('button', { type: 'button', 'data-suggestion': 'translate', onclick: (/** @type {any} */ e) => this.app?.sendFromUi(e.currentTarget.textContent) },
            translateSuggestion(this.pageLang))
          : h('button', { type: 'button', onclick: () => this.app?.sendFromUi(text) }, text)))),
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
      h('h2', null, t('setupTitle', 'Connect an AI to get started')),
      h('p', null, t('setupIntro', 'This panel explains and fixes the page you are inspecting. It needs one of these:')),
      h('ul', null,
        h('li', null, h('strong', null, t('setupKey', 'An API key')), ' ', t('setupKeyText', 'from Anthropic (Claude), OpenAI, Google Gemini, DeepSeek and others. Usage is billed to your account there.')),
        h('li', null, h('strong', null, 'Ollama'), ': ', t('setupOllamaText', 'free models that run on your own computer, no key.')),
        h('li', null, h('strong', null, t('setupServer', 'The local agent server')), ' ', t('setupServerText', '(for developers): use your Claude subscription through Claude Code.'))),
      h('button', { type: 'button', class: 'primary', onclick: openSettings }, t('openSettings', 'Open settings'))));
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
      const details = i.include?.join(', ') || i.urlContains || i.readContentOf || i.selector || i.ref || (i.text ? `"${i.text}"` : '') || i.query
        || (i.all ? 'whole page' : '')
        || (i.fullViewport ? 'visible page' : '');
      return h('div', { class: 'inspection', 'data-action': call.id }, `${actionLabel(call.name)}${details ? ` (${details})` : ''}`);
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
   * Under an agent turn that did things on the page: "Save as task", which asks for a name and saves.
   * @param {number} count steps done
   * @param {string} suggestedName
   * @param {(name: string) => Promise<void>} save
   */
  offerSaveTask(count, suggestedName, save) {
    const name = /** @type {HTMLInputElement} */ (h('input', { type: 'text', value: suggestedName, 'aria-label': t('taskName', 'Task name'), maxlength: '80' }));
    const status = h('span', { class: 'detail' });
    const form = h('div', { class: 'row', hidden: true }, name,
      h('button', {
        type: 'button', class: 'primary',
        onclick: async () => {
          try {
            await save(name.value);
            setChildren(box, h('span', { class: 'detail' }, t('taskSaved', 'Saved as "$1". Run it from the Tasks tab.', name.value.trim() || t('untitledTask', 'Untitled task'))));
          } catch (err) {
            status.textContent = ` ${/** @type {any} */ (err).message}`;
          }
        },
      }, t('save', 'Save')),
      status);
    const box = h('div', { class: 'save-task' },
      h('button', {
        type: 'button', class: 'link',
        onclick: (/** @type {any} */ e) => { e.target.hidden = true; form.hidden = false; name.focus(); name.select(); },
      }, count === 1 ? t('saveOneStep', 'Save this step as a task') : t('saveSteps', 'Save these $1 steps as a task', count)),
      form);
    const stick = this.isNearBottom();
    this.insert(box);
    if (stick) this.scrollToBottom();
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
        h('div', { class: 'ask-what' }, this.askSubject === 'task' ? t('askTask', 'Allow this task to $1?', what) : t('askAi', 'Allow the AI to $1?', what)),
        risky ? h('div', { class: 'ask-why' }, t('askWhy', 'This $1.', risky)) : null,
        h('div', { class: 'buttons' },
          h('button', { type: 'button', class: 'primary', onclick: () => done('allow') }, t('allow', 'Allow')),
          offerAll && !risky ? h('button', { type: 'button', onclick: () => done('all') }, t('allowAll', 'Allow all for this task')) : null,
          h('button', { type: 'button', onclick: () => done('deny') }, t('deny', 'Deny'))));
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
      return h('div', { class: 'memory-line failed' }, t('memoryInvalid', "The AI's $1 request was invalid, so nothing was saved.", ACTIONS[name]?.label.toLowerCase() ?? name));
    }
    const text = name === 'remember'
      ? (input.scope === 'site' ? t('rememberedSite', 'Remembered (whole site): $1', input.note) : t('rememberedGroup', 'Remembered (this kind of page): $1', input.note))
      : name === 'forget'
        ? t('forgot', 'Forgot a note ($1)', input.id)
        : t('namedGroup', 'Named this kind of page "$1" ($2)', input.name, input.pattern);
    return h('div', { class: 'memory-line' }, text, ' ',
      h('button', { type: 'button', class: 'link', onclick: () => this.app?.showTab('memory') }, t('manage', 'manage')));
  }

  /** "with $0 div.card > h2 · console" under a user message. */
  contextCaption(context, memory) {
    const parts = [];
    if (memory?.notes?.length) parts.push(t('capMemory', 'site memory (notes: $1)', memory.notes.length));
    if (!context) return parts.length ? h('div', { class: 'caption' }, t('capWith', 'with $1', parts.join(' · '))) : null;
    if (context.selected?.selector) parts.push(IN_CARD ? context.selected.selector : `$0 ${context.selected.selector}`); // "$0" means nothing outside DevTools
    if (context.console) parts.push(t('capConsole', 'console'));
    if (context.network) parts.push(t('capNetwork', 'network'));
    if (context.consoleError) parts.push(t('capError', 'error: $1', String(context.consoleError.message).slice(0, 80)));
    return parts.length ? h('div', { class: 'caption' }, t('capWith', 'with $1', parts.join(' · '))) : null;
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
      src, alt: t('screenshotOf', 'Screenshot of $1', label), title: t('clickToEnlarge', 'Click to enlarge'),
      onclick: (/** @type {Event} */ e) => /** @type {HTMLElement} */ (e.currentTarget).classList.toggle('large'),
    });
    this.insert(h('div', { class: 'screenshot' }, h('div', { class: 'caption' }, t('lookedAt', 'Looked at $1', label)), img));
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
        h('span', null, t('aiWantsTo', 'AI wants to: $1', description)),
        h('button', { type: 'button', class: 'primary', onclick: () => done(true) }, t('allow', 'Allow')),
        h('button', { type: 'button', onclick: () => done(false) }, t('deny', 'Deny')));
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
    this.busyUntil = 0;
    this.thinkingEl = h('div', { class: 'thinking' }, t('thinking', 'Thinking…'));
    this.append(this.thinkingEl);
    const tick = () => {
      if (!this.thinkingEl) return;
      const left = Math.ceil((this.busyUntil - Date.now()) / 1000);
      this.thinkingEl.textContent = left > 0
        ? t('busyRetry', '$1 is busy, trying again in $2 s…', this.busyProvider, left)
        : t('thinkingFor', 'Thinking… $1s', Math.round((Date.now() - started) / 1000));
    };
    this.thinkingTimer = setInterval(tick, 1000);
    this.tickThinking = tick;
    this.scrollToBottom();
  }

  /**
   * A busy AI service is being tried again (the provider said so): a countdown instead of "Thinking…".
   * @param {string} provider  its name, e.g. "GLM"
   * @param {number} waitMs
   */
  showBusyProvider(provider, waitMs) {
    this.busyProvider = provider;
    this.busyUntil = Date.now() + waitMs;
    this.tickThinking?.();
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
      const steps = h('details', { class: 'steps' }, h('summary', null, t('lookedSteps', 'Looked at the page · $1 steps', run.length)));
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

/**
 * "Translate this page into Turkish": the reader's first language (Chrome's, then their preferred ones) that isn't
 * the page's own, named in the interface language. Said up front, so it's clear before anything is sent.
 * @param {string} [pageLang]
 */
export function translateSuggestion(pageLang = '') {
  const base = (/** @type {string} */ code) => code.toLowerCase().split('-')[0];
  let ui = 'en';
  try { ui = chrome.i18n.getUILanguage(); } catch { /* not in the extension */ }
  const code = [ui, ...navigator.languages].map(base).find((l) => l && l !== base(pageLang)) ?? 'en';
  let name = code;
  try { name = new Intl.DisplayNames([ui], { type: 'language' }).of(code) ?? code; } catch { /* unknown code */ }
  return t('sugTranslateInto', 'Translate this page into $1', name);
}
