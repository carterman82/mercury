import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { evaluate, fixtureAdapter } from './evaluate.mjs';

const fixture = process.argv.includes('--fixture');
const adapterPath = fixture ? undefined : process.env.MERCURY_EVAL_ADAPTER;
if (!adapterPath && !fixture) throw new Error('Choose --fixture for harness verification, or set MERCURY_EVAL_ADAPTER to an explicit trusted local module.');
const adapter = adapterPath ? (await import(pathToFileURL(path.resolve(adapterPath)).href)).default : fixtureAdapter;
if (typeof adapter !== 'function') throw new Error('Evaluation adapter must default-export an async function.');
const result = await evaluate(adapter, { kind: adapterPath ? 'external-adapter' : 'deterministic-harness-fixture' });
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
process.exitCode = result.outcome === 'passed' ? 0 : 1;
