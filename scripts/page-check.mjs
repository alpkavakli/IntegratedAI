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
import { pageHelpers, findElements, frameBox, pageOutline, readText, inspectElement, areaOverlay, areaStatus, areaRoots, describeSelected } from '../extension/panel/lib/page-scripts.js';
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
<div id="integratedai-card" style="position:fixed;right:0;bottom:0"><button>Card button</button> Card text</div>
<div style="height:1500px"></div>
<div id="area-test" style="position:absolute;left:20px;top:2200px;width:600px;height:120px">
  <div id="inside" style="position:absolute;left:0;top:0;width:250px;height:100px">Inside text <button id="in-btn">Inside button</button>
    <input type="hidden" name="csrf" value="abc123def456ghi789jkl012mno345pqr678"></div>
  <div id="outside" style="position:absolute;left:300px;top:0;width:250px;height:100px">Ahmet Yılmaz <button id="out-btn">Outside button</button></div>
</div>
<div id="scroller" style="position:absolute;left:20px;top:2400px;width:300px;height:150px;overflow:auto">
  <div style="height:600px"><p id="sp-top" style="margin:4px">Panel top text</p><p id="sp-low" style="margin:300px 4px 0">Panel low text</p></div>
</div>
<script>
  window.log = [];
  document.querySelectorAll('a.Link--primary').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); log.push('open ' + a.getAttribute('href')); }));
  document.getElementById('covered').addEventListener('click', () => log.push('covered clicked'));
  document.getElementById('in-btn').addEventListener('click', () => log.push('inside clicked'));
  document.getElementById('out-btn').addEventListener('click', () => log.push('outside clicked'));
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
/** Like callInPage with a marked area (page-access.js → setPageArea). */
const callArea = (/** @type {Function} */ fn, /** @type {any} */ scope, args = {}) =>
  ev(`(${fn.toString()})((${pageHelpers.toString()})(${JSON.stringify(scope)}), typeof $0 === 'undefined' ? undefined : $0, ${JSON.stringify(args)})`);
