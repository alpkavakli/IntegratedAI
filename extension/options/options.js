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
