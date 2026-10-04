import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { PageTools } from '../src/agent/page-tools.js';
import { handleMcpRequest } from '../src/mcp.js';
import { Orchestrator } from '../src/agent/orchestrator.js';
import { Provider } from '../src/providers/base.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { SessionStore } from '../src/sessions/store.js';
import { buildSystemPrompt } from '../src/agent/system-prompt.js';
import { testConfig } from './helpers.js';

/** Fake panel answering every inspection. */
function fakePanel() {
  const requests = [];
  return {
    requests,
    send: () => {},
    requestTool: async (conversationId, name, input) => {
      requests.push({ conversationId, name, input });
      return { ok: true, result: { found: [{ selector: 'nav.g_nav' }] } };
    },
  };
}

/** Start the MCP endpoint on a random port. */
async function startServer(pageTools) {
  let port = 0;
  const server = createServer((req, res) => {
    if (req.url === '/mcp') handleMcpRequest(req, res, { pageTools, port });
    else res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  const rpc = async (token, body, headers = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
  };
  return { server, port, rpc };
}

test('MCP endpoint: lists only inspections and runs them in the right conversation', async (t) => {
  const panel = fakePanel();
  const pageTools = new PageTools(panel);
  const { server, rpc } = await startServer(pageTools);
  t.after(() => server.close());
  const { token, revoke } = pageTools.grant('conv-1', ['find_elements', 'inspect_element', 'inject_css', 'remember'], new AbortController().signal);

  const init = await rpc(token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
  assert.equal(init.body.result.protocolVersion, '2025-11-25');
  assert.equal((await rpc(token, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);

  const list = await rpc(token, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(list.body.result.tools.map((x) => x.name), ['find_elements', 'inspect_element']);
  assert.equal(list.body.result.tools[0].inputSchema.type, 'object');

  const call = await rpc(token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'find_elements', arguments: { text: 'Library' } } });
  assert.equal(call.body.result.isError, false);
  assert.match(call.body.result.content[0].text, /nav\.g_nav/);
  assert.deepEqual(panel.requests, [{ conversationId: 'conv-1', name: 'find_elements', input: { text: 'Library' } }]);

  // Changes are never runnable here, and inputs are validated.
  const change = await rpc(token, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'inject_css', arguments: { description: 'x', css: 'a{}' } } });
  assert.equal(change.body.result.isError, true);
  const bad = await rpc(token, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'inspect_element', arguments: { include: ['everything'] } } });
  assert.equal(bad.body.result.isError, true);
  assert.equal(panel.requests.length, 1);

  const unknown = await rpc(token, { jsonrpc: '2.0', id: 6, method: 'server/discover' });
  assert.equal(unknown.body.error.code, -32601);

  revoke();
  assert.equal((await rpc(token, { jsonrpc: '2.0', id: 7, method: 'tools/list' })).status, 401, 'token expires with the call');
});

test('MCP endpoint: rejects missing tokens, browser origins and foreign hosts', async (t) => {
  const pageTools = new PageTools(fakePanel());
  const { server, port, rpc } = await startServer(pageTools);
  t.after(() => server.close());
  const { token } = pageTools.grant('c', ['find_elements'], new AbortController().signal);
  const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' };

  assert.equal((await rpc(null, list)).status, 401);
  assert.equal((await rpc('wrong', list)).status, 401);
  assert.equal((await rpc(token, list, { origin: 'https://evil.example' })).status, 403);

  // fetch() won't let us fake Host, so use a raw request.
  const { request } = await import('node:http');
  const status = await new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { host: 'evil.example', authorization: `Bearer ${token}` } },
      (res) => { res.resume(); resolve(res.statusCode); });
    req.end(JSON.stringify(list));
  });
  assert.equal(status, 403);
});

