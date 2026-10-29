import type { CodexService } from './codex';
import type { ModelConnection, ModelInfo, ModelProfile, Settings, ToolRequest } from '../shared/types';
import { ReasoningStream } from './reasoning';
import { cloudChat, cloudDiscover, cloudEndpoint } from './cloud-providers';
import { documentTextMessages, documentUnsupported, hasDocuments, hasImages, imageUnsupported, localImageMessages, ModelHttpError, textOnlyMessages } from './vision';
import { ModelRequests } from './model-requests';
import { AgentScheduler, type AgentLease } from './agent-scheduler';
import { connectionGroups } from '../shared/connections';
import { InactivityWatchdog } from './inactivity';
import { ThinkingLimitError } from './thinking-guard';
import { isSubscription, openAIRoutes } from '../shared/openai-routing';

export interface ChatResult { text: string; reasoning?: string; tools: ToolRequest[]; usage?: { input?: number; output?: number }; }
export interface ProviderToolChoice { type: 'auto' | 'any' | 'tool' | 'none'; name?: string; disable_parallel_tool_use?: boolean; }
export interface ChatInput { profile: ModelProfile; agentLease?: symbol; messages: unknown[]; tools?: unknown[]; signal: AbortSignal; inactivityMs?: number; maxOutputTokens?: number; toolChoice?: ProviderToolChoice; disableThinking?: boolean; onRoutingNotice?: (notice: string) => void; onRequestState?: (state: 'queued' | 'running') => void; onImageFallback?: (reason?: string) => void; onFileFallback?: (reason?: string) => void; onText?: (delta: string) => void; onReasoning?: (delta: string) => void; onToolProgress?: () => void; }
export interface NativeMessagesInput { profile: ModelProfile; body: Record<string, unknown>; headers?: Record<string, string>; signal: AbortSignal; agentLease?: symbol; onRoutingNotice?: ChatInput['onRoutingNotice']; onRequestState?: ChatInput['onRequestState']; }
export interface ChatInput { reportMode?: boolean; }
export interface ModelProvider {
  loadedContextLimit?(profile: ModelProfile, signal: AbortSignal): Promise<number | null>;
  reserveAgent?(profiles: ModelProfile[], avoid?: ModelProfile): AgentLease;
  discover(connection: ModelConnection): Promise<ModelInfo[]>;
  chat(input: ChatInput): Promise<ChatResult>;
  messages?(input: NativeMessagesInput): Promise<Response | null>;
  probe(profile: ModelProfile, signal?: AbortSignal): Promise<boolean>;
  viewingCapabilities?(profile: ModelProfile, signal: AbortSignal): Promise<{ images: boolean | null; nativeFiles: boolean }>;
}

function subscriptionUnavailable(error: unknown): boolean {
  if (documentUnsupported(error)) return false;
  if (error instanceof ModelHttpError && ([401, 403, 404, 408, 429].includes(error.status) || error.status >= 500)) return true;
  if (error instanceof TypeError && /fetch|network|connection/i.test(error.message)) return true;
  const message = error instanceof Error ? error.message : '';
  if (/context|invalid|malformed|native tool|unoffered|too large/i.test(message)) return false;
  if (/^(?:Reconnect (?:your )?ChatGPT|Connect your ChatGPT account)/i.test(message)) return true;
  if (/^Codex response timed out/i.test(message)) return true;
  return /(?:usage|rate|plan|subscription|quota).{0,50}(?:limit|exhaust|reach|exceed|unavailable)|(?:signed out|sign.in.{0,30}(?:unavailable|expired|required)|disconnected|ECONNREFUSED|ECONNRESET|ENOTFOUND|Codex.{0,40}(?:not found|not installed|unavailable|exited))/i.test(message);
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
  if (!response.ok) throw new ModelHttpError(response.status, (await response.text()).slice(0, 500));
  return response.json();
}

