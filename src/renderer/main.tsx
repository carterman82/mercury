import { ConnectionProgress } from './ConnectionProgress';
import { refreshModelContext } from '../shared/model-context';
import { useDiscovery } from './useDiscovery';
import { connectionGroups } from '../shared/connections';
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ModelConnection, ModelInfo, ModelProfile, ProviderKind, Session, Settings, Snapshot } from '../shared/types';
import './style.css';
import { ChatPanel } from './ChatPanel';
import { Markdown } from './Markdown';
import { RoleModels } from './RoleModels';

const modelRoles = [
  { key: 'plannerModel', label: 'Planner model', description: 'Plans project infrastructure and the approach to project changes.' },
  { key: 'mainModel', label: 'Main model', description: 'Handles chats, everyday tasks, and direct project implementation.' },
  { key: 'subagentModel', label: 'Subagent model', description: 'Breaks down data and handles small analysis tasks for the Main model.' },
] as const;
const initial: Snapshot = { projects: [], sessions: [], chats: [], settings: { connections: [], mainModel: null, plannerModel: null, subagentModel: null }, activeRole: null, activeChatId: null };

function SettingsPanel({ settings, onClose, onSave, run }: { settings: Settings; onClose: () => void; onSave: (settings: Settings) => Promise<void>; run: (job: () => Promise<unknown>) => void }) {
  const [draft, setDraft] = useState<Settings>(structuredClone(settings));
  const { result: discovery, scanning, checked, error: discoveryError, refresh, update: updateDiscovery } = useDiscovery(JSON.stringify(settings.connections));
  const models = discovery?.models ?? [];
  const reachable = new Set(discovery?.connections.map(item => item.id) ?? []);
  const [other, setOther] = useState(false);
  const [manual, setManual] = useState<{ provider: ProviderKind; label: string; url: string; apiToken: string }>({ provider: 'lmstudio', label: '', url: '', apiToken: '' });
  const [manualError, setManualError] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [busyMessage, setBusyMessage] = useState('Connecting…');
  const [signingIn, setSigningIn] = useState(false);
  const [codexSignIn, setCodexSignIn] = useState(false);
  const [cloudKey, setCloudKey] = useState('');
  const [cloudProvider, setCloudProvider] = useState<'openai' | 'claude'>('claude');
  const syncAccounts = async () => {
    const latest = await window.desktop.snapshot();
    setDraft(current => {
      const connections = [...current.connections.filter(item => item.provider === 'ollama' || item.provider === 'lmstudio' || latest.settings.connections.some(saved => saved.id === item.id))
        .map(item => ({ ...latest.settings.connections.find(saved => saved.id === item.id), ...item, hasToken: latest.settings.connections.find(saved => saved.id === item.id)?.hasToken ?? item.hasToken })),
        ...latest.settings.connections.filter(item => !current.connections.some(saved => saved.id === item.id))];
      return { ...current, connections,
        additionalMainModels: current.additionalMainModels?.filter(profile => connections.some(item => item.id === profile.connectionId)),
        additionalSubagentModels: current.additionalSubagentModels?.filter(profile => connections.some(item => item.id === profile.connectionId)),
        ...Object.fromEntries(modelRoles.map(({ key }) => [key, current[key] && connections.some(item => item.id === current[key]?.connectionId) ? current[key] : null])) };
    });
    await refresh(true);
  };
  const connect = async (job: () => Promise<void>, message = 'Updating connection…') => {
    setBusyMessage(message); setConnecting(true); setManualError('');
    try { await job(); setBusyMessage('Loading your models…'); await syncAccounts(); }
    catch (error) { setManualError(error instanceof Error ? error.message : String(error)); }
    finally { setConnecting(false); }
  };
  const signIn = async (id?: string) => {
    setSigningIn(true);
    try { await connect(() => window.desktop.connectChatGPT(id), 'Connecting with ChatGPT…'); }
    finally { setSigningIn(false); }
  };
  useEffect(() => {
    if (!discovery) return;
    setDraft(current => ({ ...current, ...Object.fromEntries(modelRoles.map(({ key }) => [key, current[key] ? refreshModelContext(current[key]!, discovery.models) : null])),
      additionalMainModels: current.additionalMainModels?.map(profile => refreshModelContext(profile, discovery.models)),
      additionalSubagentModels: current.additionalSubagentModels?.map(profile => refreshModelContext(profile, discovery.models)),
      connections: [...current.connections.map(saved => {
      const found = discovery.connections.find(item => item.id === saved.id);
      return found ? { ...saved, deviceId: found.deviceId, deviceLabel: found.deviceLabel } : saved;
    }), ...discovery.connections.filter(item => !current.connections.some(saved => saved.id === item.id))] }));
  }, [discovery]);
  const connectCodex = async () => {
    setCodexSignIn(true);
    try { await connect(() => window.desktop.connectCodex(), 'Connecting with Codex…'); }
    finally { setCodexSignIn(false); }
  };
  const addOther = () => run(async () => {
    setConnecting(true); setBusyMessage('Checking model server…'); setManualError('');
    const id = `other-${manual.provider}-${crypto.randomUUID()}`;
    const connection: ModelConnection = { id, provider: manual.provider, label: manual.label.trim() || `${manual.provider === 'ollama' ? 'Ollama' : 'LM Studio'} (Other)`, url: manual.url.trim(), ...(manual.apiToken ? { apiToken: manual.apiToken } : {}) };
    try {
      const discovered = await window.desktop.discover(connection);
      setDraft(current => ({ ...current, connections: [...current.connections, connection] }));
      updateDiscovery({ connections: [...(discovery?.connections ?? []), connection], models: [...models, ...discovered], applications: discovery?.applications ?? [], diagnostics: discovery?.diagnostics ?? [] });
      setOther(false);
      setManual({ provider: 'lmstudio', label: '', url: '', apiToken: '' });
    } catch (error) { setManualError(String(error)); }
    finally { setConnecting(false); }
  });
  const hasModels = models.length > 0;
  const busy = connecting || scanning;
  const cancelSignIn = signingIn ? () => run(() => window.desktop.cancelChatGPTSignIn()) : codexSignIn ? () => run(() => window.desktop.cancelCodexSignIn()) : undefined;
  return <div className={`modal-backdrop ${busy ? 'is-busy' : ''}`}><section className="modal settings-modal" aria-busy={busy}><div className="settings-content" inert={busy}><header><div><small>CONNECTIONS</small><h2>Models and accounts</h2></div><button className="ghost" onClick={() => {
    if (signingIn) run(() => window.desktop.cancelChatGPTSignIn());
    if (codexSignIn) run(() => window.desktop.cancelCodexSignIn());
    onClose();
  }}>Close</button></header>
    <section className="cloud-accounts"><h3>Cloud accounts</h3><h4>ChatGPT sign-in</h4>
      <button disabled={connecting} onClick={() => void signIn()}>{signingIn ? 'Waiting for browser sign-in…' : 'Continue with ChatGPT'}</button>
      {signingIn && <button onClick={() => void window.desktop.cancelChatGPTSignIn().catch(error => setManualError(String(error)))}>Cancel sign-in</button>}
      <button disabled={connecting} aria-describedby="codex-description" onClick={() => void connectCodex()}>{codexSignIn ? 'Waiting for Codex sign-in…' : 'Connect with Codex'}</button>
      {codexSignIn && <button onClick={() => void window.desktop.cancelCodexSignIn().catch(error => setManualError(String(error)))}>Cancel Codex sign-in</button>}
      <small id="codex-description" className="coming-soon">Experimental · Uses the installed Codex app or CLI and its own sign-in.</small>
      <h4>API keys</h4>
      <div className="cloud-key-form"><label className="field"><span>API provider</span><select disabled={connecting} value={cloudProvider} onChange={event => { setCloudProvider(event.target.value as 'openai' | 'claude'); setCloudKey(''); }}><option value="claude">Claude</option><option value="openai">OpenAI</option></select></label><label className="field"><span>API key</span><input disabled={connecting} type="password" autoComplete="off" value={cloudKey} onChange={event => setCloudKey(event.target.value)} placeholder={cloudProvider === 'claude' ? 'Claude Console API key' : 'OpenAI API key'} /></label><button disabled={connecting || !cloudKey.trim()} onClick={() => void connect(async () => {
        const connection: ModelConnection = { id: `api-${cloudProvider}`, provider: cloudProvider, label: `${cloudProvider === 'claude' ? 'Claude' : 'OpenAI'} API`, url: cloudProvider === 'claude' ? 'https://api.anthropic.com' : 'https://api.openai.com', apiToken: cloudKey.trim() };
        await window.desktop.discover(connection);
        const latest = await window.desktop.snapshot();
        await window.desktop.updateSettings({ ...latest.settings, connections: [...latest.settings.connections.filter(item => item.id !== connection.id), connection] });
        setCloudKey('');
      })}>Connect API key</button></div>
      {manualError && <p className="hint danger" role="alert">{manualError}</p>}
    </section>
    <div className="discovery-head"><button onClick={() => void refresh(true)} disabled={scanning}>{scanning ? 'Scanning…' : 'Refresh models'}</button></div>
    {discoveryError && <p className="hint danger" role="alert">{discoveryError}</p>}
    {!hasModels && checked && !scanning && <p className="hint">No models available. Connect an account or start a model server.</p>}
    <button className="text-button" onClick={() => setOther(value => !value)}>Other: add a server address</button>
    {other && <div className="other-server"><label className="field"><span>Server type</span><select value={manual.provider} onChange={event => setManual(current => ({ ...current, provider: event.target.value as ProviderKind }))}><option value="lmstudio">LM Studio</option><option value="ollama">Ollama</option></select></label><label className="field"><span>Name</span><input value={manual.label} onChange={event => setManual(current => ({ ...current, label: event.target.value }))} placeholder="My model server" /></label><label className="field"><span>Server address</span><input value={manual.url} onChange={event => setManual(current => ({ ...current, url: event.target.value }))} placeholder="http://host:1234" /></label><label className="field"><span>API token (if required)</span><input type="password" value={manual.apiToken} onChange={event => setManual(current => ({ ...current, apiToken: event.target.value }))} autoComplete="off" /></label><button onClick={addOther}>Check and add</button>{manualError && <p className="hint danger">{manualError}</p>}</div>}
    <section className="connection-groups" aria-label="Model connections">{connectionGroups(draft.connections.filter(connection => reachable.has(connection.id) && models.some(model => model.connectionId === connection.id)), models).map(group => <article className="connection-box" key={group.id}>
      <h3>{group.label}</h3>{group.connections.map(connection => <div className="connection-server" key={connection.id}>
        <div className="connection-heading"><span><strong>{connection.label}</strong><small>Connected{connection.provider === 'codex' ? ' · Codex · Experimental' : connection.auth === 'chatgpt' ? ' · ChatGPT plan' : connection.provider === 'openai' || connection.provider === 'claude' ? ' · API billing' : ''}</small></span>
        {(connection.provider === 'openai' || connection.provider === 'claude' || connection.provider === 'codex') && <span>{connection.provider === 'codex' && <button disabled={connecting} onClick={() => void connectCodex()}>Reconnect</button>}{connection.auth === 'chatgpt' && <button disabled={connecting} onClick={() => void signIn(connection.id)}>Reconnect</button>}<button disabled={connecting} onClick={() => void connect(() => window.desktop.disconnectConnection(connection.id))}>Disconnect</button></span>}</div>
        {(connection.provider === 'lmstudio' || connection.provider === 'ollama') ? [true, false].map(loaded => {
          const list = group.models.filter(model => model.connectionId === connection.id && model.available === loaded);
          return list.length ? <div className="model-load-group" key={String(loaded)}><h4>{loaded ? 'Loaded' : 'Not loaded'}</h4><ul>{list.map(model => <li key={JSON.stringify([model.connectionId, model.id])}>{model.label}</li>)}</ul></div> : null;
        }) : <ul>{group.models.filter(model => model.connectionId === connection.id).map(model => <li key={JSON.stringify([model.connectionId, model.id])}>{model.label}</li>)}</ul>}
        {reachable.has(connection.id) && (connection.provider === 'lmstudio' || connection.provider === 'ollama') && <label className="field compact"><span>Concurrent requests per model · {connection.label}</span><input type="number" min={1} max={32} placeholder="Automatic" value={connection.maxConcurrentRequests ?? ''} onChange={event => { const limit = event.target.value ? Number(event.target.value) : undefined; setDraft(current => ({ ...current, connections: current.connections.map(item => item.id === connection.id ? { ...item, maxConcurrentRequests: limit } : item) })); }} /></label>}
      </div>)}
    </article>)}</section>
    {hasModels && <section aria-label="Model roles"><h3>Model roles</h3><div className="model-grid">{modelRoles.map(({ key, label, description }) => {
      const extrasKey = key === 'mainModel' ? 'additionalMainModels' : key === 'subagentModel' ? 'additionalSubagentModels' : null;
      return <RoleModels key={key} label={label} description={description} value={draft[key]} extras={extrasKey ? draft[extrasKey] : []} models={models} connections={draft.connections} onOther={() => setOther(true)} optional={key !== 'mainModel'} onChange={(profile, extras) => setDraft(current => ({ ...current, [key]: profile, ...(extrasKey ? { [extrasKey]: extras } : {}) }))} />;
    })}</div></section>}
    <p className="hint">Context defaults to the reported or published model maximum. You can lower it manually.</p>
    <p className="hint">Unset Planner and Subagent models use Main. Subagents return read-only findings; Main handles changes. Project chats start directly with Main and inherit project permissions.</p>
    <footer><button className="primary" disabled={connecting} onClick={() => run(async () => { setBusyMessage('Saving settings…'); setConnecting(true); try { await onSave(draft); onClose(); } finally { setConnecting(false); } })}>Save settings</button></footer>
  </div></section>{busy && <ConnectionProgress message={connecting ? busyMessage : 'Refreshing models…'} browserSignIn={signingIn || codexSignIn} onCancel={cancelSignIn} />}</div>;
}

