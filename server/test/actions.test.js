import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../../extension/shared/validate.js';
import {
  ACTION_NAMES, enabledActionNames, envelopeSchema, isReadOnly, validateAction,
} from '../../extension/shared/actions.js';

test('validator: types, required, additionalProperties, enum, anyOf', () => {
  const schema = {
    type: 'object',
    properties: { a: { type: 'string' }, b: { type: 'array', items: { enum: ['x', 'y'] } } },
    required: ['a'],
    additionalProperties: false,
  };
  assert.deepEqual(validate(schema, { a: 'ok', b: ['x'] }), []);
  assert.match(validate(schema, {}).join(), /a is required/);
  assert.match(validate(schema, { a: 1 }).join(), /type string/);
  assert.match(validate(schema, { a: 'ok', c: 1 }).join(), /c is not allowed/);
  assert.match(validate(schema, { a: 'ok', b: ['z'] }).join(), /must be one of/);
  assert.deepEqual(validate({ anyOf: [{ type: 'string' }, { type: 'integer' }] }, 3), []);
  assert.equal(validate({ anyOf: [{ type: 'string' }] }, 3).length, 1);
});

test('validator: rejects oversized strings', () => {
  assert.match(validate({ type: 'string' }, 'x'.repeat(60_000)).join(), /too long/);
});

test('read-only classification', () => {
  assert.equal(isReadOnly('inspect_element'), true);
  assert.equal(isReadOnly('inject_css'), false);
  assert.equal(isReadOnly('nope'), false);
});

test('execute_js is only enabled by the setting', () => {
  assert.ok(!enabledActionNames({}).includes('execute_js'));
  assert.ok(enabledActionNames({ executeJs: true }).includes('execute_js'));
  const input = { description: 'x', code: 'return 1' };
  assert.deepEqual(validateAction('execute_js', input, { executeJs: true }), []);
  assert.match(validateAction('execute_js', input, {}).join(), /disabled/);
});

test('inject_css validation', () => {
  assert.deepEqual(validateAction('inject_css', { description: 'd', css: '.a{color:red}' }), []);
  assert.match(validateAction('inject_css', { description: 'd', css: '<style>.a{}</style>' }).join(), /style/);
  assert.match(validateAction('inject_css', { css: 'a{}' }).join(), /description is required/);
});

test('modify_element safety rules', () => {
  const ok = { description: 'd', setStyles: [{ property: 'color', value: 'red' }] };
  assert.deepEqual(validateAction('modify_element', ok), []);
  assert.match(validateAction('modify_element', { description: 'd' }).join(), /at least one change/);
  assert.match(
    validateAction('modify_element', { description: 'd', setAttributes: [{ name: 'onclick', value: 'x()' }] }).join(),
    /event-handler/,
  );
  assert.match(
    validateAction('modify_element', { description: 'd', setAttributes: [{ name: 'href', value: ' javascript:alert(1)' }] }).join(),
    /Script URL/,
  );
  assert.deepEqual(
    validateAction('modify_element', { description: 'd', setAttributes: [{ name: 'href', value: '/docs' }] }),
    [],
  );
});

test('envelope schema accepts valid actions and rejects unknown ones', () => {
  const schema = envelopeSchema(ACTION_NAMES);
  const good = { reply: 'hi', actions: [{ type: 'inject_css', input: { description: 'd', css: 'a{}' } }] };
  assert.deepEqual(validate(schema, good), []);
  const bad = { reply: 'hi', actions: [{ type: 'rm_rf', input: {} }] };
  assert.equal(validate(schema, bad).length, 1);
});
