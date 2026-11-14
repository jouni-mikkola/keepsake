// Clean reading view of a saved article, with "Save as PDF" (print dialog) and "Save as image".
/* global DOMPurify */
import { buildFileName } from './lib/names.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const key = `article:${params.get('id')}`;
const article = (await chrome.storage.session.get(key))[key];

function status(text) {
  $('status').textContent = text;
}

if (!article) {
  status('This article is no longer available. Open the page and save it again.');
  $('pdf').disabled = $('png').disabled = true;
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
clean.querySelectorAll('video, audio, source, picture > source').forEach((n) => n.remove());

// Chrome uses the page title as the suggested PDF file name.
document.title = buildFileName(article.title, article.url, 'pdf').replace(/\.pdf$/, '');
document.documentElement.lang = article.lang || 'en';
$('site').textContent = article.siteName || '';
$('title').textContent = article.title;
const date = article.published ? new Date(article.published) : null;
$('byline').textContent = [article.byline, date && !isNaN(date) ? date.toLocaleDateString() : ''].filter(Boolean).join(' · ');
$('content').append(clean);
$('source').textContent = `Source: ${article.url} · Saved ${new Date(article.savedAt).toLocaleString()} · For personal use.`;

// Wait for images so they are in the PDF / image.
async function imagesReady() {
  const imgs = [...document.images].filter((i) => !i.complete);
  await Promise.race([
    Promise.all(imgs.map((i) => new Promise((r) => { i.onload = i.onerror = r; }))),
    new Promise((r) => setTimeout(r, 10000)),
  ]);
}

function savePdf() {
  status('Choose "Save as PDF" as the destination in the print dialog.');
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

async function savePng() {
  $('pdf').disabled = $('png').disabled = true;
  document.body.classList.add('capturing');
  try {
    await imagesReady();
    const scale = window.devicePixelRatio || 1;
    const total = document.documentElement.scrollHeight;
    const view = window.innerHeight;
    const shots = [];
    for (let y = 0; y < total; y += view) shots.push(await capturePart(y));
    window.scrollTo(0, 0);
    document.body.classList.remove('capturing');

    const width = shots[0].bitmap.width;
    const fullHeight = Math.round(total * scale);
    const pages = Math.ceil(fullHeight / MAX_IMAGE_HEIGHT);
    for (let p = 0; p < pages; p++) {
      const top = p * MAX_IMAGE_HEIGHT;
      const height = Math.min(MAX_IMAGE_HEIGHT, fullHeight - top);
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, width, height);
      for (const s of shots) ctx.drawImage(s.bitmap, 0, Math.round(s.y * scale) - top);
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      const url = URL.createObjectURL(blob);
      status(pages > 1 ? `Saving image ${p + 1} of ${pages}…` : 'Saving image…');
      await chrome.downloads
        .download({ url, filename: buildFileName(article.title, article.url, 'png', pages > 1 ? p : 0), saveAs: true })
        .catch(() => {}); // the user closed the dialog
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
    status('Done.');
  } catch (err) {
    status(`Could not save the image: ${err.message || err}`);
  } finally {
    document.body.classList.remove('capturing');
    $('pdf').disabled = $('png').disabled = false;
  }
}

$('pdf').onclick = savePdf;
$('png').onclick = savePng;

status('Loading images…');
await imagesReady();
status('Ready.');
if (params.get('action') === 'pdf') savePdf();
if (params.get('action') === 'png') savePng();
