// @ts-check
/**
 * Provider: ChatGPT through Codex CLI (`codex exec`), using your ChatGPT sign-in (Plus or Pro: usage comes out of
 * your plan's limits, no API key).
 *
 * How one model call works:
 *   codex exec --json …                        non-interactive; progress as JSON lines (thread.started, item.*, turn.*)
 *     --sandbox read-only                       and its shell tool switched off (features.shell_tool=false): page
 *     -c features.shell_tool=false              content can't make it run commands or write files
 *     -c approval_policy="never"                nothing waits for a prompt
 *     --ignore-user-config --ignore-rules       your own Codex settings, MCP servers and rules stay out of it
 *     -c mcp_servers.page.url=…                 the page tools, served by this server's /mcp endpoint (agent/
 *       bearer token in an environment variable page-tools.js), as for Claude Code
 *   The answer is the JSON object { reply, actions[] } our instructions ask for (no --output-schema: OpenAI's models
 *   refuse our schema, which isn't in their strict form, and the instructions alone work).
 *     resume <thread id>                        one Codex thread per conversation
 *   The prompt goes to stdin ("-"): our instructions on a new thread (Codex has no option for a system prompt), then
 *   the messages it hasn't seen.
 * Codex runs in an empty folder (<dataDir>/codex-cli-workspace).
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ACTIONS, isPageAction } from '../../../extension/shared/actions.js';
import { Provider } from '../../../extension/shared/providers/base.js';
import { newCallId, renderAsText } from '../../../extension/shared/providers/common.js';
import { EventQueue, LineSplitter, runProcess } from './claude-cli.js';

/** The environment variable that carries the page tools' token to Codex (never on the command line). */
const TOKEN_ENV = 'INTEGRATEDAI_PAGE_TOKEN';

export class CodexCliProvider extends Provider {
  static id = 'codex-cli';
  static label = 'ChatGPT (Codex CLI)';
  static models = ['default'];
  static capabilities = { streaming: false, nativeTools: false, reportsCost: false, vision: false };
  static structuredEnvelope = true;
  static pageToolsViaMcp = true;

  /** @param {import('../config.js').Config} config */
  static defaultModel(config) {
    return config.providers['codex-cli']?.model || 'default';
  }

  /**
   * Available if `codex login status` succeeds (installed AND signed in).
   * @param {import('../config.js').Config} config
   * @param {typeof runProcess} [run]
   */
  static async checkAvailability(config, run = runProcess) {
    const { command } = config.providers['codex-cli'];
    const exe = resolveCommand(command);
    const res = await run(exe.command, [...exe.prefix, 'login', 'status'], { timeoutMs: 20_000 });
    if (res.spawnError) {
      return { available: false, reason: `Could not run "${command}": ${res.spawnError}. Install it with "npm install -g @openai/codex", or set providers.codex-cli.command in config.json.` };
    }
    if (res.code !== 0) {
      return { available: false, reason: 'Codex CLI is not signed in. Run "codex login" in a terminal and choose "Sign in with ChatGPT".' };
    }
    return { available: true };
  }

  /**
   * @param {import('../config.js').Config} config
   * @param {{ run?: typeof runProcess }} [deps]
   */
  constructor(config, deps = {}) {
    super(config);
    this.run = deps.run ?? runProcess;
    this.workDir = join(config.dataDir, 'codex-cli-workspace');
    mkdirSync(this.workDir, { recursive: true });
  }

