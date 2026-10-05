// @ts-check
// Options page: every field saves immediately; open panels pick up the change.

import { PROTOCOL_VERSION } from '../shared/protocol.js';
import { loadSettings, saveSettings } from '../panel/lib/settings.js';
import { PRESETS, baseUrlFor, presetFetch } from '../shared/providers/openai-compatible.js';

const $ = (/** @type {string} */ id) => /** @type {HTMLInputElement} */ (document.getElementById(id));

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

// ── Connection: direct (API key) or the local agent server
const showMode = (/** @type {string} */ mode) => {
  $('mode-direct').checked = mode === 'direct';
  $('mode-server').checked = mode === 'server';
  /** @type {HTMLElement} */ ($('direct-section')).hidden = mode !== 'direct';
  /** @type {HTMLElement} */ ($('server-section')).hidden = mode !== 'server';
};
showMode(settings.mode);
$('anthropicApiKey').value = settings.anthropicApiKey;
$('directModel').value = settings.directModel;
for (const id of ['mode-direct', 'mode-server']) {
  $(id).addEventListener('change', async () => {
    const mode = $(id).value;
    await saveSettings({ mode: /** @type {any} */ (mode) });
    showMode(mode);
    showDataSummary();
  });
}
$('anthropicApiKey').addEventListener('change', () => saveSettings({ anthropicApiKey: $('anthropicApiKey').value.trim() }));
$('directModel').addEventListener('change', () => saveSettings({ directModel: $('directModel').value }));

// ── Which direct-mode provider; key and model fields for it
/** Show the fields for one provider (Anthropic has its own; the others share one set). @param {string} provider */
const showProvider = (provider) => {
  $('directProvider').value = provider;
  /** @type {HTMLElement} */ ($('anthropic-fields')).hidden = provider !== 'anthropic';
  /** @type {HTMLElement} */ ($('compat-fields')).hidden = provider === 'anthropic';
  $('test-key-result').textContent = '';
  const preset = PRESETS[provider];
  if (!preset) return;
  $('compat-label').textContent = preset.label;
  /** @type {HTMLAnchorElement} */ ($('compat-key-link')).href = preset.keyUrl;
  $('compat-key-link').textContent = new URL(preset.keyUrl).host;
  $('compat-host').textContent = new URL(preset.baseUrl).host;
  $('compatKey').value = settings.providerKeys[provider] ?? '';
  $('compatModels').replaceChildren(...preset.models.map((m) => new Option(m, m)));
  // A local provider (Ollama) has no key but an address; its model starts empty until chosen.
  const local = !!preset.local;
  /** @type {HTMLElement} */ ($('compat-key-field')).hidden = local;
  /** @type {HTMLElement} */ ($('compat-url-field')).hidden = !local;
  $('compatUrl').value = settings.providerUrls[provider] ?? '';
  $('compatModel').value = settings.providerModels[provider] || (local ? '' : preset.models[0]);
  $('compatModel').placeholder = local ? 'Click "Test connection" to list your models' : '';
  $('compat-model-hint').textContent = local
    ? 'Any model you downloaded with "ollama pull". It needs to support tools.'
    : 'Any model id from this provider. "Test key" loads the list of models your key can use.';
  $('test-key').textContent = local ? 'Test connection' : 'Test key';
};
showProvider(settings.directProvider);
$('directProvider').addEventListener('change', async () => {
  settings.directProvider = $('directProvider').value;
  await saveSettings({ directProvider: settings.directProvider });
  showProvider(settings.directProvider);
});
$('compatKey').addEventListener('change', async () => {
  settings.providerKeys = { ...settings.providerKeys, [settings.directProvider]: $('compatKey').value.trim() };
  await saveSettings({ providerKeys: settings.providerKeys });
});
/** @param {string} model */
const saveCompatModel = async (model) => {
  settings.providerModels = { ...settings.providerModels, [settings.directProvider]: model };
  await saveSettings({ providerModels: settings.providerModels });
};
$('compatModel').addEventListener('change', () => saveCompatModel($('compatModel').value.trim()));
$('compatUrl').addEventListener('change', async () => {
  settings.providerUrls = { ...settings.providerUrls, [settings.directProvider]: $('compatUrl').value.trim() };
  await saveSettings({ providerUrls: settings.providerUrls });
});

