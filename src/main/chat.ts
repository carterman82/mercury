import { randomUUID } from 'node:crypto';
import type { ChatMessage, ChatThread, ModelProfile } from '../shared/types';
import type { ModelProvider } from './providers';
import { Store } from './store';
import { ChatFiles } from './chat-files';
import { z } from 'zod';
import { chatFileInstructions, pdfToolDescription, textFileToolDescription } from './chat-instructions';
import { generateChatTurn } from './chat-generation';
import { chatConversationInstructions } from './chat-instructions';
import { documentSchema, spreadsheetSchema, presentationSchema, graphicSchema, archiveSchema } from './file-formats';
import { messageTextLength, type ChatImage } from './vision';

const tool = (name: string, description: string, properties: object, required: string[]) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } });
const schemaTool = (name: string, description: string, schema: z.ZodType) => {
  const { $schema: _schema, ...parameters } = z.toJSONSchema(schema);
  return { type: 'function', function: { name, description, parameters } };
};
const fileTools = [
  tool('create_pdf', pdfToolDescription, { name: { type: 'string' }, content: { type: 'string' } }, ['name', 'content']),
  tool('create_file', textFileToolDescription, { name: { type: 'string' }, content: { type: 'string' } }, ['name', 'content']),
  tool('read_file', 'Read text from a conversation file. Returns 12000 characters; use offset to continue.', { id: { type: 'string' }, offset: { type: 'integer' } }, ['id']),
  schemaTool('create_document', 'Create a real formatted Word DOCX from Markdown content. Supports headings, emphasis, lists, tables, and code. Use a .docx filename; no image model is required.', documentSchema),
  schemaTool('create_spreadsheet', 'Create a real Excel XLSX workbook. Supply named sheets with rows of string/number/boolean/null cells; the first row is the header. Numeric types remain numeric. Cells beginning with = are literal text, not executable formulas. No image model is required.', spreadsheetSchema),
  schemaTool('create_presentation', 'Create a real PowerPoint PPTX deck from slide titles and optional body, bullets, tables, and notes. Use separate slides for tables and bullets. Keep slides concise. No image model is required.', presentationSchema),
  schemaTool('create_graphic', 'Draw a real SVG, PNG, or JPEG graphic programmatically with rectangles, circles, lines, text, and SVG paths. Useful for diagrams, charts, and illustrations without an image-generation model. Coordinates are pixels; colors use #RRGGBB. Supply a matching filename extension.', graphicSchema),
  schemaTool('create_archive', 'Create a real ZIP archive. Each member needs a safe relative name and either text content or a fileId from this conversation. Use fileId to include generated PDFs, DOCX, XLSX, PPTX, or images. No paths outside this conversation are accessible.', archiveSchema),
];
const createSchema = z.object({ name: z.string().min(1).max(120), content: z.string().min(1).max(300_000) });
const readSchema = z.object({ id: z.string().uuid(), offset: z.number().int().min(0).optional() });

