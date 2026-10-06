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

import { pageHelpers } from './page-scripts.js';

/**
 * Evaluate an expression in the inspected page, or in one of its frames.
 * @param {string} expression
 * @param {string} [frame] URL of an iframe (as the frame reports it); omit for the page itself
 * @returns {Promise<any>}
 */
export function evalInPage(expression, frame) {
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
export function callInPage(fn, args = {}, frame = undefined) {
  const expression = `(${fn.toString()})((${pageHelpers.toString()})(), typeof $0 === 'undefined' ? undefined : $0, ${JSON.stringify(args)})`;
  return evalInPage(expression, frame);
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
 * @param {string} code
 * @param {{ timeoutMs?: number, pollMs?: number }} [options]
 */
export async function runApprovedScript(code, { timeoutMs = SCRIPT_TIMEOUT_MS, pollMs = 100 } = {}) {
  const key = crypto.randomUUID();
  // The code is placed into the expression as-is (not via `new Function`), so it
  // also works on pages whose CSP forbids eval. A syntax error rejects the promise.
  const start = `(() => {
  const __h = (${pageHelpers.toString()})();
  const __scripts = __h.state().scripts ??= {};
  __scripts[${JSON.stringify(key)}] = null;
  (async function ($0) {
${code}
  })(typeof $0 === 'undefined' ? undefined : $0).then(
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
