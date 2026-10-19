import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AgentRole, DiscoveryResult, ModelConnection, ModelInfo, ModelProfile, PlanContent, ProviderKind, Session, Settings, Snapshot } from '../shared/types';
import './style.css';
import { ChatPanel } from './ChatPanel';
import { Markdown } from './Markdown';

const roles: AgentRole[] = ['planner', 'critic', 'synthesizer', 'coder'];
const emptyPlan: PlanContent = { objective: '', assumptions: [], steps: [{ title: '', details: '', checks: [] }], blockers: [] };
const lines = (value: string) => value.split('\n').map(x => x.trim()).filter(Boolean);
const initial: Snapshot = { projects: [], sessions: [], chats: [], settings: { connections: [], defaultModel: null, overrides: {} }, activeRole: null, activeChatId: null };

function ProfileSelect({ label, value, models, onChange, onOther, optional = false }: { label: string; value?: ModelProfile | null; models: ModelInfo[]; onChange: (profile?: ModelProfile) => void; onOther: () => void; optional?: boolean }) {
  const key = (connectionId: string, model: string) => JSON.stringify([connectionId, model]);
  const selected = value ? key(value.connectionId ?? `local-${value.provider}`, value.model) : '';
  const savedMissing = value && !models.some(item => key(item.connectionId, item.id) === selected);
  return <label className="field"><span>{label}</span><select value={selected} onChange={event => {
    if (event.target.value === '__other__') { onOther(); return; }
    const model = models.find(item => key(item.connectionId, item.id) === event.target.value);
    onChange(model ? { provider: model.provider, connectionId: model.connectionId, model: model.id, contextLimit: model.contextLimit ?? 8192 } : undefined);
  }}><option value="">{optional ? 'Use default model' : 'Choose a detected model'}</option>{savedMissing && <option value={selected}>{value.model} (currently unavailable)</option>}{[...models].sort((a, b) => Number(b.available) - Number(a.available) || a.connectionLabel.localeCompare(b.connectionLabel) || a.label.localeCompare(b.label)).map(model => <option key={key(model.connectionId, model.id)} value={key(model.connectionId, model.id)}>{model.connectionLabel} · {model.label}{model.available ? '' : ' (not loaded)'}{model.toolCapable === false ? ' (no tool support)' : ''}</option>)}<option value="__other__">Other…</option></select></label>;
}

