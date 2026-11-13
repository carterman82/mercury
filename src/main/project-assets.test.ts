import { afterEach, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { projectAssetScript } from './project-assets';
import { ProjectExecutionAdapter } from './project-execution';
import { Store } from './store';
import { ProjectTools } from './project-tools';
import { ProjectWorktreeService } from './project-worktrees';
import { ChatApprovals } from './chat-approvals';
import type { ChatThread } from '../shared/types';
import { newHandoff } from './project-progress';

let server: Server | undefined;
const roots: string[] = [];
afterEach(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mercury-assets-'));
  roots.push(root);
  server = createServer((request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, { location: '/good' });
      response.end();
      return;
    }
    if (request.url === '/loop') {
      response.writeHead(302, { location: '/loop' });
      response.end();
      return;
    }
    if (request.url === '/missing') {
      response.writeHead(404);
      response.end('Entry not found');
      return;
    }
    if (request.url === '/fake') {
      response.end('Entry not found');
      return;
    }
    if (request.url === '/html') {
      response.end('<html>Internal server error</html>');
      return;
    }
    if (request.url === '/bad') {
      response.end('{not json');
      return;
    }
    if (request.url === '/gguf') {
      response.end(Buffer.from([71, 71, 85, 70, 3, 0, 0, 0]));
      return;
    }
    if (request.url === '/wasm') {
      response.end(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
      return;
    }
    if (request.url === '/slow') {
      response.write('{"model":"');
      const interval = setInterval(() => response.write(' '), 20);
      response.on('close', () => clearInterval(interval));
      return;
    }
    response.end(JSON.stringify({ model: 'fixture' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const adapter = new ProjectExecutionAdapter(path.join(root, 'unused'), path.join(root, 'scratch'));
  const destination = path.join(root, 'asset.bin');
  await fs.writeFile(destination, 'original');
  const download = async (
    route: string,
    format: 'json' | 'gguf' | 'wasm' | 'binary' = 'json',
    maxBytes = 1000,
    sha256?: string,
    signal = new AbortController().signal,
  ) => {
    const result = await adapter.execute(
      {
        command: 'asset fixture',
        executable: process.execPath,
        args: ['-'],
        stdin: projectAssetScript({ url: base + route, destination, format, maxBytes, sha256 }),
        cwd: root,
        workspaceRoot: root,
        mode: 3,
      },
      signal,
    );
    return { ...result, report: JSON.parse(result.output.trim()) };
  };
  return { root, destination, download };
}
it.each([
  ['/missing', 'ASSET_HTTP'],
  ['/fake', 'ASSET_FORMAT'],
  ['/html', 'ASSET_FORMAT'],
  ['/bad', 'ASSET_FORMAT'],
  ['/loop', 'ASSET_REDIRECT'],
])('rejects %s without replacing the old file', async (route, code) => {
  const { root, destination, download } = await fixture();
  const result = await download(route);
  expect(result.exitCode).not.toBe(0);
  expect(result.report.code).toBe(code);
  expect(await fs.readFile(destination, 'utf8')).toBe('original');
  expect((await fs.readdir(root)).some((file) => file.endsWith('.download'))).toBe(false);
});

it('preserves an existing destination when a streaming download is interrupted', async () => {
  const { root, destination, download } = await fixture();
  const controller = new AbortController();
  const pending = download('/slow', 'json', 1000, undefined, controller.signal);
  // Attach the rejection assertion before cancellation so no rejection is unhandled.
  const stopped = expect(pending).rejects.toThrow();
  await expect.poll(async () => (await fs.readdir(root)).some((file) => file.endsWith('.download'))).toBe(true);
  controller.abort();
  await stopped;
  expect(await fs.readFile(destination, 'utf8')).toBe('original');
});
it('validates formats, relative redirects, byte limits and hashes before atomic replacement', async () => {
  const { destination, download } = await fixture();
  expect((await download('/good', 'json', 2)).report.code).toBe('ASSET_TOO_LARGE');
  expect((await download('/good', 'json', 1000, '0'.repeat(64))).report.code).toBe('ASSET_HASH');
  expect(await fs.readFile(destination, 'utf8')).toBe('original');
  const json = await download('/redirect');
  expect(json.report).toMatchObject({ validated: true, status: 200, format: 'json' });
  expect(JSON.parse(await fs.readFile(destination, 'utf8'))).toEqual({ model: 'fixture' });
  expect((await download('/good', 'gguf')).report.code).toBe('ASSET_FORMAT');
  expect((await download('/gguf', 'gguf')).report.validated).toBe(true);
  expect((await download('/wasm', 'wasm')).report.validated).toBe(true);
});

async function toolFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mercury-asset-tool-'));
  roots.push(root);
  const store = new Store(path.join(root, 'state.sqlite'));
  const profile = { provider: 'ollama' as const, connectionId: 'fixture', model: 'fixture', contextLimit: 8192 };
  const projectId = randomUUID();
  store.saveProject({ id: projectId, path: root, name: 'Assets', permissionMode: 3, policyRevision: 1 });
  const chat: ChatThread = {
    id: randomUUID(),
    projectId,
    title: 'Assets',
    profile,
    messages: [],
    status: 'idle',
    updatedAt: Date.now(),
  };
  store.saveChat(chat);
  const execution = new ProjectExecutionAdapter(path.join(root, 'unused'), path.join(root, 'scratch'));
  vi.spyOn(execution, 'probe').mockResolvedValue({ available: true, version: '1.0.1' });
  const worktrees = new ProjectWorktreeService(path.join(root, 'workspaces'));
  const workspace = {
    id: 'workspace',
    chatId: chat.id,
    projectRoot: root,
    root,
    kind: 'direct' as const,
    serialized: true as const,
  };
  vi.spyOn(worktrees, 'prepare').mockResolvedValue(workspace);
  const approvals = new ChatApprovals(() => {});
  const projects = new ProjectTools(store, approvals, worktrees, undefined, { execution });
  await projects.prepare(chat, new AbortController().signal);
  return { root, store, chat, execution, workspace, projects, approvals };
}

it('keeps a file-owned worker download confined to its assigned file and host temporary file', async () => {
  const { root, store, chat, execution, workspace, projects, approvals } = await toolFixture();
  try {
    const worker = { ...chat, id: 'asset-worker' };
    await projects.prepareWorker(worker, chat, workspace, { ownedPaths: ['model.gguf'], readOnly: false });
    const execute = vi.spyOn(execution, 'execute').mockImplementation(async (request) => {
      expect(request.confined).toBe(true);
      expect(request.writableRoots).toHaveLength(2);
      expect(request.writableRoots![0]).toBe(path.join(root, 'model.gguf'));
      expect(request.writableRoots![1]).toMatch(/\.model\.gguf\.[\w-]+\.download$/);
      expect(request.writableRoots).not.toContain(root);
      return {
        exitCode: 0,
        output: JSON.stringify({ validated: true, sha256: 'a'.repeat(64) }),
        timedOut: false,
        confined: true,
      };
    });
    const pending = projects.execute(
      worker,
      'download_project_asset',
      { url: 'https://example.invalid/model.gguf', destination: 'model.gguf', format: 'gguf', maxBytes: 100 },
      new AbortController().signal,
    );
    await expect.poll(() => approvals.snapshot().length).toBe(1);
    expect(execute).not.toHaveBeenCalled();
    approvals.answer(approvals.snapshot()[0].id, true);
    await pending;
    expect(execute).toHaveBeenCalledOnce();
    await expect(
      projects.execute(
        worker,
        'download_project_asset',
        { url: 'https://example.invalid/other.gguf', destination: 'other.gguf', format: 'gguf', maxBytes: 100 },
        new AbortController().signal,
      ),
    ).rejects.toThrow('assigned paths');
    expect(execute).toHaveBeenCalledOnce();
  } finally {
    store.close();
  }
});

it('enforces the parent model contract for worker assets before executing downloads', async () => {
  const { store, chat, execution, workspace, projects } = await toolFixture();
  try {
    chat.projectHandoff = newHandoff(undefined, 'Use ONNX browser inference');
    chat.projectHandoff.compatibility = {
      runtime: 'Transformers.js',
      version: '2.17.2',
      modelFormat: 'onnx',
      modelId: 'fixture/model',
      maxBytes: 100,
      evidenceIds: ['runtime-docs'],
    };
    store.saveChat(chat);
    const worker = { ...chat, id: 'contract-worker', projectHandoff: undefined };
    await projects.prepareWorker(worker, chat, workspace, { ownedPaths: ['models'], readOnly: false });
    const execute = vi.spyOn(execution, 'execute');
    for (const args of [
      { destination: 'models/weights.gguf', format: 'gguf', maxBytes: 100 },
      { destination: 'models/weights.onnx', format: 'binary', maxBytes: 101 },
    ]) {
      await expect(
        projects.execute(
          worker,
          'download_project_asset',
          { url: 'https://example.invalid/model', ...args },
          new AbortController().signal,
        ),
      ).rejects.toThrow('accepted model contract');
    }
    await expect(
      projects.execute(
        worker,
        'download_project_asset',
        { url: 'https://example.invalid/model', destination: 'models/weights.gguf', format: 'binary', maxBytes: 100 },
        new AbortController().signal,
      ),
    ).rejects.toThrow('requires format:gguf');
    expect(execute).not.toHaveBeenCalled();
  } finally {
    store.close();
  }
});

it('invalidates the project revision when cancellation races a completed replacement', async () => {
  const { root, store, chat, execution, projects } = await toolFixture();
  try {
    const controller = new AbortController();
    vi.spyOn(execution, 'execute').mockImplementation(async (request) => {
      const config = JSON.parse(request.stdin!.match(/const config=(.*);/)![1]);
      await fs.writeFile(config.temporary, 'partial');
      await fs.writeFile(path.join(root, 'model.gguf'), 'replacement');
      controller.abort(new Error('Cancelled after replacement'));
      return {
        exitCode: 0,
        output: JSON.stringify({ validated: true, sha256: 'a'.repeat(64) }),
        timedOut: false,
        confined: false,
      };
    });
    const before = projects.generation(chat);
    await expect(
      projects.execute(
        chat,
        'download_project_asset',
        { url: 'https://example.invalid/model.gguf', destination: 'model.gguf', format: 'gguf', maxBytes: 100 },
        controller.signal,
      ),
    ).rejects.toThrow('Cancelled after replacement');
    expect(projects.generation(chat)).toBe(before + 1);
    expect((await fs.readdir(root)).some((file) => file.endsWith('.download'))).toBe(false);
  } finally {
    store.close();
  }
});
