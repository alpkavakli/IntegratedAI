// @ts-check
// Options page: a three-step setup (choose an AI, connect it, open the AI tab) with everything
// else under "Advanced settings". Every field saves immediately; open panels pick up the change.

import { PROTOCOL_VERSION } from '../shared/protocol.js';
import { loadSettings, saveSettings } from '../panel/lib/settings.js';
import { PRESETS, baseUrlFor, presetFetch } from '../shared/providers/openai-compatible.js';

const $ = (/** @type {string} */ id) => /** @type {HTMLInputElement} */ (document.getElementById(id));
/** @param {string} id @param {boolean} hidden */
const hide = (id, hidden) => { /** @type {HTMLElement} */ ($(id)).hidden = hidden; };

if (matchMedia('(prefers-color-scheme: dark)').matches) document.documentElement.classList.add('dark');

const settings = await loadSettings();
$('serverUrl').value = settings.serverUrl;
$('token').value = settings.token;
$('executeJs').checked = settings.executeJs;
$('askBeforeInspections').checked = settings.askBeforeInspections;
$('webTools').checked = settings.webTools;
$('ctx-selected').checked = settings.contextDefaults.selected;
$('ctx-console').checked = settings.contextDefaults.console;
$('ctx-network').checked = settings.contextDefaults.network;
$('directModel').value = settings.directModel;
$('compatUrl').value = settings.providerUrls.ollama ?? '';

// ── Ollama's setup commands, each with a Copy button: for this computer's system, or the one picked
// above them (Windows / macOS / Linux).

/** @type {'windows' | 'mac' | 'linux'} */
let system = /Win/.test(navigator.platform) ? 'windows' : /Mac/.test(navigator.platform) ? 'mac' : 'linux';
/** What lets the extension use Ollama, and gives models room for its instructions (Ollama's default is too small). */
const OLLAMA_COMMANDS = {
  windows: ['setx OLLAMA_ORIGINS "chrome-extension://*"', 'setx OLLAMA_CONTEXT_LENGTH 16384'],
  mac: ['launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"', 'launchctl setenv OLLAMA_CONTEXT_LENGTH 16384'],
  linux: ['sudo systemctl edit ollama', '[Service]\nEnvironment="OLLAMA_ORIGINS=chrome-extension://*"\nEnvironment="OLLAMA_CONTEXT_LENGTH=16384"'],
};
function showOllamaSteps() {
  for (const button of document.querySelectorAll('#ollama-os button')) {
    button.setAttribute('aria-pressed', String(/** @type {HTMLElement} */ (button).dataset.os === system));
  }
  $('ollama-terminal').textContent = { windows: 'PowerShell', mac: 'Terminal', linux: 'a terminal' }[system];
  $('ollama-commands').replaceChildren(...OLLAMA_COMMANDS[system].map((text, i) => {
  const row = document.createElement('div');
  row.className = 'command';
  const code = document.createElement('code');
  code.textContent = text;
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'copy';
  copy.textContent = 'Copy';
  if (system === 'linux' && i === 1) {
    // systemctl edit opens an editor: these lines go into it.
    const note = document.createElement('div');
    note.className = 'hint';
    note.textContent = 'In the editor that opens, add these lines, save, then run: sudo systemctl restart ollama';
    row.append(code, copy);
    const wrap = document.createElement('div');
    wrap.append(note, row);
    return wrap;
  }
  row.append(code, copy);
  return row;
  }));
  $('ollama-restart').textContent = {
    windows: 'Quit Ollama (right-click its icon by the clock, then Quit) and start it again from the Start menu.',
    mac: 'Quit Ollama (its icon in the menu bar, then Quit Ollama) and open it again.',
    linux: 'If you used systemctl above, Ollama has restarted already. Otherwise, restart it.',
  }[system];
}
showOllamaSteps();
for (const button of document.querySelectorAll('#ollama-os button')) {
  button.addEventListener('click', () => {
    system = /** @type {any} */ (/** @type {HTMLElement} */ (button).dataset.os);
    showOllamaSteps();
  });
}
// Copy buttons: copy the command next to them.
document.addEventListener('click', async (e) => {
  const button = /** @type {HTMLElement} */ (e.target);
  if (!button.matches?.('.command .copy')) return;
  await navigator.clipboard.writeText(button.parentElement?.querySelector('code')?.textContent ?? '');
  button.textContent = 'Copied';
  setTimeout(() => { button.textContent = 'Copy'; }, 1500);
});

