// Clean reading view of a saved article, with "Save as PDF" (print dialog) and "Save as image".
/* global DOMPurify */
import { buildFileName } from './lib/names.js';
import { A4, PHONE, imagePdf, pageBreak } from './lib/pdf.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const key = `article:${params.get('id')}`;
const article = (await chrome.storage.session.get(key))[key];

function status(text) {
  $('status').textContent = text;
}

// Light or dark follows the system until the user picks one. The PDF and image use the same look.
const { readerTheme } = await chrome.storage.local.get('readerTheme');
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('theme').textContent = theme === 'dark' ? 'Light' : 'Dark';
}
applyTheme(readerTheme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
$('theme').onclick = () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  chrome.storage.local.set({ readerTheme: next });
};

if (!article) {
  status('This article is no longer available. Open the page and save it again.');
  $('pdf').disabled = $('ipdf').disabled = $('phone').disabled = $('png').disabled = $('theme').disabled = true;
  throw new Error('missing article');
}
chrome.storage.session.remove(key);

// The article HTML comes from a web page, so it is untrusted: sanitize it and never run scripts.
const clean = DOMPurify.sanitize(article.content, {
  FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed', 'svg', 'math', 'link', 'meta', 'base'],
  FORBID_ATTR: ['style', 'srcset', 'sizes'],
  ALLOW_DATA_ATTR: false,
  RETURN_DOM_FRAGMENT: true,
});
const safeUrl = (u) => {
  try {
    const url = new URL(u, article.url);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
};
clean.querySelectorAll('a').forEach((a) => {
  const href = safeUrl(a.getAttribute('href'));
  if (href) a.href = href;
  else a.removeAttribute('href');
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
});
clean.querySelectorAll('img').forEach((img) => {
  const src = safeUrl(img.getAttribute('src'));
  if (src) img.src = src;
  else img.remove();
  img.referrerPolicy = 'no-referrer';
  img.loading = 'eager';
});
// A video's caption has nothing left to describe once the video is gone.
clean.querySelectorAll('figure').forEach((f) => f.querySelector('img, blockquote, table, pre, ul, ol') || f.remove());
clean.querySelectorAll('video, audio, source, picture > source').forEach((n) => n.remove());

// The headline, author and time are shown above the text already, so drop their copies from the body.
// Short section labels are dropped only before the first real paragraph.
let intro = true;
const repeats = new Set([article.title, article.byline, article.siteName].filter(Boolean).map((s) => s.trim().toLowerCase()));
for (const node of [...clean.querySelectorAll('h1, h2, p, span, a, time, div')]) {
  const text = node.textContent.trim();
  if (text.length > 80 && node.matches('p')) intro = false;
  if (text.length > 60 || node.querySelector('img') || !clean.contains(node)) continue; // skip text, pictures and removed parts
  // A word inside a sentence ("HS tarjoaa…") is part of the text, not a label.
  const block = node.parentElement?.closest('p, li, h2, h3, blockquote, figcaption');
  if (block && block.textContent.trim() !== text) continue;
  const lower = text.toLowerCase();
  const shortLabel = intro && text.length < 25 && !/[.!?:]$/.test(text) && !text.includes(' ', text.indexOf(' ') + 1) && !node.querySelector('*');
  const bylineLine = intro && article.byline && lower.startsWith(article.byline.trim().toLowerCase());
  if (!text || repeats.has(lower) || bylineLine || node.matches('time') || /^\d{1,2}\.\d{1,2}\.(\d{2,4})?\s+\d{1,2}[:.]\d{2}$/.test(text) || shortLabel) {
    (node.parentElement?.textContent.trim() === text && node.parentElement !== clean ? node.parentElement : node).remove();
  }
}

// Articles whose main picture is a video player, or whose top picture sits outside the article text,
// get the page's preview image on top, unless the text already starts with that picture.
const pictureKey = (u) => {
  try {
    const parts = new URL(u).pathname.split('/').filter((p) => p.length >= 12);
    return parts.length ? parts : [new URL(u).pathname];
  } catch {
    return [];
  }
};
const samePicture = (a, b) => pictureKey(a).some((p) => pictureKey(b).includes(p));
const firstBlock = [...clean.querySelectorAll('p, h2, h3, figure, img, ul, ol, blockquote')][0];
const startsWithPicture = firstBlock && (firstBlock.matches('img') || firstBlock.querySelector?.('img'));
const lead =
  article.image &&
  !startsWithPicture &&
  ![...clean.querySelectorAll('img')].some((i) => samePicture(i.src, article.image)) &&
  safeUrl(article.image);
if (lead) {
  const img = Object.assign(document.createElement('img'), { src: lead, alt: '', referrerPolicy: 'no-referrer', loading: 'eager' });
  img.onerror = () => img.parentElement?.remove();
  clean.prepend(Object.assign(document.createElement('figure'), { className: 'lead' }));
  clean.firstChild.append(img);
}

// Chrome uses the page title as the suggested PDF file name.
document.title = buildFileName(article.title, article.url, 'pdf').replace(/\.pdf$/, '');
document.documentElement.lang = article.lang || 'en';
$('site').textContent = article.siteName || '';
$('title').textContent = article.title;
const date = article.published ? new Date(article.published) : null;
$('byline').textContent = [article.byline, date && !isNaN(date) ? date.toLocaleDateString() : ''].filter(Boolean).join(' · ');
if (article.preview) {
  $('content').append(Object.assign(document.createElement('p'), { className: 'notice', textContent: 'Preview only. The full article is for subscribers.' }));
}
$('content').append(clean);
$('source').textContent = `Source: ${article.url} · Saved ${new Date(article.savedAt).toLocaleString()} · For personal use.`;

// Wait for images so they are in the PDF / image.
async function imagesReady() {
  const imgs = [...document.images].filter((i) => !i.complete);
  await Promise.race([
    Promise.all(
      imgs.map((i) => new Promise((r) => {
        i.addEventListener('load', r, { once: true });
        i.addEventListener('error', r, { once: true });
      })),
    ),
    new Promise((r) => setTimeout(r, 10000)),
  ]);
}

/** Broken pictures, placeholders and tiny icons leave empty boxes, so take them out. */
function dropBrokenImages() {
  for (const img of [...$('content').querySelectorAll('img')]) {
    if (!img.complete) continue;
    if (img.naturalWidth >= 100 && img.naturalHeight >= 40) continue;
    const figure = img.closest('figure');
    img.remove();
    if (figure && !figure.querySelector('img, blockquote, table, pre, ul, ol')) figure.remove();
  }
}

function savePdf() {
  status('In the print dialog choose "Save as PDF" and Colour. If photos come out grey, use Image PDF.');
  window.print();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_IMAGE_HEIGHT = 16000; // device pixels; larger canvases fail in Chrome

async function capturePart(y) {
  window.scrollTo(0, y);
  await sleep(600); // captureVisibleTab is limited to about 2 calls per second
  const dataUrl = await chrome.tabs.captureVisibleTab({ format: 'png' });
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  return { bitmap, y: window.scrollY };
}

/** Screenshots the whole reader view. Returns a function that draws any part of the article column. */
async function captureArticle({ sharp = false, phone = false } = {}) {
  await imagesReady();
  document.body.classList.add('capturing');
  document.body.classList.toggle('phone', phone);
  // For the PDF, enlarge the article while capturing so text stays sharp when zoomed in.
  if (sharp) {
    const fit = Math.floor(((document.documentElement.clientWidth - 8) / $('doc').offsetWidth) * 10) / 10;
    if (fit > 1) $('doc').style.zoom = String(Math.min(2, fit / (window.devicePixelRatio || 1)));
  }
  try {
    const scale = window.devicePixelRatio || 1;
    const total = document.documentElement.scrollHeight;
    const view = window.innerHeight;
    const shots = [];
    for (let y = 0; y < total; y += view) {
      status(`Capturing ${Math.min(100, Math.round(((y + view) / total) * 100))}%…`);
      shots.push(await capturePart(y));
    }
    // Keep only the article column, so wide windows don't add empty space at the sides.
    const box = $('doc').getBoundingClientRect();
    const left = Math.max(0, Math.floor(box.left * scale));
    const width = Math.min(shots[0].bitmap.width - left, Math.ceil(box.width * scale));
    const height = Math.round(total * scale);
    const background = getComputedStyle(document.documentElement).backgroundColor;
    /** Draws article rows [top, top + rows) into ctx at offset y. */
    const draw = (ctx, top, rows, y = 0) => {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, y, width, rows);
      ctx.clip();
      for (const s of shots) ctx.drawImage(s.bitmap, -left, y + Math.round(s.y * scale) - top);
      ctx.restore();
    };
    return { width, height, background, draw };
  } finally {
    window.scrollTo(0, 0);
    $('doc').style.zoom = '';
    document.body.classList.remove('capturing', 'phone');
  }
}

/** Tells whether a row of the capture is plain background, so breaks fall between lines and pictures. */
function blankRows(shot) {
  const { width, background } = shot;
  const probe = canvasOf(width, 1, background);
  const bg = probe.ctx.getImageData(0, 0, 1, 1).data;
  return (y) => {
    probe.ctx.fillRect(0, 0, width, 1);
    shot.draw(probe.ctx, y, 1);
    const px = probe.ctx.getImageData(0, 0, width, 1).data;
    for (let i = 0; i < px.length; i += 4) {
      if (Math.abs(px[i] - bg[0]) + Math.abs(px[i + 1] - bg[1]) + Math.abs(px[i + 2] - bg[2]) > 24) return false;
    }
    return true;
  };
}

function busy(on) {
  $('pdf').disabled = $('ipdf').disabled = $('phone').disabled = $('png').disabled = $('theme').disabled = on;
}

function canvasOf(width, height, background) {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);
  return { canvas, ctx };
}

