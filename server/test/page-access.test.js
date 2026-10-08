import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Orchestrator } from '../../extension/shared/agent/orchestrator.js';
import { Provider } from '../../extension/shared/providers/base.js';
import { AREA_ACTIONS, actionsForAccess, enabledActionNames } from '../../extension/shared/actions.js';
import { providerForKey } from '../../extension/shared/key-detect.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { SessionStore } from '../src/sessions/store.js';
import { testConfig } from './helpers.js';

/** A provider that replays scripted steps and records what it was offered. */
function setup(steps = []) {
  const seen = [];
  class Scripted extends Provider {
    static id = 'scripted';
    static label = 'Scripted';
    static models = ['m'];
    static async checkAvailability() { return { available: true }; }
    async *turn({ messages, system, actionNames }) {
      seen.push({ messages: structuredClone(messages), system, actionNames: [...actionNames] });
      for (const ev of steps.shift() ?? [{ type: 'text_delta', text: 'done' }]) yield ev;
      yield { type: 'done', stopReason: 'end_turn' };
    }
  }
  const toolRequests = [];
  const panel = {
    send: () => {},
    requestTool: async (_id, name, input) => { toolRequests.push({ name, input }); return { ok: true, result: {} }; },
  };
  const config = testConfig({ defaultProvider: 'scripted' });
  const orchestrator = new Orchestrator({ store: new SessionStore(config.dataDir), registry: new ProviderRegistry(config, [Scripted]), config, panel });
  return { orchestrator, seen, toolRequests };
}

test('page access: the actions offered for each level', () => {
  const all = enabledActionNames({ executeJs: true });
  assert.deepEqual(actionsForAccess(all, 'full'), all);
  assert.deepEqual(actionsForAccess(all, 'none'), []);
  const area = actionsForAccess(all, 'area');
  assert.ok(area.every((name) => AREA_ACTIONS.includes(name)));
  for (const name of ['interact', 'navigate', 'execute_js', 'inject_css', 'read_text', 'screenshot']) assert.ok(area.includes(name), name);
  for (const name of ['inspect_console', 'inspect_network', 'inspect_resources', 'remember', 'forget']) assert.ok(!area.includes(name), name);
});

test('page access: "Just answer" offers no tools and says so', async () => {
  const { orchestrator, seen } = setup();
  const session = await orchestrator.openSession({});
  await orchestrator.chat(session, { text: 'how do I center a div?', context: {}, settings: { pageAccess: 'none' }, pageUrl: 'https://example.com/a' });
  assert.deepEqual(seen[0].actionNames, []);
  assert.match(seen[0].system, /## Just answer/);
  assert.equal(session.lastUrl, 'https://example.com/a', 'the address still goes to History (not to the AI)');
});

test('page access: with a marked area, only the area tools; a call to another one is refused', async () => {
  const { orchestrator, seen, toolRequests } = setup([
    [{ type: 'tool_call', id: 'c1', name: 'inspect_console', input: {} }],
  ]);
  const session = await orchestrator.openSession({});
  await orchestrator.chat(session, { text: 'what is this?', context: { page: { site: 'https://example.com' } }, settings: { pageAccess: 'area' } });
  assert.ok(seen[0].actionNames.every((name) => AREA_ACTIONS.includes(name)));
  assert.match(seen[0].system, /## Only a marked area/);
  assert.equal(toolRequests.length, 0, 'the console was not read');
  const result = JSON.stringify(seen[1].messages.at(-1));
  assert.match(result, /not available/);
});

test('page access: whole page is the default (no access setting)', async () => {
  const { orchestrator, seen } = setup();
  const session = await orchestrator.openSession({});
  await orchestrator.chat(session, { text: 'hi', context: {} });
  assert.ok(seen[0].actionNames.includes('inspect_console'));
  assert.doesNotMatch(seen[0].system, /## Only a marked area|## Just answer/);
});

test('pasted keys: the provider from the prefix, only when it is certain', () => {
  assert.equal(providerForKey('sk-ant-api03-abcdefghijklmnopqrstuvwxyz'), 'anthropic');
  assert.equal(providerForKey('sk-or-v1-abcdefghijklmnopqrstuvwxyz0123'), 'openrouter');
  assert.equal(providerForKey('sk-proj-abcdefghijklmnopqrstuvwxyz0123'), 'openai');
  assert.equal(providerForKey('AIzaSyA1234567890abcdefghijklmnopqrstu'), 'gemini');
  assert.equal(providerForKey('sk-abcdefghijklmnopqrstuvwxyz012345'), null, 'plain sk- keys: OpenAI, DeepSeek, Kimi, Qwen … can not tell');
  assert.equal(providerForKey('sk-ant-'), null, 'too short: still typing');
  assert.equal(providerForKey('  sk-ant-api03-abcdefghijklmnopqrstuvwxyz  '), 'anthropic', 'spaces around a paste');
});

test('frames: the address DevTools knows a frame by, from Chrome\'s list', async () => {
  globalThis.chrome ??= /** @type {any} */ ({});
  const { pickFrameUrl } = await import('../../extension/panel/lib/inspected.js');
  const urls = ['https://www.netacad.com/content/i2cs/1.0/courses/content/m1/en-US/assets/quiz.html?id=7&s=abc', 'https://ads.example/x'];
  assert.equal(pickFrameUrl(urls, urls[0]), urls[0], 'exact');
  assert.equal(pickFrameUrl(urls, 'https://www.netacad.com/content/i2cs/1.0/courses/content/m1/en-US/assets/quiz.html'), urls[0], 'same site and path, other query');
  assert.equal(pickFrameUrl(urls, 'https://www.netacad.com/launch?course=1'), urls[0], 'its src redirected: the only frame from that site');
  assert.equal(pickFrameUrl([...urls, 'https://www.netacad.com/other'], 'https://www.netacad.com/launch'), 'https://www.netacad.com/launch', 'two frames from the site: no guessing');
});
