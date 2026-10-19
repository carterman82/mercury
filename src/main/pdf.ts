import { inflateSync } from 'node:zlib';

/** A deliberately small PDF text reader/writer for ordinary text PDFs. Image-only PDFs need OCR. */
export function extractPdfText(bytes: Buffer): string {
  const source = bytes.toString('latin1');
  if (!source.startsWith('%PDF-')) throw new Error('This is not a PDF file.');
  const streams: string[] = [];
  const expression = /(?:<<([\s\S]*?)>>\s*)?stream\r?\n([\s\S]*?)\r?\nendstream/g;
  for (const match of source.matchAll(expression)) {
    let stream = match[2];
    if (/\/FlateDecode/.test(match[1] ?? '')) {
      try { stream = inflateSync(Buffer.from(stream, 'latin1')).toString('latin1'); } catch { continue; }
    }
    streams.push(stream);
  }
  const unescape = (value: string) => value.replace(/\\([\\()nrtbf])/g, (_all, char: string) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }[char as 'n' | 'r' | 't' | 'b' | 'f'] ?? char))
    .replace(/\\([0-7]{1,3})/g, (_all, octal) => String.fromCharCode(parseInt(octal, 8)));
  const text: string[] = [];
  for (const stream of streams) {
    for (const match of stream.matchAll(/\((?:\\.|[^\\)])*\)\s*Tj|\[(.*?)\]\s*TJ/gs)) {
      const values = match[0].includes('TJ') ? [...(match[1] ?? '').matchAll(/\(((?:\\.|[^\\)])*)\)/g)].map(item => item[1]) : [match[0].replace(/^\(|\)\s*Tj$/g, '')];
      text.push(values.map(unescape).join(''));
    }
  }
  const output = text.join('\n').trim();
  if (!output) throw new Error('No selectable text was found in this PDF. It may be image-based or use an unsupported encoding.');
  return output;
}

const escapePdf = (value: string) => value.replace(/[\\()]/g, '\\$&').replace(/[^\x20-\x7e]/g, '?');
export function makePdf(content: string): Buffer {
  const lines = content.replace(/\r/g, '').split('\n').flatMap(line => line.match(/.{1,88}(?:\s|$)|.{1,88}/g) ?? ['']).slice(0, 2_000);
  const chunks: string[] = [];
  for (let index = 0; index < lines.length || index === 0; index += 46) {
    const page = lines.slice(index, index + 46);
    const body = ['BT', '/F1 11 Tf', '50 760 Td', ...page.flatMap((line, row) => [row ? '0 -15 Td' : '', `(${escapePdf(line)}) Tj`].filter(Boolean)), 'ET'].join('\n');
    chunks.push(body);
  }
  const objects: string[] = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${chunks.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${chunks.length} >>`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  chunks.forEach((body, i) => { objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`, `<< /Length ${Buffer.byteLength(body, 'latin1')} >>\nstream\n${body}\nendstream`); });
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf, 'latin1')); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}
