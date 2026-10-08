// @ts-check
/**
 * Run code in the inspected page with chrome.devtools.inspectedWindow.eval().
 *
 * eval() runs in the page's main JavaScript world with the DevTools console
 * utilities available ($0 = selected element, inspect(), …). It ignores the
 * page's Content-Security-Policy. Results must be JSON-serializable.
 *
 * Security note: the page controls its own JavaScript environment, so a hostile
 * page could tamper with what these functions return. That only affects the
 * data shown to the AI, never what gets executed: execution always needs the
 * user's approval in the panel.
 */

import { areaInFrame, pageHelpers } from './page-scripts.js';
import { IN_CARD, TAB_ID } from './surface.js';

/**
 * The area the user marked ({ area: [{x, y}, …], url, anchor }: coordinates in the content of `anchor`, the panel
 * that scrolls around it (or of the page), and the page it was marked on), or
 * null for the whole page. It goes with every call into the page, where the helpers leave out everything outside
 * it, and show nothing at all on another page (see pageHelpers).
 * site: instead of url, when the user keeps the area on every page of the site (checked by origin).
 * @type {{ area: { x: number, y: number }[], url: string, anchor: string, site?: string } | null}
 */
let pageScope = null;

/** Is an area marked (the tools are limited to it)? */
export const hasPageArea = () => Boolean(pageScope);

/**
 * @param {{ x: number, y: number }[] | null} area
 * @param {string} [url]  the page's address (without #…)
 * @param {string} [anchor]  selector of the panel that scrolls around the area ('' = the page)
 * @param {boolean} [keepOnSite]  the same area on every page of the site (checked by origin instead of address)
 */
export function setPageArea(area, url = '', anchor = '', keepOnSite = false) {
  let site = '';
  try { site = new URL(url).origin; } catch { /* not a web address */ }
  pageScope = area && area.length >= 3
    ? { area: area.map(({ x, y }) => ({ x: Number(x), y: Number(y) })), anchor, ...(keepOnSite && site ? { url: '', site } : { url }) }
    : null;
}

/**
 * Evaluate an expression in the inspected page, or in one of its frames.
 * @param {string} expression
 * @param {string} [frame] URL of an iframe (as the frame reports it); omit for the page itself
 * @returns {Promise<any>}
 */
export function evalInPage(expression, frame) {
  if (IN_CARD) return Promise.reject(new Error('Not available in the card on the page: continue in DevTools for this.'));
  return new Promise((resolve, reject) => {
    chrome.devtools.inspectedWindow.eval(expression, frame ? { frameURL: frame } : {}, (result, exceptionInfo) => {
      // The message only: page exceptions arrive as "Error: …" plus a stack trace nobody needs in the chat.
      if (exceptionInfo?.isException) reject(new Error(String(exceptionInfo.value).split(/\r?\n/)[0].replace(/^(Error|TypeError|RangeError): /, '')));
      else if (exceptionInfo?.isError && frame && /frame/i.test(`${exceptionInfo.code} ${exceptionInfo.description}`)) {
        reject(new Error(`No frame with the URL ${frame} (page_outline lists the frames and their URLs)`));
      } else if (exceptionInfo?.isError) reject(new Error(exceptionInfo.description || exceptionInfo.code || 'Evaluation failed'));
      else resolve(result);
    });
  });
}

/**
 * Call one of the functions from page-scripts.js inside the page.
 *
 * The function's source text is sent to the page, so it must not use anything
 * from this file's scope. It receives (helpers, selectedElement, args):
 *   helpers          = the object returned by pageHelpers() (cssPath, describe, …)
 *   selectedElement  = $0, the element selected in the Elements panel (or undefined)
 *   args             = JSON-serializable arguments
 *
 * @param {Function} fn
 * @param {unknown} [args]
 * @param {string} [frame] run it in this iframe (URL) instead of the page itself
 */
export async function callInPage(fn, args = {}, frame = undefined) {
  if (IN_CARD) return callInCard(fn, args, frame);
  let scope = pageScope;
  if (scope && frame) {
    // With a marked area: the part of it in this frame, worked out by the page around the frame (which also checks
    // that it's still the page the area belongs to). In the frame, only that part exists for the tools.
    scope = await evalInPage(`(${areaInFrame.toString()})((${pageHelpers.toString()})(${JSON.stringify(scope)}), undefined, ${JSON.stringify({ url: frame })})`);
  }
  const expression = `(${fn.toString()})((${pageHelpers.toString()})(${JSON.stringify(scope)}), typeof $0 === 'undefined' ? undefined : $0, ${JSON.stringify(args)})`;
  return evalInPage(expression, frame);
}

/**
 * Page functions that read what console-capture.js keeps in the page's own JavaScript world. They
 * don't use the helpers, so in the card they run there directly.
 */
const MAIN_WORLD = new Set(['readConsole', 'clearConsole']);

