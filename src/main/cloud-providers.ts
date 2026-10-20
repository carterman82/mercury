import type { ModelConnection, ModelInfo } from '../shared/types';
import type { ChatInput, ChatResult } from './providers';
import { requestJson, streamLines } from './providers';
import { ModelHttpError, visualInputText, type ChatImage } from './vision';
import { InactivityWatchdog } from './inactivity';
import { ThinkingLimitError } from './thinking-guard';

export function cloudEndpoint(connection: ModelConnection): string {
  const expected = connection.provider === 'openai' ? 'https://api.openai.com' : 'https://api.anthropic.com';
  if (connection.url.replace(/\/$/, '') !== expected) throw new Error(`Use ${expected} for this cloud provider.`);
  if (connection.auth && connection.provider !== 'openai') throw new Error('ChatGPT sign-in is only available for OpenAI.');
  return expected;
}
function headers(connection: ModelConnection, token: string): Record<string, string> {
  return connection.provider === 'claude' ? { 'x-api-key': token, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } : { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}
export async function cloudDiscover(connection: ModelConnection, token: string): Promise<ModelInfo[]> {
  const base = cloudEndpoint(connection);
  const models: ModelInfo[] = [];
  let after: string | undefined;
  const pages = new Set<string>();
  do {
    const suffix = after ? `?after_id=${encodeURIComponent(after)}` : '';
    const data = await requestJson(`${base}/v1/models${suffix}`, { headers: headers(connection, token), signal: AbortSignal.timeout(15_000) });
    const catalog = data.models ?? data.data ?? [];
    for (const item of catalog) {
      const id = String(item.slug ?? item.id);
      if (data.models && item.visibility !== 'list') continue;
      if (connection.provider === 'openai' && !data.models && !/^(gpt-|chatgpt-|o[1-9](?:-|$))/.test(id)) continue;
      models.push({ provider: connection.provider, connectionId: connection.id, connectionLabel: connection.label, id, label: item.display_name ?? id, available: true, contextLimit: item.context_window ?? item.context_length });
    }
    after = connection.provider === 'claude' && data.has_more ? data.last_id : undefined;
    if (after && pages.has(after)) throw new Error('The model catalog returned a repeated page.');
    if (after) pages.add(after);
  } while (after);
  return models;
}

export function responsesInput(messages: any[]): any[] {
  return messages.flatMap(message => {
    if (message.role === 'tool') return [{ type: 'function_call_output', call_id: message.tool_call_id, output: message.content }];
    const content = message.role === 'user' && message.images?.length ? [{ type: 'input_text', text: visualInputText(message.content ?? '') }, ...message.images.map((image: ChatImage) => ({ type: 'input_image', image_url: `data:${image.mimeType};base64,${image.data}` }))] : message.content;
    const items: any[] = content ? [{ role: message.role, content }] : [];
    for (const call of message.tool_calls ?? []) items.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
    return items;
  });
}
export function claudeInput(messages: any[]): { system?: string; messages: any[] } {
  const result: any[] = [];
  const system = messages.filter(item => item.role === 'system').map(item => item.content).join('\n\n');
  for (const message of messages.filter(item => item.role !== 'system')) {
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const content: any[] = message.role === 'tool' ? [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: message.content }] : message.content ? [{ type: 'text', text: message.content }] : [];
    if (message.role === 'user' && message.images?.length && content[0]?.type === 'text') content[0].text = visualInputText(message.content);
    if (message.role === 'user') for (const image of (message.images ?? []) as ChatImage[]) content.push({ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data } });
    for (const call of message.tool_calls ?? []) content.push({ type: 'tool_use', id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) });
    if (!content.length) continue;
    if (result.at(-1)?.role === role) result.at(-1).content.push(...content);
    else result.push({ role, content });
  }
  return { ...(system ? { system } : {}), messages: result };
}

