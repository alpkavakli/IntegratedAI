// @ts-check
/**
 * Providers that speak the OpenAI Chat Completions API:
 *   OpenAI, Google Gemini (its OpenAI-compatible endpoint) and OpenRouter.
 * Adding another (Ollama, Groq, Mistral, …) is one more entry in PRESETS.
 *
 * Used in direct mode with the user's own key. Actions are offered as function
 * tools; the orchestrator does validation, approval and page inspection exactly
 * as for every other provider. Plain fetch with streaming (server-sent events):
 * these vendors' SDKs aren't needed for this one endpoint.
 */

import { ACTIONS } from '../actions.js';
import { Provider } from './base.js';
import { newCallId, renderBlockAsText } from './common.js';

/** @typedef {import('../protocol.js').NeutralMessage} NeutralMessage */

/**
 * @typedef {object} Preset
 * @property {string} label
 * @property {string} baseUrl
 * @property {string[]} models        suggestions; the user can type any model id (Options → Test key lists real ones)
 * @property {string} keyUrl          where to create a key
 * @property {boolean} includeUsage   send stream_options.include_usage (not every endpoint accepts it)
 * @property {Record<string, string>} [headers]
 */

/** @type {Record<string, Preset>} */
export const PRESETS = {
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna'],
    keyUrl: 'https://platform.openai.com/api-keys',
    includeUsage: true,
  },
  gemini: {
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: ['gemini-3.8-flash', 'gemini-3.1-pro-preview', 'gemini-3.5-flash-lite'],
    keyUrl: 'https://aistudio.google.com/apikey',
    includeUsage: false,
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['anthropic/claude-sonnet-5.5', 'openai/gpt-6.1-sol', 'google/gemini-3.8-flash'],
    keyUrl: 'https://openrouter.ai/keys',
    includeUsage: true,
    // OpenRouter's optional app attribution.
    headers: { 'HTTP-Referer': 'https://github.com/alpkavakli/IntegratedAI', 'X-Title': 'IntegratedAI DevTools' },
  },
};

/**
 * Make the provider class for one preset (config.providers[id] = { apiKey, model }).
 * @param {keyof typeof PRESETS} id
 */
export function openAICompatibleProvider(id) {
  const preset = PRESETS[id];
  return class extends Provider {
    static id = id;
    static label = preset.label;
    static models = preset.models;
    static capabilities = { streaming: true, nativeTools: true, reportsCost: false, vision: true };

    /** @param {import('./base.js').ProviderConfig} config */
    static defaultModel(config) {
      return config.providers[id]?.model || preset.models[0];
    }

    /** @param {import('./base.js').ProviderConfig} config */
    static async checkAvailability(config) {
      return config.providers[id]?.apiKey
        ? { available: true }
        : { available: false, reason: `Add your ${preset.label} API key in Options.` };
    }

    /**
     * @param {import('./base.js').ProviderConfig} config
     * @param {{ fetch?: typeof fetch }} [deps]  inject a fake fetch in tests
     */
    constructor(config, deps = {}) {
      super(config);
      this.fetch = deps.fetch ?? ((...args) => fetch(...args));
    }

    /**
     * @param {import('./base.js').TurnRequest} req
     * @returns {AsyncGenerator<import('./base.js').ProviderEvent>}
     */
    async *turn({ messages, system, actionNames, model, signal }) {
      const body = {
        model,
        messages: toOpenAIMessages(system, messages),
        tools: actionNames.map((name) => ({
          type: 'function',
          function: { name, description: ACTIONS[name].description, parameters: ACTIONS[name].inputSchema },
        })),
        stream: true,
        ...(preset.includeUsage ? { stream_options: { include_usage: true } } : {}),
      };
      const res = await this.fetch(`${preset.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.providers[id]?.apiKey ?? ''}`,
          ...preset.headers,
        },
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok) throw httpError(preset.label, res.status, await res.text());

      /** @type {{ id: string, name: string, args: string }[]} */
      const calls = [];
      let finishReason = 'stop';
      /** @type {any} */
      let usage = null;
      for await (const chunk of readEvents(/** @type {ReadableStream<Uint8Array>} */ (res.body))) {
        if (chunk.error) throw new Error(`${preset.label}: ${chunk.error.message ?? JSON.stringify(chunk.error)}`);
        if (chunk.usage) usage = chunk.usage;
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};
        if (typeof delta.content === 'string' && delta.content) yield { type: 'text_delta', text: delta.content };
        // Tool calls arrive in pieces: an index, then the id and name, then the arguments bit by bit.
        for (const piece of delta.tool_calls ?? []) {
          const index = piece.index ?? calls.length;
          const call = (calls[index] ??= { id: '', name: '', args: '' });
          if (piece.id) call.id = piece.id;
          if (piece.function?.name) call.name = piece.function.name;
          if (piece.function?.arguments) call.args += piece.function.arguments;
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }

      yield {
        type: 'usage',
        inputTokens: usage?.prompt_tokens ?? 0,
        outputTokens: usage?.completion_tokens ?? 0,
        costUsd: null,
      };
      if (finishReason === 'length') {
        // Tool inputs may be cut off; never run them.
        yield { type: 'text_delta', text: '\n\n_(Response was cut off at the token limit.)_' };
        yield { type: 'done', stopReason: 'max_tokens' };
        return;
      }
      for (const call of calls.filter(Boolean)) {
        /** @type {unknown} */
        let input = {};
        try {
          input = call.args ? JSON.parse(call.args) : {};
        } catch {
          input = { _unparseable: call.args.slice(0, 200) }; // fails validation → the model gets an error result
        }
        yield { type: 'tool_call', id: call.id || newCallId(), name: call.name, input };
      }
      yield { type: 'done', stopReason: finishReason };
    }
  };
}

