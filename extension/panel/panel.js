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
 */

import { ACTIONS, validateAction } from '../shared/actions.js';
import './components/action-card.js';
import './components/chat-view.js';
import './components/console-view.js';
import './components/history-view.js';
import './components/memory-view.js';
import { relativeTime } from './components/history-view.js';
import './components/patches-view.js';
import { bg } from './lib/bg.js';
import { h } from './lib/dom.js';
import { ChangeManager } from './lib/changes.js';
import { collectContext } from './lib/context.js';
import { callInPage, selectInElementsPanel } from './lib/inspected.js';
import { runInspection } from './lib/inspections.js';
import { highlight, pageInfo, selectedLabel, selectedText } from './lib/page-scripts.js';
import { loadSettings, onSettingsChanged } from './lib/settings.js';
import { ServerClient } from './lib/ws-client.js';
import { DirectClient } from './direct/direct-client.js';
import { boostCss } from '../shared/css-boost.js';

const $ = (/** @type {string} */ id) => /** @type {any} */ (document.getElementById(id));

export class App {
  constructor() {
    this.tabId = chrome.devtools.inspectedWindow.tabId;
    /** @type {import('./lib/settings.js').Settings} */
    this.settings = /** @type {any} */ (null);
    /** @type {import('../shared/protocol.js').SessionSnapshot | null} */
    this.session = null;
    /** @type {import('../shared/protocol.js').ProviderInfo[]} */
    this.providers = [];
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
    /** Site memory for the current page (from the server), or null. @type {any} */
    this.memoryInfo = null;
    /** Your project folder for this page ("Apply to source"), or null. @type {{ name: string, path: string } | null} */
    this.sourceProject = null;

    this.chat = $('chat').bind(this);
    this.patchesView = /** @type {any} */ (null);
    this.consoleView = /** @type {any} */ (null);
  }

  async start() {
    if (chrome.devtools.panels.themeName === 'dark') document.documentElement.classList.add('dark');

    this.settings = await loadSettings();
    this.client = this.settings.mode === 'direct' ? new DirectClient(() => loadSettings()) : new ServerClient(() => loadSettings());
    this.applyContextDefaults();
    onSettingsChanged((s) => {
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
    await this.changes.load(page.timeOrigin);

    this.patchesView = $('patches').bind(this);
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

    $('composer').addEventListener('submit', (/** @type {Event} */ e) => {
      e.preventDefault();
      if (this.session?.busy) this.client.send({ type: 'chat.cancel', conversationId: this.session.id });
      else this.sendFromUi($('prompt').value);
    });
    $('prompt').addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (!this.session?.busy) this.sendFromUi($('prompt').value);
      }
    });

