import { afterEach, expect, it, vi } from 'vitest';
import { newHandoff, updateProjectTask } from './project-progress';
import { sourceEvidence } from './source-memory';

afterEach(() => vi.restoreAllMocks());
function fixture() {
  const docs = { ...sourceEvidence('web_fetch', {}, { content: 'Runtime documentation' }), id: 'docs', at: 100 };
  const newer = { ...docs, id: 'new-docs' };
  const compatibility = { runtime: 'WebLLM', version: '1', modelFormat: 'mlc', modelId: 'requested-model', maxBytes: 1000, evidenceIds: [docs.id] };
  const handoff = newHandoff(undefined, 'Browser model');
  updateProjectTask(handoff, { requirements: [{ text: 'Works', status: 'not_run', verification: 'inspection', evidenceIds: [] }], compatibility, remaining: 'Build' }, [docs]);
  return { handoff, compatibility, evidence: [docs, newer] };
}

it('checks correction prerequisites before runtime mismatch and source evidence', () => {
  const { handoff, compatibility } = fixture();
  const before = structuredClone(handoff);
  expect(() => updateProjectTask(handoff, { requirements: [], remaining: '', compatibilityCorrection: 'Repair', compatibility: { ...compatibility, modelFormat: 'onnx', evidenceIds: ['missing'] } }, [])).toThrow(expect.objectContaining({ code: 'COMPATIBILITY_CORRECTION_REQUIRED' }));
  expect(handoff).toEqual(before);
});

it('rejects missing evidence before changed scope and preserves the handoff on both failures', () => {
  const { handoff, compatibility, evidence } = fixture();
  const before = structuredClone(handoff);
  const raw = { requirements: [], remaining: '', compatibilityCorrection: 'Repair', compatibility: { ...compatibility, version: '2', maxBytes: 2000, evidenceIds: ['missing'] } };
  expect(() => updateProjectTask(handoff, raw, evidence)).toThrow(expect.objectContaining({ code: 'COMPATIBILITY_EVIDENCE_REQUIRED', details: expect.objectContaining({ invalidEvidenceIds: ['missing'] }) }));
  expect(() => updateProjectTask(handoff, { ...raw, compatibility: { ...raw.compatibility, evidenceIds: ['new-docs'] } }, evidence)).toThrow(expect.objectContaining({ code: 'COMPATIBILITY_SCOPE_CHANGED' }));
  expect(handoff).toEqual(before);
});

it('requires new documentation for correction and invalidates saved verification on success', () => {
  vi.spyOn(Date, 'now').mockReturnValue(1000);
  const { handoff, compatibility, evidence } = fixture();
  handoff.requirements[0].status = 'passed';
  handoff.requirements[0].evidenceIds = ['docs'];
  const before = structuredClone(handoff);
  const raw = { requirements: [], remaining: 'Retest', compatibilityCorrection: 'Documented version repair', compatibility: { ...compatibility, version: '2' } };
  expect(() => updateProjectTask(handoff, raw, evidence)).toThrow(expect.objectContaining({ code: 'COMPATIBILITY_SCOPE_CHANGED' }));
  expect(handoff).toEqual(before);
  updateProjectTask(handoff, { ...raw, compatibility: { ...raw.compatibility, evidenceIds: ['new-docs'] } }, evidence);
  expect(handoff).toMatchObject({ generation: 1, lastMutationAt: 1000, compatibility: { ...compatibility, version: '2', evidenceIds: ['new-docs'] }, requirements: [{ id: before.requirements[0].id, text: 'Works', status: 'not_run', evidenceIds: [] }], remaining: 'Retest' });
});
