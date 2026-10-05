// @ts-check
/**
 * UI check: drives the real panel and setup page in headless Chrome, saves a screenshot of
 * each state, and runs an accessibility audit (axe-core, WCAG 2 A/AA + best practices).
 *
 *   npm run ui-check              screenshots go to a temporary folder (printed at the end)
 *   npm run ui-check -- <folder>  or to that folder
 *
 * No API key and no real AI: the extension runs in direct mode against a scripted stand-in
 * for Ollama on this machine, which answers with text, a memory note and a CSS proposal.
 * Everything else is the real extension. Exits with 1 if the audit finds a violation or a
 * layout check fails (the audit can't see layout: sections side by side instead of stacked
 * passed it once).
 *
 * The AI panel normally lives inside DevTools, which headless Chrome can't automate, so it
 * runs in a tab with a small stand-in for chrome.devtools that forwards page evaluation to
 * the real page over the DevTools protocol (as in store-screenshots.mjs).
 *
 * Needs: Chrome installed, and network access once to download axe-core from jsDelivr.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const WORK = fs.mkdtempSync(join(tmpdir(), 'iai-ui-check-'));
const OUT = process.argv[2] ?? join(WORK, 'screens');
const PORTS = { pages: 8775, cdp: 9355, ollama: 11998 };
const AXE_URL = 'https://cdn.jsdelivr.net/npm/axe-core@4/axe.min.js';
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

// ── demo pages, the stand-in AI, Chrome

const pages = http.createServer((req, res) => {
  const file = join(root, 'store', 'demo-pages', String(req.url).split('?')[0].replace(/^\/+/, ''));
  if (!file.startsWith(join(root, 'store', 'demo-pages')) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(fs.readFileSync(file));
}).listen(PORTS.pages);

/**
 * Steps the stand-in takes in an agent mode, one per model call (it counts the tool results so far):
 * fill in the sign-up form, click "Reserve my spot" (a risky step: Auto mode asks), open another page, answer.
 */
const AGENT_SCRIPT = [
  ['interact', { description: 'Fill in the form', steps: [
    { action: 'type', selector: '#name', value: 'Sam Rivera' },
    { action: 'type', selector: '#email', value: 'sam@example.com' },
    { action: 'select', selector: '#workshop', value: 'Screen printing (Sun)' },
  ] }],
  ['interact', { description: 'Reserve the spot', steps: [{ action: 'click', text: 'Reserve my spot' }] }],
  ['navigate', { description: 'Open the pricing page', url: `http://127.0.0.1:${PORTS.pages}/pricing.html` }],
];

/**
 * Speaks the part of Ollama's API the extension uses. In Suggest mode every chat answer is the
 * same: an explanation, a site-memory note and a CSS proposal, streamed like the real thing.
 * In an agent mode it works through AGENT_SCRIPT.
 */
const ollama = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const json = (/** @type {unknown} */ value) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));
    if (req.url?.endsWith('/models')) return json({ data: [{ id: 'qwen3:latest' }] });
    if (req.url?.endsWith('/api/show')) return json({ capabilities: ['completion', 'tools', 'vision'] });
    if (!req.url?.endsWith('/chat/completions')) return res.writeHead(404).end();
    const send = (/** @type {unknown} */ chunk) => res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const request = JSON.parse(body);
    if (/Working on the page yourself/.test(request.messages[0].content)) {
      // Tool results since the user's message (screenshots come as user messages that start with an image note).
      const lastAsk = request.messages.findLastIndex((/** @type {any} */ m) => m.role === 'user' && typeof m.content === 'string');
      const step = AGENT_SCRIPT[request.messages.slice(lastAsk).filter((/** @type {any} */ m) => m.role === 'tool').length];
      if (step) {
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: 'function', function: { name: step[0], arguments: JSON.stringify(step[1]) } }] } }] });
        send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        send({ choices: [{ delta: { content: 'Done: you are signed up for screen printing, and the pricing page is open.' } }] });
        send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
      }
      return res.end('data: [DONE]\n\n');
    }
    const text = "**Why it's cut off:** `.plan .badge` sets `white-space: nowrap`, so the label stays on one line and is "
      + "**294px** wide, while its card only has **162px** inside and hides the overflow.\n\n**Fix:** let the badge wrap.";
    for (const piece of text.match(/.{1,40}/gs) ?? []) send({ choices: [{ delta: { content: piece } }] });
    const call = (/** @type {number} */ index, /** @type {string} */ name, /** @type {unknown} */ args) =>
      ({ index, id: `call_${name}_${Date.now()}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
    send({ choices: [{ delta: { tool_calls: [
      call(0, 'remember', { note: 'Pricing cards: .plan; badges: .plan .badge (nowrap by default)', scope: 'site' }),
      call(1, 'inject_css', { description: 'Let the plan badge wrap inside the card.', css: '.plan .badge {\n  white-space: normal;\n  max-width: 100%;\n}' }),
    ] } }] });
    send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
    send({ choices: [], usage: { prompt_tokens: 2400, completion_tokens: 180 } });
    res.end('data: [DONE]\n\n');
  });
}).listen(PORTS.ollama);

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORTS.cdp}`, '--enable-unsafe-extension-debugging',
  '--hide-scrollbars', `--user-data-dir=${join(WORK, 'chrome')}`, 'about:blank'], { stdio: 'ignore' });
