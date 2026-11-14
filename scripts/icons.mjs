// Draws the Keepsake icon (white bookmark with a down arrow on a green rounded square) as PNGs.
// No dependencies: a tiny rasterizer with 4x4 supersampling and a hand-written PNG encoder.
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';

const GREEN = [47, 111, 79];
const WHITE = [255, 255, 255];

function inRoundedSquare(x, y, r) {
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

// Bookmark ribbon: rectangle with a V notch at the bottom.
function inBookmark(x, y) {
  if (x < 0.3 || x > 0.7 || y < 0.18 || y > 0.84) return false;
  const notch = 0.68 + Math.abs(x - 0.5) * 0.8; // bottom edge rises towards the centre
  return y <= notch;
}

// Down arrow cut out of the bookmark.
function inArrow(x, y) {
  const shaft = Math.abs(x - 0.5) <= 0.045 && y >= 0.28 && y <= 0.5;
  const head = y >= 0.44 && y <= 0.6 && Math.abs(x - 0.5) <= (0.6 - y) * 0.9;
  return shaft || head;
}

function colorAt(x, y) {
  if (!inRoundedSquare(x, y, 0.2)) return null;
  if (inBookmark(x, y) && !inArrow(x, y)) return WHITE;
  return GREEN;
}

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const ss = 4;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = colorAt((i + (sx + 0.5) / ss) / size, (j + (sy + 0.5) / ss) / size);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
        }
      }
      const o = (j * size + i) * 4;
      if (a) { px[o] = r / a; px[o + 1] = g / a; px[o + 2] = b / a; }
      px[o + 3] = Math.round((a / (ss * ss)) * 255);
    }
  }
  return px;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync('icons', { recursive: true });
for (const size of [16, 32, 48, 128]) writeFileSync(`icons/${size}.png`, png(size, render(size)));
console.log('icons written');
