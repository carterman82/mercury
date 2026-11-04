import { z } from 'zod';
import type { ProjectHandoff, SourceEvidence } from '../shared/types';
import { ToolFailure, toolFailed } from './tool-outcome';

const compatibilitySourceTools = new Set(['read_project_file', 'read_file', 'web_fetch', 'browser_read', 'browser_open']);

export const compatibilitySchema = z
      .object({
        runtime: z.string().min(1).max(200),
        version: z.string().min(1).max(100),
        modelFormat: z.enum(['gguf', 'onnx', 'mlc']),
        modelId: z.string().min(1).max(300),
        maxBytes: z.number().int().min(1).max(1073741824),
        evidenceIds: z.array(z.string().max(200)).min(1).max(10),
      })
      .strict()
      .optional();

export function validateCompatibility(handoff: ProjectHandoff, value: { compatibility?: ProjectHandoff['compatibility']; compatibilityCorrection?: string }, evidence: SourceEvidence[]): boolean {
  let versionCorrected = false;
  if (value.compatibilityCorrection && (!handoff.compatibility || !value.compatibility || handoff.compatibility.version === value.compatibility.version))
    throw new ToolFailure('COMPATIBILITY_CORRECTION_REQUIRED', 'A correction reason requires an existing compatibility record and a changed runtime version supported by new source evidence.');
  if (value.compatibility) {
    if ((value.compatibility.modelFormat !== 'onnx' && /transformers/i.test(value.compatibility.runtime)) ||
        (value.compatibility.modelFormat !== 'mlc' && /web[-\s]?llm/i.test(value.compatibility.runtime)))
      throw new ToolFailure(
        'MODEL_RUNTIME_MISMATCH',
        'Transformers.js uses ONNX; WebLLM uses MLC model layouts. A GGUF asset needs a verified GGUF-capable browser runtime. Verify the pinned runtime documentation before implementation.',
      );
    const invalidEvidenceIds = value.compatibility.evidenceIds.filter(
        (id) =>
          !evidence.some(
            (item) =>
              item.id === id &&
              compatibilitySourceTools.has(item.tool) &&
              !toolFailed(safeResult(item.result)),
          ),
      );
    if (invalidEvidenceIds.length)
      throw new ToolFailure(
        'COMPATIBILITY_EVIDENCE_REQUIRED',
        'Compatibility needs successful source or documentation observations. Use the exact evidenceId returned by a successful read or fetch; recall_context can recover saved observations.',
        { invalidEvidenceIds, availableSources: evidence.filter(item => compatibilitySourceTools.has(item.tool) && !toolFailed(safeResult(item.result))).slice(-12).map(item => ({ evidenceId: item.id, tool: item.tool, label: item.label, input: item.input.slice(0, 500) })) },
      );
    versionCorrected = Boolean(handoff.compatibility && value.compatibilityCorrection &&
      handoff.compatibility.version !== value.compatibility.version &&
      value.compatibility.evidenceIds.some(id => !handoff.compatibility!.evidenceIds.includes(id)));
    if (
      handoff.compatibility &&
      ['runtime', 'version', 'modelFormat', 'modelId', 'maxBytes'].some(
        (key) => (key !== 'version' || !versionCorrected) && (handoff.compatibility as any)[key] !== (value.compatibility as any)[key],
      )
    )
      throw new ToolFailure(
        'COMPATIBILITY_SCOPE_CHANGED',
        'Do not silently replace the recorded runtime/model or relax its byte limit. A runtime version repair needs compatibilityCorrection with a reason and new successful source evidence; preserve the runtime, model, layout and byte limit.',
      );
  }
  return versionCorrected;
}

function safeResult(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { error: 'Unstructured observation' };
  }
}

