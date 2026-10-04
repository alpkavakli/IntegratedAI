// @ts-check
/**
 * Read-only inspections requested by the model (tool.request from the server).
 * These only READ from the page or DevTools; they never change anything.
 */

import { bg } from './bg.js';
import { callInPage } from './inspected.js';
import { findElements, inspectElement, prepareScreenshot, readConsole, restoreScroll } from './page-scripts.js';

// Headers that must never be sent to the AI.
const SENSITIVE_HEADERS = /^(cookie|set-cookie|authorization|proxy-authorization|x-api-key|api-key|x-auth-token|x-csrf-token|x-xsrf-token|x-amz-security-token)$/i;
// Query parameters that often carry secrets.
const SENSITIVE_PARAMS = /^(token|access_token|id_token|refresh_token|code|key|api_key|apikey|secret|password|sig|signature|session)$/i;

/**
 * Run one inspection.
 * @param {string} name
 * @param {any} input
 * @param {{ selectedSelector?: string, tabId: number }} ctx
 */
export async function runInspection(name, input, ctx) {
  switch (name) {
    case 'inspect_element':
      return callInPage(inspectElement, { ...input, selector: input.selector || ctx.selectedSelector || undefined });
    case 'find_elements':
      return callInPage(findElements, input);
    case 'inspect_console':
      return callInPage(readConsole, input);
    case 'inspect_network':
      return inspectNetwork(input);
    case 'inspect_resources':
      return inspectResources(input);
    case 'screenshot':
      return screenshot(input, ctx);
    default:
      throw new Error(`Unknown inspection ${name}`);
  }
}

// Longest side of a screenshot sent to the AI, and padding around the element (CSS px).
const SCREENSHOT_MAX_SIDE = 1280;
const SCREENSHOT_PADDING = 8;
// Chrome allows 2 captures per second, and two screenshots at once would fight over
// the scroll position, so screenshots run one after another.
const CAPTURE_INTERVAL_MS = 550;
let captureQueue = Promise.resolve();
let lastCaptureAt = 0;

/**
 * Capture the visible tab and crop it to the element. The image is returned as
 * { image: { mediaType, data } } next to a short description; the server sends the
 * image to the model as an image, not as text.
 * @param {{ selector?: string, fullViewport?: boolean }} input
 * @param {{ selectedSelector?: string, tabId: number }} ctx
 */
export function screenshot(input, ctx) {
  const run = captureQueue.then(() => takeScreenshot(input, ctx));
  captureQueue = run.catch(() => {});
  return run;
}

/**
 * @param {{ selector?: string, fullViewport?: boolean }} input
 * @param {{ selectedSelector?: string, tabId: number }} ctx
 */
async function takeScreenshot(input, ctx) {
  const selector = input.fullViewport ? undefined : input.selector || ctx.selectedSelector || undefined;
  const target = await callInPage(prepareScreenshot, { ...input, selector });
  let dataUrl;
  try {
    const wait = Math.max(target.scrolled ? 150 : 0, lastCaptureAt + CAPTURE_INTERVAL_MS - Date.now()); // repaint, rate limit
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCaptureAt = Date.now();
    dataUrl = await bg('tab.capture', { tabId: ctx.tabId });
  } finally {
    if (target.scrolled) await callInPage(restoreScroll, target.scroll).catch(() => {});
  }

  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const scale = bitmap.width / target.viewport.width; // device pixels per CSS pixel
  let crop = { x: 0, y: 0, w: bitmap.width, h: bitmap.height };
  let cutOff = false;
  if (target.rect) {
    const r = target.rect;
    const x0 = Math.max(0, r.x - SCREENSHOT_PADDING);
    const y0 = Math.max(0, r.y - SCREENSHOT_PADDING);
    const x1 = Math.min(target.viewport.width, r.x + r.width + SCREENSHOT_PADDING);
    const y1 = Math.min(target.viewport.height, r.y + r.height + SCREENSHOT_PADDING);
    if (x1 <= x0 || y1 <= y0) throw new Error('The element is not on screen, so it cannot be captured');
    // 1px tolerance: boxes often end at fractional pixels just past the edge.
    cutOff = r.x < -1 || r.y < -1 || r.x + r.width > target.viewport.width + 1 || r.y + r.height > target.viewport.height + 1;
    crop = {
      x: Math.round(x0 * scale), y: Math.round(y0 * scale),
      w: Math.min(bitmap.width, Math.round((x1 - x0) * scale)), h: Math.min(bitmap.height, Math.round((y1 - y0) * scale)),
    };
  }

  const k = Math.min(1, SCREENSHOT_MAX_SIDE / Math.max(crop.w, crop.h));
  const width = Math.max(1, Math.round(crop.w * k));
  const height = Math.max(1, Math.round(crop.h * k));
  const canvas = new OffscreenCanvas(width, height);
  /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext('2d')).drawImage(bitmap, crop.x, crop.y, crop.w, crop.h, 0, 0, width, height);
  bitmap.close();
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });

  return {
    captured: target.selector ?? target.label,
    element: target.rect ? target.label : undefined,
    size: { width, height },
    ...(cutOff ? { note: 'The element is larger than the visible area; only its visible part was captured.' } : {}),
    image: { mediaType: 'image/jpeg', data: await toBase64(blob) },
  };
}

/** @param {Blob} blob */
async function toBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
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
