import { expect, it } from 'vitest';
import { pdfDocumentHtml } from './pdf-document';

it('renders report structure, tables, source code, and math instead of printing Markdown markers', () => {
  const { html, title } = pdfDocumentHtml('# Technical Analysis\n\n## File identification\n\n| Property | Value |\n|---|---|\n| **File** | `index.html` |\n\n- First finding\n- Second finding\n\n```html\n<script src="src/main.js"></script>\n```\n\n$$v(x)=6x^{4/3}-6x^{2/3}-16$$');
  expect(title).toBe('Technical Analysis');
  for (const element of ['<h1>Technical Analysis</h1>', '<h2>File identification</h2>', '<table>', '<thead>', '<th>Property</th>', '<strong>File</strong>', '<ul>', '<pre>', 'hljs', 'class="katex']) expect(html).toContain(element);
  expect(html).not.toContain('## File identification');
  expect(html).not.toContain('|---|---|');
  expect(html).not.toContain('```html');
  expect(html).toContain('data:font/woff2;base64,');
});

it('sanitizes active HTML and local links while preserving safe formatting', () => {
  const { html } = pdfDocumentHtml('# Safe\n\n<script>window.badPdf=true</script><style>body{display:none}</style><iframe src="https://example.com"></iframe>\n\n<u onclick="alert(1)">underlined</u><br>next\n\n[local](file:///C:/secret) [bad](javascript:alert%281%29) ![test image](https://example.com/track)');
  expect(html).toContain('<u>underlined</u>');
  expect(html).toContain('<br/>');
  expect(html).toContain('[Image: test image]');
  for (const unsafe of ['<script', '<iframe', 'onclick=', 'window.badPdf', 'display:none', 'file:///C:/secret', '<img', 'https://example.com/track', 'href="javascript:']) expect(html).not.toContain(unsafe);
});
