import { z } from 'zod';
import type { PlanContent } from './types';

export const planSchema = z.object({
  objective: z.string().trim().min(1),
  assumptions: z.array(z.string()).default([]),
  steps: z.array(z.object({ title: z.string().trim().min(1), details: z.string(), checks: z.array(z.string()).default([]) })).min(1),
  blockers: z.array(z.string()).default([]),
});

export function parsePlan(text: string): PlanContent {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('The model did not return a JSON plan.');
  return planSchema.parse(JSON.parse(text.slice(start, end + 1)));
}

export function planMarkdown(plan: PlanContent): string {
  const lines = [`# ${plan.objective}`, '', '## Assumptions', ''];
  lines.push(...(plan.assumptions.length ? plan.assumptions.map(x => `- ${x}`) : ['- None recorded.']));
  lines.push('', '## Implementation', '');
  plan.steps.forEach((step, index) => {
    lines.push(`### ${index + 1}. ${step.title}`, '', step.details, '', '**Checks**', '', ...step.checks.map(x => `- ${x}`), '');
  });
  lines.push('## Open questions', '', ...(plan.blockers.length ? plan.blockers.map(x => `- ${x}`) : ['- None.']), '');
  return lines.join('\n');
}
