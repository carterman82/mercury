import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:net';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ProjectServers } from './project-servers';
import { ProjectExecutionAdapter, type ProjectExecutionRequest } from './project-execution';
import { WebPolicy } from './web-policy';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
async function freePort() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
}
const request: ProjectExecutionRequest = { command: 'dev server', cwd: process.cwd(), workspaceRoot: process.cwd(), mode: 2 };
async function fixture() {
  const port = await freePort(), web = new WebPolicy();
  const execute = vi.fn(async (_request, signal: AbortSignal, output) => {
    const server = createServer(socket => { socket.on('error', () => {}); socket.end('preview'); });
    await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
    output('stdout', 'ready'.repeat(12000));
    await new Promise<void>(resolve => {
      const stop = () => server.close(() => resolve());
      if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
    });
    throw new Error('Stopped');
  });
  const servers = new ProjectServers({ execute } as unknown as ProjectExecutionAdapter, web);
  cleanup.push(() => servers.shutdown());
  return { port, web, execute, servers };
}
it('keeps a server alive after startup, bounds logs, isolates chat access, and stops/revokes it', async () => {
  const { port, web, execute, servers } = await fixture();
  const turn = new AbortController();
  const server = await servers.start('owner', request, port, turn.signal);
  turn.abort();
  expect(servers.status('owner', server.id)).toMatchObject({ running: true });
  expect(servers.status('owner', server.id).output.length).toBe(40000);
  expect(execute.mock.calls[0][0]).toMatchObject({ loopback: true, timeoutMs: 3600000 });
  await expect(web.check(server.url, 'owner')).resolves.toBeInstanceOf(URL);
  expect(() => servers.status('other', server.id)).toThrow('not found');
  await servers.stop('owner', server.id);
  await expect(web.check(server.url, 'owner')).rejects.toThrow();
});
it('stops servers when project permissions change and refuses launches after shutdown', async () => {
  const { port, web, servers } = await fixture();
  const server = await servers.start('owner', request, port, new AbortController().signal);
  servers.stopChat('owner');
  await expect(web.check(server.url, 'owner')).rejects.toThrow();
  await expect.poll(() => servers.status('owner', server.id).running).toBe(false);
  await servers.shutdown();
  await expect(servers.start('owner', request, port, new AbortController().signal)).rejects.toThrow('shut down');
});
it('reports failed startup without granting browser access', async () => {
  const web = new WebPolicy();
  const servers = new ProjectServers({ execute: async () => { throw new Error('launch failed'); } } as unknown as ProjectExecutionAdapter, web);
  cleanup.push(() => servers.shutdown());
  const port = await freePort();
  await expect(servers.start('owner', request, port, new AbortController().signal)).rejects.toThrow('launch failed');
  await expect(web.check(`http://127.0.0.1:${port}`, 'owner')).rejects.toThrow();
});
it('returns bounded startup stderr with an early process exit instead of hiding its cause', async () => {
  const web = new WebPolicy();
  const servers = new ProjectServers({ execute: async () => ({ exitCode: 1, output: 'x'.repeat(8000) + '\nUnknown --listen endpoint scheme', timedOut: false }) } as unknown as ProjectExecutionAdapter, web);
  cleanup.push(() => servers.shutdown());
  const port = await freePort();
  try {
    await servers.start('owner', request, port, new AbortController().signal);
    throw new Error('Expected launch failure');
  } catch (error: any) {
    expect(error.code).toBe('SERVER_START_FAILED');
    expect(error.details.output).toHaveLength(6000);
    expect(error.details.output).toContain('Unknown --listen endpoint scheme');
    expect(error.details.url).toBe(`http://127.0.0.1:${port}`);
  }
  expect(servers.status('owner')).toEqual({ servers: [] });
  await expect(web.check(`http://127.0.0.1:${port}`, 'owner')).rejects.toThrow();
});

it('reuses matching owned previews concurrently, lists ownership and preserves expiration', async () => {
  const { port, servers, execute } = await fixture(); const signal = new AbortController().signal;
  const [first, second] = await Promise.all([servers.start('owner', request, port, signal), servers.start('owner', request, port, signal)]);
  expect(second).toMatchObject({ id: first.id, url: first.url, reused: true, expiresAt: first.expiresAt });
  expect(execute).toHaveBeenCalledOnce();
  expect(servers.status('owner')).toMatchObject({ servers: [{ id: first.id, running: true }] });
  expect(servers.status('other')).toEqual({ servers: [] });
  await expect(servers.start('other', request, port, signal)).rejects.toThrow('another managed launch');
  await expect(servers.start('owner', { ...request, network: 'allow' }, port, signal)).rejects.toThrow('another managed launch');
  await servers.stop('owner', first.id);
  const restarted = await servers.start('owner', request, port, signal);
  expect(restarted.id).not.toBe(first.id); expect(execute).toHaveBeenCalledTimes(2);
});
it.runIf(process.env.MERCURY_LIVE_MXC === '1')('serves a real website from a level 2 confined process', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mercury-preview-live-'));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const port = await freePort();
  await fs.writeFile(path.join(root, 'server.cjs'), `require('http').createServer((q,s)=>s.end('mercury-local-preview')).listen(${port},'127.0.0.1')`);
  const adapter = new ProjectExecutionAdapter(path.resolve('.build-resources/mxc-runtime'), path.join(root, '.scratch'));
  cleanup.push(() => adapter.shutdown());
  const servers = new ProjectServers(adapter, new WebPolicy());
  cleanup.push(() => servers.shutdown());
  const server = await servers.start('owner', { ...request, cwd: root, workspaceRoot: root, command: `"${process.execPath}" server.cjs`, win32k: true }, port, new AbortController().signal);
  expect(await (await fetch(server.url)).text()).toBe('mercury-local-preview');
  await servers.stop('owner', server.id);
}, 45000);
