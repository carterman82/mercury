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
])('keeps legacy command classifications from overriding full access: %s', (command) => {
  const approvalReason = commandApprovalReason({ command });
  expect(approvalReason).toBeTruthy();
  for (const mode of [1, 2, 3] as const)
    expect(
      assessProjectAction(
        { mode, revision: 1, projectId: 'p', chatId: 'c', workspaceRoot: path.resolve('.') },
        { kind: 'command', command, cwd: path.resolve('.'), approvalReason },
        { isolationAvailable: true },
      ).status,
    ).toBe(mode === 3 ? 'allow' : 'approval');
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

it('does not treat a directory listing as execution of the listed JavaScript file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mercury-list-catalog-'));
  try {
    await fs.writeFile(path.join(root, 'gamesinfo.js'), 'const games = { description: "Install upgrades with npm" };');
    expect(await projectCommandApprovalReason(root, root, { command: 'dir /s /b gamesinfo.js' })).toBeUndefined();
    expect(await projectCommandApprovalReason(root, root, { command: 'node gamesinfo.js' })).toContain('approval');
    expect(await projectCommandApprovalReason(root, root, { command: 'dir /s /b gamesinfo.js && node gamesinfo.js' })).toContain('approval');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
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

it('allows project executables while retaining level-one, installation and network review', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mercury-local-exe-'));
  try {
    const executable = path.join(root, 'test tools', 'python.exe');
    await fs.mkdir(path.dirname(executable));
    await fs.writeFile(executable, 'fixture executable');
    for (const input of [
      { command: `"${executable}" -m pytest` },
      { command: 'structured process', executable, args: ['-m', 'pytest'] },
      { command: '"test tools/python.exe" -m pytest' },
    ]) {
      const approvalReason = await projectCommandApprovalReason(root, root, input);
      expect(approvalReason).toBeUndefined();
      for (const mode of [1, 2, 3] as const) {
        expect(
          assessProjectAction(
            { mode, revision: 1, projectId: 'p', chatId: 'c', workspaceRoot: root },
            { kind: 'command', command: input.command, cwd: root, approvalReason },
            { isolationAvailable: true },
          ).status,
        ).toBe(mode === 1 ? 'approval' : 'allow');
      }
    }
    expect(
      await projectCommandApprovalReason(root, root, {
        command: 'process',
        executable,
        args: ['-m', 'pip', 'install', 'pytest'],
      }),
    ).toContain('approval');
    expect(
      await projectCommandApprovalReason(root, root, { command: `"${executable}" -m pytest`, network: 'allow' }),
    ).toContain('approval');
    expect(await projectCommandApprovalReason(root, root, { command: `"${executable}" && external.exe` })).toContain(
      'approval',
    );
    await fs.writeFile(path.join(root, 'test.cmd'), '"test tools/python.exe" -m pytest');
    expect(await projectCommandApprovalReason(root, root, { command: 'test.cmd' })).toBeUndefined();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('reviews executables outside the canonical project even through a directory link', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'mercury-external-exe-'));
  try {
    const root = path.join(base, 'project'),
      outside = path.join(base, 'outside');
    await fs.mkdir(root);
    await fs.mkdir(outside);
    const executable = path.join(outside, 'tool.exe');
    await fs.writeFile(executable, 'fixture executable');
    await fs.writeFile(path.join(root, 'tool.exe'), 'local fixture executable');
    if (process.platform === 'win32') {
      const driveRelative = path.join(root, 'tool.exe').slice(2);
      expect(
        await projectCommandApprovalReason(root, root, { command: `cd /d Z:\\outside && "${driveRelative}"` }),
      ).toContain('approval');
    }
    expect(await projectCommandApprovalReason(root, root, { command: `cd /d "${outside}" && tool.exe` })).toContain(
      'approval',
    );
    expect(
      await projectCommandApprovalReason(root, root, { command: `cmd /c "cd /d ${outside} && tool.exe"` }),
    ).toContain('approval');
    await fs.symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    for (const filename of [executable, path.join(root, 'linked', 'tool.exe'), path.join(root, 'missing.exe')]) {
      expect(
        await projectCommandApprovalReason(root, root, { command: 'process', executable: filename, args: [] }),
      ).toContain('approval');
    }
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});
