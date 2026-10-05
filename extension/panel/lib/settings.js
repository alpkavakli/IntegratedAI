// @ts-check
/**
 * User settings, stored in chrome.storage.local and edited on the options page.
 */

import { DEFAULT_PORT } from '../../shared/protocol.js';

export const DEFAULT_SETTINGS = {
  /**
   * How the AI runs:
   *   'direct' → inside the extension with the user's Anthropic API key (nothing to install)
   *   'server' → through the local agent server (Claude Code subscription, Apply to source)
   * Empty = not chosen yet: existing installs with a pairing token keep 'server', new ones get 'direct'.
   * @type {'' | 'direct' | 'server'}
   */
  mode: '',
  /** Direct mode: the user's Anthropic API key (stays in this browser; sent only to api.anthropic.com). */
  anthropicApiKey: '',
  /** Direct mode: Anthropic model to use. */
  directModel: 'claude-opus-5-5',
  /** Direct mode: which provider new conversations use ('anthropic', 'openai', 'gemini', 'openrouter', 'ollama'). */
  directProvider: 'anthropic',
  /** Direct mode: API keys for the other providers (stay in this browser; each is sent only to its provider). */
  providerKeys: { openai: '', gemini: '', openrouter: '' },
  /** Direct mode: model per provider ('' = the provider's first suggestion; Ollama: '' = not set up). */
  providerModels: { openai: '', gemini: '', openrouter: '', ollama: '' },
  /** Direct mode: address of local providers ('' = the default, http://localhost:11434/v1 for Ollama). */
  providerUrls: { ollama: '' },
  serverUrl: `ws://127.0.0.1:${DEFAULT_PORT}/ws`,
  token: '',
  /** Allow the model to propose arbitrary JavaScript (each run still needs approval). */
  executeJs: false,
  /** Let the model search the web and read web pages (docs, MDN, …). Read-only. */
  webTools: true,
  /** Ask before running read-only inspections requested by the model. */
  askBeforeInspections: false,
  /** Which context chips start enabled. */
  contextDefaults: { selected: true, console: false, network: false },
};

/** @typedef {typeof DEFAULT_SETTINGS} Settings */

/** @returns {Promise<Settings>} */
export async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  const merged = {
    ...DEFAULT_SETTINGS,
    ...settings,
    contextDefaults: { ...DEFAULT_SETTINGS.contextDefaults, ...settings?.contextDefaults },
    providerKeys: { ...DEFAULT_SETTINGS.providerKeys, ...settings?.providerKeys },
    providerModels: { ...DEFAULT_SETTINGS.providerModels, ...settings?.providerModels },
    providerUrls: { ...DEFAULT_SETTINGS.providerUrls, ...settings?.providerUrls },
  };
  if (!merged.mode) merged.mode = merged.token ? 'server' : 'direct';
  return merged;
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