export async function* streamLines(response: Response, signal: AbortSignal): AsyncGenerator<string> {
  if (!response.ok) throw new ModelHttpError(response.status, (await response.text()).slice(0, 500));
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
  async loadedContextLimit(profile: ModelProfile, signal: AbortSignal): Promise<number | null> {
    if (profile.provider !== 'lmstudio') return null;
    try {
      const response = await requestJson(`${this.url(profile)}/api/v1/models`, { headers: this.headers(profile.connectionId), signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
      const model = response.models?.find((item: any) => item.key === profile.model || item.loaded_instances?.some((instance: any) => instance.id === profile.model));
      const limits = (model?.loaded_instances ?? []).map((instance: any) => instance.config?.context_length).filter((limit: any) => Number.isSafeInteger(limit) && limit > 0);
      return limits.length ? Math.min(...limits) : null;
    } catch { signal.throwIfAborted(); return null; }
  }
  private cloudModels: ModelInfo[] = [];
  private textOnlyModels = new Map<string, number>();
  private modelMetadata = new Map<string, { parallel?: number; vision?: boolean; canonical: string; checkedAt?: number }>();
  private requests: ModelRequests;
  private scheduler = new AgentScheduler(profile => {
    const capacity = this.requestCapacity(profile);
    const connection = this.settings().connections.find(item => item.id === profile.connectionId);
    const device = connection ? connectionGroups([connection], [])[0].id : capacity.base;
    const pool = this.requestCounts.find(item => item.key === capacity.key);
    return { ...capacity, device, active: (pool?.active ?? 0) + (pool?.queued ?? 0) };
  });
  reserveAgent(profiles: ModelProfile[], avoid?: ModelProfile): AgentLease { return this.scheduler.reserve(profiles, avoid); }
  get requestCounts() { return this.requests.snapshot(); }
  constructor(private settings: () => Settings, private tokenFor: (id: string) => string | undefined = () => undefined, private connectionFailed: () => void = () => {}, private chatGPTToken: (id: string) => Promise<string> = async () => { throw new Error('ChatGPT sign-in is unavailable.'); }, requestsChanged: () => void = () => {}, private codex?: CodexService) { this.requests = new ModelRequests(requestsChanged); }

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

  rememberModels(models: ModelInfo[], connections: ModelConnection[]): void {
    this.cloudModels = models.filter(model => ['openai', 'codex'].includes(model.provider) && connections.some(connection => connection.id === model.connectionId && connection.provider === model.provider)).map(model => ({ ...model }));
    for (const model of models) {
      const connection = connections.find(item => item.id === model.connectionId && item.provider === model.provider);
      if (!connection || !['lmstudio', 'ollama'].includes(model.provider)) continue;
      const key = JSON.stringify([model.provider, endpoint(connection.url), model.id]);
      const previous = this.modelMetadata.get(key);
      this.modelMetadata.set(key, { canonical: model.id, vision: model.visionCapable ?? previous?.vision, parallel: model.parallelRequests ?? previous?.parallel, checkedAt: typeof model.visionCapable === 'boolean' ? Date.now() : previous?.checkedAt });
    }
  }

  async discover(connection: ModelConnection): Promise<ModelInfo[]> {
    if (connection.provider === 'codex') {
      if (!this.codex) throw new Error('Codex is unavailable. Connect it in Model settings.');
      const models = await this.codex.discover(connection);
      this.rememberCloudConnection(connection, models);
      return models;
    }
    if (connection.provider === 'openai' || connection.provider === 'claude') {
      cloudEndpoint(connection);
      const models = await cloudDiscover(connection, await this.cloudToken(connection));
      this.rememberCloudConnection(connection, models);
      return models;
    }
    const base = endpoint(connection.url);
    const kind = connection.provider;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      if (kind === 'ollama') {
        const init = { signal: controller.signal, headers: this.headers(connection.id, connection.apiToken) };
        const [data, running] = await Promise.all([
          requestJson(`${base}/api/tags`, init),
          requestJson(`${base}/api/ps`, init).catch(() => null),
        ]);
        const models: ModelInfo[] = (data.models ?? []).map((model: any) => ({ provider: kind, connectionId: connection.id, connectionLabel: connection.label, id: String(model.name), label: String(model.name), available: Boolean(running?.models?.some((loaded: any) => loaded.name === model.name || (model.digest && loaded.digest === model.digest))) }));
        // Fetch architecture context metadata without loading models. Bound parallel
        // requests and tolerate older servers that only implement the model list.
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(4, models.length) }, async () => {
          while (next < models.length) {
            const model = models[next++];
            try {
              const details = await requestJson(`${base}/api/show`, { ...init, method: 'POST', headers: { ...init.headers, 'content-type': 'application/json' }, body: JSON.stringify({ model: model.id }) });
              if (Array.isArray(details.capabilities)) {
                model.visionCapable = details.capabilities.includes('vision');
                model.toolCapable = details.capabilities.includes('tools');
              }
              const info = details.model_info ?? {};
              const maximum = info[`${info['general.architecture']}.context_length`] ?? Object.entries(info).find(([key]) => key.endsWith('.context_length'))?.[1];
              if (Number.isSafeInteger(maximum) && maximum >= 2048) model.contextLimit = maximum;
            } catch { /* Keep the catalog usable when optional metadata is absent. */ }
          }
        }));
        for (const model of models) this.modelMetadata.set(JSON.stringify([kind, base, model.id]), { canonical: model.id, vision: model.visionCapable, checkedAt: Date.now() });
        return models;
      }
      const data = await requestJson(`${base}/api/v1/models`, { signal: controller.signal, headers: this.headers(connection.id, connection.apiToken) });
      return (data.models ?? data.data ?? []).filter((model: any) => !model.type || model.type === 'llm').map((model: any) => {
        const id = String(model.key ?? model.id);
        const parallel = model.loaded_instances?.[0]?.config?.parallel;
        const info = { canonical: id, vision: typeof model.capabilities?.vision === 'boolean' ? model.capabilities.vision : undefined, checkedAt: Date.now(), parallel: Number.isInteger(parallel) && parallel > 0 ? Math.min(parallel, 32) : undefined };
        for (const alias of [id, ...(model.loaded_instances ?? []).map((instance: any) => instance.id)]) this.modelMetadata.set(JSON.stringify([kind, base, alias]), info);
        return {
        provider: kind, connectionId: connection.id, connectionLabel: connection.label, id: String(model.key ?? model.id), label: String(model.display_name ?? model.key ?? model.id),
        available: Boolean(model.loaded_instances?.length ?? model.loaded),
        contextLimit: model.max_context_length ?? model.context_length,
        toolCapable: model.capabilities?.trained_for_tool_use,
        ...(typeof info.vision === 'boolean' ? { visionCapable: info.vision } : {}),
        ...(info.parallel ? { parallelRequests: info.parallel } : {}),
      }; });
    } finally { clearTimeout(timer); }
  }

  private rememberCloudConnection(connection: ModelConnection, models: ModelInfo[]): void {
    this.cloudModels = [...this.cloudModels.filter(model => model.connectionId !== connection.id), ...models.filter(model => model.provider === 'openai' || model.provider === 'codex')];
  }

  async viewingCapabilities(profile: ModelProfile, signal: AbortSignal): Promise<{ images: boolean | null; nativeFiles: boolean }> {
    signal.throwIfAborted();
    if (profile.provider === 'openai' || profile.provider === 'claude') return { images: true, nativeFiles: true };
    if (profile.provider === 'codex') {
      const model = this.cloudModels.find(item => item.provider === 'codex' && item.connectionId === profile.connectionId && item.id === profile.model);
      return { images: model?.visionCapable ?? null, nativeFiles: false };
    }
    const base = this.url(profile);
    const key = JSON.stringify([profile.provider, base, profile.model]);
    const cached = this.modelMetadata.get(key);
    if (typeof cached?.vision === 'boolean' && Date.now() - (cached.checkedAt ?? 0) < 5 * 60_000) return { images: cached.vision, nativeFiles: false };
    const connection = this.settings().connections.find(item => item.id === profile.connectionId && item.provider === profile.provider)
      ?? this.settings().connections.find(item => item.provider === profile.provider && endpoint(item.url) === base);
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('Model capability check timed out.')), 5_000);
    try {
      signal.throwIfAborted();
      const headers = this.headers(connection?.id, connection?.apiToken);
      if (profile.provider === 'ollama') {
        const details = await requestJson(`${base}/api/show`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ model: profile.model }), signal: controller.signal });
        if (Array.isArray(details.capabilities)) this.modelMetadata.set(key, { ...cached, canonical: cached?.canonical ?? profile.model, vision: details.capabilities.includes('vision'), checkedAt: Date.now() });
        else return { images: null, nativeFiles: false };
      } else {
        const data = await requestJson(`${base}/api/v1/models`, { headers, signal: controller.signal });
        for (const model of data.models ?? data.data ?? []) {
          if (model.type && model.type !== 'llm') continue;
          const id = String(model.key ?? model.id);
          const parallel = model.loaded_instances?.[0]?.config?.parallel;
          const info = { canonical: id, vision: typeof model.capabilities?.vision === 'boolean' ? model.capabilities.vision : undefined, checkedAt: Date.now(), parallel: Number.isInteger(parallel) && parallel > 0 ? Math.min(parallel, 32) : undefined };
          for (const alias of [id, ...(model.loaded_instances ?? []).map((instance: any) => instance.id)]) this.modelMetadata.set(JSON.stringify([profile.provider, base, alias]), info);
        }
      }
      signal.throwIfAborted();
      return { images: this.modelMetadata.get(key)?.vision ?? null, nativeFiles: false };
    } catch {
      signal.throwIfAborted();
      return { images: null, nativeFiles: false };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  }

  async chat(input: ChatInput): Promise<ChatResult> {
    const connections = this.settings().connections;
    const routes = openAIRoutes(input.profile, connections, this.cloudModels);
    for (let index = 0; index < routes.length; index++) {
      input.signal.throwIfAborted();
      const profile = routes[index];
      const connection = connections.find(item => item.id === profile.connectionId && item.provider === profile.provider);
      if (connection && (profile.provider === 'openai' || profile.provider === 'codex')) input.onRoutingNotice?.(isSubscription(connection)
        ? `Using ${connection!.label} subscription for ${profile.model}.`
        : `Using ${connection!.label} for ${profile.model}; API charges apply. No matching subscription is available for this request.`);
      let emitted = false;
      try {
        return await this.chatOnConnection({ ...input, profile,
          onText: delta => { if (delta) emitted = true; input.onText?.(delta); },
          onReasoning: delta => { if (delta) emitted = true; input.onReasoning?.(delta); },
          onToolProgress: () => { emitted = true; input.onToolProgress?.(); },
        });
      } catch (error) {
        input.signal.throwIfAborted();
        if (emitted || index === routes.length - 1 || !isSubscription(connection) || !subscriptionUnavailable(error)) throw error;
      }
    }
    throw new Error('No model connection is available.');
  }

  private requestCapacity(profile: ModelProfile) {
    const connection = this.settings().connections.find(item => item.id === profile.connectionId && item.provider === profile.provider);
    const base = profile.provider === 'openai' || profile.provider === 'claude' ? connection?.url ?? profile.endpoint ?? '' : this.url(profile);
    const metadata = this.modelMetadata.get(JSON.stringify([profile.provider, base, profile.model]));
    const limit = Math.max(1, Math.min(32, connection?.maxConcurrentRequests ?? metadata?.parallel ?? (profile.provider === 'ollama' ? 1 : 4)));
    const server = profile.provider === 'lmstudio' || profile.provider === 'ollama' ? new URL(base) : null;
    if (server && ['localhost', '127.0.0.1', '[::1]'].includes(server.hostname.toLowerCase())) server.hostname = '127.0.0.1';
    const key = JSON.stringify([profile.provider, server?.toString().replace(/\/$/, '') ?? base, metadata?.canonical ?? profile.model]);
    return { base, key, limit };
  }

  /** Native Messages transport keeps credentials and request slots inside Mercury.
   * OpenAI/Codex deliberately use chat() so their established routing is retained. */
  async messages(input: NativeMessagesInput): Promise<Response | null> {
    if (!['claude', 'ollama', 'lmstudio'].includes(input.profile.provider)) return null;
    input.signal.throwIfAborted();
    const connection = this.settings().connections.find(item => item.id === input.profile.connectionId && item.provider === input.profile.provider);
    if (!connection) throw new Error('This model connection is unavailable.');
    if (input.profile.provider === 'claude') cloudEndpoint(connection);
    const { base, key, limit } = this.requestCapacity(input.profile);
    const finish = this.scheduler.requestStarted(input.agentLease, key);
    let release: (() => void) | undefined;
    const controller = new AbortController();
    let idle: InactivityWatchdog | undefined;
    let nativeSignal: AbortSignal | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return; cleaned = true;
      input.signal.removeEventListener('abort', abort);
      nativeSignal?.removeEventListener('abort', nativeAborted);
      idle?.dispose(); release?.(); finish();
    };
    const abort = () => {
      controller.abort(input.signal.reason);
      void reader?.cancel(input.signal.reason).catch(() => {});
      cleanup();
    };
    const nativeAborted = () => { void reader?.cancel(nativeSignal?.reason).catch(() => {}); cleanup(); };
    input.signal.addEventListener('abort', abort, { once: true });
    try {
      release = await this.requests.acquire(key, { ...input.profile, endpoint: base }, limit, input.signal, () => input.onRequestState?.('queued'));
      if (cleaned) { release(); input.signal.throwIfAborted(); throw new Error('Native model request was cancelled.'); }
      input.signal.throwIfAborted(); input.onRequestState?.('running');
      idle = new InactivityWatchdog(120_000, new ThinkingLimitError('timeout'));
      nativeSignal = AbortSignal.any([input.signal, controller.signal, idle.signal]);
      nativeSignal.addEventListener('abort', nativeAborted, { once: true });
      const requestSignal = nativeSignal;
      const forwarded = Object.fromEntries(Object.entries(input.headers ?? {}).filter(([name]) => name.toLowerCase().startsWith('anthropic-') || name.toLowerCase().startsWith('x-claude-code-')));
      const headers: Record<string, string> = { 'anthropic-version': '2023-06-01', ...forwarded, 'content-type': 'application/json' };
      if (input.profile.provider === 'claude') headers['x-api-key'] = await this.cloudToken(connection);
      else Object.assign(headers, this.headers(connection.id));
      const response = await fetch(`${base}/v1/messages`, { method: 'POST', headers, body: JSON.stringify({ ...input.body, model: input.profile.model }), signal: requestSignal, redirect: 'error' });
      if (input.profile.provider !== 'claude' && [404, 405].includes(response.status)) { await response.body?.cancel(); cleanup(); return null; }
      if (!response.body) { cleanup(); return response; }
      reader = response.body.getReader();
      const upstream = reader;
      const decoder = new TextDecoder(); let lines = '';
      const progress = (chunk: Uint8Array) => {
        lines += decoder.decode(chunk, { stream: true });
        if (lines.length > 2_000_000) throw new Error('Native Messages response has an oversized frame.');
        let newline: number;
        while ((newline = lines.indexOf('\n')) >= 0) {
          const line = lines.slice(0, newline); lines = lines.slice(newline + 1);
          if (!line.startsWith('data:')) continue;
          try {
            const event = JSON.parse(line.slice(5).trim());
            const content = event.delta?.text ?? event.delta?.thinking ?? event.delta?.partial_json;
            if ((typeof content === 'string' && content.trim()) || (event.type === 'content_block_start' && event.content_block?.type === 'tool_use')) idle?.progress();
          } catch { /* Preserve native bytes; malformed payloads are reported by the SDK. */ }
        }
      };
      const stream = new ReadableStream<Uint8Array>({
        async pull(target) {
          try {
            requestSignal.throwIfAborted();
            const next = await upstream.read();
            if (next.done) { cleanup(); target.close(); }
            else { progress(next.value); target.enqueue(next.value); }
          } catch (error) { cleanup(); target.error(error); }
        },
        async cancel(reason) { try { controller.abort(reason); await upstream.cancel(reason); } finally { cleanup(); } },
      });
      return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) {
      cleanup(); input.signal.throwIfAborted();
      if (nativeSignal?.aborted) throw nativeSignal.reason;
      if (controller.signal.aborted) throw controller.signal.reason;
      throw error;
    }
  }
  private async chatOnConnection(input: ChatInput): Promise<ChatResult> {
    const { base, key, limit } = this.requestCapacity(input.profile);
    const finish = this.scheduler.requestStarted(input.agentLease, key);
    try {
      const release = await this.requests.acquire(key, { ...input.profile, endpoint: base }, limit, input.signal, () => input.onRequestState?.('queued'));
      try {
        input.signal.throwIfAborted(); input.onRequestState?.('running');
        return await this.chatWithDocuments(input);
      } finally { release(); }
    } finally { finish(); }
  }

  private async chatWithDocuments(input: ChatInput): Promise<ChatResult> {
    if (!hasDocuments(input.messages)) return this.chatWithImages(input);
    let emitted = false;
    try {
      return await this.chatWithImages({ ...input,
        onText: delta => { if (delta) emitted = true; input.onText?.(delta); },
        onReasoning: delta => { if (delta) emitted = true; input.onReasoning?.(delta); },
        onToolProgress: () => { emitted = true; input.onToolProgress?.(); },
      });
    } catch (error) {
      input.signal.throwIfAborted();
      if (emitted || !documentUnsupported(error)) throw error;
      input.onFileFallback?.('The model could not read the attached file directly. Using extracted content and available plugins.');
      return this.chatWithImages({ ...input, messages: documentTextMessages(input.messages) });
    }
  }

  private async chatWithImages(input: ChatInput): Promise<ChatResult> {
    if (!hasImages(input.messages)) return this.chatOnce(input);
    const key = JSON.stringify([input.profile.provider, input.profile.connectionId, input.profile.endpoint, input.profile.model]);
    const fallback = () => {
      input.signal.throwIfAborted();
      input.onImageFallback?.('The server reported that this model cannot accept image input.');
      return this.chatOnce({ ...input, messages: textOnlyMessages(input.messages) });
    };
    if ((this.textOnlyModels.get(key) ?? 0) > Date.now()) return fallback();
    if (input.profile.provider === 'ollama' || input.profile.provider === 'lmstudio') {
      const metadata = this.modelMetadata.get(JSON.stringify([input.profile.provider, this.url(input.profile), input.profile.model]));
      if (metadata?.vision === false) return fallback();
    }
    let emitted = false;
    try {
      return await this.chatOnce({ ...input,
        onText: delta => { if (delta) emitted = true; input.onText?.(delta); },
        onReasoning: delta => { if (delta) emitted = true; input.onReasoning?.(delta); },
        onToolProgress: () => { emitted = true; input.onToolProgress?.(); },
      });
    } catch (error) {
      input.signal.throwIfAborted();
      if (emitted || !imageUnsupported(error)) throw error;
      if (this.textOnlyModels.size >= 100) this.textOnlyModels.clear();
      this.textOnlyModels.set(key, Date.now() + 5 * 60_000);
      return fallback();
    }
  }

  private async chatOnce(input: ChatInput): Promise<ChatResult> {
    if (input.profile.provider === 'codex') {
      if (!this.codex || !this.settings().connections.some(item => item.id === input.profile.connectionId && item.provider === 'codex')) throw new Error('Codex is disconnected. Connect it in Model settings.');
      try { return await this.codex.chat(input); }
      catch (error) { if (!input.signal.aborted) this.connectionFailed(); throw error; }
    }
    if (input.profile.provider === 'openai' || input.profile.provider === 'claude') {
      const connection = this.settings().connections.find(item => item.id === input.profile.connectionId && item.provider === input.profile.provider);
      if (!connection) throw new Error('This cloud account is disconnected. Connect it in Model settings.');
      cloudEndpoint(connection);
      try { return await cloudChat(connection, await this.cloudToken(connection), input); }
      catch (error) { this.connectionFailed(); throw error; }
    }
    const base = this.url(input.profile);
    if (input.reportMode && input.profile.provider === 'lmstudio' && !input.tools?.length) {
      const messages = input.messages as { role: string; content: string }[];
      const response = await requestJson(`${base}/api/v1/chat`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...this.headers(input.profile.connectionId) },
        signal: AbortSignal.any([input.signal, AbortSignal.timeout(input.inactivityMs ?? 600000)]),
        body: JSON.stringify({ model: input.profile.model, system_prompt: messages.filter(message => message.role === 'system').map(message => message.content).join('\n'), input: messages.filter(message => message.role !== 'system').map(message => message.content).join('\n'), reasoning: 'off', store: false, integrations: [], max_output_tokens: input.maxOutputTokens }),
      });
      if (input.maxOutputTokens && response.stats?.total_output_tokens >= input.maxOutputTokens - 1) throw new Error('The report reached its output token limit before finishing.');
      const text = (response.output ?? []).filter((item: any) => item.type === 'message').map((item: any) => item.content).join('\n');
      input.onText?.(text);
      return { text, tools: [] };
    }
    const isOllama = input.profile.provider === 'ollama';
    const controller = new AbortController();
    const idle = new InactivityWatchdog(input.inactivityMs ?? 120_000, new ThinkingLimitError('timeout'));
    const idleAbort = () => controller.abort(idle.signal.reason);
    idle.signal.addEventListener('abort', idleAbort, { once: true });
    const abort = () => controller.abort(input.signal.reason);
    input.signal.addEventListener('abort', abort, { once: true });
    if (input.signal.aborted) abort();
    const tools = input.tools?.length ? { tools: input.tools } : {};
    const body = isOllama
      ? { model: input.profile.model, messages: localImageMessages(input.messages, true), ...tools, stream: true, ...(input.disableThinking ? { think: /gpt-oss/i.test(input.profile.model) ? 'low' : false } : {}), options: { num_ctx: input.profile.contextLimit, ...(input.maxOutputTokens ? { num_predict: input.maxOutputTokens } : {}) } }
      : { model: input.profile.model, messages: localImageMessages(input.messages, false), ...tools, stream: true, ...(input.disableThinking ? { reasoning: { effort: 'none' } } : {}), ...(input.maxOutputTokens ? { max_tokens: input.maxOutputTokens } : {}), ...(input.toolChoice ? { tool_choice: input.toolChoice.type === 'tool' ? { type: 'function', function: { name: input.toolChoice.name } } : input.toolChoice.type === 'any' ? 'required' : input.toolChoice.type, ...(input.toolChoice.disable_parallel_tool_use !== undefined ? { parallel_tool_calls: !input.toolChoice.disable_parallel_tool_use } : {}) } : {}) };
    try {
      const response = await fetch(isOllama ? `${base}/api/chat` : `${base}/v1/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...this.headers(input.profile.connectionId) }, body: JSON.stringify(body), signal: controller.signal, redirect: 'error',
      });
      let text = '';
      let reasoning = '';
      const thinking = (delta: unknown) => {
        if (typeof delta !== 'string' || !delta) return;
        if (delta.trim()) idle.progress();
        reasoning = (reasoning + delta).slice(-100_000);
        input.onReasoning?.(delta);
      };
      const content = new ReasoningStream(delta => { if (delta.trim()) idle.progress(); text += delta; input.onText?.(delta); }, thinking);
      let usage: ChatResult['usage'];
      const calls = new Map<number, { id: string; name: string; arguments: string }>();
      let ollamaCallIndex = 0;
      let completed = false;
      for await (const line of streamLines(response, controller.signal)) {
        if (controller.signal.aborted) throw controller.signal.reason;
        const json = isOllama ? line : line.startsWith('data:') ? line.slice(5).trim() : '';
        if (!json) continue;
        if (!isOllama && json === '[DONE]') { completed = true; continue; }
        const chunk = JSON.parse(json);
        if (chunk.error) throw new ModelHttpError(400, typeof chunk.error === 'string' ? chunk.error : chunk.error.message ?? JSON.stringify(chunk.error));
        if (isOllama) {
          thinking(chunk.message?.thinking);
          const delta = chunk.message?.content ?? '';
          if (typeof delta === 'string') content.push(delta);
          for (const call of chunk.message?.tool_calls ?? []) {
            idle.progress();
            input.onToolProgress?.();
            const index = ollamaCallIndex++;
            calls.set(index, { id: `call_${index}`, name: String(call.function?.name ?? ''), arguments: JSON.stringify(call.function?.arguments ?? {}) });
          }
          if (chunk.done === true) {
            if (chunk.done_reason === 'length') throw new Error('The model reached its output token limit before finishing. Partial output is saved; no tool actions from this response were executed.');
            completed = true;
            usage = { input: chunk.prompt_eval_count, output: chunk.eval_count };
          }
        } else {
          const delta = chunk.choices?.[0]?.delta ?? {};
          thinking(delta.reasoning_content ?? delta.reasoning);
          if (typeof delta.content === 'string') content.push(delta.content);
          for (const item of delta.tool_calls ?? []) {
            if (item.id || item.function?.name || item.function?.arguments?.trim()) idle.progress();
            input.onToolProgress?.();
            const prior = calls.get(item.index) ?? { id: `call_${item.index}`, name: '', arguments: '' };
            if (item.id) prior.id = item.id;
            if (item.function?.name) prior.name += item.function.name;
            if (item.function?.arguments) prior.arguments += item.function.arguments;
            calls.set(item.index, prior);
          }
          if (chunk.usage) usage = { input: chunk.usage.prompt_tokens, output: chunk.usage.completion_tokens };
          const finish = chunk.choices?.[0]?.finish_reason;
          if (finish === 'length' || finish === 'content_filter') throw new Error(`The model stopped before finishing (${finish}). Partial output is saved; no tool actions from this response were executed.`);
          if (['stop', 'tool_calls', 'function_call'].includes(finish)) completed = true;
        }
      }
      content.finish();
      if (!completed) throw new Error('The model stream ended without a completion marker. Partial output is saved; no tool actions from this response were executed.');
      const parsed: ToolRequest[] = [...calls.values()].map(call => ({ id: call.id, name: call.name, arguments: JSON.parse(call.arguments || '{}') }));
      return { text, ...(reasoning ? { reasoning } : {}), tools: parsed, usage };
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason ?? new Error('Model request cancelled or timed out.');
      if (error instanceof TypeError || /Model server returned HTTP (?:401|403|404|5\d\d)/.test(String(error))) this.connectionFailed();
      throw error;
    } finally {
      idle.dispose(); idle.signal.removeEventListener('abort', idleAbort);
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
