// The official registry searches a name substring, not natural-language intent.
// Expand common tasks to useful names without inventing install candidates.
const families: { trigger: RegExp; terms: string[] }[] = [
  { trigger: /\b(web\s*(dev\w*|design)|website|frontend|front-end|ui|frameworks?)\b/i, terms: ['context7', 'shadcn', 'react', 'nextjs', 'figma'] },
  { trigger: /\b(deploy\w*|hosting|publish\w*|web\s*dev\w*|website)\b/i, terms: ['vercel', 'cloudflare', 'netlify'] },
  { trigger: /\b(documentation|library|libraries|frameworks?)\b/i, terms: ['context7'] },
  { trigger: /\b(database|databases|backend)\b/i, terms: ['postgres', 'supabase', 'sqlite'] },
  { trigger: /\b(repository|repositories|source control|git)\b/i, terms: ['github', 'gitlab'] },
  { trigger: /\b(browser|browsing|automation|testing)\b/i, terms: ['playwright', 'puppeteer'] },
];
const stopwords = new Set('a an and are as at be build can could create development dev find for from help i in is it me my need of on or plugin plugins please relevant search server servers some that the this to tools use want with would'.split(' '));
export function pluginSearchQueries(query: string): string[] {
  const clean = query.trim().toLowerCase();
  const words = clean.replace(/https?:\/\//g, '').split(/[^a-z0-9@._/-]+/).filter(word => word.length > 1 && !stopwords.has(word));
  const related = families.filter(family => family.trigger.test(clean)).flatMap(family => family.terms);
  const domains = words.filter(word => word.includes('.')).map(word => word.replace(/^www\./, '').split(/[./]/)[0]);
  // Reserve space for task aliases instead of spending the budget on every word
  // in a long sentence. Exact names remain the first query.
  return [...new Set([clean, ...domains, ...words.slice(0, related.length ? 2 : 6), ...related])].filter(Boolean).slice(0, 12);
}

export function pluginSearchScore(server: { name: string; description?: string }, queries: string[]): number {
  const name = server.name.toLowerCase(), description = String(server.description ?? '').toLowerCase();
  const service = name.split('/').at(-1) ?? name;
  return queries.reduce((score, query) => score + (service === query ? 100 : service.includes(query) ? 20 : name.includes(query) ? 5 : 0) + (description.includes(query) ? 2 : 0), 0);
}
