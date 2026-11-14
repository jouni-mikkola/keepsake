// Writes a small PDF where every page is one JPEG picture. Used for the "Image PDF", which keeps
// the exact colours and theme of the reader view whatever the print dialog settings are.

export const A4 = { width: 595.28, height: 841.89 }; // points
export const PHONE = { width: 360, height: 640 }; // a 9:16 page that fills a phone screen

const encoder = new TextEncoder();

/** PDF text string with only safe characters, as UTF-16 so any title works. */
function pdfText(text) {
  const units = [0xfe, 0xff];
  for (const ch of String(text).slice(0, 300)) {
    const code = ch.codePointAt(0);
    if (code > 0xffff) continue;
    units.push(code >> 8, code & 0xff);
  }
  return `<${units.map((b) => b.toString(16).padStart(2, '0')).join('')}>`;
}

/**
 * @param {{jpeg: Uint8Array, width: number, height: number}[]} pages pixel size of each JPEG
 * @param {{title?: string, size?: {width: number, height: number}}} info page size in points, A4 by default
 * @returns {Uint8Array}
 */
export function imagePdf(pages, info = {}) {
  if (!pages.length) throw new Error('No pages');
  const size = info.size || A4;
  const parts = [];
  const offsets = [];
  let length = 0;
  const push = (data) => {
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    parts.push(bytes);
    length += bytes.length;
  };
  const object = (n, body, stream) => {
    offsets[n] = length;
    push(`${n} 0 obj\n${body}\n`);
    if (stream) {
      push('stream\n');
      push(stream);
      push('\nendstream\n');
    }
    push('endobj\n');
  };

  // Objects: 1 catalog, 2 page tree, 3 info, then three per page: page, picture, drawing.
  const pageIds = pages.map((_, i) => 4 + i * 3);
  push('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, `<< /Type /Pages /Count ${pages.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`);
  object(3, `<< /Title ${pdfText(info.title || '')} /Producer (Keepsake) >>`);
  pages.forEach((page, i) => {
    const [pageId, imageId, drawId] = [pageIds[i], pageIds[i] + 1, pageIds[i] + 2];
    const w = size.width;
    const h = (size.width * page.height) / page.width;
    const draw = encoder.encode(`q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} 0 ${(size.height - h).toFixed(2)} cm /P Do Q`);
    object(
      pageId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${size.width} ${size.height}] ` +
        `/Resources << /XObject << /P ${imageId} 0 R >> >> /Contents ${drawId} 0 R >>`,
    );
    object(
      imageId,
      `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>`,
      page.jpeg,
    );
    object(drawId, `<< /Length ${draw.length} >>`, draw);
  });

  const count = 4 + pages.length * 3;
  const xref = length;
  let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let n = 1; n < count; n++) table += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  push(table);
  push(`trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * Picks where to end a page so no line of text is cut in half: the lowest row near the wanted
 * end that is plain background. `rowIsBlank(y)` tells whether pixel row y is background only.
 */
export function pageBreak(start, wanted, total, rowIsBlank, search = Math.round((wanted - start) * 0.2)) {
  if (wanted >= total) return total;
  for (let y = wanted; y > wanted - search && y > start; y--) if (rowIsBlank(y)) return y;
  return wanted;
}
