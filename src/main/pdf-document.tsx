import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import katexCss from 'katex/dist/katex.min.css?raw';

// Inline fonts so math works offline in packaged apps and in a data: document.
const mathFonts = import.meta.glob<string>('/node_modules/katex/dist/fonts/*.woff2', { eager: true, import: 'default', query: '?inline' });
const mathCss = katexCss.replace(/url\(fonts\/([^)]*\.woff2)\)/g, (match, name: string) => {
  const font = mathFonts[`/node_modules/katex/dist/fonts/${name}`];
  return font ? `url("${font}")` : match;
});
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
const schema = {
  ...defaultSchema,
  strip: [...(defaultSchema.strip ?? []), 'style', 'iframe', 'object', 'embed'],
  tagNames: [...(defaultSchema.tagNames ?? []), 'u', 'ins', 'mark', 'sub', 'sup', 'kbd'],
  attributes: { ...defaultSchema.attributes, code: [['className', /^language-/, 'math-inline', 'math-display']] },
};

const styles = `
@page { size: Letter; margin: 19mm 17mm 20mm; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; color: #243245; font: 10.5pt/1.55 'Segoe UI', Arial, sans-serif; }
article { max-width: 100%; }
h1,h2,h3,h4,h5,h6 { color: #142b42; line-height: 1.22; break-after: avoid-page; page-break-after: avoid; }
h1 { font-size: 25pt; font-weight: 700; letter-spacing: -.65pt; margin: 0 0 18pt; padding: 0 0 13pt; border-bottom: 3pt solid #287e9a; }
h2 { font-size: 16pt; margin: 23pt 0 10pt; padding-bottom: 5pt; border-bottom: .6pt solid #d6e3eb; }
h3 { font-size: 12.5pt; margin: 17pt 0 8pt; }
h4,h5,h6 { font-size: 11pt; margin: 12pt 0 6pt; }
p { margin: 0 0 10pt; orphans: 3; widows: 3; }
strong { font-weight: 650; color: #172d43; }
ul,ol { padding-left: 20pt; margin: 6pt 0 12pt; }
li { padding-left: 2pt; margin: 3pt 0; }
li p { margin: 0 0 5pt; }
li::marker { color: #287e9a; }
li ul,li ol { margin: 3pt 0 6pt; }
blockquote { margin: 12pt 0; padding: 9pt 13pt; border-left: 3pt solid #287e9a; background: #eff6fa; color: #354e62; break-inside: avoid-page; }
blockquote p:last-child { margin-bottom: 0; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 9pt; line-height: 1.45; margin: 10pt 0 15pt; }
thead { display: table-header-group; }
tr { break-inside: avoid-page; page-break-inside: avoid; }
th,td { border: .6pt solid #d3dfe8; text-align: left; vertical-align: top; padding: 7pt 8pt; overflow-wrap: anywhere; }
th { background: #e7f0f6; color: #142b42; font-weight: 700; }
tbody tr:nth-child(even) { background: #f7fafc; }
code { font: .88em/1.5 Consolas, 'Courier New', monospace; background: #eff3f7; color: #1c526d; padding: 1pt 3pt; border-radius: 3pt; overflow-wrap: anywhere; }
pre { margin: 11pt 0 15pt; padding: 11pt 13pt; background: #f2f5f8; border: .6pt solid #d9e2ea; border-left: 3pt solid #6897b0; border-radius: 4pt; white-space: pre-wrap; overflow-wrap: anywhere; tab-size: 2; orphans: 3; widows: 3; break-inside: avoid-page; }
pre code { font-size: 8.5pt; line-height: 1.5; padding: 0; background: transparent; color: #263647; }
.hljs-keyword,.hljs-selector-tag,.hljs-built_in { color: #7950a5; font-weight: 600; }
.hljs-string,.hljs-attr { color: #216748; }.hljs-comment { color: #65768a; font-style: italic; }
.hljs-number,.hljs-literal { color: #9f481d; }.hljs-title,.hljs-name { color: #1b5b91; }
a { color: #1b6388; text-decoration: underline; overflow-wrap: anywhere; }
hr { border: 0; border-top: .6pt solid #d6e3eb; margin: 18pt 0; }
.katex-display { margin: 13pt 0; overflow-wrap: anywhere; break-inside: avoid-page; }
.katex { font-size: 1.08em; }.katex-display > .katex { white-space: normal; }
.image-note { color: #65768a; font-style: italic; }
input[type=checkbox] { accent-color: #287e9a; }
`;

export function pdfDocumentHtml(content: string): { html: string; title: string } {
  // Sanitize model HTML before trusted highlighting and math transforms. Code
  // examples remain visible; scripts, styles, and image requests cannot run.
  const title = content.match(/^#\s+(.+)$/m)?.[1].replace(/[`*_]/g, '').trim().slice(0, 160) || 'Mercury document';
  const body = renderToStaticMarkup(<ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeRaw, [rehypeSanitize, schema], [rehypeHighlight, { detect: false }], [rehypeKatex, { trust: false, strict: 'ignore' }]]} components={{
    img: ({ alt }) => <span className="image-note">[Image: {alt || 'image'}]</span>,
    a: ({ href, children }) => href && /^https?:\/\//i.test(href) ? <a href={href}>{children}</a> : <span>{children}</span>,
  }}>{content}</ReactMarkdown>);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:"><title>${escapeHtml(title)}</title><style>${mathCss}\n${styles}</style></head><body><article>${body}</article></body></html>`;
  return { html, title };
}
