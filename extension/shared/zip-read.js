// @ts-check
/**
 * Read files out of a ZIP without unpacking it all: the list of entries (from the directory at its end), and one
 * entry's contents as a stream. For ChatGPT's data export, which can be several GB with attachments, while only
 * its conversations file is wanted. Handles ZIP64 (archives and entries over 4 GB) and the two usual methods:
 * stored and deflate (the browser's DecompressionStream does the inflating).
 */

/** @typedef {{ name: string, method: number, compressedSize: number, size: number, offset: number }} ZipEntry */

const EOCD = 0x06054b50;
const EOCD64_LOCATOR = 0x07064b50;
const EOCD64 = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** @param {Blob} blob @param {number} start @param {number} end */
const view = async (blob, start, end) => new DataView(await blob.slice(start, end).arrayBuffer());
/** A 64-bit number (files here are far below 2^53). @param {DataView} v @param {number} at */
const u64 = (v, at) => Number(v.getBigUint64(at, true));

/**
 * The entries of a ZIP file.
 * @param {Blob} blob
 * @returns {Promise<ZipEntry[]>}
 */
export async function zipEntries(blob) {
  // The end record is in the last 22 bytes, plus a comment of up to 64 KB.
  const tailStart = Math.max(0, blob.size - 65_557);
  const tail = await view(blob, tailStart, blob.size);
  let at = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === EOCD) { at = i; break; }
  }
  if (at < 0) throw new Error('This is not a ZIP file (or it is cut off).');
  let count = tail.getUint16(at + 10, true);
  let dirSize = tail.getUint32(at + 12, true);
  let dirOffset = tail.getUint32(at + 16, true);
  // ZIP64: the real numbers are in another record, pointed to by a locator just before this one.
  if (count === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) {
    const locatorAt = tailStart + at - 20;
    const locator = locatorAt >= 0 ? await view(blob, locatorAt, locatorAt + 20) : null;
    if (!locator || locator.getUint32(0, true) !== EOCD64_LOCATOR) throw new Error('This ZIP file is damaged (its ZIP64 directory is missing).');
    const recordAt = u64(locator, 8);
    const record = await view(blob, recordAt, recordAt + 56);
    if (record.getUint32(0, true) !== EOCD64) throw new Error('This ZIP file is damaged (its ZIP64 directory is missing).');
    count = u64(record, 32);
    dirSize = u64(record, 40);
    dirOffset = u64(record, 48);
  }

  const dir = await view(blob, dirOffset, dirOffset + dirSize);
  const decoder = new TextDecoder();
  /** @type {ZipEntry[]} */
  const entries = [];
  let p = 0;
  for (let n = 0; n < count && p + 46 <= dir.byteLength; n++) {
    if (dir.getUint32(p, true) !== CENTRAL) break;
    const method = dir.getUint16(p + 10, true);
    let compressedSize = dir.getUint32(p + 20, true);
    let size = dir.getUint32(p + 24, true);
    const nameLength = dir.getUint16(p + 28, true);
    const extraLength = dir.getUint16(p + 30, true);
    const commentLength = dir.getUint16(p + 32, true);
    let offset = dir.getUint32(p + 42, true);
    const name = decoder.decode(new Uint8Array(dir.buffer, dir.byteOffset + p + 46, nameLength));
    // ZIP64 extra field (id 1): the 64-bit values of whichever fields above are all ones, in this order.
    for (let e = p + 46 + nameLength; e + 4 <= p + 46 + nameLength + extraLength;) {
      const id = dir.getUint16(e, true);
      const length = dir.getUint16(e + 2, true);
      if (id === 1) {
        let q = e + 4;
        if (size === 0xffffffff) { size = u64(dir, q); q += 8; }
        if (compressedSize === 0xffffffff) { compressedSize = u64(dir, q); q += 8; }
        if (offset === 0xffffffff) { offset = u64(dir, q); }
      }
      e += 4 + length;
    }
    entries.push({ name, method, compressedSize, size, offset });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * One entry's contents, unpacked, as a stream of bytes.
 * @param {Blob} blob
 * @param {ZipEntry} entry
 * @returns {Promise<ReadableStream<Uint8Array>>}
 */
export async function zipEntryStream(blob, entry) {
  const header = await view(blob, entry.offset, entry.offset + 30);
  if (header.byteLength < 30 || header.getUint32(0, true) !== LOCAL) throw new Error(`This ZIP file is damaged (${entry.name}).`);
  const start = entry.offset + 30 + header.getUint16(26, true) + header.getUint16(28, true);
  const packed = /** @type {ReadableStream<Uint8Array>} */ (blob.slice(start, start + entry.compressedSize).stream());
  if (entry.method === 0) return packed;
  if (entry.method !== 8) throw new Error(`${entry.name} is packed in a way this can't read (method ${entry.method}).`);
  return packed.pipeThrough(/** @type {any} */ (new DecompressionStream('deflate-raw')));
}
