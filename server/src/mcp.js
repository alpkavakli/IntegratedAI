// @ts-check
/**
 * POST /mcp: a minimal MCP server (Streamable HTTP transport, JSON responses only)
 * that gives Claude Code the page inspections as tools. See agent/page-tools.js.
 *
 * Only what Claude Code needs is implemented: initialize, ping, tools/list and
 * tools/call. Notifications are acknowledged, anything else is "method not found".
 *
 * Security, in addition to only listening on localhost:
 *   - Host must be our local address        → blocks DNS rebinding
 *   - no Origin header                      → browsers always send one; Claude Code doesn't
 *   - Authorization: Bearer <grant token>   → valid only during one model call, for one conversation
 */

import { isLocalHost } from './auth.js';

const MAX_BODY_BYTES = 1024 * 1024;
const FALLBACK_PROTOCOL_VERSION = '2025-06-18';

/** @typedef {import('./agent/page-tools.js').PageTools} PageTools */

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ pageTools: PageTools, port: number }} deps
 */
export async function handleMcpRequest(req, res, { pageTools, port }) {
  const deny = (/** @type {number} */ status, /** @type {string} */ reason) => {
    console.warn(`[mcp] ${reason}`);
    res.writeHead(status, { 'content-type': 'text/plain' }).end(reason);
  };
  if (!isLocalHost(String(req.headers.host ?? ''), port)) return deny(403, `Rejected Host header "${req.headers.host}"`);
  if (req.headers.origin) return deny(403, `Rejected Origin "${req.headers.origin}"`);
  const token = String(req.headers.authorization ?? '').match(/^Bearer (.+)$/)?.[1];
  const grant = pageTools.lookup(token);
  if (!grant) return deny(401, 'Missing or expired token');

  // No server-initiated stream (GET) and no session to delete (DELETE).
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' }).end();
    return;
  }

  /** @type {any} */
  let msg;
  try {
    msg = JSON.parse(await readBody(req));
  } catch (err) {
    return sendJson(res, 400, rpcError(null, -32700, `Parse error: ${/** @type {any} */ (err)?.message ?? err}`));
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.method !== 'string') {
    return sendJson(res, 400, rpcError(null, -32600, 'Invalid request'));
  }
  // Notifications (no id) need no answer.
  if (msg.id === undefined || msg.id === null) {
    res.writeHead(202).end();
    return;
  }

  const reply = (/** @type {unknown} */ result) => sendJson(res, 200, { jsonrpc: '2.0', id: msg.id, result });
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : FALLBACK_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'integratedai-page', version: '1.0.0' },
        instructions: 'Read-only inspections of the web page open in the user\'s Chrome DevTools.',
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: pageTools.list(grant) });
    case 'tools/call': {
      const name = String(msg.params?.name ?? '');
      const { text, isError } = await pageTools.call(grant, name, msg.params?.arguments);
      return reply({ content: [{ type: 'text', text }], isError });
    }
    default:
      return sendJson(res, 200, rpcError(msg.id, -32601, `Method not found: ${msg.method}`));
  }
}

/**
 * @param {unknown} id
 * @param {number} code
 * @param {string} message
 */
function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

/** @param {import('node:http').IncomingMessage} req */
async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('Request too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
