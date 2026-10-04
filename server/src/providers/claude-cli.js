// @ts-check
/**
 * Provider: Claude Code CLI (`claude -p`), using your normal Claude Code login.
 *
 * How one model call works:
 *   claude -p                                  non-interactive "print" mode
 *     --output-format stream-json …            live events, one JSON object per line; the last is the result
 *     --json-schema '<envelope schema>'        forces { reply, actions[] } → result.structured_output
 *     --system-prompt-file <file>              replaces Claude Code's coding-agent prompt with ours
 *     --tools "" --disallowedTools "mcp__*"    no file/shell/MCP tools: the model can only answer
 *     --strict-mcp-config --setting-sources "" ignore your MCP servers, hooks and settings files
 *     --disable-slash-commands                 page text can't trigger skills/commands
 *     --session-id <uuid> | --resume <uuid>    one Claude Code session per conversation
 *   The prompt (new messages + page context) is written to stdin, not argv, because
 *   Windows limits command-line length.
 *
 * We do NOT use --bare: bare mode ignores subscription logins and needs ANTHROPIC_API_KEY.
 * Instead the CLI runs in an empty working folder (<dataDir>/claude-cli-workspace) so no
 * project CLAUDE.md, .mcp.json or project hooks are picked up.
 *
 * Inspections requested by the model come back as `actions`; the orchestrator runs
 * them and calls turn() again, which resumes the same Claude Code session.
 */

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { envelopeSchema } from '../../../extension/shared/actions.js';
import { Provider } from './base.js';
import { newCallId, renderAsText } from './common.js';

export class ClaudeCliProvider extends Provider {
  static id = 'claude-cli';
  static label = 'Claude Code CLI';
  static models = ['default', 'opus', 'sonnet', 'haiku', 'fable'];
  static capabilities = { streaming: false, nativeTools: false, reportsCost: true, vision: false };
  // The CLI answers in one JSON envelope rather than native tool calls.
  static structuredEnvelope = true;

  /** @param {import('../config.js').Config} config */
  static defaultModel(config) {
    return config.providers['claude-cli'].model || 'default';
  }

