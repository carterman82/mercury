import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { ChatInput, ChatResult } from './providers';

/** No exporter is enabled here. An embedding host may register an OpenTelemetry SDK.
 * Never attach prompts, source, endpoints, model IDs, tool arguments or error messages. */
export async function measureModelRequest(input: ChatInput, run: (input: ChatInput) => Promise<ChatResult>): Promise<ChatResult> {
  return trace.getTracer('mercury', '0.1.0').startActiveSpan('mercury.model.request', async span => {
    span.setAttribute('mercury.provider', input.profile.provider);
    let queuedAt: number | undefined;
    try {
      const result = await run({ ...input, onRequestState: state => {
        if (state === 'queued') queuedAt = performance.now();
        if (state === 'running' && queuedAt !== undefined) {
          span.setAttribute('mercury.queue.duration_ms', performance.now() - queuedAt);
          queuedAt = undefined;
        }
        span.addEvent(`request.${state}`);
        input.onRequestState?.(state);
      } });
      span.setAttribute('mercury.tool_requests', result.tools.length);
      if (result.usage?.input !== undefined) span.setAttribute('mercury.tokens.input', result.usage.input);
      if (result.usage?.output !== undefined) span.setAttribute('mercury.tokens.output', result.usage.output);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setAttribute('mercury.cancelled', input.signal.aborted);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally { span.end(); }
  });
}
