// @ts-check
/**
 * Providers that speak the OpenAI Chat Completions API:
 *   OpenAI, Google Gemini (its OpenAI-compatible endpoint), OpenRouter,
 *   DeepSeek, Qwen (Alibaba Cloud Model Studio), Kimi (Moonshot AI), GLM (Z.ai), MiniMax,
 *   Ollama (models running on the user's own computer, no key),
 *   and Custom: any other service with this API (Groq, Together, Mistral, LM Studio, vLLM, your own
 *   server), at the address the user enters, with an optional key and any model.
 * A provider many people want can still become its own entry in PRESETS.
 *
 * Thinking models: DeepSeek, Qwen, Kimi, GLM and MiniMax return the model's reasoning as
 * `reasoning_content` next to the answer, and want it back unchanged in the history of the following
 * requests (DeepSeek answers 400 without it). It is kept with each assistant message (its `raw`) and
 * sent back to the same provider (presets with sendReasoning); it is never shown in the chat.
 *
 * Used in direct mode with the user's own key. Actions are offered as function
 * tools; the orchestrator does validation, approval and page inspection exactly
 * as for every other provider. Plain fetch with streaming (server-sent events):
 * these vendors' SDKs aren't needed for this one endpoint.
 */

import { toolSpec } from '../actions.js';
import { Provider } from './base.js';
import { MAX_IMAGES_SENT, newCallId, renderBlockAsText } from './common.js';

/** Compact mode: how many of the newest tool results are sent in full. */
const COMPACT_FULL_RESULTS = 3;

/** @typedef {import('../protocol.js').NeutralMessage} NeutralMessage */

/**
 * @typedef {object} Preset
 * @property {string} label
 * @property {string} baseUrl
 * @property {string[]} models        suggestions; the user can type any model id (the settings page's Check lists real ones)
 * @property {string} keyUrl          where to create a key (local: where to get the app)
 * @property {boolean} includeUsage   send stream_options.include_usage (not every endpoint accepts it)
 * @property {string} [keyCheckUrl]   where Check key checks the key, when the model list doesn't need one
 * @property {Record<string, string>} [headers]
 * @property {boolean} [local]        runs on the user's computer: no key, and the address can be changed in Options
 * @property {string} [addressHint]   the address can be changed in Options (other regions, own workspace): what to put there
 * @property {boolean} [sendReasoning] send each assistant message's reasoning_content back (thinking models that require it)
 * @property {boolean} [thoughtSignatures] Gemini: tool calls carry a thought signature (extra_content.google) that must
 *   go back with them in the next requests, or the API refuses the call ("missing a thought_signature")
 * @property {boolean} [custom]       no fixed address: the user enters it (and any model); the key is optional
 */

/**
 * Ollama refuses requests from browser extensions unless they're allowed with
 * OLLAMA_ORIGINS (its default list has only localhost pages and desktop apps).
 */
export const OLLAMA_ORIGINS_HELP = 'Ollama refused the request: it only accepts browser extensions you allow. '
  + 'Set the environment variable OLLAMA_ORIGINS to chrome-extension://* and restart Ollama '
  + '(Windows: setx OLLAMA_ORIGINS "chrome-extension://*", then quit and reopen Ollama).';

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
    thoughtSignatures: true,
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['anthropic/claude-sonnet-5.5', 'openai/gpt-6.1-sol', 'google/gemini-3.8-flash'],
    keyUrl: 'https://openrouter.ai/keys',
    includeUsage: true,
    // OpenRouter's model list is public, so it can't tell a good key from a bad one.
    keyCheckUrl: 'https://openrouter.ai/api/v1/key',
    // OpenRouter's optional app attribution.
    headers: { 'HTTP-Referer': 'https://github.com/alpkavakli/IntegratedAI', 'X-Title': 'Browser IntegratedAI DevTools' },
  },
  // ── Models from China-based companies (checked 2026-10-07 against each provider's own documentation).
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    keyUrl: 'https://platform.deepseek.com/api_keys',
    includeUsage: true,
    sendReasoning: true,
  },
  qwen: {
    label: 'Qwen',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    models: ['qwen3.8-max', 'qwen3.7-plus', 'qwen3.7-flash'],
    keyUrl: 'https://modelstudio.console.alibabacloud.com/model/settings/api-key',
    includeUsage: false,
    sendReasoning: true,
    addressHint: 'Your Model Studio address, e.g. https://<workspace id>.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1 (keys only work in their own region)',
  },
  kimi: {
    label: 'Kimi',
    baseUrl: 'https://api.moonshot.ai/v1',
    models: ['kimi-k3'],
    keyUrl: 'https://platform.kimi.ai/console/api-keys',
    includeUsage: false,
    sendReasoning: true,
    addressHint: 'Accounts in mainland China: https://api.moonshot.cn/v1',
  },
  glm: {
    label: 'GLM',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    models: ['glm-5.3', 'glm-5.2', 'glm-4.7-flash'], // (glm-4.7-flash: free, rate-limited; checked 2026-10-08)
    keyUrl: 'https://z.ai/manage-apikey/apikey-list',
    includeUsage: false,
    sendReasoning: true,
    addressHint: 'Accounts on the Chinese site (bigmodel.cn): https://open.bigmodel.cn/api/paas/v4',
  },
  minimax: {
    label: 'MiniMax',
    baseUrl: 'https://api.minimax.io/v1',
    models: ['MiniMax-M3', 'MiniMax-M3.1-Flash-Preview'],
    keyUrl: 'https://platform.minimax.io',
    includeUsage: false,
    sendReasoning: true,
    addressHint: 'Accounts in mainland China: https://api.minimaxi.com/v1',
  },
  // Any other OpenAI-compatible service: address, key (if it needs one) and model come from Options.
  custom: {
    label: 'Custom',
    baseUrl: '',
    models: [],
    keyUrl: '',
    includeUsage: false,
    custom: true,
  },
  ollama: {
    label: 'Ollama',
    baseUrl: 'http://localhost:11434/v1',
    // Suggestions that support tools; any model you pulled works ("Test connection" lists them).
    models: ['qwen3', 'llama3.3', 'mistral-small'],
    keyUrl: 'https://ollama.com/download',
    includeUsage: false,
    local: true,
  },
};

