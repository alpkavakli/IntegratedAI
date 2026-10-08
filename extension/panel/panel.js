// @ts-check
/**
 * The AI panel's controller ("App"). It connects the pieces:
 *
 *   ServerClient (WebSocket) ⇄ App ⇄ components (<ai-chat>, <ai-action-card>, <ai-patches>, <ai-console>)
 *                                 ├─ collectContext()   small page context for each message
 *                                 ├─ runInspection()    read-only tool requests from the model
 *                                 └─ ChangeManager      apply / preview / undo of APPROVED changes
 *
 * Conversation per tab: the service worker remembers tabId → conversationId for
 * the browser session, so the conversation survives closing DevTools, reloads
 * and navigation in the same tab.
 *
 * The same panel also runs as the basic card on the page (lib/surface.js): there it has no
 * DevTools APIs, picks elements with Pick element, offers only the card's actions, and points to
 * DevTools for the rest. Both share the tab's conversation, so DevTools continues where the card was.
 */

import { ACTIONS, AREA_ACTIONS, CARD_ACTIONS, isPageAction, validateAction } from '../shared/actions.js';
import { PageAccess } from './lib/page-access.js';
import { IN_CARD, TAB_ID } from './lib/surface.js';
import { AgentRunner } from './lib/agent-runner.js';
import { hideWorkingBadge, showWorkingBadge, takeStopRequest } from './lib/page-interact.js';
import './components/action-card.js';
import './components/chat-view.js';
import './components/console-view.js';
import './components/history-view.js';
import './components/memory-view.js';
import { relativeTime } from './components/history-view.js';
import './components/patches-view.js';
import './components/tasks-view.js';
import { bg } from './lib/bg.js';
import { h } from './lib/dom.js';
import { ChangeManager } from './lib/changes.js';
import { collectContext } from './lib/context.js';
import { callInPage, selectInElementsPanel } from './lib/inspected.js';
import { runInspection } from './lib/inspections.js';
import { highlight, pageInfo, pickElement, selectedLabel, selectedText } from './lib/page-scripts.js';
import { loadSettings, onSettingsChanged, saveSettings } from './lib/settings.js';
import { saveTask, updateTask } from './lib/tasks.js';
import { ServerClient } from './lib/ws-client.js';
import { DirectClient } from './direct/direct-client.js';
import { boostCss } from '../shared/css-boost.js';
import { conversationToMarkdown } from '../shared/conversation-markdown.js';
import { localize, t } from '../shared/i18n.js';
import { PRESETS, baseUrlFor } from '../shared/providers/openai-compatible.js';

const $ = (/** @type {string} */ id) => /** @type {any} */ (document.getElementById(id));

export class App {
  constructor() {
    this.tabId = TAB_ID;
    /** @type {import('./lib/settings.js').Settings} */
    this.settings = /** @type {any} */ (null);
    /** @type {import('../shared/protocol.js').SessionSnapshot | null} */
    this.session = null;
    /** @type {import('../shared/protocol.js').ProviderInfo[]} */
    this.providers = [];
    /** A saved task is running (Tasks tab → Run). */
    this.replaying = false;
    /** Ollama is the provider: checks whether it's running (watchOllama). @type {ReturnType<typeof setInterval> | undefined} */
    this.ollamaTimer = undefined;
    /** The last check found Ollama not running (the warning banner is ours). */
    this.ollamaDown = false;
    this.changes = new ChangeManager(this.tabId);
    /** The AI backend: the local agent server, or direct mode inside the extension (same interface). Set in start(). */
    this.client = /** @type {ServerClient | DirectClient} */ (/** @type {any} */ (null));
    this.connected = false;
    this.pageUrl = '';
    /** Selector of $0 when the last message was sent (target of modify_element without selector). */
    this.lastSentSelector = '';
    /** @type {Record<string, string>} actionId → resolved target selector */
    this.targets = {};
    /** @type {Promise<void> | null} */
    this.navigationReset = null;
    /** Keeps the "working… Stop" badge on the page during agent turns. @type {ReturnType<typeof setInterval> | undefined} */
    this.pageStopTimer = undefined;
    /** Site memory for the current page (from the server), or null. @type {any} */
    this.memoryInfo = null;
    /** Your project folder for this page ("Apply to source"), or null. @type {{ name: string, path: string } | null} */
    this.sourceProject = null;

    this.chat = $('chat').bind(this);
    /** Runs page actions in the agent modes, asking in the chat when the mode says so. */
    this.agent = new AgentRunner({
      ask: (what, risky, offerAll) => this.chat.askStep(what, risky, offerAll),
      activity: (text) => this.chat.activity(text),
    });
    this.patchesView = /** @type {any} */ (null);
    this.consoleView = /** @type {any} */ (null);
    /** What of the page the AI may see: the whole page, a marked area, or nothing ("Just answer"). */
    this.access = new PageAccess(this.tabId, { onChange: () => this.renderAccess() });
    this.changes.areaRoots = () => (this.access.mode === 'area' ? this.access.roots : null);
  }

