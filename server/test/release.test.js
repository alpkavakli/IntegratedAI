import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(root, 'extension', 'manifest.json'), 'utf8'));

test('release: the npm server and the extension carry the same version (they are released together)', () => {
  assert.equal(pkg.version, manifest.version,
    'Bump both: extension/manifest.json and package.json (then npm publish the server along with the store upload; see HANDOFF.md, "Releasing").');
});

test('release: everything the server loads is in the npm package\'s files list', () => {
  const shipped = (/** @type {string} */ file) => pkg.files.some((entry) => file === entry || file.startsWith(entry));
  const seen = new Set();
  const visit = (/** @type {string} */ file) => {
    const rel = relative(root, file).split(sep).join('/');
    if (seen.has(rel)) return;
    seen.add(rel);
    assert.ok(shipped(rel), `${rel} is loaded by the server but not in package.json "files": it would be missing from npm`);
    for (const [, spec] of readFileSync(file, 'utf8').matchAll(/(?:from|import\()\s*'(\.[^']+)'/g)) visit(resolve(file, '..', spec));
  };
  visit(join(root, pkg.bin.integratedai));
  visit(join(root, 'server', 'native-host', 'host.js'));
  for (const name of readdirSync(join(root, 'server', 'src', 'providers'))) {
    const file = join(root, 'server', 'src', 'providers', name);
    if (statSync(file).isFile()) visit(file);
  }
  assert.ok(seen.size > 20, 'the import walk found the server code');
});
