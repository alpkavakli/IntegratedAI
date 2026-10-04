// @ts-check
/**
 * Read-only inspections requested by the model (tool.request from the server).
 * These only READ from the page or DevTools; they never change anything.
 */

import { callInPage } from './inspected.js';
import { inspectElement, readConsole } from './page-scripts.js';

// Headers that must never be sent to the AI.
const SENSITIVE_HEADERS = /^(cookie|set-cookie|authorization|proxy-authorization|x-api-key|api-key|x-auth-token|x-csrf-token|x-xsrf-token|x-amz-security-token)$/i;
// Query parameters that often carry secrets.
const SENSITIVE_PARAMS = /^(token|access_token|id_token|refresh_token|code|key|api_key|apikey|secret|password|sig|signature|session)$/i;

/**
 * Run one inspection.
 * @param {string} name
 * @param {any} input
 * @param {{ selectedSelector?: string }} ctx
 */
export async function runInspection(name, input, ctx) {
  switch (name) {
    case 'inspect_element':
      return callInPage(inspectElement, { ...input, selector: input.selector || ctx.selectedSelector || undefined });
    case 'inspect_console':
      return callInPage(readConsole, input);
    case 'inspect_network':
      return inspectNetwork(input);
    case 'inspect_resources':
      return inspectResources(input);
    default:
      throw new Error(`Unknown inspection ${name}`);
  }
}

/**
 * Summarize the DevTools network log (HAR). Only requests made while DevTools
 * was open are known.
 * @param {{ urlContains?: string, onlyFailed?: boolean, includeHeaders?: boolean, limit?: number }} input
 */
export async function inspectNetwork(input = {}) {
  const har = await new Promise((resolve) => chrome.devtools.network.getHAR(resolve));
  const limit = Math.min(Math.max(input.limit || 30, 1), 100);
  /** @type {any[]} */
  let entries = har?.entries ?? [];
  if (input.urlContains) entries = entries.filter((e) => e.request.url.includes(input.urlContains));
  if (input.onlyFailed) entries = entries.filter((e) => e.response.status === 0 || e.response.status >= 400);

  return {
    total: entries.length,
    note: 'Only requests made while DevTools was open are listed. Sensitive headers and query parameters are redacted.',
    requests: entries.slice(-limit).map((e) => summarizeEntry(e, Boolean(input.includeHeaders))),
  };
}

/**
 * @param {any} e HAR entry
 * @param {boolean} includeHeaders
 */
export function summarizeEntry(e, includeHeaders) {
  /** @type {Record<string, unknown>} */
  const out = {
    method: e.request.method,
    url: redactUrl(e.request.url),
    status: e.response.status,
    statusText: e.response.statusText || undefined,
    type: e._resourceType || e.response.content?.mimeType,
    sizeBytes: e.response.bodySize >= 0 ? e.response.bodySize : e.response.content?.size,
    timeMs: Math.round(e.time),
    failed: e.response.status === 0 || e.response.status >= 400 || undefined,
    error: e.response._error || undefined,
  };
  if (includeHeaders) {
    out.requestHeaders = redactHeaders(e.request.headers);
    out.responseHeaders = redactHeaders(e.response.headers);
  }
  return out;
}

/** @param {{ name: string, value: string }[]} headers */
export function redactHeaders(headers = []) {
  return headers.map(({ name, value }) => ({ name, value: SENSITIVE_HEADERS.test(name) ? '[redacted]' : value.slice(0, 300) }));
}

/** @param {string} url */
export function redactUrl(url) {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) {
      if (SENSITIVE_PARAMS.test(key)) u.searchParams.set(key, 'redacted');
    }
    if (u.username || u.password) { u.username = ''; u.password = ''; }
    const text = u.toString();
    return text.length > 500 ? `${text.slice(0, 500)}…` : text;
  } catch {
    return url.slice(0, 500);
  }
}

/**
 * List page resources or read one resource's content.
 * @param {{ urlContains?: string, type?: string, readContentOf?: string }} input
 */
export async function inspectResources(input = {}) {
  /** @type {chrome.devtools.inspectedWindow.Resource[]} */
  const resources = await new Promise((resolve) => chrome.devtools.inspectedWindow.getResources(resolve));

  if (input.readContentOf) {
    const resource = resources.find((r) => r.url === input.readContentOf);
    if (!resource) throw new Error('No resource with that exact URL');
    const content = await new Promise((resolve) => resource.getContent((text, encoding) => resolve({ text, encoding })));
    if (content.encoding === 'base64') return { url: resource.url, type: resource.type, note: 'Binary resource; content not shown.' };
    const text = content.text ?? '';
    return { url: resource.url, type: resource.type, length: text.length, content: text.length > 25000 ? `${text.slice(0, 25000)}\n… [truncated]` : text };
  }

  let list = resources;
  if (input.type) {
    const known = ['document', 'stylesheet', 'script', 'image', 'font'];
    list = list.filter((r) => (input.type === 'other' ? !known.includes(r.type) : r.type === input.type));
  }
  if (input.urlContains) list = list.filter((r) => r.url.includes(input.urlContains));
  return { total: list.length, resources: list.slice(0, 100).map((r) => ({ url: redactUrl(r.url), type: r.type })) };
}
