import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conversationToMarkdown } from '../../extension/shared/conversation-markdown.js';

test('a conversation as Markdown: questions, answers, what it looked at, and each change with its outcome', () => {
  const session = {
    title: 'Fix the badge', url: 'https://example.com/pricing', provider: 'ollama', model: 'qwen3:8b',
    messages: /** @type {any[]} */ ([
      { role: 'user', ts: 0, content: [{ type: 'context', data: { selected: { selector: '.plan .badge' } } }, { type: 'text', text: 'Why is this cut off?' }] },
      { role: 'assistant', ts: 0, content: [{ type: 'tool_call', id: 'f1', name: 'find_elements', input: { text: 'Most popular' } }] },
      { role: 'user', ts: 0, content: [{ type: 'tool_result', toolCallId: 'f1', content: '[{"ref":"e1"}]' }] },
      { role: 'assistant', ts: 0, content: [
        { type: 'text', text: 'It has white-space: nowrap.' },
        { type: 'tool_call', id: 'c1', name: 'inject_css', input: { description: 'Let it wrap', css: '.plan .badge {\n  white-space: normal;\n}' } },
        { type: 'tool_call', id: 'm1', name: 'remember', input: { note: 'badges: .plan .badge', scope: 'site' } },
      ] },
      { role: 'user', ts: 0, content: [{ type: 'text', text: 'Now sign me up' }] },
      { role: 'assistant', ts: 0, content: [{ type: 'tool_call', id: 'i1', name: 'interact', input: { description: 'Fill in', steps: [{ action: 'type', ref: 'e3', value: 'Sam' }, { action: 'click', text: 'Send' }] } }] },
    ]),
    actions: { c1: { name: 'inject_css', status: 'saved' }, i1: { name: 'interact', status: 'applied', live: true } },
  };
  const md = conversationToMarkdown(session, new Date('2026-10-07T12:30:00Z'));
  assert.match(md, /^# Fix the badge\n/);
  assert.match(md, /Page: https:\/\/example.com\/pricing {2}\nAI: ollama \(qwen3:8b\) {2}\nSaved: 2026-10-07 12:30/);
  assert.match(md, /## You\n\n_About: `.plan .badge`_\n\nWhy is this cut off\?/);
  assert.match(md, /- Looked at: Find elements \("Most popular"\)/);
  assert.match(md, /- \*\*Inject CSS\*\*: Let it wrap _\(applied and saved as a site patch\)_\n\n {2}```css\n {2}.plan .badge \{/);
  assert.match(md, /- Memory: remembered "badges: .plan .badge"/);
  assert.match(md, /- \*\*Interact with the page\*\*: Fill in _\(done on the page\)_\n {2}- type e3 → "Sam"\n {2}- click "Send"/);
  assert.doesNotMatch(md, /\[\{"ref"/, 'tool results are left out');
  assert.equal((md.match(/## AI/g) ?? []).length, 3, 'the tool-result-only message is skipped');
});
