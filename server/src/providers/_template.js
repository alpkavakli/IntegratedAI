// @ts-check
/**
 * TEMPLATE for a new provider (OpenAI, Gemini, Ollama, OpenRouter, Grok, …).
 * Not registered. Copy this file, rename the class, then add it to PROVIDERS in registry.js.
 *
 * Checklist:
 *  1. checkAvailability(): API key present? local server (Ollama) reachable?
 *  2. turn(): convert the neutral messages to the provider's format, call the model,
 *     and yield events:
 *       text_delta  → visible reply text (stream it if you can)
 *       tool_call   → { id, name, input } for each action the model wants
 *       usage       → tokens and costUsd (null if unknown)
 *       raw         → provider-native assistant content you need back next time (optional)
 *       done        → stopReason
 *  3. Tools: providers with function calling can map ACTIONS[name].inputSchema directly
 *     (it is plain JSON Schema). Providers without tool calling can ask for the
 *     { reply, actions } envelope with envelopeSchema() like claude-cli.js does
 *     (set `static structuredEnvelope = true` so the system prompt explains it).
 *  4. Add the model's prices to pricing.js if the API only reports tokens.
 *
 * You don't need to handle approvals, validation or page inspection: the
 * orchestrator does that for every provider.
 */

import { ACTIONS } from '../../../extension/shared/actions.js';
import { Provider } from '../../../extension/shared/providers/base.js';
import { renderContext } from '../../../extension/shared/providers/common.js';

export class ExampleProvider extends Provider {
  static id = 'example';
  static label = 'Example provider';
  static models = ['example-model-large', 'example-model-small'];
  static capabilities = { streaming: true, nativeTools: true, reportsCost: false, vision: false };

  /** @param {import('../config.js').Config} _config */
  static async checkAvailability(_config) {
    const key = process.env.EXAMPLE_API_KEY;
    return key ? { available: true } : { available: false, reason: 'Set EXAMPLE_API_KEY' };
  }

  /**
   * @param {import('../../../extension/shared/providers/base.js').TurnRequest} req
   * @returns {AsyncGenerator<import('../../../extension/shared/providers/base.js').ProviderEvent>}
   */
  async *turn({ messages, system, actionNames, model, signal }) {
    // 1. Convert messages (see toAnthropicMessages in anthropic.js for a full example).
    const providerMessages = messages.map((m) => ({
      role: m.role,
      content: m.content
        .map((b) => (b.type === 'text' ? b.text : b.type === 'context' ? renderContext(b.data) : ''))
        .join('\n'),
    }));

    // 2. Convert actions to the provider's tool format.
    const tools = actionNames.map((name) => ({
      name,
      description: ACTIONS[name].description,
      parameters: ACTIONS[name].inputSchema,
    }));

    // 3. Call the API (fetch, SDK, …) with `signal` so Stop works.
    void providerMessages; void tools; void system; void model; void signal;
    /** @type {{ text: string, toolCalls: { id: string, name: string, args: unknown }[] }} */
    const response = { text: 'Hello from the example provider', toolCalls: [] };

    // 4. Yield events.
    yield { type: 'text_delta', text: response.text };
    for (const call of response.toolCalls) yield { type: 'tool_call', id: call.id, name: call.name, input: call.args };
    yield { type: 'usage', inputTokens: 0, outputTokens: 0, costUsd: null };
    yield { type: 'done', stopReason: 'end_turn' };
  }
}
