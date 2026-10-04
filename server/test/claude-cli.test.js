import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCliArgs, parseCliOutput, ClaudeCliProvider } from '../src/providers/claude-cli.js';
import { testConfig, collect } from './helpers.js';

// Trimmed copy of real `claude -p --output-format json --json-schema …` output.
const REAL_OUTPUT = JSON.stringify({
  type: 'result', subtype: 'success', is_error: false,
  result: '{"reply":"hello","actions":[]}',
  structured_output: { reply: 'hello', actions: [] },
  session_id: '0c77b46f-bb8d-48db-9f95-1d53225b1b2e',
  total_cost_usd: 0.003207,
  usage: { input_tokens: 1468, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 154 },
});

test('buildCliArgs: first call vs resume', () => {
  const base = { sessionId: 'S', model: 'default', schema: { type: 'object' }, systemPromptFile: 'sp.md' };
  const first = buildCliArgs({ ...base, resume: false });
  assert.deepEqual(first.slice(0, 3), ['-p', '--output-format', 'json']);
  assert.ok(first.includes('--session-id') && !first.includes('--resume'));
  assert.ok(!first.includes('--bare'), 'must not use --bare (subscription login)');
  assert.ok(!first.includes('--model'), '"default" model passes no --model');
  assert.equal(first[first.indexOf('--tools') + 1], '', 'all built-in tools disabled');

  const again = buildCliArgs({ ...base, resume: true, model: 'sonnet', effort: 'low' });
  assert.ok(again.includes('--resume') && !again.includes('--session-id'));
  assert.equal(again[again.indexOf('--model') + 1], 'sonnet');
  assert.equal(again[again.indexOf('--effort') + 1], 'low');
});

test('parseCliOutput: real output', () => {
  const out = parseCliOutput(REAL_OUTPUT);
  assert.equal(out.isError, false);
  assert.equal(out.reply, 'hello');
  assert.deepEqual(out.actions, []);
  assert.equal(out.totalCostUsd, 0.003207);
  assert.equal(out.inputTokens, 1468);
});

test('parseCliOutput: errors and fallbacks', () => {
  assert.equal(parseCliOutput('').isError, true);
  const err = parseCliOutput(JSON.stringify({ is_error: true, subtype: 'error_during_execution', result: 'boom' }));
  assert.equal(err.isError, true);
  assert.equal(err.errorText, 'boom');
  const plain = parseCliOutput(JSON.stringify({ subtype: 'success', result: 'just text' }));
  assert.equal(plain.reply, 'just text');
});

/** Fake `run` that records calls and returns scripted outputs. */
function fakeRun(outputs) {
  const calls = [];
  const run = async (command, args, opts) => {
    calls.push({ command, args, input: opts.input });
    return { code: 0, stdout: outputs.shift(), stderr: '' };
  };
  return { run, calls };
}

const user = (text) => ({ role: 'user', content: [{ type: 'text', text }], ts: 0 });
const assistant = (text) => ({ role: 'assistant', content: [{ type: 'text', text }], ts: 0 });

test('provider: resumes the same session and sends only new messages; cost is per call', async () => {
  const out1 = JSON.stringify({
    subtype: 'success', total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5 },
    structured_output: { reply: 'Looking…', actions: [{ type: 'inspect_element', input: { include: ['rules'] } }] },
  });
  const out2 = JSON.stringify({
    subtype: 'success', total_cost_usd: 0.025, usage: { input_tokens: 10, output_tokens: 5 },
    structured_output: { reply: 'Done', actions: [] },
  });
  const { run, calls } = fakeRun([out1, out2]);
  const provider = new ClaudeCliProvider(testConfig(), { run });
  const state = {};
  const req = { system: 'sys', actionNames: ['inspect_element'], model: 'default', state, signal: new AbortController().signal };

  const messages = [user('why overflow?')];
  const ev1 = await collect(provider.turn({ ...req, messages }));
  assert.deepEqual(ev1.map((e) => e.type), ['text_delta', 'tool_call', 'usage', 'done']);
  assert.equal(ev1[1].name, 'inspect_element');
  assert.equal(ev1[2].costUsd, 0.01);
  assert.ok(calls[0].args.includes('--session-id'));
  assert.equal(calls[0].input, 'why overflow?');

  // The orchestrator appends the assistant message and a user message with results.
  messages.push(assistant('Looking…'), {
    role: 'user', ts: 0, content: [{ type: 'tool_result', toolCallId: ev1[1].id, content: '{"rules":[]}' }],
  });
  const ev2 = await collect(provider.turn({ ...req, messages }));
  assert.ok(calls[1].args.includes('--resume'));
  assert.equal(calls[1].args[calls[1].args.indexOf('--resume') + 1], state.sessionId);
  assert.match(calls[1].input, /action_result/);
  assert.doesNotMatch(calls[1].input, /why overflow/, 'already-sent messages are not repeated');
  assert.ok(Math.abs(ev2.find((e) => e.type === 'usage').costUsd - 0.015) < 1e-9);
});

test('provider: starts a fresh session when the old one is gone', async () => {
  const gone = JSON.stringify({ is_error: true, subtype: 'error', result: 'No conversation found with session ID: x' });
  const ok = JSON.stringify({ subtype: 'success', structured_output: { reply: 'hi', actions: [] } });
  const { run, calls } = fakeRun([gone, ok]);
  const provider = new ClaudeCliProvider(testConfig(), { run });
  const state = { sessionId: '11111111-1111-1111-1111-111111111111', synced: 2 };
  const messages = [user('a'), assistant('b'), user('c')];
  const events = await collect(provider.turn({
    messages, system: 's', actionNames: [], model: 'default', state, signal: new AbortController().signal,
  }));
  assert.equal(events[0].text, 'hi');
  assert.ok(calls[1].args.includes('--session-id'));
  assert.match(calls[1].input, /earlier_assistant_reply/, 'full history replayed');
});

test('availability: not installed / not logged in', async () => {
  const config = testConfig();
  const missing = await ClaudeCliProvider.checkAvailability(config, async () => ({ code: null, stdout: '', stderr: '', spawnError: 'ENOENT' }));
  assert.equal(missing.available, false);
  const loggedOut = await ClaudeCliProvider.checkAvailability(config, async () => ({ code: 1, stdout: '', stderr: '' }));
  assert.match(loggedOut.reason, /not logged in/);
});
