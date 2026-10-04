// @ts-check
/**
 * Helpers shared by providers: turning neutral content blocks into text.
 *
 * Providers with native tool calling only need renderContext(); text-only
 * providers (Claude Code CLI, future simple chat APIs) use renderAsText() to
 * flatten a whole message, including tool calls and results.
 */

import { randomBytes } from 'node:crypto';

/** @typedef {import('../../../extension/shared/protocol.js').NeutralMessage} NeutralMessage */
/** @typedef {import('../../../extension/shared/protocol.js').ContentBlock} ContentBlock */

/** Tool call ids look like "call_3f9a1c2b4d5e" (valid for every provider's id rules). */
export function newCallId() {
  return `call_${randomBytes(8).toString('hex')}`;
}

/**
 * The page context the panel collected, as a tagged block of JSON.
 * @param {unknown} data
 */
export function renderContext(data) {
  return `<page_context>\n${JSON.stringify(data, null, 1)}\n</page_context>`;
}

/**
 * Render one content block as plain text.
 * @param {ContentBlock} block
 */
export function renderBlockAsText(block) {
  switch (block.type) {
    case 'text':
      return block.text;
    case 'context':
      return renderContext(block.data);
    case 'note':
      return `<action_updates>\n${block.text}\n</action_updates>`;
    case 'tool_call':
      return `<action id="${block.id}" type="${block.name}">${JSON.stringify(block.input)}</action>`;
    case 'tool_result':
      return `<action_result id="${block.toolCallId}"${block.isError ? ' error="true"' : ''}>\n${block.content}\n</action_result>`;
    default:
      return '';
  }
}

/**
 * Render a list of messages as one text prompt (used by text-only providers).
 * User content is emitted as-is; assistant content (e.g. from another provider
 * earlier in the conversation) is wrapped so the model knows who said it.
 * @param {NeutralMessage[]} messages
 */
export function renderAsText(messages) {
  return messages
    .map((m) => {
      const body = m.content.map(renderBlockAsText).filter(Boolean).join('\n\n');
      return m.role === 'assistant' ? `<earlier_assistant_reply>\n${body}\n</earlier_assistant_reply>` : body;
    })
    .join('\n\n');
}
