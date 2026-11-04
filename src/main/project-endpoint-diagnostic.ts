import { z } from 'zod';
import { ToolFailure } from './tool-outcome';
export const endpointDiagnosticSchema = z.object({
  url: z.string().url().max(4000), method: z.enum(['GET', 'POST']).default('GET'),
  body: z.string().max(16000).optional(),
}).strict();
export function endpointDiagnosticRequest(raw: unknown) {
  const value = endpointDiagnosticSchema.parse(raw);
  const url = new URL(value.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash ||
      !/^\/(?:v1\/(?:models|chat\/completions)|api\/(?:tags|chat))\/?$/.test(url.pathname))
    throw new ToolFailure('DIAGNOSTIC_ENDPOINT_SCOPE', 'Only explicit model-list/chat diagnostic endpoints are supported. Credentials, fragments and redirects are not accepted.');
  if (value.method === 'GET' && value.body !== undefined) throw new ToolFailure('DIAGNOSTIC_BODY', 'GET diagnostics do not have a body.');
  if (value.method === 'POST') {
    let body: any; try { body = JSON.parse(value.body ?? ''); } catch { throw new ToolFailure('DIAGNOSTIC_BODY', 'Supply the exact JSON model test request for review.'); }
    if (!body || typeof body !== 'object' || Array.isArray(body) || body.stream === true)
      throw new ToolFailure('DIAGNOSTIC_BODY', 'Use a bounded non-streaming JSON model request.');
    body.stream = false;
    if (url.pathname.startsWith('/v1/')) body.max_tokens = Math.min(256, Math.max(1, Number(body.max_tokens) || 128));
    else body.options = { ...body.options, num_predict: Math.min(256, Math.max(1, Number(body.options?.num_predict) || 128)) };
    value.body = JSON.stringify(body);
  }
  return value;
}
/** Bounded, approved HTTP diagnostic. No source edits, installers or model swaps. */
export async function probeProjectEndpoint(raw: unknown, signal: AbortSignal, transport: typeof fetch = fetch) {
  const input = endpointDiagnosticRequest(raw);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Endpoint diagnostic timed out.')), 30000);
  const combined = AbortSignal.any([signal, controller.signal]);
  try {
    const response = await transport(input.url, { method: input.method, body: input.body,
      headers: { 'content-type': 'application/json' }, redirect: 'error', signal: combined });
    const reader = response.body?.getReader();
    const parts: Uint8Array[] = []; let bytes = 0, truncated = false;
    if (reader) try {
      while (true) {
        const item = await reader.read(); if (item.done) break;
        const remaining = 64000 - bytes;
        parts.push(item.value.slice(0, remaining)); bytes += Math.min(remaining, item.value.length);
        if (item.value.length > remaining || bytes >= 64000) { truncated = true; await reader.cancel(); break; }
      }
    } finally { reader.releaseLock(); }
    const output = Buffer.concat(parts).toString('utf8');
    let parsed: any; if (!truncated) try { parsed = JSON.parse(output); } catch { /* Preserve non-JSON server response. */ }
    return { ran: true, target: input.url, status: response.status, ok: response.ok, output, truncated,
      ...(parsed ? { summary: { model: parsed.model, models: Array.isArray(parsed.data) ? parsed.data.map((item: any) => item?.id).slice(0, 50) : undefined,
        finishReason: parsed.choices?.[0]?.finish_reason, content: parsed.choices?.[0]?.message?.content,
        reasoningCharacters: String(parsed.choices?.[0]?.message?.reasoning_content ?? parsed.choices?.[0]?.message?.reasoning ?? '').length,
        error: parsed.error } } : {}),
      interpretation: 'Observed diagnostic output only. HTTP errors, empty content and reasoning-only replies are different observations; none proves a network failure by itself.' };
  } catch (error) {
    signal.throwIfAborted();
    return { ran: true, target: input.url, ok: false, output: error instanceof Error ? error.message : String(error),
      interpretation: 'This request failed or timed out from Mercury. Server availability outside this execution context is unknown; do not assert the model/runtime is absent.' };
  } finally { clearTimeout(timer); }
}
