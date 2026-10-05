// @ts-check
/**
 * Provider: Anthropic API (Messages API via the official @anthropic-ai/sdk).
 *
 * Only offered when an API key is configured (config.providers.anthropic.apiKey,
 * or on the server the ANTHROPIC_API_KEY environment variable). The SDK is loaded
 * lazily, so the server runs fine without ever loading it.
 *
 * Shared by the agent server (Node: imports the npm package) and the extension's
 * direct mode (browser: passes `loadSdk` for the vendored copy in extension/vendor/).
 *
 * Actions are native tools with `strict: true` schemas. Text is streamed.
 * The system prompt and tool list are static, and automatic prompt caching
 * (`cache_control` at the top level) caches the growing conversation prefix.
 */

import { ACTIONS } from '../actions.js';
import { Provider } from './base.js';
import { MAX_IMAGES_SENT, renderContext, renderMemory } from './common.js';
import { estimateCost } from './pricing.js';

/** @typedef {import('../protocol.js').NeutralMessage} NeutralMessage */

/**
 * The configured API key: config first, then (on the server) the environment.
 * @param {{ providers: { anthropic: { apiKey?: string } } }} config
 */
export function anthropicApiKey(config) {
  const fromEnv = typeof process !== 'undefined' ? process.env?.ANTHROPIC_API_KEY : '';
  return config.providers.anthropic.apiKey || fromEnv || '';
}

// Models that accept the server-side refusal fallback (`fallbacks: "default"`).
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export class AnthropicProvider extends Provider {
  static id = 'anthropic';
  static label = 'Anthropic API';
  static models = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5', 'claude-fable-5-1'];
  static capabilities = { streaming: true, nativeTools: true, reportsCost: true, vision: true };

  /** @param {import('./base.js').ProviderConfig} config */
  static defaultModel(config) {
    return config.providers.anthropic.model || this.models[0];
  }

  /** @param {import('./base.js').ProviderConfig} config */
  static async checkAvailability(config) {
    if (!anthropicApiKey(config)) {
      return { available: false, reason: 'No API key. Set ANTHROPIC_API_KEY or providers.anthropic.apiKey in config.json.' };
    }
    return { available: true };
  }

  /**
   * @param {import('./base.js').ProviderConfig} config
   * @param {{ client?: any, loadSdk?: () => Promise<any>, browser?: boolean }} [deps]
   *   client: a ready client (tests); loadSdk: how to load the SDK module (browser: the vendored file);
   *   browser: running in the extension, where the SDK needs dangerouslyAllowBrowser (the key is the user's own)
   */
  constructor(config, deps = {}) {
    super(config);
    this.client = deps.client ?? null;
    this.loadSdk = deps.loadSdk ?? (() => import('@anthropic-ai/sdk'));
    this.browser = deps.browser === true;
  }

  async getClient() {
    if (!this.client) {
      const { default: Anthropic } = await this.loadSdk();
      this.sdk = Anthropic;
      this.client = new Anthropic({ apiKey: anthropicApiKey(this.config), ...(this.browser ? { dangerouslyAllowBrowser: true } : {}) });
    }
    return this.client;
  }

  /**
   * Turn SDK errors into messages a user can act on (typed classes, most specific first).
   * @param {unknown} err
   */
  friendlyError(err) {
    const A = this.sdk;
    if (!A || !(err instanceof A.APIError)) return err;
    const where = this.browser ? 'in Options' : 'in config.json or ANTHROPIC_API_KEY';
    if (err instanceof A.AuthenticationError) return new Error(`The Anthropic API key was not accepted. Check it ${where}.`);
    if (err instanceof A.PermissionDeniedError) return new Error(`Your Anthropic account can't use this model or feature (${err.message}).`);
    if (err instanceof A.NotFoundError) return new Error('This model is not available to your Anthropic account. Pick another model.');
    if (err instanceof A.RateLimitError) return new Error('Anthropic rate limit reached. Wait a moment and try again.');
    if (err instanceof A.APIConnectionError) return new Error('Could not reach the Anthropic API. Check your internet connection.');
    if (err instanceof A.BadRequestError && /credit balance/i.test(err.message)) {
      return new Error('Your Anthropic API credit balance is too low. Add credits at console.anthropic.com.');
    }
    if (err instanceof A.InternalServerError) return new Error('The Anthropic API had a temporary problem. Try again in a moment.');
    return err;
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

    /** @type {any} */
    let message;
    try {
      const stream = client.beta.messages.stream(params, { signal });
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          yield { type: 'text_delta', text: event.delta.text };
        }
      }
      message = await stream.finalMessage();
    } catch (err) {
      throw this.friendlyError(err);
    }

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

export { MAX_IMAGES_SENT };

/**
 * Neutral conversation → Anthropic `messages`.
 * - Consecutive messages with the same role are merged (the API wants alternation).
 * - In user messages, tool_result blocks must come first.
 * - Assistant messages produced by this provider are sent back exactly as received.
 * - Screenshots: only the last MAX_IMAGES_SENT are attached (each costs ~1–1.5k tokens on every call).
 * @param {NeutralMessage[]} messages
 */
export function toAnthropicMessages(messages) {
  let imagesLeft = MAX_IMAGES_SENT;
  /** @type {Set<unknown>} tool_result blocks whose images are still sent */
  const keepImages = new Set();
  for (const m of [...messages].reverse()) {
    for (const b of m.content) {
      if (b.type === 'tool_result' && b.images?.length && imagesLeft >= b.images.length) {
        keepImages.add(b);
        imagesLeft -= b.images.length;
      }
    }
  }

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
            return { type: 'tool_result', tool_use_id: b.toolCallId, content: toolResultContent(b, keepImages.has(b)), is_error: !!b.isError };
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

/**
 * @param {Extract<import('../protocol.js').ContentBlock, { type: 'tool_result' }>} b
 * @param {boolean} withImages
 */
function toolResultContent(b, withImages) {
  if (!b.images?.length) return b.content;
  if (!withImages) return `${b.content}\n(The screenshot from this result is no longer attached.)`;
  return [
    { type: 'text', text: b.content },
    ...b.images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } })),
  ];
}
