// Minimal HLS playlist parser. Pure functions, no browser APIs, so it can be unit tested in Node.

const ATTR_RE = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;

export function parseAttributes(text) {
  const attrs = {};
  for (const [, key, raw] of text.matchAll(ATTR_RE)) {
    attrs[key] = raw.startsWith('"') ? raw.slice(1, -1) : raw;
  }
  return attrs;
}

function resolve(uri, base) {
  const url = new URL(uri, base);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Unsupported URL scheme: ${url.protocol}`);
  }
  return url.href;
}

// Key formats that mean the stream is protected with DRM and cannot be saved.
const DRM_KEY_FORMATS = ['com.apple.streamingkeydelivery', 'com.widevine', 'com.microsoft.playready', 'urn:uuid:'];

export function isDrmKey(attrs) {
  const method = (attrs.METHOD || 'NONE').toUpperCase();
  if (method === 'NONE') return false;
  if (method !== 'AES-128') return true; // SAMPLE-AES, SAMPLE-AES-CTR, ...
  const format = (attrs.KEYFORMAT || 'identity').toLowerCase();
  return format !== 'identity' && DRM_KEY_FORMATS.some((f) => format.startsWith(f));
}

/**
 * Parses an HLS playlist.
 * Returns { type: 'master', variants, audioGroups } or
 *         { type: 'media', segments, map, duration, drm, live }.
 */
export function parsePlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines[0] !== '#EXTM3U') throw new Error('Not an HLS playlist');

  if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) {
    const variants = [];
    const audioGroups = {};
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('#EXT-X-MEDIA:')) {
        const a = parseAttributes(line.slice(13));
        if (a.TYPE === 'AUDIO' && a.URI) {
          (audioGroups[a['GROUP-ID']] ||= []).push({ uri: resolve(a.URI, baseUrl), name: a.NAME, default: a.DEFAULT === 'YES' });
        }
      } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
        const a = parseAttributes(line.slice(18));
        const uri = lines[i + 1];
        if (!uri || uri.startsWith('#')) continue;
        const [w, h] = (a.RESOLUTION || '').split('x').map(Number);
        variants.push({
          uri: resolve(uri, baseUrl),
          bandwidth: Number(a.BANDWIDTH) || 0,
          width: w || 0,
          height: h || 0,
          audio: a.AUDIO || null,
        });
        i++;
      }
    }
    variants.sort((x, y) => y.height - x.height || y.bandwidth - x.bandwidth);
    return { type: 'master', variants, audioGroups };
  }

  const segments = [];
  let map = null;
  let key = null;
  let drm = false;
  let duration = 0;
  let segDuration = 0;
  let sequence = 0;
  let live = true;
  for (const line of lines) {
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      sequence = Number(line.slice(22)) || 0;
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const a = parseAttributes(line.slice(11));
      if (isDrmKey(a)) drm = true;
      key = (a.METHOD || 'NONE').toUpperCase() === 'AES-128' && a.URI ? { uri: resolve(a.URI, baseUrl), iv: a.IV || null } : null;
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = parseAttributes(line.slice(11));
      if (a.URI) map = { uri: resolve(a.URI, baseUrl), byterange: a.BYTERANGE || null };
    } else if (line.startsWith('#EXTINF:')) {
      segDuration = parseFloat(line.slice(8)) || 0;
    } else if (line === '#EXT-X-ENDLIST' || line === '#EXT-X-PLAYLIST-TYPE:VOD') {
      live = false;
    } else if (line.startsWith('#EXT-X-BYTERANGE')) {
      throw new Error('Byte-range playlists are not supported yet');
    } else if (!line.startsWith('#')) {
      segments.push({ uri: resolve(line, baseUrl), duration: segDuration, sequence, key });
      duration += segDuration;
      sequence++;
    }
  }
  return { type: 'media', segments, map, duration, drm, live };
}

/** AES-128 IV: explicit hex IV or the segment's media sequence number (RFC 8216 5.2). */
export function ivFor(segment) {
  const iv = new Uint8Array(16);
  if (segment.key?.iv) {
    const hex = segment.key.iv.replace(/^0x/i, '').padStart(32, '0');
    for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  } else {
    let n = segment.sequence;
    for (let i = 15; i >= 12 && n > 0; i--) {
      iv[i] = n & 0xff;
      n = Math.floor(n / 256);
    }
  }
  return iv;
}
