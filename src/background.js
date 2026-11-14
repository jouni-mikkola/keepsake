// Keepsake service worker: notices media requests, keeps a per-tab list, and starts saves.
import { parsePlaylist } from './lib/hls.js';
import { buildFileName } from './lib/names.js';

const MAX_ITEMS_PER_TAB = 40;
const MIN_FILE_BYTES = 300 * 1024; // smaller files are placeholders and tracking pixels, not videos
const AD_URL = /(^|[/._-])(ads?|adserver|advert\w*|banners?|preroll|doubleclick|imasdk|vast)([/._-]|$)/i;
const tabKey = (tabId) => `tab:${tabId}`;

// ---------- small helpers ----------

// storage.session is only readable by extension pages (not content scripts) by default.
let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

async function getTab(tabId) {
  const key = tabKey(tabId);
  return (await chrome.storage.session.get(key))[key] || { items: [] };
}

function setTab(tabId, data) {
  return chrome.storage.session.set({ [tabKey(tabId)]: data });
}

function isHttp(url) {
  return /^https?:\/\//i.test(url);
}

function fromOurExtension(sender) {
  return sender.id === chrome.runtime.id && (sender.url || '').startsWith(chrome.runtime.getURL(''));
}

function header(headers, name) {
  return headers?.find((h) => h.name.toLowerCase() === name)?.value || '';
}

/** Full file size, also for 206 range responses where content-length is only the chunk. */
function totalSize(details) {
  const range = /\/(\d+)\s*$/.exec(header(details.responseHeaders, 'content-range'));
  return range ? Number(range[1]) : Number(header(details.responseHeaders, 'content-length')) || 0;
}

function fileExtension(url) {
  const m = /\.(mp4|webm|mov|m4v)$/i.exec(new URL(url).pathname);
  return m ? m[1].toLowerCase() : 'mp4';
}

function classify(details) {
  const url = new URL(details.url);
  const path = url.pathname.toLowerCase();
  const type = header(details.responseHeaders, 'content-type').toLowerCase();
  if (path.endsWith('.m3u8') || type.includes('mpegurl')) return 'hls';
  if (path.endsWith('.mpd') || type.includes('dash+xml')) return 'dash';
  if (details.type === 'media' && (type.startsWith('video/') || /\.(mp4|webm|mov|m4v)$/.test(path))) return 'file';
  return null;
}

// ---------- detection ----------

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0 || !isHttp(details.url)) return;
    if (details.type === 'main_frame') {
      serial(() => setTab(details.tabId, { pageUrl: details.url, items: [] })).then(() => updateBadge(details.tabId));
      return;
    }
    if (details.statusCode >= 400) return;
    const kind = classify(details);
    if (!kind) return;
    // For a playlist the response size is only the text, not the video.
    const size = kind === 'file' ? totalSize(details) : 0;
    if (kind === 'file' && size && size < MIN_FILE_BYTES) return;
    const item = { url: details.url, kind, size, frameId: details.frameId, ad: AD_URL.test(details.url) };
    serial(() => addItem(details.tabId, item)).catch(console.warn);
  },
  { urls: ['http://*/*', 'https://*/*'], types: ['main_frame', 'xmlhttprequest', 'media', 'other'] },
  ['responseHeaders'],
);

// Sites that change pages without reloading: earlier videos move under "Other media".
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  serial(async () => {
    const tab = await getTab(tabId);
    if (!tab.items.length || tab.pageUrl === changeInfo.url) return;
    tab.pageUrl = changeInfo.url;
    for (const item of tab.items) item.stale = item.other = true;
    await setTab(tabId, tab);
  }).then(() => updateBadge(tabId), console.warn);
});

async function addItem(tabId, item) {
  const tab = await getTab(tabId);
  if (tab.items.some((i) => i.url === item.url)) return;
  if (tab.items.length >= MAX_ITEMS_PER_TAB) tab.items.shift();
  item.id = crypto.randomUUID();
  item.found = Date.now();
  tab.items.push(item);
  await setTab(tabId, tab);
  if (item.kind === 'hls') probe(tabId, item.id, item.url);
  updateBadge(tabId);
}

async function readPlaylist(url) {
  const res = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > 5_000_000) throw new Error('Playlist too large');
  return parsePlaylist(text, res.url || url);
}