/**
 * Neutral conversation → Chat Completions messages.
 * - tool results become role "tool" messages right after the assistant's tool calls
 * - the rest of a user message (context, memory, text) becomes a user message
 * - screenshots from tool results follow as an image in a user message ("tool" messages can't hold images)
 * @param {string} system
 * @param {NeutralMessage[]} messages
 */
export function toOpenAIMessages(system, messages) {
  /** @type {any[]} */
  const out = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'assistant') {
      const text = m.content.filter((b) => b.type === 'text').map((b) => /** @type {any} */ (b).text).join('\n');
      const toolCalls = m.content.filter((b) => b.type === 'tool_call').map((b) => {
        const c = /** @type {any} */ (b);
        return { id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } };
      });
      out.push({ role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
      continue;
    }
    /** @type {any[]} */
    const images = [];
    for (const b of m.content) {
      if (b.type !== 'tool_result') continue;
      const r = /** @type {any} */ (b);
      out.push({ role: 'tool', tool_call_id: r.toolCallId, content: r.isError ? `Error: ${r.content}` : r.content });
      if (r.images) images.push(...r.images);
    }
    const parts = m.content
      .filter((b) => b.type !== 'tool_result')
      .map((b) => renderBlockAsText(/** @type {any} */ (b)))
      .filter(Boolean)
      .map((text) => ({ type: 'text', text }));
    if (!images.length) {
      // Text only: one plain string (the most widely supported form across compatible endpoints).
      if (parts.length) out.push({ role: 'user', content: parts.map((p) => p.text).join('\n\n') });
      continue;
    }
    parts.unshift({ type: 'text', text: 'Screenshot from the inspection above:' });
    parts.push(...images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mediaType};base64,${i.data}` } })));
    out.push({ role: 'user', content: parts });
  }
  return out;
}

/**
 * Server-sent events → parsed JSON chunks ("data: {…}" lines; "[DONE]" ends).
 * @param {ReadableStream<Uint8Array>} body
 */
export async function* readEvents(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      try { yield JSON.parse(data); } catch { /* ignore keep-alive comments and partial junk */ }
    }
  }
}

/**
 * A readable error for an HTTP failure.
 * @param {string} label
 * @param {number} status
 * @param {string} text response body
 */
export function httpError(label, status, text) {
  let detail = '';
  try {
    const body = JSON.parse(text);
    detail = String((Array.isArray(body) ? body[0] : body)?.error?.message ?? '');
  } catch { detail = text.slice(0, 200); }
  if (status === 401 || status === 403) return new Error(`The ${label} API key was not accepted. Check it in Options.`);
  if (status === 404) return new Error(`This model is not available on ${label}. Pick another in Options (Test key lists them).`);
  if (status === 402) return new Error(`Your ${label} account is out of credits.`);
  if (status === 429) return new Error(`${label} rate limit or quota reached. Wait a moment and try again.`);
  if (status >= 500) return new Error(`${label} had a temporary problem (${status}). Try again in a moment.`);
  return new Error(`${label} error ${status}${detail ? `: ${detail}` : ''}`);
}
