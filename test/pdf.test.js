import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imagePdf, pageBreak, PHONE } from '../src/lib/pdf.js';

const text = (bytes) => new TextDecoder('latin1').decode(bytes);

test('writes a PDF with one page per picture and a valid xref', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
  const pdf = imagePdf([{ jpeg, width: 700, height: 990 }, { jpeg, width: 700, height: 990 }], { title: 'Hello: world' });
  const s = text(pdf);
  assert.ok(s.startsWith('%PDF-1.4'));
  assert.ok(s.trimEnd().endsWith('%%EOF'));
  assert.match(s, /\/Count 2 /);
  const xref = Number(s.match(/startxref\n(\d+)/)[1]);
  assert.equal(s.slice(xref, xref + 4), 'xref');
  const offsets = [...s.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  assert.equal(offsets.length, 9);
  offsets.forEach((o, i) => assert.equal(s.slice(o, o + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`));
});

test('uses the requested page size', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const s = text(imagePdf([{ jpeg, width: 720, height: 1280 }], { size: PHONE }));
  assert.match(s, /\/MediaBox \[0 0 360 640\]/);
  assert.match(s, /q 360\.00 0 0 640\.00 0 0\.00 cm/);
});

test('breaks pages on a blank row near the wanted end', () => {
  const blank = new Set([90, 120]);
  assert.equal(pageBreak(0, 100, 500, (y) => blank.has(y)), 90);
  assert.equal(pageBreak(0, 100, 500, () => false), 100);
  assert.equal(pageBreak(0, 600, 500, () => false), 500);
});
