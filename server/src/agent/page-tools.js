// @ts-check
/**
 * Page tools: the read-only inspections (find_elements, inspect_element, …) offered
 * to Claude Code as real tools through the MCP endpoint (see ../mcp.js).
 *
 * Without this, the CLI model can only request inspections by listing them in its
 * JSON answer, and some models (often Sonnet) call them as tools anyway and give up
 * when that fails. With it, a tool call goes:
 *
 *   claude -p ──MCP tools/call──► /mcp ──► PageTools.call() ──► panel.requestTool() ──► result
 *
 * Every model call gets its own random token (a "grant"), which only works while that
 * call runs and only for inspections of that conversation. Changes (inject_css, …) and
 * site memory are never offered here: they still go through the JSON answer and the
 * user's approval.
 */

import { randomBytes } from 'node:crypto';
import { ACTIONS, isReadOnly, validateAction } from '../../../extension/shared/actions.js';

const MAX_RESULT_CHARS = 30_000;

/**
 * @typedef {{ conversationId: string, names: string[], signal: AbortSignal }} Grant
 * @typedef {{ name: string, description: string, inputSchema: object }} ToolInfo
 */

export class PageTools {
  /** @param {Pick<import('./orchestrator.js').PanelLink, 'requestTool'>} panel */
  constructor(panel) {
    this.panel = panel;
    /** @type {Map<string, Grant>} token → grant */
    this.grants = new Map();
  }

  /**
   * Allow the inspections in `names` for one model call. Revoke when the call ends.
   * @param {string} conversationId
   * @param {string[]} names enabled action names; only the read-only ones are offered
   * @param {AbortSignal} signal
   */
  grant(conversationId, names, signal) {
    const token = randomBytes(24).toString('base64url');
    this.grants.set(token, { conversationId, names: names.filter(isReadOnly), signal });
    return { token, revoke: () => { this.grants.delete(token); } };
  }

  /** @param {unknown} token */
  lookup(token) {
    return typeof token === 'string' ? this.grants.get(token) ?? null : null;
  }

  /**
   * @param {Grant} grant
   * @returns {ToolInfo[]}
   */
  list(grant) {
    return grant.names.map((name) => ({
      name,
      description: ACTIONS[name].description,
      inputSchema: ACTIONS[name].inputSchema,
    }));
  }

  /**
   * Run one inspection in the panel showing the conversation.
   * @param {Grant} grant
   * @param {string} name
   * @param {unknown} input
   * @returns {Promise<{ text: string, isError: boolean }>}
   */
  async call(grant, name, input) {
    if (!grant.names.includes(name)) return { text: `Unknown tool "${name}"`, isError: true };
    const errors = validateAction(name, input ?? {});
    if (errors.length) return { text: `Invalid input: ${errors.join('; ')}`, isError: true };
    const res = await this.panel.requestTool(grant.conversationId, name, input ?? {}, grant.signal);
    if (!res.ok) return { text: `Inspection failed: ${res.error ?? 'unknown error'}`, isError: true };
    const text = JSON.stringify(res.result ?? null);
    return { text: text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}… [truncated]` : text, isError: false };
  }
}
