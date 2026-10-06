import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordStep } from '../../extension/panel/lib/agent-runner.js';
import { describeStep } from '../../extension/panel/lib/tasks.js';

test('recordStep: refs become the element\'s selector with its visible name as the fallback', () => {
  const entry = recordStep({ action: 'click', ref: 'e7' }, { selector: '#reserve', text: 'Reserve my spot' });
  assert.deepEqual(entry, { kind: 'interact', step: { action: 'click', alternatives: [{ selector: '#reserve' }, { text: 'Reserve my spot' }] } });
  assert.equal(describeStep(entry), 'Click "Reserve my spot"');
});

test('recordStep: typed values are kept, except in password fields', () => {
  const typed = recordStep({ action: 'type', selector: '#name', value: 'Sam' }, { selector: '#name', text: 'Full name' });
  assert.equal(typed.step.value, 'Sam');
  assert.equal(describeStep(typed), 'Type "Sam" into "Full name"');
  const secret = recordStep({ action: 'type', ref: 'e2', value: 'hunter2' }, { selector: '#pw', text: 'Password', secret: true });
  assert.equal(secret.secret, true);
  assert.equal('value' in secret.step, false, 'the password is not saved');
  assert.doesNotMatch(JSON.stringify(secret), /hunter2/);
});

test('recordStep: steps without an element (scroll the page, press a key) stay as they are; frames are kept', () => {
  assert.deepEqual(recordStep({ action: 'scroll', value: 'down' }, undefined), { kind: 'interact', step: { action: 'scroll', value: 'down' } });
  assert.equal(recordStep({ action: 'click', ref: 'e1' }, { selector: 'button', text: 'Pay' }, 'https://pay.example/f').frame, 'https://pay.example/f');
  assert.equal(describeStep({ kind: 'navigate', input: { url: 'https://a.example/x' } }), 'Go to https://a.example/x');
});

test('the outline after a step: in full on a new page, only the changes on the same page', async () => {
  const { outlineChanges } = await import('../../extension/panel/lib/agent-runner.js');
  const first = { url: 'https://t.me/a', title: 'Chats', elements: ['e1 the "Message" field', 'e2 button "Send"', 'e3 link "Alice"'], text: 'Hello', headings: ['Chats'] };
  assert.equal(outlineChanges(undefined, first), first, 'first step: all of it');
  const typed = { ...first, elements: ['e1 the "Message" field = "Hi"', 'e2 button "Send"', 'e3 link "Alice"'] };
  const diff = outlineChanges(first, typed);
  assert.deepEqual(diff.added, ['e1 the "Message" field = "Hi"']);
  assert.deepEqual(diff.removed, ['e1']);
  assert.equal(diff.text, 'unchanged');
  assert.equal('elements' in diff, false);
  assert.match(diff.sameAsBefore, /still there/);
  assert.equal(outlineChanges(first, { ...first }).elements, 'unchanged');
  assert.equal(outlineChanges(first, { ...first, url: 'https://t.me/b' }).url, 'https://t.me/b', 'another page: in full');
  const replaced = { ...first, elements: ['e7 a', 'e8 b', 'e9 c', 'e10 d', 'e11 e'] };
  assert.deepEqual(outlineChanges(first, replaced).elements, replaced.elements, 'mostly new: in full');
  // A real page lists ~40 elements: one change is a small fraction of the full outline.
  const big = { ...first, elements: Array.from({ length: 40 }, (_, i) => `e${i + 1} link "Item number ${i + 1}" → /items/${i + 1}`), text: 'x'.repeat(1200) };
  const oneChange = { ...big, elements: big.elements.map((e, i) => (i === 3 ? `${e} (current)` : e)) };
  assert.ok(JSON.stringify(outlineChanges(big, oneChange)).length < JSON.stringify(oneChange).length / 5);
});
