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

test('interact: steps need a target, type/select need a value', () => {
  const ok = { description: 'Fill in and submit', steps: [
    { action: 'type', selector: '#email', value: 'a@b.c' },
    { action: 'select', selector: 'select#course', value: 'SC2005' },
    { action: 'check', text: 'I agree' },
    { action: 'click', text: 'Register' },
  ] };
  assert.deepEqual(validateAction('interact', ok), []);
  assert.match(validateAction('interact', { description: 'd', steps: [] }).join(), /1–25 steps/);
  assert.match(validateAction('interact', { description: 'd', steps: [{ action: 'click' }] }).join(), /selector or text/);
  assert.match(validateAction('interact', { description: 'd', steps: [{ action: 'type', selector: '#x' }] }).join(), /needs a value/);
  assert.match(validateAction('interact', { description: 'd', steps: [{ action: 'drag', selector: '#x' }] }).join(), /must be one of/);
  assert.match(validateAction('interact', { description: 'd', steps: [{ action: 'click', selector: '#x', onclick: 'y' }] }).join(), /not allowed/);
});

test('find_elements and inject_css toggle', () => {
  assert.deepEqual(validateAction('find_elements', { text: 'Sign in', limit: 5 }), []);
  assert.deepEqual(validateAction('find_elements', {}), []);
  const toggle = { label: '🌙', activeLabel: '☀️', placeSelector: 'header nav', position: 'append' };
  assert.deepEqual(validateAction('inject_css', { description: 'd', css: 'html{filter:invert(1)}', toggle }), []);
  assert.match(validateAction('inject_css', { description: 'd', css: 'a{}', toggle: { label: 'x'.repeat(41) } }).join(), /1–40/);
  assert.match(validateAction('inject_css', { description: 'd', css: 'a{}', toggle: { label: 'x', position: 'inside' } }).join(), /must be one of/);
  assert.match(validateAction('inject_css', { description: 'd', css: 'a{}', toggle: { label: 'x', onclick: 'y' } }).join(), /not allowed/);
});

test('screenshot: read-only, optional selector or the visible page', () => {
  assert.equal(isReadOnly('screenshot'), true);
  assert.deepEqual(validateAction('screenshot', {}), []);
  assert.deepEqual(validateAction('screenshot', { selector: 'nav.g_nav' }), []);
  assert.deepEqual(validateAction('screenshot', { fullViewport: true }), []);
  assert.notDeepEqual(validateAction('screenshot', { selector: 'nav', zoom: 2 }), []);
});

test('interact: refs, hover and frames', () => {
  assert.deepEqual(validateAction('interact', { description: 'd', steps: [{ action: 'click', ref: 'e12' }, { action: 'hover', ref: 'e3' }] }), []);
  assert.deepEqual(validateAction('interact', { description: 'd', frame: 'https://pay.example.com/form', steps: [{ action: 'type', ref: 'e1', value: 'x' }] }), []);
  assert.deepEqual(validateAction('interact', { description: 'd', steps: [{ action: 'wait', ref: 'e4' }] }), [], 'a ref is a target to wait for');
  assert.match(validateAction('interact', { description: 'd', steps: [{ action: 'click', ref: '#main' }] }).join(), /ref must look like/);
  assert.match(validateAction('interact', { description: 'd', steps: [{ action: 'click', ref: 'e1', selector: '#a' }] }).join(), /not both/);
  assert.match(validateAction('interact', { description: 'd', frame: 'javascript:alert(1)', steps: [{ action: 'click', ref: 'e1' }] }).join(), /frame must be/);
});

test('page_outline and read_text', () => {
  assert.deepEqual(validateAction('page_outline', {}), []);
  assert.deepEqual(validateAction('page_outline', { all: true, limit: 100, frame: 'https://example.com/embed' }), []);
  assert.deepEqual(validateAction('read_text', { ref: 'e7', links: true, offset: 12000 }), []);
  assert.deepEqual(validateAction('read_text', { selector: 'main' }), []);
  assert.match(validateAction('read_text', { ref: 'main' }).join(), /ref must look like/);
  assert.match(validateAction('read_text', { html: true }).join(), /not allowed|unknown|additional/i);
  assert.equal(isReadOnly('page_outline'), true);
  assert.equal(isReadOnly('read_text'), true);
  assert.deepEqual(validateAction('find_elements', { text: 'Send', frame: 'https://example.com/chat' }), []);
  assert.deepEqual(validateAction('inspect_element', { ref: 'e2', include: ['html'] }), []);
  assert.deepEqual(validateAction('screenshot', { ref: 'e2' }), []);
});
