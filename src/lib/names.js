// File name helpers. Page titles are untrusted input, so everything goes through safeFileName().

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

export function safeFileName(name, fallback = 'download') {
  let out = String(name ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f\u00ad\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '') // control, zero-width, bidi, soft hyphen
    .replace(/\s*:\s+/g, ' - ') // "Headline: quote" -> "Headline - quote"
    .replace(/([\p{L}\p{N}]):([\p{L}\p{N}])/gu, '$1꞉$2') // "IS:lle" keeps a colon-like letter that file systems allow
    .replace(/[\\/:*?"<>|~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (!out || RESERVED.test(out)) out = fallback;
  // Leave room for " (2).mp4" and keep well under common 255-byte limits.
  if (out.length > 120) out = out.slice(0, 120).trim();
  return out;
}

/** "Headline | Section | Site" -> "Headline". */
export function cleanTitle(title) {
  const parts = String(title ?? '').split(/\s+[|·•]\s+/);
  return parts[0].trim() || String(title ?? '').trim();
}

export function siteName(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function buildFileName(title, url, ext, index = 0) {
  const base = safeFileName(cleanTitle(title), siteName(url) || 'download');
  const site = siteName(url);
  const suffix = index > 0 ? ` (${index + 1})` : '';
  const withSite = site && !base.toLowerCase().includes(site) ? `${base} - ${site}` : base;
  return `${safeFileName(withSite + suffix)}.${ext}`;
}
