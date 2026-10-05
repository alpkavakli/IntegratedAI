// @ts-check
/**
 * Chrome Web Store screenshots (1280×800) from real use of the extension:
 *
 *   node scripts/store-screenshots.mjs
 *
 * Starts the agent server (temporary data folder, your Claude Code login), headless
 * Chrome with the unpacked extension, and the demo pages in store/demo-pages/. For each
 * scenario it asks the AI something real, applies the result, and captures the page and
 * the AI panel. store/screenshot-frame.html lays them out; output: store/screenshots/.
 *
 * The AI panel normally lives inside DevTools, which headless Chrome can't automate, so
 * it runs in a tab with a small stand-in for chrome.devtools that forwards page
 * evaluation to the real page over the DevTools protocol. Everything else is real.
 *
 * Needs: Chrome installed, Claude Code logged in. Each run makes a few real AI calls.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = join(root, 'store', 'screenshots');
const WORK = fs.mkdtempSync(join(tmpdir(), 'iai-shots-'));
const PORTS = { server: 7998, pages: 8771, cdp: 9343 };
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

// ── demo pages, agent server, Chrome
const pages = http.createServer((req, res) => {
  const file = join(root, 'store', 'demo-pages', String(req.url).split('?')[0].replace(/^\/+/, ''));
  if (!file.startsWith(join(root, 'store', 'demo-pages')) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(fs.readFileSync(file));
}).listen(PORTS.pages);
const home = join(WORK, 'home');
fs.mkdirSync(home);
fs.writeFileSync(join(home, 'config.json'), JSON.stringify({ port: PORTS.server, token: 'screenshots', providers: { 'claude-cli': { model: 'default' } } }));
const server = spawn(process.execPath, [join(root, 'server/src/index.js')], { env: { ...process.env, INTEGRATEDAI_HOME: home }, stdio: 'ignore' });
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORTS.cdp}`, '--enable-unsafe-extension-debugging', '--hide-scrollbars', `--user-data-dir=${join(WORK, 'chrome')}`, 'about:blank'], { stdio: 'ignore' });
await sleep(3000);

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
/**
 * One DevTools-protocol call. Times out instead of hanging (a stuck step then shows up in the log).
 * @returns {Promise<any>}
 */
const cdp = (/** @type {string} */ method, params = {}, /** @type {string} */ sessionId = undefined, timeoutMs = 30_000) => new Promise((resolve, reject) => {
  const i = ++nextId;
  const timer = setTimeout(() => { pending.delete(i); reject(new Error(`${method} timed out`)); }, timeoutMs);
  pending.set(i, (/** @type {any} */ m) => { clearTimeout(timer); resolve(m); });
  ws.send(JSON.stringify({ id: i, method, params, sessionId }));
});
const started = Date.now();
const log = (/** @type {string} */ text) => console.log(`[${String(Math.round((Date.now() - started) / 1000)).padStart(4)}s] ${text}`);
const ev = async (/** @type {string} */ session, /** @type {string} */ expression) => {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, includeCommandLineAPI: true }, session);
  return r.result.exceptionDetails ? { error: r.result.exceptionDetails.exception?.description } : r.result.result.value;
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
/**
 * Screenshot one tab. Headless Chrome only captures the tab in front reliably
 * (a background tab's capture can hang), so bring it forward first.
 * @param {{ targetId: string, session: string }} target
 * @param {string} file
 */
const capture = async (target, file) => {
  await cdp('Target.activateTarget', { targetId: target.targetId });
  await sleep(300);
  const r = await cdp('Page.captureScreenshot', { format: 'png' }, target.session);
  fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
  return pathToFileURL(file).href;
};

const extId = (await cdp('Extensions.loadUnpacked', { path: join(root, 'extension') })).result.id;
await sleep(1500);
const swTarget = (await cdp('Target.getTargets')).result.targetInfos.find((/** @type {any} */ t) => t.type === 'service_worker' && t.url.includes(extId));
const sw = (await cdp('Target.attachToTarget', { targetId: swTarget.targetId, flatten: true })).result.sessionId;
await ev(sw, `chrome.storage.local.set({ settings: { mode: 'server', serverUrl: 'ws://127.0.0.1:${PORTS.server}/ws', token: 'screenshots' } })`);

