// Decides which found media the popup shows.

// The end of a playlist address without tokens, so the same playlist matches even when its tokens differ.
export function playlistKey(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter((p) => p && !p.includes('=') && !p.includes('~'));
    return parts.slice(-3).join('/');
  } catch {
    return url;
  }
}

const frame = (i) => i.frameId ?? 0;
// A master playlist with a size estimate is the most useful copy of a stream.
const rank = (i) => (i.master ? 2 : 0) + (i.size ? 1 : 0);

export function visibleItems(items) {
  // Hide the parts that a master playlist already lists.
  const children = new Set(items.filter((i) => i.master).flatMap((i) => (i.children || []).map(playlistKey)));
  const shown = items.filter((i) => i.kind !== 'hls' || i.master || !children.has(playlistKey(i.url)));

  // Players sometimes load the same stream twice, at another address or with new tokens.
  // Two streams of the same length in the same frame are one video, so keep the best copy.
  const same = (a, b) => a.kind === 'hls' && b.kind === 'hls' && frame(a) === frame(b) &&
    !a.live && !b.live && a.duration && b.duration && Math.abs(a.duration - b.duration) <= 1;
  return shown.filter((item, n) => !shown.some((other, m) => m !== n && same(item, other) &&
    (rank(other) > rank(item) || (rank(other) === rank(item) && m < n))));
}
