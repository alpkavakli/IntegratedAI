// @ts-check
/**
 * The text of a PDF (an uploaded CV), read on this computer with pdf.js (vendored: extension/vendor/pdf.mjs and
 * pdf.worker.mjs, loaded only when a PDF is chosen). Nothing is sent anywhere for this.
 *
 * pdf.js gives the text as small pieces with positions; itemsToText puts them back into lines and paragraphs.
 */

/** Pages read at most (a CV has a few). */
export const MAX_PDF_PAGES = 30;

/**
 * One page's text pieces → lines. A new line when a piece ends its line (hasEOL) or the next one sits at another
 * height; an empty line before a clearly bigger gap (a new section); a space between pieces on a line that have a
 * gap between them.
 * @param {{ str: string, transform?: number[], width?: number, height?: number, hasEOL?: boolean }[]} items
 */
export function itemsToText(items) {
  /** @type {string[]} */
  const lines = [];
  let line = '';
  /** @type {{ y: number, endX: number, size: number } | null} */
  let last = null;
  let lineY = 0;
  let lineSize = 0;
  const flush = (/** @type {number} */ gapBefore) => {
    const text = line.replace(/\s+/g, ' ').trim();
    if (text) {
      // A gap of more than about 1.8 lines: a paragraph or section break.
      if (lines.length && gapBefore > 1.8 * (lineSize || 10)) lines.push('');
      lines.push(text);
    }
    line = '';
  };
  let prevLineY = /** @type {number | null} */ (null);
  const endLine = () => {
    if (!line.trim()) { line = ''; return; }
    flush(prevLineY === null ? 0 : Math.abs(prevLineY - lineY));
    prevLineY = lineY;
    last = null;
  };
  for (const item of items) {
    // pdf.js marks the end of a line with an empty piece (its position says nothing).
    if (!item.str) {
      if (item.hasEOL) endLine();
      continue;
    }
    const x = item.transform?.[4] ?? 0;
    const y = item.transform?.[5] ?? 0;
    const size = Math.abs(item.transform?.[3] ?? 0) || item.height || 10;
    // Another height without an end-of-line mark: a new line all the same.
    if (last && Math.abs(y - last.y) > 0.5 * Math.max(size, last.size)) endLine();
    if (!line.trim()) { lineY = y; lineSize = size; }
    if (line && last && !/\s$/.test(line) && !/^\s/.test(item.str) && x - last.endX > 0.2 * size) line += ' ';
    line += item.str;
    last = { y, endX: x + (item.width ?? 0), size };
    if (item.hasEOL) endLine();
  }
  endLine();
  return lines.join('\n');
}

/**
 * @param {ArrayBuffer | Uint8Array} data  the PDF file
 * @returns {Promise<{ text: string, pages: number, cut: boolean }>}  cut: it had more pages than are read
 */
export async function pdfToText(data) {
  // @ts-ignore (a vendored bundle, no types)
  const pdfjs = await import('../vendor/pdf.mjs');
  // In an extension page pdf.js works in a Worker, from the packaged file (in Node, for the tests, it loads the
  // worker file next to it by itself).
  if (typeof Worker !== 'undefined' && typeof document !== 'undefined') {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.mjs', import.meta.url).href;
  }
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let doc;
  try {
    // No eval and no WebAssembly (an extension page allows neither); fonts and images aren't needed for text.
    doc = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, useWasm: false, useSystemFonts: false, disableFontFace: true, verbosity: 0 }).promise;
  } catch (err) {
    const name = /** @type {any} */ (err)?.name;
    if (name === 'PasswordException') throw new Error('This PDF is protected with a password. Save a copy without one, or paste the text.');
    throw new Error('This file could not be read as a PDF. Try another export of it, or paste the text.');
  }
  try {
    const pages = Math.min(doc.numPages, MAX_PDF_PAGES);
    /** @type {string[]} */
    const parts = [];
    for (let n = 1; n <= pages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      parts.push(itemsToText(content.items));
    }
    return { text: parts.filter(Boolean).join('\n\n').trim(), pages: doc.numPages, cut: doc.numPages > MAX_PDF_PAGES };
  } finally {
    await doc.destroy?.();
  }
}