  async start() {
    localize(document);
    const dark = IN_CARD ? matchMedia('(prefers-color-scheme: dark)').matches : chrome.devtools.panels.themeName === 'dark';
    if (dark) document.documentElement.classList.add('dark');
    if (IN_CARD) document.body.dataset.surface = 'card';
    // The DevTools panel takes over from the card on this tab (it minimises itself and says so).
    else bg('card.devtoolsOpened', { tabId: this.tabId }).catch(() => {});

    this.settings = await loadSettings();
    document.body.dataset.connection = this.settings.mode === 'direct' ? 'direct' : 'server';
    this.client = this.settings.mode === 'direct' ? new DirectClient(() => loadSettings()) : new ServerClient(() => loadSettings());
    this.applyContextDefaults();
    onSettingsChanged((s) => {
      if (s.defaultAgentMode !== this.settings.defaultAgentMode) {
        this.settings = s;
        this.renderProviderPicker(); // shows the new default if this conversation hasn't chosen
      }
      // Model lists learned in Options (Check): straight into the model menu.
      if (/** @type {any} */ (this.client)?.config) /** @type {any} */ (this.client).config.modelLists = s.modelLists ?? {};
      // Switching between direct mode and the local server: start the panel over.
      if (s.mode !== this.settings.mode) {
        location.reload();
        return;
      }
      const reconnect = s.mode === 'direct'
        ? s.anthropicApiKey !== this.settings.anthropicApiKey || s.directModel !== this.settings.directModel
          || s.directProvider !== this.settings.directProvider
          || JSON.stringify(s.providerKeys) !== JSON.stringify(this.settings.providerKeys)
          || JSON.stringify(s.providerModels) !== JSON.stringify(this.settings.providerModels)
          || JSON.stringify(s.providerUrls) !== JSON.stringify(this.settings.providerUrls)
        : s.token !== this.settings.token || s.serverUrl !== this.settings.serverUrl;
      this.settings = s;
      this.chat.refreshCards();
      if (reconnect) this.client.reconnect();
    });

    const page = await callInPage(pageInfo);
    this.pageUrl = page.url;
    this.chat.setPageLang(page.lang ?? '');
    $('page-access').addEventListener('change', () => this.access.setMode($('page-access').value).catch((err) => this.showError(err.message)));
    $('area-change').addEventListener('click', () => this.access.edit().catch((err) => this.showError(err.message)));
    // While the area is being marked: Esc cancels, Ctrl+Z / Ctrl+Y undo and redo the shape (the message box keeps its
    // own undo while it has text), Enter outside the message box is Done.
    document.addEventListener('keydown', (e) => {
      if (!this.access.editing) return;
      const k = e.key.toLowerCase();
      const mod = e.ctrlKey || e.metaKey;
      const inPrompt = e.target === $('prompt') && $('prompt').value;
      const cmd = k === 'escape' ? 'cancel'
        : k === 'enter' && e.target !== $('prompt') ? 'done'
          : mod && !inPrompt && !e.shiftKey && k === 'z' ? 'undo'
            : mod && !inPrompt && (k === 'y' || (e.shiftKey && k === 'z')) ? 'redo' : null;
      if (!cmd) return;
      e.preventDefault();
      e.stopPropagation();
      this.access.command(/** @type {any} */ (cmd));
    }, true);
    await this.access.load(page.url).catch(() => {});
    this.renderAccess();
    await this.changes.load(page.timeOrigin);

    // translate_page cards: each batch goes to the conversation's provider; progress shows on the card.
    this.changes.translator = async (/** @type {any[]} */ pieces, /** @type {string} */ language) =>
      (await this.client.request({ type: 'translate.batch', conversationId: this.session?.id, language, pieces }, 180_000)).items ?? [];
    this.changes.onTranslateProgress = (/** @type {number} */ done, /** @type {number} */ total) =>
      this.showBanner(done < total ? t('translatingPart', 'Translating the page… part $1 of $2', done + 1, total) : t('translated', 'Translated.'));
    this.patchesView = $('patches').bind(this);
    this.tasksView = $('tasks').bind(this);
    this.consoleView = $('console').bind(this);
    this.historyView = $('history').bind(this);
    this.memoryView = $('memory').bind(this);
    this.wireUi();
    this.wireDevtoolsEvents();
    this.wireServer();
    this.refreshSelectedChip();
    this.client.connect();
  }

  // ───────────────────────────────────────────────────────── UI wiring

  wireUi() {
    for (const tab of document.querySelectorAll('.tabs button')) {
      tab.addEventListener('click', () => this.showTab(/** @type {HTMLElement} */ (tab).dataset.tab ?? 'chat'));
    }
    // Arrow keys move between tabs (the usual keyboard pattern for a tab list).
    document.querySelector('.tabs')?.addEventListener('keydown', (/** @type {any} */ e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const tabs = /** @type {HTMLElement[]} */ ([...document.querySelectorAll('.tabs button')]);
      const next = tabs[(tabs.indexOf(e.target) + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      this.showTab(next.dataset.tab ?? 'chat');
      next.focus();
    });

    $('composer').addEventListener('submit', (/** @type {Event} */ e) => {
      e.preventDefault();
      if (this.replaying) this.stopTask();
      else if (this.session?.busy) this.client.send({ type: 'chat.cancel', conversationId: this.session.id });
      else this.sendFromUi($('prompt').value);
    });
    // The text box grows with what you type (up to a limit), like other chat apps.
    const fitPrompt = () => {
      const el = $('prompt');
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    };
    $('prompt').addEventListener('input', fitPrompt);
    $('composer').addEventListener('submit', () => setTimeout(fitPrompt));
    $('prompt').addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (!this.session?.busy && !this.replaying) this.sendFromUi($('prompt').value);
      }
    });

