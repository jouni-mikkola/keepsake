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
  node.append(...children);
  return node;
}

function describe(item) {
  const bits = [];
  if (item.height) bits.push(`${item.height}p`);
  if (item.duration) bits.push(`${Math.floor(item.duration / 60)}:${String(item.duration % 60).padStart(2, '0')}`);
  if (item.size) bits.push(`${(item.size / 1024 / 1024).toFixed(1)} MB`);
  bits.push(item.kind === 'file' ? 'MP4 file' : item.kind === 'hls' ? 'stream' : 'DASH');
  return bits.join(' · ');
}

function blocked(item) {
  if (item.kind === 'dash') return 'DASH streams are not supported yet.';
  if (item.drm) return 'DRM protected, cannot be saved.';
  if (item.live) return 'Live stream, cannot be saved.';
  return '';
}

function render({ items, jobs }) {
  const list = $('videos');
  list.replaceChildren();
  const ours = Object.entries(jobs).filter(([, j]) => j.tabId === tab.id);
  items.forEach((item, i) => {
    const job = ours.find(([, j]) => j.itemId === item.id);
    const reason = blocked(item);
    const info = el('div', { className: 'info' }, el('div', { className: 'name' }, `Video ${i + 1}`));
    info.append(el('div', { className: 'meta', title: item.url }, reason || item.error || describe(item)));
    let action;
    if (job) {
      const [jobId, j] = job;
      if (j.status === 'failed') {
        info.append(el('div', { className: 'meta error' }, j.error));
        action = el('button', { textContent: 'OK', onclick: () => call('cancel', { jobId }).then(refresh) });
      } else {
        const label = j.status === 'converting' ? 'Converting…' : j.status === 'saving' ? 'Saving…' : `${j.done}/${j.total || '?'}`;
        info.append(el('progress', { max: j.total || 1, value: j.done || 0 }), el('div', { className: 'meta' }, label));
        action = el('button', { textContent: 'Cancel', onclick: () => call('cancel', { jobId }).then(refresh) });
      }
    } else {
      action = el('button', {
        className: 'primary',
        textContent: 'Download',
        disabled: Boolean(reason),
        onclick: () => call('download', { itemId: item.id }).then(refresh, showError),
      });
    }
    list.append(el('li', {}, info, action));
  });
  $('empty').hidden = items.length > 0;
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

if (!/^https?:/.test(tab.url || '')) {
  $('pdf').disabled = $('png').disabled = true;
}

chrome.storage.session.onChanged.addListener(refresh);
refresh();
