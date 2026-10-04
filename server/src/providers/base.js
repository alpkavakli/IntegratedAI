// @ts-check
/**
 * The provider interface. Every AI backend (Claude Code CLI, Anthropic API, and
 * later OpenAI, Gemini, Ollama, OpenRouter, …) is a subclass of Provider.
 *
 * A provider receives the whole provider-neutral conversation and yields a
 * stream of ProviderEvents for ONE model call. The orchestrator handles
 * everything else (running inspections, proposals, approval, storage).
 *
 * To add a provider: copy _template.js, implement it, register it in registry.js.
 */

/** @typedef {import('../../../extension/shared/protocol.js').NeutralMessage} NeutralMessage */

/**
 * @typedef {{ type: 'text_delta', text: string }
 *   | { type: 'preview_delta', text: string }
 *   | { type: 'tool_call', id: string, name: string, input: unknown }
 *   | { type: 'usage', inputTokens: number, outputTokens: number, costUsd: number | null }
 *   | { type: 'raw', content: unknown }
 *   | { type: 'done', stopReason: string }} ProviderEvent
 *
 *  text_delta  part of the assistant's visible reply (may arrive in one piece)
 *  preview_delta  text shown live while the model is still writing, but NOT stored.
 *              For providers whose final answer arrives separately (Claude CLI
 *              streams a preview, then yields the validated reply as text_delta).
 *  tool_call   the model wants to run an action (inspection or proposed change)
 *  usage       tokens/cost of this call; costUsd null if unknown
 *  raw         provider-native assistant content to store and send back next time
 *              (e.g. Anthropic thinking blocks). Only this provider reads it back.
 *  done        end of this model call
 */

/**
 * @typedef {object} TurnRequest
 * @property {NeutralMessage[]} messages    full conversation so far (last one is a user message)
 * @property {string} system                system prompt
 * @property {string[]} actionNames         actions the model may use this turn
 * @property {boolean} [webTools]           allow the provider's own web search / web fetch tools
 * @property {{ url: string, token: string }} [pageTools]  MCP endpoint offering the inspections as
 *                                          real tools (only for providers with static pageToolsViaMcp)
 * @property {string} model                 model id/alias chosen for this conversation
 * @property {Record<string, any>} state    per-conversation memory for this provider (persisted)
 * @property {AbortSignal} signal           aborted when the user clicks Stop
 */

/**
 * @typedef {object} Capabilities
 * @property {boolean} streaming        yields text in several text_delta events
 * @property {boolean} nativeTools      uses the model's tool-calling API
 * @property {boolean} reportsCost      usage events carry costUsd
 * @property {boolean} vision           can accept images (future: element screenshots)
 */

export class Provider {
  /** Unique id used in config and protocol, e.g. "claude-cli". */
  static id = 'base';
  /** Shown in the panel's provider picker. */
  static label = 'Base provider';
  /** Models offered in the picker. The first is the default unless config says otherwise. */
  static models = /** @type {string[]} */ ([]);
  /** @type {Capabilities} */
  static capabilities = { streaming: false, nativeTools: false, reportsCost: false, vision: false };

  /**
   * Is this provider usable right now? (CLI installed and logged in, API key set, …)
   * @param {import('../config.js').Config} _config
   * @returns {Promise<{ available: boolean, reason?: string }>}
   */
  static async checkAvailability(_config) {
    return { available: false, reason: 'Not implemented' };
  }

  /**
   * Default model from config, if the provider has one.
   * @param {import('../config.js').Config} _config
   */
  static defaultModel(_config) {
    return this.models[0] ?? '';
  }

  /** @param {import('../config.js').Config} config */
  constructor(config) {
    this.config = config;
  }

  /**
   * Run one model call.
   * @param {TurnRequest} _req
   * @returns {AsyncGenerator<ProviderEvent>}
   */
  // eslint-disable-next-line require-yield
  async *turn(_req) {
    throw new Error('turn() not implemented');
  }
}