  /**
   * @param {import('../../../extension/shared/providers/base.js').TurnRequest} req
   * @returns {AsyncGenerator<import('../../../extension/shared/providers/base.js').ProviderEvent>}
   */
  async *turn(req) {
    const { messages, system, actionNames, model, state, signal, pageTools } = req;
    const cfg = this.config.providers['codex-cli'];

    // Resume the Codex thread if there is one (only the new messages go in); our instructions go in again when
    // they changed (another agent mode, a marked area, …).
    const resume = Boolean(state.threadId);
    const systemHash = createHash('sha256').update(system).digest('hex').slice(0, 16);
    const unseen = resume ? messages.slice(state.synced ?? 0) : messages;
    const prompt = (!resume || state.systemHash !== systemHash ? `<instructions>\n${system}\n</instructions>\n\n` : '')
      + renderAsText(unseen);

    const args = buildCodexArgs({
      resume: resume ? state.threadId : null,
      model,
      schemaFile: null, // (see the top of this file; state.noSchema below stays for a schema given in future)
      pageTools,
    });
    const exe = resolveCommand(cfg.command);

    // Progress lines become live preview text ("Look at the page…") while it works.
    const queue = new EventQueue();
    const progress = new CodexProgress();
    const lines = new LineSplitter((line) => {
      const text = progress.feed(line);
      if (text) queue.push({ type: 'preview_delta', text });
    });
    const started = Date.now();
    const running = this.run(exe.command, [...exe.prefix, ...args], {
      cwd: this.workDir,
      input: prompt,
      timeoutMs: cfg.timeoutMs,
      signal,
      env: pageTools ? { [TOKEN_ENV]: pageTools.token } : {},
      onStdout: (chunk) => lines.push(chunk),
    }).finally(() => queue.end());
    for await (const event of queue) yield event;
    const res = await running;
    console.log(`[codex-cli] ${resume ? 'resume' : 'new thread'}: ${((Date.now() - started) / 1000).toFixed(1)}s, exit ${res.code}`);

    if (signal.aborted) throw new Error('Cancelled');
    if (res.spawnError) throw new Error(`Could not run Codex CLI: ${res.spawnError}`);
    if (res.timedOut) throw new Error(`ChatGPT (Codex CLI) did not answer within ${Math.round(cfg.timeoutMs / 1000)}s`);

    const out = parseCodexOutput(res.stdout);
    const failure = out.error || (res.code !== 0 && !out.message ? res.stderr.trim() || `exit code ${res.code}` : '');
    // Its thread is gone: a new one, with the whole conversation.
    if (resume && failure && /thread|session|not found|no such/i.test(failure)) {
      state.threadId = undefined;
      state.synced = 0;
      yield* this.turn(req);
      return;
    }
    // The answer format refused (Codex's model needs a stricter schema): without it from now on; the instructions
    // still ask for the same JSON answer.
    if (!state.noSchema && failure && /schema/i.test(failure)) {
      state.noSchema = true;
      yield* this.turn(req);
      return;
    }
    if (failure) throw new Error(`ChatGPT (Codex CLI) error: ${failure.slice(0, 500)}`);

    state.threadId = out.threadId ?? state.threadId;
    state.systemHash = systemHash;
    state.synced = messages.length + 1; // (+1: the assistant message the orchestrator adds for this call)

    const envelope = parseEnvelope(out.message);
    if (envelope.reply) yield { type: 'text_delta', text: envelope.reply };
    for (const action of envelope.actions) yield { type: 'tool_call', id: newCallId(), name: action.type, input: action.input };
    yield { type: 'usage', inputTokens: out.inputTokens, outputTokens: out.outputTokens, costUsd: null };
    yield { type: 'done', stopReason: 'end_turn' };
  }

  /** The answer's JSON schema in a file named after its hash (written once per variant). @param {object} schema */
  writeSchema(schema) {
    const text = JSON.stringify(schema);
    const file = join(this.workDir, `answer-schema-${createHash('sha256').update(text).digest('hex').slice(0, 16)}.json`);
    if (!existsSync(file)) writeFileSync(file, text);
    return file;
  }
}

/** Name of our MCP server for Codex (its tools: page's find_elements, …). */
const MCP_SERVER = 'page';

/**
 * The argv for one `codex exec` call (after the program itself). Exported for tests.
 * @param {{ resume: string | null, model: string, schemaFile: string | null, pageTools?: { url: string, token: string } }} o
 */
export function buildCodexArgs(o) {
  const args = [
    'exec', '--json', '--skip-git-repo-check',
    '--sandbox', 'read-only',
    '-c', 'features.shell_tool=false',
    '-c', 'approval_policy="never"',
    '--ignore-user-config', '--ignore-rules',
  ];
  if (o.pageTools) {
    args.push('-c', `mcp_servers.${MCP_SERVER}.url=${JSON.stringify(o.pageTools.url)}`);
    args.push('-c', `mcp_servers.${MCP_SERVER}.bearer_token_env_var=${JSON.stringify(TOKEN_ENV)}`);
    // Our page tools run without a prompt (nobody could answer one here; the panel enforces what each may do).
    args.push('-c', `mcp_servers.${MCP_SERVER}.default_tools_approval_mode="auto"`);
  }
  if (o.schemaFile) args.push('--output-schema', o.schemaFile);
  if (o.model && o.model !== 'default') args.push('--model', o.model);
  if (o.resume) args.push('resume', o.resume);
  args.push('-'); // the prompt comes from stdin
  return args;
}

