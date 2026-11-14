import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlaylist, ivFor, isDrmKey } from '../src/lib/hls.js';

const BASE = 'https://cdn.example.com/v/abc/index.m3u8';

test('master playlist: best variant first, URLs resolved', () => {
  const pl = parsePlaylist(
    `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360
360/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080
1080/index.m3u8?token=x`,
    BASE,
  );
  assert.equal(pl.type, 'master');
  assert.equal(pl.variants[0].height, 1080);
  assert.equal(pl.variants[0].uri, 'https://cdn.example.com/v/abc/1080/index.m3u8?token=x');
});

test('media playlist: segments, duration, VOD', () => {
  const pl = parsePlaylist(
    `#EXTM3U
#EXT-X-MEDIA-SEQUENCE:5
#EXTINF:4.0,
seg5.ts
#EXTINF:3.5,
/abs/seg6.ts
#EXT-X-ENDLIST`,
    BASE,
  );
  assert.equal(pl.type, 'media');
  assert.equal(pl.live, false);
  assert.equal(pl.duration, 7.5);
  assert.equal(pl.segments[1].uri, 'https://cdn.example.com/abs/seg6.ts');
  assert.equal(pl.segments[1].sequence, 6);
});

test('playlist without ENDLIST is live', () => {
  assert.equal(parsePlaylist('#EXTM3U\n#EXTINF:4,\na.ts', BASE).live, true);
});

test('DRM detection', () => {
  assert.equal(isDrmKey({ METHOD: 'NONE' }), false);
  assert.equal(isDrmKey({ METHOD: 'AES-128', URI: 'k' }), false);
  assert.equal(isDrmKey({ METHOD: 'SAMPLE-AES', KEYFORMAT: 'com.apple.streamingkeydelivery' }), true);
  assert.equal(isDrmKey({ METHOD: 'AES-128', KEYFORMAT: 'urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed' }), true);
  const pl = parsePlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x"\n#EXTINF:4,\na.ts\n#EXT-X-ENDLIST', BASE);
  assert.equal(pl.drm, true);
});

test('AES-128 key and IV', () => {
  const pl = parsePlaylist(
    '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:258\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:4,\na.ts\n#EXT-X-ENDLIST',
    BASE,
  );
  const seg = pl.segments[0];
  assert.equal(seg.key.uri, 'https://cdn.example.com/v/abc/key.bin');
  assert.deepEqual([...ivFor(seg).slice(14)], [1, 2]);
  assert.deepEqual([...ivFor({ key: { iv: '0x000102030405060708090a0b0c0d0e0f' } })], [...Array(16).keys()]);
});

test('rejects non-http segment URLs', () => {
  assert.throws(() => parsePlaylist('#EXTM3U\n#EXTINF:4,\njavascript:alert(1)\n#EXT-X-ENDLIST', BASE));
  assert.throws(() => parsePlaylist('#EXTM3U\n#EXTINF:4,\nfile:///etc/passwd\n#EXT-X-ENDLIST', BASE));
});

test('rejects non-playlists', () => {
  assert.throws(() => parsePlaylist('<html>', BASE));
});
