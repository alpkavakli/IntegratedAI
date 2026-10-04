import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkUpgrade, tokenMatches } from '../src/auth.js';
import { scopeMatches, defaultScopeFor } from '../../extension/shared/url-scope.js';

const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const config = { port: 7823, allowedExtensionIds: [] };
const req = (host, origin) => ({ headers: { host, origin } });

test('upgrade: accepts a Chrome extension on localhost', () => {
  assert.equal(checkUpgrade(req('127.0.0.1:7823', EXT), config).ok, true);
  assert.equal(checkUpgrade(req('localhost:7823', EXT), config).ok, true);
});

test('upgrade: rejects websites, DNS rebinding and wrong ports', () => {
  assert.equal(checkUpgrade(req('127.0.0.1:7823', 'https://evil.example'), config).ok, false);
  assert.equal(checkUpgrade(req('127.0.0.1:7823', undefined), config).ok, false);
  assert.equal(checkUpgrade(req('evil.example:7823', EXT), config).ok, false);
  assert.equal(checkUpgrade(req('127.0.0.1:9999', EXT), config).ok, false);
});

test('upgrade: optional extension id allow-list', () => {
  const strict = { ...config, allowedExtensionIds: ['pppppppppppppppppppppppppppppppp'] };
  assert.equal(checkUpgrade(req('127.0.0.1:7823', EXT), strict).ok, false);
});

test('token comparison', () => {
  assert.equal(tokenMatches('secret', 'secret'), true);
  assert.equal(tokenMatches('secreT', 'secret'), false);
  assert.equal(tokenMatches(undefined, 'secret'), false);
  assert.equal(tokenMatches('', ''), false);
});

test('patch scopes', () => {
  assert.equal(scopeMatches({ type: 'origin', value: 'https://a.com' }, 'https://a.com/x?y'), true);
  assert.equal(scopeMatches({ type: 'origin', value: 'https://a.com' }, 'https://b.com/'), false);
  assert.equal(scopeMatches({ type: 'prefix', value: 'https://a.com/docs/' }, 'https://a.com/docs/1'), true);
  assert.equal(scopeMatches({ type: 'pattern', value: 'https://*.a.com/app/*' }, 'https://x.a.com/app/1'), true);
  assert.equal(scopeMatches({ type: 'pattern', value: 'https://*.a.com/app/*' }, 'https://x.a.com/other'), false);
  assert.equal(scopeMatches({ type: 'origin', value: 'chrome://settings' }, 'chrome://settings'), false);
  assert.deepEqual(defaultScopeFor('https://a.com/page'), { type: 'origin', value: 'https://a.com' });
  assert.equal(defaultScopeFor('chrome://newtab'), null);
});
