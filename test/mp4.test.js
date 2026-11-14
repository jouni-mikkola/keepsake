import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxes, combineTracks } from '../src/lib/mp4.js';

function box(type, ...parts) {
  const size = 8 + parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, size);
  out.set([...type].map((c) => c.charCodeAt(0)), 4);
  let at = 8;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
const u32 = (n) => new Uint8Array([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const fullbox = (...fields) => new Uint8Array([0, 0, 0, 0, ...fields.flatMap((f) => [...u32(f)])]);
const concat = (...arrs) => Uint8Array.from(arrs.flatMap((a) => [...a]));

function init(trackId) {
  const tkhd = box('tkhd', fullbox(0, 0, trackId, 0, 0));
  return concat(
    box('ftyp', new TextEncoder().encode('isom')),
    box('moov', box('mvhd', fullbox(0, 0, 1000, 0, 7)), box('trak', tkhd), box('mvex', box('trex', fullbox(trackId, 1, 0, 0, 0)))),
  );
}
const segment = (trackId, payload) =>
  concat(box('moof', box('mfhd', fullbox(0)), box('traf', box('tfhd', fullbox(trackId)))), box('mdat', new Uint8Array([payload])));

const readU32 = (buf, at) => new DataView(buf.buffer, buf.byteOffset).getUint32(at);

test('combines video and audio into one file with tracks 1 and 2', () => {
  const parts = combineTracks(init(481), init(0), [segment(481, 1), segment(481, 2)], [segment(0, 9)]);
  const file = concat(...parts);
  const top = boxes(file).map((b) => b.type);
  assert.deepEqual(top, ['ftyp', 'moov', 'moof', 'mdat', 'moof', 'mdat', 'moof', 'mdat']);

  const moov = boxes(file)[1];
  const inMoov = boxes(file, moov.start + 8, moov.end);
  assert.deepEqual(inMoov.map((b) => b.type), ['mvhd', 'trak', 'trak', 'mvex']);
  const trackIds = inMoov.filter((b) => b.type === 'trak').map((b) => readU32(file, b.start + 8 + 8 + 12));
  assert.deepEqual(trackIds, [1, 2]);
  assert.equal(readU32(file, inMoov[0].end - 4), 3, 'next_track_ID');

  // Fragments: video 1, audio, video 2, with increasing sequence numbers.
  const moofs = boxes(file).filter((b) => b.type === 'moof');
  const ids = moofs.map((m) => readU32(file, m.start + 8 + 16 + 8 + 12));
  const seqs = moofs.map((m) => readU32(file, m.start + 8 + 12));
  assert.deepEqual(ids, [1, 2, 1]);
  assert.deepEqual(seqs, [1, 2, 3]);
});

test('rejects broken boxes', () => {
  assert.throws(() => boxes(new Uint8Array([0, 0, 0, 99, 109, 111, 111, 118])));
});
