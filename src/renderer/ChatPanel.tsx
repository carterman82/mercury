import { modelProfile, refreshModelContext } from '../shared/model-context';
import { useDiscovery } from './useDiscovery';
import React, { useEffect, useRef, useState } from 'react';
import type { ChatFile, DiscoveryResult, ModelProfile, Snapshot } from '../shared/types';
import { CopyButton, Markdown } from './Markdown';
import { ThinkingPanel } from './ThinkingPanel';
import { ModelSelect } from './ModelSelect';
import { ContextPanel } from './ContextPanel';
import { MAX_CHAT_ATTACHMENTS } from '../shared/chat-files';
import { ProjectMapsPanel } from './ProjectMaps';
const activityNames: Record<string, string> = { delegate_task: 'Analyze with Subagent', browser_search: 'Search the web', browser_open: 'Read a webpage', browser_read: 'Read more of the page', browser_click: 'Follow a source link', browser_close: 'Close browser', discover_plugins: 'Find plugins', install_plugin: 'Install plugin', plugin_list_tools: 'Inspect plugin tools', plugin_call_tool: 'Use plugin', create_pdf: 'Create PDF', create_file: 'Create file', read_file: 'Read file', create_document: 'Create Word document', create_spreadsheet: 'Create spreadsheet', create_presentation: 'Create presentation', create_graphic: 'Create graphic', create_archive: 'Create archive' };

Object.assign(activityNames, { web_search: 'Search the web', web_fetch: 'Read a web source', recall_context: 'Recall saved sources', browser_screenshot: 'Inspect browser screenshot', browser_enable_controls: 'Request game controls', browser_press: 'Press game keys', browser_pointer: 'Click game viewport' });
Object.assign(activityNames, { list_project_files: 'Browse project files', read_project_file: 'Read project source', search_project_files: 'Search project source', edit_project_file: 'Edit project source', run_project_command: 'Run project command', review_project_changes: 'Review project changes', integrate_project_changes: 'Apply reviewed changes', read_project_notes: 'Read shared project notes', update_project_notes: 'Update shared project notes' });
Object.assign(activityNames, { start_project_task: 'Start project worker', wait_project_tasks: 'Collect worker findings', review_project_task: 'Review worker changes', accept_project_task: 'Accept worker changes', refresh_project_maps: 'Refresh dependency maps', query_project_maps: 'Inspect dependencies' });

