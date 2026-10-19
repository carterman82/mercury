export type ProviderKind = 'ollama' | 'lmstudio';
export type AgentRole = 'planner' | 'critic' | 'synthesizer' | 'coder';
export type SessionStatus = 'draft' | 'planning' | 'awaiting_input' | 'awaiting_review' | 'implementing' | 'awaiting_command' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export interface ModelConnection { id: string; provider: ProviderKind; label: string; url: string; apiToken?: string; hasToken?: boolean; }

export interface ModelProfile {
  provider: ProviderKind;
  connectionId?: string;
  endpoint?: string;
  model: string;
  contextLimit: number;
  toolVerified?: boolean;
}
export interface Settings {
  connections: ModelConnection[];
  defaultModel: ModelProfile | null;
  overrides: Partial<Record<AgentRole, ModelProfile>>;
}
export interface ModelInfo { provider: ProviderKind; connectionId: string; connectionLabel: string; id: string; label: string; available: boolean; contextLimit?: number; toolCapable?: boolean; }
export interface DiscoveryResult { connections: ModelConnection[]; models: ModelInfo[]; applications: string[]; diagnostics: string[]; }
export interface PlanStep { title: string; details: string; checks: string[]; }
export interface PlanContent { objective: string; assumptions: string[]; steps: PlanStep[]; blockers: string[]; }
export interface PlanRevision { revision: number; content: PlanContent; approved: boolean; createdAt: number; }
export interface RunEvent { id: string; at: number; role?: AgentRole; kind: 'message' | 'status' | 'tool' | 'error' | 'command' | 'change'; text: string; }
export interface ChangeRecord { path: string; before: string | null; after: string | null; at: number; }
export interface CommandRequest { id: string; command: string; cwd: string; }
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
}
export interface Project { id: string; path: string; name: string; }
export interface ChatMessage { id: string; role: 'user' | 'assistant'; content: string; model?: string; reasoning?: string; startedAt?: number; thinkingEndedAt?: number; completedAt?: number; }
export interface ChatThread { id: string; title: string; profile: ModelProfile; messages: ChatMessage[]; status: 'idle' | 'streaming' | 'stopped' | 'failed' | 'interrupted'; error?: string; updatedAt: number; }
export interface Snapshot { projects: Project[]; sessions: Session[]; chats: ChatThread[]; settings: Settings; activeRole: AgentRole | null; activeChatId: string | null; }
export interface ToolRequest { id: string; name: string; arguments: unknown; }

export interface DesktopApi {
  snapshot(): Promise<Snapshot>;
  onUpdate(callback: (snapshot: Snapshot) => void): () => void;
  openProject(): Promise<Project | null>;
  createSession(projectId: string, objective: string): Promise<Session>;
  updateSettings(settings: Settings): Promise<void>;
  discover(connection: ModelConnection): Promise<ModelInfo[]>;
  autoDiscover(force?: boolean): Promise<DiscoveryResult>;
  probe(profile: ModelProfile): Promise<boolean>;
  sendChat(chatId: string | null, profile: ModelProfile, message: string): Promise<string>;
  stopChat(chatId: string): Promise<void>;
  openLink(url: string): Promise<void>;
  plan(sessionId: string, feedback?: string): Promise<void>;
  savePlan(sessionId: string, content: PlanContent): Promise<void>;
  approvePlan(sessionId: string, revision: number): Promise<void>;
  exportPlan(sessionId: string): Promise<string | null>;
  answerCommand(sessionId: string, requestId: string, allow: boolean, remember: boolean): Promise<void>;
  stop(sessionId: string): Promise<void>;
  resume(sessionId: string): Promise<void>;
}