function LegacySession({ session }: { session: Session }) {
  return <section className="legacy-session"><header><small>LEGACY HISTORY · READ ONLY</small><h1>{session.objective}</h1><p>{session.status.replaceAll('_', ' ')}</p></header>
    <details open><summary>Conversation</summary>{session.events.map(event => <article className="event" key={event.id}><small>{event.role ?? 'System'} · {event.kind}</small><Markdown content={event.text || 'Working…'} /></article>)}</details>
    {session.plan && <details><summary>Plan · revision {session.plan.revision}</summary><h2>{session.plan.content.objective}</h2>{session.plan.content.assumptions.map((item, i) => <p key={i}>{item}</p>)}{session.plan.content.steps.map((step, i) => <article key={i}><h3>{step.title}</h3><p>{step.details}</p><ul>{step.checks.map((check, j) => <li key={j}>{check}</li>)}</ul></article>)}{session.plan.content.blockers.map((item, i) => <p key={i}>{item}</p>)}</details>}
    <details><summary>Changes · {session.changes.length}</summary>{session.changes.map((change, i) => <article key={i}><h3>{change.path}</h3><div className="diff-grid"><pre>{change.before ?? '(new file)'}</pre><pre>{change.after ?? '(deleted)'}</pre></div></article>)}</details>
  </section>;
}