function SettingsPanel({ settings, onClose, onSave, run }: { settings: Settings; onClose: () => void; onSave: (settings: Settings) => Promise<void>; run: (job: () => Promise<unknown>) => void }) {
  const [draft, setDraft] = useState<Settings>(structuredClone(settings));
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [found, setFound] = useState<DiscoveryResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [other, setOther] = useState(false);
  const [manual, setManual] = useState<{ provider: ProviderKind; label: string; url: string; apiToken: string }>({ provider: 'lmstudio', label: '', url: '', apiToken: '' });
  const [manualError, setManualError] = useState('');
  const refresh = async (force = false) => {
    setScanning(true);
    try {
      const result = await window.desktop.autoDiscover(force);
      setFound(result);
      setModels(result.models);
      setDraft(current => ({ ...current, connections: [...current.connections, ...result.connections.filter(item => !current.connections.some(saved => saved.provider === item.provider && saved.url === item.url))] }));
    } catch (error) { setManualError(String(error)); }
    finally { setScanning(false); }
  };
  useEffect(() => { void refresh(); }, []);
  const addOther = () => run(async () => {
    setManualError('');
    const id = `other-${manual.provider}-${crypto.randomUUID()}`;
    const connection: ModelConnection = { id, provider: manual.provider, label: manual.label.trim() || `${manual.provider === 'ollama' ? 'Ollama' : 'LM Studio'} (Other)`, url: manual.url.trim(), ...(manual.apiToken ? { apiToken: manual.apiToken } : {}) };
    try {
      const discovered = await window.desktop.discover(connection);
      setDraft(current => ({ ...current, connections: [...current.connections, connection] }));
      setModels(current => [...current, ...discovered]);
      setOther(false);
      setManual({ provider: 'lmstudio', label: '', url: '', apiToken: '' });
    } catch (error) { setManualError(String(error)); }
  });
  const setProfile = (role: AgentRole, profile?: ModelProfile) => setDraft(current => {
    const overrides = { ...current.overrides };
    if (profile) overrides[role] = profile; else delete overrides[role];
    return { ...current, overrides };
  });
  return <div className="modal-backdrop"><section className="modal settings-modal"><header><div><small>CONNECTIONS</small><h2>Local models</h2></div><button className="ghost" onClick={onClose}>Close</button></header>
    <p>Running Ollama and LM Studio servers are found automatically, including servers shared by Tailscale. Select a model below.</p>
    <div className="discovery-head"><strong>Detected connections</strong><button onClick={() => void refresh(true)} disabled={scanning}>{scanning ? 'Scanning…' : 'Refresh'}</button></div>
    {found?.applications.length ? <p className="hint">Installed apps: {found.applications.join(', ')}</p> : null}
    {found?.connections.length ? found.connections.map(connection => <div className="detected-server" key={connection.id}><span><strong>{connection.label}</strong><small>{connection.url}</small></span><span>{found.models.filter(model => model.connectionId === connection.id).length} models</span></div>) : <p className="hint">{scanning ? 'Checking local and Tailscale servers…' : 'No running model servers found.'}</p>}
    {found?.diagnostics.filter(item => !item.includes('127.0.0.1')).map((item, index) => <p className="hint" key={index}>{item}</p>)}
    <button className="text-button" onClick={() => setOther(value => !value)}>Other: add a server address</button>
    {other && <div className="other-server"><label className="field"><span>Server type</span><select value={manual.provider} onChange={event => setManual(current => ({ ...current, provider: event.target.value as ProviderKind }))}><option value="lmstudio">LM Studio</option><option value="ollama">Ollama</option></select></label><label className="field"><span>Name</span><input value={manual.label} onChange={event => setManual(current => ({ ...current, label: event.target.value }))} placeholder="My model server" /></label><label className="field"><span>Server address</span><input value={manual.url} onChange={event => setManual(current => ({ ...current, url: event.target.value }))} placeholder="http://host:1234" /></label><label className="field"><span>API token (if required)</span><input type="password" value={manual.apiToken} onChange={event => setManual(current => ({ ...current, apiToken: event.target.value }))} autoComplete="off" /></label><button onClick={addOther}>Check and add</button>{manualError && <p className="hint danger">{manualError}</p>}</div>}
    <div className="model-grid"><ProfileSelect label="Default model" value={draft.defaultModel} models={models} onOther={() => setOther(true)} onChange={profile => setDraft(current => ({ ...current, defaultModel: profile ?? null }))} />
    </div><details className="advanced-settings"><summary>Agent models and context</summary><div className="model-grid">{roles.map(role => <ProfileSelect key={role} label={`${role[0].toUpperCase()}${role.slice(1)} override`} value={draft.overrides[role]} models={models} onOther={() => setOther(true)} optional onChange={profile => setProfile(role, profile)} />)}</div>
    <label className="field compact"><span>Context limit for default model</span><input type="number" min={2048} value={draft.defaultModel?.contextLimit ?? 8192} onChange={event => setDraft(current => ({ ...current, defaultModel: current.defaultModel ? { ...current.defaultModel, contextLimit: Number(event.target.value) } : null }))} disabled={!draft.defaultModel} /></label>
    </details>
    <p className="hint">Agents run one at a time. Coding checks tool use before editing. An unloaded model may fail until it is loaded in its server.</p>
    <footer><button className="primary" onClick={() => run(async () => { await onSave(draft); onClose(); })}>Save settings</button></footer>
  </section></div>;
}

