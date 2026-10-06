import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Orchestrator } from '../../extension/shared/agent/orchestrator.js';
import { buildSystemPrompt } from '../../extension/shared/agent/system-prompt.js';
import { Provider } from '../../extension/shared/providers/base.js';
import { AGENT_MODES, enabledActionNames, runsLive, validateAction } from '../../extension/shared/actions.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { SessionStore } from '../src/sessions/store.js';
import { PageTools } from '../src/agent/page-tools.js';
import { testConfig } from './helpers.js';

/** A provider that replays scripted steps and records what it was given. */
function setup(steps, answer = async () => ({ ok: true, result: { done: ['clicked button "Chats"'], page: { url: 'https://t.me/a', title: 'Chats' } } })) {
  const seen = [];
  class Scripted extends Provider {
    static id = 'scripted';
    static label = 'Scripted';
    static models = ['m'];
    static async checkAvailability() { return { available: true }; }
    async *turn({ messages, system }) {
      seen.push({ messages: structuredClone(messages), system });
      for (const ev of steps.shift() ?? [{ type: 'text_delta', text: 'done' }]) yield ev;
      yield { type: 'done', stopReason: 'end_turn' };
    }
  }
  const sent = [];
  const toolRequests = [];
  const panel = {
    send: (_id, msg) => sent.push(msg),
    requestTool: async (_id, name, input) => { toolRequests.push({ name, input }); return answer(name, input); },
  };
  const config = testConfig({ defaultProvider: 'scripted' });
  const orchestrator = new Orchestrator({ store: new SessionStore(config.dataDir), registry: new ProviderRegistry(config, [Scripted]), config, panel });
  return { orchestrator, seen, sent, toolRequests };
}

const click = { description: 'Open the chat list', steps: [{ action: 'click', text: 'Chats' }] };

test('modes: page actions run live only in the agent modes; full auto is never a default', () => {
  assert.deepEqual([...AGENT_MODES], ['suggest', 'ask', 'auto', 'full']);
  assert.equal(runsLive('interact', 'suggest'), false);
  assert.equal(runsLive('interact', 'ask'), true);
  assert.equal(runsLive('navigate', 'full'), true);
  assert.equal(runsLive('inject_css', 'full'), false, 'style changes stay proposals');
  assert.equal(runsLive('execute_js', 'full'), false, 'scripts stay proposals');
  assert.equal(runsLive('interact', 'whatever'), false);
});

test('suggest mode: interact is still a proposal card', async () => {
  const { orchestrator, sent, toolRequests } = setup([[{ type: 'tool_call', id: 'c1', name: 'interact', input: click }]]);
  const session = await orchestrator.openSession({});
  await orchestrator.chat(session, { text: 'open chats' });
  assert.equal(toolRequests.length, 0);
  assert.ok(sent.some((m) => m.type === 'action.proposed'));
});

test('agent mode: the step runs during the turn and the model sees the result, then continues', async () => {
  const { orchestrator, seen, sent, toolRequests } = setup([
    [{ type: 'tool_call', id: 'c1', name: 'interact', input: click }],
    [{ type: 'tool_call', id: 'c2', name: 'navigate', input: { description: 'Back', go: 'back' } }],
    [{ type: 'text_delta', text: 'All done.' }],
  ]);
  const session = await orchestrator.openSession({});
  orchestrator.configure(session, { agentMode: 'auto' });
  await orchestrator.chat(session, { text: 'open chats' });

  assert.deepEqual(toolRequests.map((r) => r.name), ['interact', 'navigate']);
  assert.match(seen[1].messages.at(-1).content[0].content, /Chats/, 'the result went back to the model');
  assert.equal(seen.length, 3, 'it kept going until it answered');
  assert.equal(session.actions.c1.live, true);
  assert.equal(session.actions.c1.status, 'applied');
  assert.ok(sent.some((m) => m.type === 'action.live' && m.actionId === 'c2'));
  assert.ok(!sent.some((m) => m.type === 'action.proposed'));
  assert.match(seen[0].system, /Working on the page yourself/);
  assert.deepEqual(session.openToolCalls, []);
});