export class ChatService {
  private active = new Map<string, AbortController>();
  get activeId(): string | null { return this.active.keys().next().value ?? null; }
  get activeIds(): string[] { return [...this.active.keys()]; }
  constructor(private store: Store, private providers: ModelProvider, private notify: () => void, private agentRunning: () => boolean, private files?: ChatFiles) {}
  private save(chat: ChatThread): void { this.store.saveChat(chat); this.notify(); }
  stop(id: string): void {
    const controller = this.active.get(id);
    if (!controller) throw new Error('This chat is not generating a response.');
    controller.abort(new Error('Response stopped.'));
  }
  async send(id: string | null, selected: ModelProfile, message: string, attachmentIds: string[] = []): Promise<string> {
    if ((id && this.active.has(id)) || this.agentRunning()) throw new Error('Wait for the current response in this chat or stop it first.');
    if (attachmentIds.length > 8) throw new Error('Attach up to eight files per message.');
    const connection = this.store.settings().connections.find(item => item.id === selected.connectionId && item.provider === selected.provider);
    if (!connection) throw new Error('Save this model connection in Model settings first.');
    const profile = { ...selected, endpoint: connection.url };
    const chat: ChatThread = id ? this.store.chat(id) : { id: randomUUID(), title: message.slice(0, 70), profile, messages: [], status: 'idle', updatedAt: Date.now() };
    const prior = chat.messages.filter(item => item.content.trim() || item.files?.length);
    const history = prior.map(({ role, content, files }) => ({ role, content: content + (files?.length ? `\nConversation files available through read_file: ${JSON.stringify(files)}` : '') }));
    const messages: { role: string; content: string; images?: ChatImage[] }[] = [{ role: 'system', content: 'You are Mercury, a helpful assistant. Answer the user directly. Use Markdown formatting when helpful: headings, bold, italics, lists, quotes, tables, and fenced code blocks with a language label. For underline use <u>text</u>.' }, ...history, { role: 'user', content: message }];
    messages[0].content += chatConversationInstructions;
    if (this.files) messages[0].content += chatFileInstructions;
    if (messageTextLength(messages) > Math.min(profile.contextLimit * 3, 300_000)) throw new Error('This chat exceeds the selected model’s context limit. Start a new chat or choose a larger context in settings.');
    const controller = new AbortController();
    this.active.set(chat.id, controller);
    chat.profile = profile;
    chat.status = 'streaming';
    delete chat.error;
    chat.messages.push({ id: randomUUID(), role: 'user', content: message });
    const response: ChatMessage = { id: randomUUID(), role: 'assistant', content: '', model: profile.model, startedAt: Date.now() };
    chat.messages.push(response);
    this.save(chat);
    let publishTimer: ReturnType<typeof setTimeout> | null = null;
    const publish = () => {
      if (!publishTimer) publishTimer = setTimeout(() => { publishTimer = null; this.save(chat); }, 75);
    };
    try {
      if (attachmentIds.length && !this.files) throw new Error('File uploads are unavailable.');
      const attached = this.files ? await Promise.all(attachmentIds.map(fileId => this.files!.get(fileId))) : [];
      if (attached.some(file => file.kind !== 'upload')) throw new Error('Only uploaded files can be attached.');
      chat.messages[chat.messages.length - 2].files = attached;
      for (const file of attached) {
        const text = await this.files!.text(file.id);
        const space = Math.max(0, Math.min(profile.contextLimit * 3, 300_000) - messageTextLength(messages) - 2500);
        messages.at(-1)!.content += `\n\nAttached source file ${JSON.stringify(file)} (${text.length} characters):\n<attachment>\n${text.slice(0, Math.min(12000, Math.floor(space / 2)))}\n</attachment>\nUse read_file with its ID for more text.`;
      }
      // Rehydrate from authorized conversation files, never save base64 in chat history.
      // Newest eight images get priority; older attachments remain accessible as text.
      let imageCount = 0, imageBytes = 0;
      const sources = [...prior.map((item, index) => ({ files: item.role === 'user' ? item.files ?? [] : [], target: messages[index + 1], historical: true })), { files: attached, target: messages.at(-1)!, historical: false }];
      for (const source of sources.reverse()) for (const file of source.files) {
        if (!/\.(png|jpe?g|webp|gif|bmp|tiff?|ico|avif)$/i.test(file.name)) continue;
        let image: ChatImage | null = null;
        try { if (imageCount < 8) image = await this.files!.image(file.id); } catch { /* Keep the existing extracted-text fallback. */ }
        if (image && imageBytes + image.data.length <= 24 * 1024 * 1024) {
          (source.target.images ??= []).push(image); imageCount++; imageBytes += image.data.length;
          // OCR limitations describe the extractor, not the visual input. Do not tell
          // a vision model "visual contents have not been interpreted" beside real pixels.
          source.target.content = source.target.content.replace(JSON.stringify(file), JSON.stringify({ id: file.id, name: file.name, size: file.size, kind: file.kind, format: file.format, textExtractionStatus: file.readStatus }));
          if (source.historical) {
            const space = Math.max(0, Math.min(profile.contextLimit * 3, 300_000) - messageTextLength(messages) - 2500);
            source.target.content += `\nExtracted text fallback for ${JSON.stringify(file.name)}:\n<attachment>\n${(await this.files!.text(file.id)).slice(0, Math.min(12000, Math.floor(space / 2)))}\n</attachment>`;
          }
        } else source.target.content += `\n[${JSON.stringify(file.name)} is available as extracted text/metadata only; image decoding or the image payload limit prevented visual input.]`;
      }
      const allowed = new Set(chat.messages.flatMap(item => (item.files ?? []).map(file => file.id)));
      let complete = false;
      for (let turn = 0; turn < 8; turn++) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (messageTextLength(messages) > Math.min(profile.contextLimit * 3, 300_000)) throw new Error('Files exceed this model’s context limit. Choose a larger context or attach smaller files.');
      const prefix = response.content;
      const result = await generateChatTurn(this.providers, { profile, messages, tools: this.files ? fileTools : undefined, signal: controller.signal, onRequestState: state => {
        response.queued = state === 'queued';
        this.save(chat);
      }, onImageFallback: () => {
        response.notice = 'This model does not support image input. Using extracted text instead; visual contents are unavailable.';
        this.save(chat);
      }, onText: delta => {
        if (controller.signal.aborted) return;
        if (delta.trim() && !response.thinkingEndedAt) response.thinkingEndedAt = Date.now();
        response.content = (response.content + delta).slice(0, 200_001);
        if (response.content.length > 200_000) { controller.abort(new Error('Response length limit reached.')); return; }
        publish();
      }, onReasoning: delta => {
        if (controller.signal.aborted) return;
        response.reasoning = ((response.reasoning ?? '') + delta).slice(0, 100_001);
        if (response.reasoning.length > 100_000) { controller.abort(new Error('Thinking output limit reached. Partial reasoning has been saved.')); return; }
        publish();
      } }, reason => {
        response.content = prefix;
        response.notice = reason === 'repetition' ? 'Repetitive thinking detected. Trying once to answer directly.' : 'Thinking limit reached. Trying once to answer directly.';
        this.save(chat);
      });
      if (controller.signal.aborted) throw controller.signal.reason;
      response.content = prefix + result.text;
      if (!response.reasoning && result.reasoning) response.reasoning = result.reasoning.slice(0, 100_000);
      if (!result.tools.length) { complete = true; break; }
      (messages as any[]).push({ role: 'assistant', content: result.text || null, tool_calls: result.tools.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) });
      for (const call of result.tools) {
        if (controller.signal.aborted) throw controller.signal.reason;
        let output: unknown;
        try {
          if (!this.files) throw new Error('File tools are unavailable.');
          if (call.name === 'read_file') {
            const args = readSchema.parse(call.arguments);
            if (!allowed.has(args.id)) throw new Error('File is not attached to this conversation.');
            const text = await this.files.text(args.id);
            const file = await this.files.get(args.id);
            const offset = args.offset ?? 0;
            output = { content: text.slice(offset, offset + 12000), format: file.format, readStatus: file.readStatus, note: file.note, totalCharacters: text.length, nextOffset: offset + 12000 < text.length ? offset + 12000 : null };
          } else if (call.name === 'create_pdf' || call.name === 'create_file') {
            const args = createSchema.parse(call.arguments);
            const file = await this.files.create(args.name, args.content, call.name === 'create_pdf');
            (response.files ??= []).push(file); allowed.add(file.id); this.save(chat);
            output = { created: file, message: 'File created successfully. The user can save it using the response file card.' };
          } else if (['create_document', 'create_spreadsheet', 'create_presentation', 'create_graphic', 'create_archive'].includes(call.name)) {
            const file = await this.files.createStandard(call.name, call.arguments, allowed);
            (response.files ??= []).push(file); allowed.add(file.id); this.save(chat);
            output = { created: file, message: 'File created successfully. The user can save it using the response file card.' };
          } else throw new Error('Unknown tool. Use an offered file tool.');
        } catch (error) { output = { error: error instanceof Error ? error.message : String(error) }; }
        (messages as any[]).push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(output) });
      }
      if (response.content) response.content += '\n\n';
      }
      if (!complete) throw new Error('File tool turn limit reached. Created files are saved; send a follow-up to continue.');
      if (!response.content.trim() && !response.files?.length) throw new Error('The model returned no answer. Try another model or send the message again.');
      chat.status = 'idle';
    } catch (error) {
      chat.status = controller.signal.aborted ? 'stopped' : 'failed';
      chat.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (publishTimer) clearTimeout(publishTimer);
      delete response.queued;
      response.completedAt = Date.now(); this.active.delete(chat.id); this.save(chat);
    }
    return chat.id;
  }
}
