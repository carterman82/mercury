import { DatabaseSync } from 'node:sqlite';
import type { ChatThread, Project, Session, Settings, SourceEvidence } from '../shared/types';
import { chatEvidence, projectEvidence, recallContext } from './source-memory';

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
  private indexedEvidence = new Map<string, Set<string>>();
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
    this.db.exec(`CREATE TABLE IF NOT EXISTS source_evidence (
      row_id INTEGER PRIMARY KEY, kind TEXT NOT NULL, owner_id TEXT NOT NULL, message_id TEXT,
      id TEXT NOT NULL, at INTEGER NOT NULL, tool TEXT NOT NULL, label TEXT NOT NULL, input TEXT NOT NULL, result TEXT NOT NULL,
      UNIQUE(kind,owner_id,id));
      CREATE INDEX IF NOT EXISTS evidence_owner ON source_evidence(kind,owner_id,at);
      CREATE VIRTUAL TABLE IF NOT EXISTS source_evidence_fts USING fts5(label,input,result,content='source_evidence',content_rowid='row_id');
      CREATE TRIGGER IF NOT EXISTS evidence_insert AFTER INSERT ON source_evidence BEGIN
        INSERT INTO source_evidence_fts(rowid,label,input,result) VALUES(new.row_id,new.label,new.input,new.result); END;`);
    if (version < 5) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const row of this.db.prepare('SELECT id,data FROM chats').all() as { id: string; data: string }[]) {
          const chat: ChatThread = JSON.parse(row.data);
          this.indexChatEvidence(chat);
          this.db.prepare('UPDATE chats SET data=? WHERE id=?').run(JSON.stringify(this.withoutChatEvidence(chat)), row.id);
        }
        for (const row of this.db.prepare('SELECT id,data FROM sessions').all() as { id: string; data: string }[]) {
          const session: Session = JSON.parse(row.data);
          this.indexSourceEvidence('session', session.id, projectEvidence(session));
          const { sourceEvidence: _evidence, ...rest } = session;
          this.db.prepare('UPDATE sessions SET data=? WHERE id=?').run(JSON.stringify(rest), row.id);
        }
        this.db.prepare("INSERT OR REPLACE INTO meta VALUES('version','5')").run();
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
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
  chats(): ChatThread[] { return (this.db.prepare('SELECT data FROM chats ORDER BY updated_at DESC').all() as any[]).map(row => this.hydrateChat(JSON.parse(row.data))); }
  chat(id: string): ChatThread {
    const row = this.db.prepare('SELECT data FROM chats WHERE id = ?').get(id) as any;
    if (!row) throw new Error('Chat not found.');
    return this.hydrateChat(JSON.parse(row.data));
  }
  saveChat(chat: ChatThread): void {
    if (chat.projectId) this.project(chat.projectId);
    const previous = this.db.prepare('SELECT project_id FROM chats WHERE id = ?').get(chat.id) as { project_id: string | null } | undefined;
    if (previous && (previous.project_id ?? undefined) !== chat.projectId) throw new Error('A chat cannot be moved to a different project.');
    chat.updatedAt = Date.now();
    this.indexChatEvidence(chat);
    this.db.prepare('INSERT OR REPLACE INTO chats (id,updated_at,data,project_id) VALUES (?,?,?,?)').run(chat.id, chat.updatedAt, JSON.stringify(this.withoutChatEvidence(chat)), chat.projectId ?? null);
  }
  saveProject(project: Project): void { this.db.prepare('INSERT OR REPLACE INTO projects (id,data) VALUES (?,?)').run(project.id, JSON.stringify(project)); }
  sessions(): Session[] { return (this.db.prepare('SELECT data FROM sessions ORDER BY updated_at DESC').all() as any[]).map(row => this.migrateSession(JSON.parse(row.data))); }
  session(id: string): Session {
    const row = this.db.prepare('SELECT data FROM sessions WHERE id = ?').get(id) as any;
    if (!row) throw new Error('Session not found.');
    return this.migrateSession(JSON.parse(row.data));
  }
  private migrateSession(session: Session): Session {
    const evidence = this.evidence('session', session.id);
    if (evidence.length) session.sourceEvidence = evidence;
    const old = session.assignments as any;
    if (old && !old.main) session.assignments = { planner: old.planner, main: old.coder, subagent: old.coder };
    return session;
  }
  saveSession(session: Session): void {
    session.updatedAt = Date.now();
    this.indexSourceEvidence('session', session.id, projectEvidence(session));
    const { sourceEvidence: _evidence, ...rest } = session;
    this.db.prepare('INSERT OR REPLACE INTO sessions (id,project_id,updated_at,data) VALUES (?,?,?,?)').run(session.id, session.projectId, session.updatedAt, JSON.stringify(rest));
  }
  private withoutChatEvidence(chat: ChatThread): ChatThread {
    return { ...chat, messages: chat.messages.map(message => { const { sourceEvidence: _evidence, ...rest } = message; return rest; }) };
  }
  private indexChatEvidence(chat: ChatThread): void {
    for (const message of chat.messages) this.indexSourceEvidence('chat', chat.id, message.sourceEvidence ?? [], message.id);
    this.indexSourceEvidence('chat', chat.id, chatEvidence(chat));
  }
  /** Evidence is append-only: observing the same id again never overwrites its provenance. */
  indexSourceEvidence(kind: 'chat' | 'session', ownerId: string, entries: SourceEvidence[], messageId: string | null = null): void {
    const key = JSON.stringify([kind, ownerId]);
    let known = this.indexedEvidence.get(key);
    if (!known) {
      known = new Set((this.db.prepare('SELECT id FROM source_evidence WHERE kind=? AND owner_id=?').all(kind, ownerId) as { id: string }[]).map(row => row.id));
      this.indexedEvidence.set(key, known);
    }
    const insert = this.db.prepare('INSERT OR IGNORE INTO source_evidence(kind,owner_id,message_id,id,at,tool,label,input,result) VALUES(?,?,?,?,?,?,?,?,?)');
    for (const item of entries) {
      if (known.has(item.id)) continue;
      insert.run(kind, ownerId, messageId, item.id, item.at, item.tool, item.label, item.input, item.result);
      known.add(item.id);
    }
  }
  private evidence(kind: 'chat' | 'session', ownerId: string): SourceEvidence[] {
    return this.db.prepare('SELECT id,at,tool,label,input,result FROM source_evidence WHERE kind=? AND owner_id=? ORDER BY row_id').all(kind, ownerId) as unknown as SourceEvidence[];
  }
  private hydrateChat(chat: ChatThread): ChatThread {
    const rows = this.db.prepare('SELECT message_id,id,at,tool,label,input,result FROM source_evidence WHERE kind=\'chat\' AND owner_id=? AND message_id IS NOT NULL ORDER BY row_id').all(chat.id) as unknown as (SourceEvidence & { message_id: string })[];
    const grouped = new Map<string, SourceEvidence[]>();
    for (const { message_id, ...item } of rows) { const entries = grouped.get(message_id) ?? []; entries.push(item); grouped.set(message_id, entries); }
    for (const message of chat.messages) { const entries = grouped.get(message.id); if (entries?.length) message.sourceEvidence = entries; }
    return chat;
  }
  recallSourceContext(kind: 'chat' | 'session', ownerId: string, raw: unknown, budget = 12000): string {
    return recallContext([], raw, budget, {
      get: id => this.db.prepare('SELECT id,at,tool,label,input,result FROM source_evidence WHERE kind=? AND owner_id=? AND id=?').get(kind, ownerId, id) as SourceEvidence | undefined,
      search: (query, offset, limit) => {
        const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
        const match = terms.map(term => `"${term}"`).join(' AND ');
        if (query.trim() && !match) return { matches: [], total: 0 };
        const from = match ? 'source_evidence e JOIN source_evidence_fts f ON f.rowid=e.row_id' : 'source_evidence e';
        const where = `e.kind=? AND e.owner_id=?${match ? ' AND source_evidence_fts MATCH ?' : ''}`;
        const args = match ? [kind, ownerId, match] : [kind, ownerId];
        const total = Number((this.db.prepare(`SELECT count(*) AS total FROM ${from} WHERE ${where}`).get(...args) as { total: number }).total);
        const rows = this.db.prepare(`SELECT e.id,e.at,e.tool,e.label,e.input,${match ? "snippet(source_evidence_fts,2,'','', ' … ',32)" : 'substr(e.result,1,200)'} AS result FROM ${from} WHERE ${where} ORDER BY ${match ? 'bm25(source_evidence_fts), ' : ''}e.row_id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset) as unknown as SourceEvidence[];
        return { matches: rows, total };
      },
    });
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