test('orchestrator: gives MCP-capable providers a token that works only during the call', async () => {
  const seen = [];
  let pageTools;
  class McpProvider extends Provider {
    static id = 'mcp-test';
    static models = ['m'];
    static structuredEnvelope = true;
    static pageToolsViaMcp = true;
    static async checkAvailability() { return { available: true }; }
    async *turn(req) {
      seen.push({ pageTools: req.pageTools, system: req.system, live: Boolean(pageTools.lookup(req.pageTools?.token)) });
      // What Claude Code does through /mcp during the call.
      await pageTools.call(pageTools.lookup(req.pageTools.token), 'find_elements', { text: 'Library' });
      yield { type: 'text_delta', text: 'ok' };
      yield { type: 'done', stopReason: 'end_turn' };
    }
  }
  const config = testConfig({ defaultProvider: 'mcp-test', port: 7823 });
  const panel = fakePanel();
  pageTools = new PageTools(panel);
  const store = new SessionStore(config.dataDir);
  const orchestrator = new Orchestrator({ store, registry: new ProviderRegistry(config, [McpProvider]), config, panel, pageTools });
  const session = await orchestrator.openSession({ url: 'https://example.com/' });
  await orchestrator.chat(session, { text: 'find the nav bar' });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].pageTools.url, 'http://127.0.0.1:7823/mcp');
  assert.ok(seen[0].live, 'token valid while the provider runs');
  assert.equal(pageTools.lookup(seen[0].pageTools.token), null, 'revoked afterwards');
  assert.match(seen[0].system, /Inspections are real tools/);
  assert.deepEqual(panel.requests.map((r) => [r.conversationId, r.name]), [[session.id, 'find_elements']]);
  // The chat keeps a record of what was inspected, before the reply.
  const reply = session.messages.at(-1);
  assert.deepEqual(reply.content.map((b) => b.type), ['inspection', 'text']);
  assert.deepEqual(reply.content[0], { type: 'inspection', name: 'find_elements', input: { text: 'Library' } });
});

test('system prompt: without page tools, inspections go in actions', () => {
  const names = ['find_elements', 'inject_css'];
  assert.doesNotMatch(buildSystemPrompt({ actionNames: names, structuredEnvelope: true }), /Inspections are real tools/);
  assert.match(buildSystemPrompt({ actionNames: names, structuredEnvelope: true, pageTools: true }), /changes and memory updates .* are NOT\ntools/);
});

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

test('formatResult: a screenshot becomes an image next to the text, invalid images are dropped', async () => {
  const { formatResult } = await import('../src/agent/page-tools.js');
  const ok = formatResult({ captured: 'nav.g_nav', image: { mediaType: 'image/png', data: PNG_1PX } });
  assert.deepEqual(ok.images, [{ mediaType: 'image/png', data: PNG_1PX }]);
  assert.deepEqual(JSON.parse(ok.text), { captured: 'nav.g_nav', image: 'attached' });
  assert.doesNotMatch(ok.text, /iVBOR/, 'image data is never sent as text');

  for (const image of [{ mediaType: 'image/svg+xml', data: PNG_1PX }, { mediaType: 'image/png', data: 'not base64!' }, { mediaType: 'image/png', data: 'A'.repeat(6 * 1024 * 1024) }]) {
    const bad = formatResult({ image });
    assert.equal(bad.images, undefined);
    assert.match(bad.text, /missing/);
  }
  assert.equal(formatResult({ found: [] }).images, undefined);
});

test('MCP endpoint: screenshots are returned as image content', async (t) => {
  const panel = {
    send: () => {},
    requestTool: async () => ({ ok: true, result: { captured: 'nav.g_nav', image: { mediaType: 'image/png', data: PNG_1PX } } }),
  };
  const pageTools = new PageTools(panel);
  const { server, rpc } = await startServer(pageTools);
  t.after(() => server.close());
  const { token } = pageTools.grant('c', ['screenshot'], new AbortController().signal);
  const res = await rpc(token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'screenshot', arguments: { selector: 'nav' } } });
  const [text, image] = res.body.result.content;
  assert.equal(text.type, 'text');
  assert.deepEqual(image, { type: 'image', data: PNG_1PX, mimeType: 'image/png' });
});

test('orchestrator: screenshot results keep their image for providers that read tool results', async () => {
  let call = 0;
  class Plain extends Provider {
    static id = 'plain';
    static models = ['m'];
    static async checkAvailability() { return { available: true }; }
    async *turn() {
      if (call++ === 0) yield { type: 'tool_call', id: 'c1', name: 'screenshot', input: { selector: 'nav' } };
      else yield { type: 'text_delta', text: 'It is white.' };
      yield { type: 'done', stopReason: 'end_turn' };
    }
  }
  const config = testConfig({ defaultProvider: 'plain' });
  const panel = { send: () => {}, requestTool: async () => ({ ok: true, result: { captured: 'nav', image: { mediaType: 'image/png', data: PNG_1PX } } }) };
  const store = new SessionStore(config.dataDir);
  const orchestrator = new Orchestrator({ store, registry: new ProviderRegistry(config, [Plain]), config, panel });
  const session = await orchestrator.openSession({ url: 'https://example.com/' });
  await orchestrator.chat(session, { text: 'what colour is the nav?' });
  const result = session.messages.flatMap((m) => m.content).find((b) => b.type === 'tool_result');
  assert.deepEqual(result.images, [{ mediaType: 'image/png', data: PNG_1PX }]);
  assert.doesNotMatch(result.content, /iVBOR/);
});
