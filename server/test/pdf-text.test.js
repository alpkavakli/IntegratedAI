import { test } from 'node:test';
import assert from 'node:assert/strict';
import { itemsToText, pdfToText } from '../../extension/shared/pdf-text.js';
import { makePdf } from './helpers.js';

test('pdf text: pieces become lines; a gap on a line a space; a big gap an empty line', () => {
  const at = (str, x, y, width, hasEOL = false, size = 10) => ({ str, transform: [size, 0, 0, size, x, y], width, hasEOL });
  const text = itemsToText([
    at('Alp', 72, 700, 20), at('Kavaklı', 95, 700, 40, true),          // a gap between two pieces: a space
    at('Software ', 72, 686, 45), at('Engineer', 117, 686, 40),         // already a space: not doubled; no EOL mark…
    at('Experience', 72, 640, 60, true),                                 // …but a new height: a new line, after a big gap
    at('Built a credit', 72, 626, 70), at('-scoring app', 142, 626, 60, true), // touching pieces: joined as they are
  ]);
  assert.equal(text, 'Alp Kavaklı\nSoftware Engineer\n\nExperience\nBuilt a credit-scoring app');
});

test('pdf text: a real PDF is read with the packaged pdf.js (lines, a section break)', async () => {
  const pdf = makePdf([
    ['Alp Kavakli', 18],
    ['Software Engineer (Java, Spring Boot)', 12],
    ['§Experience', 14],
    ['Built a full-stack credit-scoring app', 11],
  ]);
  const { text, pages, cut } = await pdfToText(pdf);
  assert.equal(pages, 1);
  assert.equal(cut, false);
  assert.equal(text, 'Alp Kavakli\nSoftware Engineer (Java, Spring Boot)\n\nExperience\nBuilt a full-stack credit-scoring app');
});

test('pdf text: something that is not a PDF gives a message a person can act on', async () => {
  await assert.rejects(pdfToText(new TextEncoder().encode('just some text, not a pdf')), /could not be read as a PDF/);
});