function App() {
  const [state, setState] = useState<Snapshot>(initial);
  const [mode, setMode] = useState<'chat' | 'projects'>('chat');
  const [chatId, setChatId] = useState<string | null>(null);
  const [projectChatId, setProjectChatId] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { window.desktop.snapshot().then(setState).catch(error => setError(String(error))); return window.desktop.onUpdate(setState); }, []);
  useEffect(() => { if (!projectId && state.projects[0]) { setProjectId(state.projects[0].id); setExpanded(current => new Set([...current, state.projects[0].id])); } }, [state.projects, projectId]);
  const session = state.sessions.find(item => item.id === sessionId);
  const project = state.projects.find(item => item.id === projectId);
  const run = (job: () => Promise<unknown>) => { setError(''); void job().catch(error => setError(String(error?.message ?? error))); };
  const selectProject = (id: string) => { setProjectId(id); setProjectChatId(null); setSessionId(null); setExpanded(current => new Set([...current, id])); };
  const chatButton = (id: string, title: string, streaming: boolean, selected: boolean, onClick: () => void) => <button key={id} className={`session-item ${selected ? 'active' : ''}`} onClick={onClick}><span>{title}</span>{streaming && <small>Responding…</small>}</button>;
  return <div className="app"><aside className="sidebar"><div className="brand"><div className="brand-mark">M</div><strong>Mercury<span className="brand-dot">.</span></strong></div>
    <nav className="mode-nav" aria-label="Main navigation"><button aria-label="Chat" className={mode === 'chat' ? 'active' : ''} onClick={() => setMode('chat')}>◌ <span>Chat</span></button><button aria-label="Projects" className={mode === 'projects' ? 'active' : ''} onClick={() => setMode('projects')}>▱ <span>Projects</span></button></nav>
    {mode === 'chat' ? <><button className="project-button" onClick={() => setChatId(null)}>＋ New chat</button><div className="sidebar-label">RECENT CHATS</div><div className="session-list">{state.chats.filter(item => !item.projectId).map(item => chatButton(item.id, item.title, item.status === 'streaming', chatId === item.id, () => setChatId(item.id)))}</div></> : <><button className="project-button" onClick={() => run(async () => { const result = await window.desktop.openProject(); if (result) selectProject(result.id); })}>＋ Open project</button><div className="sidebar-label">PROJECTS</div><div className="project-tree">{state.projects.map(item => <section key={item.id} className="project-group"><div className="project-group-heading"><button aria-label={`${expanded.has(item.id) ? 'Collapse' : 'Expand'} ${item.name}`} aria-expanded={expanded.has(item.id)} className="project-expand" onClick={() => setExpanded(current => { const next = new Set(current); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next; })}>{expanded.has(item.id) ? '▾' : '▸'}</button><button className={`project-item ${projectId === item.id ? 'active' : ''}`} title={item.path} onClick={() => selectProject(item.id)}>▱ {item.name}</button></div>{expanded.has(item.id) && <div className="project-chats"><button className="project-new-chat" onClick={() => selectProject(item.id)}>＋ New chat</button>{state.chats.filter(chat => chat.projectId === item.id).map(chat => chatButton(chat.id, chat.title, chat.status === 'streaming', projectChatId === chat.id && !sessionId, () => { setProjectId(item.id); setProjectChatId(chat.id); setSessionId(null); }))}{state.sessions.some(session => session.projectId === item.id) && <details className="legacy-history"><summary>Legacy history · read only</summary>{state.sessions.filter(session => session.projectId === item.id).map(session => <button key={session.id} className={`session-item ${sessionId === session.id ? 'active' : ''}`} onClick={() => { setProjectId(item.id); setSessionId(session.id); }}><span>{session.objective}</span><small>{session.status.replaceAll('_', ' ')}</small></button>)}</details>}</div>}</section>)}</div></>}
    <div className="sidebar-bottom"><button onClick={() => setSettingsOpen(true)}>⚙ &nbsp; Model settings</button></div></aside>
    <main className="main">{error && <div className="error-banner"><span>{error}</span><button onClick={() => setError('')}>Dismiss</button></div>}{mode === 'chat' ? <ChatPanel key="ordinary" state={state} chatId={chatId} onSelect={setChatId} openSettings={() => setSettingsOpen(true)} /> : session ? <LegacySession session={session} /> : project ? <ChatPanel key={project.id} state={state} chatId={projectChatId} projectId={project.id} onSelect={setProjectChatId} openSettings={() => setSettingsOpen(true)} /> : <div className="welcome"><div className="eyebrow">PROJECTS</div><h2>Work on a local project</h2><p>Open a folder to start a project chat with Main. Keep related conversations together and choose the project’s permission setting.</p><button className="primary" onClick={() => run(async () => { const result = await window.desktop.openProject(); if (result) selectProject(result.id); })}>Open project</button></div>}</main>
    {settingsOpen && <SettingsPanel settings={state.settings} onClose={() => setSettingsOpen(false)} onSave={settings => window.desktop.updateSettings(settings)} run={run} />}
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);