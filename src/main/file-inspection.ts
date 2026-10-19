import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { TextDecoder } from 'node:util';
import { unzipSync, strFromU8 } from 'fflate';
import { XMLParser } from 'fast-xml-parser';

export interface FileInspection { text: string; format: string; readStatus: 'readable' | 'partial' | 'metadata'; note?: string; }
export const MAX_EXTRACTED = 300_000;
const MAX_EXPANDED = 32 * 1024 * 1024;

export function boundedInspection(result: FileInspection): FileInspection {
  if (result.text.length <= MAX_EXTRACTED) return result;
  return { ...result, text: result.text.slice(0, MAX_EXTRACTED - 90) + '\n[Extraction truncated at the 300,000-character limit.]', readStatus: 'partial', note: (result.note ? result.note + ' ' : '') + 'Extracted text was truncated.' };
}

/** Inspect ZIP entries in memory; never extract uploaded paths onto disk. */
export function inspectZip(bytes: Buffer, extract: boolean): { entries: { name: string; size: number }[]; files: Record<string, Uint8Array> } {
  const entries: { name: string; size: number }[] = [];
  let total = 0;
  const files = unzipSync(bytes, { filter: file => {
    if (entries.length >= 1000) throw new Error('Archive exceeds the 1,000-entry inspection limit.');
    entries.push({ name: file.name, size: file.originalSize });
    if (!extract) return false;
    total += file.originalSize;
    if (file.originalSize > 12 * 1024 * 1024 || total > MAX_EXPANDED) throw new Error('Archive exceeds the safe document expansion limit.');
    return /\.(xml|rels)$/i.test(file.name);
  } });
  return { entries, files };
}

const decodeEntities = (text: string) => text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (all, entity: string) => {
  if (!entity.startsWith('#')) return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[entity] ?? all;
  const value = parseInt(entity.slice(entity[1] === 'x' ? 2 : 1), entity[1] === 'x' ? 16 : 10);
  return value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : all;
});

export function xmlDocumentText(bytes: Uint8Array): string {
  const source = strFromU8(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error('XML entity declarations are not supported.');
  const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: true, processEntities: false, trimValues: false });
  const visit = (nodes: any[]): string => nodes.map(node => Object.entries(node).map(([tag, children]) => {
    if (tag === '#text') return decodeEntities(String(children));
    if (!Array.isArray(children)) return '';
    const local = tag.split(':').at(-1);
    if (local === 'br') return '\n';
    if (local === 'tab') return '\t';
    const suffix = ['p', 'tr', 'row', 'table-row', 'h', 'text-box'].includes(local!) ? '\n' : ['tc', 'table-cell'].includes(local!) ? '\t' : '';
    return visit(children) + suffix;
  }).join('')).join('');
  return visit(parser.parse(source)).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function decodeText(bytes: Buffer, knownText = false): { text: string; encoding: string } | null {
  let encoding = 'utf-8';
  let data = bytes;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) { encoding = 'utf-16le'; data = bytes.subarray(2); }
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) { encoding = 'utf-16be'; data = bytes.subarray(2); }
  let text: string;
  try { text = new TextDecoder(encoding, { fatal: true }).decode(data); }
  catch {
    if (!knownText) return null;
    encoding = 'windows-1252'; text = new TextDecoder(encoding).decode(data);
  }
  if (text.includes('\0') || (text.match(/[\x01-\x08\x0b\x0c\x0e-\x1f]/g)?.length ?? 0) > Math.max(2, text.length * .01)) return null;
  return { text, encoding };
}

