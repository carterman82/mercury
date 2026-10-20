import { afterEach, expect, it, vi } from 'vitest';
import { LocalProviders, type ChatInput } from './providers';
import { responsesInput, claudeInput } from './cloud-providers';
import { imageUnsupported, messageTextLength, ModelHttpError } from './vision';

const image = { mimeType: 'image/png', data: 'iVBORw0KGgo=' };
const message = { role: 'user', content: 'What is this?\nLocal OCR: MEGAMAN', images: [image] };
const input = (provider: 'ollama' | 'lmstudio' = 'ollama'): ChatInput => ({ profile: { provider, model: 'vision-test', connectionId: 'test', contextLimit: 8192 }, messages: [message], signal: new AbortController().signal });
const providers = (provider: 'ollama' | 'lmstudio' = 'ollama') => new LocalProviders(() => ({ connections: [{ id: 'test', provider, label: 'Test', url: 'http://127.0.0.1:11434' }], defaultModel: null, overrides: {} }));
const success = (ollama = true) => new Response(ollama ? JSON.stringify({ message: { content: 'Blue character' }, done: true }) + '\n' : 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'Blue character' } }] }) + '\n\ndata: [DONE]\n');
afterEach(() => vi.unstubAllGlobals());

it('sends raw base64 images to Ollama without changing the internal messages', async () => {
  const fetch = vi.fn().mockResolvedValue(success()); vi.stubGlobal('fetch', fetch);
  expect((await providers().chat(input())).text).toBe('Blue character');
  expect(JSON.parse(fetch.mock.calls[0][1].body).messages[0].images).toEqual([image.data]);
  expect(message.images[0]).toEqual(image);
});

it('sends data-URL content parts to LM Studio', async () => {
  const fetch = vi.fn().mockResolvedValue(success(false)); vi.stubGlobal('fetch', fetch);
  await providers('lmstudio').chat(input('lmstudio'));
  const sent = JSON.parse(fetch.mock.calls[0][1].body).messages[0];
  expect(sent.images).toBeUndefined();
  expect(sent.content).toContainEqual({ type: 'image_url', image_url: { url: `data:image/png;base64,${image.data}` } });
});

it('converts actual images for OpenAI Responses and Claude without dropping tool history', () => {
  expect(responsesInput([message])[0].content).toContainEqual({ type: 'input_image', image_url: `data:image/png;base64,${image.data}` });
  expect(claudeInput([message]).messages[0].content).toContainEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.data } });
});

it('retries once with OCR after an explicit unsupported-image error and remembers the model temporarily', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response('{"error":"this model does not support images"}', { status: 400 })).mockImplementation(async () => success());
  vi.stubGlobal('fetch', fetch); const provider = providers(); const notice = vi.fn();
  await provider.chat({ ...input(), onImageFallback: notice });
  expect(fetch).toHaveBeenCalledTimes(2); expect(notice).toHaveBeenCalledOnce();
  const text = JSON.parse(fetch.mock.calls[1][1].body).messages[0];
  expect(text.images).toBeUndefined(); expect(text.content).toContain('MEGAMAN'); expect(text.content).toContain('Do not claim to see');
  await provider.chat(input()); expect(fetch).toHaveBeenCalledTimes(3);
  expect(JSON.parse(fetch.mock.calls[2][1].body).messages[0].images).toBeUndefined();
  await provider.chat({ ...input(), profile: { ...input().profile, model: 'another' } });
  expect(JSON.parse(fetch.mock.calls[3][1].body).messages[0].images).toHaveLength(1);
});

it('handles Ollama streamed capability errors, but never retries after partial output', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response('{"error":"model does not support image input"}\n')).mockResolvedValueOnce(success())
    .mockResolvedValueOnce(new Response('{"message":{"content":"partial"}}\n{"error":"model does not support image input"}\n'));
  vi.stubGlobal('fetch', fetch);
  await providers().chat(input()); expect(fetch).toHaveBeenCalledTimes(2);
  await expect(providers().chat(input())).rejects.toThrow('does not support'); expect(fetch).toHaveBeenCalledTimes(3);
});

it.each([401, 403, 429, 503])('does not hide HTTP %i as a vision limitation', async status => {
  const fetch = vi.fn().mockResolvedValue(new Response('model does not support images', { status })); vi.stubGlobal('fetch', fetch);
  await expect(providers().chat(input())).rejects.toThrow(`HTTP ${status}`); expect(fetch).toHaveBeenCalledOnce();
});

it('does not retry corrupt-image or context errors, or retry a failed text fallback', async () => {
  expect(imageUnsupported(new ModelHttpError(400, 'unsupported image format'))).toBe(false);
  expect(imageUnsupported(new ModelHttpError(400, 'image context length exceeds limit'))).toBe(false);
  const fetch = vi.fn().mockImplementation(async () => new Response('model does not support images', { status: 400 })); vi.stubGlobal('fetch', fetch);
  await expect(providers().chat(input())).rejects.toThrow('does not support'); expect(fetch).toHaveBeenCalledTimes(2);
});

it('honors Stop before a text fallback and excludes base64 from text-context accounting', async () => {
  const controller = new AbortController(); const fetch = vi.fn().mockImplementation(async () => { controller.abort(new Error('Stopped')); return new Response('model does not support images', { status: 400 }); });
  vi.stubGlobal('fetch', fetch);
  await expect(providers().chat({ ...input(), signal: controller.signal })).rejects.toThrow('Stopped'); expect(fetch).toHaveBeenCalledOnce();
  expect(messageTextLength([{ ...message, images: [{ ...image, data: 'x'.repeat(100_000) }] }])).toBeLessThan(200);
});