    $('new-chat').addEventListener('click', () => this.newConversation());
    $('copy-text').addEventListener('click', () => this.copySelectedText());
    $('server-toggle').addEventListener('click', () => this.toggleServer());
    $('save-markdown').addEventListener('click', () => this.saveMarkdown());
    $('ollama-unload').addEventListener('click', () => this.unloadOllama());
    if (IN_CARD) {
      // Once: point out the full version in DevTools.
      if (!this.settings.cardTipSeen) $('card-tip').hidden = false;
      $('card-tip-ok').addEventListener('click', () => {
        $('card-tip').hidden = true;
        saveSettings({ cardTipSeen: true });
      });
      $('pick-element').addEventListener('click', () => this.startPicking());
      // Esc minimises the card (the page around this frame can't see the key, so tell it).
      addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !document.querySelector('.ask-step')) parent.postMessage({ integratedai: 'minimize' }, '*');
      });
      $('to-devtools').addEventListener('click', () => this.showBanner(
        t('toDevtoolsHelp', 'Press $1 and open the AI tab. This conversation continues there, with every tool: filling in forms, working on the page step by step, element edits, scripts and the network log.',
          /Mac/.test(navigator.platform) ? '⌥⌘I' : t('f12OrCtrl', 'F12 (or Ctrl+Shift+I)')),
      ));
    }
    $('history-button').addEventListener('click', () => this.historyView.toggle());
    $('open-options').addEventListener('click', () => bg('options.open'));
    $('provider-select').addEventListener('change', () => {
      const value = $('provider-select').value;
      // The other connection (local server ⇄ direct): switch to it; the panel reloads (onSettingsChanged).
      if (value === '@server') saveSettings({ mode: 'server' });
      else if (value.startsWith('@direct:')) saveSettings({ mode: 'direct', directProvider: value.slice('@direct:'.length) });
      else this.configure({ provider: value });
    });
    $('agent-mode').addEventListener('change', () => {
      const mode = $('agent-mode').value;
      if (mode !== 'full') { this.hideBanner(); this.configure({ agentMode: mode }); return; }
      $('agent-mode').value = this.agentMode(); // not yet: confirm first
      this.showBanner(t('fullAutoWarning', 'Full auto: the AI clicks, types, submits forms and moves between pages without asking you. Use it for tasks you would trust someone else with, and watch it; ■ stops it.'),
        false, t('turnOnFullAuto', 'Turn on Full auto'), () => {
        this.hideBanner();
        this.configure({ agentMode: 'full' });
      });
    });
    $('model-select').addEventListener('change', () => this.configure({ model: $('model-select').value }));
  }

  /** The Page access menu and the line about the marked area. */
  renderAccess() {
    const { mode, editing, pending, points } = this.access;
    $('page-access').value = mode;
    document.body.dataset.pageAccess = mode;
    $('area-row').hidden = mode !== 'area';
    $('area-label').textContent = editing ? t('areaMarking', 'Mark the area on the page, then click Done there')
      : pending || points.length < 3 ? t('areaConfirm', 'This is another page: confirm the area here before the AI sees anything')
        : t('areaShared', 'The AI sees only the marked area');
    $('area-change').hidden = editing;
    $('area-change').textContent = pending || points.length < 3 ? t('areaMark', 'Mark it') : t('areaChange', 'Change');
  }

  /** @param {string} name */
  showTab(name) {
    for (const tab of document.querySelectorAll('.tabs button')) {
      const active = /** @type {HTMLElement} */ (tab).dataset.tab === name;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
      tab.setAttribute('tabindex', active ? '0' : '-1');
    }
    for (const view of ['chat', 'patches', 'tasks', 'console', 'memory']) $(`view-${view}`).hidden = view !== name;
    if (name === 'memory') this.refreshMemory();
    this.consoleView.setVisible(name === 'console');
    if (name === 'patches') this.patchesView.refresh();
    if (name === 'tasks') this.tasksView.refresh();
    if (name === 'chat') $('prompt').focus();
  }

  applyContextDefaults() {
    $('ctx-selected').checked = this.settings.contextDefaults.selected;
    $('ctx-console').checked = this.settings.contextDefaults.console;
    $('ctx-network').checked = this.settings.contextDefaults.network;
  }

  wireDevtoolsEvents() {
    if (IN_CARD) {
      this.wireCardEvents();
      return;
    }
    chrome.devtools.panels.elements.onSelectionChanged.addListener(() => this.refreshSelectedChip());

    // Reload or navigation: the page is fresh, so nothing we applied is active any more.
    chrome.devtools.network.onNavigated.addListener((url) => {
      this.pageUrl = url;
      this.navigationReset = this.afterNavigation().then(() => this.access.pageChanged(url));
    });
  }

  async afterNavigation() {
    // Wait briefly so pageInfo() reads the NEW document's timeOrigin.
    await new Promise((r) => setTimeout(r, 400));
    let timeOrigin = null;
    try {
      timeOrigin = (await callInPage(pageInfo)).timeOrigin;
    } catch { /* page still loading */ }
    await this.changes.reset(timeOrigin);
    this.chat.refreshCards();
    this.refreshSelectedChip();
    this.patchesView.refresh();
    this.consoleView.refresh(true);
    await this.refreshMemory();
    this.updateWelcome();
  }

  async refreshSelectedChip() {
    try {
      const sel = await callInPage(selectedLabel);
      $('selected-label').textContent = IN_CARD
        ? (sel ? sel.label : t('noElementPicked', 'No element picked'))
        : (sel ? `$0 ${sel.label}` : t('nothingSelected', '$0 (nothing selected)'));
      $('selected-label').title = sel?.selector ?? '';
    } catch {
      $('selected-label').textContent = IN_CARD ? t('noElementPicked', 'No element picked') : '$0';
    }
  }

  /**
   * The card has no DevTools events: it hears from the element picker, and follows the tab's
   * address when an app changes it without loading a new page (a new page reloads the card).
   */
  wireCardEvents() {
    chrome.runtime.onMessage.addListener((msg, sender) => {
      if (msg?.type !== 'card.picked' || sender.tab?.id !== this.tabId) return;
      $('pick-element').classList.remove('active');
      if (msg.picked) $('ctx-selected').checked = true;
      this.refreshSelectedChip();
      $('prompt').focus();
    });
    chrome.tabs.onUpdated.addListener((tabId, change) => {
      if (tabId !== this.tabId) return;
      // Loaded: the new page's language, for "Translate this page into …".
      if (change.status === 'complete') callInPage(pageInfo).then((page) => this.chat.setPageLang(page.lang ?? '')).catch(() => {});
      if (!change.url) return;
      this.pageUrl = change.url;
      this.access.pageChanged(change.url).catch(() => {}); // an app changing its address without a new page
      this.patchesView.refresh();
      this.refreshMemory();
    });
    $('ctx-selected').closest('label').title = t('chipPickedTitle', 'Send a short description of the element you picked');
  }

  /** Pick element (card): the next click on the page chooses the element to ask about. Clicking again cancels. */
  async startPicking() {
    const button = $('pick-element');
    const stop = button.classList.contains('active');
    button.classList.toggle('active', !stop);
    try {
      await callInPage(pickElement, { stop });
    } catch (err) {
      button.classList.remove('active');
      this.showError(`Can't pick on this page: ${/** @type {any} */ (err).message}`);
    }
  }

  // ───────────────────────────────────────────────────────── server

  wireServer() {
    this.client.addEventListener('status', (/** @type {any} */ e) => {
      const { status, error } = e.detail;
      this.connected = status === 'connected';
      $('status-dot').className = `dot ${status}`;
      $('status-dot').title = status;
      if (status === 'connected') {
        this.hideBanner();
        this.openSession();
      } else if (status === 'unauthorized' && this.settings.mode === 'direct') {
        // Nothing set up yet: a first-run screen, not an error.
        this.hideBanner();
        $('session-row').hidden = true;
        this.chat.renderSetup(() => bg('options.open'));
      } else if (status === 'unauthorized') {
        this.showBanner(error, true, t('openSettings', 'Open settings'), () => bg('options.open'));
      } else if (status === 'disconnected') {
        if (this.settings.mode === 'direct') this.showBanner(error, true, t('openSettings', 'Open settings'), () => bg('options.open'));
        // (error is the client's own wording, which says to run npm start: the button does that now.)
        else this.showBanner(t('serverNotRunning', "The local server isn't running."), true, t('startServer', 'Start server'), () => this.toggleServer('start'));
      }
      this.renderServerToggle();
      this.updateComposer();
      this.chat.refreshCards();
    });

    this.client.addEventListener('message', (/** @type {any} */ e) => this.onServerMessage(e.detail));
  }

  async openSession() {
    try {
      const conversationId = await bg('conv.get', { tabId: this.tabId });
      const page = await callInPage(pageInfo).catch(() => ({ url: this.pageUrl, title: '' }));
      const reply = await this.client.request({ type: 'session.open', conversationId, url: page.url, title: page.title });
      await this.setSession(reply.session);
      this.providers = (await this.client.request({ type: 'providers.list' })).providers;
      this.renderProviderPicker();
      this.refreshModelList(this.session?.provider);
    } catch (err) {
      this.showBanner(t('couldNotOpen', 'Could not open the conversation: $1', /** @type {any} */ (err).message), true);
    }
  }

  /** @param {any} session */
  async setSession(session) {
    this.session = session;
    await bg('conv.set', { tabId: this.tabId, conversationId: session.id });
    this.targets = (await bg('kv.get', { key: `targets:${session.id}` })) ?? {};
    this.memoryInfo = null;
    this.chat.renderAll();
    this.renderUsage();
    this.refreshMemory();
    this.renderProviderPicker();
    this.updateComposer();
  }

  async newConversation() {
    if (!this.connected) return;
    const page = await callInPage(pageInfo).catch(() => ({ url: this.pageUrl, title: '' }));
    const reply = await this.client.request({ type: 'session.reset', url: page.url, title: page.title });
    await this.setSession(reply.session);
  }

  /**
   * While the AI works on the page: keep the "working… Stop" badge on the page (again after every
   * page load) and stop the turn when it's clicked.
   */
  watchPageStop() {
    this.unwatchPageStop();
    const tick = async () => {
      try {
        if (await callInPage(takeStopRequest)) {
          if (this.replaying) this.stopTask();
          if (this.session?.busy) this.client.send({ type: 'chat.cancel', conversationId: this.session.id });
          this.chat.cancelAsks();
          return;
        }
        await callInPage(showWorkingBadge);
      } catch { /* the page is loading; try again on the next tick */ }
    };
    tick();
    this.pageStopTimer = setInterval(tick, 700);
  }

  unwatchPageStop() {
    if (this.pageStopTimer === undefined) return;
    clearInterval(this.pageStopTimer);
    this.pageStopTimer = undefined;
    callInPage(hideWorkingBadge).catch(() => {});
  }

  /** How the AI may operate the page in this conversation (its own choice, else the user's default; the card only suggests). */
  agentMode() {
    if (IN_CARD) return 'suggest';
    return this.session?.agentMode ?? this.settings.defaultAgentMode ?? 'suggest';
  }

  /** @param {{ provider?: string, model?: string, memoryMode?: string, agentMode?: string }} change */
  async configure(change) {
    if (!this.session) return;
    try {
      const reply = await this.client.request({ type: 'session.config', conversationId: this.session.id, ...change });
      this.session = reply.session;
      this.renderProviderPicker();
      if (change.memoryMode) {
        this.memoryInfo = null;
        await this.refreshMemory();
        this.updateWelcome();
      }
    } catch (err) {
      this.showError(/** @type {any} */ (err).message);
      this.renderProviderPicker();
    }
  }

  /** @param {any} msg */
  async onServerMessage(msg) {
    const session = this.session;
    if (msg.conversationId && msg.conversationId !== session?.id) return; // another tab's conversation
    switch (msg.type) {
      case 'session.state':
        await this.setSession(msg.session);
        break;
      case 'turn.started':
        this.agent.reset();
        if (this.agentMode() !== 'suggest') this.watchPageStop();
        if (session) session.busy = true;
        this.chat.setBusy(true);
        this.updateComposer();
        this.chat.refreshCards(); // "Check it" waits for the answer
        break;
      case 'chat.delta':
        this.chat.appendDelta(msg.text);
        break;
      case 'chat.message':
        session?.messages.push(msg.message);
        this.chat.appendMessage(msg.message);
        break;
      case 'action.proposed':
        if (session) session.actions[msg.actionId] = { name: msg.name, input: msg.input, status: 'proposed' };
        await this.rememberTarget(msg.actionId, msg.input);
        this.chat.refreshCard(msg.actionId);
        break;
      case 'tool.request':
        await this.handleToolRequest(msg);
        break;
      case 'action.live':
        if (session) session.actions[msg.actionId] = msg.record;
        this.chat.refreshLiveLine(msg.actionId);
        break;
      case 'turn.done':
        this.chat.cancelAsks();
        this.unwatchPageStop();
        this.offerToSaveTask();
        if (session) {
          session.busy = false;
          session.usage = msg.sessionUsage;
        }
        this.chat.setBusy(false);
        this.renderUsage();
        this.updateComposer();
        this.chat.refreshCards();
        break;
      case 'memory.changed':
        await this.refreshMemory();
        break;
      case 'error':
        this.showError(msg.message);
        break;
    }
  }

  /**
   * Run a read-only inspection requested by the model and send the result back.
   * @param {{ requestId: string, name: string, input: any }} msg
   */
  async handleToolRequest({ requestId, name, input }) {
    const reply = (/** @type {object} */ payload) => this.client.send({ type: 'tool.result', requestId, ...payload });
    try {
      const errors = validateAction(name, input);
      if (errors.length) throw new Error(errors.join('; '));
      // The page access the user chose, enforced here too (the agent decides what it offers; this runs it).
      if (this.access.mode === 'none') throw new Error('The user chose "Just answer": the page is not shared');
      if (this.access.mode === 'area' && !AREA_ACTIONS.includes(name)) throw new Error(`${ACTIONS[name]?.label ?? name} is not available while only a marked area is shared`);
      if (isPageAction(name)) {
        // The panel enforces the mode itself: nothing runs here in Suggest mode.
        await this.navigationReset;
        reply({ ok: true, result: await this.agent.run(/** @type {any} */ (name), input, this.agentMode()) });
        return;
      }
      if (ACTIONS[name]?.readOnly !== true) throw new Error('Not an inspection');
      if (IN_CARD && !CARD_ACTIONS.includes(name)) throw new Error(`${ACTIONS[name].label} is only available in DevTools`);
      if (this.settings.askBeforeInspections) {
        const allowed = await this.chat.askPermission(`${ACTIONS[name].label} ${JSON.stringify(input)}`);
        if (!allowed) throw new Error('The user denied this inspection');
      }
      const result = await runInspection(name, input, { selectedSelector: this.lastSentSelector, tabId: this.tabId });
      // Show the user what the AI looked at.
      if (result?.image) this.chat.addScreenshot(String(result.captured ?? ''), `data:${result.image.mediaType};base64,${result.image.data}`);
      reply({ ok: true, result });
    } catch (err) {
      reply({ ok: false, error: String(/** @type {any} */ (err)?.message ?? err) });
    }
  }

  // ───────────────────────────────────────────────────────── sending

  /** @param {string} text */
  async sendFromUi(text, extra = {}) {
    text = text.trim();
    if (!text || !this.session || !this.connected || this.session.busy) return;
    // "Only an area" without a confirmed area on this page: mark it first (the message waits in the box).
    if (this.access.mode === 'area' && !this.access.areaReady) {
      if (!this.access.editing) this.access.edit().catch((err) => this.showError(err.message));
      return;
    }
    $('prompt').value = '';
    $('send').disabled = true;
    try {
      const full = this.access.mode === 'full';
      const { context } = this.access.mode === 'none' ? { context: {} } : await collectContext({
        selected: $('ctx-selected').checked,
        // The console and the network log are about the whole page: only with full access.
        console: full && $('ctx-console').checked,
        network: full && $('ctx-network').checked,
      }, full ? extra : {});
      this.lastSentSelector = /** @type {any} */ (context.selected)?.selector ?? '';
      this.client.send({
        type: 'chat.send',
        conversationId: this.session.id,
        text,
        context: this.access.limitContext(context),
        pageUrl: this.pageUrl,
        settings: {
          executeJs: this.settings.executeJs, webTools: this.settings.webTools, agentMode: this.settings.defaultAgentMode,
          ...(IN_CARD ? { surface: 'card' } : {}),
          ...(this.access.mode !== 'full' ? { pageAccess: this.access.mode } : {}),
        },
      });
    } catch (err) {
      $('prompt').value = text;
      this.showError(`Could not send: ${/** @type {any} */ (err).message}`);
    } finally {
      this.updateComposer();
    }
  }

  // ───────────────────────────────────────────────────────── history & site memory

  /** Conversations on this site (for the History popover and the welcome area). */
  async listConversations() {
    const reply = await this.client.request({ type: 'sessions.list', url: this.pageUrl });
    return { site: reply.site, items: reply.items };
  }

  /**
   * Continue an earlier conversation in this tab.
   * @param {string} conversationId
   */
  async switchConversation(conversationId) {
    const page = await callInPage(pageInfo).catch(() => ({ url: this.pageUrl, title: '' }));
    const reply = await this.client.request({ type: 'session.open', conversationId, url: page.url, title: page.title });
    await this.setSession(reply.session);
    this.showTab('chat');
  }

  /** Load the site memory for the current page and update the Memory tab. */
  async refreshMemory() {
    this.refreshSourceProject();
    if (!this.connected || !this.pageUrl) return;
    try {
      // The memory this conversation uses: the site's shared memory, its private memory, or none.
      const reply = await this.client.request({ type: 'memory.get', url: this.pageUrl, conversationId: this.session?.id });
      this.memoryInfo = reply.memory;
      this.memoryMode = reply.mode ?? 'shared';
    } catch {
      this.memoryInfo = null;
    }
    const count = this.memoryInfo ? this.memoryInfo.notes.filter((/** @type {any} */ n) => n.appliesHere).length : 0;
    $('memory-count').hidden = count === 0;
    $('memory-count').textContent = String(count);
    this.memoryView.render();
  }

  /** Is there a project folder for this page (config.json "projects")? */
  async refreshSourceProject() {
    try {
      const reply = await this.client.request({ type: 'source.project', url: this.pageUrl });
      this.sourceProject = reply.project;
    } catch {
      this.sourceProject = null;
    }
    this.chat.refreshCards();
  }

  /**
   * Edit site memory from the Memory tab.
   * @param {Record<string, unknown>} change
   */
  async editMemory(change) {
    const reply = await this.client.request({ type: 'memory.edit', url: this.pageUrl, conversationId: this.session?.id, ...change });
    this.memoryInfo = reply.memory;
    await this.refreshMemory();
  }

  /**
   * For an empty conversation: offer to continue the latest conversation on this
   * site, and say what the AI already remembers here.
   */
  async updateWelcome() {
    if (!this.connected || !this.session) return;
    if (this.session.messages.some((m) => m.role === 'user')) return;
    let items = [];
    try {
      items = (await this.listConversations()).items.filter((/** @type {any} */ i) => i.id !== this.session?.id);
    } catch { /* offline */ }
    if (!this.memoryInfo) await this.refreshMemory();
    const last = items[0]; // same kind of page first, then newest
    const remembered = this.memoryInfo ? this.memoryInfo.notes.filter((/** @type {any} */ n) => n.appliesHere).length : 0;
    const groupName = this.memoryInfo?.group.name;
    const mode = this.memoryMode ?? 'shared';
    this.chat.setWelcome([
      last ? h('div', { class: 'continue' },
        h('button', { type: 'button', class: 'primary', onclick: () => this.switchConversation(last.id) }, 'Continue'),
        ` "${last.title}" · ${relativeTime(last.updatedAt)}${last.sameGroup ? '' : ' (another page on this site)'} `,
        items.length > 1 ? h('button', { type: 'button', class: 'link', onclick: () => this.historyView.toggle() }, `all ${items.length}`) : null) : null,
      remembered ? h('div', { class: 'meta' },
        `${remembered} saved note${remembered === 1 ? '' : 's'} about ${this.memoryInfo.site}${groupName ? ` and "${groupName}" pages` : ''}. `,
        h('button', { type: 'button', class: 'link', onclick: () => this.showTab('memory') }, 'See memory')) : null,
      // Separate conversations with separate memories.
      mode === 'shared'
        ? h('div', { class: 'meta' },
          h('button', { type: 'button', class: 'link', onclick: () => this.configure({ memoryMode: 'private' }) }, 'Use private memory'),
          ' for this conversation (its own notes, separate from the site\'s shared memory), or ',
          h('button', { type: 'button', class: 'link', onclick: () => this.configure({ memoryMode: 'off' }) }, 'no memory'), '.')
        : h('div', { class: 'meta' },
          mode === 'private' ? 'This conversation has its own private memory. ' : 'Memory is off for this conversation. ',
          h('button', { type: 'button', class: 'link', onclick: () => this.configure({ memoryMode: 'shared' }) }, 'Use the site\'s shared memory')),
    ]);
  }

  /**
   * Copy the text of the selected element ($0) to the clipboard. Done by the
   * extension itself (like selecting the text and pressing Ctrl+C), not the AI.
   */
  async copySelectedText() {
    const button = $('copy-text');
    try {
      const text = await callInPage(selectedText);
      if (text === null) throw new Error(IN_CARD ? 'Pick an element on the page first.' : 'Select an element in the Elements panel first.');
      await copyToClipboard(text);
      button.textContent = t('copiedChars', 'Copied $1 characters', text.length.toLocaleString());
    } catch (err) {
      button.textContent = t('copyFailed', 'Copy failed');
      this.showError(String(/** @type {any} */ (err)?.message ?? err));
    }
    setTimeout(() => { button.textContent = t('copyText', 'Copy text'); }, 2000);
  }

  /** "Explain" button in the Console tab. @param {any} entry */
  explainError(entry) {
    this.showTab('chat');
    const { level, message, stack, source, count } = entry;
    this.sendFromUi('Explain this console error and suggest a fix.', {
      consoleError: { level, message, stack, source, count },
    });
  }

  // ───────────────────────────────────────────────────────── actions (called by cards)

  /**
   * Remember which element an action targets. modify_element / execute_js without
   * a selector target the element that was selected when the message was sent.
   * @param {string} actionId
   * @param {any} input
   */
  async rememberTarget(actionId, input) {
    const target = input?.selector || this.lastSentSelector;
    if (!target || this.targets[actionId]) return;
    this.targets[actionId] = target;
    if (this.session) await bg('kv.set', { key: `targets:${this.session.id}`, value: this.targets });
  }

  /**
   * @param {string} actionId
   * @param {any} input
   */
  targetFor(actionId, input) {
    return input?.selector || this.targets[actionId] || '';
  }

  /** The action with its selector resolved, after re-validating it. @param {string} actionId */
  prepare(actionId) {
    const record = this.session?.actions[actionId] ?? this.findToolCall(actionId);
    if (!record) throw new Error('Unknown action');
    const errors = validateAction(record.name, record.input, { executeJs: this.settings.executeJs });
    if (errors.length) throw new Error(`Refusing to run: ${errors.join('; ')}`);
    const input = { ...record.input };
    if (record.name === 'modify_element' && !input.selector) input.selector = this.targets[actionId] || undefined;
    return { name: record.name, input };
  }

  /** @param {string} actionId */
  findToolCall(actionId) {
    for (const m of this.session?.messages ?? []) {
      for (const b of m.content) if (b.type === 'tool_call' && b.id === actionId) return { name: b.name, input: b.input };
    }
    return null;
  }

  /** @param {string} actionId */
  async previewAction(actionId) {
    await this.navigationReset;
    const { name, input } = this.prepare(actionId);
    await this.changes.preview(actionId, name, input);
  }

  /** @param {string} actionId */
  async stopPreview(actionId) {
    await this.changes.stopPreview(actionId);
  }

  /** @param {string} actionId */
  async applyAction(actionId) {
    await this.navigationReset;
    const { name, input } = this.prepare(actionId);
    try {
      const detail = await this.changes.apply(actionId, name, input);
      this.reportStatus(actionId, 'applied', detail);
    } catch (err) {
      this.reportStatus(actionId, 'failed', String(/** @type {any} */ (err)?.message ?? err));
      throw err;
    }
  }

  /** @param {string} actionId */
  async rejectAction(actionId) {
    await this.changes.stopPreview(actionId);
    this.reportStatus(actionId, 'rejected');
  }

  /** @param {string} actionId */
  async undoAction(actionId) {
    await this.changes.undo(actionId);
    this.reportStatus(actionId, 'undone');
  }

  /**
   * Save an applied inject_css as a persistent patch for this site.
   * @param {string} actionId
   * @param {{ name: string, scope: import('../shared/url-scope.js').Scope }} options
   */
  async saveAsPatch(actionId, { name, scope }) {
    const { input } = this.prepare(actionId);
    await bg('patches.add', {
      // css: as the AI wrote it (shown, editable); injectedCss: what is inserted (selectors boosted to win ties).
      patch: {
        name, css: input.css, injectedCss: boostCss(input.css), scope, enabled: true, sourceUrl: this.pageUrl,
        ...(input.toggle ? { toggle: input.toggle } : {}), ...(input.frame ? { frame: input.frame } : {}),
      },
    });
    // The CSS is already in the page; from now on the patch owns it (toggle/delete in Patches).
    await this.changes.forget(actionId);
    this.reportStatus(actionId, 'saved', `Saved as patch "${name}"`);
    this.patchesView.refresh();
  }

  // ───────────────────────────────────────────────────────── apply to source

  /**
   * Ask Claude Code (read-only, in the project folder) for edits that put an applied CSS change into the source.
   * @param {string} actionId
   */
  async proposeSource(actionId) {
    if (!this.session) throw new Error('No conversation');
    const reply = await this.client.request({ type: 'source.propose', conversationId: this.session.id, actionId }, 6 * 60_000);
    const record = this.session.actions[actionId];
    if (record) record.source = { proposalId: reply.proposal.id, status: 'proposed', files: reply.proposal.previews.map((/** @type {any} */ p) => p.file) };
    return reply.proposal;
  }

  /**
   * Write the proposed edits to the files, or undo them.
   * @param {string} actionId
   * @param {'write' | 'undo'} op
   */
  async writeSource(actionId, op) {
    if (!this.session) throw new Error('No conversation');
    const reply = await this.client.request({ type: `source.${op}`, conversationId: this.session.id, actionId });
    const record = this.session.actions[actionId];
    if (record) record.source = reply.source;
    return reply;
  }

  /**
   * Tell the server what happened, so the model learns about it in the next message.
   * @param {string} actionId
   * @param {string} status
   * @param {string} [detail]
   */
  reportStatus(actionId, status, detail) {
    const record = this.session?.actions[actionId];
    if (record) {
      record.status = /** @type {any} */ (status);
      record.detail = detail;
    }
    try {
      this.client.send({ type: 'action.status', conversationId: this.session?.id, actionId, status, detail });
    } catch { /* offline: the card still shows the local state */ }
    this.chat.refreshCard(actionId);
  }

  /**
   * Outline an element on the page for a moment.
   * @param {string} [selector]
   * @param {string} [ref] an element ref from the AI (find_elements, page_outline)
   * @param {string} [frame] the iframe (URL) it is in
   */
  highlight(selector, ref, frame) {
    callInPage(highlight, { selector, ref }, frame).catch(() => {});
  }

  /** @param {string} selector */
  selectInElements(selector) {
    // The card has no Elements panel: outline it on the page instead.
    if (IN_CARD) this.highlight(selector);
    else selectInElementsPanel(selector).catch(() => {});
  }

  // ───────────────────────────────────────────────────────── small UI bits

  /** @param {string} text */
  showError(text) {
    this.chat.showError(text);
  }

  /**
   * @param {string} text
   * @param {boolean} [isError]
   * @param {string} [actionLabel]
   * @param {() => void} [action]
   */
  showBanner(text, isError = false, actionLabel, action) {
    $('banner').hidden = false;
    $('banner').classList.toggle('error', isError);
    $('banner-text').textContent = text;
    const btn = $('banner-action');
    btn.hidden = !actionLabel;
    btn.textContent = actionLabel ?? '';
    btn.onclick = action ?? null;
  }

  hideBanner() {
    $('banner').hidden = true;
  }

  updateComposer() {
    const busy = Boolean(this.session?.busy || this.replaying);
    // Like other chat apps: an arrow to send, a square to stop (both icons are in panel.html).
    $('send').classList.toggle('busy', busy);
    $('send').title = busy ? t('stop', 'Stop') : t('sendEnter', 'Send (Enter)');
    $('send').setAttribute('aria-label', busy ? t('stop', 'Stop') : t('send', 'Send'));
    $('send').disabled = !this.connected || !this.session;
    $('new-chat').disabled = !this.connected || busy;
    $('provider-select').disabled = busy;
    $('model-select').disabled = busy;
    $('agent-mode').disabled = busy;
    $('page-access').disabled = busy;
  }

  renderProviderPicker() {
    const providerSelect = $('provider-select');
    const modelSelect = $('model-select');
    providerSelect.replaceChildren(...this.providers.map((p) => {
      // Providers that aren't set up stay visible (so people know they exist) but say what's missing.
      const option = new Option(p.available ? p.label : t('notSetUp', '$1 (not set up)', p.label), p.id);
      option.disabled = !p.available;
      option.title = p.reason ?? '';
      return option;
    }), ...this.otherConnection());
    const current = this.providers.find((p) => p.id === this.session?.provider);
    providerSelect.value = this.session?.provider ?? '';
    document.body.dataset.provider = this.session?.provider ?? '';
    this.watchOllama(this.session?.provider === 'ollama');
    // The conversation's model may be one typed in Options (e.g. "qwen3:latest"), not a suggestion.
    const models = [...(current?.models ?? [])];
    if (this.session?.model && !models.includes(this.session.model)) models.unshift(this.session.model);
    modelSelect.replaceChildren(...models.map((m) => new Option(m, m)));
    modelSelect.value = this.session?.model ?? '';
    $('session-row').hidden = !this.providers.length;
    $('agent-mode').value = this.agentMode();
    document.body.dataset.agentMode = this.agentMode();

    if (current && !current.available) {
      const other = this.providers.find((p) => p.available);
      this.showBanner(t('providerNotSetUp', "$1 isn't set up: $2", current.label, current.reason) + (other ? ` ${t('orPickOther', 'Or pick "$1" in the provider menu.', other.label)}` : ''), true);
    }
  }

  /**
   * The other way to connect, at the end of the provider menu: from direct mode the local server
   * (Claude Code), from the server the direct providers that are set up. Choosing one switches the
   * connection; each keeps its own conversations.
   * @returns {HTMLOptGroupElement[]}
   */
  otherConnection() {
    const group = document.createElement('optgroup');
    group.label = t('switchConnection', 'Switch connection');
    const s = this.settings;
    if (s.mode === 'direct') {
      const option = new Option(s.token ? t('claudeCodeServer', 'Claude Code (local server)') : t('claudeCodeServerNotSetUp', 'Claude Code (local server, not set up)'), '@server');
      option.disabled = !s.token;
      option.title = s.token ? t('claudeCodeServerTitle', 'Use your Claude subscription through the local server') : t('setUpInOptions', 'Set it up in Options');
      group.append(option);
    } else {
      // Claude with an API key, then every preset that is set up (a key; Ollama: a chosen model).
      if (s.anthropicApiKey) group.append(new Option('Claude (API key)', '@direct:anthropic'));
      for (const [id, preset] of Object.entries(PRESETS)) {
        if (preset.local ? s.providerModels?.[id] : s.providerKeys?.[id]) group.append(new Option(preset.label, `@direct:${id}`));
      }
    }
    return group.children.length ? [group] : [];
  }

  renderUsage() {
    const usage = this.session?.usage;
    const el = $('cost');
    if (!usage || (!usage.inputTokens && !usage.outputTokens)) {
      el.textContent = '';
      return;
    }
    const tokens = usage.inputTokens + usage.outputTokens;
    const tokenText = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k tok` : `${tokens} tok`;
    el.textContent = usage.costUsd === null ? tokenText : `$${usage.costUsd.toFixed(usage.costUsd < 0.1 ? 4 : 2)} · ${tokenText}`;
    el.title = this.session?.provider === 'claude-cli'
      ? t('costClaudeCode', 'Estimated cost reported by Claude Code. With a subscription this is usage against your plan, not a separate bill.')
      : t('costApi', 'Estimated API cost of this conversation');
  }

  // ───────────────────────────────────────────────────────── saved tasks

  /**
   * After an agent turn that did things on the page: offer to save those steps as a task,
   * to run again later without the AI.
   */
  offerToSaveTask() {
    const steps = this.agent.recorded;
    if (!steps.length || this.agentMode() === 'suggest') return;
    const startUrl = this.agent.startUrl || this.pageUrl;
    // The user's request is a good default name ("Sign me up for screen printing").
    const lastAsk = this.session?.messages.findLast((m) => m.role === 'user' && m.content.some((b) => b.type === 'text'));
    const text = /** @type {any} */ (lastAsk?.content.find((b) => b.type === 'text'))?.text ?? '';
    this.chat.offerSaveTask(steps.length, text.split('\n')[0].slice(0, 80), async (name) => {
      await saveTask({ name, startUrl, steps: structuredClone(steps) });
      await this.tasksView.refresh();
    });
  }

  /**
   * Run a saved task: its steps, without the AI, asking before risky ones (as in Auto mode).
   * @param {import('./lib/tasks.js').Task} task
   */
  async runTask(task) {
    if (this.replaying || this.session?.busy) return;
    this.replaying = true;
    this.showTab('chat');
    this.chat.askSubject = 'task';
    this.chat.setBusy(true);
    this.updateComposer();
    this.tasksView.refresh();
    this.watchPageStop();
    const header = this.chat.activity(t('taskRunning', 'Running the saved task "$1"', task.name));
    try {
      const done = await this.agent.replay(task);
      header.done(done.length === 1 ? t('taskRanOne', 'Ran the saved task "$1" (1 step)', task.name) : t('taskRan', 'Ran the saved task "$1" ($2 steps)', task.name, done.length));
      await updateTask(task.id, { lastRun: Date.now() });
    } catch (err) {
      header.done(t('taskStopped', 'The saved task "$1" stopped: $2', task.name, /** @type {any} */ (err).message), false);
    } finally {
      this.replaying = false;
      this.chat.askSubject = 'ai';
      this.unwatchPageStop();
      this.chat.cancelAsks();
      this.chat.setBusy(false);
      this.updateComposer();
      this.tasksView.refresh();
    }
  }

  /** Stop a running task (Stop in the panel or on the page). */
  stopTask() {
    this.agent.abort();
    this.chat.cancelAsks();
  }

  // ───────────────────────────────────────────────────────── the local server

  /** The Server button shows whether the local server is running (= connected to it). */
  renderServerToggle() {
    const on = Boolean(this.connected);
    $('server-toggle').setAttribute('aria-pressed', String(on));
    $('server-toggle').title = on ? t('serverRunningTitle', 'The local server is running. Click to stop it') : t('startServerTitle', 'Start the local server');
    $('server-toggle').setAttribute('aria-label', on ? t('stopServerTitle', 'Stop the local server') : t('startServerTitle', 'Start the local server'));
  }

  /**
   * Start or stop the local agent server (no `npm start` needed): through the helper program that
   * `npm run services:install` registers once. The first click asks for the permission to talk to it.
   * @param {'start' | 'stop'} [want]
   */
  async toggleServer(want = this.connected ? 'stop' : 'start') {
    const button = $('server-toggle');
    if (!(await chrome.permissions.contains({ permissions: ['nativeMessaging'] }))) {
      const granted = await chrome.permissions.request({ permissions: ['nativeMessaging'] }).catch(() => false);
      if (!granted) {
        this.showBanner(t('serverPermission', 'To start the server from here, IntegratedAI needs your OK to talk to its helper program on this computer. Click Server again and allow it, or allow it in the settings.'),
          true, t('openSettings', 'Open settings'), () => bg('options.open'));
        return;
      }
    }
    button.classList.add('working');
    this.showBanner(want === 'start' ? t('serverStarting', 'Starting the local server…') : t('serverStopping', 'Stopping the local server…'));
    try {
      /** @type {any} */
      const reply = await bg('services.call', { action: want });
      if (reply.needsPermission) {
        this.showBanner(t('serverAllowFirst', 'Allow IntegratedAI to talk to its helper program first (click Server again).'), true);
      } else if (reply.notInstalled) {
        this.showBanner(t('serverSetup', 'One-time setup: in the IntegratedAI folder, run  $1  then click Server again.', reply.installCommand), true,
          t('copyCommand', 'Copy command'), () => copyToClipboard(reply.installCommand).then(() => this.showBanner(t('serverSetupCopied', 'Copied. Run it in a terminal in the IntegratedAI folder, then click Server again.'))));
      } else if (reply.error) {
        this.showBanner(reply.error, true);
      } else if (want === 'start') {
        this.hideBanner();
        this.client.reconnect();
      } else {
        this.showBanner(t('serverStopped', 'The local server is stopped. Click Server to start it again.'));
      }
    } catch (err) {
      this.showBanner(String(/** @type {any} */ (err)?.message ?? err), true);
    } finally {
      button.classList.remove('working');
      this.renderServerToggle();
    }
  }

  /**
   * Direct mode: ask the provider which models it has (at most once a day per provider), so new models
   * show up in the model menu without an update of the extension. Quietly does nothing on any problem.
   * @param {string | undefined} id
   */
  async refreshModelList(id) {
    const preset = id ? PRESETS[id] : undefined;
    if (this.settings.mode !== 'direct' || !preset || !this.providers.find((p) => p.id === id)?.available) return;
    const DAY = 24 * 60 * 60 * 1000;
    if (Date.now() - (this.settings.modelLists?.[id]?.at ?? 0) < DAY) return;
    try {
      const key = this.settings.providerKeys?.[id];
      const res = await fetch(`${baseUrlFor(id, { baseUrl: this.settings.providerUrls?.[id] ?? '' })}/models`, {
        headers: { ...(preset.local || !key ? {} : { authorization: `Bearer ${key}` }), ...preset.headers },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return;
      const ids = ((await res.json()).data ?? []).map((/** @type {any} */ m) => String(m.id).replace(/^models\//, '')).sort();
      if (!ids.length) return;
      this.settings.modelLists = { ...this.settings.modelLists, [id]: { ids, at: Date.now() } };
      await saveSettings({ modelLists: this.settings.modelLists });
      if (/** @type {any} */ (this.client).config) /** @type {any} */ (this.client).config.modelLists = this.settings.modelLists;
      this.providers = (await this.client.request({ type: 'providers.list' })).providers;
      this.renderProviderPicker();
    } catch { /* offline, or no model list here: the suggestions stay */ }
  }

  /** The local Ollama's address without "/v1" (its own API). */
  ollamaRoot() {
    return baseUrlFor('ollama', { baseUrl: this.settings.providerUrls?.ollama ?? '' }).replace(/\/v1\/?$/, '');
  }

  /**
   * While Ollama is the provider: check it's running (now, then every 10 s while the panel is visible),
   * so a stopped Ollama shows up before a message fails. The dot turns red and a banner says how to start it.
   * @param {boolean} on
   */
  watchOllama(on) {
    clearInterval(this.ollamaTimer);
    this.ollamaTimer = undefined;
    if (!on) {
      if (this.ollamaDown) this.setOllamaDown(false);
      return;
    }
    this.checkOllama();
    this.ollamaTimer = setInterval(() => { if (document.visibilityState === 'visible') this.checkOllama(); }, 10_000);
  }

  async checkOllama() {
    let up = false;
    try {
      up = (await fetch(`${this.ollamaRoot()}/api/version`, { signal: AbortSignal.timeout(3000) })).ok;
    } catch { /* not running (or not reachable) */ }
    // Running and known to be: nothing to do. Not running: (re)show it, in case a reconnect hid the banner.
    if (up && !this.ollamaDown) return;
    this.setOllamaDown(!up);
  }

  /** @param {boolean} down */
  setOllamaDown(down) {
    this.ollamaDown = down;
    $('status-dot').className = `dot ${down ? 'disconnected' : this.connected ? 'connected' : 'disconnected'}`;
    $('status-dot').title = down ? t('ollamaNotRunningShort', "Ollama isn't running") : (this.connected ? t('connected', 'connected') : t('disconnected', 'disconnected'));
    if (down) {
      const start = /Mac/.test(navigator.platform) ? t('ollamaStartMac', 'open it from Applications')
        : /Win/.test(navigator.platform) ? t('ollamaStartWin', 'start it from the Start menu') : t('ollamaStartLinux', 'start it (ollama serve)');
      this.showBanner(t('ollamaNotRunning', "Ollama isn't running: $1, then send your message.", start), true, t('checkAgain', 'Check again'), () => this.checkOllama());
    } else {
      this.hideBanner();
    }
  }

  /**
   * Ollama keeps the model in memory (graphics card, fans) for 5 minutes after the last message. This
   * unloads it now; the next message loads it again. Quitting Ollama itself is done from its own icon.
   */
  async unloadOllama() {
    const model = this.session?.model;
    if (!model) return;
    const root = this.ollamaRoot();
    try {
      const res = await fetch(`${root}/api/generate`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, keep_alive: 0 }),
      });
      if (!res.ok) throw new Error(`Ollama answered ${res.status}`);
      this.showBanner(t('unloaded', 'Unloaded $1: your graphics card is free. Your next message loads it again (a few seconds). To quit Ollama completely, use its own icon (by the clock, or in the menu bar).', model));
    } catch (err) {
      // Nothing answers: Ollama isn't running, so no model is loaded (a TypeError is fetch's "can't connect").
      if (err instanceof TypeError) this.showBanner(t('unloadNotRunning', "Ollama isn't running, so no model is loaded: your graphics card is already free. Start Ollama again before your next message."));
      else this.showBanner(t('unloadFailed', "Couldn't unload the model: $1", /** @type {any} */ (err).message), true);
    }
  }

  /** Save the conversation as a Markdown file (to read or share; no page data beyond what's in the chat). */
  saveMarkdown() {
    if (!this.session?.messages.length) {
      this.showBanner(t('nothingToSave', 'Nothing to save yet: this conversation is empty.'));
      return;
    }
    const text = conversationToMarkdown(/** @type {any} */ (this.session));
    let site = 'page';
    try { site = new URL(this.session.url ?? this.pageUrl).hostname.replace(/^www\./, ''); } catch { /* keep "page" */ }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
    a.download = `integratedai-${site}-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  }

  /** @param {number} n */
  setTaskCount(n) {
    $('task-count').hidden = n === 0;
    $('task-count').textContent = String(n);
  }

  /** @param {number} n */
  setPatchCount(n) {
    $('patch-count').hidden = n === 0;
    $('patch-count').textContent = String(n);
  }

  /** @param {number} n */
  setErrorCount(n) {
    $('error-count').hidden = n === 0;
    $('error-count').textContent = String(n);
  }
}

/**
 * Write text to the clipboard. DevTools panels may block the async Clipboard API,
 * so fall back to a hidden textarea and execCommand.
 * @param {string} text
 */
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch { /* fall back below */ }
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  if (!ok) throw new Error('The browser did not allow copying.');
}

// Exposed for debugging from the panel's own DevTools (right-click the panel → Inspect).
const app = new App();
/** @type {any} */ (window).app = app;
app.start().catch((err) => {
  console.error(err);
  app.showBanner(t('panelFailed', 'The AI panel failed to start: $1', err.message), true);
});

