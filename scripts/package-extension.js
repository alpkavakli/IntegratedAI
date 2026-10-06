// @ts-check
/**
 * Build the Chrome Web Store upload: dist/integratedai-<version>.zip
 *
 *   npm run package
 *
 * Checks the manifest against store rules first (description ≤ 132 chars,
 * name ≤ 75, icons present, no remote code), then zips the extension/ folder.
 * The zip writer is built in (Node's zlib), so no extra dependencies.
 */

import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const extDir = join(root, 'extension');
const manifest = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'));

// ───────────────────────────────────────── store checks

const problems = [];
if (manifest.manifest_version !== 3) problems.push('manifest_version must be 3');
// Name and description may be "__MSG_key__": then check them in every language (_locales/<lang>/messages.json).
const localesDir = join(extDir, '_locales');
const locales = existsSync(localesDir) ? readdirSync(localesDir) : [];
const texts = (/** @type {string} */ value) => {
  const key = /^__MSG_(\w+)__$/.exec(value ?? '')?.[1];
  if (!key) return [['', value]];
  return locales.map((lang) => [lang, JSON.parse(readFileSync(join(localesDir, lang, 'messages.json'), 'utf8'))[key]?.message]);
};
if (/^__MSG_/.test(manifest.name) && !manifest.default_locale) problems.push('default_locale is needed with __MSG_ texts');
for (const [lang, name] of texts(manifest.name)) {
  if (!name || name.length > 75) problems.push(`name${lang ? ` (${lang})` : ''} must be 1–75 characters`);
}
for (const [lang, description] of texts(manifest.description)) {
  if (!description || description.length > 132) problems.push(`description${lang ? ` (${lang})` : ''} must be ≤ 132 characters (now ${description?.length})`);
}
if (!/^\d+(\.\d+){0,3}$/.test(manifest.version)) problems.push(`version "${manifest.version}" must be 1–4 dot-separated numbers`);
for (const [size, file] of Object.entries(manifest.icons ?? {})) {
  if (!existsSync(join(extDir, file))) problems.push(`icon ${size} missing: ${file}`);
}
if (!manifest.icons?.['128']) problems.push('a 128×128 icon is required');

const files = walk(extDir);
// MV3 forbids remotely hosted code: no <script src="http…"> and no imports from URLs.
for (const file of files.filter((f) => /\.(js|html)$/.test(f))) {
  const text = readFileSync(file, 'utf8');
  if (/<script[^>]+src=["']https?:/i.test(text) || /\bimport\s*(?:[^'"]*from\s*)?["']https?:/.test(text)) {
    problems.push(`remote code in ${relative(extDir, file)}`);
  }
}
if (problems.length) {
  console.error('Not ready for the Chrome Web Store:\n' + problems.map((p) => `  - ${p}`).join('\n'));
  process.exit(1);
}

// ───────────────────────────────────────── zip

const out = join(root, 'dist', `integratedai-${manifest.version}.zip`);
mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(out, zip(files.map((f) => ({ name: relative(extDir, f).split(sep).join('/'), data: readFileSync(f) }))));
console.log(`Packaged ${files.length} files → ${relative(root, out)} (${(statSync(out).size / 1024).toFixed(0)} KB)`);

/** All files under dir, skipping dotfiles and editor leftovers. @param {string} dir @returns {string[]} */
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith('.') || entry.name.endsWith('~')) return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

/**
 * Minimal ZIP (deflate) writer.
 * @param {{ name: string, data: Buffer }[]} entries
 */
function zip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const compressed = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);        // version needed
    local.writeUInt16LE(0x0800, 6);    // UTF-8 names
    local.writeUInt16LE(8, 8);         // deflate
    local.writeUInt32LE(0x00210000, 10); // fixed date/time (1980-01-01) for reproducible zips
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, compressed);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt32LE(0x00210000, 12);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(compressed.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(nameBuf.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, nameBuf);
    offset += local.length + nameBuf.length + compressed.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, end]);
}

/** @param {Buffer} buf */
function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
