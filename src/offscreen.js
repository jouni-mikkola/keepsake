// Offscreen document: downloads HLS segments, decrypts AES-128, turns MPEG-TS into MP4, makes a Blob URL.
/* global muxjs */
import { parsePlaylist, ivFor } from './lib/hls.js';
import { combineTracks } from './lib/mp4.js';

const CONCURRENCY = 6;
const MAX_SEGMENTS = 20000;
const MAX_BYTES = 4 * 1024 ** 3; // 4 GB safety limit against runaway playlists
const jobs = new Map(); // jobId -> { controller, blobUrl }

function send(msg) {
  return chrome.runtime.sendMessage(msg).catch(() => {});
}

async function get(url, signal, as = 'bytes') {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const credentials of ['same-origin', 'include']) {
      try {
        const res = await fetch(url, { credentials, signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) });
        if (res.status === 401 || res.status === 403) {
          lastError = new Error(`Access denied (HTTP ${res.status})`);
          continue; // try again with cookies
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return as === 'text' ? { text: await res.text(), url: res.url || url } : new Uint8Array(await res.arrayBuffer());
      } catch (err) {
        if (signal.aborted) throw new Error('Cancelled');
        lastError = err;
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  throw lastError;
}

async function loadMedia(url, signal) {
  const res = await get(url, signal, 'text');
  const pl = parsePlaylist(res.text, res.url);
  if (pl.type !== 'media') throw new Error('Unexpected nested master playlist.');
  return checkMedia(pl);
}

/** Returns { video, audio } media playlists; audio is null when the sound is inside the video segments. */
async function loadPlaylists(url, signal) {
  const first = await get(url, signal, 'text');
  const pl = parsePlaylist(first.text, first.url);
  if (pl.type === 'media') return { video: checkMedia(pl), audio: null };
  const best = pl.variants[0];
  if (!best) throw new Error('The playlist has no video streams.');
  const group = best.audio ? pl.audioGroups[best.audio] : null;
  const audioUri = group?.length ? (group.find((g) => g.default) || group[0]).uri : null;
  const [video, audio] = await Promise.all([loadMedia(best.uri, signal), audioUri ? loadMedia(audioUri, signal) : null]);
  return { video, audio };
}

function checkMedia(pl) {
  if (pl.drm) throw new Error('This video is DRM protected and cannot be saved.');
  if (pl.live) throw new Error('This is a live stream. Only finished videos can be saved.');
  if (!pl.segments.length) throw new Error('The playlist is empty.');
  if (pl.segments.length > MAX_SEGMENTS) throw new Error('The video is too long.');
  if (pl.map?.byterange) throw new Error('Byte-range init segments are not supported yet.');
  return pl;
}

async function decryptor(signal) {
  const keys = new Map();
  return async (segment, data) => {
    if (!segment.key) return data;
    if (!keys.has(segment.key.uri)) {
      keys.set(
        segment.key.uri,
        get(segment.key.uri, signal).then((raw) => {
          if (raw.byteLength !== 16) throw new Error('Invalid AES-128 key.');
          return crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt']);
        }),
      );
    }
    const key = await keys.get(segment.key.uri);
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivFor(segment) }, key, data));
  };
}

/** Downloads the segments of all playlists, CONCURRENCY at a time, keeping their order. */
async function downloadSegments(playlists, jobId, signal) {
  const decrypt = await decryptor(signal);
  const tasks = playlists.flatMap((pl, p) => pl.segments.map((seg, i) => ({ seg, p, i })));
  const out = playlists.map((pl) => new Array(pl.segments.length));
  let next = 0;
  let done = 0;
  let bytes = 0;
  let lastReport = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const { seg, p, i } = tasks[next++];
      const data = await decrypt(seg, await get(seg.uri, signal));
      out[p][i] = data;
      bytes += data.byteLength;
      if (bytes > MAX_BYTES) throw new Error('The video is too large.');
      done++;
      if (Date.now() - lastReport > 300 || done === tasks.length) {
        lastReport = Date.now();
        send({ type: 'progress', jobId, done, total: tasks.length });
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return out;
}

/** MPEG-TS or packed AAC -> { init, parts } fragmented MP4. `only` keeps one track type ('video'/'audio'). */
function transmux(segments, only = null) {
  let init = null;
  const parts = [];
  const transmuxer = new muxjs.mp4.Transmuxer({ remux: !only });
  transmuxer.on('data', (seg) => {
    if (only && seg.type !== only) return;
    init ||= new Uint8Array(seg.initSegment);
    parts.push(new Uint8Array(seg.data));
  });
  for (const data of segments) {
    transmuxer.push(data);
    transmuxer.flush();
  }
  if (!init) throw new Error('Could not read the video segments.');
  return { init, parts };
}

const isTs = (b) => b[0] === 0x47;
const isPackedAudio = (b) => (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) || (b[0] === 0xff && (b[1] & 0xf0) === 0xf0);

/** One playlist's segments -> { init, parts }. */
async function toFmp4(pl, segments, only, signal) {
  if (pl.map) return { init: await get(pl.map.uri, signal), parts: segments };
  if (isTs(segments[0]) || isPackedAudio(segments[0])) return transmux(segments, only);
  throw new Error('Unsupported segment format.');
}

async function runHls({ jobId, url }) {
  const controller = new AbortController();
  jobs.set(jobId, { controller });
  try {
    const { video, audio } = await loadPlaylists(url, controller.signal);
    const playlists = audio ? [video, audio] : [video];
    const total = playlists.reduce((n, pl) => n + pl.segments.length, 0);
    send({ type: 'progress', jobId, done: 0, total });
    const [videoSegs, audioSegs] = await downloadSegments(playlists, jobId, controller.signal);
    send({ type: 'progress', jobId, done: total, total, status: 'converting' });
    let parts;
    if (audio) {
      const v = await toFmp4(video, videoSegs, 'video', controller.signal);
      const a = await toFmp4(audio, audioSegs, 'audio', controller.signal);
      parts = combineTracks(v.init, a.init, v.parts, a.parts);
    } else {
      const v = await toFmp4(video, videoSegs, null, controller.signal);
      parts = [v.init, ...v.parts];
    }
    if (controller.signal.aborted) return;
    const blobUrl = URL.createObjectURL(new Blob(parts, { type: 'video/mp4' }));
    jobs.set(jobId, { controller, blobUrl });
    send({ type: 'finished', jobId, blobUrl });
  } catch (err) {
    jobs.delete(jobId);
    if (!controller.signal.aborted) send({ type: 'failed', jobId, error: String(err?.message || err) });
  }
}

function release(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.controller.abort();
  if (job.blobUrl) URL.revokeObjectURL(job.blobUrl);
  jobs.delete(jobId);
  if (!jobs.size) setTimeout(() => !jobs.size && window.close(), 1000);
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (sender.id !== chrome.runtime.id || msg?.target !== 'offscreen') return;
  if (msg.type === 'hls') runHls(msg);
  if (msg.type === 'cancel' || msg.type === 'release') release(msg.jobId);
});
