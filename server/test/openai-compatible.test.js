import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS, httpError, openAICompatibleProvider, readEvents, toOpenAIMessages } from '../../extension/shared/providers/openai-compatible.js';
import { DirectRegistry, directConfig } from '../../extension/panel/direct/direct-client.js';
import { collect } from './helpers.js';

/** A Response-like object streaming the given SSE text in small chunks. */
function sseResponse(text, status = 200) {
  const bytes = new TextEncoder().encode(text);
  return {
    ok: status < 400,
    status,
    text: async () => text,
    body: new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 13) controller.enqueue(bytes.slice(i, i + 13)); // awkward chunk boundaries
        controller.close();
      },
    }),
  };
}
const sse = (chunks) => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';

test('messages: tool results follow the tool calls; context and screenshots become a user message', () => {
  const out = toOpenAIMessages('SYSTEM', [
    { role: 'user', ts: 0, content: [{ type: 'context', data: { page: 1 } }, { type: 'text', text: 'make it red' }] },
    { role: 'assistant', ts: 0, content: [{ type: 'text', text: 'Looking' }, { type: 'tool_call', id: 'c1', name: 'find_elements', input: { text: 'Buy' } }] },
    { role: 'user', ts: 0, content: [
      { type: 'tool_result', toolCallId: 'c1', content: '{"total":1}', images: [{ mediaType: 'image/png', data: 'AAAA' }] },
      { type: 'note', text: 'applied' },
    ] },
  ]);
  assert.deepEqual(out.map((m) => m.role), ['system', 'user', 'assistant', 'tool', 'user']);
  assert.match(out[1].content, /<page_context>[\s\S]*make it red/);
  assert.deepEqual(out[2].tool_calls[0], { id: 'c1', type: 'function', function: { name: 'find_elements', arguments: '{"text":"Buy"}' } });
  assert.equal(out[3].tool_call_id, 'c1');
  assert.equal(out[4].content.at(-1).type, 'image_url');
  assert.match(out[4].content.at(-1).image_url.url, /^data:image\/png;base64,AAAA$/);
});

test('SSE reader handles split chunks and [DONE]', async () => {
  const res = sseResponse(sse([{ a: 1 }, { b: 2 }]) + 'data: {"after":"done"}\n\n');
  const events = [];
  for await (const e of readEvents(res.body)) events.push(e);
  assert.deepEqual(events, [{ a: 1 }, { b: 2 }]);
});

test('provider: streams text, assembles tool calls from pieces, reports usage', async () => {
  const OpenAI = openAICompatibleProvider('openai');
  const requests = [];
  const fakeFetch = async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body) });
    return sseResponse(sse([
      { choices: [{ delta: { content: 'Let me ' } }] },
      { choices: [{ delta: { content: 'look.' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'find_elements', arguments: '{"te' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'xt":"Buy"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 900, completion_tokens: 40 } },
    ]));
  };
  const provider = new OpenAI({ providers: { openai: { apiKey: 'sk-test', model: 'gpt-6.1-sol' } } }, { fetch: fakeFetch });
  const events = await collect(provider.turn({
    messages: [{ role: 'user', ts: 0, content: [{ type: 'text', text: 'hi' }] }],
    system: 'S', actionNames: ['find_elements', 'inject_css'], model: 'gpt-6.1-sol', state: {}, signal: new AbortController().signal,
  }));
  assert.deepEqual(events.filter((e) => e.type === 'text_delta').map((e) => e.text).join(''), 'Let me look.');
  const call = events.find((e) => e.type === 'tool_call');
  assert.deepEqual(call, { type: 'tool_call', id: 'call_a', name: 'find_elements', input: { text: 'Buy' } });
  assert.deepEqual(events.find((e) => e.type === 'usage'), { type: 'usage', inputTokens: 900, outputTokens: 40, costUsd: null });

  const { url, init, body } = requests[0];
  assert.equal(url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(init.headers.authorization, 'Bearer sk-test');
  assert.equal(body.stream, true);
  assert.deepEqual(body.tools.map((t) => t.function.name), ['find_elements', 'inject_css']);
  assert.equal(body.messages[0].role, 'system');
});

test('provider: a cut-off answer never runs its tool calls; Gemini gets no stream_options', async () => {
  const Gemini = openAICompatibleProvider('gemini');
  let sent;
  const provider = new Gemini({ providers: { gemini: { apiKey: 'g', model: 'gemini-3.8-flash' } } }, {
    fetch: async (url, init) => {
      sent = { url, body: JSON.parse(init.body) };
      return sseResponse(sse([
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'inject_css', arguments: '{"css":"a{' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'length' }] },
      ]));
    },
  });
  const events = await collect(provider.turn({ messages: [], system: 'S', actionNames: ['inject_css'], model: 'gemini-3.8-flash', state: {}, signal: new AbortController().signal }));
  assert.ok(!events.some((e) => e.type === 'tool_call'));
  assert.equal(events.at(-1).stopReason, 'max_tokens');
  assert.match(sent.url, /generativelanguage\.googleapis\.com\/v1beta\/openai\/chat\/completions$/);
  assert.equal(sent.body.stream_options, undefined);
});

test('HTTP errors become readable messages', async () => {
  assert.match(httpError('OpenAI', 401, '{"error":{"message":"bad key"}}').message, /key was not accepted/);
  assert.match(httpError('OpenRouter', 402, '').message, /out of credits/);
  assert.match(httpError('Google Gemini', 404, '').message, /not available/);
  // Real responses for a bad key (2026-10-05).
  assert.match(httpError('Google Gemini', 400, '[{"error":{"code":400,"message":"Please pass a valid API key","status":"INVALID_ARGUMENT"}}]').message, /key was not accepted/);
  assert.match(httpError('OpenRouter', 401, '{"error":{"message":"User not found.","code":401}}').message, /key was not accepted/);
  assert.match(httpError('OpenAI', 400, '{"error":{"message":"Invalid schema"}}').message, /400: Invalid schema/);
  const OpenRouter = openAICompatibleProvider('openrouter');
  const provider = new OpenRouter({ providers: { openrouter: { apiKey: 'x', model: 'm' } } }, { fetch: async () => sseResponse('{"error":{"message":"nope"}}', 401) });
  await assert.rejects(collect(provider.turn({ messages: [], system: 'S', actionNames: [], model: 'm', state: {}, signal: new AbortController().signal })), /OpenRouter API key was not accepted/);
});

test('direct registry: every provider with a key is available; the preferred one is picked first', async () => {
  const base = { anthropicApiKey: '', directModel: '', directProvider: 'gemini', providerKeys: { openai: 'o', gemini: '', openrouter: 'r' }, providerModels: { openai: 'gpt-x', gemini: '', openrouter: '' } };
  const registry = new DirectRegistry(directConfig(/** @type {any} */ (base)));
  const list = await registry.list();
  assert.deepEqual(list.map((p) => [p.id, p.available]), [['anthropic', false], ['openai', true], ['gemini', false], ['openrouter', true]]);
  assert.equal(list.find((p) => p.id === 'openai').defaultModel, 'gpt-x');
  assert.equal(list.find((p) => p.id === 'openrouter').defaultModel, PRESETS.openrouter.models[0]);
  assert.equal(await registry.pickDefault(), 'openai', 'preferred Gemini has no key, so the first provider with a key');
  const withGemini = new DirectRegistry(directConfig(/** @type {any} */ ({ ...base, providerKeys: { ...base.providerKeys, gemini: 'g' } })));
  assert.equal(await withGemini.pickDefault(), 'gemini');
});
