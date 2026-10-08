import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexCliProvider, buildCodexArgs, parseCodexOutput, parseEnvelope, resolveCommand, CodexProgress } from '../src/providers/codex-cli.js';
import { PROVIDERS } from '../src/providers/registry.js';
import { testConfig, collect } from './helpers.js';

const pageTools = { url: 'http://127.0.0.1:7823/mcp', token: 'secret-grant' };

test('codex args: read-only, no shell, nothing asks, your own settings left out; page tools by URL, token not on the command line', () => {
  const args = buildCodexArgs({ resume: null, model: 'default', schemaFile: 'S.json', pageTools });
  const joined = args.join(' ');
  assert.equal(args[0], 'exec');
  assert.ok(args.includes('--json'));
  assert.deepEqual(args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 2), ['--sandbox', 'read-only']);
  assert.ok(joined.includes('features.shell_tool=false'), 'its shell tool is off');
  assert.ok(joined.includes('approval_policy="never"'));
  assert.ok(args.includes('--ignore-user-config') && args.includes('--ignore-rules'));
  assert.ok(joined.includes('mcp_servers.page.url="http://127.0.0.1:7823/mcp"'));
  assert.ok(joined.includes('mcp_servers.page.bearer_token_env_var="INTEGRATEDAI_PAGE_TOKEN"'));
  assert.ok(!joined.includes('secret-grant'), 'the token goes in an environment variable');
  assert.deepEqual(args.slice(-1), ['-'], 'the prompt from stdin');
  assert.ok(!args.includes('--model'), 'default: Codex picks');
  const resumed = buildCodexArgs({ resume: 'thr-1', model: 'gpt-x', schemaFile: null });
  assert.deepEqual(resumed.slice(-3), ['resume', 'thr-1', '-']);
  assert.ok(resumed.includes('--model') && !resumed.includes('--output-schema'));
});

test('codex output: thread id, the last agent message, usage, errors', () => {
  const out = parseCodexOutput([
    '{"type":"thread.started","thread_id":"thr-9"}',
    '{"type":"turn.started"}',
    '{"type":"item.started","item":{"id":"1","type":"mcp_tool_call","tool":"page_outline","status":"in_progress"}}',
    '{"type":"item.completed","item":{"id":"2","type":"agent_message","text":"{\\"reply\\":\\"Done\\",\\"actions\\":[]}"}}',
    '{"type":"turn.completed","usage":{"input_tokens":120,"output_tokens":30}}',
    'not json',
  ].join('\n'));
  assert.deepEqual(out, { threadId: 'thr-9', message: '{"reply":"Done","actions":[]}', inputTokens: 120, outputTokens: 30, error: '' });
  assert.equal(parseCodexOutput('{"type":"error","message":"usage limit reached"}').error, 'usage limit reached');
  assert.equal(parseCodexOutput('{"type":"turn.failed","error":{"message":"bad schema"}}').error, 'bad schema');
});

test('codex answer: JSON envelope, inside a code block, or plain text', () => {
  assert.deepEqual(parseEnvelope('{"reply":"Hi","actions":[{"type":"inject_css","input":{"css":"a{}"}}]}'), { reply: 'Hi', actions: [{ type: 'inject_css', input: { css: 'a{}' } }] });
  assert.deepEqual(parseEnvelope('Here:\n```json\n{"reply":"Hi","actions":[]}\n```'), { reply: 'Hi', actions: [] });
  assert.deepEqual(parseEnvelope('Just text {not json}'), { reply: 'Just text {not json}', actions: [] });
});

test('codex progress: page tool calls become preview lines; page steps do not', () => {
  const p = new CodexProgress();
  assert.match(p.feed('{"type":"item.started","item":{"type":"mcp_tool_call","tool":"page_outline"}}'), /Look at the page/);
  assert.equal(p.feed('{"type":"item.started","item":{"type":"mcp_tool_call","tool":"interact"}}'), '');
});

test('codex on Windows: an npm codex.cmd is run as node + its script', () => {
  const cmd = 'C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd';
  const r = resolveCommand('codex', {
    platform: 'win32',
    where: () => ['C:\\Users\\me\\AppData\\Roaming\\npm\\codex', cmd],
    read: () => '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n',
  });
  assert.equal(r.command, process.execPath);
  assert.match(r.prefix[0], /npm[\\/]node_modules[\\/]@openai[\\/]codex[\\/]bin[\\/]codex\.js$/);
  assert.deepEqual(resolveCommand('codex', { platform: 'win32', where: () => ['C:\\bin\\codex.exe'] }), { command: 'C:\\bin\\codex.exe', prefix: [] });
  assert.deepEqual(resolveCommand('codex', { platform: 'linux' }), { command: 'codex', prefix: [] });
});