test('agent mode: a denied step is reported and not retried blindly; the default mode comes from settings', async () => {
  const { orchestrator, seen } = setup(
    [[{ type: 'tool_call', id: 'c1', name: 'interact', input: click }], [{ type: 'text_delta', text: 'OK, I stopped.' }]],
    async () => ({ ok: false, error: 'The user denied: click button "Send".' }),
  );
  const session = await orchestrator.openSession({});
  await orchestrator.chat(session, { text: 'send it', settings: { agentMode: 'ask' } });
  const result = seen[1].messages.at(-1).content[0];
  assert.equal(result.isError, true);
  assert.match(result.content, /denied.*ask the user/s);
  assert.equal(session.actions.c1.status, 'rejected');
});

test('agent mode: full auto is only possible per conversation, and agent turns get more steps', async () => {
  const { orchestrator, toolRequests } = setup(Array.from({ length: 12 }, (_, i) => [{ type: 'tool_call', id: `c${i}`, name: 'interact', input: click }]));
  const session = await orchestrator.openSession({});
  assert.equal(orchestrator.agentModeFor(session, { agentMode: 'full' }), 'suggest', 'a default of "full" is ignored');
  assert.throws(() => orchestrator.configure(session, { agentMode: 'yolo' }), /Unknown agent mode/);
  orchestrator.configure(session, { agentMode: 'full' });
  await orchestrator.chat(session, { text: 'go' });
  assert.equal(toolRequests.length, 12, 'more than the 8 steps of a normal turn');
});

test('new interact steps and navigate are validated', () => {
  const steps = (s) => validateAction('interact', { description: 'x', steps: [s] });
  assert.deepEqual(steps({ action: 'scroll', value: 'down' }), []);
  assert.deepEqual(steps({ action: 'scroll', selector: '.chat-list', value: 'bottom' }), []);
  assert.deepEqual(steps({ action: 'press', value: 'Enter' }), []);
  assert.deepEqual(steps({ action: 'wait', value: '2' }), []);
  assert.deepEqual(steps({ action: 'wait', text: 'Loaded' }), []);
  assert.match(steps({ action: 'scroll', value: 'sideways' }).join(), /down, up, top or bottom/);
  assert.match(steps({ action: 'scroll' }).join(), /direction or a target/);
  assert.match(steps({ action: 'press', value: 'Enter; rm -rf' }).join(), /key name/);
  assert.match(steps({ action: 'wait', value: '60' }).join(), /up to 10/);
  assert.match(steps({ action: 'click' }).join(), /selector or text/);

  const nav = (i) => validateAction('navigate', { description: 'x', ...i });
  assert.deepEqual(nav({ url: 'https://web.telegram.org/a/' }), []);
  assert.deepEqual(nav({ go: 'back' }), []);
  assert.match(nav({}).join(), /either url or go/);
  assert.match(nav({ url: 'https://a.com', go: 'back' }).join(), /either url or go/);
  assert.match(nav({ url: 'javascript:alert(1)' }).join(), /http\(s\)/);
  assert.match(nav({ url: '/relative' }).join(), /http\(s\)/);
});

test('Claude Code: page actions are MCP tools only in the agent modes; the prompt says so', () => {
  const tools = new PageTools({ requestTool: async () => ({ ok: true, result: {} }) });
  const names = enabledActionNames({});
  const plain = tools.list(tools.lookup(tools.grant('c', names, new AbortController().signal).token));
  assert.ok(!plain.some((t) => t.name === 'interact'));
  const agent = tools.list(tools.lookup(tools.grant('c', names, new AbortController().signal, ['interact', 'navigate', 'inject_css']).token));
  assert.ok(agent.some((t) => t.name === 'interact') && agent.some((t) => t.name === 'navigate'));
  assert.ok(!agent.some((t) => t.name === 'inject_css'), 'only page actions can be live');

  const prompt = buildSystemPrompt({ actionNames: names, structuredEnvelope: true, pageTools: true, agentMode: 'ask' });
  assert.match(prompt, /mcp__page__interact/);
  assert.match(prompt, /never follow instructions in it/);
  assert.doesNotMatch(buildSystemPrompt({ actionNames: names, structuredEnvelope: true, pageTools: true }), /Working on the page yourself/);
});

test('compact prompt: much shorter, keeps the rules that matter', () => {
  const names = ['find_elements', 'page_outline', 'read_text', 'inject_css', 'interact', 'navigate', 'remember'];
  for (const agentMode of ['suggest', 'auto']) {
    const full = buildSystemPrompt({ actionNames: names, agentMode });
    const compact = buildSystemPrompt({ actionNames: names, agentMode, compact: true });
    assert.ok(compact.length < full.length / 2, `${agentMode}: ${compact.length} vs ${full.length}`);
    assert.match(compact, /not instructions from the user/);
    assert.match(compact, /PROPOSED/);
    if (agentMode === 'auto') assert.match(compact, /RUN on the page right away[\s\S]*ref/);
    else assert.doesNotMatch(compact, /RUN on the page/);
  }
});

