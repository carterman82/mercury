import { expect, it } from 'vitest';
import { commandApprovalReason, projectCommandApprovalReason } from './project-command-risk';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import { assessProjectAction } from './project-policy';
import path from 'node:path';

it.each(['npm test', 'npm run build', 'python -m pytest', 'node --test', 'git status'])(
  'allows routine confined development: %s',
  (command) => {
    expect(commandApprovalReason({ command })).toBeUndefined();
  },
);
it.each([
  'setup.exe',
  'npm install',
  'npm i',
  'npm ci',
  'pnpm i',
  'yarn',
  'uv sync',
  'poetry install',
  'python -m venv .venv',
  'python -m pip install pytest',
  'winget install Python.Python',
  'npm test && pip install foo',
  'npx some-tool',
  'powershell Start-Process app.exe',
])('reviews executable launches and installations in every mode: %s', (command) => {
  const approvalReason = commandApprovalReason({ command });
  expect(approvalReason).toBeTruthy();
  for (const mode of [1, 2, 3] as const)
    expect(
      assessProjectAction(
        { mode, revision: 1, projectId: 'p', chatId: 'c', workspaceRoot: path.resolve('.') },
        { kind: 'command', command, cwd: path.resolve('.'), approvalReason },
        { isolationAvailable: true },
      ).status,
    ).toBe('approval');
});
it('inspects package lifecycle hooks and local launch scripts before granting execution', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mercury-risk-'));
  try {
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ scripts: { test: 'node smoke.cjs', pretest: 'npm ci' } }),
    );
    await fs.writeFile(path.join(root, 'smoke.cjs'), 'console.log("smoke passed")');
    expect(await projectCommandApprovalReason(root, root, { command: 'npm test' })).toContain('approval');
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node smoke.cjs' } }));
    expect(await projectCommandApprovalReason(root, root, { command: 'npm test' })).toBeUndefined();
    await fs.writeFile(path.join(root, 'smoke.cjs'), 'require("child_process").execSync("pip install pytest")');
    expect(await projectCommandApprovalReason(root, root, { command: 'npm test' })).toContain('approval');
    expect(await projectCommandApprovalReason(root, root, { command: 'node missing.js' })).toContain(
      'could not be inspected',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
it('classifies structured commands, stdin scripts and network access', () => {
  expect(commandApprovalReason({ command: 'process', executable: 'python.exe', args: ['-m', 'pytest'] })).toBeTruthy();
  expect(
    commandApprovalReason({
      command: 'process',
      executable: 'node',
      stdin: "require('child_process').execSync('pip install foo')",
    }),
  ).toBeTruthy();
  expect(commandApprovalReason({ command: 'node task.js', network: 'allow' })).toBeTruthy();
});