// ── Step 3: how to start, with this computer's shortcut, whether the icon is pinned, and a try-out.

chrome.commands.getAll().then((commands) => {
  const shortcut = commands.find((c) => c.name === '_execute_action')?.shortcut;
  if (shortcut) $('card-shortcut').textContent = shortcut;
  else $('card-shortcut-text').textContent = ' (you can give it a keyboard shortcut at chrome://extensions/shortcuts)';
}).catch(() => {});
chrome.action.getUserSettings?.().then((user) => {
  if (!user.isOnToolbar) return;
  $('pin-text').textContent = 'The IntegratedAI icon is pinned to your toolbar.';
  $('pin-use').classList.add('done');
}).catch(() => {});
$('try-card').addEventListener('click', () => chrome.runtime.sendMessage({ cmd: 'card.tryIt' }));

// ── Donations: shown once there is a page to donate on (GitHub Sponsors, Ko-fi, …).
// The × closes it for good (remembered in settings).
const DONATE_URL = '';
if (DONATE_URL && !settings.donateDismissed) {
  /** @type {HTMLAnchorElement} */ ($('donate-link')).href = DONATE_URL;
  hide('donate', false);
}
$('donate-close').addEventListener('click', () => {
  hide('donate', true);
  saveSettings({ donateDismissed: true });
});

// ── Step 1: which AI. "server" means the local agent server; everything else is direct mode.

/** Where each key-based provider hands out keys (Anthropic isn't in PRESETS). */
const KEY_PAGES = { anthropic: 'https://console.anthropic.com/settings/keys' };

/** The choice shown in step 1. */
let choice = settings.mode === 'server' ? 'server' : settings.directProvider;

/** The saved key for a provider. @param {string} provider */
const savedKey = (provider) => (provider === 'anthropic' ? settings.anthropicApiKey : settings.providerKeys[provider] ?? '');

/** Show step 2 for the chosen AI. */
function showChoice() {
  for (const input of /** @type {NodeListOf<HTMLInputElement>} */ (document.querySelectorAll('input[name="provider"]'))) {
    input.checked = input.value === choice;
  }
  const preset = PRESETS[choice];
  const keyBased = choice === 'anthropic' || (preset && !preset.local);
  hide('key-setup', !keyBased);
  hide('ollama-setup', choice !== 'ollama');
  hide('server-setup', choice !== 'server');
  $('step2-title').textContent = choice === 'ollama' ? 'Set up Ollama' : choice === 'server' ? 'Connect the agent server' : 'Paste your API key';
  $('test-key').textContent = keyBased ? 'Check key' : 'Check connection';
  setStatus('');
  markDone(false);

  if (keyBased) {
    const page = KEY_PAGES[/** @type {'anthropic'} */ (choice)] ?? preset.keyUrl;
    /** @type {HTMLAnchorElement} */ ($('key-link')).href = page;
    $('key-link').textContent = new URL(page).host;
    $('key-host').textContent = choice === 'anthropic' ? 'api.anthropic.com' : new URL(preset.baseUrl).host;
    $('apiKey').value = savedKey(choice);
  }

  // Model: a list of Claude models, or any model id for the others (suggestions from the preset or the key).
  hide('model-field', choice === 'server');
  hide('directModel', choice !== 'anthropic');
  hide('compatModel', choice === 'anthropic' || choice === 'server');
  if (preset) {
    $('compatModels').replaceChildren(...preset.models.map((m) => new Option(m, m)));
    $('compatModel').value = settings.providerModels[choice] || (preset.local ? '' : preset.models[0]);
    $('compatModel').placeholder = preset.local ? 'Chosen when you check the connection' : '';
  }

  // Already set up? Check it now, so the page shows it's ready.
  if ((keyBased && savedKey(choice)) || (choice === 'ollama' && settings.providerModels.ollama) || (choice === 'server' && settings.token)) {
    check();
  }
}