export async function cloudChat(connection: ModelConnection, token: string, input: ChatInput): Promise<ChatResult> {
  const claude = connection.provider === 'claude';
  const tools = (input.tools ?? []) as any[];
  const body = claude
    ? { model: input.profile.model, ...claudeInput(input.messages), max_tokens: 8192, stream: true, ...(tools.length ? { tools: tools.map(tool => ({ name: tool.function.name, description: tool.function.description, input_schema: tool.function.parameters })) } : {}) }
    : { model: input.profile.model, input: responsesInput(input.messages), store: false, stream: true, ...(tools.length ? { tools: tools.map(tool => ({ type: 'function', ...tool.function, strict: false })) } : {}) };
  const idle = new InactivityWatchdog(120_000, new ThinkingLimitError('timeout'));
  const signal = AbortSignal.any([input.signal, idle.signal]);
  try {
  const response = await fetch(`${cloudEndpoint(connection)}/v1/${claude ? 'messages' : 'responses'}`, { method: 'POST', headers: headers(connection, token), body: JSON.stringify(body), signal, redirect: 'error' });
  let text = '';
  let reasoning = '';
  let completed = false;
  let usage: ChatResult['usage'];
  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  for await (const line of streamLines(response, signal)) {
    if (!line.startsWith('data:')) continue;
    const value = line.slice(5).trim();
    if (!value || value === '[DONE]') continue;
    const event = JSON.parse(value);
    const meaningful = event.delta?.text ?? event.delta?.thinking ?? event.delta?.partial_json ?? (typeof event.delta === 'string' ? event.delta : '');
    if ((typeof meaningful === 'string' && meaningful.trim()) || (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') || (event.type === 'response.output_item.added' && event.item?.type === 'function_call')) idle.progress();
    if (event.type === 'error' || event.type === 'response.failed' || event.type === 'response.incomplete') throw new ModelHttpError(400, event.error?.message ?? event.response?.error?.message ?? `Model request failed: ${event.type}.`);
    if (claude) {
      if (event.type === 'message_start') usage = { input: event.message?.usage?.input_tokens };
      if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') { input.onToolProgress?.(); calls.set(event.index, { id: event.content_block.id, name: event.content_block.name, arguments: '' }); }
      if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') { text += event.delta.text; input.onText?.(event.delta.text); }
        if (event.delta.type === 'thinking_delta') { reasoning = (reasoning + event.delta.thinking).slice(-100_000); input.onReasoning?.(event.delta.thinking); }
        if (event.delta.type === 'input_json_delta') {
          input.onToolProgress?.();
          const call = calls.get(event.index);
          if (call) call.arguments += event.delta.partial_json;
        }
      }
      if (event.type === 'message_delta') {
        usage = { ...usage, output: event.usage?.output_tokens };
        if (event.delta?.stop_reason === 'max_tokens' || event.delta?.stop_reason === 'refusal') throw new Error(`Claude stopped: ${event.delta.stop_reason}.`);
      }
      if (event.type === 'message_stop') completed = true;
    } else {
      if (event.type === 'response.output_text.delta') { text += event.delta; input.onText?.(event.delta); }
      if (event.type === 'response.reasoning_summary_text.delta') { reasoning = (reasoning + event.delta).slice(-100_000); input.onReasoning?.(event.delta); }
      if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') { input.onToolProgress?.(); calls.set(event.output_index, { id: event.item.call_id, name: event.item.name, arguments: event.item.arguments ?? '' }); }
      if (event.type === 'response.function_call_arguments.delta') {
        input.onToolProgress?.();
        const call = calls.get(event.output_index);
        if (call) call.arguments += event.delta;
      }
      if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') calls.set(event.output_index, { id: event.item.call_id, name: event.item.name, arguments: event.item.arguments });
      if (event.type === 'response.completed') {
        completed = true;
        usage = { input: event.response?.usage?.input_tokens, output: event.response?.usage?.output_tokens };
      }
    }
  }
  if (!completed) throw new Error('The model stream ended before the response completed. Try again.');
  return { text, ...(reasoning ? { reasoning } : {}), tools: [...calls.values()].map(call => ({ id: call.id, name: call.name, arguments: JSON.parse(call.arguments || '{}') })), usage };
  } catch (error) { if (signal.aborted) throw signal.reason; throw error; }
  finally { idle.dispose(); }
}
