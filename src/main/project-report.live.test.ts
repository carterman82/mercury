import { it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { LocalProviders } from './providers';
import { ProjectMaps } from './project-maps';
import { generateProjectReport } from './project-report';
import { resolveCandidates } from './delegation';
import { createHash } from 'node:crypto';

it.skipIf(process.env.MERCURY_LIVE_REPORTS !== '1')('generates reports using every saved project and its selected live model', async () => {
  const db = new DatabaseSync(path.join(process.env.APPDATA!, 'Local Plan Agent', 'state.sqlite'), { readOnly: true });
  const projects = db.prepare('SELECT data FROM projects').all().map((row: any) => JSON.parse(row.data)).filter((project: any) => !process.env.MERCURY_REPORT_PROJECT || project.name === process.env.MERCURY_REPORT_PROJECT);
  expect(projects.length).toBeGreaterThan(0);
  const chats = db.prepare('SELECT data FROM chats ORDER BY updated_at DESC').all().map((row: any) => JSON.parse(row.data));
  const settings = JSON.parse((db.prepare("SELECT data FROM settings WHERE key = 'app'").get() as any)?.data ?? '{}');
  db.close();
  const provider = new LocalProviders(() => settings);
  const originalChat = provider.chat.bind(provider);
  let requests = 0;
  provider.chat = async input => {
    const request = ++requests;
    const key = createHash('sha256').update(JSON.stringify({ profile: input.profile, messages: input.messages, maxOutputTokens: input.maxOutputTokens, reportMode: input.reportMode })).digest('hex');
    const cacheFile = path.join('test-results/live-reports/cache', key + '.json');
    try { const cached = JSON.parse(await fs.readFile(cacheFile, 'utf8')); console.log('Reusing analysis', request); return cached; } catch { /* New request. */ }
    const started = Date.now();
    console.log('Request', request, input.profile.model, 'started');
    try {
      const result = await originalChat(input);
      await fs.mkdir(path.dirname(cacheFile), { recursive: true });
      await fs.writeFile(cacheFile, JSON.stringify(result));
      await fs.writeFile('test-results/live-reports/last-model-output.md', result.text);
      return result;
    }
    finally { console.log('Request', request, 'ended after', Math.round((Date.now() - started) / 1000), 'seconds'); }
  };
  const maps = new ProjectMaps();
  const results = [];
  await fs.mkdir('test-results/live-reports', { recursive: true });
  for (const project of projects) {
    const chat = chats.find((value: any) => value.projectId === project.id);
    console.log('Testing report:', project.name, chat?.profile.model);
    try {
      const diagrams = [];
      for (const relative of await maps.existingDiagrams(project.path)) diagrams.push(await maps.readDiagram(project.path, relative, true));
      console.log(project.name, 'diagrams:', diagrams.length);
      const report = await generateProjectReport(provider, chat.profile, diagrams, new AbortController().signal, { candidates: resolveCandidates(settings, 'subagent', chat.profile), concurrency: settings.projectWorkerConcurrency ?? 3 });
      const { default: mermaid } = await import('mermaid');
      await mermaid.parse(report.diagram);
      await fs.writeFile(path.join('test-results/live-reports', project.name + '.md'), report.content);
      await fs.writeFile(path.join('test-results/live-reports', project.name + '.mmd'), report.diagram);
      results.push({ project: project.name, sources: report.sources, passed: true });
    } catch (error) {
      results.push({ project: project.name, passed: false, error: String(error) });
    }
    console.log(JSON.stringify(results.at(-1)));
    await fs.writeFile('test-results/live-reports/results.json', JSON.stringify(results, null, 2));
  }
  expect(results.filter(value => !value.passed)).toEqual([]);
}, 3600000);