/**
 * The API address for a provider: the preset's, or the address set in Options (local ones, and
 * providers with other regions or per-account addresses).
 * @param {string} id
 * @param {{ baseUrl?: string } | undefined} providerConfig
 */
export function baseUrlFor(id, providerConfig) {
  const preset = PRESETS[id];
  const own = (preset.local || preset.addressHint || preset.custom) && providerConfig?.baseUrl?.trim().replace(/\/+$/, '');
  return own || preset.baseUrl;
}

/** "https://host:port" of a URL, or the text itself if it isn't one. @param {string} url */
function safeOrigin(url) {
  try { return new URL(url).origin; } catch { return url || '(no address)'; }
}

/** Waits before trying a busy service again (presetFetch). */
export const RETRY_WAITS_MS = [2000, 5000];

/** @param {number} ms @param {AbortSignal | null | undefined} signal */
function sleepUnlessAborted(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
  });
}

/**
 * fetch() for a preset, with errors a user can act on. A local server that isn't
 * running, and Ollama refusing the extension (403), get their own messages; a busy hosted service is tried again.
 * @param {string} id
 * @param {(url: string, init: RequestInit) => Promise<Response>} doFetch
 * @param {string} url
 * @param {RequestInit} init
 */
export async function presetFetch(id, doFetch, url, init) {
  const preset = PRESETS[id];
  let res;
  // A hosted service that's busy for a moment (503/502/529, common on free tiers): try twice more, after a short wait.
  for (let attempt = 0; ; attempt++) {
    try {
      res = await doFetch(url, init);
    } catch (err) {
      if (/** @type {any} */ (err)?.name === 'AbortError') throw err;
      if (preset.custom) throw new Error(`Can't reach ${safeOrigin(url)}. Check the address in Options, and that the service is running.`);
      if (!preset.local) throw err;
      throw new Error(`Can't reach ${preset.label} at ${new URL(url).origin}. Is it running? Start the Ollama app (or run "ollama serve").`);
    }
    if (preset.local || ![502, 503, 529].includes(res.status) || attempt >= RETRY_WAITS_MS.length) break;
    const after = Number(res.headers?.get?.('retry-after'));
    await sleepUnlessAborted(after > 0 ? Math.min(after * 1000, 10_000) : RETRY_WAITS_MS[attempt], init?.signal);
  }
  if (!res.ok) {
    const text = await res.text();
    if (id === 'ollama' && res.status === 403) throw new Error(OLLAMA_ORIGINS_HELP);
    throw httpError(preset.label, res.status, text);
  }
  return res;
}

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
    /** Local models have small context windows: the orchestrator uses compact mode for them. */

    /** @param {import('./base.js').ProviderConfig} config */
    static defaultModel(config) {
      return config.providers[id]?.model || preset.models[0];
    }

    /** @param {import('./base.js').ProviderConfig} config */
    static async checkAvailability(config) {
      if (preset.custom) {
        return config.providers[id]?.baseUrl && config.providers[id]?.model
          ? { available: true }
          : { available: false, reason: 'Enter the address and the model of your service in Options.' };
      }
      if (preset.local) {
        // No key: choosing a model in Options is what turns it on.
        return config.providers[id]?.model
          ? { available: true }
          : { available: false, reason: `Choose an ${preset.label} model in Options.` };
      }
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
     * Compact mode (short prompt and tool descriptions, older results shortened): an Options choice for local
     * models with a small context window. Off by default: with 16K tokens of context, qwen3:8b did the same task
     * more reliably with the full prompt (2 of 2 runs) than with the compact one (1 of 2).
     */
    get compact() {
      return preset.local === true && this.config.providers[id]?.compact === true;
    }

    /**
     * @param {import('./base.js').TurnRequest} req
     * @returns {AsyncGenerator<import('./base.js').ProviderEvent>}
     */
    async *turn({ messages, system, actionNames, model, signal, compact = false }) {
      const body = {
        model,
        messages: toOpenAIMessages(system, messages, { compact, reasoningFor: preset.sendReasoning ? id : undefined, signaturesFor: preset.thoughtSignatures ? id : undefined }),
        // (Left out when there are none: OpenAI refuses an empty list.)
        ...(actionNames.length ? {
          tools: actionNames.map((name) => {
            const spec = toolSpec(name, compact);
            return { type: 'function', function: { name, description: spec.description, parameters: spec.inputSchema } };
          }),
        } : {}),
        stream: true,
        ...(preset.includeUsage ? { stream_options: { include_usage: true } } : {}),
      };
      const settings = this.config.providers[id];
      const res = await presetFetch(id, this.fetch, `${baseUrlFor(id, settings)}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // (Custom services may not need a key: then none is sent.)
          ...(preset.local || (preset.custom && !settings?.apiKey) ? {} : { authorization: `Bearer ${settings?.apiKey ?? ''}` }),
          ...preset.headers,
        },
        body: JSON.stringify(body),
        signal,
      });

      /** @type {{ id: string, name: string, args: string, signature?: string }[]} */
      const calls = [];
      let finishReason = 'stop';
      /** @type {any} */
      let usage = null;
      // The model's thinking (reasoning_content; "reasoning" on some endpoints): kept, not shown.
      let reasoning = '';
      for await (const chunk of readEvents(/** @type {ReadableStream<Uint8Array>} */ (res.body))) {
        if (chunk.error) throw new Error(`${preset.label}: ${chunk.error.message ?? JSON.stringify(chunk.error)}`);
        if (chunk.usage) usage = chunk.usage;
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};
        if (typeof delta.content === 'string' && delta.content) yield { type: 'text_delta', text: delta.content };
        if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
        else if (typeof delta.reasoning === 'string') reasoning += delta.reasoning;
        // Tool calls arrive in pieces: an index, then the id and name, then the arguments bit by bit.
        for (const piece of delta.tool_calls ?? []) {
          const index = piece.index ?? calls.length;
          const call = (calls[index] ??= { id: '', name: '', args: '' });
          if (piece.id) call.id = piece.id;
          if (piece.function?.name) call.name = piece.function.name;
          if (piece.function?.arguments) call.args += piece.function.arguments;
          // Gemini's thought signature for this call (kept, sent back with it).
          const signature = piece.extra_content?.google?.thought_signature;
          if (typeof signature === 'string') call.signature = signature;
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }

      // Kept with the assistant message, so it can go back with the next request: the reasoning (sendReasoning
      // presets) and Gemini's thought signatures, by tool call id.
      for (const call of calls) if (call && !call.id) call.id = newCallId();
      const signatures = Object.fromEntries(calls.filter((c) => c?.signature).map((c) => [c.id, c.signature]));
      if (reasoning || Object.keys(signatures).length) {
        yield { type: 'raw', content: { ...(reasoning ? { reasoning } : {}), ...(Object.keys(signatures).length ? { signatures } : {}) } };
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
 * What Gemini accepts in place of a thought signature on tool calls it didn't make itself (from another provider
 * earlier in the conversation), per Google's thought-signature documentation.
 */
const GEMINI_NO_SIGNATURE = 'skip_thought_signature_validator';

/**
 * Neutral conversation → Chat Completions messages.
 * - tool results become role "tool" messages right after the assistant's tool calls
 * - the rest of a user message (context, memory, text) becomes a user message
 * - screenshots from tool results follow as an image in a user message ("tool" messages can't hold images);
 *   only the last MAX_IMAGES_SENT are attached (each costs ~1–1.5k tokens on every call), as for Anthropic
 * - compact mode (local models): only the last COMPACT_FULL_RESULTS tool results are sent in full (older ones are
 *   shortened), and only the newest page context (the selected element etc.); site memory is always kept
 * - reasoningFor (thinking models): assistant messages carry the reasoning_content this provider returned with them;
 *   one with tool calls but no stored reasoning (written by another provider) gets an empty one, which these
 *   providers accept, where a missing one can be refused
 * - signaturesFor (Gemini): tool calls carry the thought signature this provider returned with them; the calls in a
 *   step made by another provider (no signatures) get Google's documented stand-in on the first one
 * @param {string} system
 * @param {NeutralMessage[]} messages
 * @param {{ compact?: boolean, reasoningFor?: string, signaturesFor?: string }} [opts]
 */
export function toOpenAIMessages(system, messages, { compact = false, reasoningFor = undefined, signaturesFor = undefined } = {}) {
  /** @type {Set<unknown>} tool_result blocks whose images are still sent */
  const keepImages = new Set();
  let imagesLeft = MAX_IMAGES_SENT;
  for (const m of [...messages].reverse()) {
    for (const b of m.content) {
      if (b.type === 'tool_result' && b.images?.length && imagesLeft >= b.images.length) {
        keepImages.add(b);
        imagesLeft -= b.images.length;
      }
    }
  }

  /** Compact mode: the tool results and page context blocks sent in full (the newest ones). @type {Set<unknown>} */
  const full = new Set();
  if (compact) {
    const blocks = messages.flatMap((m) => m.content);
    for (const b of blocks.filter((x) => x.type === 'tool_result').slice(-COMPACT_FULL_RESULTS)) full.add(b);
    const lastContext = blocks.findLast((x) => x.type === 'context');
    if (lastContext) full.add(lastContext);
  }
  /** @param {any} b */
  const shorten = (b) => {
    if (!compact || full.has(b)) return b.content;
    const text = String(b.content);
    return text.length > 300 ? `${text.slice(0, 300)}… (an older result, shortened)` : text;
  };

  /** @type {any[]} */
  const out = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'assistant') {
      const text = m.content.filter((b) => b.type === 'text').map((b) => /** @type {any} */ (b).text).join('\n');
      /** @type {any} */
      const raw = m.raw;
      /** @type {Record<string, string> | undefined} */
      const signatures = signaturesFor && raw?.provider === signaturesFor ? raw.content?.signatures : undefined;
      const toolCalls = m.content.filter((b) => b.type === 'tool_call').map((b, i) => {
        const c = /** @type {any} */ (b);
        // (Only the first call of a step has a signature when the model called several at once.)
        const signature = signaturesFor ? (signatures?.[c.id] ?? (i === 0 && !signatures ? GEMINI_NO_SIGNATURE : undefined)) : undefined;
        return {
          id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
          ...(signature ? { extra_content: { google: { thought_signature: signature } } } : {}),
        };
      });
      const reasoning = reasoningFor
        ? (raw?.provider === reasoningFor && typeof raw.content?.reasoning === 'string' ? raw.content.reasoning : (toolCalls.length ? '' : undefined))
        : undefined;
      out.push({
        role: 'assistant', content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        ...(reasoning !== undefined ? { reasoning_content: reasoning } : {}),
      });
      continue;
    }
    /** @type {any[]} */
    const images = [];
    for (const b of m.content) {
      if (b.type !== 'tool_result') continue;
      const r = /** @type {any} */ (b);
      const dropped = r.images?.length && !keepImages.has(b) ? '\n(The screenshot from this result is no longer attached.)' : '';
      out.push({ role: 'tool', tool_call_id: r.toolCallId, content: (r.isError ? `Error: ${shorten(r)}` : shorten(r)) + dropped });
      if (r.images && keepImages.has(b)) images.push(...r.images);
    }
    const parts = m.content
      .filter((b) => b.type !== 'tool_result' && !(compact && b.type === 'context' && !full.has(b)))
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
  // Gemini answers a bad key with 400 "API key not valid" / "Please pass a valid API key".
  if (status === 401 || status === 403 || (status === 400 && /api key/i.test(detail))) {
    return new Error(`The ${label} API key was not accepted. Check it in Options.`);
  }
  if (status === 404) return new Error(`This model is not available on ${label}. Pick another in the settings (Check key lists them).`);
  if (status === 402) return new Error(`Your ${label} account is out of credits.`);
  if (status === 429) return new Error(`${label} rate limit or quota reached. Wait a moment and try again.`);
  if (status >= 500) return new Error(`${label} had a temporary problem (${status}). Try again in a moment.`);
  return new Error(`${label} error ${status}${detail ? `: ${detail}` : ''}`);
}
