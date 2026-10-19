import type { ModelConnection, ModelInfo, ModelProfile, Settings, ToolRequest } from '../shared/types';
import { ReasoningStream } from './reasoning';
import { cloudChat, cloudDiscover, cloudEndpoint } from './cloud-providers';

export interface ChatResult { text: string; reasoning?: string; tools: ToolRequest[]; usage?: { input?: number; output?: number }; }
export interface ChatInput { profile: ModelProfile; messages: unknown[]; tools?: unknown[]; signal: AbortSignal; disableThinking?: boolean; onText?: (delta: string) => void; onReasoning?: (delta: string) => void; onToolProgress?: () => void; }
export interface ModelProvider {
  discover(connection: ModelConnection): Promise<ModelInfo[]>;
  chat(input: ChatInput): Promise<ChatResult>;
  probe(profile: ModelProfile, signal?: AbortSignal): Promise<boolean>;
}

export function endpoint(raw: string): string {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Enter an HTTP or HTTPS server address without a path, credentials, or query.');
  }
  return url.toString().replace(/\/$/, '');
}

export async function requestJson(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, { ...init, redirect: 'error' });
  if (!response.ok) throw new Error(`Model server returned HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
  return response.json();
}

export async function* streamLines(response: Response, signal: AbortSignal): AsyncGenerator<string> {
  if (!response.ok) throw new Error(`Model server returned HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
  if (!response.body) throw new Error('Model server did not provide a response stream.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      if (signal.aborted) throw new Error('Model request cancelled.');
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trimEnd();
        buffer = buffer.slice(index + 1);
        if (line) yield line;
      }
      if (buffer.length > 2_000_000) throw new Error('Model server sent an oversized stream chunk.');
      if (done) break;
    }
    if (buffer.trim()) yield buffer.trim();
  } finally { reader.releaseLock(); }
}

export class LocalProviders implements ModelProvider {
  constructor(private settings: () => Settings, private tokenFor: (id: string) => string | undefined = () => undefined, private connectionFailed: () => void = () => {}, private chatGPTToken: (id: string) => Promise<string> = async () => { throw new Error('ChatGPT sign-in is unavailable.'); }) {}

  private async cloudToken(connection: ModelConnection): Promise<string> {
    const token = connection.auth === 'chatgpt' ? await this.chatGPTToken(connection.id) : connection.apiToken || this.tokenFor(connection.id);
    if (!token) throw new Error(`Connect ${connection.provider === 'claude' ? 'Claude' : 'OpenAI'} in Model settings first.`);
    return token;
  }

  private headers(id?: string, oneTimeToken?: string): Record<string, string> {
    const token = oneTimeToken || (id ? this.tokenFor(id) : undefined);
    if (token && !oneTimeToken) {
      const connection = this.settings().connections.find(item => item.id === id);
      if (!connection || connection.auth || connection.provider === 'openai' || connection.provider === 'claude') throw new Error('Saved credentials need a matching local connection.');
    }
    return token ? { authorization: `Bearer ${token}` } : {};
  }

  private url(profile: ModelProfile): string {
    const selected = this.settings().connections.find(item => item.id === profile.connectionId);
    if (selected && selected.provider !== profile.provider) throw new Error('The model needs a matching saved connection.');
    if (selected && profile.endpoint && endpoint(profile.endpoint) !== endpoint(selected.url)) throw new Error('Change the saved connection address in Model settings.');
    const legacy = this.settings().connections.find(item => item.provider === profile.provider);
    return endpoint(profile.endpoint ?? selected?.url ?? legacy?.url ?? '');
  }

