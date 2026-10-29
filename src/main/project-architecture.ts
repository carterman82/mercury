import { z } from 'zod';

/** A deliberately small, evidence-carrying architecture IR. It is the boundary
 * between model interpretation and deterministic Mermaid rendering. */
export const architectureSchema = z.object({
  components: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    responsibility: z.string().optional(),
    kind: z.enum(['application', 'external', 'storage']).default('application'),
    group: z.string().optional(),
    evidence: z.array(z.string()).default([]),
    uncertainty: z.string().optional(),
  })).min(1).max(40),
  relationships: z.array(z.object({
    source: z.string().min(1), target: z.string().min(1),
    type: z.enum(['calls', 'reads', 'writes', 'publishes_to', 'uses', 'imports', 'configuration']).default('uses'),
    artifact: z.string().optional(), observed: z.boolean().default(false),
    evidence: z.array(z.string()).default([]), uncertainty: z.string().optional(),
  })).max(120).default([]),
  purpose: z.string().optional(), entryPoints: z.array(z.string()).default([]),
});
export type Architecture = z.infer<typeof architectureSchema>;

const clean = (value: string) => value.replace(/[<>"`[\]{}|\\\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
const key = (value: string) => clean(value).toLowerCase();
const kindFor = (name: string): 'application' | 'external' | 'storage' => /\b(database|storage|store|cache|bucket|filesystem|file)\b/i.test(name) ? 'storage' : /\b(api|service|github|slack|wordpress|openai|aws|client)\b/i.test(name) ? 'external' : 'application';

/** Reconciles only explicit ids or responsibility+kind matches. Similar display
 * names alone are intentionally insufficient evidence to merge components. */
export function reconcileArchitecture(input: Architecture): Architecture {
  const aliases = new Map<string, string>();
  const components: Architecture['components'] = [];
  const seen = new Map<string, number>();
  for (const candidate of input.components) {
    const signature = candidate.responsibility ? `${candidate.kind}:${key(candidate.responsibility)}` : `id:${candidate.id}`;
    const existing = seen.get(signature);
    if (existing === undefined) { aliases.set(candidate.id, candidate.id); seen.set(signature, components.length); components.push({ ...candidate, name: clean(candidate.name), responsibility: candidate.responsibility && clean(candidate.responsibility), evidence: [...new Set(candidate.evidence)].sort() }); }
    else { const target = components[existing]; aliases.set(candidate.id, target.id); target.evidence = [...new Set([...target.evidence, ...candidate.evidence])].sort(); }
  }
  const relation = new Map<string, Architecture['relationships'][number]>();
  for (const edge of input.relationships) {
    const source = aliases.get(edge.source) ?? edge.source, target = aliases.get(edge.target) ?? edge.target;
    if (source === target || !components.some(node => node.id === source) || !components.some(node => node.id === target)) continue;
    const id = `${source}\u0000${target}\u0000${edge.type}\u0000${edge.artifact ?? ''}`;
    const prior = relation.get(id);
    if (prior) { prior.observed ||= edge.observed; prior.evidence = [...new Set([...prior.evidence, ...edge.evidence])].sort(); prior.uncertainty ??= edge.uncertainty; }
    else relation.set(id, { ...edge, source, target, artifact: edge.artifact && clean(edge.artifact), evidence: [...new Set(edge.evidence)].sort() });
  }
  return { ...input, components: components.sort((a, b) => a.id.localeCompare(b.id)), relationships: [...relation.values()].sort((a, b) => `${a.source}:${a.target}:${a.type}`.localeCompare(`${b.source}:${b.target}:${b.type}`)), entryPoints: [...new Set(input.entryPoints)].sort() };
}

export function renderArchitecture(architecture: Architecture): string {
  const graph = reconcileArchitecture(architecture);
  const ids = new Map(graph.components.map((component, index) => [component.id, `c${index}`]));
  const lines = ['flowchart LR'];
  const ungrouped = graph.components.filter(component => !component.group);
  for (const component of ungrouped) lines.push(`  ${ids.get(component.id)}["${clean(component.name)}"]`);
  const groups = new Map<string, typeof graph.components>();
  for (const component of graph.components.filter(component => component.group)) {
    const members = groups.get(component.group!) ?? [];
    members.push(component); groups.set(component.group!, members);
  }
  // A boundary with one member adds noise, so retain it only when it actually
  // communicates an architectural grouping.
  for (const [group, members] of [...groups.entries()].filter(([, value]) => value.length > 1).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`  subgraph ${clean(group).replace(/[^A-Za-z0-9_]/g, '_') || 'boundary'}["${clean(group)}"]`);
    for (const component of members) lines.push(`    ${ids.get(component.id)}["${clean(component.name)}"]`);
    lines.push('  end');
  }
  for (const [, members] of [...groups.entries()].filter(([, value]) => value.length === 1)) for (const component of members) lines.push(`  ${ids.get(component.id)}["${clean(component.name)}"]`);
  const label: Record<Architecture['relationships'][number]['type'], string> = { calls: 'calls', reads: 'reads', writes: 'writes', publishes_to: 'publishes to', uses: 'uses', imports: 'imports', configuration: 'configures' };
  for (const edge of graph.relationships) {
    const suffix = edge.artifact ? ` ${clean(edge.artifact)}` : '';
    lines.push(`  ${ids.get(edge.source)} ${edge.observed ? '-->' : '-.->'}|${label[edge.type]}${suffix}| ${ids.get(edge.target)}`);
  }
  return lines.join('\n');
}

/** Conservative local fallback: records observed Mermaid connections without
 * inventing responsibilities, artifacts, or execution order. */
export function architectureFromMermaid(sources: { path: string; content: string }[]): Architecture {
  const labels = new Map<string, string>();
  const components = new Map<string, Architecture['components'][number]>();
  const relationships: Architecture['relationships'] = [];
  const add = (raw: string, path: string) => {
    const id = raw.replace(/[^A-Za-z0-9_-]/g, '_') || 'component';
    if (!components.has(raw)) components.set(raw, { id, name: labels.get(raw) ?? raw, kind: kindFor(labels.get(raw) ?? raw), evidence: [`${path}: ${raw}`], uncertainty: 'Responsibility was not available in the source diagram.' });
    return id;
  };
  for (const source of sources) {
    for (const declaration of source.content.matchAll(/\b([A-Za-z][\w-]*)\s*\["?([^\]"\n]+)"?\]/g)) labels.set(declaration[1], declaration[2]);
    const edges = source.content.replace(/\b([A-Za-z][\w-]*)\s*\["?([^\]"\n]+)"?\]/g, '$1');
    for (const match of edges.matchAll(/\b([A-Za-z][\w-]*)\s*(?:-->|-.->|==>)\s*(?:\|([^|]+)\|\s*)?([A-Za-z][\w-]*)/g)) {
      const from = add(match[1], source.path), to = add(match[3], source.path);
      relationships.push({ source: from, target: to, type: 'calls', observed: true, evidence: [`${source.path}: ${match[0]}`], uncertainty: match[2] ? undefined : 'Relationship type came from the source diagram, not source code.' });
    }
  }
  return { components: [...components.values()], relationships, entryPoints: [] };
}
