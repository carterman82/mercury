import { randomUUID, createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ProjectBatches } from './project-batches';

const roots: string[] = [];
const chatId = randomUUID();
async function directory() { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mercury-batches-')); roots.push(root); return root; }
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
const item = (id: string) => ({ id, status: 'ready', research: 'Found the original game release.', proposal: 'Replace the title and description.', sources: ['https://example.com/game'] });
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

it('persists per-item research across restarts and pages summaries without replaying all source text', async () => {
  const root = await directory(); const batches = new ProjectBatches(root);
  expect(await batches.read({ batchId: 'game-seo' })).toMatchObject({ revision: 0, items: [] });
  await batches.update(chatId, { batchId: 'game-seo', expectedRevision: 0, items: [item('Minecraft'), item('Mario')] });
  const restarted = new ProjectBatches(root);
  expect(await restarted.list()).toMatchObject({ batches: [{ batchId: 'game-seo', revision: 1, itemCount: 2 }] });
  expect(await restarted.read({ batchId: 'game-seo', limit: 1 })).toMatchObject({ revision: 1, items: [{ id: 'Minecraft', status: 'ready' }], nextOffset: 1 });
  const summary = await restarted.read({ batchId: 'game-seo' });
  expect(JSON.stringify(summary)).not.toContain('Found the original');
  expect(await restarted.read({ batchId: 'game-seo', itemId: 'Minecraft' })).toMatchObject({ item: { ...item('Minecraft'), chatId } });
  await restarted.update(chatId, { batchId: 'game-seo', expectedRevision: 1, items: [{ ...item('Mario'), status: 'blocked', note: 'Needs an authoritative source.' }] });
  expect(await restarted.read({ batchId: 'game-seo', status: 'ready' })).toMatchObject({ totalItems: 1, items: [{ id: 'Minecraft' }] });
});

it('rejects stale concurrent saves across service instances and preserves unrelated items', async () => {
  const root = await directory(); const first = new ProjectBatches(root); const second = new ProjectBatches(root);
  const results = await Promise.allSettled([
    first.update(chatId, { batchId: 'seo', expectedRevision: 0, items: [item('one')] }),
    second.update(chatId, { batchId: 'seo', expectedRevision: 0, items: [item('two')] }),
  ]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
  expect(await first.read({ batchId: 'seo' })).toMatchObject({ revision: 1, totalItems: 1 });
});

it('resumes a 300-item job by status with bounded reads and saves', async () => {
  const root = await directory(); const batches = new ProjectBatches(root);
  for (let batch = 0; batch < 30; batch++) {
    await batches.update(chatId, { batchId: 'all-games', expectedRevision: batch, items: Array.from({ length: 10 }, (_, index) => ({ ...item(`game-${batch * 10 + index}`), status: batch < 2 ? 'ready' : 'pending' })) });
  }
  const resumed = new ProjectBatches(root);
  const firstPage = await resumed.read({ batchId: 'all-games', status: 'pending', limit: 10 });
  expect(firstPage).toMatchObject({ revision: 30, totalItems: 280, nextOffset: 10 });
  expect(firstPage.items?.[0]).toMatchObject({ id: 'game-20' });
  expect(firstPage.items).toHaveLength(10);
  await expect(resumed.update(chatId, { batchId: 'all-games', expectedRevision: 30, items: Array.from({ length: 11 }, (_, index) => item(`too-many-${index}`)) })).rejects.toThrow();
  expect(await resumed.read({ batchId: 'all-games' })).toMatchObject({ revision: 30, totalItems: 300 });
});

it('records integration separately from research only after a ready item and matching current file hashes', async () => {
  const root = await directory(); const batches = new ProjectBatches(root, async () => true);
  await fs.writeFile(path.join(root, 'games.js'), 'changed game');
  const integrated = { ...item('one'), status: 'integrated', integratedFiles: [{ path: 'games.js', hash: sha('changed game') }] };
  await expect(batches.update(chatId, { batchId: 'seo', expectedRevision: 0, items: [integrated] })).rejects.toThrow('ready');
  await batches.update(chatId, { batchId: 'seo', expectedRevision: 0, items: [item('one')] });
  await expect(batches.update(chatId, { batchId: 'seo', expectedRevision: 1, items: [{ ...integrated, integratedFiles: [{ path: 'games.js', hash: sha('wrong') }] }] })).rejects.toThrow('hash');
  await batches.update(chatId, { batchId: 'seo', expectedRevision: 1, items: [integrated] });
  expect(await batches.read({ batchId: 'seo', itemId: 'one' })).toMatchObject({ revision: 2, item: { status: 'integrated', integratedFiles: integrated.integratedFiles }, notice: expect.stringContaining('not test verification') });
  await expect(batches.update(chatId, { batchId: 'seo', expectedRevision: 2, items: [{ ...item('two'), status: 'verified' }] })).rejects.toThrow();
});

it('rejects uppercase batch aliases instead of creating conflicting Windows lock identities', async () => {
  const root = await directory(); const batches = new ProjectBatches(root);
  await batches.update(chatId, { batchId: 'seo', expectedRevision: 0, items: [item('one')] });
  await expect(batches.update(chatId, { batchId: 'SEO', expectedRevision: 0, items: [item('two')] })).rejects.toThrow('lowercase');
  await expect(batches.read({ batchId: 'SEO' })).rejects.toThrow('lowercase');
  expect(await batches.list()).toMatchObject({ batches: [{ batchId: 'seo', revision: 1, itemCount: 1 }] });
});

it('retains research on status-only changes and clears receipts when returning to research', async () => {
  const root = await directory(); const batches = new ProjectBatches(root, async () => true);
  await fs.writeFile(path.join(root, 'games.js'), 'changed game');
  const ready = { ...item('one'), note: 'Reviewed sources.' };
  await batches.update(chatId, { batchId: 'seo', expectedRevision: 0, items: [ready] });
  await batches.update(chatId, { batchId: 'seo', expectedRevision: 1, items: [{ id: 'one', status: 'integrated', integratedFiles: [{ path: 'games.js', hash: sha('changed game') }] }] });
  expect(await batches.read({ batchId: 'seo', itemId: 'one' })).toMatchObject({ item: { ...ready, status: 'integrated' } });
  await batches.update(chatId, { batchId: 'seo', expectedRevision: 2, items: [{ id: 'one', status: 'researching' }] });
  expect(await batches.read({ batchId: 'seo', itemId: 'one' })).toMatchObject({ item: { ...ready, status: 'researching', integratedFiles: [] } });
});

it('does not accept hashes from unchanged reads as integration evidence and fails closed without host validation', async () => {
  const root = await directory();
  await fs.writeFile(path.join(root, 'games.js'), 'unchanged game');
  const rejected = new ProjectBatches(root, async () => false);
  await rejected.update(chatId, { batchId: 'seo', expectedRevision: 0, items: [item('one')] });
  const update = { batchId: 'seo', expectedRevision: 1, items: [{ id: 'one', status: 'integrated', integratedFiles: [{ path: 'games.js', hash: sha('unchanged game') }] }] };
  await expect(rejected.update(chatId, update)).rejects.toThrow('successful source mutation');
  await expect(new ProjectBatches(root).update(chatId, update)).rejects.toThrow('successful source mutation');
  expect(await rejected.read({ batchId: 'seo' })).toMatchObject({ revision: 1, items: [{ status: 'ready' }] });
});

it('requires the final shared file hash for every item integrated in a single save', async () => {
  const root = await directory();
  const first = sha('first patch'); const final = sha('first patch plus second patch');
  const batches = new ProjectBatches(root, async receipt => [first, final].includes(receipt.hash));
  await batches.update(chatId, { batchId: 'seo', expectedRevision: 0, items: [item('one'), item('two')] });
  await fs.writeFile(path.join(root, 'games.js'), 'first patch plus second patch');
  const receiptItem = (id: string, hash: string) => ({ id, status: 'integrated', integratedFiles: [{ path: 'games.js', hash }] });
  await expect(batches.update(chatId, { batchId: 'seo', expectedRevision: 1, items: [receiptItem('one', first), receiptItem('two', final)] })).rejects.toThrow('hash');
  await batches.update(chatId, { batchId: 'seo', expectedRevision: 1, items: [receiptItem('one', final), receiptItem('two', final)] });
  expect(await batches.read({ batchId: 'seo' })).toMatchObject({ revision: 2, items: [{ id: 'one', status: 'integrated' }, { id: 'two', status: 'integrated' }] });
});

it('confines storage and receipts, rejects corrupt state and bounds item payloads', async () => {
  const root = await directory(); const outside = await directory(); const batches = new ProjectBatches(root);
  await expect(batches.read({ batchId: '../escape' })).rejects.toThrow();
  await expect(batches.update(chatId, { batchId: 'seo', expectedRevision: 0, items: [{ ...item('one'), research: 'x'.repeat(12_001) }] })).rejects.toThrow();
  await batches.update(chatId, { batchId: 'seo', expectedRevision: 0, items: [item('one')] });
  await expect(batches.update(chatId, { batchId: 'seo', expectedRevision: 1, items: [{ ...item('one'), status: 'integrated', integratedFiles: [{ path: '../outside', hash: sha('x') }] }] })).rejects.toThrow();
  await fs.writeFile(path.join(root, '.mercury', 'batches', 'seo.json'), '{broken');
  await expect(batches.update(chatId, { batchId: 'seo', expectedRevision: 1, items: [item('one')] })).rejects.toThrow();
  const linked = await directory();
  await fs.symlink(outside, path.join(linked, '.mercury'), process.platform === 'win32' ? 'junction' : 'dir');
  await expect(new ProjectBatches(linked).update(chatId, { batchId: 'seo', expectedRevision: 0, items: [item('one')] })).rejects.toThrow();
  expect(await fs.readdir(outside)).toEqual([]);
});