export function rtfText(source: string): string {
  // Drop non-text destinations before decoding RTF escapes; do not interpret objects.
  let depth = 0, skipDepth = 0, output = '', unicodeFallback = 1;
  for (let index = 0; index < source.length;) {
    const char = source[index++];
    if (char === '{') { depth++; if (/^\\(?:\*|fonttbl|colortbl|stylesheet|info|pict|object|header|footer)/.test(source.slice(index))) skipDepth ||= depth; continue; }
    if (char === '}') { if (depth === skipDepth) skipDepth = 0; depth--; continue; }
    if (skipDepth) continue;
    if (char !== '\\') { if (char !== '\r' && char !== '\n') output += char; continue; }
    if (/[{}\\]/.test(source[index] ?? '')) { output += source[index++]; continue; }
    const hex = /^'([0-9a-f]{2})/i.exec(source.slice(index));
    if (hex) { output += new TextDecoder('windows-1252').decode(Uint8Array.of(parseInt(hex[1], 16))); index += hex[0].length; continue; }
    const control = /^([a-z]+)(-?\d+)? ?/i.exec(source.slice(index));
    if (!control) { index++; continue; }
    index += control[0].length;
    if (['par', 'line', 'row'].includes(control[1])) output += '\n';
    else if (['tab', 'cell'].includes(control[1])) output += '\t';
    else if (control[1] === 'uc') unicodeFallback = Math.max(0, Math.min(5, Number(control[2])));
    else if (control[1] === 'u') { output += String.fromCharCode((Number(control[2]) + 65536) % 65536); index += unicodeFallback; }
  }
  return output.trim();
}

export function binaryInspection(name: string, bytes: Buffer, reason?: string): FileInspection {
  let format = path.extname(name).slice(1).toUpperCase() || 'Binary';
  const ascii = bytes.subarray(0, 16).toString('latin1');
  if (ascii.startsWith('MZ')) format = 'Windows executable';
  else if (ascii.startsWith('\x7fELF')) format = 'ELF executable';
  else if (ascii.startsWith('SQLite format 3')) format = 'SQLite database';
  else if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WAVE') format = 'WAV audio';
  else if (ascii.slice(4, 8) === 'ftyp') format = 'MP4/QuickTime media';
  else if (ascii.startsWith('ID3')) format = 'MP3 audio';
  const strings = bytes.subarray(0, 512_000).toString('latin1').match(/[\x20-\x7e]{8,}/g)?.slice(0, 40).map(value => value.slice(0, 240)) ?? [];
  const note = reason || 'No content decoder is available for this format. Only file metadata and a bounded binary preview were inspected; the contents have not been fully read.';
  return { format, readStatus: 'metadata', note, text: `File: ${name}\nType: ${format}\nBytes: ${bytes.length}\nSHA-256: ${createHash('sha256').update(bytes).digest('hex')}\n${note}\nHeader (hex): ${bytes.subarray(0, 64).toString('hex')}\nPrintable byte strings (not a full content extraction):\n${strings.join('\n')}` };
}

export function inspectCompressedText(name: string, bytes: Buffer): FileInspection {
  const unpacked = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes, { maxOutputLength: MAX_EXPANDED }) : bytes;
  const tar = /\.(tar|tgz|tar\.gz)$/i.test(name);
  if (tar) {
    const entries: string[] = [];
    for (let offset = 0; offset + 512 <= unpacked.length && unpacked[offset];) {
      if (entries.length >= 1000) throw new Error('TAR archive exceeds 1,000 entries.');
      const filename = unpacked.subarray(offset, offset + 100).toString('utf8').replace(/\0.*$/, '');
      const size = parseInt(unpacked.subarray(offset + 124, offset + 136).toString('ascii').replace(/\0/g, '').trim(), 8);
      if (!Number.isFinite(size) || size < 0) throw new Error('Unsupported TAR size encoding.');
      entries.push(`${filename} (${size} bytes)`); offset += 512 + Math.ceil(size / 512) * 512;
    }
    return { format: 'TAR archive', readStatus: 'partial', note: 'Archive member names and sizes only; members were not executed or extracted.', text: entries.join('\n') };
  }
  const decoded = decodeText(unpacked);
  return decoded ? { format: 'GZIP text', readStatus: 'readable', text: decoded.text } : binaryInspection(name, bytes, 'GZIP payload is binary; its content has not been interpreted.');
}
