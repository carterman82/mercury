import React, { useEffect, useRef, useState } from 'react';
import type { ProjectMapSummary } from '../shared/types';

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
  const [status, setStatus] = useState<ProjectMapSummary | null>(null);
  const [selected, setSelected] = useState('');
  const [source, setSource] = useState('');
  const [svg, setSvg] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const version = useRef(0);
  const load = async (refresh: boolean) => {
    const revision = ++version.current;
    setBusy(true);
    setError('');
    try {
      const next = await (refresh
        ? window.desktop.refreshProjectMaps(chatId)
        : window.desktop.projectMapStatus(chatId));
      if (revision !== version.current) return;
      setStatus(next);
      setSelected((current) => (next.diagrams.includes(current) ? current : (next.diagrams[0] ?? '')));
    } catch (error) {
      if (revision === version.current) setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (revision === version.current) setBusy(false);
    }
  };
  useEffect(() => {
    void load(false);
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
        const diagram = await window.desktop.readProjectDiagram(chatId, selected);
        validateProjectDiagram(diagram.content);
        const { default: mermaid } = await import('mermaid');
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'dark',
          maxTextSize: 256000,
          suppressErrorRendering: true,
          secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize'],
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
  }, [chatId, selected, status?.fresh]);
  return (
    <div className="modal-backdrop">
      <section className="modal project-maps-panel" aria-label="Project dependency maps">
        <header>
          <div>
            <small>PROJECT ARCHITECTURE</small>
            <h2>Dependency maps</h2>
          </div>
          <button onClick={onClose}>Close maps</button>
        </header>
        <div className="project-map-controls">
          <button disabled={busy} onClick={() => void load(true)}>
            {busy ? 'Updating maps…' : 'Refresh maps'}
          </button>
          {status && (
            <span role="status">
              {status.fresh ? 'Up to date' : 'Refresh needed'} · {status.sourceFiles} source files ·{' '}
              {status.unresolvedReferences} unresolved references
            </span>
          )}
        </div>
        {status && (
          <p className="hint">
            Languages: {status.languages.join(', ') || 'No supported source detected'}. Solid lines are confirmed
            relationships; dashed lines are inferred. Dynamic behavior may remain unresolved.
          </p>
        )}
        <label className="field">
          <span>Diagram</span>
          <select
            aria-label="Dependency diagram"
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
          >
            {(status?.diagrams ?? []).map((value) => (
              <option key={value} value={value}>
                {value === 'system.mmd' ? 'System interactions' : (status?.diagramLabels?.[value] ?? value)}
              </option>
            ))}
          </select>
        </label>
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
        {source && (
          <details>
            <summary>Diagram source</summary>
            <pre>{source}</pre>
          </details>
        )}
        {Boolean(status?.diagnostics.length) && (
          <details>
            <summary>Coverage and limitations</summary>
            {status!.diagnostics.slice(0, 50).map((item, index) => (
              <p key={index}>
                {item.file ? item.file + ': ' : ''}
                {item.message}
              </p>
            ))}
          </details>
        )}
      </section>
    </div>
  );
}
