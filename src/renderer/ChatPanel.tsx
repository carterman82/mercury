import React, { useEffect, useRef, useState } from 'react';
import type { ChatFile, DiscoveryResult, ModelProfile, Snapshot } from '../shared/types';
import { CopyButton, Markdown } from './Markdown';
import { ThinkingPanel } from './ThinkingPanel';
import { ModelSelect } from './ModelSelect';

export function ChatPanel({ state, chatId, onSelect, openSettings }: { state: Snapshot; chatId: string | null; onSelect: (id: string) => void; openSettings: () => void }) {
  const chat = state.chats.find(item => item.id === chatId);
  const [profile, setProfile] = useState<ModelProfile | null>(chat?.profile ?? state.settings.defaultModel);
  const [discovery, setDiscovery] = useState<DiscoveryResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [attachments, setAttachments] = useState<ChatFile[]>([]);
  const [attaching, setAttaching] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const importing = useRef(false);
  const viewVersion = useRef(0);
  const chooser = useRef<HTMLInputElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const blocked = Boolean(state.activeChatId || state.activeRole || pending);
  useEffect(() => { viewVersion.current++; dragDepth.current = 0; setDragging(false); setProfile(chat?.profile ?? state.settings.defaultModel); setMessage(''); setError(''); setAttachments([]); }, [chatId]);
  useEffect(() => {
    // Prevent dropping files outside the chat from navigating Electron away.
    const preventNavigation = (event: DragEvent) => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); };
    window.addEventListener('dragover', preventNavigation);
    window.addEventListener('drop', preventNavigation);
    return () => { viewVersion.current++; window.removeEventListener('dragover', preventNavigation); window.removeEventListener('drop', preventNavigation); };
  }, []);
  useEffect(() => { if (!profile && state.settings.defaultModel) setProfile(state.settings.defaultModel); }, [state.settings.defaultModel]);
  useEffect(() => { if (pending && state.activeChatId) onSelect(state.activeChatId); }, [pending, state.activeChatId]);
  useEffect(() => { follow.current = true; }, [chatId]);
  useEffect(() => { if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [chat?.messages.at(-1)?.content, chat?.messages.at(-1)?.reasoning, chat?.messages.length]);
  const refresh = async (force = false) => {
    setScanning(true); setError('');
    try {
      const found = await window.desktop.autoDiscover(force);
      setDiscovery(found);
      const first = found.models.find(item => item.available) ?? found.models[0];
      if (first) setProfile(current => current ?? { provider: first.provider, connectionId: first.connectionId, model: first.id, contextLimit: Math.min(first.contextLimit ?? 8192, 32768) });
    } catch (error) { setError(String(error)); }
    finally { setScanning(false); }
  };
  useEffect(() => { void refresh(); }, [JSON.stringify(state.settings.connections)]);
  const models = [...(discovery?.models ?? [])].sort((a, b) => Number(b.available) - Number(a.available) || a.label.localeCompare(b.label));
  const send = async () => {
    if (!profile || (!message.trim() && !attachments.length) || blocked || attaching) return;
    const text = message.trim();
    const files = attachments;
    setPending(true); setError('');
    try {
      const latest = await window.desktop.snapshot();
      const connection = discovery?.connections.find(item => item.id === profile.connectionId);
      if (connection && !latest.settings.connections.some(item => item.id === connection.id)) await window.desktop.updateSettings({ ...latest.settings, connections: [...latest.settings.connections, connection] });
      setMessage('');
      setAttachments([]);
      const id = await window.desktop.sendChat(chatId, profile, text, files.map(file => file.id));
      onSelect(id);
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); setMessage(current => current || text); setAttachments(files); }
    finally { setPending(false); }
  };
  const attach = async (files: File[]) => {
    if (!files.length) return;
    if (blocked || importing.current) { setError('Wait for the current response or file upload to finish.'); return; }
    if (files.length + attachments.length > 8) { setError('Attach up to eight files per message.'); return; }
    const version = viewVersion.current;
    importing.current = true;
    setAttaching(true); setError('');
    try {
      const selected = await window.desktop.addChatFiles(files);
      if (version === viewVersion.current) setAttachments(current => [...current, ...selected]);
    } catch (error) { if (version === viewVersion.current) setError(error instanceof Error ? error.message : String(error)); }
    finally { importing.current = false; setAttaching(false); }
  };
  const modelPicker = <div className="chat-model-picker composer-model-picker"><ModelSelect label="Chat model" value={profile} models={models} disabled={blocked} scanning={scanning} onChange={value => setProfile(value ?? null)} onOther={openSettings} /><button type="button" className="ghost" onClick={() => void refresh(true)} disabled={scanning || blocked} title="Refresh models" aria-label="Refresh models">↻</button></div>;
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
    {dragging && <div className="chat-drop-overlay" aria-live="polite"><div><span aria-hidden="true">↓</span><strong>{blocked || attaching ? 'Wait for the current response or upload to finish' : 'Drop files to attach'}</strong><p>Documents, spreadsheets, slides, images, code, and more · Up to 8 files, 25 MB each</p></div></div>}
    <header className="chat-toolbar"><div><h1>Chat</h1><p>Try a model. Ask anything.</p></div></header>
    <div className="chat-scroll" ref={scroll} onScroll={() => { if (scroll.current) follow.current = scroll.current.scrollHeight - scroll.current.scrollTop - scroll.current.clientHeight < 140; }}><div className="sr-only" role="status">{chat?.status === 'streaming' ? 'Model response in progress' : ''}</div>
      {chat?.messages.length ? <div className="chat-messages">{chat.messages.map((item, index) => {
        const active = chat.status === 'streaming' && index === chat.messages.length - 1;
        return <article key={item.id} className={`chat-message chat-${item.role}`}><div className="chat-message-label">{item.role === 'user' ? 'You' : item.model ?? 'Mercury'}</div>
          {item.role === 'assistant' && <ThinkingPanel message={item} active={active} />}
          {item.notice && <p className="chat-notice" role="status">{item.notice}</p>}
          <div className="chat-message-content">{item.role === 'user' ? item.content : item.content.trim() ? <Markdown content={item.content} /> : !active && !item.files?.length ? <span className="empty">No answer received.</span> : null}</div>
          {Boolean(item.files?.length) && <div className="chat-files">{item.files!.map(file => <div className="chat-file" key={file.id}><span>📄 {file.name}<small>{file.format ? file.format + ' · ' : ''}{Math.ceil(file.size / 1024)} KB{file.kind === 'upload' && file.readStatus ? ` · ${file.readStatus === 'metadata' ? 'Metadata only' : file.readStatus === 'partial' ? 'Partial extraction' : 'Text available'}` : ''}</small>{file.note && <span className="file-extraction-note">{file.note}</span>}</span><button type="button" onClick={() => void window.desktop.saveChatFile(file.id).catch(error => setError(String(error)))}>Save {file.name}</button></div>)}</div>}
          {item.role === 'assistant' && !active && item.content.trim() && <div className="response-actions"><CopyButton label="Copy response" text={item.content} />{item.startedAt && item.completedAt && <span>{Math.max(1, Math.round((item.completedAt - item.startedAt) / 1000))}s</span>}</div>}
        </article>;
      })}{chat.status === 'interrupted' && <p className="chat-notice">This response was interrupted when Mercury closed. Send a message to continue.</p>}{chat.error && <p className="chat-notice" role="alert">{chat.error}</p>}<div ref={end} /></div> : <div className="chat-empty"><div className="mercury-orbit">M</div><h2>Hello from Mercury.</h2><p>Pick a model below and start a conversation.</p><div className="prompt-suggestions">{['What can you help me with?', 'Explain how local AI models work.', 'Write a small Python guessing game.'].map(prompt => <button key={prompt} onClick={() => setMessage(prompt)}>{prompt}<span>↗</span></button>)}</div></div>}</div>
    <div className="chat-compose-area">{error && <p className="chat-notice" role="alert">{error}</p>}<form className="chat-composer" onSubmit={event => { event.preventDefault(); void send(); }}>
      {Boolean(attachments.length) && <div className="pending-files">{attachments.map(file => <span key={file.id} title={file.note}>{file.name}{file.readStatus === 'metadata' ? ' · metadata only' : file.readStatus === 'partial' ? ' · partial extraction' : ''}<button type="button" aria-label={`Remove ${file.name}`} disabled={blocked} onClick={() => setAttachments(current => current.filter(item => item.id !== file.id))}>×</button></span>)}</div>}
      <input ref={chooser} type="file" multiple className="sr-only" tabIndex={-1} aria-label="Choose chat files" onChange={event => { void attach(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
      <textarea aria-label="Message" placeholder="Message Mercury… or drop files here" rows={2} value={message} maxLength={30000} onChange={event => setMessage(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} /><div className="compose-actions">{modelPicker}{state.activeChatId === chatId && state.activeChatId ? <button type="button" onClick={() => void window.desktop.stopChat(state.activeChatId!).catch(error => setError(String(error)))}>Stop response</button> : <button type="submit" className="primary" disabled={!profile || (!message.trim() && !attachments.length) || blocked || attaching}>Send ↑</button>}</div></form><p className="composer-hint">{attaching ? 'Attaching files…' : 'Drop files anywhere in chat · Ctrl+O to browse'} · Enter to send · Shift + Enter for a new line</p></div>
  </section>;
}

