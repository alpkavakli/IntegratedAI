import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Orchestrator } from '../../extension/shared/agent/orchestrator.js';
import { Provider } from '../../extension/shared/providers/base.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { SessionStore } from '../src/sessions/store.js';
import { testConfig } from './helpers.js';

/**
 * A provider that replays scripted steps. Each step is a list of events.
 * It records the messages it was given so tests can inspect them.
 */
function scriptedProvider(steps) {
  const seen = [];
  class Scripted extends Provider {
    static id = 'scripted';
    static label = 'Scripted';
    static models = ['m'];
    static async checkAvailability() { return { available: true }; }
    async *turn({ messages }) {
      seen.push(structuredClone(messages));
      const step = steps.shift() ?? [{ type: 'text_delta', text: '(no more steps)' }];
      for (const ev of step) yield ev;
      if (!step.some((ev) => ev.type === 'done')) yield { type: 'done', stopReason: 'end_turn' };
    }
  }
  return { Scripted, seen };
}

/** Fake panel: records messages, answers inspections with a canned result. */
function fakePanel() {
  const sent = [];
  const toolRequests = [];
  return {
    sent,
    toolRequests,
    send: (_id, msg) => sent.push(msg),
    requestTool: async (_id, name, input) => {
      toolRequests.push({ name, input });
      return { ok: true, result: { inspected: name } };
    },
  };
}

function setup(steps) {
  const config = testConfig({ defaultProvider: 'scripted' });
  const { Scripted, seen } = scriptedProvider(steps);
  const panel = fakePanel();
  const store = new SessionStore(config.dataDir);
  const orchestrator = new Orchestrator({ store, registry: new ProviderRegistry(config, [Scripted]), config, panel });
  return { orchestrator, panel, seen, store };
}

const css = { description: 'Make it red', css: '.x{color:red}' };

test('inspection round-trip, then a proposal that waits for the user', async () => {
  const { orchestrator, panel, seen } = setup([
    [{ type: 'tool_call', id: 'c1', name: 'inspect_element', input: { include: ['rules'] } }],
    [{ type: 'text_delta', text: 'Here is a fix.' }, { type: 'tool_call', id: 'c2', name: 'inject_css', input: css }],
  ]);
  const session = await orchestrator.openSession({ url: 'https://a.com' });
  await orchestrator.chat(session, { text: 'make it red', context: { page: { url: 'https://a.com' } } });

  // Inspection ran in the panel and its result went back to the model.
  assert.equal(panel.toolRequests[0].name, 'inspect_element');
  const secondCall = seen[1];
  const results = secondCall[secondCall.length - 1].content;
  assert.equal(results[0].type, 'tool_result');
  assert.match(results[0].content, /inspected/);

  // The CSS was only proposed, never executed by the server.
  assert.ok(panel.sent.some((m) => m.type === 'action.proposed' && m.actionId === 'c2'));
  assert.equal(panel.toolRequests.length, 1);
  assert.equal(session.actions.c2.status, 'proposed');
  assert.deepEqual(session.openToolCalls, ['c2']);
  assert.equal(panel.sent.at(-1).type, 'turn.done');
});

test('the user decision becomes the tool result of the next message', async () => {
  const { orchestrator, seen } = setup([
    [{ type: 'tool_call', id: 'c1', name: 'inject_css', input: css }],
    [{ type: 'text_delta', text: 'Great.' }],
  ]);
  const session = await orchestrator.openSession({});
  await orchestrator.chat(session, { text: 'red please' });
  orchestrator.setActionStatus(session, 'c1', 'applied');
  await orchestrator.chat(session, { text: 'thanks' });

  const lastUser = seen[1].at(-1);
  assert.equal(lastUser.content[0].type, 'tool_result');
  assert.equal(lastUser.content[0].toolCallId, 'c1');
  assert.match(lastUser.content[0].content, /applied/);
  assert.deepEqual(session.openToolCalls, []);
});

test('later status changes are reported once as a note', async () => {
  const { orchestrator, seen } = setup([
    [{ type: 'tool_call', id: 'c1', name: 'inject_css', input: css }],
    [{ type: 'text_delta', text: 'ok' }],
    [{ type: 'text_delta', text: 'ok' }],
  ]);
  const session = await orchestrator.openSession({});
  await orchestrator.chat(session, { text: '1' });
  orchestrator.setActionStatus(session, 'c1', 'applied');
  await orchestrator.chat(session, { text: '2' });
  orchestrator.setActionStatus(session, 'c1', 'undone');
  await orchestrator.chat(session, { text: '3' });
  const note = seen[2].at(-1).content.find((b) => b.type === 'note');
  assert.match(note.text, /undid/);
});

test('invalid and disabled actions are rejected with an error result', async () => {
  const { orchestrator, panel, seen } = setup([
    [
      { type: 'tool_call', id: 'c1', name: 'execute_js', input: { description: 'd', code: 'alert(1)' } },
      { type: 'tool_call', id: 'c2', name: 'modify_element', input: { description: 'd', setAttributes: [{ name: 'onclick', value: 'x' }] } },
    ],
    [{ type: 'text_delta', text: 'sorry' }],
  ]);
  const session = await orchestrator.openSession({});
  await orchestrator.chat(session, { text: 'go', settings: { executeJs: false } });

  assert.ok(!panel.sent.some((m) => m.type === 'action.proposed'));
  const results = seen[1].at(-1).content;
  assert.ok(results.every((r) => r.type === 'tool_result' && r.isError));
  assert.match(results[0].content, /disabled/);
  assert.equal(session.actions.c2.status, 'invalid');
});

test('usage is accumulated per turn and per session', async () => {
  const { orchestrator, panel } = setup([
    [{ type: 'text_delta', text: 'a' }, { type: 'usage', inputTokens: 10, outputTokens: 2, costUsd: 0.5 }],
    [{ type: 'text_delta', text: 'b' }, { type: 'usage', inputTokens: 5, outputTokens: 1, costUsd: null }],
  ]);
  const session = await orchestrator.openSession({});
  await orchestrator.chat(session, { text: 'x' });
  await orchestrator.chat(session, { text: 'y' });
  assert.deepEqual(session.usage, { inputTokens: 15, outputTokens: 3, costUsd: 0.5 });
  assert.equal(panel.sent.filter((m) => m.type === 'turn.done').length, 2);
});

test('conversations are persisted and reloaded', async () => {
  const { orchestrator, store } = setup([[{ type: 'text_delta', text: 'hi' }]]);
  const session = await orchestrator.openSession({ title: 'T' });
  await orchestrator.chat(session, { text: 'hello' });
  await store.flush();
  store.cache.clear();
  const loaded = await store.get(session.id);
  assert.equal(loaded.messages.length, 2);
  assert.equal(loaded.busy, false);
});

test('pause_turn (long server-side web search) continues automatically', async () => {
  const { orchestrator, seen } = setup([
    [{ type: 'text_delta', text: 'Searching…' }, { type: 'done', stopReason: 'pause_turn' }],
    [{ type: 'text_delta', text: 'Found it.' }],
  ]);
  const session = await orchestrator.openSession({});
  await orchestrator.chat(session, { text: 'look it up', settings: { webTools: true } });
  assert.equal(seen.length, 2, 'provider was called again');
  assert.equal(session.messages.filter((m) => m.role === 'assistant').length, 2);
});