function PlanEditor({ session, run }: { session: Session; run: (job: () => Promise<unknown>) => void }) {
  const [draft, setDraft] = useState<PlanContent>(session.plan ? structuredClone(session.plan.content) : structuredClone(emptyPlan));
  const [feedback, setFeedback] = useState('');
  useEffect(() => { setDraft(session.plan ? structuredClone(session.plan.content) : structuredClone(emptyPlan)); }, [session.id, session.plan?.revision]);
  const editable = ['awaiting_review', 'awaiting_input', 'interrupted', 'failed'].includes(session.status);
  const updateStep = (index: number, key: 'title' | 'details' | 'checks', value: string) => setDraft(current => {
    const steps = current.steps.map((step, i) => i === index ? { ...step, [key]: key === 'checks' ? lines(value) : value } : step);
    return { ...current, steps };
  });
  return <div className="plan-editor"><div className="panel-head"><div><small>PLAN {session.plan ? `· REVISION ${session.plan.revision}` : ''}</small><h2>{session.plan ? 'Review the approach' : 'Waiting for a plan'}</h2></div>{session.plan && <button onClick={() => run(() => window.desktop.exportPlan(session.id))}>Export Markdown</button>}</div>
    {session.plan && <div className="plan-fields"><label className="field"><span>Objective</span><textarea disabled={!editable} rows={2} value={draft.objective} onChange={event => setDraft({ ...draft, objective: event.target.value })} /></label>
      <label className="field"><span>Assumptions · one per line</span><textarea disabled={!editable} rows={3} value={draft.assumptions.join('\n')} onChange={event => setDraft({ ...draft, assumptions: lines(event.target.value) })} /></label>
      {draft.steps.map((step, index) => <div className="plan-step" key={index}><div className="step-title"><strong>Step {index + 1}</strong>{editable && <button className="ghost danger" onClick={() => setDraft({ ...draft, steps: draft.steps.filter((_, i) => i !== index) })}>Remove</button>}</div><label className="field"><span>Title</span><input disabled={!editable} value={step.title} onChange={event => updateStep(index, 'title', event.target.value)} /></label><label className="field"><span>Changes</span><textarea disabled={!editable} rows={3} value={step.details} onChange={event => updateStep(index, 'details', event.target.value)} /></label><label className="field"><span>Checks · one per line</span><textarea disabled={!editable} rows={2} value={step.checks.join('\n')} onChange={event => updateStep(index, 'checks', event.target.value)} /></label></div>)}
      {editable && <button onClick={() => setDraft({ ...draft, steps: [...draft.steps, { title: '', details: '', checks: [] }] })}>Add step</button>}
      <label className="field"><span>Open questions · resolve these before implementation</span><textarea disabled={!editable} rows={3} value={draft.blockers.join('\n')} onChange={event => setDraft({ ...draft, blockers: lines(event.target.value) })} /></label>
      {editable && <div className="plan-actions"><button onClick={() => run(() => window.desktop.savePlan(session.id, draft))}>Save revision</button><button className="primary" disabled={draft.blockers.length > 0 || JSON.stringify(draft) !== JSON.stringify(session.plan.content)} onClick={() => run(() => window.desktop.approvePlan(session.id, session.plan!.revision))}>Approve and implement</button></div>}
      {editable && <div className="feedback"><label className="field"><span>Feedback for another planning cycle</span><textarea rows={3} value={feedback} onChange={event => setFeedback(event.target.value)} placeholder="What should the team revise or investigate?" /></label><button onClick={() => run(async () => { await window.desktop.plan(session.id, feedback); setFeedback(''); })}>Revise with agents</button></div>}
    </div>}
  </div>;
}

