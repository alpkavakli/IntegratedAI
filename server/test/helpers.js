import { mkdtempSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULTS } from '../src/config.js';

/** A config object pointing at a throwaway data folder. */
export function testConfig(overrides = {}) {
  return {
    ...structuredClone(DEFAULTS),
    token: 'test-token',
    dataDir: mkdtempSync(join(tmpdir(), 'integratedai-test-')),
    ...overrides,
  };
}

/** Collect all events from an async generator. */
export async function collect(gen) {
  const out = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

/**
 * A small real PDF (one page, Helvetica), with a correct cross-reference table: lines of text at the given sizes.
 * @param {[string, number][]} lines  [text, font size]
 */
export function makePdf(lines) {
  const esc = (s) => s.replace(/[\\()]/g, '\\$&');
  let y = 740;
  const stream = `BT\n${lines.map(([text, size], i) => {
    const move = i === 0 ? `72 ${y} Td` : `0 -${Math.round(size * (text.startsWith('§') ? 3 : 1.4))} Td`;
    return `/F1 ${size} Tf ${move} (${esc(text.replace(/^§/, ''))}) Tj`;
  }).join('\n')}\nET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

/**
 * A ZIP file (deflate), for tests. zip64: write the ZIP64 records and all-ones markers that archives over 4 GB
 * use, though this one is small (to test reading them).
 * @param {{ name: string, data: string | Uint8Array }[]} entries
 * @param {{ zip64?: boolean }} [opts]
 */
export function makeZip(entries, { zip64 = false } = {}) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  for (const { name, data } of entries) {
    const raw = Buffer.from(data);
    const packed = deflateRawSync(raw);
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(zip64 ? 45 : 20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, packed);

    // ZIP64 extra field: the real size, packed size and offset (the header fields are all ones).
    const extra = zip64 ? Buffer.concat([Buffer.from([1, 0, 24, 0]), u64(raw.length), u64(packed.length), u64(offset)]) : Buffer.alloc(0);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(45, 4);
    header.writeUInt16LE(zip64 ? 45 : 20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt32LE(zip64 ? 0xffffffff : packed.length, 20);
    header.writeUInt32LE(zip64 ? 0xffffffff : raw.length, 24);
    header.writeUInt16LE(nameBuf.length, 28);
    header.writeUInt16LE(extra.length, 30);
    header.writeUInt32LE(zip64 ? 0xffffffff : offset, 42);
    central.push(header, nameBuf, extra);
    offset += local.length + nameBuf.length + packed.length;
  }
  const dir = Buffer.concat(central);
  const tail = [];
  if (zip64) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(44n, 4);
    record.writeUInt16LE(45, 12);
    record.writeUInt16LE(45, 14);
    record.writeBigUInt64LE(BigInt(entries.length), 24);
    record.writeBigUInt64LE(BigInt(entries.length), 32);
    record.writeBigUInt64LE(BigInt(dir.length), 40);
    record.writeBigUInt64LE(BigInt(offset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(offset + dir.length), 8);
    locator.writeUInt32LE(1, 16);
    tail.push(record, locator);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(zip64 ? 0xffff : entries.length, 8);
  end.writeUInt16LE(zip64 ? 0xffff : entries.length, 10);
  end.writeUInt32LE(zip64 ? 0xffffffff : dir.length, 12);
  end.writeUInt32LE(zip64 ? 0xffffffff : offset, 16);
  return new Uint8Array(Buffer.concat([...chunks, dir, ...tail, end]));
}

/**
 * A conversation as ChatGPT's data export has it: a tree of messages with a current node.
 * @param {string} id @param {string} title @param {[string, string][]} turns  [role, text]
 * @param {number} [time] seconds
 */
export function exportedChat(id, title, turns, time = 1_760_000_000) {
  const mapping = { root: { id: 'root', message: null, parent: null, children: ['m0'] } };
  turns.forEach(([role, text], i) => {
    mapping[`m${i}`] = {
      id: `m${i}`, parent: i ? `m${i - 1}` : 'root', children: i < turns.length - 1 ? [`m${i + 1}`] : [],
      message: { id: `m${i}`, author: { role }, create_time: time + i, content: { content_type: 'text', parts: [text] }, metadata: {} },
    };
  });
  return { title, create_time: time, update_time: time + turns.length, mapping, current_node: `m${turns.length - 1}`, conversation_id: id };
}
