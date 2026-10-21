import path from 'node:path';
import type { ProviderKind } from '../shared/types';
import { decodeText } from './file-inspection';

// Provider file inputs are narrower than the file upload features in their web apps.
// https://developers.openai.com/api/docs/guides/file-inputs
// https://platform.claude.com/docs/en/build-with-claude/pdf-support
const textTypes: Record<string, string> = {
  txt: 'text/plain', text: 'text/plain', md: 'text/markdown', markdown: 'text/markdown',
  csv: 'text/csv', tsv: 'text/tab-separated-values', iif: 'text/plain',
  html: 'text/html', htm: 'text/html', xml: 'application/xml', json: 'application/json',
  js: 'text/javascript', mjs: 'text/javascript', ts: 'text/plain', tsx: 'text/plain', jsx: 'text/plain',
  css: 'text/css', py: 'text/x-python', c: 'text/x-c', cpp: 'text/x-c++',
  eml: 'message/rfc822', mime: 'message/rfc822', mht: 'message/rfc822', mhtml: 'message/rfc822',
  ics: 'text/calendar', ifb: 'text/calendar', vcf: 'text/vcard', vtt: 'text/vtt',
};
for (const extension of 'asm bat cc conf cxx def dic h hh in ksh list log nws pl rst s sql srt sh rb go rs java swift kt kts yaml yml toml ini'.split(' ')) textTypes[extension] = 'text/plain';

const archiveTypes: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  odt: 'application/vnd.oasis.opendocument.text',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pages: 'application/vnd.apple.pages', key: 'application/vnd.apple.keynote',
};
const legacyTypes: Record<string, string> = { doc: 'application/msword', dot: 'application/msword' };
for (const extension of 'xla xlb xlc xlm xls xlt xlw'.split(' ')) legacyTypes[extension] = 'application/vnd.ms-excel';
for (const extension of 'pot ppa pps ppt pwz wiz'.split(' ')) legacyTypes[extension] = 'application/vnd.ms-powerpoint';

/** Return a provider-supported native MIME only when the content matches the format. */
export function nativeFileMime(provider: ProviderKind, name: string, bytes: Buffer): string | null {
  if (provider !== 'openai' && provider !== 'claude') return null;
  if (bytes.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  if (provider === 'claude') return null;
  const extension = path.extname(name).slice(1).toLowerCase();
  if (extension === 'pdf') return null;
  if (archiveTypes[extension]) return bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) ? archiveTypes[extension] : null;
  if (legacyTypes[extension]) return bytes.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) ? legacyTypes[extension] : null;
  if (extension === 'rtf') return bytes.subarray(0, 5).toString('ascii') === '{\\rtf' && decodeText(bytes, true) ? 'application/rtf' : null;
  return textTypes[extension] && decodeText(bytes) ? textTypes[extension] : null;
}
