// @ts-check
/**
 * A conversation as Markdown, for "Save as Markdown" in the panel: what was asked, what the AI answered,
 * what it looked at, and what it proposed or did on the page (with what happened to each change).
 * Page context, tool results, site-memory internals and screenshots are left out: it's a record to read
 * or share, not a copy of everything sent to the AI.
 */

import { ACTIONS, isReadOnly, isServerSide } from './actions.js';

/** What happened to a change, in words. */
const STATUS = {
  proposed: 'not applied', applied: 'applied', rejected: 'rejected', failed: 'failed', undone: 'applied, then undone',
  saved: 'applied and saved as a site patch', invalid: 'not valid, not shown',
};

/**
 * @param {{ title?: string, url?: string, provider?: string, model?: string,
 *   messages: import('./protocol.js').NeutralMessage[], actions: Record<string, any> }} session
 * @param {Date} [now]
 */
export function conversationToMarkdown(session, now = new Date()) {
  const out = [`# ${session.title || 'Conversation'}`, ''];
  const meta = [
    session.url && `Page: ${session.url}`,
    session.provider && `AI: ${session.provider}${session.model ? ` (${session.model})` : ''}`,
    `Saved: ${now.toISOString().slice(0, 16).replace('T', ' ')}`,
  ].filter(Boolean);
  out.push(meta.join('  \n'), '');

  for (const message of session.messages) {
    const lines = [];
    for (const block of message.content) {
      const b = /** @type {any} */ (block);
      if (b.type === 'text' && b.text.trim()) lines.push(b.text.trim(), '');
      else if (b.type === 'context' && message.role === 'user' && b.data?.selected?.selector) lines.push(`_About: \`${b.data.selected.selector}\`_`, '');
      else if (b.type === 'inspection') lines.push(`- Looked at: ${describe(b.name, b.input)}`);
      else if (b.type === 'tool_call') lines.push(...toolCall(b, session.actions[b.id]));
    }
    // A message made of tool results only (the AI's inspections coming back): nothing to show.
    if (!lines.length) continue;
    out.push(`## ${message.role === 'user' ? 'You' : 'AI'}`, '', ...lines);
    if (lines.at(-1) !== '') out.push('');
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

/** One tool call: an inspection line, a memory note, or a change with its outcome. @param {any} call @param {any} record */
function toolCall(call, record) {
  const input = call.input ?? {};
  if (isServerSide(call.name)) {
    const what = call.name === 'remember' ? `remembered "${input.note}"` : call.name === 'forget' ? 'forgot a note' : `named this page type "${input.name}"`;
    return [`- Memory: ${what}`];
  }
  if (isReadOnly(call.name) || !ACTIONS[call.name]) return [`- Looked at: ${describe(call.name, input)}`];
  const outcome = record?.live
    ? (record.status === 'applied' ? 'done on the page' : record.status === 'rejected' ? 'denied' : 'not done')
    : STATUS[/** @type {keyof typeof STATUS} */ (record?.status)] ?? 'not applied';
  const lines = [`- **${ACTIONS[call.name].label}**${input.description ? `: ${input.description}` : ''} _(${outcome})_`];
  if (call.name === 'inject_css') lines.push('', '  ```css', ...String(input.css).split('\n').map((l) => `  ${l}`), '  ```', '');
  if (call.name === 'execute_js') lines.push('', '  ```js', ...String(input.code).split('\n').map((l) => `  ${l}`), '  ```', '');
  if (call.name === 'interact') {
    for (const s of input.steps ?? []) {
      const target = s.text ? `"${s.text}"` : s.selector ? `\`${s.selector}\`` : s.ref ?? '';
      lines.push(`  - ${s.action} ${target}${s.value !== undefined ? ` → ${JSON.stringify(s.value)}` : ''}`.trimEnd());
    }
  }
  if (call.name === 'navigate') lines.push(`  - ${input.url ?? input.go}`);
  return lines;
}

/** "Find elements ("Send")" @param {string} name @param {any} input */
function describe(name, input = {}) {
  const label = ACTIONS[name]?.label ?? name;
  const detail = input.selector || input.ref || (input.text ? `"${input.text}"` : '') || input.urlContains || input.readContentOf || '';
  return detail ? `${label} (${detail})` : label;
}