for (const input of /** @type {NodeListOf<HTMLInputElement>} */ (document.querySelectorAll('input[name="provider"]'))) {
  input.addEventListener('change', async () => {
    choice = input.value;
    if (choice === 'server') {
      settings.mode = 'server';
      await saveSettings({ mode: 'server' });
    } else {
      settings.mode = 'direct';
      settings.directProvider = choice;
      await saveSettings({ mode: 'direct', directProvider: choice });
    }
    showChoice();
    showDataSummary();
  });
}

// ── Step 2: the key (saved and checked as soon as it's pasted), or Ollama / the server.

/** @param {string} text @param {'ok' | 'bad' | ''} [kind] */
function setStatus(text, kind = '') {
  $('test-key-result').className = `status ${kind}`;
  $('test-key-result').textContent = text;
}

/** Step 2 done: tick it and point at step 3. @param {boolean} done */
function markDone(done) {
  $('step-2').classList.toggle('done', done);
  $('step-3').classList.toggle('done', false);
}

async function saveKey() {
  const key = $('apiKey').value.trim();
  if (choice === 'anthropic') {
    settings.anthropicApiKey = key;
    await saveSettings({ anthropicApiKey: key });
  } else {
    settings.providerKeys = { ...settings.providerKeys, [choice]: key };
    await saveSettings({ providerKeys: settings.providerKeys });
  }
}

let keyTimer = 0;
$('apiKey').addEventListener('input', () => {
  // Check shortly after pasting or typing stops.
  clearTimeout(keyTimer);
  keyTimer = /** @type {any} */ (setTimeout(async () => {
    await saveKey();
    if ($('apiKey').value.trim()) check();
    else setStatus('');
  }, 600));
});
$('token').addEventListener('input', () => {
  clearTimeout(keyTimer);
  keyTimer = /** @type {any} */ (setTimeout(async () => {
    settings.token = $('token').value.trim();
    await saveSettings({ token: settings.token });
    if (settings.token) check();
  }, 600));
});
$('directModel').addEventListener('change', async () => {
  settings.directModel = $('directModel').value;
  await saveSettings({ directModel: settings.directModel });
  if (savedKey('anthropic')) check();
});
/** @param {string} model */
const saveCompatModel = async (model) => {
  settings.providerModels = { ...settings.providerModels, [choice]: model };
  await saveSettings({ providerModels: settings.providerModels });
};
$('compatModel').addEventListener('change', () => saveCompatModel($('compatModel').value.trim()));
$('compatUrl').addEventListener('change', async () => {
  settings.providerUrls = { ...settings.providerUrls, ollama: $('compatUrl').value.trim() };
  await saveSettings({ providerUrls: settings.providerUrls });
});
$('serverUrl').addEventListener('change', () => saveSettings({ serverUrl: $('serverUrl').value.trim() }));
$('test-key').addEventListener('click', async () => {
  if (choice !== 'server' && choice !== 'ollama') await saveKey();
  check();
});

let checking = 0;
/** Check the chosen AI and show the result in plain words. */
async function check() {
  const run = ++checking;
  setStatus('Checking…');
  markDone(false);
  const result = await (choice === 'server' ? checkServer() : checkProvider(choice)).catch((err) => {
    const e = /** @type {any} */ (err);
    // The Anthropic SDK's errors carry a status; httpError() messages already say what to do.
    return {
      ok: false,
      text: e?.status === 401 ? 'This key was not accepted. Check that you copied all of it.'
        : e?.status === 404 ? 'The key works, but this model is not available to your account. Pick another model.'
          : String(e?.message ?? e),
    };
  });
  if (run !== checking) return; // a newer check started meanwhile
  setStatus(result.ok ? `✓ ${result.text} You're ready: see step 3.` : result.text, result.ok ? 'ok' : 'bad');
  markDone(result.ok);
}

