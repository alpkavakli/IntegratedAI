// @ts-check
/**
 * List of available providers. To add one, import its class and add it to PROVIDERS.
 */

import { AnthropicProvider } from './anthropic.js';
import { ClaudeCliProvider } from './claude-cli.js';

/** @typedef {typeof import('./base.js').Provider} ProviderClass */

/** @type {ProviderClass[]} */
export const PROVIDERS = [ClaudeCliProvider, AnthropicProvider];

const AVAILABILITY_TTL_MS = 60_000;

export class ProviderRegistry {
  /**
   * @param {import('../config.js').Config} config
   * @param {ProviderClass[]} [providers]  override in tests
   */
  constructor(config, providers = PROVIDERS) {
    this.config = config;
    this.providers = providers;
    /** @type {Map<string, { at: number, value: Promise<{ available: boolean, reason?: string }> }>} */
    this.availability = new Map();
  }

  /** @param {string} id */
  get(id) {
    return this.providers.find((p) => p.id === id);
  }

  /**
   * Availability is cached for a minute (checking the CLI spawns a process).
   * @param {string} id
   */
  async isAvailable(id) {
    const P = this.get(id);
    if (!P) return { available: false, reason: `Unknown provider "${id}"` };
    const cached = this.availability.get(id);
    if (cached && Date.now() - cached.at < AVAILABILITY_TTL_MS) return cached.value;
    const value = P.checkAvailability(this.config).catch((err) => ({ available: false, reason: String(err?.message ?? err) }));
    this.availability.set(id, { at: Date.now(), value });
    return value;
  }

  /** @returns {Promise<import('../../../extension/shared/protocol.js').ProviderInfo[]>} */
  async list() {
    return Promise.all(
      this.providers.map(async (P) => {
        const { available, reason } = await this.isAvailable(P.id);
        return {
          id: P.id,
          label: P.label,
          available,
          reason,
          models: P.models,
          defaultModel: P.defaultModel(this.config),
        };
      }),
    );
  }

  /**
   * The configured default provider, or the first available one.
   * @returns {Promise<string>}
   */
  async pickDefault() {
    const preferred = this.config.defaultProvider;
    if (this.get(preferred) && (await this.isAvailable(preferred)).available) return preferred;
    for (const P of this.providers) {
      if ((await this.isAvailable(P.id)).available) return P.id;
    }
    return preferred; // nothing available; the panel shows why
  }

  /**
   * @param {string} id
   * @returns {import('./base.js').Provider}
   */
  create(id) {
    const P = this.get(id);
    if (!P) throw new Error(`Unknown provider "${id}"`);
    return new P(this.config);
  }
}
