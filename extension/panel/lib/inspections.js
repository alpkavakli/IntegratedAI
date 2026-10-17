// @ts-check
/**
 * Read-only inspections requested by the model (tool.request from the server).
 * These only READ from the page or DevTools; they never change anything.
 */

import { bg } from './bg.js';
import { callInPage, hasPageArea } from './inspected.js';
import { findElements, frameBox, inspectElement, pageOutline, prepareScreenshot, readConsole, readMoreStep, readText, restoreScroll, setCardHidden, videoWatchStart, videoWatchStatus, videoWatchStop } from './page-scripts.js';
import { FRAMES_PER_SHEET, SOUND_RATE, clock, encodeWav, peakLevel, sheetLayout, watchPlan } from '../../shared/video-watch.js';

// Headers that must never be sent to the AI.
const SENSITIVE_HEADERS = /^(cookie|set-cookie|authorization|proxy-authorization|x-api-key|api-key|x-auth-token|x-csrf-token|x-xsrf-token|x-amz-security-token)$/i;
// Query parameters that often carry secrets.
const SENSITIVE_PARAMS = /^(token|access_token|id_token|refresh_token|code|key|api_key|apikey|secret|password|sig|signature|session)$/i;

/**
 * Run one inspection.
 * @param {string} name
 * @param {any} input
 * @param {{ selectedSelector?: string, tabId: number, videoSound?: boolean }} ctx
 */
export async function runInspection(name, input, ctx) {
  switch (name) {
    case 'inspect_element':
      return callInPage(inspectElement, { ...input, selector: input.selector || (input.ref || input.frame ? undefined : ctx.selectedSelector) || undefined }, input.frame);
    case 'find_elements':
      return callInPage(findElements, input, input.frame);
    case 'page_outline':
      return callInPage(pageOutline, input, input.frame);
    case 'read_text':
      return callInPage(readText, input, input.frame);
    case 'inspect_console':
      return callInPage(readConsole, input);
    case 'inspect_network':
      return inspectNetwork(input);
    case 'inspect_resources':
      return inspectResources(input);
    case 'screenshot':
      return screenshot(input, ctx);
    case 'read_more':
      return readMore(input);
    case 'watch_video':
      return watchVideo(input, ctx);
    case 'search_chats':
      // The user's imported ChatGPT chats: kept by the extension, searched in its background page.
      return bg('chats.search', { input });
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
 * @param {{ selector?: string, ref?: string, frame?: string, fullViewport?: boolean }} input
 * @param {{ selectedSelector?: string, tabId: number }} ctx
 */
async function takeScreenshot(input, ctx) {
  // With a marked area the picture is always the area (frames in it included, as they show on screen).
  if (hasPageArea()) input = { ...input, frame: undefined, ref: undefined, selector: undefined, fullViewport: false };
  const selector = input.fullViewport ? undefined : input.selector || (input.ref || input.frame ? undefined : ctx.selectedSelector) || undefined;
  const target = input.frame ? await frameTarget(input, selector) : await callInPage(prepareScreenshot, { ...input, selector });
  let dataUrl;
  try {
    const wait = Math.max(target.scrolled ? 150 : 0, lastCaptureAt + CAPTURE_INTERVAL_MS - Date.now()); // repaint, rate limit
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCaptureAt = Date.now();
    // The card on the page (if open) is hidden for the capture, so it isn't in the picture.
    const cardShown = await callInPage(setCardHidden, { hidden: true }).catch(() => false);
    if (cardShown) await new Promise((r) => setTimeout(r, 60)); // let it repaint
    try {
      dataUrl = await bg('tab.capture', { tabId: ctx.tabId });
    } finally {
      if (cardShown) await callInPage(setCardHidden, { hidden: false }).catch(() => {});
    }
  } finally {
    if (target.scrolled) await callInPage(restoreScroll, target.scroll).catch(() => {});
    if (target.frameScrolled) await callInPage(restoreScroll, target.frameScroll, input.frame).catch(() => {});
  }

  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const scale = bitmap.width / target.viewport.width; // device pixels per CSS pixel
  let crop = { x: 0, y: 0, w: bitmap.width, h: bitmap.height };
  let cutOff = false;
  // With a marked area: exactly its box (no padding), and everything outside the area greyed out below.
  const padding = target.polygon ? 0 : SCREENSHOT_PADDING;
  let x0 = 0;
  let y0 = 0;
  if (target.rect) {
    const r = target.rect;
    x0 = Math.max(0, r.x - padding);
    y0 = Math.max(0, r.y - padding);
    const x1 = Math.min(target.viewport.width, r.x + r.width + padding);
    const y1 = Math.min(target.viewport.height, r.y + r.height + padding);
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
  const context = /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext('2d'));
  context.drawImage(bitmap, crop.x, crop.y, crop.w, crop.h, 0, 0, width, height);
  bitmap.close();
  if (target.polygon) {
    // Paint over everything outside the area before the picture leaves this function.
    const f = scale * k;
    context.beginPath();
    context.rect(0, 0, width, height);
    target.polygon.forEach((/** @type {{x: number, y: number}} */ p, /** @type {number} */ i) => {
      const x = (p.x - x0) * f;
      const y = (p.y - y0) * f;
      if (i) context.lineTo(x, y); else context.moveTo(x, y);
    });
    context.closePath();
    context.fillStyle = '#80868b';
    context.fill('evenodd');
  }
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });

  return {
    captured: target.selector ?? target.label,
    element: target.rect ? target.label : undefined,
    size: { width, height },
    ...(cutOff ? { note: 'The element is larger than the visible area; only its visible part was captured.' } : {}),
    image: { mediaType: 'image/jpeg', data: await toBase64(blob) },
  };
}