/**
 * Open a demo page and an AI panel for it (chrome.devtools stand-in bridged to the page).
 * @param {string} file demo page
 * @param {string} select CSS selector to select as $0
 * @param {'dark' | 'default'} theme
 */
async function openScenario(file, select, theme) {
  const url = `http://127.0.0.1:${PORTS.pages}/${file}`;
  const page = await attach(url);
  await cdp('DOM.enable', {}, page.session);
  await viewport(page.session, 700, 736);
  await sleep(1200);
  const tabId = await ev(sw, `chrome.tabs.query({}).then(t => t.find(x => x.url === ${JSON.stringify(url)}).id)`);
  const { root: doc } = (await cdp('DOM.getDocument', {}, page.session)).result;
  const node = (await cdp('DOM.querySelector', { nodeId: doc.nodeId, selector: select }, page.session)).result.nodeId;
  await cdp('DOM.setInspectedNode', { nodeId: node }, page.session);

  const panel = await attach('about:blank');
  await viewport(panel.session, 580, 706);
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
  await sleep(3000);

  const ui = (/** @type {string} */ expr) => ev(panel.session, expr);
  return {
    page, panel, ui,
    /** Send a message and wait for the answer (an action card). @param {string} text */
    async ask(text) {
      await ui(`document.getElementById('prompt').value = ${JSON.stringify(text)}; document.getElementById('composer').requestSubmit()`);
      await cdp('Target.activateTarget', { targetId: page.targetId });
      for (let i = 0; i < 240; i++) {
        await sleep(1000);
        if (await ui(`!!document.querySelector('ai-action-card') && !document.querySelector('.thinking')`)) break;
      }
      await sleep(800);
    },
    /** Click a button on the first action card by its label. @param {string} label */
    click: (label) => ui(`(() => { const b = [...document.querySelectorAll('ai-action-card button')].find(b => b.textContent.trim().startsWith(${JSON.stringify(label)})); if (!b) return false; b.click(); return true; })()`),
    /** Scroll the chat so the newest action card's top is near the top of the panel (long answers push it down). */
    async scrollToCard() {
      await ui(`(() => { const chat = document.getElementById('chat'); const cards = chat.querySelectorAll('ai-action-card'); const card = cards[cards.length - 1]; if (card) chat.scrollTop = card.offsetTop - 140; })()`);
      await sleep(300);
    },
    /** Scroll the chat so the newest answer and its card are in view. */
    async scrollChat() {
      await ui(`(() => { const chat = document.getElementById('chat'); const msgs = chat.querySelectorAll('.msg.user'); const last = msgs[msgs.length - 1]; chat.scrollTop = last ? last.offsetTop - 8 : 0; })()`);
      await sleep(300);
    },
    async shoot(/** @type {string} */ name, /** @type {string} */ caption) {
      await cdp('Target.activateTarget', { targetId: page.targetId });
      await sleep(400);
      const pagePng = await capture(page, join(WORK, `${name}-page.png`));
      const panelPng = await capture(panel, join(WORK, `${name}-panel.png`));
      await compose(name, caption, pagePng, panelPng, theme === 'dark' ? 'dark' : 'light');
    },
  };
}

/** Lay out the captures with a caption and save the final 1280×800 screenshot. */
async function compose(/** @type {string} */ name, /** @type {string} */ caption, /** @type {string} */ pagePng, /** @type {string | null} */ panelPng, theme = 'dark') {
  const frame = pathToFileURL(join(root, 'store', 'screenshot-frame.html')).href;
  const params = new URLSearchParams({ caption, page: pagePng, theme, ...(panelPng ? { panel: panelPng } : {}) });
  const frameTab = await attach(`${frame}?${params}`);
  await viewport(frameTab.session, 1280, 800);
  await sleep(800);
  await capture(frameTab, join(OUT, `${name}.png`));
  log(`saved store/screenshots/${name}.png`);
}

