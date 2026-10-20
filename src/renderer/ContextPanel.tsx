import React, { useEffect, useRef, useState } from 'react';
import type { BrowserPreview, ChatFile, FilePreview } from '../shared/types';
import { Markdown } from './Markdown';

export function ContextPanel({ chatId, files, browserUsed, requestedFile }: { chatId: string | null; files: ChatFile[]; browserUsed: boolean; requestedFile: { id: string; at: number } | null }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'files' | 'browser'>('files');
  const [selected, setSelected] = useState('');
  const [page, setPage] = useState(1);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [browser, setBrowser] = useState<BrowserPreview | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const suppressed = useRef(false);
  const file = files.find(item => item.id === selected);
  const ids = files.map(item => item.id).join(',');
  useEffect(() => {
    suppressed.current = false; setOpen(false); setTab('files'); setSelected(''); setPage(1); setPreview(null); setBrowser(null); setError('');
  }, [chatId]);
  useEffect(() => {
    if (browserUsed) { setTab('browser'); if (!suppressed.current) setOpen(true); }
  }, [chatId, browserUsed]);
  useEffect(() => {
    if (!files.length) { setSelected(''); return; }
    setSelected(files.at(-1)!.id);
    if (!browserUsed && !suppressed.current) setOpen(true);
  }, [chatId, ids]);
  useEffect(() => {
    if (requestedFile && files.some(item => item.id === requestedFile.id)) {
      setSelected(requestedFile.id); setTab('files'); setOpen(true);
    }
  }, [requestedFile]);
  useEffect(() => { setPage(1); }, [selected]);
  useEffect(() => {
    let cancelled = false;
    setPreview(null); setError('');
    if (!open || tab !== 'files' || !file) return;
    setLoading(true);
    void window.desktop.previewChatFile(file.id, page).then(value => { if (!cancelled) setPreview(value); }, reason => { if (!cancelled) setError(String(reason)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, tab, selected, page, chatId]);
  useEffect(() => {
    if (!open || tab !== 'browser' || !chatId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const value = await window.desktop.previewChatBrowser(chatId);
        if (!cancelled) { setBrowser(current => value?.image || !value ? value : { ...value, image: current?.url === value.url ? current.image : undefined }); setError(''); }
      } catch (reason) { if (!cancelled) setError(String(reason)); }
      if (!cancelled) timer = setTimeout(() => void refresh(), 1200);
    };
    void refresh();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [open, tab, chatId]);
  const choose = (next: 'files' | 'browser') => { setTab(next); setOpen(true); setError(''); };
  return <aside className={`context-panel ${open ? 'expanded' : 'collapsed'}`} aria-label="Context panel">
    {!open ? <div className="context-rail"><button type="button" aria-label="Expand context panel" title="Expand context panel" onClick={() => setOpen(true)}>◧</button><button type="button" aria-label="Show context files" title="Files" onClick={() => choose('files')}>▤<small>{files.length || ''}</small></button><button type="button" aria-label="Show AI browser" title="AI browser" onClick={() => choose('browser')}>◎</button></div> : <>
      <header className="context-header"><div role="tablist" aria-label="Context views"><button type="button" role="tab" aria-selected={tab === 'files'} onClick={() => choose('files')}>Files <small>{files.length}</small></button><button type="button" role="tab" aria-selected={tab === 'browser'} onClick={() => choose('browser')}>Browser</button></div><button type="button" aria-label="Shrink context panel" title="Shrink context panel" onClick={() => { suppressed.current = true; setOpen(false); }}>⇥</button></header>
      {tab === 'files' ? <div className="context-files" role="tabpanel" aria-label="Files preview">
        {files.length ? <><div className="context-file-controls"><select aria-label="Preview file" value={selected} onChange={event => setSelected(event.target.value)}>{files.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><button type="button" disabled={!file} onClick={() => file && void window.desktop.saveChatFile(file.id).catch(reason => setError(String(reason)))}>Save</button></div>
          {loading && <p className="context-hint" role="status">Loading preview…</p>}
          {preview?.kind === 'pdf' && <div className="context-pagination"><button type="button" aria-label="Previous PDF page" disabled={loading || page <= 1} onClick={() => setPage(current => current - 1)}>←</button><span>Page {preview.page} of {preview.pages}</span><button type="button" aria-label="Next PDF page" disabled={loading || page >= (preview.pages ?? 1)} onClick={() => setPage(current => current + 1)}>→</button></div>}
          {preview?.note && <p className="context-hint">{preview.note}</p>}
          <div className="context-document">{preview?.image ? <img className={preview.kind === 'pdf' ? 'pdf-page' : ''} src={preview.image} alt={file?.name ?? 'File preview'} /> : preview?.kind === 'text' ? /\.md(?:own)?$/i.test(file?.name ?? '') ? <Markdown content={preview.text ?? ''} /> : <pre>{preview.text || 'No readable text is available for this file.'}</pre> : null}</div>
        </> : <div className="context-empty"><span>▤</span><h3>Your files, beside the chat</h3><p>Drop a file into chat or ask Mercury to create one. Click any file to preview it here.</p></div>}
      </div> : <div className="context-browser" role="tabpanel" aria-label="AI browser preview"><div className="context-address" title={browser?.url}>{browser?.url || 'AI browser'}</div><p className="context-hint">Live view · Controlled by the AI · Updates while this panel is open</p>{browser?.image ? <div className="context-viewport"><img src={browser.image} alt="Live AI browser viewport" /></div> : <div className="context-empty"><span>◎</span><h3>{browser ? 'Waiting for the page' : 'Browse together'}</h3><p>{browser ? 'The website is still rendering.' : 'When Mercury opens a website with Playwright, its live view appears here. Sessions close after five idle minutes.'}</p></div>}</div>}
      {error && <p className="context-hint" role="alert">{error}</p>}
    </>}
  </aside>;
}
