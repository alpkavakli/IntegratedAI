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