/**
 * Something inside an iframe: its position in the frame (prepareScreenshot there), moved by where the frame's
 * content is on the page (frameBox), and cut to the frame's visible area. Without a target: the whole frame.
 * @param {{ selector?: string, ref?: string, frame?: string, fullViewport?: boolean }} input
 * @param {string | undefined} selector
 */
async function frameTarget(input, selector) {
  const frame = /** @type {string} */ (input.frame);
  const outer = await callInPage(frameBox, { url: frame });
  const whole = input.fullViewport || (!selector && !input.ref);
  const inner = whole ? null : await callInPage(prepareScreenshot, { ...input, selector, fullViewport: false }, frame);
  const b = outer.box;
  let rect = { x: b.x, y: b.y, width: b.width, height: b.height };
  if (inner?.rect) {
    const x = Math.max(b.x, b.x + inner.rect.x);
    const y = Math.max(b.y, b.y + inner.rect.y);
    rect = { x, y, width: Math.min(b.x + b.width, b.x + inner.rect.x + inner.rect.width) - x, height: Math.min(b.y + b.height, b.y + inner.rect.y + inner.rect.height) - y };
  }
  return {
    viewport: outer.viewport, scroll: outer.scroll, scrolled: outer.scrolled,
    frameScroll: inner?.scroll, frameScrolled: Boolean(inner?.scrolled),
    rect, selector: inner?.selector ?? frame, label: inner ? `${inner.label} (in ${frame})` : `the frame ${frame}`,
  };
}

/**
 * read_more: load more of a list that grows as you scroll (comments, feeds, results, reviews): scroll it a screen at
 * a time and open "Show more" buttons until nothing new comes (2.5 s at its end), there is enough text, or time is up;
 * then read it (read_text, from the start).
 * @param {{ ref?: string, selector?: string, expand?: boolean, seconds?: number, enough?: number }} input
 */