test('codex provider: a thread per conversation, the token in the environment, actions and usage back', async () => {
  const calls = [];
  const run = async (command, args, opts) => {
    calls.push({ args, opts });
    const resumed = args.includes('resume');
    return {
      code: 0, stderr: '',
      stdout: [
        resumed ? '' : '{"type":"thread.started","thread_id":"thr-1"}',
        `{"type":"item.completed","item":{"type":"agent_message","text":${JSON.stringify(JSON.stringify({ reply: resumed ? 'Second' : 'First', actions: resumed ? [] : [{ type: 'find_elements', input: { text: 'Go' } }] }))}}}`,
        '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}',
      ].join('\n'),
    };
  };
  const config = testConfig({ providers: { ...testConfig().providers, 'codex-cli': { command: 'C:/x/codex.exe', model: 'default', timeoutMs: 1000 } } });
  const provider = new CodexCliProvider(config, { run });
  const state = {};
  const messages = [{ role: 'user', ts: 0, content: [{ type: 'text', text: 'hello' }] }];
  const req = { messages, system: 'SYSTEM', actionNames: ['find_elements'], model: 'default', state, signal: new AbortController().signal, pageTools };
  const first = await collect(provider.turn(req));
  assert.ok(first.some((e) => e.type === 'text_delta' && e.text === 'First'));
  assert.ok(first.some((e) => e.type === 'tool_call' && e.name === 'find_elements'));
  assert.equal(calls[0].opts.env.INTEGRATEDAI_PAGE_TOKEN, 'secret-grant');
  assert.match(calls[0].opts.input, /<instructions>\nSYSTEM/);
  assert.equal(state.threadId, 'thr-1');
  messages.push({ role: 'assistant', ts: 0, content: [{ type: 'text', text: 'First' }] }, { role: 'user', ts: 0, content: [{ type: 'text', text: 'again' }] });
  const second = await collect(provider.turn(req));
  assert.ok(second.some((e) => e.type === 'text_delta' && e.text === 'Second'));
  assert.ok(calls[1].args.includes('thr-1'), 'resumed');
  assert.doesNotMatch(calls[1].opts.input, /<instructions>/, 'same instructions: not sent again');
  assert.match(calls[1].opts.input, /again/);
  assert.doesNotMatch(calls[1].opts.input, /hello/, 'only what it has not seen');
});

test('codex provider: no answer schema is sent (OpenAI refuses ours); a refusal would still fall back', async () => {
  const calls = [];
  const run = async (command, args) => {
    calls.push(args);
    if (args.includes('--output-schema')) return { code: 1, stderr: '', stdout: '{"type":"error","message":"Invalid schema for response_format"}' };
    return { code: 0, stderr: '', stdout: '{"type":"thread.started","thread_id":"t"}\n{"type":"item.completed","item":{"type":"agent_message","text":"plain answer"}}' };
  };
  const config = testConfig({ providers: { ...testConfig().providers, 'codex-cli': { command: 'C:/x/codex.exe', model: 'default', timeoutMs: 1000 } } });
  const provider = new CodexCliProvider(config, { run });
  const state = {};
  const events = await collect(provider.turn({ messages: [{ role: 'user', ts: 0, content: [{ type: 'text', text: 'hi' }] }], system: 'S', actionNames: [], model: 'default', state, signal: new AbortController().signal }));
  assert.ok(events.some((e) => e.type === 'text_delta' && e.text === 'plain answer'));
  assert.equal(calls.length, 1, 'one call');
  assert.ok(!calls[0].includes('--output-schema'));
});

test('codex availability: not installed, not signed in, ready; and it is in the server\'s list', async () => {
  const config = testConfig({ providers: { ...testConfig().providers, 'codex-cli': { command: 'C:/x/codex.exe', model: 'default', timeoutMs: 1000 } } });
  const missing = await CodexCliProvider.checkAvailability(config, async () => ({ code: null, stdout: '', stderr: '', spawnError: 'ENOENT' }));
  assert.match(missing.reason, /npm install -g @openai\/codex/);
  const out = await CodexCliProvider.checkAvailability(config, async () => ({ code: 1, stdout: '', stderr: '' }));
  assert.match(out.reason, /codex login/);
  assert.deepEqual(await CodexCliProvider.checkAvailability(config, async () => ({ code: 0, stdout: '', stderr: '' })), { available: true });
  assert.ok(PROVIDERS.includes(CodexCliProvider));
});

test('codex: its page tools run without a prompt (checked against Codex 0.161: it blocks MCP tools otherwise)', async () => {
  const args = buildCodexArgs({ resume: null, model: 'default', schemaFile: null, pageTools }).join(' ');
  assert.ok(args.includes('mcp_servers.page.default_tools_approval_mode="auto"'));
  const { PageTools } = await import('../src/agent/page-tools.js');
  const tools = new PageTools({ requestTool: async () => ({ ok: true, result: {} }) });
  const listed = tools.list(tools.lookup(tools.grant('c', ['page_outline', 'interact'], new AbortController().signal, ['interact']).token));
  assert.equal(listed.find((t) => t.name === 'page_outline').annotations.readOnlyHint, true, 'inspections say they only read');
  assert.equal(listed.find((t) => t.name === 'interact').annotations.readOnlyHint, false);
});