function App() {
  const [state, setState] = useState<Snapshot>(initial);
  const [mode, setMode] = useState<'chat' | 'projects'>('chat');
  const [chatId, setChatId] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [objective, setObjective] = useState('');
  const [tab, setTab] = useState<'conversation' | 'plan' | 'changes' | 'commands'>('conversation');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [error, setError] = useState('');
  const [remember, setRemember] = useState(false);
  useEffect(() => {
    window.desktop.snapshot().then(setState).catch(error => setError(String(error)));
    return window.desktop.onUpdate(setState);
  }, []);
  useEffect(() => { if (!projectId && state.projects[0]) setProjectId(state.projects[0].id); }, [state.projects, projectId]);
  const session = state.sessions.find(item => item.id === sessionId) ?? null;
  const project = state.projects.find(item => item.id === (session?.projectId ?? projectId));
  const busy = session && ['planning', 'implementing', 'awaiting_command'].includes(session.status);
  const run = (job: () => Promise<unknown>) => { setError(''); void job().catch(error => setError(String(error?.message ?? error))); };
  const events = session?.events ?? [];
  const commandEvents = events.filter(event => event.kind === 'command');
  const newSession = () => run(async () => {
    if (!projectId) throw new Error('Open a project first.');
    const created = await window.desktop.createSession(projectId, objective);
    setSessionId(created.id); setTab('conversation'); setObjective('');
    await window.desktop.plan(created.id);
  });
  return <div className="app"><aside className="sidebar"><div className="brand"><div className="brand-mark">M</div><strong>Mercury<span className="brand-dot">.</span></strong></div>
    <nav className="mode-nav" aria-label="Main navigation"><button aria-label="Chat" className={mode === 'chat' ? 'active' : ''} onClick={() => setMode('chat')}>◌ <span>Chat</span></button><button aria-label="Projects" className={mode === 'projects' ? 'active' : ''} onClick={() => setMode('projects')}>▱ <span>Projects</span>{state.activeRole && <span className="activity-dot" />}</button></nav>
    {mode === 'chat' ? <><button className="project-button" disabled={Boolean(state.activeChatId)} onClick={() => setChatId(null)}>＋ New chat</button><div className="sidebar-label">RECENT CHATS</div><div className="session-list">{state.chats.map(item => <button key={item.id} className={`session-item ${chatId === item.id ? 'active' : ''}`} onClick={() => setChatId(item.id)}><span>{item.title}</span>{item.status === 'streaming' && <small>Responding…</small>}</button>)}</div></> : <><button className="project-button" onClick={() => run(async () => { const result = await window.desktop.openProject(); if (result) { setProjectId(result.id); setSessionId(null); } })}>＋ Open project</button><div className="sidebar-label">PROJECTS</div><div className="project-list">{state.projects.map(item => <button key={item.id} className={`project-item ${projectId === item.id ? 'active' : ''}`} onClick={() => { setProjectId(item.id); setSessionId(null); }}><span className="folder">▱</span><span>{item.name}</span></button>)}</div><div className="sidebar-label">SESSIONS</div><div className="session-list">{state.sessions.filter(item => !projectId || item.projectId === projectId).map(item => <button key={item.id} className={`session-item ${sessionId === item.id ? 'active' : ''}`} onClick={() => { setSessionId(item.id); setTab('conversation'); }}><span>{item.objective}</span><small>{item.status.replaceAll('_', ' ')}</small></button>)}</div></>}
    <div className="sidebar-bottom"><button onClick={() => setSettingsOpen(true)}>⚙ &nbsp; Model settings</button><small>Your models. Your space.</small></div></aside>
    <main className="main">{mode === 'chat' ? <>{error && <div className="error-banner"><span>{error}</span><button onClick={() => setError('')}>Dismiss</button></div>}<ChatPanel state={state} chatId={chatId} onSelect={setChatId} openSettings={() => setSettingsOpen(true)} /></> : <><header className="topbar"><div><small>{project?.path ?? 'PROJECTS'}</small><h1>{session ? session.objective : 'Plan your next change'}</h1></div><div className="topbar-actions">{session && <span className={`status status-${session.status}`}>{session.status.replaceAll('_', ' ')}</span>}{state.activeRole && <span className="role-badge">{state.activeRole} · {session?.assignments?.[state.activeRole]?.model}</span>}{busy && <button className="danger" onClick={() => run(() => window.desktop.stop(session!.id))}>Stop</button>}{session?.status === 'interrupted' && session.plan?.approved && <button className="primary" onClick={() => run(() => window.desktop.resume(session.id))}>Resume</button>}</div></header>
      {error && <div className="error-banner"><span>{error}</span><button onClick={() => setError('')}>Dismiss</button></div>}
      {!session ? <div className="welcome"><div className="eyebrow">FROM IDEA TO VERIFIED CHANGE</div><h2>What would you like to build?</h2><p>Three planning agents will inspect your project and prepare a plan for your review. Coding starts only after you approve it.</p><textarea rows={5} value={objective} onChange={event => setObjective(event.target.value)} placeholder="Describe the change, constraints, and what success looks like..." /><div className="welcome-footer"><span>{project ? `Working in ${project.name}` : 'Open a project to begin'}</span><button className="primary" disabled={!projectId || !objective.trim() || !state.settings.defaultModel} onClick={newSession}>Start planning →</button></div>{!state.settings.defaultModel && <button className="text-button" onClick={() => setSettingsOpen(true)}>Choose a local model first</button>}</div>
      : <div className="content"><nav className="tabs">{(['conversation', 'plan', 'changes', 'commands'] as const).map(item => <button key={item} className={tab === item ? 'selected' : ''} onClick={() => setTab(item)}>{item[0].toUpperCase() + item.slice(1)}{item === 'changes' && session.changes.length ? ` · ${session.changes.length}` : ''}</button>)}</nav>
        <div className="panel-scroll" key={`${session.id}:${tab}`}>
          {tab === 'conversation' && <div className="timeline"><div className="objective-card"><small>YOUR REQUEST</small><p>{session.objective}</p></div>{events.map(event => <article className={`event event-${event.kind}`} key={event.id}><div className="event-meta"><span>{event.role ?? 'System'} · {event.kind}</span><time>{new Date(event.at).toLocaleTimeString()}</time></div>{event.kind === 'message' && event.text ? <Markdown content={event.text} /> : <pre>{event.text || 'Working…'}</pre>}</article>)}{session.status === 'draft' && <button className="primary" onClick={() => run(() => window.desktop.plan(session.id))}>Start planning</button>}{session.status === 'awaiting_review' && <button className="primary" onClick={() => setTab('plan')}>Review plan →</button>}{session.status === 'awaiting_input' && <button className="primary" onClick={() => setTab('plan')}>Answer open questions →</button>}</div>}
          {tab === 'plan' && <PlanEditor session={session} run={run} />}
          {tab === 'changes' && <div className="changes"><div className="panel-head"><div><small>WORKSPACE</small><h2>Changes made in this session</h2></div></div>{session.changes.length ? session.changes.map((change, index) => <article className="change" key={index}><h3>{change.path}</h3><div className="diff-grid"><div><small>BEFORE</small><pre>{change.before ?? '(new file)'}</pre></div><div><small>AFTER</small><pre>{change.after ?? '(deleted)'}</pre></div></div></article>) : <p className="empty">No files changed in this session.</p>}</div>}
          {tab === 'commands' && <div className="commands"><div className="panel-head"><div><small>VERIFICATION</small><h2>Commands and results</h2></div></div>{commandEvents.length ? commandEvents.map(event => <article className="command-result" key={event.id}><time>{new Date(event.at).toLocaleTimeString()}</time><pre>{event.text}</pre></article>) : <p className="empty">No commands requested yet.</p>}</div>}
        </div>
      </div>}
    </>}</main>
    {session?.command && <div className="modal-backdrop"><section className="modal command-modal"><small>APPROVAL REQUIRED</small><h2>Run this command?</h2><p>The coding agent is waiting for your decision.</p><div className="command-detail"><small>WORKING DIRECTORY</small><code>{session.command.cwd}</code><small>COMMAND</small><code>{session.command.command}</code></div><label className="checkbox"><input type="checkbox" checked={remember} onChange={event => setRemember(event.target.checked)} />Allow this exact command again in this session</label><footer><button onClick={() => run(() => window.desktop.answerCommand(session.id, session.command!.id, false, false))}>Deny</button><button className="primary" onClick={() => run(async () => { await window.desktop.answerCommand(session.id, session.command!.id, true, remember); setRemember(false); })}>Run command</button></footer></section></div>}
    {settingsOpen && <SettingsPanel settings={state.settings} onClose={() => setSettingsOpen(false)} onSave={settings => window.desktop.updateSettings(settings)} run={run} />}
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);