const refused = (/** @type {Promise<any>} */ p) => p.then((v) => `not refused: ${JSON.stringify(v)}`, (err) => String(err.message));

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

  // The card on the page is ours: no page tool sees it.
  const all = JSON.stringify([await call(readText, {}), await call(pageOutline, { all: true }), await call(findElements, { text: 'Card' })]);
  check('the card on the page is invisible to the page tools', !/Card (button|text)/.test(all), all.match(/.{40}Card.{40}/)?.[0]);

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

  const guessed = await step({ action: 'click', ref: 'e9999' }).then(() => 'clicked', (err) => String(err.message));
  check('a guessed ref is reported as never given out', /not a ref from this page/.test(guessed), guessed);

  // Quiet: changes reset the timer; our own outline doesn't.
  await call(quietFor);
  await sleep(300);
  const quiet = await call(quietFor);
  await ev('document.body.append(document.createElement("p"))');
  const after = await call(quietFor);
  check('quietFor: measures the time since the last change', quiet.quietMs >= 250 && after.quietMs < 100, { quiet, after });

  // A screenshot inside an iframe starts from where the frame's content is on the page.
  await ev('scrollTo(0, 0)');
  const fb = await call(frameBox, { url: `http://127.0.0.1:${PORTS.page}/frame.html` });
  const real = await ev(`(() => { const r = document.querySelector('iframe').getBoundingClientRect(); return { x: r.left + 2, y: r.top + 2 }; })()`);
  check('frameBox: the content area of the iframe (inside its border)', Math.abs(fb.box.x - real.x) < 1 && Math.abs(fb.box.y - real.y) < 1 && fb.box.width === 300, { fb, real });

  // inspect_element by ref.
  const inspected = await call(inspectElement, { ref: rows.matches[1].ref, include: ['html'] });
  check('inspect_element by ref', /docs/.test(inspected.html), inspected);

  // ── Only a marked area: nothing outside it reaches the AI, however it's asked for.
  const url = await ev('location.href.split("#")[0]');
  const box = (/** @type {number[]} */ [x0, y0, x1, y1]) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
  const area = { area: box([10, 2190, 290, 2310]), url }; // around #inside (20…270, 2200…2300), not #outside (320…)
  const inText = (await callArea(readText, area)).text;
  check('area: read_text has what is inside', inText.includes('Inside text') && inText.includes('Inside button'), inText);
  check('area: read_text has nothing outside (not the name next to it, not the page)', !inText.includes('Ahmet') && !inText.includes('Repository') && !inText.includes('Outside'), inText);
  const outFind = await callArea(findElements, area, { text: 'Outside button' });
  check('area: find_elements can not find what is outside', outFind.total === 0, outFind);
  const inFind = await callArea(findElements, area, { text: 'Inside button' });
  check('area: find_elements finds what is inside', inFind.total >= 1, inFind);
  const bySelector = await refused(callArea(inspectElement, area, { selector: '#out-btn' }));
  check('area: inspect_element refuses a selector outside', /inside the marked area|outside the area/.test(bySelector), bySelector);
  const outRef = (await call(findElements, { selector: '#out-btn' })).matches[0].ref; // a ref given out without the area
  const byRef = await refused(callArea(inspectElement, area, { ref: outRef }));
  check('area: a ref outside is refused', /outside the area/.test(byRef), byRef);
  const outClick = await callArea(interactStep, area, { actionId: 'check', step: { action: 'click', text: 'Outside button' } });
  check('area: the agent can not click outside', !outClick.found && !(await ev('log')).includes('outside clicked'), outClick);
  await callArea(interactStep, area, { actionId: 'check', step: { action: 'click', text: 'Inside button' } });
  check('area: the agent can click inside', (await ev('log')).includes('inside clicked'), await ev('log'));
  const html = (await callArea(inspectElement, area, { selector: '#inside', include: ['html'] })).html;
  check('area: HTML excerpts hide hidden-field values', html.includes('Inside button') && !html.includes('abc123'), html);
  const plainHtml = (await call(inspectElement, { selector: '#inside', include: ['html'] })).html;
  check('HTML excerpts hide hidden-field values (whole page too)', !plainHtml.includes('abc123'), plainHtml);
  const areaOutline = await callArea(pageOutline, area, { all: true });
  check('area: page_outline leaves out the address and title', !("url" in areaOutline) && !("title" in areaOutline) && Boolean(areaOutline.area), areaOutline);
  // A cut through an element: it's left out (when in doubt, out).
  const cut = (await callArea(readText, { area: box([10, 2190, 60, 2310]), url })).text;
  check('area: text only partly inside is left out', !cut.includes('Inside text'), cut);
  // A concave area whose corner pokes into #inside: #inside isn't completely inside, so it's not one of the roots.
  const notch = { area: [{ x: 10, y: 2190 }, { x: 290, y: 2190 }, { x: 290, y: 2310 }, { x: 150, y: 2310 }, { x: 145, y: 2250 }, { x: 140, y: 2310 }, { x: 10, y: 2310 }], url };
  const notchRoots = await callArea(areaRoots, notch);
  check('area: a corner poking into an element leaves it out', !notchRoots.includes('#inside'), notchRoots);
  const roots = await callArea(areaRoots, area);
  check('area: CSS and scripts are rooted at what is inside', roots.includes('#inside'), roots);
  // Another page (the AI navigated): everything is refused until the user confirms the area there.
  const wrongPage = await refused(callArea(readText, { ...area, url: 'http://127.0.0.1:1/other' }));
  check('area: on another page nothing is shown', /different page/.test(wrongPage), wrongPage);
  // (as $0: the element selected in the Elements panel)
  const sel = await ev(`(${describeSelected.toString()})((${pageHelpers.toString()})(${JSON.stringify(area)}), document.getElementById('out-btn'), {})`);
  check('area: a selected element outside is not described', typeof sel === 'string' && /outside the area/.test(sel), sel);

  // The editor: drag a rectangle, Enter = Done.
  await ev('scrollTo(0, 0)');
  await call(areaOverlay, { mode: 'edit' });
  const mouse = (/** @type {string} */ type, /** @type {number} */ x, /** @type {number} */ y) =>
    cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 }, session);
  const enter = () => cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, session);
  const logBefore = (await ev('log')).length;
  await mouse('mousePressed', 100, 100);
  await mouse('mouseMoved', 200, 160);
  await mouse('mouseMoved', 300, 250);
  await mouse('mouseReleased', 300, 250);
  await enter();
  const drawn = await call(areaStatus);
  check('area editor: drag a rectangle, Enter', drawn?.result === 'done' && drawn.points.length === 4 && drawn.points[0].x === 100 && drawn.points[2].y === 250, drawn);
  // Change it: drag a corner, then add one from the dot between the top corners.
  await call(areaOverlay, { mode: 'edit', points: drawn.points });
  await mouse('mousePressed', 300, 250);
  await mouse('mouseMoved', 340, 280);
  await mouse('mouseReleased', 340, 280);
  await mouse('mousePressed', 200, 100);
  await mouse('mouseMoved', 200, 60);
  await mouse('mouseReleased', 200, 60);
  await enter();
  const shaped = await call(areaStatus);
  check('area editor: drag a corner, add a corner', shaped?.points.length === 5 && shaped.points.some((/** @type {any} */ p) => p.x === 340 && p.y === 280) && shaped.points.some((/** @type {any} */ p) => p.x === 200 && p.y === 60), shaped);
  // Move it: drag inside.
  await call(areaOverlay, { mode: 'edit', points: shaped.points });
  await mouse('mousePressed', 200, 150);
  await mouse('mouseMoved', 230, 170);
  await mouse('mouseReleased', 230, 170);
  await enter();
  const moved = await call(areaStatus);
  check('area editor: drag inside moves it', moved?.points.every((/** @type {any} */ p, /** @type {number} */ i) => p.x === shaped.points[i].x + 30 && p.y === shaped.points[i].y + 20), moved);
  check('area editor: the page is not clicked meanwhile, and the outline stays', (await ev('log')).length === logBefore && (await ev('!!document.getElementById("integratedai-area")')) === true);
  await call(areaOverlay, { mode: 'off' });

  // ── An area in a panel that scrolls by itself (apps like Gmail or Blackboard): it moves with the content.
  const panelArea = { area: box([0, 0, 280, 60]), url, anchor: '#scroller' }; // the top of the panel's content
  const panelText = (await callArea(readText, panelArea)).text;
  check('scrolling panel: the area has the text at its top, not the text further down', panelText.includes('Panel top') && !panelText.includes('Panel low'), panelText);
  await ev('document.getElementById("scroller").scrollTop = 300');
  const scrolledText = (await callArea(readText, panelArea)).text;
  check('scrolling panel: after the panel scrolls, still the same text (the area moved with it)', scrolledText.includes('Panel top') && !scrolledText.includes('Panel low'), scrolledText);
  const gone = await refused(callArea(readText, { ...panelArea, anchor: '#no-such-panel' }));
  check('scrolling panel: if the panel is gone, nothing is shown', /different page/.test(gone), gone);
  // The editor: the wheel scrolls the panel under the pointer, and a rectangle drawn on the panel is attached to it.
  await ev('document.getElementById("scroller").scrollTop = 0; document.getElementById("scroller").scrollIntoView({ block: "center" })');
  const panelBox = await ev('(() => { const r = document.getElementById("scroller").getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; })()');
  await call(areaOverlay, { mode: 'edit' });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: panelBox.l + 100, y: panelBox.t + 60, deltaX: 0, deltaY: 120 }, session);
  await sleep(150);
  const wheeled = await ev('document.getElementById("scroller").scrollTop');
  check('area editor: the wheel scrolls the panel under the pointer', wheeled > 0, wheeled);
  await ev('document.getElementById("scroller").scrollTop = 0');
  await mouse('mousePressed', panelBox.l + 10, panelBox.t + 10);
  await mouse('mouseMoved', panelBox.l + 200, panelBox.t + 60);
  await mouse('mouseReleased', panelBox.l + 200, panelBox.t + 60);
  await enter();
  const anchored = await call(areaStatus);
  check('area editor: drawn on a scrolling panel, it is attached to the panel', anchored?.anchor === '#scroller' && anchored.points[0].y < 20, anchored);
  await call(areaOverlay, { mode: 'off' });
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