/**
 * Read `codex exec --json` output: the thread id, the last agent message, token usage, and an error if it failed.
 * Exported for tests.
 * @param {string} stdout
 */
export function parseCodexOutput(stdout) {
  const out = { threadId: /** @type {string | null} */ (null), message: '', inputTokens: 0, outputTokens: 0, error: '' };
  for (const line of stdout.split(/\r?\n/)) {
    /** @type {any} */
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev?.type === 'thread.started' && ev.thread_id) out.threadId = String(ev.thread_id);
    else if (ev?.type === 'item.completed' && ev.item?.type === 'agent_message' && typeof ev.item.text === 'string') out.message = ev.item.text;
    else if (ev?.type === 'turn.completed') {
      out.inputTokens = Number(ev.usage?.input_tokens ?? 0);
      out.outputTokens = Number(ev.usage?.output_tokens ?? 0);
    } else if (ev?.type === 'turn.failed') out.error = String(ev.error?.message ?? ev.message ?? 'the turn failed');
    else if (ev?.type === 'error') out.error = String(ev.message ?? ev.error?.message ?? 'error');
  }
  return out;
}

/**
 * The { reply, actions } answer from the final message: JSON (also inside a code block or a sentence), or plain text
 * as the reply. Exported for tests.
 * @param {string} text
 * @returns {{ reply: string, actions: { type: string, input: unknown }[] }}
 */
export function parseEnvelope(text) {
  const tryJson = (/** @type {string} */ s) => { try { return JSON.parse(s); } catch { return null; } };
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  const data = tryJson(text.trim()) ?? (start >= 0 && end > start ? tryJson(text.slice(start, end + 1)) : null);
  if (!data || typeof data !== 'object' || (typeof data.reply !== 'string' && !Array.isArray(data.actions))) {
    return { reply: text.trim(), actions: [] };
  }
  return {
    reply: typeof data.reply === 'string' ? data.reply : '',
    actions: Array.isArray(data.actions) ? data.actions.filter((a) => a && typeof a.type === 'string') : [],
  };
}

/** Codex's progress lines → short preview lines for the panel ("Look at the page…"). */
export class CodexProgress {
  /** @param {string} line @returns {string} */
  feed(line) {
    /** @type {any} */
    let ev;
    try { ev = JSON.parse(line); } catch { return ''; }
    if (ev?.type !== 'item.started' || ev.item?.type !== 'mcp_tool_call') return '';
    const name = String(ev.item.tool ?? ev.item.name ?? '').replace(/^.*__/, '');
    if (!name || isPageAction(name)) return ''; // page steps show up as their own lines in the chat
    return `\n${ACTIONS[name]?.label ?? name}…\n`;
  }
}

/** @type {Map<string, { command: string, prefix: string[] }>} */
const resolved = new Map();

/**
 * How to start the CLI. On Windows, npm installs "codex" as a codex.cmd script, which Node can't start without a
 * shell: then the script's JavaScript file is run with Node directly (what the script does). Exported for tests.
 * @param {string} command
 * @param {{ platform?: string, where?: (c: string) => string[], read?: (f: string) => string }} [deps]
 */
export function resolveCommand(command, deps = {}) {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'win32' || /[\\/]/.test(command) || /\.(exe|js)$/i.test(command)) return { command, prefix: [] };
  const key = command;
  const cached = resolved.get(key);
  if (cached && !deps.where) return cached;
  const where = deps.where ?? ((c) => {
    const r = spawnSync('where', [c], { encoding: 'utf8', windowsHide: true });
    return r.status === 0 ? r.stdout.split(/\r?\n/).filter(Boolean) : [];
  });
  const found = where(command);
  const exe = found.find((p) => /\.exe$/i.test(p));
  const cmd = found.find((p) => /\.cmd$/i.test(p));
  let result = { command, prefix: /** @type {string[]} */ ([]) };
  if (exe) result = { command: exe, prefix: [] };
  else if (cmd) {
    const script = (deps.read ?? ((f) => readFileSync(f, 'utf8')))(cmd);
    const m = /"%~?dp0%?\\([^"]+?\.js)"/i.exec(script);
    if (m) result = { command: process.execPath, prefix: [join(dirname(cmd), m[1])] };
  }
  if (!deps.where) resolved.set(key, result);
  return result;
}
