// Packs the extension into dist/keepsake-<version>.zip (for the Chrome Web Store or a GitHub release).
// Only the files the extension needs are included. No dependencies.
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync, crc32 } from 'node:zlib';

const INCLUDE = ['manifest.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'icons', 'src'];

function walk(path) {
  return statSync(path).isDirectory() ? readdirSync(path).sort().flatMap((n) => walk(join(path, n))) : [path];
}

const files = INCLUDE.flatMap(walk);
const local = [];
const central = [];
let offset = 0;
for (const name of files) {
  const data = readFileSync(name);
  const packed = deflateRawSync(data, { level: 9 });
  const nameBuf = Buffer.from(name.replaceAll('\\', '/'));
  const crc = crc32(data);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4); // version needed
  header.writeUInt16LE(0x0800, 6); // UTF-8 names
  header.writeUInt16LE(8, 8); // deflate
  header.writeUInt32LE(0x00210000, 10); // fixed time/date (1980-01-01) for reproducible zips
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(packed.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(nameBuf.length, 26);
  local.push(header, nameBuf, packed);

  const entry = Buffer.alloc(46);
  entry.writeUInt32LE(0x02014b50, 0);
  entry.writeUInt16LE(20, 4);
  entry.writeUInt16LE(20, 6);
  entry.writeUInt16LE(0x0800, 8);
  entry.writeUInt16LE(8, 10);
  entry.writeUInt32LE(0x00210000, 12);
  entry.writeUInt32LE(crc, 16);
  entry.writeUInt32LE(packed.length, 20);
  entry.writeUInt32LE(data.length, 24);
  entry.writeUInt16LE(nameBuf.length, 28);
  entry.writeUInt32LE(offset, 42);
  central.push(entry, nameBuf);
  offset += header.length + nameBuf.length + packed.length;
}
const centralBuf = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralBuf.length, 12);
end.writeUInt32LE(offset, 16);

const { version } = JSON.parse(readFileSync('manifest.json', 'utf8'));
mkdirSync('dist', { recursive: true });
const out = `dist/keepsake-${version}.zip`;
writeFileSync(out, Buffer.concat([...local, centralBuf, end]));
console.log(`${out} (${files.length} files)`);
