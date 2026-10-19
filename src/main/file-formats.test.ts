import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileFormats } from './file-formats';
import { ChatFiles } from './chat-files';
import { makePdf } from './pdf';
import { zipSync, strToU8, unzipSync } from 'fflate';

const directories: string[] = [];
const formats = new FileFormats(process.cwd());
function fixture() { const root = mkdtempSync(path.join(os.tmpdir(), 'mercury-formats-')); directories.push(root); return root; }
afterEach(() => directories.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

it('creates a real Word document and re-extracts headings, emphasis, and table contents', async () => {
  const result = await formats.document({ name: 'report.docx', content: '# Quarterly report\n\n## Findings\n\nA **useful** report.\n\n| Region | Revenue |\n|---|---|\n| West | 1250 |\n\n- Follow up\n\n```js\nconst total = 1250;\n```' });
  expect(result.bytes.subarray(0, 2).toString()).toBe('PK');
  const document = await formats.inspect('report.docx', result.bytes);
  expect(document.text).toContain('Quarterly report'); expect(document.text).toContain('West'); expect(document.text).toContain('1250');
  expect(document.readStatus).toBe('partial');
  expect(Buffer.from(unzipSync(result.bytes)['word/document.xml']).toString()).toContain('w:tbl');
});

it('round-trips a real multi-sheet XLSX without treating user cells as executable formulas', async () => {
  const result = await formats.spreadsheet({ name: 'budget.xlsx', sheets: [{ name: 'Budget', rows: [['Item', 'Amount'], ['Travel', 1250], ['=WEBSERVICE("https://example.com")', true]] }, { name: 'Notes', rows: [['Note'], ['Final figures']] }] });
  const read = await formats.inspect('budget.xlsx', result.bytes);
  expect(read.text).toContain('[Sheet: Budget'); expect(read.text).toContain('1250'); expect(read.text).toContain('Final figures');
  const xml = Buffer.from(unzipSync(result.bytes)['xl/worksheets/sheet1.xml']).toString();
  expect(xml).not.toContain('<f>');
});

it('creates real PowerPoint slides with body, table, and speaker notes', async () => {
  const result = await formats.presentation({ name: 'deck.pptx', title: 'Planning review', slides: [{ title: 'Overview', bullets: ['Read common files', 'Generate real artifacts'], notes: 'These are speaker notes.' }, { title: 'Results', table: [['Format', 'Support'], ['DOCX', 'Read and write']] }] });
  const read = await formats.inspect('deck.pptx', result.bytes);
  expect(read.text).toContain('Overview'); expect(read.text).toContain('Read common files'); expect(read.text).toContain('speaker notes'); expect(read.text).toContain('DOCX');
  expect(Object.keys(unzipSync(result.bytes)).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))).toHaveLength(2);
});

it('draws PNG and JPEG without an image model, and extracts English image text locally', async () => {
  const input = { name: 'message.png', width: 900, height: 180, elements: [{ type: 'text', x: 45, y: 110, text: 'Mercury file support 2026', fontSize: 50, fill: '#000000' }] };
  const result = await formats.graphic(input);
  expect(result.bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  const jpeg = await formats.graphic({ ...input, name: 'message.jpg' });
  expect(jpeg.bytes.subarray(0, 2).toString('hex')).toBe('ffd8');
  const read = await formats.inspect('message.png', result.bytes);
  expect(read.text).toMatch(/Mercury file support 2026/i);
  expect(read.readStatus).toBe('partial'); expect(read.note).toContain('Visual objects');
  expect((await formats.inspect('message.jpg', jpeg.bytes)).text).toMatch(/Mercury file support 2026/i);
}, 60_000);

it('accepts unknown binary files as metadata-only and decodes BOM-marked UTF-16 text', async () => {
  const root = fixture();
  const service = new ChatFiles(path.join(root, 'files'), async text => makePdf(text), async () => 'PDF', formats);
  const unknown = path.join(root, 'unknown.binary'); writeFileSync(unknown, Buffer.from([0, 255, 23, 0, 10, 4, 9]));
  const upload = await service.import(unknown);
  expect(upload.readStatus).toBe('metadata'); expect(upload.note).toContain('not been fully read');
  expect(await service.text(upload.id)).toContain('SHA-256:');
  const unicode = await formats.inspect('unicode.txt', Buffer.concat([Buffer.from([255, 254]), Buffer.from('Café 世界', 'utf16le')]));
  expect(unicode.text).toBe('Café 世界');
});

it('reads OpenDocument XML and lists ZIP archives without executing or writing their members', async () => {
  const odt = zipSync({ 'content.xml': strToU8('<office:document><text:p>Hello &amp; welcome</text:p><text:p>Second paragraph</text:p></office:document>') });
  expect((await formats.inspect('sample.odt', Buffer.from(odt))).text).toContain('Hello & welcome');
  const archive = zipSync({ '../escape.txt': strToU8('Cannot extract this') });
  const read = await formats.inspect('archive.zip', Buffer.from(archive));
  expect(read.text).toContain('../escape.txt'); expect(read.readStatus).toBe('partial');
  expect(() => formats.archive({ name: 'bad.zip', files: [{ name: '../escape.txt', content: 'bad' }] }, new Map())).toThrow('safe relative');
});

it('accounts for oversized document expansion as metadata and rejects XML entity declarations', async () => {
  const large = zipSync({ 'word/document.xml': new Uint8Array(12 * 1024 * 1024 + 1).fill(65) });
  const rejected = await formats.inspect('oversized.docx', Buffer.from(large));
  expect(rejected.readStatus).toBe('metadata'); expect(rejected.note).toContain('expansion limit');
  const entities = zipSync({ 'content.xml': strToU8('<!DOCTYPE a [<!ENTITY external SYSTEM "file:///secret">]><a>&external;</a>') });
  const read = await formats.inspect('entities.odt', Buffer.from(entities));
  expect(read.readStatus).toBe('metadata'); expect(read.note).toContain('entity declarations');
});

it('packages authorized binary outputs and refuses forged binary text files', async () => {
  const root = fixture();
  const service = new ChatFiles(path.join(root, 'files'), async text => makePdf(text), async () => 'PDF', formats);
  const document = await service.createStandard('create_document', { name: 'report.docx', content: '# Actual document' }, new Set());
  const archive = await service.createStandard('create_archive', { name: 'bundle.zip', files: [{ name: 'docs/report.docx', fileId: document.id }, { name: 'README.md', content: '# Bundle' }] }, new Set([document.id]));
  const members = unzipSync(await service.bytes(archive.id));
  expect(Buffer.from(members['docs/report.docx']).equals(await service.bytes(document.id))).toBe(true);
  await expect(service.createStandard('create_archive', { name: 'bad.zip', files: [{ name: 'report.docx', fileId: document.id }] }, new Set())).rejects.toThrow('not attached');
  await expect(service.create('fake.xlsx', 'not a workbook', false)).rejects.toThrow('dedicated');
});
