import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { backupDataDir, dataInfo, prepareDataDir } from '../src/storage/data-version.js';
import { buildExport, conversationsToWrite, mergeMemory, mergePatches, parseImport } from '../../extension/shared/data-transfer.js';
import { newSession } from '../../extension/shared/agent/session-model.js';
import { testConfig } from './helpers.js';

const version = (dir) => JSON.parse(readFileSync(join(dir, 'data-version.json'), 'utf8')).version;

// ─────────────────────────────────────────────── server data folder

test('a fresh or pre-versioning folder is stamped, nothing else happens', () => {
  const dir = testConfig().dataDir;
  writeFileSync(join(dir, 'config.json'), '{}');
  const result = prepareDataDir(dir, { appVersion: '0.1.0' });
  assert.equal(result.backup, null);
  assert.equal(version(dir), 1);
  // second start: nothing to do
  assert.deepEqual(prepareDataDir(dir).ran, []);
});

test('an update backs the data up, then migrates in order', () => {
  const dir = testConfig().dataDir;
  mkdirSync(join(dir, 'memory'), { recursive: true });
  writeFileSync(join(dir, 'memory', 'site.com.json'), '{"site":"site.com","notes":[]}');
  mkdirSync(join(dir, 'logs'), { recursive: true });
  writeFileSync(join(dir, 'logs', 'x.log'), 'noise');
  prepareDataDir(dir); // stamp v1

  const order = [];
  const migrations = [
    { to: 3, description: 'third', run: () => order.push(3) },
    { to: 2, description: 'second', run: (d) => { order.push(2); writeFileSync(join(d, 'memory', 'site.com.json'), '{"migrated":true}'); } },
  ];
  const result = prepareDataDir(dir, { migrations, currentVersion: 3 });
  assert.deepEqual(order, [2, 3]);
  assert.equal(version(dir), 3);
  assert.deepEqual(result.ran, ['v2: second', 'v3: third']);
  // The backup has the data as it was before, without logs.
  assert.equal(readFileSync(join(result.backup, 'memory', 'site.com.json'), 'utf8'), '{"site":"site.com","notes":[]}');
  assert.equal(existsSync(join(result.backup, 'logs')), false);
  assert.equal(dataInfo(dir).backups, 1);
});

test('an older server refuses newer data instead of damaging it', () => {
  const dir = testConfig().dataDir;
  writeFileSync(join(dir, 'data-version.json'), JSON.stringify({ version: 99 }));
  assert.throws(() => prepareDataDir(dir), /newer version/);
});

test('backups never include earlier backups', () => {
  const dir = testConfig().dataDir;
  writeFileSync(join(dir, 'config.json'), '{}');
  const first = backupDataDir(dir, 'one');
  const second = backupDataDir(dir, 'two');
  assert.equal(existsSync(join(second, 'backups')), false);
  assert.equal(existsSync(join(first, 'config.json')), true);
});

// ─────────────────────────────────────────────── extension export / import

const patch = (id, css = 'a{color:red}') => ({ id, name: `p${id}`, css, scope: { type: 'origin', value: 'https://a.com' }, enabled: true, createdAt: 1 });

test('export never contains the pairing token', () => {
  const data = buildExport({ patches: [patch('1')], settings: { token: 'secret', serverUrl: 'ws://x', executeJs: true }, extensionVersion: '1.0.0' });
  assert.equal(JSON.stringify(data).includes('secret'), false);
  assert.deepEqual(data.settings, { serverUrl: 'ws://x', executeJs: true });
});

test('import round-trip and merge rules', () => {
  const file = JSON.parse(JSON.stringify(buildExport({ patches: [patch('1'), patch('2', 'b{}')], settings: {}, extensionVersion: '1' })));
  const { patches } = parseImport(file);
  const existing = [patch('1', 'old{}'), patch('9', 'b{}')];
  const result = mergePatches(existing, patches);
  assert.equal(result.updated, 1, 'same id replaces');
  assert.equal(result.skipped, 1, 'same css + scope under another id is not duplicated');
  assert.equal(result.added, 0);
  assert.equal(result.merged.find((p) => p.id === '1').css, 'a{color:red}');
});

