// @ts-check
/**
 * User settings, stored in chrome.storage.local and edited on the options page.
 */

import { DEFAULT_PORT } from '../../shared/protocol.js';

export const DEFAULT_SETTINGS = {
  serverUrl: `ws://127.0.0.1:${DEFAULT_PORT}/ws`,
  token: '',
  /** Allow the model to propose arbitrary JavaScript (each run still needs approval). */
  executeJs: false,
  /** Ask before running read-only inspections requested by the model. */
  askBeforeInspections: false,
  /** Which context chips start enabled. */
  contextDefaults: { selected: true, console: false, network: false },
};

/** @typedef {typeof DEFAULT_SETTINGS} Settings */

/** @returns {Promise<Settings>} */
export async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    contextDefaults: { ...DEFAULT_SETTINGS.contextDefaults, ...settings?.contextDefaults },
  };
}

/** @param {Partial<Settings>} changes */
export async function saveSettings(changes) {
  const current = await loadSettings();
  await chrome.storage.local.set({ settings: { ...current, ...changes } });
}

/** @param {(s: Settings) => void} callback */
export function onSettingsChanged(callback) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) loadSettings().then(callback);
  });
}