async function readMore(input) {
  const seconds = Math.min(45, Math.max(3, Number(input.seconds) || 20));
  const enough = Math.min(150_000, Math.max(5000, Number(input.enough) || 40_000));
  const target = { ref: input.ref, selector: input.selector };
  const began = Date.now();
  /** @type {Record<string, number>} */
  const opened = {};
  let first = null;
  let last = null;
  let quiet = 0;
  let steps = 0;
  let stopped = `the time limit (${seconds} s)`;
  while (Date.now() - began < seconds * 1000) {
    const step = await callInPage(readMoreStep, { ...target, expand: input.expand });
    steps++;
    first ??= step;
    for (const text of step.clicked) opened[text] = (opened[text] ?? 0) + 1;
    // Nothing new since the last step, at the end of the list, with nothing opened: count it; three in a row = done.
    const same = last && step.chars === last.chars && step.height === last.height;
    quiet = same && step.atEnd && !step.clicked.length ? quiet + 1 : 0;
    last = step;
    if (quiet >= 3) { stopped = 'nothing more loaded'; break; }
    if (step.chars >= enough) { stopped = `enough text (${enough.toLocaleString('en')} characters)`; break; }
    await new Promise((r) => setTimeout(r, 800));
  }
  const read = await callInPage(readText, target);
  const buttons = Object.entries(opened).map(([text, n]) => (n > 1 ? `"${text}" ×${n}` : `"${text}"`));
  return {
    loaded: `scrolled ${last?.scroller ?? 'the page'} ${steps} times in ${Math.round((Date.now() - began) / 1000)} s; the text grew from ${(first?.chars ?? 0).toLocaleString('en')} to ${(last?.chars ?? 0).toLocaleString('en')} characters`,
    stoppedAt: stopped,
    ...(buttons.length ? { opened: buttons.slice(0, 12).join(', ') + (buttons.length > 12 ? `, and ${buttons.length - 12} more` : '') } : {}),
    ...read,
  };
}

/**
 * watch_video: watch a video on the page while it plays. Pictures of it every second or two (put together on one or
 * two contact sheets, each frame with its time), and its sound as a WAV file when the user allows it (only AIs that
 * can listen get it; see the providers). The tab has to stay on screen: hidden tabs can't be captured, and most
 * sites pause their videos in them.
 * @param {{ ref?: string, selector?: string, seconds?: number }} input
 * @param {{ selectedSelector?: string, tabId: number, videoSound?: boolean }} ctx
 */
async function watchVideo(input, ctx) {
  const start = await callInPage(videoWatchStart, { ref: input.ref, selector: input.selector, sound: ctx.videoSound !== false });
  const plan = watchPlan(input, start);
  /** @type {{ at: number, image: { mediaType: string, data: string } }[]} */
  const frames = [];
  const began = Date.now();
  let ended = false;
  let gone = false;
  let furthest = start.currentTime;
  /** @type {any} */
  let stopped = { done: false };
  try {
    for (;;) {
      const tookAt = Date.now();
      const status = await callInPage(videoWatchStatus, {});
      if (status.gone) { gone = true; break; }
      furthest = Math.max(furthest, status.time);
      const shot = await screenshot({ ref: start.ref }, ctx);
      frames.push({ at: status.time, image: shot.image });
      if (status.ended && frames.length > 1) { ended = true; break; }
      if ((Date.now() - began) / 1000 >= plan.seconds) break;
      await new Promise((r) => setTimeout(r, Math.max(0, plan.everyMs - (Date.now() - tookAt))));
    }
  } finally {
    for (let i = 0; i < 50 && !stopped.done; i++) {
      stopped = await callInPage(videoWatchStop, {}).catch(() => ({ done: true }));
      if (!stopped.done) await new Promise((r) => setTimeout(r, 100));
    }
  }
  const watched = Math.round((Date.now() - began) / 100) / 10;
  const sheets = await contactSheets(frames);
  const sound = stopped.audio ? await soundToWav(stopped.audio).catch((err) => ({ error: String(err?.message ?? err) })) : null;
  /** @type {string} */
  let soundNote = start.sound;
  if (stopped.error) soundNote = `not recorded (${stopped.error})`;
  else if (sound && 'error' in sound) soundNote = `recorded, but it could not be read (${sound.error})`;
  else if (sound?.silent) soundNote = 'silent (nothing could be heard: the video may be muted for recording, protected, or quiet)';
  else if (sound) soundNote = `attached (${clock(sound.seconds)})`;
  return {
    video: start.label,
    ref: start.ref,
    watched: ended
      ? `${watched} s, from ${clock(start.currentTime)} to the end${start.duration ? ` (${clock(start.duration)})` : ''}, where it stopped or started over`
      : `${watched} s, from ${clock(start.currentTime)} to ${clock(furthest)}${start.duration ? ` of ${clock(start.duration)}` : ''}`,
    ...(gone ? { note: 'The video was removed from the page while watching (the page moved on?).' } : {}),
    frames: `${frames.length} pictures, about every ${Math.round(plan.everyMs / 100) / 10} s, on ${sheets.length} contact sheet${sheets.length === 1 ? '' : 's'}: each picture shows its time in the video at its top left`,
    sound: soundNote,
    images: sheets,
    ...(sound && !('error' in sound) && !sound.silent ? { audio: { mediaType: 'audio/wav', data: sound.data } } : {}),
  };
}