  /**
   * Available if `claude auth status` succeeds (installed AND logged in).
   * @param {import('../config.js').Config} config
   * @param {typeof runProcess} [run]  injectable for tests
   */
  static async checkAvailability(config, run = runProcess) {
    const { command } = config.providers['claude-cli'];
    const res = await run(command, ['auth', 'status'], { timeoutMs: 20_000 });
    if (res.spawnError) {
      return { available: false, reason: `Could not run "${command}": ${res.spawnError}. Install Claude Code or set providers.claude-cli.command in config.json.` };
    }
    if (res.code !== 0) {
      return { available: false, reason: 'Claude Code is not logged in. Run `claude` once in a terminal and log in.' };
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
    this.workDir = join(config.dataDir, 'claude-cli-workspace');
    mkdirSync(this.workDir, { recursive: true });
  }

  /**
   * @param {import('./base.js').TurnRequest} req
   * @returns {AsyncGenerator<import('./base.js').ProviderEvent>}
   */
  async *turn(req) {
    const { messages, system, actionNames, model, state, signal } = req;
    const cfg = this.config.providers['claude-cli'];

    // Resume the Claude Code session if we have one; then only the messages it
    // hasn't seen yet are sent. Otherwise send the whole history (this also covers
    // switching to this provider in the middle of a conversation).
    const resume = Boolean(state.sessionId);
    const sessionId = state.sessionId ?? randomUUID();
    const unseen = resume ? messages.slice(state.synced ?? 0) : messages;
    const prompt = renderAsText(unseen);

    const args = buildCliArgs({
      sessionId,
      resume,
      model,
      effort: cfg.effort,
      maxBudgetUsd: cfg.maxBudgetUsdPerCall,
      schema: envelopeSchema(actionNames),
      systemPromptFile: this.writeSystemPrompt(system),
    });

    // Run the CLI and turn its stream-json lines into live preview text while it works.
    const queue = new EventQueue();
    const preview = new StreamPreview();
    const lines = new LineSplitter((line) => {
      const text = preview.feed(line);
      if (text) queue.push({ type: 'preview_delta', text });
    });
    const running = this.run(cfg.command, args, {
      cwd: this.workDir,
      input: prompt,
      timeoutMs: cfg.timeoutMs,
      signal,
      onStdout: (chunk) => lines.push(chunk),
    }).finally(() => queue.end());
    for await (const event of queue) yield event;
    const res = await running;

    if (signal.aborted) throw new Error('Cancelled');
    if (res.spawnError) throw new Error(`Could not run Claude Code: ${res.spawnError}`);
    if (res.timedOut) throw new Error(`Claude Code did not answer within ${Math.round(cfg.timeoutMs / 1000)}s`);

    const out = parseCliOutput(res.stdout);

    // The stored Claude Code session may be gone (e.g. deleted with `claude purge`).
    // Start a fresh one and send the full history instead.
    if (resume && out.isError && /no conversation found|session.*not found/i.test(out.errorText + res.stderr)) {
      state.sessionId = undefined;
      state.synced = 0;
      state.lastTotalCostUsd = 0;
      yield* this.turn(req);
      return;
    }
    if (out.isError) {
      throw new Error(`Claude Code error: ${out.errorText || res.stderr.trim() || `exit code ${res.code}`}`);
    }

    // Remember the session. +1 because the orchestrator appends exactly one
    // assistant message for this call; Claude Code already knows that one.
    state.sessionId = sessionId;
    state.synced = messages.length + 1;

    // With --resume, total_cost_usd is the session's running total; report the difference.
    let costUsd = out.totalCostUsd;
    if (costUsd !== null) {
      const previous = state.lastTotalCostUsd ?? 0;
      state.lastTotalCostUsd = costUsd;
      if (costUsd >= previous) costUsd -= previous;
    }

    // The validated reply is the stored text (the preview above was display-only).
    if (out.reply) yield { type: 'text_delta', text: out.reply };
    for (const action of out.actions) {
      yield { type: 'tool_call', id: newCallId(), name: action.type, input: action.input };
    }
    yield { type: 'usage', inputTokens: out.inputTokens, outputTokens: out.outputTokens, costUsd };
    yield { type: 'done', stopReason: out.stopReason };
  }

  /**
   * Write the system prompt to a file named after its hash (so it's written once per variant).
   * @param {string} system
   */
  writeSystemPrompt(system) {
    const hash = createHash('sha256').update(system).digest('hex').slice(0, 16);
    const file = join(this.workDir, `system-prompt-${hash}.md`);
    if (!existsSync(file)) writeFileSync(file, system);
    return file;
  }
}

/**
 * Build the argv for one `claude -p` call. Exported for tests.
 * @param {{ sessionId: string, resume: boolean, model: string, effort?: string | null,
 *   maxBudgetUsd?: number | null, schema: object, systemPromptFile: string }} o
 */
export function buildCliArgs(o) {
  const args = [
    '-p',
    '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--json-schema', JSON.stringify(o.schema),
    '--system-prompt-file', o.systemPromptFile,
    '--tools', '',
    '--disallowedTools', 'mcp__*',
    '--strict-mcp-config',
    '--setting-sources', '',
    '--disable-slash-commands',
  ];
  args.push(o.resume ? '--resume' : '--session-id', o.sessionId);
  if (o.model && o.model !== 'default') args.push('--model', o.model);
  if (o.effort) args.push('--effort', o.effort);
  if (o.maxBudgetUsd) args.push('--max-budget-usd', String(o.maxBudgetUsd));
  return args;
}

/**
 * Parse the JSON printed by `claude -p --output-format json`. Exported for tests.
 * @param {string} stdout
 */
export function parseCliOutput(stdout) {
  /** @type {any} */
  let data = null;
  const text = stdout.trim();
  try {
    data = JSON.parse(text); // --output-format json: one object
  } catch {
    // --output-format stream-json: one object per line; the final one has type "result".
    for (const line of text.split(/\r?\n/).reverse()) {
      try {
        const obj = JSON.parse(line);
        if (obj?.type === 'result') { data = obj; break; }
      } catch { /* not JSON */ }
    }
  }

  const result = {
    isError: true,
    errorText: '',
    reply: '',
    /** @type {{ type: string, input: unknown }[]} */
    actions: [],
    totalCostUsd: /** @type {number|null} */ (null),
    inputTokens: 0,
    outputTokens: 0,
    stopReason: 'end_turn',
  };

  if (!data || typeof data !== 'object') {
    result.errorText = `Unexpected output from Claude Code: ${text.slice(0, 300) || '(empty)'}`;
    return result;
  }

  result.totalCostUsd = typeof data.total_cost_usd === 'number' ? data.total_cost_usd : null;
  const u = data.usage ?? {};
  result.inputTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  result.outputTokens = u.output_tokens ?? 0;

  if (data.is_error || (data.subtype && data.subtype !== 'success')) {
    result.errorText = String(data.result ?? data.subtype ?? 'unknown error');
    return result;
  }
  result.isError = false;

  // Normally the envelope is in structured_output. Fall back to parsing `result`,
  // and finally to treating `result` as a plain-text reply.
  let envelope = data.structured_output;
  if (!envelope && typeof data.result === 'string') {
    try {
      envelope = JSON.parse(data.result);
    } catch {
      envelope = { reply: data.result, actions: [] };
    }
  }
  result.reply = typeof envelope?.reply === 'string' ? envelope.reply : '';
  result.actions = Array.isArray(envelope?.actions)
    ? envelope.actions.filter((a) => a && typeof a.type === 'string')
    : [];
  return result;
}

/**
 * Run a process, write `input` to stdin, collect output. Never throws.
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, input?: string, timeoutMs?: number, signal?: AbortSignal,
 *   onStdout?: (chunk: string) => void }} [opts]  onStdout: called with output as it arrives
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string, spawnError?: string, timedOut?: boolean }>}
 */
export function runProcess(command, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { cwd: opts.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: '', spawnError: String(err?.message ?? err) });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (/** @type {any} */ extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ code: child.exitCode, stdout, stderr, ...extra });
    };

    const onAbort = () => child.kill();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = opts.timeoutMs
      ? setTimeout(() => { timedOut = true; child.kill(); }, opts.timeoutMs)
      : undefined;

    child.stdout.setEncoding('utf8').on('data', (d) => {
      stdout += d;
      try { opts.onStdout?.(d); } catch { /* a display problem must not break the run */ }
    });
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
    child.on('error', (err) => finish({ spawnError: err.message }));
    child.on('close', (code) => finish({ code, timedOut }));

    child.stdin.on('error', () => {}); // ignore EPIPE if the process exits early
    child.stdin.end(opts.input ?? '');
  });
}

