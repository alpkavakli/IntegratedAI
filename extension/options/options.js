// @ts-check
// Options page: every field saves immediately; open panels pick up the change.

import { PROTOCOL_VERSION } from '../shared/protocol.js';
import { loadSettings, saveSettings } from '../panel/lib/settings.js';

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
  try {
    const info = /** @type {any} */ (await serverDataInfo());
    $('data-server').textContent =
      `${info.conversations} conversation${info.conversations === 1 ? '' : 's'} and site memory for ${info.memorySites} site${info.memorySites === 1 ? '' : 's'}, ` +
      `in ${info.dataDir}${info.backups ? ` (${info.backups} automatic backup${info.backups === 1 ? '' : 's'} in its "backups" folder)` : ''}`;
  } catch {
    $('data-server').textContent = 'not connected (start the server with npm start to see this)';
  }
}

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
    dataResult(`Exported ${data.patches.length} patch${data.patches.length === 1 ? '' : 'es'} and your settings.`);
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