    $('new-chat').addEventListener('click', () => this.newConversation());
    $('copy-text').addEventListener('click', () => this.copySelectedText());
    $('history-button').addEventListener('click', () => this.historyView.toggle());
    $('open-options').addEventListener('click', () => bg('options.open'));
    $('provider-select').addEventListener('change', () => this.configure({ provider: $('provider-select').value }));
    $('model-select').addEventListener('change', () => this.configure({ model: $('model-select').value }));
  }

  /** @param {string} name */
  showTab(name) {
    for (const tab of document.querySelectorAll('.tabs button')) {
      tab.classList.toggle('active', /** @type {HTMLElement} */ (tab).dataset.tab === name);
    }
    for (const view of ['chat', 'patches', 'console', 'memory']) $(`view-${view}`).hidden = view !== name;
    if (name === 'memory') this.refreshMemory();
    this.consoleView.setVisible(name === 'console');
    if (name === 'patches') this.patchesView.refresh();
    if (name === 'chat') $('prompt').focus();
  }

  applyContextDefaults() {
    $('ctx-selected').checked = this.settings.contextDefaults.selected;
    $('ctx-console').checked = this.settings.contextDefaults.console;
    $('ctx-network').checked = this.settings.contextDefaults.network;
  }

  wireDevtoolsEvents() {
    chrome.devtools.panels.elements.onSelectionChanged.addListener(() => this.refreshSelectedChip());

    // Reload or navigation: the page is fresh, so nothing we applied is active any more.
    chrome.devtools.network.onNavigated.addListener((url) => {
      this.pageUrl = url;
      this.navigationReset = this.afterNavigation();
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
      $('selected-label').textContent = sel ? `$0 ${sel.label}` : '$0 (nothing selected)';
      $('selected-label').title = sel?.selector ?? '';
    } catch {
      $('selected-label').textContent = '$0';
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
      } else if (status === 'unauthorized') {
        this.showBanner(error, true, 'Open settings', () => bg('options.open'));
      } else if (status === 'disconnected') {
        this.showBanner(this.settings.mode === 'direct' ? error : `Agent server disconnected: ${error} Retrying…`, true,
          this.settings.mode === 'direct' ? 'Open settings' : undefined, () => bg('options.open'));
      }
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
    } catch (err) {
      this.showBanner(`Could not open the conversation: ${/** @type {any} */ (err).message}`, true);
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

  /** @param {{ provider?: string, model?: string, memoryMode?: string }} change */
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
      case 'turn.done':
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
      if (errors.length || ACTIONS[name]?.readOnly !== true) throw new Error(errors.join('; ') || 'Not an inspection');
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
    $('prompt').value = '';
    $('send').disabled = true;
    try {
      const { context } = await collectContext({
        selected: $('ctx-selected').checked,
        console: $('ctx-console').checked,
        network: $('ctx-network').checked,
      }, extra);
      this.lastSentSelector = /** @type {any} */ (context.selected)?.selector ?? '';
      this.client.send({
        type: 'chat.send',
        conversationId: this.session.id,
        text,
        context,
        settings: { executeJs: this.settings.executeJs, webTools: this.settings.webTools },
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
        `🧠 I remember ${remembered} thing${remembered === 1 ? '' : 's'} about ${this.memoryInfo.site}${groupName ? ` and "${groupName}" pages` : ''}. `,
        h('button', { type: 'button', class: 'link', onclick: () => this.showTab('memory') }, 'See memory')) : null,
      // Separate conversations with separate memories.
      mode === 'shared'
        ? h('div', { class: 'meta' },
          h('button', { type: 'button', class: 'link', onclick: () => this.configure({ memoryMode: 'private' }) }, 'Use private memory'),
          ' for this conversation (its own notes, separate from the site\'s shared memory), or ',
          h('button', { type: 'button', class: 'link', onclick: () => this.configure({ memoryMode: 'off' }) }, 'no memory'), '.')
        : h('div', { class: 'meta' },
          mode === 'private' ? '🔒 This conversation has its own private memory. ' : '🚫 Memory is off for this conversation. ',
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
      if (text === null) throw new Error('Select an element in the Elements panel first.');
      await copyToClipboard(text);
      button.textContent = `Copied ${text.length.toLocaleString()} characters`;
    } catch (err) {
      button.textContent = 'Copy failed';
      this.showError(String(/** @type {any} */ (err)?.message ?? err));
    }
    setTimeout(() => { button.textContent = 'Copy text'; }, 2000);
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
      patch: { name, css: input.css, injectedCss: boostCss(input.css), scope, enabled: true, sourceUrl: this.pageUrl, ...(input.toggle ? { toggle: input.toggle } : {}) },
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

  /** @param {string} selector */
  highlight(selector) {
    callInPage(highlight, { selector }).catch(() => {});
  }

  /** @param {string} selector */
  selectInElements(selector) {
    selectInElementsPanel(selector).catch(() => {});
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
    const busy = Boolean(this.session?.busy);
    $('send').textContent = busy ? 'Stop' : 'Send';
    $('send').disabled = !this.connected || !this.session;
    $('new-chat').disabled = !this.connected || busy;
    $('provider-select').disabled = busy;
    $('model-select').disabled = busy;
  }

  renderProviderPicker() {
    const providerSelect = $('provider-select');
    const modelSelect = $('model-select');
    providerSelect.replaceChildren(...this.providers.map((p) => {
      // Providers that aren't set up stay visible (so people know they exist) but say what's missing.
      const option = new Option(p.available ? p.label : `${p.label} (not set up)`, p.id);
      option.disabled = !p.available;
      option.title = p.reason ?? '';
      return option;
    }));
    const current = this.providers.find((p) => p.id === this.session?.provider);
    providerSelect.value = this.session?.provider ?? '';
    modelSelect.replaceChildren(...(current?.models ?? []).map((m) => new Option(m, m)));
    modelSelect.value = this.session?.model ?? '';

    if (current && !current.available) {
      const other = this.providers.find((p) => p.available);
      this.showBanner(`${current.label} isn't set up: ${current.reason}${other ? ` Or pick "${other.label}" in the provider menu.` : ''}`, true);
    }
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
      ? 'Estimated cost reported by Claude Code. With a subscription this is usage against your plan, not a separate bill.'
      : 'Estimated API cost of this conversation';
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
  app.showBanner(`The AI panel failed to start: ${err.message}`, true);
});

