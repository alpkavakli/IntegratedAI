// @ts-check
/**
 * Page check: runs the functions that work inside the page (page-scripts.js, page-interact.js)
 * in headless Chrome on a test page, the same way the panel runs them (as text, with the
 * DevTools console utilities), and checks what they return and do.
 *
 *   npm run page-check
 *
 * The test page has what tripped the agent up on real sites: rows of identical markup (like
 * GitHub's file list), a code viewer whose text is in a text area, a web component (shadow
 * DOM), a button covered by a banner, a disabled button, a modal dialog, a chat composer
 * that only trusts real input events, a link that opens a new tab, and an iframe.
 * No AI, no extension, no network. Exits with 1 if a check fails.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pageHelpers, findElements, pageOutline, readText, inspectElement } from '../extension/panel/lib/page-scripts.js';
import { interactStep, quietFor } from '../extension/panel/lib/page-interact.js';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const WORK = fs.mkdtempSync(join(tmpdir(), 'iai-page-check-'));
const PORTS = { page: 8776, cdp: 9356 };
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

const PAGE = `<!doctype html><html><head><title>Agent test page</title><style>
  body { font: 14px system-ui; margin: 16px; } .hide { display: none; } td { padding: 2px 8px; }
  #banner { position: fixed; left: 0; right: 0; bottom: 0; height: 60px; background: #eee; }
  #covered { position: fixed; bottom: 10px; left: 10px; }
</style></head><body>
<h1>Repository files</h1>
<table><tbody>
  ${['src', 'docs', 'README.md'].map((name) => `<tr class="react-directory-row">
    <td class="cell-large"><div><div><a class="Link--primary" href="/repo/tree/main/${name}" aria-label="${name}, (Directory)">${name}</a></div></div></td>
    <td class="cell-small hide"><a class="Link--primary" href="/repo/tree/main/${name}">${name}</a></td>
    <td>Last commit</td></tr>`).join('')}
</tbody></table>
<section id="code"><h2>orchestrator.js</h2>
  <textarea id="read-only-cursor-text-area" readonly aria-label="file content">export class Orchestrator {
  chat() {}
}</textarea>
  <pre>const a = 1;
  const b = 2;</pre></section>
<ul><li>First point</li><li>Second point</li></ul>
<p>Hidden: <span style="visibility:hidden">secret words</span> shown.</p>
<label>Name <input id="name"></label>
<div id="editor" contenteditable="true" aria-label="Message"></div>
<button id="off" disabled>Save</button>
<a id="ext" href="https://example.com/doc" target="_blank">Docs</a>
<x-card></x-card>
<iframe src="/frame.html" title="Embedded form" style="width:300px;height:80px"></iframe>
<dialog id="dlg"><p>Delete this file?</p><button>Cancel</button><button>Delete</button></dialog>
<button id="covered">Covered button</button><div id="banner">Cookie banner</div>
<div style="height:1500px"></div>
<script>
  window.log = [];
  document.querySelectorAll('a.Link--primary').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); log.push('open ' + a.getAttribute('href')); }));
  document.getElementById('covered').addEventListener('click', () => log.push('covered clicked'));
  // A chat composer like Telegram's: it keeps its own copy of the text and only updates it from
  // trusted input events (typing, the browser's editing commands), not from scripts changing the DOM.
  const editor = document.getElementById('editor');
  window.editorModel = '';
  editor.addEventListener('input', (e) => { if (e.isTrusted) window.editorModel = editor.innerText.trim(); });
  // A React-style field: the value only counts when an input event comes after it changed.
  document.getElementById('name').addEventListener('input', (e) => { window.nameEvents = (window.nameEvents || 0) + 1; window.nameTrusted = e.isTrusted; });
  customElements.define('x-card', class extends HTMLElement {
    connectedCallback() {
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = '<p>Shadow text</p><button>Like</button>';
      root.querySelector('button').addEventListener('click', () => log.push('liked'));
    }
  });
</script></body></html>`;

const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  if (req.url === '/frame.html') res.end('<!doctype html><title>Frame</title><button>Pay</button>');
  else res.end(PAGE);
}).listen(PORTS.page);

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORTS.cdp}`, `--user-data-dir=${join(WORK, 'chrome')}`,
  '--window-size=1000,800', 'about:blank'], { stdio: 'ignore' });
await sleep(2500);

// ── DevTools protocol (as in ui-check.mjs)
const version = await (await fetch(`http://127.0.0.1:${PORTS.cdp}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let nextId = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(String(e.data));
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
/** @returns {Promise<any>} */
const cdp = (/** @type {string} */ method, params = {}, /** @type {string | undefined} */ sessionId = undefined) => new Promise((resolve) => {
  const i = ++nextId;
  pending.set(i, resolve);
  ws.send(JSON.stringify({ id: i, method, params, sessionId }));
});
const targetId = (await cdp('Target.createTarget', { url: `http://127.0.0.1:${PORTS.page}/` })).result.targetId;
const session = (await cdp('Target.attachToTarget', { targetId, flatten: true })).result.sessionId;
await cdp('Runtime.enable', {}, session);
await sleep(1200);

