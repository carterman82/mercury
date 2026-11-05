import { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor/editor/editor.api.js';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';

(self as typeof self & { MonacoEnvironment?: unknown }).MonacoEnvironment = { getWorker: () => new EditorWorker() };

export default function MonacoDiff({ path, before, after }: { path: string; before: string | null; after: string | null }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const original = monaco.editor.createModel(before ?? '', undefined, monaco.Uri.parse(`mercury-before:///${encodeURIComponent(path)}`));
    const modified = monaco.editor.createModel(after ?? '', undefined, monaco.Uri.parse(`mercury-after:///${encodeURIComponent(path)}`));
    const editor = monaco.editor.createDiffEditor(host.current, { readOnly: true, originalEditable: false, automaticLayout: true, theme: 'vs-dark', renderSideBySide: true, minimap: { enabled: false }, scrollBeyondLastLine: false, accessibilitySupport: 'on' });
    editor.setModel({ original, modified });
    return () => { editor.dispose(); original.dispose(); modified.dispose(); };
  }, [path, before, after]);
  return <div className="project-diff-editor" ref={host} aria-label={`Read-only differences for ${path}`} />;
}
