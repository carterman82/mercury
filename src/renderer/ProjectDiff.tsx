import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { ProjectDiff } from '../shared/types';
import './project-diff.css';

const MonacoDiff = lazy(() => import('./MonacoDiff'));

class EditorBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <p role="alert">The difference editor could not load. Close and reopen this panel to retry.</p> : this.props.children; }
}

export function ProjectDiffPanel({ chatId, onClose }: { chatId: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef(0);
  const [review, setReview] = useState<ProjectDiff | null>(null);
  const [selected, setSelected] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const refresh = async () => {
    const version = ++request.current;
    setLoading(true); setError('');
    try {
      const result = await window.desktop.projectChanges(chatId);
      if (request.current !== version) return;
      setReview(result); setSelected(current => result.changes.some(change => change.path === current) ? current : result.changes[0]?.path ?? '');
    } catch (error) { if (request.current === version) setError(error instanceof Error ? error.message : String(error)); }
    finally { if (request.current === version) setLoading(false); }
  };
  useEffect(() => {
    dialog.current?.showModal();
    void refresh();
    return () => { request.current++; };
  }, [chatId]);
  const change = review?.changes.find(item => item.path === selected);
  return <dialog ref={dialog} className="project-diff-panel" aria-labelledby="project-diff-title" onCancel={event => { event.preventDefault(); onClose(); }}>
    <header><h2 id="project-diff-title">Project changes</h2><button type="button" onClick={onClose}>Close changes</button></header>
    <div className="project-diff-controls"><button type="button" disabled={loading} onClick={() => void refresh()}>{loading ? 'Reading changes…' : 'Refresh changes'}</button><span>Read-only · Before → Current file</span></div>
    {error && <p role="alert">{error}</p>}
    {review && <><p>{review.baseLabel}</p>{review.truncated && <p role="status">Showing a bounded preview. More changes or file contents were omitted.</p>}
      {review.changes.length ? <><label className="project-diff-file">Changed file<select aria-label="Changed file" value={selected} onChange={event => setSelected(event.target.value)}>{review.changes.map(item => <option key={item.path} value={item.path}>{item.path}{item.binary ? ' · binary or large file' : item.before === null ? ' · added' : item.after === null ? ' · deleted' : ''}</option>)}</select></label>
        {change && (change.binary ? <p>Binary files and files larger than 512 KB are listed without a text preview.</p> : <EditorBoundary key={change.path}><Suspense fallback={<p role="status">Loading difference editor…</p>}><MonacoDiff path={change.path} before={change.before} after={change.after} /></Suspense></EditorBoundary>)}
      </> : <p>No differences to show for this checkpoint.</p>}</>}
  </dialog>;
}