export function ChatPanel({ state, chatId, projectId, onSelect, openSettings }: { state: Snapshot; chatId: string | null; projectId?: string; onSelect: (id: string) => void; openSettings: () => void }) {
  const chat = state.chats.find(item => item.id === chatId);
  const project = state.projects.find(item => item.id === (chat?.projectId ?? projectId));
  const [profile, setProfile] = useState<ModelProfile | null>(chat?.profile ?? state.settings.mainModel);
  const { result: discovery, scanning, error: discoveryError, refresh } = useDiscovery(JSON.stringify(state.settings.connections));
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [mapsOpen, setMapsOpen] = useState(false);
  const [attachments, setAttachments] = useState<ChatFile[]>([]);
  const [attaching, setAttaching] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [previewFile, setPreviewFile] = useState<{ id: string; at: number } | null>(null);
  const contextFiles = Array.from(new Map([...(chat?.messages.flatMap(item => item.files ?? []) ?? []), ...attachments].map(file => [file.id, file])).values());
  const browserUsed = Boolean(chat?.messages.some(item => item.toolActivity?.some(action => action.name.startsWith('browser_'))));
  const dragDepth = useRef(0);
  const importing = useRef(false);
  const viewVersion = useRef(0);
  const chooser = useRef<HTMLInputElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const blocked = Boolean(chat?.status === 'streaming' || pending);
  useEffect(() => { viewVersion.current++; dragDepth.current = 0; setDragging(false); setProfile(chat?.profile ?? state.settings.mainModel); setMessage(''); setError(''); setAttachments([]); }, [chatId]);
  // Follow automatic pool routing without replacing an unsent manual selection.
  useEffect(() => { if (chat) setProfile(chat.profile); }, [chatId, JSON.stringify(chat?.profile)]);
  useEffect(() => {
    // Prevent dropping files outside the chat from navigating Electron away.
    const preventNavigation = (event: DragEvent) => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); };
    window.addEventListener('dragover', preventNavigation);
    window.addEventListener('drop', preventNavigation);
    return () => { viewVersion.current++; window.removeEventListener('dragover', preventNavigation); window.removeEventListener('drop', preventNavigation); };
  }, []);
  useEffect(() => { if (!chat && state.settings.mainModel) setProfile(state.settings.mainModel); }, [JSON.stringify(state.settings.mainModel)]);
  useEffect(() => { follow.current = true; }, [chatId]);
  useEffect(() => { if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [chat?.messages.at(-1)?.content, chat?.messages.at(-1)?.reasoning, chat?.messages.length]);
  useEffect(() => {
    const first = discovery?.models.find(item => item.available) ?? discovery?.models[0];
    if (first) setProfile(current => current ?? modelProfile(first));
    if (!chat) setProfile(current => current ? refreshModelContext(current, discovery?.models ?? []) : current);
  }, [discovery]);
  const models = [...(discovery?.models ?? [])].sort((a, b) => Number(b.available) - Number(a.available) || a.label.localeCompare(b.label));
  const send = async () => {
    if (!profile || (!message.trim() && !attachments.length) || blocked || attaching) return;
    const submittedAt = Date.now();
    const text = message.trim();
    const files = attachments;
    const version = viewVersion.current;
    setPending(true); setError('');
    try {
      const latest = await window.desktop.snapshot();
      const connection = discovery?.connections.find(item => item.id === profile.connectionId);
      if (connection && !latest.settings.connections.some(item => item.id === connection.id)) await window.desktop.updateSettings({ ...latest.settings, connections: [...latest.settings.connections, connection] });
      setMessage('');
      setAttachments([]);
      const id = await window.desktop.sendChat(chatId, profile, text, files.map(file => file.id), submittedAt, project?.id);
      if (version === viewVersion.current) onSelect(id);
    } catch (error) { if (version === viewVersion.current) { setError(error instanceof Error ? error.message : String(error)); setMessage(current => current || text); setAttachments(files); } }
    finally { setPending(false); }
  };
  const attach = async (files: File[]) => {
    if (!files.length) return;
    if (blocked || importing.current) { setError('Wait for the current response or file upload to finish.'); return; }
    if (files.length + attachments.length > MAX_CHAT_ATTACHMENTS) { setError(`Attach up to ${MAX_CHAT_ATTACHMENTS} files per message.`); return; }
    const version = viewVersion.current;
    importing.current = true;
    setAttaching(true); setError('');
    try {
      const selected = await window.desktop.addChatFiles(files);
      if (version === viewVersion.current) setAttachments(current => [...current, ...selected]);
    } catch (error) { if (version === viewVersion.current) setError(error instanceof Error ? error.message : String(error)); }
    finally { importing.current = false; setAttaching(false); }
  };
  const modelPicker = <div className="chat-model-picker composer-model-picker"><ModelSelect label="Chat model" value={profile} models={models} connections={state.settings.connections} disabled={blocked} scanning={scanning} onChange={value => setProfile(value ?? null)} onOther={openSettings} /><button type="button" className="ghost" onClick={() => void refresh(true)} disabled={scanning || blocked} title="Refresh models" aria-label="Refresh models">↻</button></div>;
  return <section className={`chat-layout ${dragging ? 'is-dragging' : ''}`} aria-label="Chat" onKeyDown={event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') { event.preventDefault(); if (!blocked && !attaching) chooser.current?.click(); }
  }} onDragEnter={event => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault(); dragDepth.current++; setDragging(true);
  }} onDragOver={event => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault(); event.dataTransfer.dropEffect = blocked || attaching ? 'none' : 'copy';
  }} onDragLeave={event => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault(); dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (!dragDepth.current) setDragging(false);
  }} onDrop={event => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault(); dragDepth.current = 0; setDragging(false);
    void attach(Array.from(event.dataTransfer.files));
  }}>
    {dragging && <div className="chat-drop-overlay" aria-live="polite"><div><span aria-hidden="true">↓</span><strong>{blocked || attaching ? 'Wait for the current response or upload to finish' : 'Drop files to attach'}</strong><p>Documents, spreadsheets, slides, images, code, and more · Up to {MAX_CHAT_ATTACHMENTS} files, 25 MB each</p></div></div>}
    <div className="chat-main"><header className="chat-toolbar"><div><h1>{project?.name ?? 'Chat'}</h1>{project && <small className="project-workspace" title={chat?.workspacePath ?? project.path}>{chat?.workspacePath && chat.workspacePath !== project.path ? `Worktree · ${chat.workspacePath}` : project.path}</small>}</div>{project && <><button type="button" disabled={!chat} onClick={() => setMapsOpen(true)}>Dependency maps</button><label className="project-permissions"><span>🛡 Permissions</span><select aria-label="Project permission mode" value={project.permissionMode ?? 2} onChange={event => void window.desktop.updateProjectPermissions(project.id, Number(event.target.value) as 1 | 2 | 3).catch(error => setError(String(error)))}><option value={1}>1 · Ask before commands</option><option value={2}>2 · Ask before risky actions</option><option value={3}>3 · Full access</option></select></label></>}</header>
    {project && (project.permissionMode ?? 2) !== 3 && !chat?.executionSupport?.available && <p className="project-capability-note" role="status">Restricted commands are unavailable{chat?.executionSupport?.reason ? `: ${chat.executionSupport.reason}` : ' until Windows process confinement is verified for this chat'}. File operations follow this project’s permission setting.</p>}
    {project && chat?.projectAssignments?.length ? <details className="chat-tool-activity project-worker-activity"><summary>Project workers · {chat.projectAssignments.filter(worker => ['completed', 'accepted'].includes(worker.status)).length}/{chat.projectAssignments.length} finished</summary>{chat.projectAssignments.map(worker => <article key={worker.id}><strong>{worker.task}</strong><small>{worker.kind} · {worker.profile.model} · {worker.status}</small>{worker.error && <p role="alert">{worker.error}</p>}{worker.findings && <details><summary>Findings</summary><Markdown content={worker.findings} /></details>}{worker.activity?.some(action => action.name === 'run_project_command') && <details><summary>Recorded checks</summary>{worker.activity.filter(action => action.name === 'run_project_command').map((action, index) => <pre key={index}>{action.status}: {action.result}</pre>)}</details>}</article>)}</details> : null}
    <div className="chat-scroll" ref={scroll} onScroll={() => { if (scroll.current) follow.current = scroll.current.scrollHeight - scroll.current.scrollTop - scroll.current.clientHeight < 140; }}><div className="sr-only" role="status">{chat?.status === 'streaming' ? 'Model response in progress' : ''}</div>
      {chat?.messages.length ? <div className="chat-messages">{chat.messages.map((item, index) => {
        const active = chat.status === 'streaming' && index === chat.messages.length - 1;
        const subagents = item.toolActivity?.filter(action => action.name === 'delegate_task') ?? [];
        const otherTools = item.toolActivity?.filter(action => action.name !== 'delegate_task') ?? [];
        return <article key={item.id} className={`chat-message chat-${item.role}`}><div className="chat-message-label">{item.role === 'user' ? 'You' : item.model ?? 'Mercury'}</div>
          {item.role === 'assistant' && <ThinkingPanel message={item} active={active} />}
          {item.notice && <p className="chat-notice" role="status">{item.notice}</p>}
          {active && item.queued && <p className="chat-notice" role="status">Waiting for a free request slot on this model. Other chats can continue.</p>}
          {Boolean(subagents.length) && <div className="chat-tool-activity chat-subagent-activity" aria-label="Subagent activity">{subagents.map((action, index) => <div key={index}><span role="status">{action.status === 'running' ? 'Working' : action.status === 'succeeded' ? 'Done' : 'Failed'} · {action.label ?? 'Subagent'}</span>{action.result && <details><summary>{action.status === 'failed' ? 'Task error' : 'Subagent findings'}</summary><Markdown content={action.result} /></details>}</div>)}</div>}
          {Boolean(otherTools.length) && <details className="chat-tool-activity"><summary>{active ? 'Working with tools…' : 'Tools used'}</summary>{otherTools.map((action, index) => <div key={index} title={action.name}>{action.status === 'running' ? 'Working' : action.status === 'succeeded' ? 'Done' : 'Failed'} · {activityNames[action.name] ?? action.name}{action.label && ` · ${action.label}`}{action.result && <details><summary>{action.status === 'failed' ? 'Task error' : 'Tool result'}</summary><Markdown content={action.result} /></details>}</div>)}</details>}
          <div className="chat-message-content">{item.role === 'user' ? item.content : item.content.trim() ? <Markdown content={item.content} /> : !active && !item.files?.length ? <span className="empty">No answer received.</span> : null}</div>
          {Boolean(item.files?.length) && <div className="chat-files">{item.files!.map(file => <div className="chat-file" key={file.id}><span>📄 {file.name}<small>{file.format ? file.format + ' · ' : ''}{Math.ceil(file.size / 1024)} KB{file.kind === 'upload' && file.readStatus ? ` · ${file.readStatus === 'metadata' ? 'Metadata only' : file.readStatus === 'partial' ? 'Partial extraction' : 'Text available'}` : ''}</small>{file.note && <span className="file-extraction-note">{file.note}</span>}</span><button type="button" onClick={() => setPreviewFile({ id: file.id, at: Date.now() })}>Preview {file.name}</button><button type="button" onClick={() => void window.desktop.saveChatFile(file.id).catch(error => setError(String(error)))}>Save {file.name}</button></div>)}</div>}
          {item.role === 'assistant' && !active && item.content.trim() && <div className="response-actions"><CopyButton label="Copy response" text={item.content} /></div>}
        </article>;
      })}{chat.status === 'interrupted' && <p className="chat-notice">This response was interrupted when Mercury closed. Send a message to continue.</p>}{chat.error && <p className="chat-notice" role="alert">{chat.error}</p>}<div ref={end} /></div> : <div className="chat-empty"><div className="mercury-orbit">M</div><h2>Hello from Mercury.</h2><p>Pick a model below and start a conversation.</p><div className="prompt-suggestions">{['What can you help me with?', 'Explain how local AI models work.', 'Write a small Python guessing game.'].map(prompt => <button key={prompt} onClick={() => setMessage(prompt)}>{prompt}<span>↗</span></button>)}</div></div>}</div>
    <div className="chat-compose-area">{(state.chatApprovals ?? []).filter(request => request.chatId === chatId).map(request => <section className="chat-approval" key={request.id} aria-label={request.projectId ? 'Project action approval' : 'Plugin approval'}><strong>{request.title}</strong><pre>{request.details}</pre><div><button type="button" onClick={() => void window.desktop.answerChatApproval(request.id, false).catch(error => setError(String(error)))}>Deny</button><button type="button" onClick={() => void window.desktop.answerChatApproval(request.id, true).catch(error => setError(String(error)))}>Allow once</button></div></section>)}{(error || discoveryError) && <p className="chat-notice" role="alert">{error || discoveryError}</p>}<form className="chat-composer" onSubmit={event => { event.preventDefault(); void send(); }}>
      {Boolean(attachments.length) && <div className="pending-files">{attachments.map(file => <span key={file.id} title={file.note}>{file.name}{file.readStatus === 'metadata' ? ' · metadata only' : file.readStatus === 'partial' ? ' · partial extraction' : ''}<button type="button" aria-label={`Remove ${file.name}`} disabled={blocked} onClick={() => setAttachments(current => current.filter(item => item.id !== file.id))}>×</button></span>)}</div>}
      <input ref={chooser} type="file" multiple className="sr-only" tabIndex={-1} aria-label="Choose chat files" onChange={event => { void attach(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
      <textarea aria-label="Message" placeholder="Message Mercury… or drop files here" rows={2} value={message} maxLength={30000} onChange={event => setMessage(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} /><div className="compose-actions">{modelPicker}{chat?.status === 'streaming' ? <button type="button" onClick={() => void window.desktop.stopChat(chat.id).catch(error => setError(String(error)))}>Stop response</button> : <button type="submit" className="primary" disabled={!profile || (!message.trim() && !attachments.length) || blocked || attaching}>Send ↑</button>}</div></form><p className="composer-hint">{attaching ? 'Attaching files…' : 'Drop files anywhere in chat · Ctrl+O to browse'} · Enter to send · Shift + Enter for a new line</p></div>
    </div><ContextPanel key={chatId ?? 'draft'} chatId={chatId} files={contextFiles} browserUsed={browserUsed} requestedFile={previewFile} />{mapsOpen && chatId && <ProjectMapsPanel key={chatId} chatId={chatId} onClose={() => setMapsOpen(false)} />}
  </section>;
}