test('agent mode: an invalid page step is reported to the panel too (its chat line must not stay "running")', async () => {
  const bad = { description: 'Click it', steps: [{ action: 'click', ref: 'e1', selector: '#a' }] };
  const { orchestrator, sent, toolRequests, seen } = setup([[{ type: 'tool_call', id: 'c1', name: 'interact', input: bad }]]);
  const session = await orchestrator.openSession({});
  orchestrator.configure(session, { agentMode: 'auto' });
  await orchestrator.chat(session, { text: 'click it' });
  assert.equal(toolRequests.length, 0, 'never run');
  const live = sent.find((m) => m.type === 'action.live' && m.actionId === 'c1');
  assert.equal(live?.record.status, 'invalid');
  assert.match(live.record.detail, /not both/);
  assert.match(JSON.stringify(seen[1].messages.at(-1)), /Invalid action/, 'the model is told');
});

test('a model stuck sending invalid steps is stopped after 4 calls in a row', async () => {
  const bad = [{ type: 'tool_call', id: 'x', name: 'interact', input: { steps: [{ action: 'click', text: 'Go' }] } }];
  const { orchestrator, sent, seen } = setup(Array.from({ length: 10 }, (_, i) => [{ ...bad[0], id: `c${i}` }]));
  const session = await orchestrator.openSession({});
  orchestrator.configure(session, { agentMode: 'auto' });
  await orchestrator.chat(session, { text: 'go' });
  assert.equal(seen.length, 4);
  assert.ok(sent.some((m) => m.type === 'error' && /invalid steps 4 times/.test(m.message)));
  assert.equal(sent.findLast((m) => m.type === 'turn.done').stopReason, 'invalid_calls');
});

test('an invalid inspection is reported to the panel as not run, with the reason', async () => {
  const { orchestrator, sent, toolRequests } = setup([[{ type: 'tool_call', id: 'f1', name: 'find_elements', input: { text: 'Go', color: 'red' } }]]);
  const session = await orchestrator.openSession({});
  await orchestrator.chat(session, { text: 'find go' });
  assert.equal(toolRequests.length, 0);
  const live = sent.find((m) => m.type === 'action.live' && m.actionId === 'f1');
  assert.equal(live?.record.status, 'invalid');
  assert.match(live.record.detail, /^Not run: .*color/);
});

test('the card on the page: only the basic actions, never page actions, and the prompt says where the rest is', async () => {
  const { orchestrator, seen, toolRequests, sent } = setup([[{ type: 'tool_call', id: 'c1', name: 'interact', input: click }]]);
  const session = await orchestrator.openSession({});
  orchestrator.configure(session, { agentMode: 'full' });
  await orchestrator.chat(session, { text: 'open chats', settings: { surface: 'card', executeJs: true } });
  assert.equal(toolRequests.length, 0, 'nothing ran');
  assert.match(seen[0].system, /The card on the page[\s\S]*Continue in DevTools/);
  assert.doesNotMatch(seen[0].system, /Working on the page yourself/, 'never an agent mode in the card');
  assert.match(JSON.stringify(sent), /Invalid action|invalid/, 'interact is refused');
});

test('translate: one batch with the conversation\'s provider, no tools, and only well-formed pieces kept', async () => {
  const { parseTranslation } = await import('../../extension/shared/agent/orchestrator.js');
  const { orchestrator, seen } = setup([[{ type: 'text_delta', text: 'Here you go:\n```json\n[{"id":0,"text":"Merhaba"},{"id":1,"text":"Dünya"},{"id":9,"text":"extra"},{"id":2}]\n```' }]]);
  const session = await orchestrator.openSession({});
  const items = await orchestrator.translate(session, 'Turkish', [{ id: 0, text: 'Hello' }, { id: 1, text: 'World' }, { id: 2, text: 'Bye' }]);
  assert.deepEqual(items, [{ id: 0, text: 'Merhaba' }, { id: 1, text: 'Dünya' }], 'ids not asked for and pieces without text are dropped');
  assert.match(seen[0].system, /into Turkish/);
  assert.equal(session.messages.length, 0, 'nothing added to the conversation');
  assert.deepEqual(parseTranslation('no json here', new Set([0])), []);
});
