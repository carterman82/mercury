import { createServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Explicit opt-in bridge through Mercury's actual ModelProvider implementation.
 * It uses only the configured local model, never saved accounts or paid fallback. */
export default async function mercuryLocalAdapter({ task, tools, signal }) {
  const provider = process.env.MERCURY_EVAL_PROVIDER ?? 'ollama';
  const model = process.env.MERCURY_EVAL_MODEL;
  if (!['ollama', 'lmstudio'].includes(provider) || !model) throw new Error('Set MERCURY_EVAL_MODEL and choose ollama or lmstudio.');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const server = await createServer({ root, configFile: false, optimizeDeps: { noDiscovery: true, entries: [] }, server: { middlewareMode: true, watch: null, ws: false }, appType: 'custom' });
  try {
    const { LocalProviders } = await server.ssrLoadModule('/src/main/providers.ts');
    const connection = { id: 'evaluation-only', provider, label: 'Evaluation local model', url: process.env.MERCURY_EVAL_ENDPOINT ?? (provider === 'ollama' ? 'http://127.0.0.1:11434' : 'http://127.0.0.1:1234') };
    const profile = { provider, connectionId: connection.id, model, contextLimit: 8192 };
    const runtime = new LocalProviders(() => ({ connections: [connection], mainModel: profile, plannerModel: null, subagentModel: null }));
    const definition = (name, properties, required) => ({ type: 'function', function: { name, description: `Use fixture ${name}`, parameters: { type: 'object', properties, required, additionalProperties: false } } });
    const offered = [definition('read', { name: { type: 'string', enum: ['clamp.mjs', 'keep.txt'] } }, ['name']), definition('write', { name: { type: 'string', enum: ['clamp.mjs', 'keep.txt'] }, content: { type: 'string' } }, ['name', 'content']), definition('test', {}, [])];
    const messages = [{ role: 'system', content: 'Complete the isolated coding task with the offered tools. Only fixture read/write/test tools are available. Run tests after editing. Do not claim a tool ran until its result is supplied.' }, { role: 'user', content: task }];
    let input = 0, output = 0, usageKnown = true;
    for (let step = 0; step < 12; step++) {
      signal.throwIfAborted();
      const result = await runtime.chat({ profile, messages, tools: offered, signal });
      if (result.usage?.input === undefined || result.usage?.output === undefined) usageKnown = false;
      else { input += result.usage.input; output += result.usage.output; }
      messages.push({ role: 'assistant', content: result.text || null, ...(result.tools.length ? { tool_calls: result.tools.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } : {}) });
      if (!result.tools.length) return usageKnown ? { usage: { input, output } } : {};
      for (const call of result.tools) {
        const args = call.arguments;
        let value;
        if (call.name === 'read') value = await tools.read(args.name);
        else if (call.name === 'write') value = await tools.write(args.name, args.content) ?? 'written';
        else if (call.name === 'test') value = { passed: await tools.test() };
        else throw new Error('Evaluation model requested an unoffered tool.');
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(value) });
      }
    }
    throw new Error('Evaluation exceeded 12 model turns.');
  } finally { await server.close(); }
}
