import React, { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import './markdown.css';

// Model HTML is sanitized before the trusted math/highlighting transforms run.
const schema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), 'u', 'ins', 'mark', 'sub', 'sup', 'kbd'],
  attributes: { ...defaultSchema.attributes, code: [['className', /^language-/, 'math-inline', 'math-display']] },
};

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [status, setStatus] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return <button type="button" className="copy-button" aria-label={label} title={status === 'Copy failed' ? 'Select the text and copy it manually.' : label} onClick={async () => {
    try { await navigator.clipboard.writeText(text); setStatus('Copied'); }
    catch { setStatus('Copy failed'); }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus(''), 1800);
  }}>{status || 'Copy'}</button>;
}

function plainText(children: ReactNode): string {
  return React.Children.toArray(children).map(child => {
    if (typeof child === 'string' || typeof child === 'number') return String(child);
    return React.isValidElement<{ children?: ReactNode }>(child) ? plainText(child.props.children) : '';
  }).join('');
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const code = React.Children.toArray(children).find(child => React.isValidElement(child));
  const className = React.isValidElement<{ className?: string }>(code) ? code.props.className ?? '' : '';
  const language = /language-([^\s]+)/.exec(className)?.[1] ?? 'Code';
  return <div className="code-block"><div className="code-header"><span>{language}</span><CopyButton label="Copy code" text={plainText(children).replace(/\n$/, '')} /></div><pre>{children}</pre></div>;
}

function SafeLink({ href, children }: { href?: string; children?: ReactNode }) {
  const [failed, setFailed] = useState(false);
  if (!href || !/^https?:\/\//i.test(href)) return <span>{children}</span>;
  return <><a href={href} title={href} onClick={event => {
    event.preventDefault();
    void window.desktop.openLink(href).catch(() => setFailed(true));
  }}>{children}</a>{failed && <span className="link-error"> (could not open link)</span>}</>;
}

const components: Components = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  a: ({ href, children }) => <SafeLink href={href}>{children}</SafeLink>,
  // Do not load tracking images or local file URLs supplied by a model.
  img: ({ alt }) => <span className="image-placeholder">[Image: {alt || 'image'}]</span>,
  table: ({ children }) => <div className="table-scroll"><table>{children}</table></div>,
};

export const Markdown = memo(function Markdown({ content }: { content: string }) {
  return <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeRaw, [rehypeSanitize, schema], [rehypeHighlight, { detect: false }], [rehypeKatex, { trust: false, strict: 'ignore' }]]} components={components}>{content.trimStart()}</ReactMarkdown></div>;
});
