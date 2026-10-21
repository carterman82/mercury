import { describe, expect, it } from 'vitest';
import { nativeFileMime } from './native-files';
import { claudeInput, responsesInput } from './cloud-providers';

const pdf = Buffer.from('%PDF-1.7\nNative document bytes\n');
const document = { name: 'report.pdf', mimeType: 'application/pdf', data: pdf.toString('base64') };
const image = { mimeType: 'image/png', data: 'aW1hZ2U=' };

describe('native file formats', () => {
  it('sniffs PDF content before the extension for supported cloud providers', () => {
    expect(nativeFileMime('openai', 'upload.bin', pdf)).toBe('application/pdf');
    expect(nativeFileMime('claude', 'upload.bin', pdf)).toBe('application/pdf');
    expect(nativeFileMime('claude', 'fake.pdf', Buffer.from('not a PDF'))).toBeNull();
    expect(nativeFileMime('ollama', 'report.pdf', pdf)).toBeNull();
    expect(nativeFileMime('codex', 'report.pdf', pdf)).toBeNull();
  });

  it('supports legacy Office and modern Office through OpenAI, never as Claude PDFs', () => {
    const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]);
    expect(nativeFileMime('openai', 'REPORT.DOC', ole)).toBe('application/msword');
    expect(nativeFileMime('openai', 'report.xlsx', zip)).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(nativeFileMime('claude', 'report.docx', zip)).toBeNull();
    expect(nativeFileMime('openai', 'report.docx', Buffer.from('invalid content'))).toBeNull();
    expect(nativeFileMime('openai', 'archive.zip', zip)).toBeNull();
  });

  it('accepts recognized text and code without relabeling arbitrary binary bytes', () => {
    expect(nativeFileMime('openai', 'report.csv', Buffer.from('name,value\na,1'))).toBe('text/csv');
    expect(nativeFileMime('openai', 'app.tsx', Buffer.from('export const x = <div/>;'))).toBe('text/plain');
    expect(nativeFileMime('openai', 'image.txt', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff]))).toBeNull();
    expect(nativeFileMime('openai', 'unknown.blob', Buffer.from('text'))).toBeNull();
    expect(nativeFileMime('claude', 'notes.md', Buffer.from('text'))).toBeNull();
  });
});

describe('native document provider payloads', () => {
  const call = { id: 'call-1', function: { name: 'read_file', arguments: '{"path":"a"}' } };
  const messages = [
    { role: 'user', content: 'Compare these', images: [image], documents: [document] },
    { role: 'assistant', content: null, tool_calls: [call] },
    { role: 'tool', content: 'file contents', tool_call_id: call.id },
  ];

  it('sends images, original PDF bytes, text, and tools through Responses together', () => {
    const result = responsesInput(messages);
    expect(result[0].content).toContainEqual({ type: 'input_file', filename: document.name, file_data: `data:application/pdf;base64,${document.data}` });
    expect(result[0].content).toContainEqual({ type: 'input_image', image_url: `data:${image.mimeType};base64,${image.data}` });
    expect(result[0].content[0].text).toContain('Compare these');
    expect(result).toContainEqual({ type: 'function_call', call_id: call.id, name: 'read_file', arguments: call.function.arguments });
    expect(result).toContainEqual({ type: 'function_call_output', call_id: call.id, output: 'file contents' });
  });

  it('sends PDF document blocks with images and tool history through Claude', () => {
    const result = claudeInput(messages).messages;
    expect(result[0].content).toContainEqual({ type: 'document', title: document.name, source: { type: 'base64', media_type: 'application/pdf', data: document.data } });
    expect(result[0].content).toContainEqual({ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data } });
    expect(result[1].content).toContainEqual({ type: 'tool_use', id: call.id, name: 'read_file', input: { path: 'a' } });
    expect(result[2].content).toContainEqual({ type: 'tool_result', tool_use_id: call.id, content: 'file contents' });
  });

  it('decodes text document sources and rejects unsupported Office blocks for Claude', () => {
    const text = 'résumé 📄';
    const result = claudeInput([{ role: 'user', documents: [{ name: 'notes.txt', mimeType: 'text/plain', data: Buffer.from(text).toString('base64') }] }]);
    expect(result.messages[0].content[0].source).toEqual({ type: 'text', media_type: 'text/plain', data: text });
    expect(() => claudeInput([{ role: 'user', documents: [{ ...document, name: 'report.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }] }])).toThrow('Use extracted text or a file plugin');
  });
});
