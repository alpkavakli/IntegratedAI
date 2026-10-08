import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OLLAMA_ORIGINS_HELP, PRESETS, baseUrlFor, httpError, openAICompatibleProvider, readEvents, toOpenAIMessages } from '../../extension/shared/providers/openai-compatible.js';
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
  assert.deepEqual(list.map((p) => [p.id, p.available]), [['anthropic', false], ['openai', true], ['gemini', false], ['openrouter', true],
    ['deepseek', false], ['qwen', false], ['kimi', false], ['glm', false], ['minimax', false], ['custom', false], ['ollama', false]]);
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

test('thinking models: the reasoning is kept with the answer and sent back to the same provider only', async () => {
  let sent;
  const DeepSeek = openAICompatibleProvider('deepseek');
  const provider = new DeepSeek(directConfig(/** @type {any} */ ({ providerKeys: { deepseek: 'k' }, providerModels: {} })), {
    fetch: async (_url, init) => {
      sent = JSON.parse(init.body);
      return sseResponse(sse([
        { choices: [{ delta: { reasoning_content: 'Look up ' } }] },
        { choices: [{ delta: { reasoning_content: 'the button.' } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'find_elements', arguments: '{"text":"Go"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      ]));
    },
  });
  const events = await collect(provider.turn({ messages: [{ role: 'user', ts: 0, content: [{ type: 'text', text: 'click go' }] }], system: 'S', actionNames: ['find_elements'], model: 'deepseek-flash', state: {}, signal: new AbortController().signal }));
  assert.deepEqual(events.find((e) => e.type === 'raw')?.content, { reasoning: 'Look up the button.' });
  assert.equal(events.some((e) => e.type === 'text_delta' && /Look up/.test(e.text)), false, 'never shown in the chat');

  const history = /** @type {any[]} */ ([
    { role: 'user', ts: 0, content: [{ type: 'text', text: 'click go' }] },
    { role: 'assistant', ts: 0, raw: { provider: 'deepseek', content: { reasoning: 'Look up the button.' } }, content: [{ type: 'tool_call', id: 'c1', name: 'find_elements', input: { text: 'Go' } }] },
    { role: 'user', ts: 0, content: [{ type: 'tool_result', toolCallId: 'c1', content: '[]' }] },
    { role: 'assistant', ts: 0, raw: { provider: 'ollama', content: { reasoning: 'other model' } }, content: [{ type: 'tool_call', id: 'c2', name: 'find_elements', input: {} }] },
    { role: 'user', ts: 0, content: [{ type: 'tool_result', toolCallId: 'c2', content: '[]' }] },
    { role: 'assistant', ts: 0, content: [{ type: 'text', text: 'done' }] },
  ]);
  const assistants = (/** @type {any[]} */ out) => out.filter((m) => m.role === 'assistant');
  const toDeepSeek = assistants(toOpenAIMessages('S', history, { reasoningFor: 'deepseek' }));
  assert.equal(toDeepSeek[0].reasoning_content, 'Look up the button.', 'sent back unchanged');
  assert.equal(toDeepSeek[1].reasoning_content, '', 'another provider\'s tool call: an empty one, not a missing one');
  assert.equal('reasoning_content' in toDeepSeek[2], false, 'plain answers from others: nothing');
  assert.ok(assistants(toOpenAIMessages('S', history)).every((m) => !('reasoning_content' in m)), 'OpenAI etc. never get it');
  assert.equal(PRESETS.openai.sendReasoning, undefined);
  for (const id of ['deepseek', 'qwen', 'kimi', 'glm', 'minimax']) assert.equal(PRESETS[id].sendReasoning, true, id);
});

test('Gemini: thought signatures on tool calls are kept and sent back with them, to Gemini only', async () => {
  const Gemini = openAICompatibleProvider('gemini');
  const provider = new Gemini(directConfig(/** @type {any} */ ({ providerKeys: { gemini: 'k' }, providerModels: {} })), {
    fetch: async () => sseResponse(sse([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'g1', type: 'function', function: { name: 'page_outline', arguments: '{}' }, extra_content: { google: { thought_signature: 'SIG-1' } } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ])),
  });
  const events = await collect(provider.turn({ messages: [{ role: 'user', ts: 0, content: [{ type: 'text', text: 'look' }] }], system: 'S', actionNames: ['page_outline'], model: 'gemini-3.8-flash', state: {}, signal: new AbortController().signal }));
  assert.deepEqual(events.find((e) => e.type === 'raw')?.content, { signatures: { g1: 'SIG-1' } });

  const history = /** @type {any[]} */ ([
    { role: 'user', ts: 0, content: [{ type: 'text', text: 'look' }] },
    { role: 'assistant', ts: 0, raw: { provider: 'gemini', content: { signatures: { g1: 'SIG-1' } } }, content: [{ type: 'tool_call', id: 'g1', name: 'page_outline', input: {} }] },
    { role: 'user', ts: 0, content: [{ type: 'tool_result', toolCallId: 'g1', content: '{}' }] },
    { role: 'assistant', ts: 0, raw: { provider: 'claude-cli', content: {} }, content: [{ type: 'tool_call', id: 'x1', name: 'read_text', input: {} }, { type: 'tool_call', id: 'x2', name: 'read_text', input: {} }] },
    { role: 'user', ts: 0, content: [{ type: 'tool_result', toolCallId: 'x1', content: '' }, { type: 'tool_result', toolCallId: 'x2', content: '' }] },
  ]);
  const calls = toOpenAIMessages('S', history, { signaturesFor: 'gemini' }).filter((m) => m.role === 'assistant').map((m) => m.tool_calls);
  assert.equal(calls[0][0].extra_content.google.thought_signature, 'SIG-1', 'sent back unchanged');
  assert.equal(calls[1][0].extra_content.google.thought_signature, 'skip_thought_signature_validator', 'another provider\'s step: the stand-in on its first call');
  assert.equal('extra_content' in calls[1][1], false, 'and not on the others');
  const toOthers = toOpenAIMessages('S', history).filter((m) => m.role === 'assistant').flatMap((m) => m.tool_calls);
  assert.ok(toOthers.every((c) => !('extra_content' in c)), 'other providers never get it');
  assert.equal(PRESETS.gemini.thoughtSignatures, true);
});

test('a text-only model that refuses images: the same request without them, and none after that', async () => {
  const bodies = [];
  const Glm = openAICompatibleProvider('glm');
  const provider = new Glm(directConfig(/** @type {any} */ ({ providerKeys: { glm: 'k' }, providerModels: {} })), {
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      const hasImage = body.messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));
      if (hasImage) return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: "messages.content.type is invalid, allowed values: ['text']" } }) };
      return sseResponse(sse([{ choices: [{ delta: { content: 'ok' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]));
    },
  });
  const history = /** @type {any[]} */ ([
    { role: 'user', ts: 0, content: [{ type: 'text', text: 'look' }] },
    { role: 'assistant', ts: 0, content: [{ type: 'tool_call', id: 's1', name: 'screenshot', input: {} }] },
    { role: 'user', ts: 0, content: [{ type: 'tool_result', toolCallId: 's1', content: 'captured', images: [{ mediaType: 'image/jpeg', data: 'AAAA' }] }] },
  ]);
  const state = {};
  const run = () => collect(provider.turn({ messages: history, system: 'S', actionNames: [], model: 'glm-4.7-flash', state, signal: new AbortController().signal }));
  const first = await run();
  assert.ok(first.some((e) => e.type === 'text_delta' && e.text === 'ok'), 'answered after the retry');
  assert.equal(bodies.length, 2, 'refused once, then sent without the image');
  assert.match(JSON.stringify(bodies[1].messages), /can't see images/);
  await run();
  assert.equal(bodies.length, 3, 'the next call goes without images straight away');
});

test('providers with other regions or per-account addresses use the address from Options; others never do', () => {
  assert.equal(baseUrlFor('kimi', { baseUrl: '' }), 'https://api.moonshot.ai/v1');
  assert.equal(baseUrlFor('kimi', { baseUrl: 'https://api.moonshot.cn/v1/' }), 'https://api.moonshot.cn/v1');
  assert.equal(baseUrlFor('qwen', { baseUrl: 'https://ws1.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1' }), 'https://ws1.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1');
  assert.equal(baseUrlFor('openai', { baseUrl: 'https://evil.example/v1' }), 'https://api.openai.com/v1', 'fixed address');
});

test('Custom: any OpenAI-compatible service at the address from Options; the key is optional', async () => {
  const Custom = openAICompatibleProvider('custom');
  const config = (/** @type {any} */ extra) => directConfig(/** @type {any} */ ({ providerKeys: {}, providerModels: {}, providerUrls: {}, ...extra }));
  assert.equal((await Custom.checkAvailability(config({}))).available, false);
  assert.equal((await Custom.checkAvailability(config({ providerUrls: { custom: 'http://localhost:1234/v1' } }))).available, false, 'needs a model too');
  const ready = config({ providerUrls: { custom: 'http://localhost:1234/v1/' }, providerModels: { custom: 'my-model' } });
  assert.equal((await Custom.checkAvailability(ready)).available, true, 'no key needed');
  let sent;
  const provider = new Custom(ready, {
    fetch: async (url, init) => { sent = { url, init }; return sseResponse(sse([{ choices: [{ delta: {}, finish_reason: 'stop' }] }])); },
  });
  await collect(provider.turn({ messages: [], system: 'S', actionNames: [], model: 'my-model', state: {}, signal: new AbortController().signal }));
  assert.equal(sent.url, 'http://localhost:1234/v1/chat/completions');
  assert.equal(sent.init.headers.authorization, undefined, 'no key, no header');
  const keyed = new Custom(config({ providerUrls: { custom: 'https://api.example.com/v1' }, providerModels: { custom: 'm' }, providerKeys: { custom: 'sk-1' } }), {
    fetch: async (url, init) => { sent = { url, init }; return sseResponse(sse([{ choices: [{ delta: {}, finish_reason: 'stop' }] }])); },
  });
  await collect(keyed.turn({ messages: [], system: 'S', actionNames: [], model: 'm', state: {}, signal: new AbortController().signal }));
  assert.equal(sent.init.headers.authorization, 'Bearer sk-1');
});

test('the model menu: built-in suggestions, then the models the provider listed (new ones without an update)', async () => {
  const registry = new DirectRegistry(directConfig(/** @type {any} */ ({
    providerKeys: { deepseek: 'k' }, providerModels: {},
    modelLists: { deepseek: { ids: ['deepseek-flash', 'deepseek-v5'], at: 1 } },
  })));
  const deepseek = (await registry.list()).find((p) => p.id === 'deepseek');
  assert.deepEqual(deepseek.models, ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-v5']);
});

test('a busy service while answering: the provider says so (for the panel), then goes on', async () => {
  const { RETRY_WAITS_MS } = await import('../../extension/shared/providers/openai-compatible.js');
  const saved = [...RETRY_WAITS_MS];
  RETRY_WAITS_MS.fill(1);
  try {
    let calls = 0;
    const Glm = openAICompatibleProvider('glm');
    const provider = new Glm(directConfig(/** @type {any} */ ({ providerKeys: { glm: 'k' }, providerModels: {} })), {
      fetch: async () => (++calls < 3
        ? { ok: false, status: 429, headers: new Map(), text: async () => JSON.stringify({ error: { message: 'The service may be temporarily overloaded' } }) }
        : sseResponse(sse([{ choices: [{ delta: { content: 'ok' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]))),
    });
    const events = await collect(provider.turn({ messages: [{ role: 'user', ts: 0, content: [{ type: 'text', text: 'hi' }] }], system: 'S', actionNames: [], model: 'glm-4.7-flash', state: {}, signal: new AbortController().signal }));
    const busy = events.filter((e) => e.type === 'status');
    assert.equal(busy.length, 2, 'one notice per wait');
    assert.deepEqual({ status: busy[0].status, provider: busy[0].provider }, { status: 'busy', provider: 'GLM' });
    assert.ok(events.some((e) => e.type === 'text_delta' && e.text === 'ok'));
  } finally {
    RETRY_WAITS_MS.splice(0, RETRY_WAITS_MS.length, ...saved);
  }
});

test('a busy service (503) is tried again before it counts as an error', async () => {
  const { RETRY_WAITS_MS, presetFetch } = await import('../../extension/shared/providers/openai-compatible.js');
  const saved = [...RETRY_WAITS_MS];
  RETRY_WAITS_MS.fill(1);
  try {
    let calls = 0;
    const flaky = async () => (++calls < 3 ? { ok: false, status: 503, headers: new Map(), text: async () => 'busy' } : { ok: true, status: 200 });
    const res = await presetFetch('gemini', flaky, 'https://x/chat', {});
    assert.equal(res.status, 200);
    assert.equal(calls, 3, 'twice more');
    calls = 0;
    await assert.rejects(presetFetch('gemini', async () => { calls++; return { ok: false, status: 503, headers: new Map(), text: async () => 'busy' }; }, 'https://x/chat', {}), /503|temporary/i);
    assert.equal(calls, 3, 'then the error');
    calls = 0;
    await assert.rejects(presetFetch('gemini', async () => { calls++; return { ok: false, status: 400, headers: new Map(), text: async () => 'bad' }; }, 'https://x/chat', {}));
    assert.equal(calls, 1, 'a real error is not tried again');
  } finally {
    RETRY_WAITS_MS.splice(0, RETRY_WAITS_MS.length, ...saved);
  }
});
