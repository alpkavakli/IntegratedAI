import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { t } from '../../extension/shared/i18n.js';

const ext = fileURLToPath(new URL('../../extension/', import.meta.url));
const locale = (/** @type {string} */ lang) => JSON.parse(readFileSync(join(ext, '_locales', lang, 'messages.json'), 'utf8'));

test('i18n: every language has the same messages, with the same $1…$9 values', () => {
  const en = locale('en');
  for (const lang of readdirSync(join(ext, '_locales'))) {
    const other = locale(lang);
    assert.deepEqual(Object.keys(other).sort(), Object.keys(en).sort(), `${lang}: same keys as English`);
    for (const [key, { message }] of Object.entries(en)) {
      const values = (/** @type {string} */ m) => [...new Set(m.match(/\$\d/g) ?? [])].sort().join(',');
      assert.equal(values(other[key].message), values(message), `${lang}.${key}: same values`);
      assert.ok(other[key].message.trim(), `${lang}.${key}: not empty`);
    }
  }
});

test('i18n: every key the code uses exists in English, with the same English text', () => {
  const en = locale('en');
  /** @param {string} dir @returns {string[]} */
  const files = (dir) => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'vendor' || name === '_locales' || name === 'i18n.js') return []; // (i18n.js documents the syntax)
    return statSync(path).isDirectory() ? files(path) : /\.(js|html)$/.test(name) ? [path] : [];
  });
  for (const file of files(ext)) {
    const text = readFileSync(file, 'utf8');
    for (const [, key, english] of text.matchAll(/\bt\('(\w+)', (['"`])((?:\\.|(?!\2).)*)\2/g).map((m) => [m[0], m[1], m[3]])) {
      assert.ok(en[key], `${file}: "${key}" is not in _locales/en`);
      assert.equal(en[key].message, english.replace(/\\'/g, "'"), `${file}: "${key}" differs from _locales/en`);
    }
    for (const [, key] of text.matchAll(/data-i18n(?:-html|-title|-placeholder|-aria-label)?="(\w+)"/g)) {
      assert.ok(en[key], `${file}: data-i18n "${key}" is not in _locales/en`);
    }
  }
});

test('i18n: t() without chrome.i18n (tests, plain pages) gives the English with the values in it', () => {
  assert.equal(t('x', 'Copied $1 characters', 12), 'Copied 12 characters');
  assert.equal(t('x', '$1 of $2', 'a', 'b'), 'a of b');
});
