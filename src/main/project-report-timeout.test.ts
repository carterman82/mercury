import { expect, it, vi } from 'vitest';
import { LocalProviders } from './providers';
import { generateProjectReport } from './project-report';
import { architectureSchema, renderArchitecture } from './project-architecture';
const canonical = architectureSchema.parse({ components: [{ id: 'main', name: 'Main' }, { id: 'formula', name: 'Formula' }, { id: 'storage', name: 'Storage', kind: 'storage' }], relationships: [{ source: 'main', target: 'formula', type: 'uses', observed: true }, { source: 'formula', target: 'storage', type: 'writes', observed: true }] });

const profile = { provider: 'lmstudio' as const, connectionId: 'test', endpoint: 'http://127.0.0.1:1234', model: 'test', contextLimit: 32768 };
const settings = { connections: [{ id: 'test', provider: 'lmstudio' as const, url: profile.endpoint, label: 'Test' }], mainModel: null, plannerModel: null, subagentModel: null };
const diagrams = [{ path: 'system.mmd', content: 'flowchart LR\nMain --> Formula\nFormula --> Storage' }];

it('finishes a report after slow prefill and long reasoning within the generation safety limits', async () => {
  vi.useFakeTimers();
  try {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const request = JSON.parse(init.body);
      calls++;
      const stream = new ReadableStream({ start(controller) {
        const emit = (delta: object, finish_reason?: string) => controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ choices: [{ delta, finish_reason }] }) + '\n'));
        init.signal.addEventListener('abort', () => controller.error(init.signal.reason));
        // Ninety seconds of prefill, then useful reasoning each minute.
        for (let minute = 1; minute <= 8; minute++) setTimeout(() => emit({ reasoning_content: `Inspecting relationship ${minute}` }), minute * 60000 + 30000);
        setTimeout(() => {
          emit({ content: request.messages[0].content.includes('canonical architecture') ? JSON.stringify(canonical) : 'Main evaluates formulas and stores results.' }, 'stop');
          controller.close();
        }, 9 * 60000);
      } });
      return new Response(stream);
    }));
    const streaming = new LocalProviders(() => settings);
    const originalChat = streaming.chat.bind(streaming);
    streaming.chat = input => originalChat({ ...input, reportMode: false });
    const result = generateProjectReport(streaming, profile, diagrams, new AbortController().signal);
    for (let minute = 0; minute < 40; minute++) await vi.advanceTimersByTimeAsync(60000);
    expect((await result).diagram).toBe(renderArchitecture(canonical));
    expect(calls).toBe(2);
  } finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
}, 15000);

it.skipIf(process.env.MERCURY_SYNTHETIC_REPORT !== '1')('generates a report on the live LM Studio server using synthetic diagrams only', async () => {
  const liveProfile = { ...profile, endpoint: 'http://100.80.53.57:1234', model: 'qwen/qwen3.6-35b-a3b', contextLimit: 262144 };
  const provider = new LocalProviders(() => ({ ...settings, connections: [{ ...settings.connections[0], url: liveProfile.endpoint }] }));
  const result = await generateProjectReport(provider, liveProfile, diagrams, new AbortController().signal);
  const { default: mermaid } = await import('mermaid');
  await mermaid.parse(result.diagram);
  expect(result.sources).toBe(1);
  console.log('Live synthetic report generated and Mermaid parsed successfully.');
}, 1200000);
