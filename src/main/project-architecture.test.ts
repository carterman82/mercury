import { expect, it } from 'vitest';
import { architectureSchema, reconcileArchitecture, renderArchitecture } from './project-architecture';
import { validateReportDiagram } from './report-diagram';

it('reconciles supported component aliases and aggregates repeated observed calls', () => {
  const result = reconcileArchitecture(architectureSchema.parse({ components: [
    { id: 'writer-a', name: 'Publishing', responsibility: 'publishes generated posts', kind: 'application', evidence: ['a.ts'] },
    { id: 'writer-b', name: 'Post Publisher', responsibility: 'publishes generated posts', kind: 'application', evidence: ['b.ts'] },
    { id: 'cms', name: 'CMS API', kind: 'external', evidence: ['client.ts'] },
  ], relationships: [
    { source: 'writer-a', target: 'cms', type: 'publishes_to', observed: true, evidence: ['a.ts:4'] },
    { source: 'writer-b', target: 'cms', type: 'publishes_to', observed: true, evidence: ['b.ts:7'] },
  ] }));
  expect(result.components).toHaveLength(2);
  expect(result.relationships).toEqual([expect.objectContaining({ source: 'writer-a', target: 'cms', evidence: ['a.ts:4', 'b.ts:7'] })]);
});

it('does not merge similar names without responsibility evidence and retains storage', () => {
  const result = reconcileArchitecture(architectureSchema.parse({ components: [
    { id: 'validate', name: 'Validate', kind: 'application', evidence: ['validate.ts'], uncertainty: 'Unknown responsibility' },
    { id: 'validation', name: 'Validation', kind: 'application', evidence: ['rules.ts'], uncertainty: 'Unknown responsibility' },
    { id: 'db', name: 'Content Database', kind: 'storage', evidence: ['db.ts'] },
  ], relationships: [{ source: 'validate', target: 'db', type: 'writes', observed: true, evidence: ['validate.ts:10'] }] }));
  expect(result.components).toHaveLength(3);
  expect(result.components.find(component => component.id === 'db')?.kind).toBe('storage');
});

it('renders validated Mermaid deterministically without inventing data flow', async () => {
  const architecture = architectureSchema.parse({ components: [
    { id: 'api', name: 'Content API', responsibility: 'serves content', kind: 'application', group: 'Application', evidence: ['api.ts'] },
    { id: 'job', name: 'Publishing', responsibility: 'publishes posts', kind: 'application', group: 'Application', evidence: ['job.ts'] },
    { id: 'store', name: 'Content Store', kind: 'storage', evidence: ['store.ts'], uncertainty: 'Storage role is only diagram evidence' },
  ], relationships: [{ source: 'job', target: 'store', type: 'writes', observed: true, evidence: ['job.ts:8'] }] });
  const first = renderArchitecture(architecture), second = renderArchitecture(architecture);
  expect(first).toBe(second);
  expect(first).toContain('|writes|');
  await expect(validateReportDiagram(first)).resolves.toBeUndefined();
});
