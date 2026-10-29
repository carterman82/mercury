import DOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';

// Mermaid's parser sanitizes labels even without rendering. Node needs a DOM
// for that sanitizer; no repository scripts or external resources are loaded.
if (typeof DOMPurify.sanitize !== 'function') {
  const dom = new JSDOM('');
  Object.assign(DOMPurify, DOMPurify(dom.window));
}

export async function validateReportDiagram(diagram: string): Promise<void> {
  if (diagram.length > 256000 || !/^(?:flowchart|graph)\s/i.test(diagram) || /%%\s*\{|(?:^|\n)\s*click\s/i.test(diagram)) throw new Error('A plain Mermaid flowchart is required.');
  const { default: mermaid } = await import('mermaid');
  await mermaid.parse(diagram);
}