/**
 * Anthropic: the official SDK (vendored) fetches the model's details.
 * Others: list the models the key can use (costs nothing) and check the chosen one is there.
 * Ollama: no key; list the downloaded models, and pick one if none is chosen yet.
 * @param {string} provider
 * @returns {Promise<{ ok: boolean, text: string }>}
 */
async function checkProvider(provider) {
  if (provider === 'anthropic') {
    if (!settings.anthropicApiKey) return { ok: false, text: 'Paste your API key first.' };
    const { default: Anthropic } = await import('../vendor/anthropic-sdk.mjs');
    const client = new Anthropic({ apiKey: settings.anthropicApiKey, dangerouslyAllowBrowser: true, maxRetries: 0 });
    const model = await client.models.retrieve($('directModel').value);
    return { ok: true, text: `Your key works (${model.display_name}).` };
  }
  const preset = PRESETS[provider];
  if (!preset.local && !savedKey(provider)) return { ok: false, text: 'Paste your API key first.' };
  const auth = { ...(preset.local ? {} : { authorization: `Bearer ${savedKey(provider)}` }), ...preset.headers };
  if (preset.keyCheckUrl) await presetFetch(provider, fetch, preset.keyCheckUrl, { headers: auth });
  const res = await presetFetch(provider, fetch, `${baseUrlFor(provider, { baseUrl: $('compatUrl').value })}/models`, { headers: auth });
  const ids = ((await res.json()).data ?? []).map((/** @type {any} */ m) => String(m.id).replace(/^models\//, '')).sort();
  $('compatModels').replaceChildren(...ids.map((id) => new Option(id, id)));
  if (preset.local) {
    if (!ids.length) return { ok: false, text: 'Ollama is running but has no models yet. Download one, for example: ollama pull qwen3' };
    if (!$('compatModel').value.trim()) {
      // Prefer a suggested model (known to use tools) if it's downloaded, e.g. "qwen3:latest".
      const pick = ids.find((m) => preset.models.some((s) => m === s || m.startsWith(`${s}:`))) ?? ids[0];
      $('compatModel').value = pick;
      await saveCompatModel(pick);
    }
  }
  const chosen = $('compatModel').value.trim();
  // Ollama names models "name:tag"; "qwen3" means "qwen3:latest".
  const found = ids.includes(chosen) || (preset.local && ids.includes(`${chosen}:latest`));
  if (!found) {
    return { ok: false, text: `${preset.local ? 'Ollama is running' : 'Your key works'}, but "${chosen}" isn't one of your ${ids.length} models. Pick one in the Model box.` };
  }
  if (provider !== 'ollama') return { ok: true, text: `Your key works (${chosen}).` };

  // Chrome sends the extension's Origin only with POST requests (like the chat requests), so listing
  // models can work while Ollama still refuses the chat. Ask about the model with a POST: that hits the
  // same origin check, and the answer says whether the model can use tools (and see screenshots).
  const root = baseUrlFor(provider, { baseUrl: $('compatUrl').value }).replace(/\/v1$/, '');
  const info = await (await presetFetch(provider, fetch, `${root}/api/show`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: chosen }),
  })).json();
  const caps = Array.isArray(info.capabilities) ? info.capabilities : null; // older Ollama versions don't say
  if (caps && !caps.includes('tools')) {
    return { ok: false, text: `Ollama is running, but ${chosen} can't use tools, which this extension needs. Pick another model (for example qwen3).` };
  }
  // The context window: Ollama only reports it for a model that has run (api/ps). Too small, and Ollama
  // silently cuts off the extension's instructions, so the model doesn't know what to do.
  const loaded = await presetFetch(provider, fetch, `${root}/api/ps`).then((r) => r.json()).catch(() => null) // (older versions: no api/ps)
    .then((ps) => ps?.models?.find((/** @type {any} */ m) => m.name === chosen || m.name === `${chosen}:latest`));
  if (loaded?.context_length && loaded.context_length < 8192) {
    return { ok: false, text: `Ollama is running, but it gives ${chosen} only ${loaded.context_length} tokens of context, too few for this extension's instructions. Do step 3 above (OLLAMA_CONTEXT_LENGTH) and restart Ollama.` };
  }
  return { ok: true, text: `Ollama is running (using ${chosen}${caps && !caps.includes('vision') ? "; it can't see screenshots" : ''}).` };
}

