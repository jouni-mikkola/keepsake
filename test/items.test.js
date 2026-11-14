import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleItems, playlistKey } from '../src/lib/items.js';

const ids = (items) => visibleItems(items).map((i) => i.id);

test('hides playlists that a master lists, even with other tokens', () => {
  const items = [
    { id: 'm', kind: 'hls', master: true, url: 'https://cdn.example/v/1/master.m3u8', children: ['https://cdn.example/hdnts=a/v/1/1080/index.m3u8'] },
    { id: 'c', kind: 'hls', url: 'https://cdn.example/hdnts=b/v/1/1080/index.m3u8', duration: 77 },
  ];
  assert.deepEqual(ids(items), ['m']);
  assert.equal(playlistKey('https://x.example/a/b~c/d/e.m3u8'), 'a/d/e.m3u8');
});

test('shows one copy of a stream loaded twice', () => {
  const items = [
    { id: 'part', kind: 'hls', url: 'https://cdn.example/other/path/video.m3u8', duration: 77 },
    { id: 'master', kind: 'hls', master: true, children: [], url: 'https://cdn.example/a/master.m3u8', duration: 77, size: 50e6 },
    { id: 'again', kind: 'hls', master: true, children: [], url: 'https://cdn.example/a/master.m3u8?t=2', duration: 76 },
  ];
  assert.deepEqual(ids(items), ['master']);
});

test('keeps different videos and other frames', () => {
  const items = [
    { id: 'a', kind: 'hls', master: true, children: [], url: 'https://cdn.example/a.m3u8', duration: 77 },
    { id: 'b', kind: 'hls', master: true, children: [], url: 'https://cdn.example/b.m3u8', duration: 140 },
    { id: 'c', kind: 'hls', master: true, children: [], url: 'https://cdn.example/c.m3u8', duration: 77, frameId: 3 },
    { id: 'd', kind: 'file', url: 'https://cdn.example/d.mp4', duration: 77 },
    { id: 'e', kind: 'hls', master: true, children: [], url: 'https://cdn.example/e.m3u8', live: true },
    { id: 'f', kind: 'hls', master: true, children: [], url: 'https://cdn.example/f.m3u8', live: true },
  ];
  assert.deepEqual(ids(items), ['a', 'b', 'c', 'd', 'e', 'f']);
});
