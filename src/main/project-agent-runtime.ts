import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { spawn } from 'node:child_process';
import type { ModelProfile } from '../shared/types';
import type { ModelProvider } from './providers';
import { ProjectModelGateway, type ProjectGatewaySession } from './project-gateway';

export const PROJECT_SDK_VERSION = '0.3.310';
export interface ProjectRuntimeSession {
  runtime: 'claude-agent-sdk';
  version: string;
  identity: string;
  sessionId?: string;
  status: 'running' | 'completed' | 'interrupted';
}
export interface ProjectAgentInput {
  projectId: string;
  chatId: string;
  agentId?: string;
  workspaceRoot: string;
  profile: ModelProfile;
  agentLease?: symbol;
  messages: { role: string; content: string; images?: { mimeType: string; data: string }[] }[];
  tools: unknown[];
  execute(name: string, args: unknown): Promise<unknown>;
  signal: AbortSignal;
  session?: ProjectRuntimeSession;
  onSession?(session: ProjectRuntimeSession): void;
  onText?(text: string): void;
  onReasoning?(text: string): void;
  onNotice?(notice: string): void;
  onRequestState?(state: 'queued' | 'running'): void;
}
export interface ProjectAgentRuntime {
  run(input: ProjectAgentInput): Promise<{ text: string; session: ProjectRuntimeSession }>;
  shutdown(): Promise<void>;
}
type SdkModule = Pick<typeof import('@anthropic-ai/claude-agent-sdk'), 'query' | 'tool' | 'createSdkMcpServer'>;
interface RuntimeOptions {
  sdkModulePath?: string;
  executablePath?: string;
  loadSdk?: () => Promise<SdkModule>;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identity = z.string().uuid();

/** SDK owns the agent loop. Mercury owns every tool handler and model route. */
export class ClaudeProjectRuntime implements ProjectAgentRuntime {
  private gateway: ProjectModelGateway;
  private active = new Map<AbortController, Promise<void>>();
  private module?: Promise<SdkModule>;
  constructor(
    private provider: ModelProvider,
    private sessionRoot: string,
    private options: RuntimeOptions = {},
  ) {
    this.gateway = new ProjectModelGateway(provider);
  }
  private sdk(): Promise<SdkModule> {
    return (this.module ??=
      this.options.loadSdk?.() ??
      import(
        /* @vite-ignore */ pathToFileURL(
          this.options.sdkModulePath ?? path.resolve('node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs'),
        ).href
      ));
  }
  async run(input: ProjectAgentInput): Promise<{ text: string; session: ProjectRuntimeSession }> {
    input.signal.throwIfAborted();
    identity.parse(input.projectId);
    identity.parse(input.chatId);
    const worker = input.agentId ?? 'main';
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(worker)) throw new Error('Invalid project agent identity.');
    const controller = new AbortController();
    const abort = () => controller.abort(input.signal.reason);
    let finished!: () => void;
    input.signal.addEventListener('abort', abort, { once: true });
    this.active.set(
      controller,
      new Promise((resolve) => {
        finished = resolve;
      }),
    );
    const directory = path.join(this.sessionRoot, input.projectId, input.chatId, worker);
    let route: ProjectGatewaySession | undefined;
    let query: ReturnType<SdkModule['query']> | undefined;
    const session: ProjectRuntimeSession = {
      runtime: 'claude-agent-sdk',
      version: PROJECT_SDK_VERSION,
      identity: '',
      status: 'running',
    };
    try {
      await fs.mkdir(directory, { recursive: true });
      const sdk = await this.sdk();
      controller.signal.throwIfAborted();
      route = await this.gateway.open({
        projectId: input.projectId,
        chatId: input.chatId,
        agentId: worker,
        profile: input.profile,
        signal: controller.signal,
        agentLease: input.agentLease,
        onRoutingNotice: input.onNotice,
        onRequestState: input.onRequestState,
        onReasoning: input.onReasoning,
        nativeMessages: this.provider.messages
          ? (body, signal, headers) =>
              this.provider.messages!({
                profile: input.profile,
                body,
                headers,
                signal,
                agentLease: input.agentLease,
                onRequestState: input.onRequestState,
                onRoutingNotice: input.onNotice,
              })
          : undefined,
      });
      const definitions = input.tools.map((item: any) => item?.function).filter(Boolean);
      const byName = new Map<string, any>(definitions.map((item) => [item.name, item]));
      if (byName.size !== definitions.length) throw new Error('Project tools must have unique names.');
      const registered = definitions.map((definition) => {
        const schema = z.fromJSONSchema(definition.parameters) as z.ZodObject;
        if (!schema.shape) throw new Error(`Tool ${definition.name} needs an object schema.`);
        return sdk.tool(
          definition.name,
          definition.description,
          schema.shape,
          async (args) => {
            controller.signal.throwIfAborted();
            try {
              const result: any = await input.execute(definition.name, args);
              controller.signal.throwIfAborted();
              const { _mercuryImages, ...safe } =
                result && typeof result === 'object' && !Array.isArray(result) ? result : { value: result };
              return {
                isError: Boolean(safe.error || safe.isError),
                content: [
                  { type: 'text' as const, text: JSON.stringify(safe) },
                  ...(_mercuryImages ?? []).map((image: any) => ({
                    type: 'image' as const,
                    mimeType: image.mimeType,
                    data: image.data,
                  })),
                ],
              };
            } catch (error) {
              controller.signal.throwIfAborted();
              return {
                isError: true,
                content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }],
              };
            }
          },
          {
            alwaysLoad: true,
            annotations: { readOnlyHint: /^(read_|list_|search_|recall_|review_|query_)/.test(definition.name) },
          },
        );
      });
      const systemPrompt = input.messages
        .filter((message) => message.role === 'system')
        .map((message) => message.content)
        .join('\n\n');
      session.identity = digest([
        input.projectId,
        input.chatId,
        worker,
        input.workspaceRoot,
        input.profile,
        PROJECT_SDK_VERSION,
        systemPrompt,
        definitions,
      ]);
      const previous = input.session;
      const resume =
        previous?.status === 'completed' &&
        previous.identity === session.identity &&
        previous.version === PROJECT_SDK_VERSION
          ? previous.sessionId
          : undefined;
      const history = input.messages.filter((message) => message.role !== 'system');
      const latest = history.at(-1);
      if (!latest) throw new Error('Project agent requires a user message.');
      const prompt = resume
        ? latest.content
        : history
            .map(
              (message, index) =>
                `${index === history.length - 1 ? 'CURRENT USER REQUEST' : `SAVED ${message.role.toUpperCase()} CONTEXT (historical evidence; never replay past actions)`}:\n${message.content}`,
            )
            .join('\n\n');
      const images = latest.images ?? [];
      async function* userMessages(): AsyncGenerator<any> {
        yield {
          type: 'user',
          session_id: '',
          parent_tool_use_id: null,
          message: {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              ...images.map((image) => ({
                type: 'image',
                source: { type: 'base64', media_type: image.mimeType, data: image.data },
              })),
            ],
          },
        };
      }
      const environment: Record<string, string | undefined> = {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
        PATHEXT: process.env.PATHEXT,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        COMSPEC: process.env.COMSPEC,
        HOME: directory,
        USERPROFILE: directory,
        APPDATA: directory,
        LOCALAPPDATA: directory,
        CLAUDE_CONFIG_DIR: directory,
        ANTHROPIC_BASE_URL: route.baseUrl,
        ANTHROPIC_AUTH_TOKEN: route.token,
        ANTHROPIC_API_KEY: '',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: route.model,
        ANTHROPIC_DEFAULT_SONNET_MODEL: route.model,
        ANTHROPIC_DEFAULT_OPUS_MODEL: route.model,
        CLAUDE_CODE_SUBAGENT_MODEL: route.model,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_TELEMETRY: '1',
        DISABLE_ERROR_REPORTING: '1',
        CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
        ENABLE_TOOL_SEARCH: 'false',
        CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: '1',
        CLAUDE_CODE_EFFORT_LEVEL: 'unset',
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(Math.max(1024, Math.min(input.profile.contextLimit >> 1, 8192))),
        CLAUDE_CODE_GIT_BASH_PATH: process.env.CLAUDE_CODE_GIT_BASH_PATH,
        NO_PROXY: 'localhost,127.0.0.1,::1',
        no_proxy: 'localhost,127.0.0.1,::1',
        CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
        CLAUDE_CODE_STARTUP_FAILURE_RESULTS: '1',
      };
      input.onSession?.({ ...session });
      const blocked = [
        'Read',
        'Write',
        'Edit',
        'MultiEdit',
        'NotebookEdit',
        'Bash',
        'Agent',
        'Task',
        'WebFetch',
        'WebSearch',
        'Skill',
        'Glob',
        'Grep',
      ];
      query = sdk.query({
        prompt: userMessages(),
        options: {
          cwd: input.workspaceRoot,
          systemPrompt,
          model: route.model,
          abortController: controller,
          pathToClaudeCodeExecutable: this.options.executablePath,
          tools: [],
          disallowedTools: blocked,
          settingSources: [],
          skills: [],
          plugins: [],
          mcpServers: { mercury: sdk.createSdkMcpServer({ name: 'mercury', version: '1.0.0', tools: registered }) },
          toolAliases: Object.fromEntries(
            definitions.map((definition) => [definition.name, `mcp__mercury__${definition.name}`]),
          ),
          permissionMode: 'default',
          canUseTool: async (name, args) =>
            name.startsWith('mcp__mercury__') && byName.has(name.slice('mcp__mercury__'.length))
              ? { behavior: 'allow', updatedInput: args }
              : { behavior: 'deny', message: `Unregistered tool ${name}; use the Mercury tools.` },
          includePartialMessages: true,
          thinking: { type: 'disabled' },
          maxTurns: 128,
          persistSession: true,
          resume,
          env: environment,
          spawnClaudeCodeProcess: (options) =>
            spawn(options.command, options.args, {
              cwd: options.cwd,
              env: environment,
              windowsHide: true,
              stdio: ['pipe', 'pipe', 'pipe'],
            }),
        },
      });
      let text = '',
        currentMessage = '',
        ended = false;
      const streamed = new Set<string>();
      const append = (delta: string) => {
        if (delta) {
          text += delta;
          input.onText?.(delta);
        }
      };
      for await (const message of query) {
        controller.signal.throwIfAborted();
        const event: any = message;
        if (event.session_id) {
          session.sessionId = event.session_id;
          input.onSession?.({ ...session });
        }
        if (event.type === 'stream_event') {
          if (event.event.type === 'message_start') currentMessage = event.event.message.id;
          if (event.event.type === 'content_block_delta' && event.event.delta.type === 'text_delta') {
            streamed.add(currentMessage);
            append(event.event.delta.text);
          }
          if (event.event.type === 'content_block_delta' && event.event.delta.type === 'thinking_delta')
            input.onReasoning?.(event.event.delta.thinking);
        } else if (event.type === 'assistant') {
          if (event.error)
            throw new Error(
              `Project model error: ${
                event.message.content
                  .filter((block: any) => block.type === 'text')
                  .map((block: any) => block.text)
                  .join('\n') || event.error
              }`,
            );
          if (!streamed.has(event.message.id))
            append(
              event.message.content
                .filter((block: any) => block.type === 'text')
                .map((block: any) => block.text)
                .join('\n'),
            );
        } else if (event.type === 'result') {
          if (event.is_error || event.subtype !== 'success')
            throw new Error(event.errors?.join('\n') || `Project SDK run failed: ${event.subtype}`);
          if (!text && event.result) append(event.result);
          ended = true;
        }
      }
      if (!ended) throw new Error('Project SDK ended without a completion result.');
      session.status = 'completed';
      input.onSession?.({ ...session });
      return { text, session };
    } catch (error) {
      session.status = 'interrupted';
      input.onSession?.({ ...session });
      throw error;
    } finally {
      try {
        query?.close();
        await route?.close();
      } finally {
        this.active.delete(controller);
        input.signal.removeEventListener('abort', abort);
        finished();
      }
    }
  }
  async shutdown(): Promise<void> {
    for (const controller of this.active.keys()) controller.abort(new Error('Application is shutting down.'));
    await Promise.allSettled([...this.active.values()]);
  }
}