const axe = await (await fetch(AXE_URL)).text();
await sleep(3000);

// ── DevTools protocol

const version = await (await fetch(`http://127.0.0.1:${PORTS.cdp}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let nextId = 0;
const pending = new Map();
/** @type {((m: any) => void)[]} */
const listeners = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(String(e.data));
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else listeners.forEach((l) => l(m));
});
/** @returns {Promise<any>} */
const cdp = (/** @type {string} */ method, params = {}, /** @type {string} */ sessionId = undefined) => new Promise((resolve, reject) => {
  const i = ++nextId;
  const timer = setTimeout(() => { pending.delete(i); reject(new Error(`${method} timed out`)); }, 30_000);
  pending.set(i, (/** @type {any} */ m) => { clearTimeout(timer); resolve(m); });
  ws.send(JSON.stringify({ id: i, method, params, sessionId }));
});
/** Evaluate in a tab and return the value (throws on an exception in the page). */
const ev = async (/** @type {string} */ session, /** @type {string} */ expression) => {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, includeCommandLineAPI: true }, session);
  if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description);
  return r.result.result.value;
};
const attach = async (/** @type {string} */ url) => {
  const targetId = (await cdp('Target.createTarget', { url })).result.targetId;
  const session = (await cdp('Target.attachToTarget', { targetId, flatten: true })).result.sessionId;
  await cdp('Runtime.enable', {}, session);
  await cdp('Page.enable', {}, session);
  return { targetId, session };
};
const viewport = (/** @type {string} */ session, /** @type {number} */ width, /** @type {number} */ height) =>
  cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, session);

const started = Date.now();
const log = (/** @type {string} */ text) => console.log(`[${String(Math.round((Date.now() - started) / 1000)).padStart(3)}s] ${text}`);

/** Screenshot a tab at a size (headless Chrome only captures the tab in front reliably). */
async function shot(/** @type {{ targetId: string, session: string }} */ tab, /** @type {string} */ name, width = 480, height = 760) {
  await viewport(tab.session, width, height);
  await cdp('Target.activateTarget', { targetId: tab.targetId });
  await sleep(500);
  const r = await cdp('Page.captureScreenshot', { format: 'png' }, tab.session);
  fs.writeFileSync(join(OUT, `${name}.png`), Buffer.from(r.result.data, 'base64'));
  log(`screenshot ${name}`);
}

/** @type {string[]} */
const violations = [];
/** Run axe-core in a tab and collect what it finds. */
async function audit(/** @type {string} */ session, /** @type {string} */ name) {
  await cdp('Runtime.evaluate', { expression: axe }, session);
  /** @type {string[]} */
  const found = await ev(session, `axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'best-practice'] }).then((r) =>
    r.violations.map((v) => v.impact + ' ' + v.id + ': ' + v.help + ' → ' + v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')))`);
  log(`audit ${name}: ${found.length ? `${found.length} violation(s)` : 'ok'}`);
  for (const v of found) violations.push(`${name}: ${v}`);
}

/**
 * Layout checks the audit can't do. Each check is an expression that returns '' when fine,
 * or what's wrong.
 * @param {string} session
 * @param {string} name
 * @param {string[]} checks
 */
async function checkLayout(session, name, checks) {
  for (const check of checks) {
    const problem = await ev(session, check);
    if (problem) violations.push(`${name}: layout: ${problem}`);
  }
  log(`layout ${name}`);
}
const PANEL_LAYOUT = [
  // The input box is at the bottom of the panel and as wide as it.
  `(() => { const c = document.getElementById('composer').getBoundingClientRect();
    return innerHeight - c.bottom > 4 ? 'the input box is not at the bottom' : c.width < innerWidth - 20 ? 'the input box is narrower than the panel' : ''; })()`,
  // The toolbar is two rows at most.
  `document.querySelector('.toolbar').getBoundingClientRect().height > 70 ? 'the toolbar takes more than two rows' : ''`,
];
const SETUP_LAYOUT = [
  // The three steps are stacked, each nearly as wide as the page column.
  `(() => { const s = [...document.querySelectorAll('.step')].map((e) => e.getBoundingClientRect());
    if (s.some((r) => r.width < 500)) return 'a step is narrower than 500px';
    return s.every((r, i) => i === 0 || r.top >= s[i - 1].bottom) ? '' : 'the steps are not stacked'; })()`,
];

// ── the extension, in direct mode with the stand-in AI

const extId = (await cdp('Extensions.loadUnpacked', { path: join(root, 'extension') })).result.id;
await sleep(1500);
const swTarget = (await cdp('Target.getTargets')).result.targetInfos.find((/** @type {any} */ t) => t.type === 'service_worker' && t.url.includes(extId));
const sw = (await cdp('Target.attachToTarget', { targetId: swTarget.targetId, flatten: true })).result.sessionId;
const useStandIn = () => ev(sw, `chrome.storage.local.set({ settings: { mode: 'direct', directProvider: 'ollama',
  providerModels: { ollama: 'qwen3' }, providerUrls: { ollama: 'http://127.0.0.1:${PORTS.ollama}/v1' } } })`);

/**
 * Open a demo page, select an element in it, and open an AI panel for it.
 * @param {string} file demo page
 * @param {string} select CSS selector to select as $0
 * @param {'dark' | 'default'} theme DevTools theme
 */
async function openPanel(file, select, theme) {
  const url = `http://127.0.0.1:${PORTS.pages}/${file}`;
  const page = await attach(url);
  await cdp('DOM.enable', {}, page.session);
  await sleep(1200);
  // The newest tab with this page (an earlier scenario may have the same page open).
  const tabId = await ev(sw, `chrome.tabs.query({}).then(t => t.findLast(x => x.url === ${JSON.stringify(url)}).id)`);
  const { root: doc } = (await cdp('DOM.getDocument', {}, page.session)).result;
  const node = (await cdp('DOM.querySelector', { nodeId: doc.nodeId, selector: select }, page.session)).result.nodeId;
  await cdp('DOM.setInspectedNode', { nodeId: node }, page.session);

  const panel = await attach('about:blank');
  await cdp('Runtime.addBinding', { name: '__evalBridge' }, panel.session);
  listeners.push(async (m) => {
    if (m.method !== 'Runtime.bindingCalled' || m.sessionId !== panel.session) return;
    const { id, expr } = JSON.parse(m.params.payload);
    const r = await cdp('Runtime.evaluate', { expression: expr, includeCommandLineAPI: true, returnByValue: true }, page.session);
    const exc = r.result.exceptionDetails ? { isException: true, value: r.result.exceptionDetails.exception?.description } : undefined;
    const value = exc ? undefined : r.result.result.value;
    await cdp('Runtime.evaluate', { expression: `__resolveEval(${id}, ${value === undefined ? 'undefined' : JSON.stringify(value)}, ${exc ? JSON.stringify(exc) : 'undefined'})` }, panel.session);
  });
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__pend = {}; let __n = 0;
    window.__resolveEval = (i, result, exc) => { __pend[i](result, exc); delete __pend[i]; };
    const noop = { addListener() {} };
    chrome.devtools = {
      inspectedWindow: { tabId: ${tabId}, eval(expr, opts, cb) { const i = ++__n; __pend[i] = cb; __evalBridge(JSON.stringify({ id: i, expr })); }, getResources(cb) { cb([]); } },
      panels: { themeName: ${JSON.stringify(theme)}, elements: { onSelectionChanged: noop }, openResource() {} },
      network: { onNavigated: noop, getHAR(cb) { cb({ entries: [] }); } },
    };` }, panel.session);
  await cdp('Page.navigate', { url: `chrome-extension://${extId}/panel/panel.html` }, panel.session);
  await sleep(2500);
  const ui = (/** @type {string} */ expr) => ev(panel.session, expr);
  return {
    page, panel, ui,
    /** Send a message and wait until the answer is in. @param {string} text */
    async ask(text) {
      await ui(`document.getElementById('prompt').value = ${JSON.stringify(text)}; document.getElementById('composer').requestSubmit()`);
      for (let i = 0; i < 60 && !(await ui(`!!document.querySelector('ai-action-card') && !document.querySelector('.thinking')`)); i++) await sleep(500);
      await sleep(800);
    },
    /** Click a button on the newest action card by its label. @param {string} label */
    click: (label) => ui(`(() => { const cards = document.querySelectorAll('ai-action-card'); const b = [...cards[cards.length - 1].querySelectorAll('button')].find(b => b.textContent.trim().startsWith(${JSON.stringify(label)})); b?.click(); return !!b; })()`),
    /** @param {string} tab */
    showTab: (tab) => ui(`document.querySelector('[data-tab=${tab}]').click()`),
  };
}

// ── the tour

let failed = false;
try {
  await useStandIn();
  const dark = await openPanel('pricing.html', '.plan .badge', 'dark');
  await shot(dark.panel, 'panel-01-start-dark');
  await dark.ask('Why is this badge cut off? Fix it so the whole label is visible.');
  await shot(dark.panel, 'panel-02-answer-dark');
  await audit(dark.panel.session, 'panel answer (dark)');
  await checkLayout(dark.panel.session, 'panel answer (dark)', PANEL_LAYOUT);
  await dark.click('Preview'); await sleep(800);
  await dark.click('Apply'); await sleep(1000);
  await dark.click('Save as site patch'); await sleep(600);
  await shot(dark.panel, 'panel-03-save-form-dark');
  await dark.click('Save patch'); await sleep(1200);
  await ev(dark.page.session, `console.error('TypeError: Cannot read properties of undefined (reading "price")')`);
  await sleep(800);
  for (const tab of ['patches', 'console', 'memory']) {
    await dark.showTab(tab); await sleep(800);
    await shot(dark.panel, `panel-04-${tab}-dark`);
    await audit(dark.panel.session, `panel ${tab} tab (dark)`);
  }
  await dark.showTab('chat');
  await dark.ui(`document.getElementById('history-button').click()`); await sleep(1000);
  await shot(dark.panel, 'panel-05-history-dark');

  const light = await openPanel('signup.html', '#signup', 'default');
  await shot(light.panel, 'panel-06-start-light-narrow', 360, 700);
  await light.ask('Why is this cut off?');
  await shot(light.panel, 'panel-07-answer-light-narrow', 360, 700);
  await audit(light.panel.session, 'panel answer (light, narrow)');
  await checkLayout(light.panel.session, 'panel answer (light, narrow)', PANEL_LAYOUT);

  // Agent mode: the AI fills in a form, asks before the risky click, then opens another page.
  const agent = await openPanel('signup.html', '#signup', 'default');
  await viewport(agent.page.session, 700, 600); // before the steps, so the outline matches the page in the screenshot
  await agent.ui(`(() => { const s = document.getElementById('agent-mode'); s.value = 'auto'; s.dispatchEvent(new Event('change')); })()`);
  await sleep(800);
  await shot(agent.panel, 'panel-09-auto-mode-start-light');
  await agent.ui(`document.getElementById('prompt').value = 'Sign me up for screen printing as Sam Rivera, sam@example.com'; document.getElementById('composer').requestSubmit()`);
  for (let i = 0; i < 60 && !(await agent.ui(`!!document.querySelector('.ask-step')`)); i++) await sleep(250);
  const asked = await agent.ui(`document.querySelector('.ask-step')?.innerText ?? ''`);
  const badgeWhileWorking = await ev(agent.page.session, `!!document.getElementById('integratedai-working')`);
  if (!badgeWhileWorking) violations.push('agent: no "working… Stop" badge on the page during the turn');
  const typedWithoutAsking = await ev(agent.page.session, `document.getElementById('name').value + ' / ' + document.getElementById('email').value`);
  await shot(agent.panel, 'panel-10-auto-mode-asks-light');
  await shot(agent.page, 'page-10-highlight', 700, 600);
  await agent.ui(`[...document.querySelectorAll('.ask-step button')].find((b) => b.textContent === 'Allow').click()`);
  for (let i = 0; i < 80 && !(await agent.ui(`!document.querySelector('.thinking') && /Done: you are signed up/.test(document.getElementById('chat').innerText)`)); i++) await sleep(250);
  await shot(agent.panel, 'panel-11-auto-mode-done-light');
  const pageNow = await ev(agent.page.session, 'location.pathname');
  const lines = await agent.ui(`[...document.querySelectorAll('.activity')].map((l) => l.textContent)`);
  log(`agent: asked "${asked.replace(/\s+/g, ' ')}"; typed "${typedWithoutAsking}"; now on ${pageNow}`);
  for (const line of lines) log(`  ${line}`);
  if (!/Reserve my spot/.test(asked) || !/submits a form/.test(asked)) violations.push(`agent: the risky click was not asked about (${asked})`);
  if (typedWithoutAsking !== 'Sam Rivera / sam@example.com') violations.push(`agent: typing didn't run on its own (${typedWithoutAsking})`);
  if (pageNow !== '/pricing.html') violations.push(`agent: it didn't open the next page (${pageNow})`);
  await audit(agent.panel.session, 'panel, Auto mode (light)');
  await sleep(1000);
  if (await ev(agent.page.session, `!!document.getElementById('integratedai-working')`)) violations.push('agent: the badge stayed after the turn');

  // Stop on the page: a new task, then the badge's Stop (its shadow root is closed, so set what its click sets).
  await agent.ui(`document.getElementById('new-chat').click()`);
  await sleep(1500);
  await agent.ui(`document.getElementById('prompt').value = 'Sign me up again'; document.getElementById('composer').requestSubmit()`);
  await sleep(1200);
  await ev(agent.page.session, `window[Symbol.for('integratedai.state')].stopRequested = true`);
  let stopped = false;
  for (let i = 0; i < 20 && !(stopped = await agent.ui(`document.getElementById('send').textContent === '↑'`)); i++) await sleep(250);
  log(`agent: Stop on the page ${stopped ? 'stopped the turn' : 'did NOT stop the turn'}`);
  if (!stopped) violations.push('agent: Stop on the page did not stop the turn');

  // Nothing set up yet: the panel's first-run screen.
  await ev(sw, `chrome.storage.local.set({ settings: { mode: 'direct', directProvider: 'anthropic' } })`);
  const none = await openPanel('blog.html', 'article p', 'dark');
  await shot(none.panel, 'panel-08-not-set-up-dark');
  await audit(none.panel.session, 'panel not set up (dark)');

  // The setup page: first visit (both themes), then Ollama connected with Advanced settings open.
  for (const scheme of ['light', 'dark']) {
    await ev(sw, `chrome.storage.local.set({ settings: {} })`);
    const options = await attach(`chrome-extension://${extId}/options/options.html`);
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }, options.session);
    await cdp('Page.reload', {}, options.session);
    await sleep(1500);
    await shot(options, `setup-01-first-${scheme}`, 900, 1000);
    await audit(options.session, `setup page (${scheme})`);
    await checkLayout(options.session, `setup page (${scheme})`, SETUP_LAYOUT);
  }
  await useStandIn();
  const options = await attach(`chrome-extension://${extId}/options/options.html`);
  await sleep(1500);
  await ev(options.session, `document.getElementById('test-key').click()`);
  await sleep(1500);
  await ev(options.session, `document.querySelector('details.advanced').open = true`);
  await shot(options, 'setup-02-ollama-ready-advanced', 900, 1700);
  await audit(options.session, 'setup page, Ollama ready, advanced settings');
  await checkLayout(options.session, 'setup page, Ollama ready', SETUP_LAYOUT);
} catch (err) {
  failed = true;
  console.error(err);
} finally {
  ws.close();
  chrome.kill();
  pages.close();
  ollama.close();
}

console.log(`\nScreenshots: ${OUT}`);
if (violations.length) console.log(`Problems:\n  ${violations.join('\n  ')}`);
else if (!failed) console.log('Accessibility and layout: no problems.');
process.exit(failed || violations.length ? 1 : 0);