/** Evaluate in the page (with the console utilities, like inspectedWindow.eval). */
const ev = async (/** @type {string} */ expression) => {
  const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, includeCommandLineAPI: true }, session);
  if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'exception');
  return r.result.result.value;
};
/** Like callInPage in inspected.js. */
const call = (/** @type {Function} */ fn, args = {}) =>
  ev(`(${fn.toString()})((${pageHelpers.toString()})(), typeof $0 === 'undefined' ? undefined : $0, ${JSON.stringify(args)})`);

let failures = 0;
const check = (/** @type {string} */ name, /** @type {boolean} */ ok, /** @type {unknown} */ detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n     ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};
const step = async (/** @type {any} */ s) => call(interactStep, { actionId: 'check', step: s });

try {
  // Rows of identical markup: every match needs its own selector and ref.
  const rows = await call(findElements, { selector: 'td.cell-large a.Link--primary' });
  const selectors = rows.matches.map((/** @type {any} */ m) => m.selector);
  check('find_elements: one distinct selector per row', new Set(selectors).size === 3, selectors);
  const unique = await ev(`${JSON.stringify(selectors)}.every((s) => document.querySelectorAll(s).length === 1)`);
  check('find_elements: each selector matches exactly one element', unique, selectors);
  check('find_elements: refs and plain names', rows.matches.every((/** @type {any} */ m) => /^e\d+$/.test(m.ref)) && /link "docs, \(Directory\)"/.test(rows.matches[1].name), rows.matches[1]);

  // Clicking by ref clicks exactly that row.
  await step({ action: 'click', ref: rows.matches[1].ref });
  check('click by ref: the right row', (await ev('log.at(-1)')) === 'open /repo/tree/main/docs', await ev('log'));

  // By text with several matches: the AI is told it got the first.
  const byText = await step({ action: 'click', text: 'src' });
  check('click by text: says when there were several matches', /first of \d+ matches/.test(byText.did) || !/matches/.test(byText.did), byText);

  // Reading: text areas (code viewers), pre, headings, lists; hidden text left out.
  const text = (await call(readText, {})).text;
  check('read_text: a code viewer\'s text area', text.includes('export class Orchestrator'), text);
  check('read_text: headings and list items', /^# Repository files$/m.test(text) && /^- First point$/m.test(text), text);
  check('read_text: <pre> keeps its lines and indent', /^ {2}const b = 2;$/m.test(text), text);
  check('read_text: table rows on one line', /src \| .*Last commit/.test(text), text);
  check('read_text: hidden text left out', !text.includes('secret words') && text.includes('shown.'), text);
  check('read_text: shadow DOM included', text.includes('Shadow text'), text);
  const part = await call(readText, { selector: '#code' });
  check('read_text: one element', part.text.startsWith('## orchestrator.js') && !part.text.includes('Repository'), part);

  // The outline: what's on screen, with refs, states and where links go.
  const outline = await call(pageOutline, {});
  const lines = outline.elements.join('\n');
  check('page_outline: fields, buttons, links with refs', /e\d+ the "Name" field/.test(lines) && /e\d+ button "Save" \(disabled\)/.test(lines), outline.elements);
  check('page_outline: link targets and new tabs', /→ \/repo\/tree\/main\/src/.test(lines) && /→ https:\/\/example.com\/doc \(opens a new tab\)/.test(lines), outline.elements);
  check('page_outline: shadow DOM buttons', /button "Like"/.test(lines), outline.elements);
  check('page_outline: frames', outline.frames?.[0]?.url === `http://127.0.0.1:${PORTS.page}/frame.html`, outline.frames);
  check('page_outline: headings and text', outline.headings?.[0] === 'Repository files' && /Repository files/.test(outline.text ?? ''), outline);

  // An open modal dialog: only its contents count.
  await ev('document.getElementById("dlg").showModal()');
  const modal = await call(pageOutline, {});
  check('page_outline: an open modal is all that is listed', !!modal.dialog && modal.elements.length === 2 && /Delete this file/.test(modal.text), modal);
  await ev('document.getElementById("dlg").close()');

  // Typing: a plain field and a chat composer both get trusted input events.
  await step({ action: 'type', text: 'Name', value: 'Sam Rivera' });
  check('type: field value and a trusted input event', (await ev('document.getElementById("name").value')) === 'Sam Rivera' && (await ev('window.nameTrusted')) === true,
    await ev('({ v: document.getElementById("name").value, n: window.nameEvents, t: window.nameTrusted })'));
  await step({ action: 'type', selector: '#editor', value: 'Hello there' });
  check('type: a chat composer takes it', (await ev('window.editorModel')) === 'Hello there', await ev('({ m: window.editorModel, t: document.getElementById("editor").textContent })'));
  await step({ action: 'type', selector: '#editor', value: 'Second try' });
  check('type: replaces what was there', (await ev('window.editorModel')) === 'Second try', await ev('window.editorModel'));

  // Shadow DOM, disabled, covered, new-tab links.
  await step({ action: 'click', text: 'Like' });
  check('click inside a shadow root by text', (await ev('log.at(-1)')) === 'liked', await ev('log'));
  const disabled = await step({ action: 'click', selector: '#off' }).then(() => 'clicked', (err) => String(err.message));
  check('click: a disabled button is reported, not clicked', /disabled/.test(disabled), disabled);
  await ev('scrollTo(0, 0)');
  const covered = await step({ action: 'click', selector: '#covered' });
  check('click: a covered button is clicked and the cover reported', /Cookie banner|was on top of it/.test(covered.did) && (await ev('log.at(-1)')) === 'covered clicked', covered);
  const external = await call(interactStep, { actionId: 'check', step: { action: 'click', selector: '#ext' }, dry: true });
  check('dry run: plain-words description', external.what === 'click link "Docs"', external);

  // Stale refs say so.
  const stale = await ev('document.querySelector("tr").remove()').then(() => step({ action: 'click', ref: rows.matches[0].ref })).then(() => 'clicked', (err) => String(err.message));
  check('a removed element\'s ref is reported as gone', /not on the page any more/.test(stale), stale);

  // Quiet: changes reset the timer; our own outline doesn't.
  await call(quietFor);
  await sleep(300);
  const quiet = await call(quietFor);
  await ev('document.body.append(document.createElement("p"))');
  const after = await call(quietFor);
  check('quietFor: measures the time since the last change', quiet.quietMs >= 250 && after.quietMs < 100, { quiet, after });

  // inspect_element by ref.
  const inspected = await call(inspectElement, { ref: rows.matches[1].ref, include: ['html'] });
  check('inspect_element by ref', /docs/.test(inspected.html), inspected);
} catch (err) {
  console.log(`FAIL ${err instanceof Error ? err.stack : err}`);
  failures++;
} finally {
  ws.close();
  chrome.kill();
  server.close();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll page checks passed');
process.exit(failures ? 1 : 0);
