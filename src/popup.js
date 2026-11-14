// Popup: lists videos found on the current tab and offers the save buttons.
const $ = (id) => document.getElementById(id);
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

async function call(type, extra = {}) {
  const res = await chrome.runtime.sendMessage({ type, tabId: tab.id, ...extra });
  if (!res?.ok) throw new Error(res?.error || 'Something went wrong.');
  return res.value;
}

function showError(err) {
  $('error').textContent = err ? String(err.message || err) : '';
  $('error').hidden = !err;
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c != null));
  return node;
}

const ICONS = {
  download: 'M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19h14',
  cancel: 'M6 6l12 12M18 6L6 18',
  play: 'M8 5.5v13l10-6.5z',
  ok: 'M5 12.5l4.5 4.5L19 7',
};

function icon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', ICONS[name]);
  path.setAttribute('fill', name === 'play' ? 'currentColor' : 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

function clock(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(seconds % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function megabytes(bytes) {
  const mb = bytes / 1024 / 1024;
  return mb >= 1000 ? `${(mb / 1024).toFixed(1)} GB` : `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

function describe(item) {
  const bits = [];
  const short = Math.min(item.width || Infinity, item.height || Infinity);
  if (Number.isFinite(short) && short > 0) bits.push(`${short}p`);
  if (item.width && item.height > item.width) bits.push('vertical');
  if (item.size) bits.push(`${item.estimated ? '≈ ' : ''}${megabytes(item.size)}`);
  if (!bits.length) bits.push(item.kind === 'file' ? 'Video file' : 'Stream');
  return bits.join(' · ');
}

function blocked(item) {
  if (item.kind === 'dash') return 'This stream type is not supported.';
  if (item.drm) return 'Copy protected, cannot be saved.';
  if (item.live) return 'Live stream, cannot be saved.';
  return '';
}

function fallbackTitle(item) {
  try {
    const name = decodeURIComponent(new URL(item.url).pathname.split('/').pop() || '');
    if (item.kind === 'file' && name) return name;
  } catch {}
  return tab.title || 'Video';
}

function thumb(item) {
  const box = el('div', { className: 'thumb' });
  const placeholder = () => {
    const svg = icon('play');
    svg.classList.add('play');
    return svg;
  };
  if (item.thumb) {
    const img = el('img', { src: item.thumb, alt: '', referrerPolicy: 'no-referrer' });
    img.onerror = () => img.replaceWith(placeholder());
    box.append(img);
  } else {
    box.append(placeholder());
  }
  if (item.duration) box.append(el('span', { className: 'time' }, clock(item.duration)));
  return box;
}

function row(item, job) {
  const reason = blocked(item);
  const info = el('div', { className: 'info' }, el('div', { className: 'title', title: item.title || '' }, item.title || fallbackTitle(item)));
  let action;
  let bar = null;

  if (job) {
    const [jobId, j] = job;
    const cancel = () => call('cancel', { jobId }).then(refresh, showError);
    if (j.status === 'failed') {
      info.append(el('div', { className: 'meta error' }, j.error || 'Download failed.'));
      action = el('button', { className: 'icon', title: 'Dismiss', onclick: cancel }, icon('cancel'));
    } else {
      const pct = j.total ? Math.floor(((j.done || 0) / j.total) * 100) : 0;
      const label = { converting: 'Finishing…', saving: 'Saving…' }[j.status] || `Downloading ${pct}%${j.bytes ? ` · ${megabytes(j.bytes)}` : ''}`;
      info.append(el('div', { className: 'meta' }, label));
      action = el('button', { className: 'icon', title: 'Cancel', onclick: cancel }, icon('cancel'));
      bar = el('div', { className: `bar${j.status === 'downloading' || !j.status ? '' : ' busy'}` }, el('i', { style: `width:${pct}%` }));
    }
  } else {
    info.append(el('div', { className: 'meta', title: item.url }, reason || item.error || describe(item)));
    action = el('button', {
      className: 'icon primary',
      title: reason || 'Download',
      disabled: Boolean(reason),
      onclick: (e) => {
        e.currentTarget.disabled = true;
        call('download', { itemId: item.id }).then(refresh, (err) => {
          showError(err);
          refresh();
        });
      },
    }, icon('download'));
    action.setAttribute('aria-label', 'Download');
  }
  return el('li', { className: 'video' }, thumb(item), info, action, bar);
}

let last = '';
function render({ items, jobs }) {
  const state = JSON.stringify({ items, jobs });
  if (state === last) return;
  last = state;
  const ours = Object.entries(jobs).filter(([, j]) => j.tabId === tab.id);
  const jobFor = (item) => ours.find(([, j]) => j.itemId === item.id);
  const main = items.filter((i) => !i.other || jobFor(i));
  const rest = items.filter((i) => !main.includes(i));
  main.sort((a, b) => b.playing - a.playing);
  $('videos').replaceChildren(...main.map((i) => row(i, jobFor(i))));
  $('others').replaceChildren(...rest.map((i) => row(i, jobFor(i))));
  $('more').hidden = !rest.length;
  $('more').querySelector('summary').textContent = `Other media (${rest.length})`;
  $('count').textContent = main.length || '';
  $('empty').hidden = main.length > 0 || rest.length > 0;
}

async function refresh() {
  try {
    render(await call('list'));
  } catch (err) {
    showError(err);
  }
}

function saveArticle(mode) {
  showError(null);
  call('article', { mode }).then(() => window.close(), showError);
}

$('pdf').onclick = () => saveArticle('pdf');
$('png').onclick = () => saveArticle('png');

try {
  $('host').textContent = new URL(tab.url).hostname.replace(/^www\./, '');
} catch {}
if (!/^https?:/.test(tab.url || '')) {
  $('pdf').disabled = $('png').disabled = true;
}

chrome.storage.session.onChanged.addListener(refresh);
await refresh();
call('scan').then(refresh, () => {});