/**
 * Open a socket to the agent server, send hello, and report what it says.
 * @returns {Promise<{ ok: boolean, text: string }>}
 */
function checkServer() {
  return new Promise((resolve) => {
    if (!$('token').value.trim()) { resolve({ ok: false, text: 'Paste the pairing token first.' }); return; }
    let ws;
    try {
      ws = new WebSocket($('serverUrl').value.trim());
    } catch (err) {
      resolve({ ok: false, text: String(err) });
      return;
    }
    const timer = setTimeout(() => { ws.close(); resolve({ ok: false, text: 'The agent server did not answer.' }); }, 5000);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', token: $('token').value.trim(), protocol: PROTOCOL_VERSION }));
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      clearTimeout(timer);
      ws.close();
      resolve(msg.type === 'welcome' ? { ok: true, text: 'Connected to the agent server.' } : { ok: false, text: msg.message });
    };
    ws.onerror = () => {
      clearTimeout(timer);
      resolve({ ok: false, text: "Can't reach the agent server. Is it running (npm start)?" });
    };
  });
}

// ── Advanced settings

for (const input of /** @type {NodeListOf<HTMLInputElement>} */ (document.querySelectorAll('input[name="defaultAgentMode"]'))) {
  input.checked = input.value === settings.defaultAgentMode;
  input.addEventListener('change', () => saveSettings({ defaultAgentMode: /** @type {any} */ (input.value) }));
}
$('ollamaCompact').checked = settings.ollamaCompact;

// The panel's Server button (local server mode): its setup command, and the permission it needs.
$('services-command').textContent = `npm run services:install -- --id ${chrome.runtime.id}`;
const showServicesPermission = async () => {
  const granted = await chrome.permissions.contains({ permissions: ['nativeMessaging'] });
  $('services-allow').hidden = granted;
  $('services-status').textContent = granted ? 'Allowed.' : '';
};
$('services-allow').addEventListener('click', async () => {
  await chrome.permissions.request({ permissions: ['nativeMessaging'] }).catch(() => false);
  showServicesPermission();
});
showServicesPermission();
for (const id of ['executeJs', 'askBeforeInspections', 'webTools', 'ollamaCompact']) {
  $(id).addEventListener('change', () => saveSettings({ [id]: $(id).checked }));
}
for (const key of ['selected', 'console', 'network']) {
  $(`ctx-${key}`).addEventListener('change', () => saveSettings({
    contextDefaults: { selected: $('ctx-selected').checked, console: $('ctx-console').checked, network: $('ctx-network').checked },
  }));
}

// ───────────────────────────────────────────── Your data

/**
 * Ask the background service worker (it owns the extension's stored data).
 * @param {string} cmd
 * @param {Record<string, unknown>} [args]
 */
async function worker(cmd, args = {}) {
  const res = await chrome.runtime.sendMessage({ cmd, ...args });
  if (!res?.ok) throw new Error(res?.error ?? `${cmd} failed`);
  return res.value;
}

/** Ask the agent server where it keeps its data (data.info), using the saved settings. */
function serverDataInfo() {
  return new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WebSocket($('serverUrl').value.trim());
    } catch (err) {
      reject(err);
      return;
    }
    const timer = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 4000);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', token: $('token').value.trim(), protocol: PROTOCOL_VERSION }));
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'welcome') ws.send(JSON.stringify({ type: 'data.info', id: 1 }));
      else if (msg.type === 'data') { clearTimeout(timer); ws.close(); resolve(msg.info); }
      else if (msg.type === 'error') { clearTimeout(timer); ws.close(); reject(new Error(msg.message)); }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('unreachable')); };
  });
}