// Read the playlist once so the popup can show quality, length, size and whether saving is possible.
async function probe(tabId, itemId, url) {
  let info;
  try {
    const pl = await readPlaylist(url);
    if (pl.type === 'master') {
      const best = pl.variants[0];
      const audio = Object.values(pl.audioGroups).flat().map((a) => a.uri);
      info = {
        master: true,
        children: [...pl.variants.map((v) => v.uri), ...audio],
        width: best?.width || 0,
        height: best?.height || 0,
      };
      if (best) {
        const media = await readPlaylist(best.uri);
        if (media.type === 'media') {
          info.duration = Math.round(media.duration);
          info.drm = media.drm;
          info.live = media.live;
          info.size = best.bandwidth ? Math.round((best.bandwidth * media.duration) / 8) : 0;
          info.estimated = true;
        }
      }
    } else {
      info = { master: false, duration: Math.round(pl.duration), drm: pl.drm, live: pl.live };
    }
  } catch (err) {
    info = { error: String(err.message || err) };
  }
  await serial(async () => {
    const tab = await getTab(tabId);
    const item = tab.items.find((i) => i.id === itemId);
    if (!item) return;
    Object.assign(item, info);
    await setTab(tabId, tab);
  });
  updateBadge(tabId);
}

/** Items the user cares about: hide variant playlists that belong to a master playlist. */
function visibleItems(items) {
  const strip = (u) => u.split('?')[0];
  const children = new Set(items.filter((i) => i.master).flatMap((i) => i.children.flatMap((c) => [c, strip(c)])));
  return items.filter((i) => i.kind !== 'hls' || i.master || !(children.has(i.url) || children.has(strip(i.url))));
}

const isMain = (i) => i.kind !== 'dash' && !i.other;

async function updateBadge(tabId) {
  const tab = await getTab(tabId);
  if (tab.badge) return; // progress or done mark is showing
  const count = visibleItems(tab.items).filter(isMain).length;
  await chrome.action.setBadgeBackgroundColor({ tabId, color: '#3b6fe0' }).catch(() => {});
  await chrome.action.setBadgeText({ tabId, text: count ? String(count) : '' }).catch(() => {});
}

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(tabKey(tabId));
});

// ---------- offscreen document (needed for Blob URLs and WebCrypto-heavy work) ----------

async function ensureOffscreen() {
  const url = chrome.runtime.getURL('src/offscreen.html');
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
  if (existing.length) return;
  await chrome.offscreen.createDocument({
    url,
    reasons: ['BLOBS'],
    justification: 'Join video segments into one file and hand it to the downloads API.',
  });
}

async function setJob(id, patch) {
  return serial(async () => {
    const { jobs = {} } = await chrome.storage.session.get('jobs');
    const job = jobs[id];
    if (patch === null) delete jobs[id];
    else if (patch.tabId) jobs[id] = patch; // new job
    else if (!job) return null; // late message for a job that is already gone
    else if (patch.progress && (job.status === 'saving' || job.status === 'failed')) return null;
    else jobs[id] = { ...job, ...patch };
    await chrome.storage.session.set({ jobs });
    return jobs[id] || null;
  });
}

// ---------- saving ----------

async function startDownload(tabId, itemId) {
  const tab = await getTab(tabId);
  const visible = visibleItems(tab.items);
  const item = visible.find((i) => i.id === itemId);
  if (!item) throw new Error('That video is no longer listed. Reload the page.');
  const info = await chrome.tabs.get(tabId);
  const ext = item.kind === 'file' ? fileExtension(item.url) : 'mp4';
  const filename = buildFileName(item.title || info.title, info.url, ext);

  // No forced Save dialog: Chrome's own "Ask where to save" setting decides.
  if (item.kind === 'file') {
    await chrome.downloads.download({ url: item.url, filename });
    flashBadge(tabId, '✓');
    return { started: true };
  }
  if (item.kind !== 'hls') throw new Error('This stream type is not supported yet.');
  if (item.drm) throw new Error('This video is DRM protected and cannot be saved.');

  const jobId = crypto.randomUUID();
  await setJob(jobId, { tabId, itemId, filename, status: 'downloading', done: 0, total: 0 });
  await ensureOffscreen();
  chrome.runtime.sendMessage({ target: 'offscreen', type: 'hls', jobId, url: item.url, pageUrl: info.url });
  return { jobId };
}

