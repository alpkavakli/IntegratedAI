// @ts-check
/**
 * Connection security for the local server.
 *
 * Three independent checks, because "it only listens on localhost" is not enough:
 * any website you visit can try to open ws://127.0.0.1:<port> from your browser.
 *
 *  1. Host header must be 127.0.0.1 / localhost / [::1]  → blocks DNS-rebinding attacks
 *  2. Origin header must be chrome-extension://<id>       → blocks normal websites
 *     (optionally restricted to specific extension IDs)
 *  3. The first message must carry the pairing token      → blocks other extensions/apps
 */

import { timingSafeEqual } from 'node:crypto';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Check the HTTP upgrade request before accepting a WebSocket.
 * @param {{ headers: Record<string, string | string[] | undefined> }} req
 * @param {{ port: number, allowedExtensionIds: string[] }} config
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function checkUpgrade(req, config) {
  const host = String(req.headers.host ?? '');
  if (!isLocalHost(host, config.port)) {
    return { ok: false, reason: `Rejected Host header "${host}"` };
  }

  const origin = String(req.headers.origin ?? '');
  const match = origin.match(/^chrome-extension:\/\/([a-p]{32})$/);
  if (!match) {
    return { ok: false, reason: `Rejected Origin "${origin || '(none)'}" (only Chrome extensions may connect)` };
  }
  if (config.allowedExtensionIds.length && !config.allowedExtensionIds.includes(match[1])) {
    return { ok: false, reason: `Extension ${match[1]} is not in allowedExtensionIds` };
  }
  return { ok: true };
}

/**
 * Is this Host header our own local address? (Blocks DNS rebinding.)
 * @param {string} host
 * @param {number} expectedPort
 */
export function isLocalHost(host, expectedPort) {
  const hostname = host.replace(/:\d+$/, '');
  const port = host.match(/:(\d+)$/)?.[1];
  return LOCAL_HOSTS.has(hostname) && (!port || Number(port) === expectedPort);
}

/**
 * Constant-time token comparison.
 * @param {unknown} given
 * @param {string} expected
 */
export function tokenMatches(given, expected) {
  if (typeof given !== 'string' || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