async function saveImagePdf({ phone = false } = {}) {
  busy(true);
  try {
    const size = phone ? PHONE : A4;
    const shot = await captureArticle({ sharp: true, phone });
    const { width, height, background } = shot;
    const pageHeight = Math.round((width * size.height) / size.width);
    const margin = Math.round(width * (phone ? 0.04 : 0.05));
    const rowIsBlank = blankRows(shot);

    const pages = [];
    for (let top = 0; top < height; ) {
      const topMargin = pages.length ? margin : 0; // the article already has room at the very top
      const room = pageHeight - topMargin - margin;
      const end = pageBreak(top, top + room, height, rowIsBlank);
      status(`Making page ${pages.length + 1}…`);
      const { canvas, ctx } = canvasOf(width, pageHeight, background);
      shot.draw(ctx, top, end - top, topMargin);
      const jpeg = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 })).arrayBuffer());
      pages.push({ jpeg, width, height: pageHeight });
      top = end;
      while (top < height && rowIsBlank(top)) top++; // no empty rows at a page start, and no empty last page
    }

    status('Saving PDF…');
    const blob = new Blob([imagePdf(pages, { title: article.title, size })], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const name = buildFileName(phone ? `${article.title} (phone)` : article.title, article.url, 'pdf');
    await chrome.downloads
      .download({ url, filename: name, saveAs: true })
      .catch(() => {}); // the user closed the dialog
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    status(`Done. ${pages.length} ${pages.length === 1 ? 'page' : 'pages'}.`);
  } catch (err) {
    status(`Could not save the PDF: ${err.message || err}`);
  } finally {
    busy(false);
  }
}

