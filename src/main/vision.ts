/** Internal image payload. Only provider adapters turn this into API-specific fields. */
export interface ChatImage { mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string; }
export const visualInputText = (content: string) => `${content}\n[Actual image pixels are attached to this message. Answer visual questions using the image itself. OCR text, if present, is supplemental and may be garbled. Text-extraction status does not limit your visual input. Do not claim that only OCR text is available when you received image data.]`;

export function hasImages(messages: unknown[]): boolean {
  return messages.some((message: any) => message.role === 'user' && message.images?.length);
}

export function textOnlyMessages(messages: unknown[]): unknown[] {
  return messages.map((message: any) => {
    const { images, ...rest } = message;
    return images?.length ? { ...rest, content: `${rest.content ?? ''}\n[Image input unavailable for this model. Only the extracted text/metadata above is available. Do not claim to see the image or infer its visual contents from its filename.]` } : rest;
  });
}

export function localImageMessages(messages: unknown[], ollama: boolean): unknown[] {
  return messages.map((message: any) => {
    const { images, ...rest } = message;
    if (message.role !== 'user' || !images?.length) return rest;
    if (ollama) return { ...rest, content: visualInputText(rest.content ?? ''), images: images.map((image: ChatImage) => image.data) };
    return { ...rest, content: [{ type: 'text', text: visualInputText(rest.content ?? '') }, ...images.map((image: ChatImage) => ({ type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.data}` } }))] };
  });
}

/** Base64 length is not text context usage. Image token limits are enforced by the server. */
export function messageTextLength(messages: unknown[]): number {
  return JSON.stringify(messages, (key, value) => key === 'images' ? '[image payload]' : value).length;
}

export class ModelHttpError extends Error {
  constructor(public status: number, public detail: string) { super(`Model server returned HTTP ${status}: ${detail}`); }
}

export function imageUnsupported(error: unknown): boolean {
  if (!(error instanceof ModelHttpError) || ![400, 415, 422, 500].includes(error.status)) return false;
  // Do not downgrade on authentication, context limits, corrupt images, or general outages.
  const detail = error.detail;
  if (/(?:invalid (?:image|base64)|corrupt|malformed|too large|exceeds|unsupported image format|image format.{0,20}not supported|context length|token limit)/i.test(detail)) return false;
  return /(?:does not|doesn't|do not|cannot|can't|not|no|only|unsupported|unavailable|missing|requires?)/i.test(detail)
    && /(?:support.{0,70}(?:image|vision|multimodal)|(?:image|vision|multimodal).{0,70}(?:support|capab|enabled|available)|text.only|only supports? text|(?:missing|requires?|no).{0,40}(?:vision encoder|image encoder|mmproj)|(?:image|vision) (?:input|content|type).{0,30}(?:unsupported|not allowed))/i.test(detail);
}