/** @type {Record<string, () => Promise<void>>} Scenarios by output name; run all, or the names given as arguments. */
const SCENARIOS = {
  // Diagnose a layout bug and preview the fix.
  '01-diagnose': async () => {
    const pricing = await openScenario('pricing.html', '.plan .badge', 'dark');
    log('asking');
    await pricing.ask('Why is this badge cut off? Fix it so the whole label is visible.');
    log('preview');
    await pricing.click('Preview');
    await sleep(1200);
    await pricing.scrollChat();
    await pricing.shoot('01-diagnose', 'Ask about any element — get the cause and a fix you can preview');
  },

  // A dark reading theme with an on/off button in the nav bar, saved for the site; then its Memory tab.
  '02-theme-toggle': async () => {
    const blog = await openScenario('blog.html', 'article p', 'dark');
    log('asking');
    await blog.ask('Add a toggle in the nav bar that switches this blog to a soft dark reading theme.');
    log('apply + save');
    await blog.click('Apply');
    await sleep(1200);
    await blog.click('Save as site patch');
    await sleep(500);
    // All demo pages share one origin: save for this page only, so the theme doesn't spill onto the others.
    await blog.ui(`(() => { const s = document.querySelector('ai-action-card .save-form select'); s.value = 'prefix'; s.dispatchEvent(new Event('change')); })()`);
    await blog.click('Save patch');
    await sleep(2000);
    await blog.scrollToCard();
    await blog.shoot('02-theme-toggle', 'Themes and fixes, saved per site — with an on/off button on the page');
    log('memory tab');
    await blog.ui(`document.querySelector('[data-tab=memory]').click()`);
    await sleep(1500);
    await blog.shoot('04-memory', 'Remembers each site, so the next conversation starts informed');
  },

  // Auto mode: it fills in the form by itself and asks before submitting (the button is outlined on the page).
  '03-forms': async () => {
    const signup = await openScenario('signup.html', '#signup', 'dark');
    await signup.ui(`(() => { const m = document.getElementById('agent-mode'); m.value = 'auto'; m.dispatchEvent(new Event('change')); })()`);
    await sleep(800);
    log('asking (Auto mode)');
    await signup.ui(`document.getElementById('prompt').value = ${JSON.stringify("Sign me up for screen printing: name Sam Rivera, email sam@example.com, I'm new to this, no newsletter. Then reserve my spot.")}; document.getElementById('composer').requestSubmit()`);
    await cdp('Target.activateTarget', { targetId: signup.page.targetId });
    for (let i = 0; i < 240 && !(await signup.ui(`!!document.querySelector('.ask-step')`)); i++) await sleep(1000);
    await sleep(600);
    await signup.shoot('03-forms', 'Works through tasks on the page by itself — and asks before anything risky');
    await signup.ui(`[...document.querySelectorAll('.ask-step button')].find((b) => b.textContent === 'Allow')?.click()`);
  },

  // Options: choose how to connect.
  // The setup page as a new user first sees it (a key would be checked right away, and a made-up one fails).
  '05-options': async () => {
    await ev(sw, `chrome.storage.local.get('settings').then(({ settings }) => chrome.storage.local.set({ settings: { ...settings, mode: 'direct', directProvider: 'anthropic', anthropicApiKey: '' } }))`);
    const options = await attach(`chrome-extension://${extId}/options/options.html`);
    await viewport(options.session, 1280, 736);
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }, options.session);
    await sleep(1500);
    const optionsPng = await capture(options, join(WORK, 'options.png'));
    await compose('05-options', 'Your own API key, free local models with Ollama, or your Claude subscription', optionsPng, null);
  },
};

// Small promo tile (440×280) from store/promo-tile.html; no AI involved.
SCENARIOS['promo-tile'] = async () => {
  const tile = await attach(pathToFileURL(join(root, 'store', 'promo-tile.html')).href);
  await viewport(tile.session, 440, 280);
  await sleep(800);
  await capture(tile, join(OUT, 'promo-tile-440x280.png'));
  log('saved store/screenshots/promo-tile-440x280.png');
};

const wanted = process.argv.slice(2);
const failures = [];
try {
  for (const [name, run] of Object.entries(SCENARIOS)) {
    if (wanted.length && !wanted.includes(name)) continue;
    log(`── ${name}`);
    try {
      await run();
    } catch (err) {
      // One broken scenario shouldn't block the others.
      failures.push(name);
      log(`${name} FAILED: ${/** @type {any} */ (err)?.message ?? err}`);
    }
  }
  log(failures.length ? `done, failed: ${failures.join(', ')}` : 'done');
} finally {
  ws.close();
  chrome.kill();
  server.kill();
  pages.close();
}