async function showDataSummary() {
  const summary = await worker('data.summary');
  $('data-extension').textContent = `${summary.patches} saved patch${summary.patches === 1 ? '' : 'es'}, ${count(summary.tasks ?? 0, 'saved task')} and your settings (extension ${summary.extensionVersion})`;
  if ((await loadSettings()).mode === 'direct') {
    $('data-extension').textContent += `; in direct mode also ${summary.conversations} conversation${summary.conversations === 1 ? '' : 's'} and site memory for ${summary.memorySites} site${summary.memorySites === 1 ? '' : 's'}`;
    // The server isn't used in direct mode, so its line is left out.
    /** @type {HTMLElement} */ ($('data-server-item')).hidden = true;
    return;
  }
  /** @type {HTMLElement} */ ($('data-server-item')).hidden = false;
  try {
    const info = /** @type {any} */ (await serverDataInfo());
    $('data-server').textContent =
      `${info.conversations} conversation${info.conversations === 1 ? '' : 's'} and site memory for ${info.memorySites} site${info.memorySites === 1 ? '' : 's'}, ` +
      `in ${info.dataDir}${info.backups ? ` (${info.backups} automatic backup${info.backups === 1 ? '' : 's'} in its "backups" folder)` : ''}`;
  } catch {
    $('data-server').textContent = 'not connected (start the server with npm start to see this)';
  }
}

/** "1 patch", "3 patches" @param {number} n @param {string} one @param {string} [many] */
const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** @param {string} text @param {boolean} [ok] */
function dataResult(text, ok = true) {
  $('data-result').className = ok ? 'ok' : 'bad';
  $('data-result').textContent = text;
}

$('export').addEventListener('click', async () => {
  try {
    const data = await worker('data.export');
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `integratedai-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    dataResult(`Exported ${count(data.patches.length, 'patch', 'patches')}, ${count(data.tasks.length, 'saved task')}, ${count(data.conversations.length, 'conversation')}, `
      + `site memory for ${count(data.memory.length, 'site')}, and your settings.`);
  } catch (err) {
    dataResult(String(/** @type {any} */ (err).message ?? err), false);
  }
});

$('import').addEventListener('change', async () => {
  const file = $('import').files?.[0];
  $('import').value = '';
  if (!file) return;
  try {
    const result = await worker('data.import', { data: JSON.parse(await file.text()) });
    dataResult(`Imported: ${result.added} new patch${result.added === 1 ? '' : 'es'}, ${result.updated} updated, ${result.skipped} already here`
      + `; ${count(result.tasks ?? 0, 'saved task')}, ${count(result.conversations, 'conversation')} and ${count(result.notes, 'memory note')}`
      + (result.settings.length ? '; settings restored.' : '.'));
    setTimeout(() => location.reload(), 1500); // show the imported settings
  } catch (err) {
    dataResult(`Import failed: ${String(/** @type {any} */ (err).message ?? err)}`, false);
  }
});

// Two clicks to delete (no native confirm dialogs).
$('clear').addEventListener('click', async () => {
  const button = $('clear');
  if (!button.dataset.armed) {
    button.dataset.armed = '1';
    button.textContent = 'Click again to delete everything stored in this browser';
    setTimeout(() => { delete button.dataset.armed; button.textContent = 'Delete extension data'; }, 4000);
    return;
  }
  try {
    await worker('data.clear');
    dataResult(settings.mode === 'server'
      ? 'Deleted. Your conversations and site memory on the agent server were not touched.'
      : 'Deleted.');
    setTimeout(() => location.reload(), 1500);
  } catch (err) {
    dataResult(String(/** @type {any} */ (err).message ?? err), false);
  }
});

// Last, so everything above is defined when the first check runs.
showChoice();
showDataSummary();