async function finishJob(jobId, blobUrl) {
  const { jobs = {} } = await chrome.storage.session.get('jobs');
  const job = jobs[jobId];
  if (!job) return;
  try {
    await setJob(jobId, { status: 'saving' });
    const downloadId = await chrome.downloads.download({ url: blobUrl, filename: job.filename });
    await setJob(jobId, { downloadId });
    flashBadge(job.tabId, '✓');
    // A small blob can finish before we stored downloadId, so check once ourselves.
    const [state] = await chrome.downloads.search({ id: downloadId });
    if (state && state.state !== 'in_progress') {
      releaseBlob(jobId);
      await setJob(jobId, null);
    }
  } catch (err) {
    // Usually the user closed the Save dialog.
    releaseBlob(jobId);
    await setJob(jobId, null);
  }
}

// The badge shows download progress, then a short done or failed mark, then the video count again.
async function setBadgeMark(tabId, text) {
  await serial(async () => {
    const tab = await getTab(tabId);
    tab.badge = text;
    await setTab(tabId, tab);
  });
  if (text) await chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  else updateBadge(tabId);
}

function flashBadge(tabId, text) {
  setBadgeMark(tabId, text);
  setTimeout(() => setBadgeMark(tabId, ''), 4000);
}

function releaseBlob(jobId) {
  chrome.runtime.sendMessage({ target: 'offscreen', type: 'release', jobId }).catch(() => {});
}

chrome.downloads.onChanged.addListener(async (delta) => {
  if (!delta.state || delta.state.current === 'in_progress') return;
  const { jobs = {} } = await chrome.storage.session.get('jobs');
  const jobId = Object.keys(jobs).find((id) => jobs[id].downloadId === delta.id);
  if (!jobId) return;
  releaseBlob(jobId);
  await setJob(jobId, null);
});

async function saveArticle(tabId, mode) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['src/vendor/Readability.js'] });
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: extractArticle });
  if (!result?.content) throw new Error('Could not find an article on this page.');
  const id = crypto.randomUUID();
  await clearOldArticles();
  await chrome.storage.session.set({ [`article:${id}`]: { ...result, savedAt: Date.now() } });
  await chrome.tabs.create({ url: chrome.runtime.getURL(`src/reader.html?id=${id}&action=${mode}`), openerTabId: tabId });
}

async function clearOldArticles() {
  const all = await chrome.storage.session.get(null);
  const old = Object.entries(all)
    .filter(([k, v]) => k.startsWith('article:') && Date.now() - (v.savedAt || 0) > 60 * 60 * 1000)
    .map(([k]) => k);
  if (old.length) await chrome.storage.session.remove(old);
}

