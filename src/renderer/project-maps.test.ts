import { expect, it } from 'vitest';
import { validateProjectDiagram } from './ProjectMaps';

it.each([
  '%%{init: {"securityLevel":"loose"}}%%\nflowchart LR',
  'flowchart LR\nclick A "https://example.com"',
  '---\nconfig:\n  securityLevel: loose\n---\nflowchart LR',
])('rejects repository-controlled Mermaid configuration or actions', (source) => {
  expect(() => validateProjectDiagram(source)).toThrow();
});
it('allows structural diagrams while enforcing the preview bound', () => {
  expect(() => validateProjectDiagram('flowchart LR\n a["File"] --> b["Method"]')).not.toThrow();
  expect(() => validateProjectDiagram('x'.repeat(256001))).toThrow(/limit/);
});
