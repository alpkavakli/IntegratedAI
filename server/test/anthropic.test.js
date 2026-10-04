import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicProvider, toAnthropicMessages, toAnthropicTools } from '../src/providers/anthropic.js';
import { testConfig, collect } from './helpers.js';

test('messages: merge same-role messages, tool_results first, raw content reused', () => {
  const thinking = { type: 'thinking', thinking: '', signature: 'sig' };
  const raw = [thinking, { type: 'tool_use', id: 'toolu_1', name: 'inspect_element', input: { include: [] } }];
  const out = toAnthropicMessages([
    { role: 'user', ts: 0, content: [{ type: 'context', data: { page: 1 } }, { type: 'text', text: 'hi' }] },
    {
      role: 'assistant', ts: 0,
      content: [{ type: 'tool_call', id: 'toolu_1', name: 'inspect_element', input: { include: [] } }],
      raw: { provider: 'anthropic', content: raw },
    },
    { role: 'user', ts: 0, content: [{ type: 'tool_result', toolCallId: 'toolu_1', content: '{}' }] },
    { role: 'user', ts: 0, content: [{ type: 'note', text: 'applied' }, { type: 'tool_result', toolCallId: 'x', content: 'r' }] },
  ]);
  assert.equal(out.length, 3);
  assert.match(out[0].content[0].text, /<page_context>/);
  assert.deepEqual(out[1].content, raw, 'thinking blocks are passed back unchanged');
  assert.deepEqual(out[2].content.map((b) => b.type), ['tool_result', 'tool_result', 'text']);
});

test('messages: assistant from another provider becomes text + tool_use', () => {
  const out = toAnthropicMessages([
    { role: 'user', ts: 0, content: [{ type: 'text', text: 'q' }] },
    { role: 'assistant', ts: 0, content: [{ type: 'text', text: 'a' }, { type: 'tool_call', id: 'call_1', name: 'inject_css', input: {} }] },
  ]);
  assert.deepEqual(out[1].content.map((b) => b.type), ['text', 'tool_use']);
});

test('tools are strict', () => {
  const tools = toAnthropicTools(['inject_css']);
  assert.equal(tools[0].strict, true);
  assert.equal(tools[0].input_schema.additionalProperties, false);
});

/** Minimal stand-in for client.beta.messages.stream(). */
function fakeClient(finalMessage, deltas = []) {
  const calls = [];
  return {
    calls,
    beta: {
      messages: {
        stream(params) {
          calls.push(params);
          return {
            async *[Symbol.asyncIterator]() {
              for (const text of deltas) yield { type: 'content_block_delta', delta: { type: 'text_delta', text } };
            },
            finalMessage: async () => finalMessage,
          };
        },
      },
    },
  };
}

test('provider: streams text, emits tool calls, usage cost and raw content', async () => {
  const final = {
    stop_reason: 'tool_use',
    usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    content: [
      { type: 'text', text: 'Hello' },
      { type: 'tool_use', id: 'toolu_9', name: 'inject_css', input: { description: 'd', css: 'a{}' } },
    ],
  };
  const client = fakeClient(final, ['Hel', 'lo']);
  const config = testConfig();
  config.providers.anthropic.apiKey = 'sk-test';
  const provider = new AnthropicProvider(config, { client });
  const events = await collect(provider.turn({
    messages: [{ role: 'user', ts: 0, content: [{ type: 'text', text: 'hi' }] }],
    system: 'sys', actionNames: ['inject_css'], model: 'claude-opus-5-5', state: {}, signal: new AbortController().signal,
  }));
  assert.deepEqual(events.map((e) => e.type), ['text_delta', 'text_delta', 'usage', 'tool_call', 'raw', 'done']);
  // $4/M in + $20/M out
  assert.ok(Math.abs(events[2].costUsd - (1000 * 4 + 100 * 20) / 1e6) < 1e-12);

  const params = client.calls[0];
  assert.equal(params.fallbacks, 'default');
  assert.deepEqual(params.output_config, { effort: 'medium' });
  assert.equal(params.tool_choice, undefined, 'forced tool choice is not allowed on Opus 5.5');
});

test('provider: truncated responses never yield tool calls', async () => {
  const final = { stop_reason: 'max_tokens', usage: {}, content: [{ type: 'tool_use', id: 't', name: 'inject_css', input: {} }] };
  const config = testConfig();
  config.providers.anthropic.apiKey = 'sk-test';
  const provider = new AnthropicProvider(config, { client: fakeClient(final) });
  const events = await collect(provider.turn({
    messages: [], system: 's', actionNames: [], model: 'claude-haiku-4-5', state: {}, signal: new AbortController().signal,
  }));
  assert.ok(!events.some((e) => e.type === 'tool_call'));
});

test('availability requires an API key', async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    assert.equal((await AnthropicProvider.checkAvailability(testConfig())).available, false);
    const config = testConfig();
    config.providers.anthropic.apiKey = 'sk-x';
    assert.equal((await AnthropicProvider.checkAvailability(config)).available, true);
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
});