// ─────────────────────────────────────────────────────────── streaming helpers

/** Splits a stream of text chunks into complete lines. */
export class LineSplitter {
  /** @param {(line: string) => void} onLine */
  constructor(onLine) {
    this.onLine = onLine;
    this.buffer = '';
  }

  /** @param {string} chunk */
  push(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.onLine(line);
    }
  }
}

/**
 * Turns Claude Code stream-json lines into preview text for the panel.
 *
 * With --json-schema the answer arrives as the input of a "StructuredOutput"
 * tool call, streamed as JSON fragments like  {"reply": "CSS flex  |  box items…
 * We decode the "reply" string as it grows. If the model also writes plain text
 * before the tool call, that text is previewed instead (and the JSON reply,
 * which normally repeats it, is then not previewed a second time).
 */
export class StreamPreview {
  constructor() {
    this.sawText = false;
    this.inStructuredOutput = false;
    this.json = '';
    this.reply = new JsonStringField('reply');
  }

  /**
   * @param {string} line one stream-json line
   * @returns {string} new preview text ('' if none)
   */
  feed(line) {
    /** @type {any} */
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return '';
    }
    // Only top-level stream events (not subagents).
    if (msg.type !== 'stream_event' || msg.parent_tool_use_id) return '';
    const event = msg.event;

    if (event?.type === 'content_block_start') {
      this.inStructuredOutput = event.content_block?.type === 'tool_use' && event.content_block?.name === 'StructuredOutput';
      return '';
    }
    if (event?.type !== 'content_block_delta') return '';

    if (event.delta?.type === 'text_delta') {
      this.sawText = true;
      return event.delta.text ?? '';
    }
    if (event.delta?.type === 'input_json_delta' && this.inStructuredOutput) {
      const more = this.reply.feed(event.delta.partial_json ?? '');
      return this.sawText ? '' : more;
    }
    return '';
  }
}

/**
 * Incrementally decodes one string field ("reply") from a JSON object that
 * arrives in fragments. feed() returns only the newly decoded characters.
 */
export class JsonStringField {
  /** @param {string} name */
  constructor(name) {
    this.pattern = new RegExp(`"${name}"\\s*:\\s*"`);
    this.buffer = '';
    this.pos = -1;     // index of the next undecoded character of the value
    this.done = false;
  }

  /** @param {string} fragment */
  feed(fragment) {
    this.buffer += fragment;
    if (this.done) return '';
    if (this.pos < 0) {
      const m = this.pattern.exec(this.buffer);
      if (!m) return '';
      this.pos = /** @type {number} */ (m.index) + m[0].length;
    }

    let out = '';
    while (this.pos < this.buffer.length) {
      const ch = this.buffer[this.pos];
      if (ch === '"') { this.done = true; break; }
      if (ch !== '\\') { out += ch; this.pos++; continue; }

      // Escape sequence: wait until it is complete.
      const next = this.buffer[this.pos + 1];
      if (next === undefined) break;
      if (next === 'u') {
        const hex = this.buffer.slice(this.pos + 2, this.pos + 6);
        if (hex.length < 4) break;
        out += String.fromCharCode(parseInt(hex, 16));
        this.pos += 6;
        continue;
      }
      out += { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' }[next] ?? next; // \" \\ \/ map to themselves
      this.pos += 2;
    }
    return out;
  }
}

/**
 * Minimal async queue: push() from callbacks, `for await` on the other side.
 * Bridges the child-process callbacks into the provider's async generator.
 */
export class EventQueue {
  constructor() {
    /** @type {any[]} */
    this.items = [];
    this.ended = false;
    /** @type {(() => void) | null} */
    this.wake = null;
  }

  /** @param {any} item */
  push(item) {
    this.items.push(item);
    this.wake?.();
  }

  end() {
    this.ended = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.items.length) {
        yield this.items.shift();
      } else if (this.ended) {
        return;
      } else {
        await new Promise((resolve) => { this.wake = () => resolve(undefined); });
        this.wake = null;
      }
    }
  }
}