/**
 * Frames → contact sheets (JPEG): a grid per sheet, each frame with its time.
 * @param {{ at: number, image: { mediaType: string, data: string } }[]} frames
 */
async function contactSheets(frames) {
  /** @type {{ mediaType: string, data: string }[]} */
  const sheets = [];
  for (let first = 0; first < frames.length; first += FRAMES_PER_SHEET) {
    const part = frames.slice(first, first + FRAMES_PER_SHEET);
    const bitmaps = await Promise.all(part.map(async (f) => createImageBitmap(await (await fetch(`data:${f.image.mediaType};base64,${f.image.data}`)).blob())));
    const layout = sheetLayout(part.length, bitmaps[0].width / bitmaps[0].height);
    const canvas = new OffscreenCanvas(layout.width, layout.height);
    const c = /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext('2d'));
    c.fillStyle = '#202124';
    c.fillRect(0, 0, layout.width, layout.height);
    const font = Math.max(12, Math.round(layout.cellW / 14));
    c.font = `600 ${font}px system-ui, sans-serif`;
    bitmaps.forEach((bitmap, i) => {
      const x = (i % layout.cols) * layout.cellW;
      const y = Math.floor(i / layout.cols) * layout.cellH;
      // Fit the frame into its cell, keeping its shape.
      const k = Math.min(layout.cellW / bitmap.width, layout.cellH / bitmap.height);
      const w = bitmap.width * k;
      const h = bitmap.height * k;
      c.drawImage(bitmap, x + (layout.cellW - w) / 2, y + (layout.cellH - h) / 2, w, h);
      bitmap.close();
      const label = clock(part[i].at);
      const pad = Math.round(font / 3);
      c.fillStyle = 'rgba(0, 0, 0, 0.75)';
      c.fillRect(x + 2, y + 2, c.measureText(label).width + pad * 2, font + pad * 2);
      c.fillStyle = '#ffffff';
      c.fillText(label, x + 2 + pad, y + 2 + pad + font * 0.85);
      c.strokeStyle = '#202124';
      c.strokeRect(x + 0.5, y + 0.5, layout.cellW - 1, layout.cellH - 1);
    });
    sheets.push({ mediaType: 'image/jpeg', data: await toBase64(await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 })) });
  }
  return sheets;
}

/**
 * The recorded sound (webm/opus, base64) → 16 kHz mono WAV (base64), and whether anything can be heard in it.
 * @param {string} base64
 */
async function soundToWav(base64) {
  const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
  const decoded = await new OfflineAudioContext(1, 1, SOUND_RATE).decodeAudioData(bytes.buffer);
  const length = Math.max(1, Math.ceil(decoded.duration * SOUND_RATE));
  const mono = new OfflineAudioContext(1, length, SOUND_RATE);
  const source = mono.createBufferSource();
  source.buffer = decoded;
  source.connect(mono.destination);
  source.start();
  const samples = (await mono.startRendering()).getChannelData(0);
  const silent = peakLevel(samples) < 0.003;
  return { silent, seconds: decoded.duration, data: silent ? '' : await toBase64(new Blob([encodeWav(samples, SOUND_RATE)])) };
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