  async discover(connection: ModelConnection): Promise<ModelInfo[]> {
    if (connection.provider === 'openai' || connection.provider === 'claude') {
      cloudEndpoint(connection);
      return cloudDiscover(connection, await this.cloudToken(connection));
    }
    const base = endpoint(connection.url);
    const kind = connection.provider;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      if (kind === 'ollama') {
        const data = await requestJson(`${base}/api/tags`, { signal: controller.signal, headers: this.headers(connection.id, connection.apiToken) });
        return (data.models ?? []).map((model: any) => ({ provider: kind, connectionId: connection.id, connectionLabel: connection.label, id: String(model.name), label: String(model.name), available: true }));
      }
      const data = await requestJson(`${base}/api/v1/models`, { signal: controller.signal, headers: this.headers(connection.id, connection.apiToken) });
      return (data.models ?? data.data ?? []).filter((model: any) => !model.type || model.type === 'llm').map((model: any) => ({
        provider: kind, connectionId: connection.id, connectionLabel: connection.label, id: String(model.key ?? model.id), label: String(model.display_name ?? model.key ?? model.id),
        available: Boolean(model.loaded_instances?.length ?? model.loaded),
        contextLimit: model.max_context_length ?? model.context_length,
        toolCapable: model.capabilities?.trained_for_tool_use,
      }));
    } finally { clearTimeout(timer); }
  }

  async chat(input: ChatInput): Promise<ChatResult> {
    if (input.profile.provider === 'openai' || input.profile.provider === 'claude') {
      const connection = this.settings().connections.find(item => item.id === input.profile.connectionId && item.provider === input.profile.provider);
      if (!connection) throw new Error('This cloud account is disconnected. Connect it in Model settings.');
      cloudEndpoint(connection);
      try { return await cloudChat(connection, await this.cloudToken(connection), input); }
      catch (error) { this.connectionFailed(); throw error; }
    }
    const base = this.url(input.profile);
    const isOllama = input.profile.provider === 'ollama';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Model response timed out.')), 600_000);
    const abort = () => controller.abort(input.signal.reason);
    input.signal.addEventListener('abort', abort, { once: true });
    if (input.signal.aborted) abort();
    const tools = input.tools?.length ? { tools: input.tools } : {};
    const body = isOllama
      ? { model: input.profile.model, messages: input.messages, ...tools, stream: true, ...(input.disableThinking ? { think: /gpt-oss/i.test(input.profile.model) ? 'low' : false } : {}), options: { num_ctx: input.profile.contextLimit } }
      : { model: input.profile.model, messages: input.messages, ...tools, stream: true };
    try {
      const response = await fetch(isOllama ? `${base}/api/chat` : `${base}/v1/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...this.headers(input.profile.connectionId) }, body: JSON.stringify(body), signal: controller.signal, redirect: 'error',
      });
      let text = '';
      let reasoning = '';
      const thinking = (delta: unknown) => {
        if (typeof delta !== 'string' || !delta) return;
        reasoning += delta;
        input.onReasoning?.(delta);
      };
      const content = new ReasoningStream(delta => { text += delta; input.onText?.(delta); }, thinking);
      let usage: ChatResult['usage'];
      const calls = new Map<number, { id: string; name: string; arguments: string }>();
      let ollamaCallIndex = 0;
      for await (const line of streamLines(response, controller.signal)) {
        if (controller.signal.aborted) throw controller.signal.reason;
        const json = isOllama ? line : line.startsWith('data:') ? line.slice(5).trim() : '';
        if (!json || json === '[DONE]') continue;
        const chunk = JSON.parse(json);
        if (isOllama) {
          thinking(chunk.message?.thinking);
          const delta = chunk.message?.content ?? '';
          if (typeof delta === 'string') content.push(delta);
          for (const call of chunk.message?.tool_calls ?? []) {
            input.onToolProgress?.();
            const index = ollamaCallIndex++;
            calls.set(index, { id: `call_${index}`, name: String(call.function?.name ?? ''), arguments: JSON.stringify(call.function?.arguments ?? {}) });
          }
          if (chunk.done) usage = { input: chunk.prompt_eval_count, output: chunk.eval_count };
        } else {
          const delta = chunk.choices?.[0]?.delta ?? {};
          thinking(delta.reasoning_content ?? delta.reasoning);
          if (typeof delta.content === 'string') content.push(delta.content);
          for (const item of delta.tool_calls ?? []) {
            input.onToolProgress?.();
            const prior = calls.get(item.index) ?? { id: `call_${item.index}`, name: '', arguments: '' };
            if (item.id) prior.id = item.id;
            if (item.function?.name) prior.name += item.function.name;
            if (item.function?.arguments) prior.arguments += item.function.arguments;
            calls.set(item.index, prior);
          }
          if (chunk.usage) usage = { input: chunk.usage.prompt_tokens, output: chunk.usage.completion_tokens };
        }
      }
      content.finish();
      const parsed: ToolRequest[] = [...calls.values()].map(call => ({ id: call.id, name: call.name, arguments: JSON.parse(call.arguments || '{}') }));
      return { text, ...(reasoning ? { reasoning } : {}), tools: parsed, usage };
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason ?? new Error('Model request cancelled or timed out.');
      if (error instanceof TypeError || /Model server returned HTTP (?:401|403|404|5\d\d)/.test(String(error))) this.connectionFailed();
      throw error;
    } finally {
      clearTimeout(timeout);
      input.signal.removeEventListener('abort', abort);
    }
  }

  async probe(profile: ModelProfile, signal?: AbortSignal): Promise<boolean> {
    const controller = new AbortController();
    const tools = [{ type: 'function', function: { name: 'probe', description: 'Return the word ready.', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } } }];
    const result = await this.chat({ profile, messages: [{ role: 'user', content: 'Call the probe tool with value ready.' }], tools, signal: signal ?? controller.signal });
    return result.tools.some(call => call.name === 'probe' && (call.arguments as any)?.value === 'ready');
  }
}
