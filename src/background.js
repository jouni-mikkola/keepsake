// Keepsake service worker: notices media requests, keeps a per-tab list, and starts saves.
import { parsePlaylist } from './lib/hls.js';
import { buildFileName } from './lib/names.js';

const MAX_ITEMS_PER_TAB = 40;
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
    const size = Number(header(details.responseHeaders, 'content-length')) || 0;
    serial(() => addItem(details.tabId, { url: details.url, kind, size })).catch(console.warn);
  },
  { urls: ['http://*/*', 'https://*/*'], types: ['main_frame', 'xmlhttprequest', 'media', 'other'] },
  ['responseHeaders'],
);

async function addItem(tabId, item) {
  const tab = await getTab(tabId);
  if (tab.items.some((i) => i.url === item.url) || tab.items.length >= MAX_ITEMS_PER_TAB) return;
  item.id = crypto.randomUUID();
  item.found = Date.now();
  tab.items.push(item);
  await setTab(tabId, tab);
  if (item.kind === 'hls') probe(tabId, item.id, item.url);
  updateBadge(tabId);
}

// Read the playlist once so the popup can show quality, length and whether saving is possible.
async function probe(tabId, itemId, url) {
  let info;
  try {
    const res = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > 5_000_000) throw new Error('Playlist too large');
    const pl = parsePlaylist(text, res.url || url);
    if (pl.type === 'master') {
      const best = pl.variants[0];
      info = {
        master: true,
        children: pl.variants.map((v) => v.uri),
        height: best?.height || 0,
      };
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

async function updateBadge(tabId) {
  const tab = await getTab(tabId);
  const count = visibleItems(tab.items).filter((i) => i.kind !== 'dash').length;
  await chrome.action.setBadgeBackgroundColor({ tabId, color: '#2f6f4f' }).catch(() => {});
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
    if (patch === null) delete jobs[id];
    else if (jobs[id] || patch.status === 'downloading') jobs[id] = { ...jobs[id], ...patch };
    await chrome.storage.session.set({ jobs });
  });
}

// ---------- saving ----------

async function startDownload(tabId, itemId) {
  const tab = await getTab(tabId);
  const visible = visibleItems(tab.items);
  const item = visible.find((i) => i.id === itemId);
  if (!item) throw new Error('That video is no longer listed. Reload the page.');
  const info = await chrome.tabs.get(tabId);
  const index = visible.filter((i) => i.kind !== 'dash').indexOf(item);
  const filename = buildFileName(info.title, info.url, 'mp4', Math.max(0, index));

  if (item.kind === 'file') {
    await chrome.downloads.download({ url: item.url, filename, saveAs: true });
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
    const downloadId = await chrome.downloads.download({ url: blobUrl, filename: job.filename, saveAs: true });
    await setJob(jobId, { downloadId });
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
  const clone = document.cloneNode(true);
  // Use real image URLs for lazy-loaded images before Readability runs.
  clone.querySelectorAll('img').forEach((img) => {
    const lazy = img.getAttribute('data-src') || img.getAttribute('data-lazy-src');
    if (lazy && !img.getAttribute('src')) img.setAttribute('src', lazy);
    img.removeAttribute('loading');
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
    content: article.content,
  };
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
    download: () => startDownload(msg.tabId, msg.itemId),
    article: () => saveArticle(msg.tabId, msg.mode === 'png' ? 'png' : 'pdf'),
    async cancel() {
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'cancel', jobId: msg.jobId }).catch(() => {});
      await setJob(msg.jobId, null);
    },
    // From the offscreen document:
    progress: () => setJob(msg.jobId, { done: msg.done, total: msg.total, status: msg.status || 'downloading' }),
    failed: () => setJob(msg.jobId, { status: 'failed', error: msg.error }),
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
