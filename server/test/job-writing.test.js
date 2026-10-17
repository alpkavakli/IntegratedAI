import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CARD_ACTIONS, MAX_WRITTEN_TEXT, actionsForAccess, enabledActionNames, validateAction } from '../../extension/shared/actions.js';
import { renderContext } from '../../extension/shared/providers/common.js';
import { toOpenAIMessages } from '../../extension/shared/providers/openai-compatible.js';
import { buildSystemPrompt } from '../../extension/shared/agent/system-prompt.js';
import { conversationToMarkdown } from '../../extension/shared/conversation-markdown.js';
import { MAX_CV_CHARS, aboutMe, hasProfile } from '../../extension/panel/lib/profile.js';

test('write_text: a finished text for the user; offered in the card and with a marked area, not with "Just answer"', () => {
  assert.deepEqual(validateAction('write_text', { description: 'Cover letter for Acme', text: 'Dear Acme team, …' }), []);
  assert.ok(validateAction('write_text', { description: 'x', text: '   ' }).length, 'an empty text is refused');
  assert.ok(validateAction('write_text', { description: 'x', text: 'a'.repeat(MAX_WRITTEN_TEXT + 1) }).length, 'so is a far too long one');
  assert.ok(CARD_ACTIONS.includes('write_text'));
  const all = enabledActionNames({});
  assert.ok(actionsForAccess(all, 'area').includes('write_text'));
  assert.deepEqual(actionsForAccess(all, 'none'), []);
});

test('about me: the CV and notes go to the AI as their own block, as facts, apart from the page context', () => {
  const text = renderContext({ page: { url: 'https://jobs.example/backend' }, aboutMe: { cv: 'Alp Kavaklı\nJava, Spring Boot', notes: 'Backend internships' } });
  assert.match(text, /^<about_me note="[^"]*never invent[^"]*">\nCV:\nAlp Kavaklı\nJava, Spring Boot\n\nNotes from the user:\nBackend internships\n<\/about_me>\n<page_context>/);
  assert.match(text, /"url": "https:\/\/jobs\.example\/backend"/);
  assert.doesNotMatch(text.slice(text.indexOf('<page_context>')), /Spring Boot/, 'not repeated inside the page context');
  // "Just answer" (no page context at all): only the block.
  assert.doesNotMatch(renderContext({ aboutMe: { cv: 'CV' } }), /page_context/);
  // Nothing attached: as before.
  assert.equal(renderContext({ page: { url: 'u' } }), '<page_context>\n{\n "page": {\n  "url": "u"\n }\n}\n</page_context>');
  // It reaches the model inside the user's message.
  const sent = toOpenAIMessages('S', [{ role: 'user', ts: 0, content: [{ type: 'context', data: { aboutMe: { cv: 'MY CV TEXT' } } }, { type: 'text', text: 'Write a cover letter' }] }]);
  assert.match(sent[1].content, /<about_me[\s\S]*MY CV TEXT[\s\S]*Write a cover letter/);
});

test('about me: nothing saved → nothing attached; long texts are cut', () => {
  assert.equal(hasProfile({ cv: '  ', notes: '' }), false);
  assert.equal(aboutMe({ cv: '', notes: ' ' }), null);
  assert.deepEqual(aboutMe({ cv: ' CV ', notes: '' }), { cv: 'CV' });
  assert.equal(aboutMe({ cv: 'x'.repeat(MAX_CV_CHARS + 500), notes: 'n' }).cv.length, MAX_CV_CHARS);
});

test('the AI is told how to write for the user: from their CV only, as write_text', () => {
  const names = enabledActionNames({});
  for (const prompt of [buildSystemPrompt({ actionNames: names }), buildSystemPrompt({ actionNames: names, compact: true })]) {
    assert.match(prompt, /write_text/);
    assert.match(prompt, /[Nn]ever invent/);
    assert.match(prompt, /<about_me>/);
  }
});

test('markdown export: a written text is in it, quoted', () => {
  const md = conversationToMarkdown({
    title: 'Cover letter', url: 'https://jobs.example', provider: 'gemini', model: 'm', actions: { w1: { status: 'proposed' } },
    messages: [
      { role: 'user', ts: 1, content: [{ type: 'text', text: 'Write a cover letter' }] },
      { role: 'assistant', ts: 2, content: [{ type: 'text', text: 'Here it is.' }, { type: 'tool_call', id: 'w1', name: 'write_text', input: { description: 'Cover letter for Acme', text: 'Dear Acme team,\nI build things.' } }] },
    ],
  }, new Date(0));
  assert.match(md, /\*\*Written text\*\*: Cover letter for Acme/);
  assert.match(md, /> Dear Acme team,\n\s+> I build things\./);
});