async function savePng() {
  busy(true);
  try {
    const shot = await captureArticle();
    const { width, background } = shot;
    const fullHeight = shot.height;
    // Very long articles become several images, cut between lines rather than through them.
    const rowIsBlank = blankRows(shot);
    const cuts = [];
    for (let top = 0; top < fullHeight; ) {
      const end = fullHeight - top <= MAX_IMAGE_HEIGHT ? fullHeight : pageBreak(top, top + MAX_IMAGE_HEIGHT, fullHeight, rowIsBlank, 1500);
      cuts.push([top, end]);
      top = end;
    }
    for (const [p, [top, end]] of cuts.entries()) {
      const { canvas, ctx } = canvasOf(width, end - top, background);
      shot.draw(ctx, top, end - top);
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      const url = URL.createObjectURL(blob);
      status(cuts.length > 1 ? `Saving image ${p + 1} of ${cuts.length}…` : 'Saving image…');
      const filename = buildFileName(article.title, article.url, 'png', cuts.length > 1 ? p : 0);
      // Ask where to save only once; the other parts go to the downloads folder.
      const ok = await chrome.downloads.download({ url, filename, saveAs: p === 0 }).catch(() => null);
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      if (!ok) break; // the user closed the dialog
    }
    status('Done.');
  } catch (err) {
    status(`Could not save the image: ${err.message || err}`);
  } finally {
    busy(false);
  }
}

$('pdf').onclick = savePdf;
$('ipdf').onclick = () => saveImagePdf();
$('phone').onclick = () => saveImagePdf({ phone: true });
$('png').onclick = savePng;

status('Loading images…');
await imagesReady();
dropBrokenImages();
status('Ready.');
if (params.get('action') === 'pdf') savePdf();
if (params.get('action') === 'png') savePng();
if (params.get('action') === 'ipdf') saveImagePdf();
if (params.get('action') === 'phone') saveImagePdf({ phone: true });
