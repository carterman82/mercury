import { DatabaseSync } from 'node:sqlite';
import type { ChatThread, Project, Session, Settings } from '../shared/types';

const defaults: Settings = {
  connections: [
    { id: 'local-ollama', provider: 'ollama', label: 'Ollama on this computer', url: 'http://127.0.0.1:11434' },
    { id: 'local-lmstudio', provider: 'lmstudio', label: 'LM Studio on this computer', url: 'http://127.0.0.1:1234' },
    { id: 'shared-lmstudio', provider: 'lmstudio', label: 'Shared LM Studio (Tailscale)', url: 'http://100.80.53.57:1234' },
  ],
  mainModel: null, plannerModel: null, subagentModel: null,
};

export class Store {
  private db: DatabaseSync;
  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const version = Number((this.db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as any)?.value ?? 0);
    if (version < 1) {
      this.db.exec('CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
      this.db.exec('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, updated_at INTEGER NOT NULL, data TEXT NOT NULL)');
      this.db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, data TEXT NOT NULL)');
      this.db.prepare("INSERT OR REPLACE INTO meta (key,value) VALUES ('version','1')").run();
    }
    if (version < 2) {
      this.db.exec('CREATE TABLE IF NOT EXISTS secrets (key TEXT PRIMARY KEY, data TEXT NOT NULL)');
      this.db.prepare("INSERT OR REPLACE INTO meta (key,value) VALUES ('version','2')").run();
    }
    if (version < 3) {
      this.db.exec('CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, data TEXT NOT NULL)');
      this.db.prepare("INSERT OR REPLACE INTO meta (key,value) VALUES ('version','3')").run();
    }
    if (version < 4) {
      const columns = this.db.prepare('PRAGMA table_info(chats)').all() as { name: string }[];
      if (!columns.some(column => column.name === 'project_id')) this.db.exec('ALTER TABLE chats ADD COLUMN project_id TEXT REFERENCES projects(id)');
      this.db.exec("UPDATE chats SET project_id = json_extract(data, '$.projectId')");
      this.db.exec('CREATE INDEX IF NOT EXISTS chats_project_id ON chats(project_id, updated_at DESC)');
      this.db.prepare("INSERT OR REPLACE INTO meta (key,value) VALUES ('version','4')").run();
    }
    for (const chat of this.chats()) {
      let changed = false;
      if (chat.status === 'streaming') { chat.status = 'interrupted'; changed = true; }
      if (chat.projectRuntime?.status === 'running') { chat.projectRuntime.status = 'interrupted'; changed = true; }
      for (const assignment of chat.projectAssignments ?? []) if (assignment.status === 'running' || assignment.status === 'queued') { assignment.status = 'interrupted'; if (assignment.session) assignment.session.status = 'interrupted'; changed = true; }
      if (changed) this.saveChat(chat);
    }
    for (const session of this.sessions()) {
      if (['planning', 'implementing', 'awaiting_command'].includes(session.status)) {
        session.status = 'interrupted';
        session.command = null;
        this.saveSession(session);
      }
    }
  }
  projects(): Project[] { return (this.db.prepare('SELECT data FROM projects').all() as any[]).map(row => ({ permissionMode: 2, policyRevision: 1, ...JSON.parse(row.data) })); }
  project(id: string): Project {
    const project = this.projects().find(item => item.id === id);
    if (!project) throw new Error('Project not found.');
    return project;
  }
  chats(): ChatThread[] { return (this.db.prepare('SELECT data FROM chats ORDER BY updated_at DESC').all() as any[]).map(row => JSON.parse(row.data)); }
  chat(id: string): ChatThread {
    const row = this.db.prepare('SELECT data FROM chats WHERE id = ?').get(id) as any;
    if (!row) throw new Error('Chat not found.');
    return JSON.parse(row.data);
  }
  saveChat(chat: ChatThread): void {
    if (chat.projectId) this.project(chat.projectId);
    const previous = this.db.prepare('SELECT project_id FROM chats WHERE id = ?').get(chat.id) as { project_id: string | null } | undefined;
    if (previous && (previous.project_id ?? undefined) !== chat.projectId) throw new Error('A chat cannot be moved to a different project.');
    chat.updatedAt = Date.now();
    this.db.prepare('INSERT OR REPLACE INTO chats (id,updated_at,data,project_id) VALUES (?,?,?,?)').run(chat.id, chat.updatedAt, JSON.stringify(chat), chat.projectId ?? null);
  }
  saveProject(project: Project): void { this.db.prepare('INSERT OR REPLACE INTO projects (id,data) VALUES (?,?)').run(project.id, JSON.stringify(project)); }
  sessions(): Session[] { return (this.db.prepare('SELECT data FROM sessions ORDER BY updated_at DESC').all() as any[]).map(row => this.migrateSession(JSON.parse(row.data))); }
  session(id: string): Session {
    const row = this.db.prepare('SELECT data FROM sessions WHERE id = ?').get(id) as any;
    if (!row) throw new Error('Session not found.');
    return this.migrateSession(JSON.parse(row.data));
  }
  private migrateSession(session: Session): Session {
    const old = session.assignments as any;
    if (old && !old.main) session.assignments = { planner: old.planner, main: old.coder, subagent: old.coder };
    return session;
  }
  saveSession(session: Session): void {
    session.updatedAt = Date.now();
    this.db.prepare('INSERT OR REPLACE INTO sessions (id,project_id,updated_at,data) VALUES (?,?,?,?)').run(session.id, session.projectId, session.updatedAt, JSON.stringify(session));
  }
  settings(): Settings {
    const row = this.db.prepare("SELECT data FROM settings WHERE key = 'app'").get() as any;
    if (!row) return structuredClone(defaults);
    const saved = JSON.parse(row.data);
    const connections = (Array.isArray(saved.connections) ? saved.connections : defaults.connections.map(item => ({ ...item, url: saved.endpoints?.[item.provider] ?? item.url })))
      .map((item: any) => ({ ...item, hasToken: Boolean(this.secret(item.id)), apiToken: undefined }));
    const migrateProfile = (profile: any) => profile ? { ...profile, connectionId: profile.connectionId ?? `local-${profile.provider}` } : profile;
    return { connections, projectWorkerConcurrency: saved.projectWorkerConcurrency ?? 3,
      mainModel: migrateProfile('mainModel' in saved ? saved.mainModel : saved.defaultModel ?? saved.overrides?.coder) ?? null,
      plannerModel: migrateProfile('plannerModel' in saved ? saved.plannerModel : saved.overrides?.planner) ?? null,
      subagentModel: migrateProfile(saved.subagentModel) ?? null,
      additionalMainModels: (saved.additionalMainModels ?? []).map(migrateProfile),
      additionalSubagentModels: (saved.additionalSubagentModels ?? []).map(migrateProfile) };
  }
  saveSettings(settings: Settings): void { this.db.prepare("INSERT OR REPLACE INTO settings (key,data) VALUES ('app',?)").run(JSON.stringify(settings)); }
  discoveryCache(): unknown {
    const row = this.db.prepare("SELECT data FROM settings WHERE key = 'model-discovery'").get() as any;
    try { return row ? JSON.parse(row.data) : null; } catch { return null; }
  }
  saveDiscoveryCache(value: unknown): void {
    if (value === null) this.db.prepare("DELETE FROM settings WHERE key = 'model-discovery'").run();
    else this.db.prepare("INSERT OR REPLACE INTO settings (key,data) VALUES ('model-discovery',?)").run(JSON.stringify(value));
  }
  secret(id: string): string | null { return (this.db.prepare('SELECT data FROM secrets WHERE key = ?').get(id) as any)?.data ?? null; }
  saveSecret(id: string, value: string | null): void {
    if (value === null) this.db.prepare('DELETE FROM secrets WHERE key = ?').run(id);
    else this.db.prepare('INSERT OR REPLACE INTO secrets (key,data) VALUES (?,?)').run(id, value);
  }
  close(): void { this.db.close(); }
}