/**
 * The card on the page has no DevTools, so page functions run through chrome.scripting instead: in
 * the extension's isolated world, where the page can't tamper with them (it shares the DOM, so
 * events still reach the page's own code), with the same helpers and the element picked with
 * Pick element as the selected one. The functions are imported there from the extension's files.
 * @param {Function} fn
 * @param {unknown} args
 * @param {string} [frame]
 */
async function callInCard(fn, args, frame) {
  if (frame) throw new Error('Frames can only be used from DevTools: continue in DevTools for this.');
  if (MAIN_WORLD.has(fn.name)) {
    const [main] = await chrome.scripting.executeScript({ target: { tabId: TAB_ID }, world: 'MAIN', func: /** @type {any} */ (fn), args: [null, null, args] });
    return main?.result;
  }
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId: TAB_ID },
    world: 'ISOLATED',
    func: runInCard,
    args: [fn.name, /** @type {any} */ (args), /** @type {any} */ (pageScope)],
  });
  const reply = /** @type {{ ok: boolean, value?: any, error?: string } | undefined} */ (injection?.result);
  if (!reply) throw new Error('The page did not answer (it may be loading)');
  if (!reply.ok) throw new Error(reply.error);
  return reply.value;
}

/**
 * Runs in the page (isolated world): load the page functions and call one by name.
 * Self-contained: it is sent to the page as source text.
 * @param {string} name
 * @param {any} args
 * @param {any} scope  the marked area, if any (see pageHelpers)
 */
async function runInCard(name, args, scope) {
  try {
    const [scripts, interact] = await Promise.all([
      import(chrome.runtime.getURL('panel/lib/page-scripts.js')),
      import(chrome.runtime.getURL('panel/lib/page-interact.js')),
    ]);
    const fn = scripts[name] ?? interact[name];
    if (typeof fn !== 'function') throw new Error(`Unknown page function ${name}`);
    const h = scripts.pageHelpers(scope);
    const picked = h.state().picked;
    return { ok: true, value: await fn(h, picked && picked.isConnected ? picked : undefined, args) };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

/** How long runApprovedScript waits for a script's result (it keeps running in the page after that). */
export const SCRIPT_TIMEOUT_MS = 30_000;

/**
 * Run user-approved JavaScript (from an execute_js action) in the page.
 * The code is the body of an async function, so it may use `await`; `$0` is the
 * selected element. Resolves to { ok: true, value } or { ok: false, error }.
 *
 * inspectedWindow.eval() can't wait for a Promise, so the script's settled result
 * is kept in the page's hidden state under a random key, and read back by polling.
 * With a marked area, the script also gets $area: the outermost elements inside it (areaRoots), to work on.
 * @param {string} code
 * @param {{ timeoutMs?: number, pollMs?: number, areaRoots?: string[] }} [options]
 */
export async function runApprovedScript(code, { timeoutMs = SCRIPT_TIMEOUT_MS, pollMs = 100, areaRoots = [] } = {}) {
  const key = crypto.randomUUID();
  // The code is placed into the expression as-is (not via `new Function`), so it
  // also works on pages whose CSP forbids eval. A syntax error rejects the promise.
  const start = `(() => {
  const __h = (${pageHelpers.toString()})();
  const __scripts = __h.state().scripts ??= {};
  __scripts[${JSON.stringify(key)}] = null;
  (async function ($0, $area) {
${code}
  })(typeof $0 === 'undefined' ? undefined : $0, ${JSON.stringify(areaRoots)}.map((s) => document.querySelector(s)).filter(Boolean)).then(
    (value) => { __scripts[${JSON.stringify(key)}] = { ok: true, value: __h.toJson(value) }; },
    (e) => { __scripts[${JSON.stringify(key)}] = { ok: false, error: String(e && e.stack || e) }; },
  );
  return true;
})()`;
  // Read the result once it's there (and forget it). undefined = the page was reloaded or left meanwhile.
  const read = `(() => {
  const __scripts = (${pageHelpers.toString()})().state().scripts;
  if (!__scripts || !(${JSON.stringify(key)} in __scripts)) return undefined;
  const result = __scripts[${JSON.stringify(key)}];
  if (result) delete __scripts[${JSON.stringify(key)}];
  return result;
})()`;
  await evalInPage(start);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await evalInPage(read);
    if (result) return result;
    if (result === undefined) return { ok: true, value: '(the page reloaded or navigated before the script finished)' };
    if (Date.now() >= deadline) {
      return { ok: true, value: `(still running after ${Math.round(timeoutMs / 1000)} s; it continues in the page, but its result is not reported)` };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** Select an element in the Elements panel (DevTools `inspect()` utility). */
/** @param {string} selector */
export function selectInElementsPanel(selector) {
  return evalInPage(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el) inspect(el); return !!el; })()`);
}
