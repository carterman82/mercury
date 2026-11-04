import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const excluded = ['.git', '.mercury', 'node_modules', 'dist', 'build', 'out', '.vite', '.next', 'coverage', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', 'venv', '.venv', '.venv-*', '.venv_*'];

export function repositorySearchExecutable(): string {
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const base = resources && !resources.endsWith(path.join('electron', 'dist', 'resources'))
    ? path.join(resources, 'search-runtime', 'node_modules')
    : path.join(process.cwd(), 'node_modules');
  const require = createRequire(path.join(base, '..', 'package.json'));
  return require.resolve(`@vscode/ripgrep-${process.platform}-${process.arch}/bin/${process.platform === 'win32' ? 'rg.exe' : 'rg'}`, { paths: [base] });
}

/** Fixed argument arrays only; user queries never pass through a shell. */
export async function repositorySearch(root: string, target: string, mode: 'files' | 'matches', limit: number, query?: string, signal?: AbortSignal): Promise<string[]> {
  signal?.throwIfAborted();
  const args = ['--hidden', '--no-require-git', '--no-ignore-global', '--no-ignore-exclude', '--no-config', '--sort', 'path'];
  for (const directory of excluded) args.push('--glob', `!**/${directory}`, '--glob', `!**/${directory}/**`);
  if (mode === 'files') args.push('--files', '--null', '--');
  else args.push('--max-filesize', '512000', '--json', '--fixed-strings', '--ignore-case', '--', query!);
  args.push(target);
  return new Promise((resolve, reject) => {
    const child = spawn(repositorySearchExecutable(), args, { cwd: root, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const output: string[] = [];
    let pending = '', errors = '', stopped = false;
    const stop = () => { stopped = true; child.kill(); };
    const abort = () => child.kill();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { errors = 'Repository search timed out.'; child.kill(); }, 30_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { errors = (errors + chunk).slice(0, 2000); });
    child.stdout.on('data', (chunk: string) => {
      if (stopped) return;
      pending += chunk;
      const delimiter = mode === 'files' ? '\0' : '\n';
      let index: number;
      while ((index = pending.indexOf(delimiter)) >= 0) {
        const line = pending.slice(0, index); pending = pending.slice(index + 1);
        if (mode === 'files') output.push(line.replaceAll('\\', '/').replace(/^\.\//, ''));
        else {
          try {
            const event = JSON.parse(line);
            if (event.type === 'match' && typeof event.data.path.text === 'string' && typeof event.data.lines.text === 'string') {
              const file = event.data.path.text.replaceAll('\\', '/').replace(/^\.\//, '');
              output.push(`${file}:${event.data.line_number}: ${event.data.lines.text.replace(/\r?\n$/, '').slice(0, 240)}`);
            }
          } catch { errors = 'Invalid repository search output.'; stop(); }
        }
        if (output.length >= limit) { stop(); break; }
      }
      if (pending.length > 2_000_000) { errors = 'Repository search output exceeded its limit.'; stop(); }
    });
    child.once('error', reject);
    child.once('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (signal?.aborted) reject(signal.reason);
      else if (errors || (!stopped && code !== 0 && code !== 1)) reject(new Error(errors || `Repository search exited with code ${code}.`));
      else resolve(output);
    });
  });
}
