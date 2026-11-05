import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { evaluate } from './evaluate.mjs';

export default class MercuryTaskProvider {
  id() { return 'mercury-isolated-coding-task'; }
  async callApi() {
    if (!process.env.MERCURY_EVAL_ADAPTER) return { error: 'Set MERCURY_EVAL_ADAPTER to a trusted module bridging the Mercury runtime. No fixture is substituted for real inference.' };
    const adapter = (await import(pathToFileURL(path.resolve(process.env.MERCURY_EVAL_ADAPTER)).href)).default;
    const result = await evaluate(adapter);
    return { output: JSON.stringify(result), ...(result.metrics.tokens ? { tokenUsage: { prompt: result.metrics.tokens.input, completion: result.metrics.tokens.output, total: result.metrics.tokens.input + result.metrics.tokens.output } } : {}) };
  }
}