test('import rejects foreign, newer and damaged files; ignores the token', () => {
  assert.throws(() => parseImport({ hello: 1 }), /not an IntegratedAI export/);
  assert.throws(() => parseImport({ format: 'integratedai-extension-data', version: 99, patches: [] }), /newer version/);
  assert.throws(() => parseImport({ format: 'integratedai-extension-data', version: 1, patches: [{ id: 'x' }] }), /damaged/);
  const { settings } = parseImport({ format: 'integratedai-extension-data', version: 1, patches: [], settings: { token: 't', webTools: false } });
  assert.deepEqual(settings, { webTools: false });
});

const note = (id, text, createdAt = 1, scope = 'site') => ({ id, text, scope, by: 'assistant', createdAt });

test('export v2 carries direct-mode conversations and memory; a version 1 file still imports', () => {
  const session = { ...newSession({ provider: 'openai', model: 'gpt-6.1-sol' }), busy: true };
  const memory = { site: 'a.com', groups: [], notes: [note('n1', 'Login is at /signin')] };
  const file = JSON.parse(JSON.stringify(buildExport({ patches: [], settings: {}, extensionVersion: '1', conversations: [session], memory: [memory] })));
  assert.equal(file.version, 2);
  assert.equal('busy' in file.conversations[0], false, 'runtime-only state is not exported');
  const parsed = parseImport(file);
  assert.equal(parsed.conversations[0].id, session.id);
  assert.deepEqual(parsed.memory, [memory]);
  const v1 = parseImport({ format: 'integratedai-extension-data', version: 1, patches: [patch('1')] });
  assert.deepEqual([v1.patches.length, v1.conversations, v1.memory], [1, [], []]);
});

test('import rejects damaged conversations and memory', () => {
  const base = { format: 'integratedai-extension-data', version: 2, patches: [] };
  assert.throws(() => parseImport({ ...base, conversations: [{ id: '../../etc', messages: [] }] }), /Conversation 1 is damaged/);
  const session = newSession({ provider: 'anthropic', model: 'm' });
  assert.throws(() => parseImport({ ...base, conversations: [{ ...session, messages: [{ role: 'user' }] }] }), /Conversation 1 is damaged/);
  assert.throws(() => parseImport({ ...base, memory: [{ site: 'a.com', groups: [], notes: [{ id: 'x', text: 1 }] }] }), /Site memory 1 is damaged/);
});

test('imported conversations: new and newer are written, older copies never overwrite', () => {
  const here = new Map([['a', 10], ['b', 10]]);
  const result = conversationsToWrite(here, [{ id: 'a', updatedAt: 5 }, { id: 'b', updatedAt: 20 }, { id: 'c', updatedAt: 1 }]);
  assert.deepEqual(result.write.map((s) => s.id), ['b', 'c']);
  assert.deepEqual([result.added, result.updated, result.skipped], [1, 1, 1]);
});

test('imported memory is joined with what is here, without duplicates or going over the limit', () => {
  const existing = { site: 'a.com', groups: [{ id: 'g1', name: 'Reader', pattern: '/book/*' }], notes: [note('n1', 'Dark theme', 5)] };
  const incoming = {
    site: 'a.com',
    groups: [{ id: 'g2', name: 'Reader again', pattern: '/book/*' }, { id: 'g3', name: 'Cart', pattern: '/cart' }],
    notes: [note('n1', 'Dark theme', 5), note('zz', 'Dark theme', 9), note('n2', 'Prices exclude tax', 1, '/cart')],
  };
  const { merged, added } = mergeMemory(existing, incoming);
  assert.equal(added, 1);
  assert.deepEqual(merged.groups.map((g) => g.id), ['g1', 'g3'], 'same pattern is not added twice');
  assert.deepEqual(merged.notes.map((n) => n.id), ['n2', 'n1'], 'oldest first');
  assert.equal(mergeMemory(null, incoming).merged.notes.length, 2, 'duplicates within the file are joined too');
  assert.equal(existing.notes.length, 1, 'the existing record is not modified');

  const many = { site: 'a.com', groups: [], notes: Array.from({ length: 120 }, (_, i) => note(`m${i}`, `note ${i}`, i)) };
  const capped = mergeMemory(null, { ...many, notes: many.notes.slice(0, 100) });
  const over = mergeMemory(capped.merged, { ...many, notes: many.notes.slice(100) }).merged;
  assert.equal(over.notes.length, 100);
  assert.equal(over.notes[0].id, 'm20', 'the oldest notes are dropped');
});
