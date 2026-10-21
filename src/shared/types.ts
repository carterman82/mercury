export type ProviderKind = 'ollama' | 'lmstudio' | 'openai' | 'claude' | 'codex';
export type ModelCategory = 'local' | 'openai' | 'claude';
export const modelCategory = (provider: ProviderKind): ModelCategory => provider === 'ollama' || provider === 'lmstudio' ? 'local' : provider === 'codex' ? 'openai' : provider;
export type AgentRole = 'planner' | 'main' | 'subagent';
export type HistoricalAgentRole = AgentRole | 'critic' | 'synthesizer' | 'coder';
export type SessionStatus = 'draft' | 'planning' | 'awaiting_input' | 'awaiting_review' | 'implementing' | 'awaiting_command' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export interface ModelConnection { id: string; provider: ProviderKind; label: string; url: string; apiToken?: string; hasToken?: boolean; auth?: 'chatgpt'; maxConcurrentRequests?: number; deviceId?: string; deviceLabel?: string; }

export interface ModelProfile {
  provider: ProviderKind;
  connectionId?: string;
  endpoint?: string;
  model: string;
  contextLimit: number;
  contextMode?: 'auto' | 'manual';
  toolVerified?: boolean;
}
export interface Settings {
  connections: ModelConnection[];
  mainModel: ModelProfile | null;
  plannerModel: ModelProfile | null;
  subagentModel: ModelProfile | null;
  additionalMainModels?: ModelProfile[];
  additionalSubagentModels?: ModelProfile[];
}
export interface ModelInfo { provider: ProviderKind; connectionId: string; connectionLabel: string; id: string; label: string; available: boolean; contextLimit?: number; contextLimitSource?: 'provider' | 'published'; contextLimitReference?: string; contextLimitVerifiedAt?: string; toolCapable?: boolean; visionCapable?: boolean; parallelRequests?: number; }
export interface ModelRequestCount { key: string; provider: ProviderKind; endpoint: string; model: string; limit: number; active: number; queued: number; }
export interface DiscoveryResult { connections: ModelConnection[]; models: ModelInfo[]; applications: string[]; diagnostics: string[]; }
export interface PlanStep { title: string; details: string; checks: string[]; }
export interface PlanContent { objective: string; assumptions: string[]; steps: PlanStep[]; blockers: string[]; }
export interface PlanRevision { revision: number; content: PlanContent; approved: boolean; createdAt: number; }
export interface RunEvent { id: string; at: number; role?: HistoricalAgentRole; kind: 'message' | 'status' | 'tool' | 'error' | 'command' | 'change'; text: string; }
export interface ChangeRecord { path: string; before: string | null; after: string | null; at: number; }
export interface CommandRequest { id: string; command: string; cwd: string; }
export interface SourceEvidence { id: string; at: number; tool: string; label: string; input: string; result: string; }
export interface Session {
  id: string;
  projectId: string;
  objective: string;
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
  events: RunEvent[];
  plan: PlanRevision | null;
  changes: ChangeRecord[];
  command: CommandRequest | null;
  assignments: Record<AgentRole, ModelProfile> | null;
  subagentCandidates?: ModelProfile[];
  sourceEvidence?: SourceEvidence[];
}
export interface Project { id: string; path: string; name: string; }
export interface ChatFile { id: string; name: string; size: number; kind: 'upload' | 'generated'; format?: string; readStatus?: 'readable' | 'partial' | 'metadata'; note?: string; }
export interface FilePreview { kind: 'image' | 'pdf' | 'text'; text?: string; image?: string; page?: number; pages?: number; note?: string; }
export interface BrowserPreview { url: string; image?: string; }
export interface ChatMessage { id: string; role: 'user' | 'assistant'; content: string; files?: ChatFile[]; sourceEvidence?: SourceEvidence[]; model?: string; reasoning?: string; notice?: string; queued?: boolean; toolActivity?: { name: string; label?: string; status: 'running' | 'succeeded' | 'failed'; at: number; result?: string }[]; startedAt?: number; thinkingEndedAt?: number; completedAt?: number; }
export interface ChatThread { id: string; title: string; profile: ModelProfile; usesMainPool?: boolean; messages: ChatMessage[]; status: 'idle' | 'streaming' | 'stopped' | 'failed' | 'interrupted'; error?: string; updatedAt: number; }
export interface ChatApproval { id: string; chatId: string; title: string; details: string; at: number; }
export interface Snapshot { projects: Project[]; sessions: Session[]; chats: ChatThread[]; settings: Settings; activeRole: AgentRole | null; activeChatId: string | null; activeChatIds?: string[]; modelRequests?: ModelRequestCount[]; chatApprovals?: ChatApproval[]; }
export interface ToolRequest { id: string; name: string; arguments: unknown; }

export interface DesktopApi {
  snapshot(): Promise<Snapshot>;
  onUpdate(callback: (snapshot: Snapshot) => void): () => void;
  openProject(): Promise<Project | null>;
  createSession(projectId: string, objective: string): Promise<Session>;
  updateSettings(settings: Settings): Promise<void>;
  connectChatGPT(id?: string): Promise<void>;
  cancelChatGPTSignIn(): Promise<void>;
  connectCodex(): Promise<void>;
  cancelCodexSignIn(): Promise<void>;
  cachedDiscovery(): Promise<DiscoveryResult | null>;
  onDiscovery(callback: (result: DiscoveryResult) => void): () => void;
  disconnectConnection(id: string): Promise<void>;
  discover(connection: ModelConnection): Promise<ModelInfo[]>;
  autoDiscover(force?: boolean): Promise<DiscoveryResult>;
  probe(profile: ModelProfile): Promise<boolean>;
  addChatFiles(files: File[]): Promise<ChatFile[]>;
  saveChatFile(fileId: string): Promise<string | null>;
  previewChatFile(fileId: string, page?: number): Promise<FilePreview>;
  previewChatBrowser(chatId: string): Promise<BrowserPreview | null>;
  sendChat(chatId: string | null, profile: ModelProfile, message: string, attachmentIds?: string[]): Promise<string>;
  stopChat(chatId: string): Promise<void>;
  answerChatApproval(id: string, allow: boolean): Promise<void>;
  openLink(url: string): Promise<void>;
  plan(sessionId: string, feedback?: string): Promise<void>;
  savePlan(sessionId: string, content: PlanContent): Promise<void>;
  approvePlan(sessionId: string, revision: number): Promise<void>;
  exportPlan(sessionId: string): Promise<string | null>;
  answerCommand(sessionId: string, requestId: string, allow: boolean, remember: boolean): Promise<void>;
  stop(sessionId: string): Promise<void>;
  resume(sessionId: string): Promise<void>;
}
