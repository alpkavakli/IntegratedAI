// @ts-check
/**
 * Builds the small page context attached to each chat message.
 *
 * Only what the user enabled (the chips above the input box) is collected:
 *   selected  → the $0 element: selector, key computed styles, box, short HTML (on by default)
 *   console   → the last few errors/warnings
 *   network   → failed requests + a short list of recent ones
 * Anything else the model can request with an inspection action.
 */

import { callInPage } from './inspected.js';
import { inspectNetwork } from './inspections.js';
import { describeSelected, pageInfo, readConsole } from './page-scripts.js';

/**
 * @param {{ selected: boolean, console: boolean, network: boolean }} include
 * @param {{ consoleError?: unknown }} [extra]  e.g. the error the user clicked "Explain" on
 */
export async function collectContext(include, extra = {}) {
  const page = await callInPage(pageInfo);
  /** @type {Record<string, unknown>} */
  const context = { page: { url: page.url, title: page.title, viewport: page.viewport } };

  const tasks = [];
  if (include.selected) {
    tasks.push(callInPage(describeSelected).then((s) => { context.selected = s ?? 'No element selected'; }));
  }
  if (include.console) {
    tasks.push(callInPage(readConsole, { levels: ['error', 'warn'], limit: 8 }).then((c) => {
      context.console = c.available ? c.entries.map(({ level, message, count, source }) => ({ level, message: message.slice(0, 500), count, source })) : c.note;
    }));
  }
  if (include.network) {
    tasks.push(Promise.all([inspectNetwork({ onlyFailed: true, limit: 10 }), inspectNetwork({ limit: 10 })]).then(([failed, recent]) => {
      context.network = { failed: failed.requests, recent: recent.requests.map((r) => `${r.status} ${r.method} ${r.url}`) };
    }));
  }
  // A failing optional part shouldn't block the message.
  await Promise.all(tasks.map((t) => t.catch((err) => { context.contextError = String(err.message ?? err); })));

  if (extra.consoleError) context.consoleError = extra.consoleError;
  return { context, timeOrigin: page.timeOrigin };
}
