// @ts-check
/**
 * Provider: Anthropic API (Messages API via the official @anthropic-ai/sdk).
 *
 * Only offered when an API key is configured (config.providers.anthropic.apiKey
 * or the ANTHROPIC_API_KEY environment variable). The SDK is imported lazily, so
 * the server runs fine without ever loading it.
 *
 * Actions are native tools with `strict: true` schemas. Text is streamed.
 * The system prompt and tool list are static, and automatic prompt caching
 * (`cache_control` at the top level) caches the growing conversation prefix.
 */

import { ACTIONS } from '../../../extension/shared/actions.js';
import { anthropicApiKey } from '../config.js';
import { Provider } from './base.js';
import { renderContext, renderMemory } from './common.js';
import { estimateCost } from './pricing.js';

/** @typedef {import('../../../extension/shared/protocol.js').NeutralMessage} NeutralMessage */

// Models that accept the server-side refusal fallback (`fallbacks: "default"`).
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export class AnthropicProvider extends Provider {
  static id = 'anthropic';
  static label = 'Anthropic API';
  static models = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5', 'claude-fable-5-1'];
  static capabilities = { streaming: true, nativeTools: true, reportsCost: true, vision: true };

  /** @param {import('../config.js').Config} config */
  static defaultModel(config) {
    return config.providers.anthropic.model || this.models[0];
  }

  /** @param {import('../config.js').Config} config */
  static async checkAvailability(config) {
    if (!anthropicApiKey(config)) {
      return { available: false, reason: 'No API key. Set ANTHROPIC_API_KEY or providers.anthropic.apiKey in config.json.' };
    }
    return { available: true };
  }

  /**
   * @param {import('../config.js').Config} config
   * @param {{ client?: any }} [deps]  inject a fake client in tests
   */
  constructor(config, deps = {}) {
    super(config);
    this.client = deps.client ?? null;
  }

  async getClient() {
    if (!this.client) {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      this.client = new Anthropic({ apiKey: anthropicApiKey(this.config) });
    }
    return this.client;
  }

  /**
   * @param {import('./base.js').TurnRequest} req
   * @returns {AsyncGenerator<import('./base.js').ProviderEvent>}
   */
  async *turn({ messages, system, actionNames, model, signal, webTools }) {
    const cfg = this.config.providers.anthropic;
    const client = await this.getClient();

    /** @type {Record<string, any>} */
    const params = {
      model,
      max_tokens: cfg.maxTokens,
      system,
      tools: [...toAnthropicTools(actionNames), ...(webTools ? webToolsFor(model) : [])],
      messages: toAnthropicMessages(messages),
      cache_control: { type: 'ephemeral' }, // automatic prompt caching of the prefix
    };
    // Haiku 4.5 does not support the effort parameter.
    if (!model.startsWith('claude-haiku')) params.output_config = { effort: cfg.effort };
    // On a safety refusal, let the API retry on a suitable fallback model.
    if (cfg.fallbacks && FALLBACK_MODELS.has(model)) {
      params.betas = [FALLBACK_BETA];
      params.fallbacks = 'default';
    }

    const stream = client.beta.messages.stream(params, { signal });
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield { type: 'text_delta', text: event.delta.text };
      }
    }
    const message = await stream.finalMessage();

    const u = message.usage ?? {};
    yield {
      type: 'usage',
      inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      outputTokens: u.output_tokens ?? 0,
      costUsd: estimateCost(model, {
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
      }),
    };

    if (message.stop_reason === 'refusal') {
      yield { type: 'text_delta', text: '\n\n_(The model declined this request.)_' };
      yield { type: 'done', stopReason: 'refusal' };
      return; // no raw content and no tool calls: nothing half-finished goes into history
    }
    if (message.stop_reason === 'max_tokens') {
      // Tool inputs may be truncated; never run them.
      yield { type: 'text_delta', text: '\n\n_(Response was cut off at the token limit.)_' };
      yield { type: 'done', stopReason: 'max_tokens' };
      return;
    }

    for (const block of message.content) {
      if (block.type === 'tool_use') yield { type: 'tool_call', id: block.id, name: block.name, input: block.input };
    }
    // Keep the exact content (including thinking blocks): it must be sent back unchanged.
    yield { type: 'raw', content: message.content };
    yield { type: 'done', stopReason: message.stop_reason };
  }
}

/**
 * Anthropic-hosted web tools. They run on Anthropic's servers; results come back
 * inside the assistant message (kept in `raw`). A long search may end the call
 * with stop_reason "pause_turn"; the orchestrator then simply calls again.
 * @param {string} model
 */
export function webToolsFor(model) {
  if (model.startsWith('claude-haiku')) return [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }];
  return [
    { type: 'web_search_20260209', name: 'web_search', max_uses: 5 },
    { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 5 },
  ];
}

/**
 * Action catalog → Anthropic tool definitions.
 * @param {string[]} actionNames
 */
export function toAnthropicTools(actionNames) {
  return actionNames.map((name) => ({
    name,
    description: ACTIONS[name].description,
    input_schema: ACTIONS[name].inputSchema,
    strict: true,
  }));
}

/**
 * Neutral conversation → Anthropic `messages`.
 * - Consecutive messages with the same role are merged (the API wants alternation).
 * - In user messages, tool_result blocks must come first.
 * - Assistant messages produced by this provider are sent back exactly as received.
 * @param {NeutralMessage[]} messages
 */
export function toAnthropicMessages(messages) {
  /** @type {{ role: 'user'|'assistant', content: any[] }[]} */
  const out = [];
  for (const m of messages) {
    /** @type {any[]} */
    let content;
    if (m.role === 'assistant') {
      content = m.raw?.provider === 'anthropic' && Array.isArray(m.raw.content)
        ? m.raw.content
        : m.content.flatMap((b) => {
          if (b.type === 'text' && b.text) return [{ type: 'text', text: b.text }];
          if (b.type === 'tool_call') return [{ type: 'tool_use', id: b.id, name: b.name, input: b.input }];
          return [];
        });
      if (!content.length) content = [{ type: 'text', text: '(no reply)' }];
    } else {
      content = m.content.map((b) => {
        switch (b.type) {
          case 'tool_result':
            return { type: 'tool_result', tool_use_id: b.toolCallId, content: b.content, is_error: !!b.isError };
          case 'context':
            return { type: 'text', text: renderContext(b.data) };
          case 'memory':
            return { type: 'text', text: renderMemory(b.data) };
          case 'note':
            return { type: 'text', text: `<action_updates>\n${b.text}\n</action_updates>` };
          case 'text':
            return { type: 'text', text: b.text || '(empty message)' };
          default:
            return null;
        }
      }).filter(Boolean);
    }

    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) prev.content.push(...content);
    else out.push({ role: m.role, content: [...content] });
  }

  for (const msg of out) {
    if (msg.role === 'user') {
      msg.content.sort((a, b) => Number(b.type === 'tool_result') - Number(a.type === 'tool_result'));
    }
  }
  return out;
}
