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
 * Evaluate an expression in the inspected page.
 * @param {string} expression
 * @returns {Promise<any>}
 */
export function evalInPage(expression) {
  return new Promise((resolve, reject) => {
    chrome.devtools.inspectedWindow.eval(expression, {}, (result, exceptionInfo) => {
      if (exceptionInfo?.isException) reject(new Error(String(exceptionInfo.value)));
      else if (exceptionInfo?.isError) reject(new Error(exceptionInfo.description || exceptionInfo.code || 'Evaluation failed'));
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
 */
export function callInPage(fn, args = {}) {
  const expression = `(${fn.toString()})((${pageHelpers.toString()})(), typeof $0 === 'undefined' ? undefined : $0, ${JSON.stringify(args)})`;
  return evalInPage(expression);
}

/**
 * Run user-approved JavaScript (from an execute_js action) in the page.
 * The code is a function body; `$0` is the selected element. Returns
 * { ok, value } or { ok: false, error }.
 * @param {string} code
 */
export function runApprovedScript(code) {
  // The code is placed into the expression as-is (not via `new Function`), so it
  // also works on pages whose CSP forbids eval. A syntax error rejects the promise.
  const expression = `(() => {
  const __h = (${pageHelpers.toString()})();
  try {
    const __result = (function ($0) {
${code}
    })(typeof $0 === 'undefined' ? undefined : $0);
    if (__result && typeof __result.then === 'function') return { ok: true, value: '(returned a Promise; it was started but not awaited)' };
    return { ok: true, value: __h.toJson(__result) };
  } catch (e) {
    return { ok: false, error: String(e && e.stack || e) };
  }
})()`;
  return evalInPage(expression);
}

/** Select an element in the Elements panel (DevTools `inspect()` utility). */
/** @param {string} selector */
export function selectInElementsPanel(selector) {
  return evalInPage(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el) inspect(el); return !!el; })()`);
}
