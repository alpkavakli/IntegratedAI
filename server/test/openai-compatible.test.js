import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OLLAMA_ORIGINS_HELP, PRESETS, httpError, openAICompatibleProvider, readEvents, toOpenAIMessages } from '../../extension/shared/providers/openai-compatible.js';
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

test('messages: only the last 3 screenshots are sent again; older ones become a note', () => {
  const shot = (i) => [
    { role: 'assistant', ts: 0, content: [{ type: 'tool_call', id: 's' + i, name: 'screenshot', input: {} }] },
    { role: 'user', ts: 0, content: [{ type: 'tool_result', toolCallId: 's' + i, content: 'shot ' + i, images: [{ mediaType: 'image/jpeg', data: 'IMG' + i }] }] },
  ];
  const out = toOpenAIMessages('S', [1, 2, 3, 4, 5].flatMap(shot));
  const sent = out.flatMap((m) => Array.isArray(m.content) ? m.content.filter((p) => p.type === 'image_url').map((p) => p.image_url.url.slice(-4)) : []);
  assert.deepEqual(sent, ['IMG3', 'IMG4', 'IMG5']);
  assert.match(out.find((m) => m.tool_call_id === 's1').content, /no longer attached/);
  assert.equal(out.find((m) => m.tool_call_id === 's5').content, 'shot 5');
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
  assert.deepEqual(list.map((p) => [p.id, p.available]), [['anthropic', false], ['openai', true], ['gemini', false], ['openrouter', true], ['ollama', false]]);
  assert.equal(list.find((p) => p.id === 'openai').defaultModel, 'gpt-x');
  assert.equal(list.find((p) => p.id === 'openrouter').defaultModel, PRESETS.openrouter.models[0]);
  assert.equal(await registry.pickDefault(), 'openai', 'preferred Gemini has no key, so the first provider with a key');
  const withGemini = new DirectRegistry(directConfig(/** @type {any} */ ({ ...base, providerKeys: { ...base.providerKeys, gemini: 'g' } })));
  assert.equal(await withGemini.pickDefault(), 'gemini');
});

test('Ollama: no key, address from Options, chosen model turns it on', async () => {
  const Ollama = openAICompatibleProvider('ollama');
  assert.equal((await Ollama.checkAvailability({ providers: { ollama: { model: '' } } })).available, false);
  assert.equal((await Ollama.checkAvailability({ providers: { ollama: { model: 'qwen3' } } })).available, true);
  const config = directConfig(/** @type {any} */ ({ providerKeys: {}, providerModels: { ollama: 'qwen3' }, providerUrls: { ollama: 'http://192.168.1.5:11434/v1/' } }));
  assert.equal(await new DirectRegistry(config).pickDefault(), 'ollama', 'usable without any key');

  let sent;
  const provider = new Ollama(config, {
    fetch: async (url, init) => {
      sent = { url, init };
      return sseResponse(sse([{ choices: [{ delta: { content: 'hi' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]));
    },
  });
  await collect(provider.turn({ messages: [], system: 'S', actionNames: [], model: 'qwen3', state: {}, signal: new AbortController().signal }));
  assert.equal(sent.url, 'http://192.168.1.5:11434/v1/chat/completions');
  assert.equal(sent.init.headers.authorization, undefined, 'no key is sent');
  assert.equal(JSON.parse(sent.init.body).stream_options, undefined);
});

test('Ollama: not running, and refusing the extension, give instructions', async () => {
  const Ollama = openAICompatibleProvider('ollama');
  const config = { providers: { ollama: { model: 'qwen3' } } };
  const run = (fetch) => collect(new Ollama(config, { fetch }).turn({ messages: [], system: 'S', actionNames: [], model: 'qwen3', state: {}, signal: new AbortController().signal }));
  await assert.rejects(run(async () => { throw new TypeError('Failed to fetch'); }), /Can't reach Ollama at http:\/\/localhost:11434\. Is it running\?/);
  await assert.rejects(run(async () => sseResponse('', 403)), (err) => err.message === OLLAMA_ORIGINS_HELP);
  await assert.rejects(run(async () => sseResponse('{"error":{"message":"registry.ollama.ai/library/gemma:2b does not support tools"}}', 400)), /does not support tools/);
  const aborted = Object.assign(new Error('aborted'), { name: 'AbortError' });
  await assert.rejects(run(async () => { throw aborted; }), (err) => err === aborted, 'stopping is not reported as "not running"');
});

test('compact mode: an Ollama option (off by default), never for hosted providers; short tool descriptions, same shapes', async () => {
  const Ollama = openAICompatibleProvider('ollama');
  const OpenAI = openAICompatibleProvider('openai');
  const settings = (/** @type {boolean | undefined} */ ollamaCompact) => directConfig(/** @type {any} */ ({ providerKeys: { openai: 'k' }, providerModels: { ollama: 'qwen3' }, ollamaCompact }));
  assert.equal(new Ollama(settings(undefined)).compact, false, 'off by default');
  assert.equal(new Ollama(settings(true)).compact, true);
  assert.equal(new OpenAI(settings(true)).compact, false);
  let sent;
  const provider = new Ollama(settings(true), {
    fetch: async (_url, init) => { sent = JSON.parse(init.body); return sseResponse(sse([{ choices: [{ delta: {}, finish_reason: 'stop' }] }])); },
  });
  await collect(provider.turn({ messages: [], system: 'S', actionNames: ['interact'], model: 'qwen3', state: {}, signal: new AbortController().signal, compact: true }));
  const tool = sent.tools[0].function;
  assert.ok(tool.description.length < 300);
  const fieldTexts = JSON.stringify(tool.parameters).match(/"description":"[^"]*"/g) ?? [];
  assert.ok(fieldTexts.length && fieldTexts.every((d) => d.length <= 110), 'short field descriptions');
  assert.match(tool.parameters.properties.description.description, /One short sentence/);
  assert.ok(tool.parameters.properties.description, 'a field named description stays');
  assert.deepEqual(tool.parameters.properties.steps.items.properties.action.enum.slice(0, 2), ['click', 'hover'], 'enums kept');
});

test('compact mode: older tool results are shortened, only the newest page context is sent', () => {
  const long = 'x'.repeat(2000);
  const step = (/** @type {number} */ i) => [
    { role: 'assistant', ts: 0, content: [{ type: 'tool_call', id: `c${i}`, name: 'page_outline', input: {} }] },
    { role: 'user', ts: 0, content: [{ type: 'tool_result', toolCallId: `c${i}`, content: long }] },
  ];
  const messages = /** @type {any[]} */ ([
    { role: 'user', ts: 0, content: [{ type: 'context', data: { page: { url: 'https://a.example/1' } } }, { type: 'text', text: 'first' }] },
    ...step(1), ...step(2), ...step(3), ...step(4), ...step(5),
    { role: 'user', ts: 0, content: [{ type: 'context', data: { page: { url: 'https://a.example/2' } } }, { type: 'text', text: 'second' }] },
  ]);
  const tools = (/** @type {any[]} */ out) => out.filter((m) => m.role === 'tool').map((m) => m.content.length);
  const compact = toOpenAIMessages('S', messages, { compact: true });
  assert.deepEqual(tools(compact).map((n) => n > 1000), [false, false, true, true, true], 'the last 3 in full');
  const users = compact.filter((m) => m.role === 'user').map((m) => m.content);
  assert.ok(!users[0].includes('a.example/1') && users[0].includes('first'), 'old context dropped, text kept');
  assert.ok(users[1].includes('a.example/2'));
  assert.ok(tools(toOpenAIMessages('S', messages)).every((n) => n === 2000), 'unchanged without compact');
});
