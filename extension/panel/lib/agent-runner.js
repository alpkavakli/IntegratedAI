// @ts-check
/**
 * Runs page actions (interact, navigate) during a turn, in the agent modes.
 *
 * Each step: find and outline the target on the page (so the user can follow),
 * ask the user first if the mode says so, pause briefly, do it, and wait until the
 * page has settled (a page load or route change finished, no more elements coming in).
 * The result (what was done, and an outline of the page afterwards: what's on screen,
 * with refs to target it) goes back to the model, which decides the next step.
 *
 *   ask  → ask before every step ("Allow all for this task" stops asking, except for risky steps)
 *   auto → ask only before risky steps (submitting, sending, paying, deleting, passwords, another site)
 *   full → never ask
 *
 * The panel checks the mode itself (not the agent): in Suggest mode nothing runs here.
 */

import { callInPage, evalInPage } from './inspected.js';
import { clearHighlight, interactStep, quietFor } from './page-interact.js';
import { pageOutline } from './page-scripts.js';

const STEP_TIMEOUT_MS = 5000;
const WAIT_MAX_MS = 10_000;
const POLL_MS = 250;
/** Long enough for a person to see the outlined target before it is clicked. */
const FOLLOW_PAUSE_MS = 450;
const LOAD_TIMEOUT_MS = 20_000;
/** How long a step looks again for an element that was there a moment ago (re-rendered). */
const RERENDER_GRACE_MS = 2000;
/** After a step, the page counts as settled once nothing has changed for this long. */
const QUIET_MS = 500;
/** Pages that never stop changing (a clock, a live feed): stop waiting after this long, or this long after a page change. */
const BUSY_PAGE_MS = 3000;
const BUSY_PAGE_NAV_MS = 8000;
/** The outline sent back after each step: enough to pick the next target without looking it up. */
const STEP_OUTLINE = { limit: 40, textChars: 1200 };

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @typedef {object} RunnerUi
 * @property {(text: string, risky: string, allowAll: boolean) => Promise<'allow' | 'all' | 'deny'>} ask
 * @property {(text: string) => { done: (text: string, ok?: boolean) => void }} activity  a line in the chat
 */

export class AgentRunner {
  /** @param {RunnerUi} ui */
  constructor(ui) {
    this.ui = ui;
    /** "Allow all for this task" was clicked (reset when a turn starts). */
    this.allowAll = false;
    this.counter = 0;
  }

  /** A new turn: ask again. */
  reset() {
    this.allowAll = false;
  }

  /**
   * Should the user be asked before this step?
   * @param {string} mode
   * @param {string} risky why the step is risky, or ''
   */
  needsAsk(mode, risky) {
    if (mode === 'full') return false;
    if (risky) return true;
    return mode === 'ask' && !this.allowAll;
  }

  /**
   * Ask (if needed). Throws when the user says no.
   * @param {string} mode
   * @param {string} what
   * @param {string} risky
   */
  async approve(mode, what, risky) {
    if (!this.needsAsk(mode, risky)) return;
    const answer = await this.ui.ask(what, risky, mode === 'ask' && !this.allowAll);
    if (answer === 'deny') throw new Error(`The user denied: ${what}.`);
    if (answer === 'all') this.allowAll = true;
  }

  /**
   * Run one page action.
   * @param {'interact' | 'navigate'} name
   * @param {any} input
   * @param {string} mode one of ask / auto / full
   */
  async run(name, input, mode) {
    if (!['ask', 'auto', 'full'].includes(mode)) throw new Error('Page actions only run in Ask, Auto or Full auto mode');
    const done = name === 'navigate' ? [await this.navigate(input, mode)] : await this.interact(input, mode);
    return { done, ...(await observe(name === 'interact' ? input.frame : undefined)) };
  }

