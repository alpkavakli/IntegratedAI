import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequestHandler } from '../../extension/shared/agent/requests.js';
import { MemoryStore } from '../../extension/shared/agent/memory.js';
import { Orchestrator } from '../../extension/shared/agent/orchestrator.js';
import { fingerprint, newSession } from '../../extension/shared/agent/session-model.js';
import { AnthropicProvider } from '../../extension/shared/providers/anthropic.js';
import { Provider } from '../../extension/shared/providers/base.js';
import { DirectRegistry, directConfig } from '../../extension/panel/direct/direct-client.js';

/** In-memory stores, like direct mode's (but without IndexedDB / chrome.storage). */
function memoryOnlyStores() {
  const sessions = new Map();
  const store = {
    create: (init) => { const s = newSession(init); sessions.set(s.id, s); return s; },
    get: async (id) => sessions.get(id) ?? null,
    save: () => {},
    listForSite: (site) => [...sessions.values()].filter((s) => s.site === site).map((s) => ({ id: s.id, site: s.site, groupPattern: s.groupPattern ?? '/', updatedAt: s.updatedAt, title: s.title })),
  };
  const saved = new Map();
  const memory = new MemoryStore({ read: (site) => saved.get(site) ?? null, write: (m) => saved.set(m.site, structuredClone(m)) });
  return { store, memory, saved };
}

function setup(steps = []) {
  class Scripted extends Provider {
    static id = 'scripted';
    static models = ['m'];
    static async checkAvailability() { return { available: true }; }
    async *turn() {
      for (const ev of steps.shift() ?? [{ type: 'text_delta', text: 'ok' }]) yield ev;
      yield { type: 'done', stopReason: 'end_turn' };
    }
  }
  const registry = {
    get: (id) => (id === 'scripted' ? Scripted : undefined),
    isAvailable: async () => ({ available: true }),
    pickDefault: async () => 'scripted',
    create: () => new Scripted({ providers: {} }),
    list: async () => [{ id: 'scripted', available: true }],
  };
  const events = [];
  const { store, memory, saved } = memoryOnlyStores();
  const orchestrator = new Orchestrator({
    store, registry, memory, config: { maxStepsPerTurn: 4, providers: {} },
    panel: { send: (_id, msg) => events.push(msg), requestTool: async () => ({ ok: true, result: {} }) },
  });
  const attached = [];
  const handle = createRequestHandler({ orchestrator, store, registry, memory, onSession: (s) => attached.push(s.id) });
  return { handle, events, saved, attached };
}

test('shared request handler: open, chat, history, memory, unknown requests', async () => {
  const { handle, events, saved, attached } = setup([[{ type: 'text_delta', text: 'Hello!' }]]);
  const opened = await handle({ type: 'session.open', url: 'https://shop.com/p/1', title: 'Shop' });
  assert.equal(opened.type, 'session.state');
  const id = opened.session.id;
  assert.deepEqual(attached, [id], 'onSession lets the server route events to this panel');

  assert.equal(await handle({ type: 'chat.send', conversationId: id, text: 'hi', context: { page: { url: 'https://shop.com/p/1' } } }), null);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(events.some((e) => e.type === 'turn.done'));

  const history = await handle({ type: 'sessions.list', url: 'https://shop.com/p/2' });
  assert.equal(history.site, 'shop.com');
  assert.equal(history.items.length, 1);
  assert.equal(history.items[0].sameGroup, true);

  const mem = await handle({ type: 'memory.edit', url: 'https://shop.com/p/1', op: 'addNote', text: 'Cart: #cart', scope: 'site' });
  assert.equal(mem.memory.notes[0].text, 'Cart: #cart');
  assert.equal(saved.get('shop.com').notes.length, 1, 'written through the backend');

  await assert.rejects(handle({ type: 'chat.send', conversationId: id, text: '   ' }), /Empty message/);
  await assert.rejects(handle({ type: 'session.config', conversationId: 'nope' }), /not found/);
  assert.equal(await handle({ type: 'source.propose' }), undefined, 'server-only requests are left to the caller');
});

test('fingerprint: stable for equal data, different for changes', () => {
  assert.equal(fingerprint({ a: [1, 2] }), fingerprint({ a: [1, 2] }));
  assert.notEqual(fingerprint({ a: [1, 2] }), fingerprint({ a: [1, 3] }));
  assert.match(fingerprint('x'), /^[0-9a-f]{16}$/);
});

test('Anthropic errors become messages a user can act on', () => {
  // Stand-ins for the SDK's error classes.
  class APIError extends Error {}
  class AuthenticationError extends APIError {}
  class RateLimitError extends APIError {}
  class BadRequestError extends APIError {}
  const sdk = { APIError, AuthenticationError, RateLimitError, BadRequestError, PermissionDeniedError: class extends APIError {}, NotFoundError: class extends APIError {}, APIConnectionError: class extends APIError {}, InternalServerError: class extends APIError {} };
  const direct = new AnthropicProvider({ providers: { anthropic: { apiKey: 'k' } } }, { browser: true });
  direct.sdk = sdk;
  assert.match(direct.friendlyError(new AuthenticationError('401 {...}')).message, /key was not accepted.*in Options/);
  assert.match(direct.friendlyError(new RateLimitError('429')).message, /rate limit/);
  assert.match(direct.friendlyError(new BadRequestError('Your credit balance is too low')).message, /credit balance/);
  const other = new Error('boom');
  assert.equal(direct.friendlyError(other), other, 'non-API errors pass through unchanged');
  const server = new AnthropicProvider({ providers: { anthropic: { apiKey: 'k' } } });
  server.sdk = sdk;
  assert.match(server.friendlyError(new AuthenticationError('x')).message, /config\.json/);
});

test('direct registry: only the Anthropic API, available once a key is set', async () => {
  const settings = (key) => ({ anthropicApiKey: key, directModel: 'claude-sonnet-5-5' });
  const without = new DirectRegistry(directConfig(/** @type {any} */ (settings(''))));
  assert.deepEqual(await without.isAvailable('anthropic'), { available: false, reason: 'Add your Anthropic API key in Options.' });
  const withKey = new DirectRegistry(directConfig(/** @type {any} */ (settings('sk-ant-x'))));
  const [info] = await withKey.list();
  assert.equal(info.available, true);
  assert.equal(info.defaultModel, 'claude-sonnet-5-5');
  assert.equal(await withKey.pickDefault(), 'anthropic');
  assert.throws(() => withKey.create('claude-cli'), /local agent server/);
  assert.equal(withKey.create('anthropic').browser, true);
});