// Check the key. Anthropic: the official SDK (vendored) fetches the model's details.
// Others: list the models the key can use (costs nothing) and check the chosen one is there.
// Ollama: no key; list the downloaded models, and pick the first if none is chosen yet.
$('test-key').addEventListener('click', async () => {
  const result = $('test-key-result');
  result.className = '';
  result.textContent = 'Checking…';
  const provider = $('directProvider').value;
  try {
    if (provider === 'anthropic') {
      const { default: Anthropic } = await import('../vendor/anthropic-sdk.mjs');
      const client = new Anthropic({ apiKey: $('anthropicApiKey').value.trim(), dangerouslyAllowBrowser: true, maxRetries: 0 });
      const model = await client.models.retrieve($('directModel').value);
      result.className = 'ok';
      result.textContent = `Key works ✔ (${model.display_name})`;
      return;
    }
    const preset = PRESETS[provider];
    const auth = { ...(preset.local ? {} : { authorization: `Bearer ${$('compatKey').value.trim()}` }), ...preset.headers };
    if (preset.keyCheckUrl) await presetFetch(provider, fetch, preset.keyCheckUrl, { headers: auth });
    const res = await presetFetch(provider, fetch, `${baseUrlFor(provider, { baseUrl: $('compatUrl').value })}/models`, { headers: auth });
    const ids = ((await res.json()).data ?? []).map((/** @type {any} */ m) => String(m.id).replace(/^models\//, '')).sort();
    $('compatModels').replaceChildren(...ids.map((id) => new Option(id, id)));
    if (preset.local) {
      if (!ids.length) throw new Error('Ollama is running but has no models yet. Download one, for example: ollama pull qwen3');
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
    const works = preset.local ? 'Ollama is running ✔' : 'Key works ✔';
    if (!found) {
      result.className = 'bad';
      result.textContent = `${works.slice(0, -2)}, but "${chosen}" isn't one of your ${ids.length} models. Pick one from the Model list.`;
      return;
    }
    let note = '';
    if (provider === 'ollama') {
      // Chrome sends the extension's Origin only with POST requests (like the chat requests), so listing
      // models can work while Ollama still refuses the chat. Ask about the model with a POST: that hits the
      // same origin check, and the answer says whether the model can use tools (and see screenshots).
      const root = baseUrlFor(provider, { baseUrl: $('compatUrl').value }).replace(/\/v1$/, '');
      const info = await (await presetFetch(provider, fetch, `${root}/api/show`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: chosen }),
      })).json();
      const caps = Array.isArray(info.capabilities) ? info.capabilities : null; // older Ollama versions don't say
      if (caps && !caps.includes('tools')) {
        result.className = 'bad';
        result.textContent = `Ollama is running, but ${chosen} can't use tools, which this extension needs. Pick another model (for example qwen3).`;
        return;
      }
      if (caps && !caps.includes('vision')) note = "; it can't see screenshots";
    }
    result.className = 'ok';
    result.textContent = `${works} (${ids.length} model${ids.length === 1 ? '' : 's'} available${preset.local ? `, using ${chosen}${note}` : ''})`;
  } catch (err) {
    const e = /** @type {any} */ (err);
    result.className = 'bad';
    // The SDK's errors carry a status; httpError() messages already say what to do.
    result.textContent = e?.status === 401 ? 'This key was not accepted. Check that you copied all of it.'
      : e?.status === 404 ? 'The key works, but this model is not available to your account. Pick another.'
        : String(e?.message ?? e);
  }
});

for (const id of ['serverUrl', 'token']) {
  $(id).addEventListener('change', () => saveSettings({ [id]: $(id).value.trim() }));
}
for (const id of ['executeJs', 'askBeforeInspections', 'webTools']) {
  $(id).addEventListener('change', () => saveSettings({ [id]: $(id).checked }));
}
for (const key of ['selected', 'console', 'network']) {
  $(`ctx-${key}`).addEventListener('change', () => saveSettings({
    contextDefaults: { selected: $('ctx-selected').checked, console: $('ctx-console').checked, network: $('ctx-network').checked },
  }));
}

// Open a socket, send hello, and report what the server says.
$('test').addEventListener('click', () => {
  const result = $('test-result');
  result.className = '';
  result.textContent = 'Connecting…';
  let ws;
  try {
    ws = new WebSocket($('serverUrl').value.trim());
  } catch (err) {
    result.className = 'bad';
    result.textContent = String(err);
    return;
  }
  const timer = setTimeout(() => { result.className = 'bad'; result.textContent = 'No answer.'; ws.close(); }, 5000);
  ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', token: $('token').value.trim(), protocol: PROTOCOL_VERSION }));
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    clearTimeout(timer);
    result.className = msg.type === 'welcome' ? 'ok' : 'bad';
    result.textContent = msg.type === 'welcome' ? 'Connected ✔' : msg.message;
    ws.close();
  };
  ws.onerror = () => {
    clearTimeout(timer);
    result.className = 'bad';
    result.textContent = 'Cannot reach the server. Is `npm start` running?';
  };
});

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
  $('data-extension').textContent = `${summary.patches} saved patch${summary.patches === 1 ? '' : 'es'} and your settings (extension ${summary.extensionVersion})`;
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
    dataResult(`Exported ${count(data.patches.length, 'patch', 'patches')}, ${count(data.conversations.length, 'conversation')}, `
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
      + `; ${count(result.conversations, 'conversation')} and ${count(result.notes, 'memory note')}`
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
    button.textContent = 'Click again to delete all patches and settings';
    setTimeout(() => { delete button.dataset.armed; button.textContent = 'Delete extension data'; }, 4000);
    return;
  }
  try {
    await worker('data.clear');
    dataResult('Deleted. Your conversations and site memory on the server were not touched.');
    setTimeout(() => location.reload(), 1500);
  } catch (err) {
    dataResult(String(/** @type {any} */ (err).message ?? err), false);
  }
});

showDataSummary();