// Runs inside the page (isolated world). Must be self-contained.
function extractArticle() {
  /* global Readability */
  const meta = (sel) => document.querySelector(sel)?.getAttribute('content') || '';
  // Largest image in a srcset, so the saved copy doesn't get the small preview size.
  const largest = (srcset) => {
    let best = '';
    let bestW = 0;
    for (const part of (srcset || '').split(/,\s+/)) {
      const [url, size = '1x'] = part.trim().split(/\s+/);
      const w = parseFloat(size) * (size.endsWith('x') ? 1000 : 1);
      if (url && w > bestW) [best, bestW] = [url, w];
    }
    return best;
  };
  const live = [...document.images];
  const clone = document.cloneNode(true);
  clone.querySelectorAll('img').forEach((img, i) => {
    const sources = [img.getAttribute('srcset'), ...[...(img.closest('picture')?.querySelectorAll('source') || [])]
      .filter((s) => !/avif/.test(s.type || ''))
      .map((s) => s.getAttribute('srcset'))];
    const big = sources.map(largest).find(Boolean);
    const lazy = img.getAttribute('data-src') || img.getAttribute('data-lazy-src');
    const src = big || lazy || live[i]?.currentSrc || img.getAttribute('src');
    if (src) img.setAttribute('src', new URL(src, location.href).href);
    img.removeAttribute('srcset');
    img.removeAttribute('loading');
  });
  // Video players, ads, comments and "read next" boxes are not part of the article.
  clone
    .querySelectorAll('video, audio, [aria-label*="player" i], [class*="player" i], [class*="comment" i], [id*="comment" i], [class*="related" i], [class*="advert" i], [class*="ad-slot" i], ' +
        '[class*="teaser" i], [data-testid*="teaser" i], [class*="recommend" i], [class*="newsletter" i], [class*="share" i], ' +
        '[class*="article-tail" i], [data-testid="tags"], aside, nav, form')
    .forEach((n) => {
      // A broad class match must never take the headline and article text with it.
      if (!n.matches('html, body, main') && !n.querySelector('h1')) n.remove();
    });
  clone.querySelectorAll('div, span, p').forEach((n) => {
    if (/^(mainos|advertisement|annons|ad|anzeige)$/i.test(n.textContent.trim())) n.remove();
  });
  const article = new Readability(clone, { keepClasses: false }).parse();
  if (!article) return null;
  return {
    title: article.title || document.title,
    byline: article.byline || meta('meta[name="author"]') || meta('meta[property="article:author"]'),
    siteName: article.siteName || meta('meta[property="og:site_name"]') || location.hostname,
    published: article.publishedTime || meta('meta[property="article:published_time"]'),
    excerpt: article.excerpt || '',
    lang: document.documentElement.lang || article.lang || '',
    url: meta('meta[property="og:url"]') || location.href,
    image: leadImage(),
    content: article.content,
  };

  // The article's own picture from structured data, else og:image unless it is the site's default picture.
  function leadImage() {
    const generic = (u) => !u || /default|placeholder|logo/i.test(u);
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = [].concat(JSON.parse(s.textContent)).flatMap((d) => d['@graph'] || d);
        for (const d of data.filter((x) => /Article|Posting/.test([].concat(x['@type']).join(' ')))) {
          const first = [].concat(d.image || [])[0];
          const src = typeof first === 'string' ? first : first?.url;
          if (!generic(src)) return src;
        }
      } catch {}
    }
    const og = meta('meta[property="og:image"]');
    return generic(og) ? '' : og;
  }
}

// ---------- which video is which ----------

// Runs inside each frame of the page (isolated world). Must be self-contained.
function scanPage() {
  const meta = (sel) => document.querySelector(sel)?.getAttribute('content') || '';
  const generic = /^(video|videos|player|video player|videosoitin|soitin|media)$/i;
  let ld = null;
  const walk = (o) => {
    if (!o || typeof o !== 'object' || ld) return;
    if (Array.isArray(o)) return o.forEach(walk);
    if (o['@type'] === 'VideoObject') {
      const thumb = [].concat(o.thumbnailUrl || [])[0];
      ld = { name: String(o.name || ''), thumb: typeof thumb === 'string' ? thumb : thumb?.url || '' };
      return;
    }
    Object.values(o).forEach(walk);
  };
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      walk(JSON.parse(s.textContent));
    } catch {}
  }
  const label = (video) => {
    let node = video;
    for (let i = 0; i < 6 && node; i++, node = node.parentElement) {
      const own = (node.getAttribute('aria-label') || node.getAttribute('title') || '').trim();
      if (own.length > 3 && !generic.test(own)) return own;
      const caption = node.querySelector('figcaption')?.textContent.trim();
      if (caption) return caption;
    }
    return '';
  };
  const grab = (video) => {
    try {
      if (video.readyState < 2 || !video.videoWidth) return '';
      const scale = 200 / Math.max(video.videoWidth, video.videoHeight);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', 0.7);
    } catch {
      return ''; // cross-origin video, the canvas is tainted
    }
  };
  const videos = [...document.querySelectorAll('video')].map((v) => {
    const r = v.getBoundingClientRect();
    return {
      src: v.currentSrc || '',
      duration: Number.isFinite(v.duration) ? Math.round(v.duration) : 0,
      width: v.videoWidth,
      height: v.videoHeight,
      area: Math.round(r.width * r.height),
      playing: !v.paused,
      ad: v.muted && v.loop && !v.controls,
      title: label(v).slice(0, 200),
      thumb: v.poster || grab(v),
    };
  });
  return {
    videos,
    title: (ld?.name || meta('meta[property="og:title"]') || '').slice(0, 200),
    image: absolute(ld?.thumb || meta('meta[property="og:image"]')),
  };

  function absolute(url) {
    try {
      return url ? new URL(url, location.href).href : '';
    } catch {
      return '';
    }
  }
}

