import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boostSelectorList } from '../../extension/shared/css-boost.js';

// boostCss() itself needs the browser's CSS parser (tested in a real browser);
// the selector rewriting it relies on is plain JavaScript.

const B = ':not(#integratedai)';

test('every selector in a list gets one ID of extra specificity', () => {
  assert.equal(boostSelectorList('.plan .badge'), `.plan .badge${B}`);
  assert.equal(boostSelectorList('a:hover, nav > a.active'), `a:hover${B}, nav > a.active${B}`);
  assert.equal(boostSelectorList('html'), `html${B}`);
});

test('the boost goes before a pseudo-element, after a pseudo-class', () => {
  assert.equal(boostSelectorList('h1::before'), `h1${B}::before`);
  assert.equal(boostSelectorList('p:first-line'), `p${B}:first-line`);
  assert.equal(boostSelectorList('input::placeholder, li::marker'), `input${B}::placeholder, li${B}::marker`);
  assert.equal(boostSelectorList('x-card::part(title)'), `x-card${B}::part(title)`);
  assert.equal(boostSelectorList('a:is(.x, .y)'), `a:is(.x, .y)${B}`);
});

test('commas inside :is(), attribute values and strings do not split the list', () => {
  assert.equal(boostSelectorList(':is(.a, .b) .c, [data-x="a,b"]'), `:is(.a, .b) .c${B}, [data-x="a,b"]${B}`);
  assert.equal(boostSelectorList(`[title='x, y'] span`), `[title='x, y'] span${B}`);
});

test('already boosted selectors are left alone', () => {
  assert.equal(boostSelectorList(`.a${B}`), `.a${B}`);
});
