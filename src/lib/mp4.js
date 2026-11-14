// Joins a video-only and an audio-only fragmented MP4 (as made by mux.js) into one file with both tracks.
// Pure functions on Uint8Arrays, so it can be unit tested in Node.

function type(buf, at) {
  return String.fromCharCode(buf[at + 4], buf[at + 5], buf[at + 6], buf[at + 7]);
}

function view(buf) {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** Top-level boxes of buf as [{ type, start, end }]. */
export function boxes(buf, start = 0, end = buf.byteLength) {
  const dv = view(buf);
  const out = [];
  let at = start;
  while (at + 8 <= end) {
    let size = dv.getUint32(at);
    if (size === 1) size = Number(dv.getBigUint64(at + 8));
    else if (size === 0) size = end - at;
    if (size < 8 || at + size > end) throw new Error('Broken MP4 data.');
    out.push({ type: type(buf, at), start: at, end: at + size });
    at += size;
  }
  return out;
}

function children(buf, box) {
  return boxes(buf, box.start + 8, box.end);
}

function find(buf, list, path) {
  const [head, ...rest] = path;
  const box = list.find((b) => b.type === head);
  if (!box || !rest.length) return box;
  return find(buf, children(buf, box), rest);
}

function all(buf, list, path) {
  const [head, ...rest] = path;
  const hits = list.filter((b) => b.type === head);
  return rest.length ? hits.flatMap((b) => all(buf, children(buf, b), rest)) : hits;
}

function slice(buf, box) {
  return buf.slice(box.start, box.end);
}

function makeBox(name, ...parts) {
  const size = 8 + parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(size);
  view(out).setUint32(0, size);
  for (let i = 0; i < 4; i++) out[4 + i] = name.charCodeAt(i);
  let at = 8;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/** Sets the track id inside a copied trak, trex or moof box. */
function setTrackId(box, id) {
  const top = boxes(box)[0];
  const dv = view(box);
  if (top.type === 'trak') {
    const tkhd = find(box, children(box, top), ['tkhd']);
    const version = box[tkhd.start + 8];
    dv.setUint32(tkhd.start + 8 + (version === 1 ? 20 : 12), id);
  } else if (top.type === 'trex') {
    dv.setUint32(top.start + 12, id);
  } else if (top.type === 'moof') {
    for (const tfhd of all(box, children(box, top), ['traf', 'tfhd'])) dv.setUint32(tfhd.start + 12, id);
  }
  return box;
}

function setSequence(moof, n) {
  const mfhd = find(moof, children(moof, boxes(moof)[0]), ['mfhd']);
  view(moof).setUint32(mfhd.start + 12, n);
  return moof;
}

function parseInit(init) {
  const top = boxes(init);
  const moov = find(init, top, ['moov']);
  const inMoov = children(init, moov);
  return {
    ftyp: slice(init, find(init, top, ['ftyp'])),
    mvhd: slice(init, find(init, inMoov, ['mvhd'])),
    trak: slice(init, find(init, inMoov, ['trak'])),
    trex: slice(init, find(init, inMoov, ['mvex', 'trex'])),
  };
}

/** Splits a media segment (moof+mdat pairs) into [moof, mdat] pairs. */
function fragments(data) {
  const list = boxes(data);
  const out = [];
  for (let i = 0; i < list.length; i++) {
    if (list[i].type === 'moof' && list[i + 1]?.type === 'mdat') {
      // moof is copied because its track id and sequence are rewritten; mdat is only viewed, to save memory.
      out.push([slice(data, list[i]), data.subarray(list[i + 1].start, list[i + 1].end)]);
      i++;
    }
  }
  return out;
}

/**
 * videoInit/audioInit: ftyp+moov from mux.js. videoParts/audioParts: arrays of moof+mdat segments, in order.
 * Returns an array of Uint8Arrays that together form one MP4 with track 1 = video, track 2 = audio.
 */
export function combineTracks(videoInit, audioInit, videoParts, audioParts) {
  const v = parseInit(videoInit);
  const a = parseInit(audioInit);
  const mvhd = v.mvhd.slice();
  view(mvhd).setUint32(mvhd.byteLength - 4, 3); // next_track_ID (last field in both versions)
  const moov = makeBox(
    'moov',
    mvhd,
    setTrackId(v.trak.slice(), 1),
    setTrackId(a.trak.slice(), 2),
    makeBox('mvex', setTrackId(v.trex.slice(), 1), setTrackId(a.trex.slice(), 2)),
  );
  const vf = videoParts.flatMap(fragments);
  const af = audioParts.flatMap(fragments);
  const out = [v.ftyp, moov];
  let seq = 1;
  // Interleave by segment so players can start quickly.
  for (let i = 0; i < Math.max(vf.length, af.length); i++) {
    if (vf[i]) out.push(setSequence(setTrackId(vf[i][0], 1), seq++), vf[i][1]);
    if (af[i]) out.push(setSequence(setTrackId(af[i][0], 2), seq++), af[i][1]);
  }
  return out;
}