function safeImage(url) {
  if (/^data:image\/(jpeg|png|webp);base64,[a-z0-9+/=]+$/i.test(url) && url.length < 200_000) return url;
  return /^https?:\/\//i.test(url) && url.length < 2000 ? url : '';
}

/** Gives each listed item a title and thumbnail, and moves ads and extras into "other". */
async function scanTab(tabId) {
  const tab = await getTab(tabId);
  const frameIds = [...new Set(tab.items.map((i) => i.frameId ?? 0))];
  if (!frameIds.length) return;
  let results = [];
  try {
    results = await chrome.scripting.executeScript({ target: { tabId, frameIds }, func: scanPage });
  } catch {
    return; // page not scriptable; the list still works without titles
  }
  const top = results.find((r) => r.frameId === 0)?.result || results[0]?.result || {};
  const videos = results.flatMap((r) => (r.result?.videos || []).map((v) => ({ ...v, frameId: r.frameId })));

  const match = (item) => {
    if (item.kind === 'file') return videos.find((v) => v.src === item.url);
    const streams = videos.filter((v) => v.src.startsWith('blob:') && v.frameId === (item.frameId ?? 0));
    const fits = streams.filter((v) => {
      if (item.duration && v.duration && Math.abs(item.duration - v.duration) > 2) return false;
      if (item.width && v.width && item.width > item.height !== v.width > v.height) return false;
      return true;
    });
    return fits.sort((a, b) => b.playing - a.playing || b.area - a.area)[0];
  };

  await serial(async () => {
    const fresh = await getTab(tabId);
    for (const item of visibleItems(fresh.items)) {
      const v = match(item);
      item.title = v?.title || top.title || '';
      item.thumb = safeImage(v?.thumb || '') || safeImage(top.image || '');
      item.playing = Boolean(v?.playing);
      if (v?.width && !item.width) [item.width, item.height] = [v.width, v.height];
      if (v?.duration && !item.duration) item.duration = v.duration;
      item.other = item.stale || item.ad || Boolean(v?.ad) || (item.kind === 'file' && !v && !item.size);
    }
    // A clip of a few seconds next to a real video is a player intro or an ad, not the story.
    const main = visibleItems(fresh.items).filter((i) => !i.other);
    if (main.some((i) => i.duration >= 15)) {
      for (const i of main) if (i.duration && i.duration < 10) i.other = true;
    }
    await setTab(tabId, fresh);
  });
  updateBadge(tabId);
}

// ---------- messages ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!fromOurExtension(sender) || msg?.target === 'offscreen') return false;

  const handlers = {
    async list() {
      const tab = await getTab(msg.tabId);
      const { jobs = {} } = await chrome.storage.session.get('jobs');
      return { items: visibleItems(tab.items), jobs };
    },
    scan: () => scanTab(msg.tabId),
    download: () => startDownload(msg.tabId, msg.itemId),
    article: () => saveArticle(msg.tabId, ['png', 'ipdf'].includes(msg.mode) ? msg.mode : 'pdf'),
    async cancel() {
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'cancel', jobId: msg.jobId }).catch(() => {});
      await setJob(msg.jobId, null);
      if (msg.tabId) await setBadgeMark(msg.tabId, '');
    },
    // From the offscreen document:
    async progress() {
      const patch = { progress: true, done: msg.done, total: msg.total, status: msg.status || 'downloading' };
      if (msg.bytes) patch.bytes = msg.bytes;
      const job = await setJob(msg.jobId, patch);
      if (job && msg.total && job.status === 'downloading') setBadgeMark(job.tabId, `${Math.floor((msg.done / msg.total) * 100)}%`);
    },
    async failed() {
      await setJob(msg.jobId, { status: 'failed', error: msg.error });
      const { jobs = {} } = await chrome.storage.session.get('jobs');
      if (jobs[msg.jobId]) flashBadge(jobs[msg.jobId].tabId, '!');
    },
    finished: () => finishJob(msg.jobId, msg.blobUrl),
  };

  const handler = handlers[msg?.type];
  if (!handler) return false;
  Promise.resolve()
    .then(handler)
    .then((value) => sendResponse({ ok: true, value }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true;
});
