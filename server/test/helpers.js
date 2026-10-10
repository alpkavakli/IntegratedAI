import { mkdtempSync } from 'node:fs';
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
