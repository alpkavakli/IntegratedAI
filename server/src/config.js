// @ts-check
/**
 * Server configuration.
 *
 * Stored in ~/.integratedai/config.json (override the folder with the
 * INTEGRATEDAI_HOME environment variable). Created with defaults on first run,
 * including a random pairing token that you paste into the extension options.
 *
 * You can edit the file by hand; restart the server afterwards.
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PORT } from '../../extension/shared/protocol.js';

/**
 * @typedef {object} CliProviderConfig
 * @property {string} command          Executable to run. "claude" (on PATH) or a full path.
 * @property {string} model            "default" = whatever your Claude Code is configured to use, or an alias like "opus"/"sonnet"
 * @property {string|null} effort      null = CLI default, or "low" | "medium" | "high" | "xhigh" | "max"
 * @property {number|null} maxBudgetUsdPerCall  Optional safety cap passed as --max-budget-usd
 * @property {number} timeoutMs        Kill the CLI if one call takes longer than this
 *
 * @typedef {object} AnthropicProviderConfig
 * @property {string} apiKey           Leave empty to use the ANTHROPIC_API_KEY environment variable
 * @property {string} model
 * @property {string} effort           "low" | "medium" | "high" | "xhigh" | "max"
 * @property {number} maxTokens
 * @property {boolean} fallbacks       Server-side refusal fallback (supported models only)
 *
 * @typedef {object} Config
 * @property {string} host
 * @property {number} port
 * @property {string} token
 * @property {string[]} allowedExtensionIds   Empty = any chrome-extension:// origin (token still required)
 * @property {string} defaultProvider
 * @property {number} maxStepsPerTurn         Max model calls per user message (inspection round-trips)
 * @property {{ name?: string, path: string, urls: string[] }[]} projects  Your own sites' source folders for
 *                                            "Apply to source": pages whose URL starts with one of `urls` map to `path`
 * @property {{ 'claude-cli': CliProviderConfig, 'codex-cli': { command: string, model: string, timeoutMs: number }, anthropic: AnthropicProviderConfig }} providers
 * @property {string} dataDir                 (computed, not saved)
 */

export const DEFAULTS = {
  host: '127.0.0.1',
  port: DEFAULT_PORT,
  token: '',
  allowedExtensionIds: [],
  defaultProvider: 'claude-cli',
  maxStepsPerTurn: 8,
  projects: [],
  providers: {
    'claude-cli': {
      command: 'claude',
      model: 'default',
      effort: null,
      maxBudgetUsdPerCall: null,
      timeoutMs: 5 * 60 * 1000,
    },
    // ChatGPT through Codex CLI (signed in with your ChatGPT plan).
    'codex-cli': {
      command: 'codex',
      model: 'default',
      timeoutMs: 5 * 60 * 1000,
    },
    anthropic: {
      apiKey: '',
      model: 'claude-opus-5-5',
      effort: 'medium',
      maxTokens: 32000,
      fallbacks: true,
    },
  },
};

export function dataDir() {
  return process.env.INTEGRATEDAI_HOME || join(homedir(), '.integratedai');
}

/**
 * Load the config file (creating it if missing) and merge it over the defaults.
 * @param {string} [dir]
 * @returns {Config}
 */
export function loadConfig(dir = dataDir()) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'config.json');

  /** @type {any} */
  let saved = {};
  if (existsSync(file)) {
    saved = JSON.parse(readFileSync(file, 'utf8'));
  }

  const config = {
    ...DEFAULTS,
    ...saved,
    providers: {
      'claude-cli': { ...DEFAULTS.providers['claude-cli'], ...saved.providers?.['claude-cli'] },
      'codex-cli': { ...DEFAULTS.providers['codex-cli'], ...saved.providers?.['codex-cli'] },
      anthropic: { ...DEFAULTS.providers.anthropic, ...saved.providers?.anthropic },
    },
  };

  // First run (or token deleted): generate a pairing token and save the file.
  if (!config.token) {
    config.token = randomBytes(24).toString('base64url');
    writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });
  } else if (!existsSync(file)) {
    writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });
  }

  return { ...config, dataDir: dir };
}

/**
 * The Anthropic API key, if one was configured (config file first, then env).
 * The Anthropic provider is only offered when this returns a value.
 * @param {Config} config
 */
export function anthropicApiKey(config) {
  return config.providers.anthropic.apiKey || process.env.ANTHROPIC_API_KEY || '';
}