  /**
   * @param {{ steps: any[], frame?: string }} input
   * @param {string} mode
   */
  async interact({ steps, frame }, mode) {
    const actionId = `live-${Date.now()}-${++this.counter}`;
    /** @type {string[]} */
    const done = [];
    for (const [index, step] of steps.entries()) {
      // A plain pause.
      if (step.action === 'wait' && !step.selector && !step.text && !step.ref) {
        const line = this.ui.activity(`Waiting ${step.value} s`);
        await sleep(Math.min(Number(step.value) * 1000, WAIT_MAX_MS));
        line.done(`Waited ${step.value} s`);
        done.push(`waited ${step.value} s`);
        continue;
      }
      // Find it (it may appear after the previous step), outline it, and describe it.
      const deadline = Date.now() + (step.action === 'wait' ? WAIT_MAX_MS : STEP_TIMEOUT_MS);
      let preview;
      try {
        // hold: the outline stays on the target while the user is asked and until the step runs.
        while (!(preview = await callInPage(interactStep, { actionId, step, dry: true, hold: true }, frame))?.found && Date.now() < deadline) await sleep(POLL_MS);
      } catch (err) {
        throw new Error(`Step ${index + 1} failed: ${/** @type {any} */ (err).message}${soFar(done)}`);
      }
      if (!preview?.found) {
        const what = [step.ref, step.selector, step.text && `"${step.text}"`].filter(Boolean).join(' ');
        throw new Error(`Step ${index + 1} (${step.action} ${what}): no matching element on the page.${soFar(done)}`);
      }
      try {
        await this.approve(mode, preview.what, preview.risky);
      } catch (err) {
        await callInPage(clearHighlight, {}, frame).catch(() => {});
        throw new Error(`${/** @type {any} */ (err).message}${soFar(done)}`);
      }

      const line = this.ui.activity(capitalize(preview.what));
      await sleep(FOLLOW_PAUSE_MS);
      const before = await pageNow().catch(() => null);
      await callInPage(quietFor, {}, frame).catch(() => {}); // start watching for changes before the step
      let result;
      try {
        // Pages re-render while you use them (a search box is replaced as you type): look again briefly.
        const retryUntil = Date.now() + RERENDER_GRACE_MS;
        while (!(result = await callInPage(interactStep, { actionId, step }, frame))?.found && Date.now() < retryUntil) await sleep(POLL_MS);
      } catch (err) {
        await callInPage(clearHighlight, {}, frame).catch(() => {});
        line.done(`Failed: ${preview.what}`, false);
        throw new Error(`Step ${index + 1} failed: ${/** @type {any} */ (err).message}${soFar(done)}`);
      }
      if (!result?.found) {
        line.done(`Not found any more: ${preview.what}`, false);
        throw new Error(`Step ${index + 1}: the element disappeared before it could be used.${soFar(done)}`);
      }
      // The chat says it the way it was asked; the AI gets the precise version (selectors, values).
      line.done(/^(couldn't|.* was already)/.test(result.did) ? capitalize(result.did) : capitalize(preview.what));
      done.push(result.did);
      await settle(before?.url, false, frame);
    }
    return done;
  }

  /**
   * @param {{ url?: string, go?: 'back' | 'forward' | 'reload' }} input
   * @param {string} mode
   */
  async navigate({ url, go }, mode) {
    const before = await pageNow();
    let what;
    let risky = '';
    if (url) {
      what = `go to ${url}`;
      const from = safeOrigin(before.url);
      if (from && from !== safeOrigin(url)) risky = 'leaves this site';
    } else {
      what = go === 'reload' ? 'reload the page' : `go ${go}`;
    }
    await this.approve(mode, what, risky);
    const line = this.ui.activity(capitalize(what));
    await sleep(FOLLOW_PAUSE_MS);
    if (url) await evalInPage(`location.href = ${JSON.stringify(url)}`);
    else if (go === 'back') await evalInPage('history.back()');
    else if (go === 'forward') await evalInPage('history.forward()');
    else chrome.devtools.inspectedWindow.reload({});
    await settle(before.url, true);
    const now = await pageNow();
    line.done(`${capitalize(what)}: now on ${now.title || now.url}`);
    return `${what}; the page is now ${now.url}`;
  }
}

/** The inspected page's URL and title (may throw while a new page is loading). */
function pageNow() {
  return evalInPage('({ url: location.href, title: document.title })');
}

/**
 * How the page looks after the steps, for the model: an outline of what's on screen (and of
 * the frame the steps ran in). Falls back to the URL and title if the page can't be read.
 * @param {string} [frame]
 */
async function observe(frame) {
  const page = await callInPage(pageOutline, STEP_OUTLINE).catch(() => pageNow().catch(() => null));
  if (!frame) return { page };
  const inFrame = await callInPage(pageOutline, STEP_OUTLINE, frame).catch((err) => ({ error: String(err?.message ?? err) }));
  return { page: page && { url: page.url, title: page.title }, frame: inFrame };
}

/**
 * Wait until the page has settled after a step: a page load it started has finished
 * (polling through the moment the old page is gone), and nothing has been added, removed
 * or re-rendered for QUIET_MS (a route change in an app, a list that loaded, a menu that
 * opened). So the model sees the result without adding wait steps.
 * @param {string} [beforeUrl]
 * @param {boolean} [expectLoad] a navigation was started on purpose
 * @param {string} [frame] the steps ran in this iframe: watch it for changes
 */
async function settle(beforeUrl, expectLoad = false, frame = undefined) {
  await sleep(expectLoad ? 400 : 150);
  const start = Date.now();
  const deadline = start + LOAD_TIMEOUT_MS;
  let changedPage = expectLoad;
  while (Date.now() < deadline) {
    try {
      const top = await evalInPage('({ url: location.href, ready: document.readyState })');
      if (top.url !== beforeUrl) changedPage = true;
      if (top.ready === 'complete') {
        const { quietMs } = await callInPage(quietFor, {}, frame).catch(() => ({ quietMs: QUIET_MS }));
        if (quietMs >= QUIET_MS) return;
        if (Date.now() - start > (changedPage ? BUSY_PAGE_NAV_MS : BUSY_PAGE_MS)) return;
      }
    } catch { /* the old page is gone and the new one isn't ready to answer yet */ }
    await sleep(POLL_MS);
  }
}

/** @param {string} url */
function safeOrigin(url) {
  try { return new URL(url).origin; } catch { return ''; }
}

/** @param {string} text */
function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** @param {string[]} done */
function soFar(done) {
  return done.length ? ` Steps already done: ${done.join('; ')}.` : ' No steps were done.';
}
