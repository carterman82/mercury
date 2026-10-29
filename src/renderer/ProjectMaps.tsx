import React, { useEffect, useRef, useState } from 'react';
import { Markdown } from './Markdown';
import type { ProjectReport } from '../shared/types';

export function validateProjectDiagram(source: string): void {
  if (source.length > 256000) throw new Error('This diagram exceeds the preview limit.');
  if (/%%\s*\{|(?:^|\n)\s*click\s|^\s*---/i.test(source))
    throw new Error('Diagram configuration directives and interactive actions are disabled in this read-only viewer.');
}
function sanitizeSvg(svg: string): string {
  const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
  if (document.querySelector('parsererror') || document.documentElement.localName !== 'svg')
    throw new Error('The diagram renderer returned invalid SVG.');
  document
    .querySelectorAll('script, foreignObject, iframe, object, embed, a, image')
    .forEach((element) => element.remove());
  for (const element of Array.from(document.querySelectorAll('*')))
    for (const attribute of Array.from(element.attributes)) {
      if (
        /^on/i.test(attribute.name) ||
        /^(?:href|xlink:href|src)$/i.test(attribute.name) ||
        /(?:javascript:|data:|https?:|@import)/i.test(attribute.value)
      )
        element.removeAttribute(attribute.name);
    }
  document.querySelectorAll('style').forEach((element) => {
    if (/@import|(?:https?:|data:|javascript:)/i.test(element.textContent ?? '')) element.remove();
  });
  return document.documentElement.outerHTML;
}

export function ProjectMapsPanel({ chatId, onClose }: { chatId: string; onClose(): void }) {
  const [report, setReport] = useState('');
  const [sources, setSources] = useState(0);
  const [selected, setSelected] = useState('');
  const [source, setSource] = useState('');
  const [svg, setSvg] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('Starting report…');
  const [metadata, setMetadata] = useState<ProjectReport | null>(null);
  const version = useRef(0);
  const show = (result: ProjectReport) => {
    setReport(result.content.replace(/```mermaid\s*\n[\s\S]*?```/i, ''));
    setSources(result.sources);
    setSelected(result.diagram);
    setMetadata(result);
  };
  const load = async (regenerate = false) => {
    const revision = ++version.current;
    setBusy(true);
    setError('');
    setProgress('Checking changed diagrams or rejoining the current report…');
    try {
      if (!regenerate) {
        const cached = await window.desktop.cachedProjectReport(chatId);
        if (revision !== version.current) return;
        if (cached) show(cached);
      }
      const result = await window.desktop.generateProjectReport(chatId, regenerate);
      if (revision !== version.current) return;
      show(result);
    } catch (error) {
      if (revision === version.current) setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (revision === version.current) setBusy(false);
    }
  };
  useEffect(() => window.desktop.onProjectReportProgress((id, message) => {
    if (id === chatId) setProgress(message);
  }), [chatId]);
  useEffect(() => {
    void load();
    return () => {
      version.current++;
    };
  }, [chatId]);
  useEffect(() => {
    let cancelled = false;
    setSvg('');
    setSource('');
    if (!selected) return;
    void (async () => {
      try {
        const diagram = { content: selected };
        validateProjectDiagram(diagram.content);
        const { default: mermaid } = await import('mermaid');
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          htmlLabels: false,
          theme: 'dark',
          maxTextSize: 256000,
          suppressErrorRendering: true,
          secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'htmlLabels'],
          flowchart: { htmlLabels: false },
        });
        await mermaid.parse(diagram.content);
        const rendered = await mermaid.render(
          `project-map-${crypto.randomUUID().replaceAll('-', '')}`,
          diagram.content,
        );
        if (!cancelled) {
          setSource(diagram.content);
          setSvg(sanitizeSvg(rendered.svg));
          setError('');
        }
      } catch (error) {
        if (!cancelled) setError(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chatId, selected]);
  return (
    <div className="modal-backdrop">
      <section className="modal project-maps-panel" aria-label="Project architecture report">
        <header>
          <div>
            <small>PROJECT ARCHITECTURE</small>
            <h2>Architecture report</h2>
          </div>
          <button onClick={onClose}>Close report</button>
        </header>
        <div className="project-map-controls">
          <button disabled={busy} onClick={() => void load()}>
            {busy ? 'Checking report…' : source ? 'Update Report' : 'Generate Report'}
          </button>
          <button disabled={busy} onClick={() => void load(true)} title="Ignore saved report and analysis; analyze every diagram again">Start from scratch</button>
          {source && <button onClick={() => void window.desktop.saveProjectReport(chatId).catch(error => setError(String(error)))}>Save .mmd</button>}
        </div>
        {busy && <p role="status">{progress} You can close this window and reopen it to view the same report.</p>}
        {sources > 0 && <p className="hint">Subagents analyzed {sources} existing architecture diagrams; Main synthesized this overview. Diagrams were not rebuilt and may reflect an earlier project state. Nodes group scripts by responsibility; dashed arrows show inferred relationships.</p>}
        {metadata?.generatedAt && <p className="hint">Saved {new Date(metadata.generatedAt).toLocaleString()} · Source commit: {metadata.lastCommit?.slice(0, 12) ?? 'No Git commit'} · Changes are checked against saved diagram contents, including uncommitted edits.</p>}
        {error && (
          <p role="alert" className="hint danger">
            {error}
          </p>
        )}
        <div
          className="project-map-canvas"
          aria-label="Dependency diagram preview"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
        {report && <Markdown content={report} />}
        {source && (
          <details>
            <summary>Diagram source</summary>
            <pre>{source}</pre>
          </details>
        )}
      </section>
    </div>
  );
}
