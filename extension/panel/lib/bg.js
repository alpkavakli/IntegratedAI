// @ts-check
/**
 * Tiny client for the background service worker (see background/service-worker.js).
 * @param {string} cmd
 * @param {Record<string, unknown>} [args]
 * @returns {Promise<any>}
 */
export async function bg(cmd, args = {}) {
  const res = await chrome.runtime.sendMessage({ cmd, ...args });
  if (!res?.ok) throw new Error(res?.error ?? `Background command ${cmd} failed`);
  return res.value;
}
