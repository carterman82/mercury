/** Host classification of visible command requests, never a model risk label.
 * Confinement still enforces filesystem/network limits on ordinary commands. */
import { promises as fs } from 'node:fs';
import path from 'node:path';

interface CommandInput {
  command: string;
  executable?: string;
  args?: string[];
  stdin?: string;
  network?: string;
}

export function commandApprovalReason(input: CommandInput): string | undefined {
  const text = [input.command, input.executable, ...(input.args ?? []), input.stdin].filter(Boolean).join(' ');
  if (/\.(?:exe|com|msi)\b|\b(?:msiexec|start-process)\b/i.test(text))
    return 'Running an EXE or launching an external program requires your approval.';
  if (
    (/\b(?:install|uninstall|add|update|upgrade|setup|ensurepip|venv|sync)\b/i.test(text) &&
      /\b(?:npm|npx|pnpm|yarn|bun|pip\d*|pipx|uv|poetry|python\d*|py|conda|mamba|winget|choco|scoop|apt(?:-get)?|dnf|yum|brew|gem|cargo|dotnet|setup)\b/i.test(
        text,
      )) ||
    /\b(?:npm|pnpm|bun)\s+(?:i|ci)\b|\byarn\s*(?:$|[;&|])/i.test(text)
  )
    return 'Installing, removing or updating software requires your approval.';
  if (
    /\b(?:npx|npm\s+exec|pnpm\s+dlx|yarn\s+dlx|bunx|uvx|curl|wget|irm|invoke-restmethod|invoke-webrequest)\b/i.test(
      text,
    ) ||
    input.network === 'allow'
  )
    return 'Downloading or running network-provided code requires your approval.';
}

/** Inspect local launch scripts as well as the submitted command. Unreadable,
 * external or excessive launch chains require review rather than blind trust. */
export async function projectCommandApprovalReason(
  root: string,
  cwd: string,
  input: CommandInput,
  inspectScope?: (text: string) => void,
  reviewPermissions = true,
): Promise<string | undefined> {
  inspectScope?.([input.command, input.executable, ...(input.args ?? []), input.stdin].filter(Boolean).join(' '));
  const canonicalRoot = await fs.realpath(root);
  cwd = await fs.realpath(cwd);
  if (!within(canonicalRoot, cwd))
    return 'Review this command before inspecting or running scripts outside the project.';
  // An extension alone is not a reason to review project tooling. Resolve every
  // candidate independently so another external launch still requires approval.
  const classify = async (command: string, directory: string, network?: string) => {
    if (!reviewPermissions) return undefined;
    const uncertainDirectory = /\b(?:cd|chdir|pushd)\b|\b(?:cmd|powershell|pwsh|sh|bash)(?:\.exe)?\s/i.test(command);
    const candidates =
      /"([^"\r\n]+\.(?:exe|com))"|'([^'\r\n]+\.(?:exe|com))'|([^\s"';&|()<>]+\.(?:exe|com))(?=$|[\s"';&|()<>])/gi;
    let inspected = '',
      offset = 0;
    for (const match of command.matchAll(candidates)) {
      inspected += command.slice(offset, match.index);
      const filename = match[1] ?? match[2] ?? match[3];
      let local = false;
      try {
        const resolved = await fs.realpath(path.resolve(directory, filename));
        // A Windows root-relative path (\tools\app.exe) still depends on the
        // current drive; only a drive-qualified/UNC path is stable after cd /d.
        const fullyQualified =
          path.isAbsolute(filename) && (process.platform !== 'win32' || path.parse(filename).root.length > 1);
        local =
          (!uncertainDirectory || fullyQualified) &&
          within(canonicalRoot, resolved) &&
          (await fs.stat(resolved)).isFile();
      } catch {
        /* Unknown executable paths still require review. */
      }
      // Keep the program name for installation/network classification (python,
      // pip, curl, etc.), removing only the already-authorized extension.
      inspected += local ? match[0].replace(/\.(?:exe|com)(?=["']?$)/i, '') : match[0];
      offset = match.index! + match[0].length;
    }
    inspected += command.slice(offset);
    return commandApprovalReason({ command: inspected, network });
  };
  const direct = await classify(
    [input.command, input.executable ? `"${input.executable}"` : '', ...(input.args ?? []), input.stdin]
      .filter(Boolean)
      .join(' '),
    cwd,
    input.network,
  );
  if (direct) return direct;
  const visited = new Set<string>();
  const inspect = async (command: string, directory: string, depth: number): Promise<string | undefined> => {
    inspectScope?.(command);
    const risk = await classify(command, directory);
    if (risk) return risk;
    // A single Windows directory listing consumes filenames as data. Do not
    // inspect a listed .js file as a launch script. Composed commands and
    // expansion still follow the conservative inspection below.
    if (/^\s*dir(?:\s|$)/i.test(command) && !/[&|;<>\r\n^%!`$]/.test(command)) return undefined;
    if (depth > 8 || visited.size > 32)
      return 'Review this command: its local launch chain exceeds the inspection limit.';
    const scripts = [
      ...command.matchAll(/(?:^|[\s"'])((?:[\w./\\-]+)\.(?:[cm]?js|tsx?|py|ps1|cmd|bat|sh))(?=$|[\s"'])/gi),
    ].map((match) => match[1]);
    const npm = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([\w:-]+)/i.exec(command);
    if (npm && !['exec', 'dlx', 'version', '--version'].includes(npm[1])) {
      let packageDirectory = directory;
      let manifest: any;
      for (;;) {
        try {
          const manifestPath = await fs.realpath(path.join(packageDirectory, 'package.json'));
          if (!within(canonicalRoot, manifestPath))
            return 'Review this command: its package manifest points outside the project.';
          if ((await fs.stat(manifestPath)).size > 512000)
            return 'Review this command: its package manifest exceeds the inspection limit.';
          manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
          break;
        } catch {
          /* Search only within the project. */
        }
        const parent = path.dirname(packageDirectory);
        if (packageDirectory === canonicalRoot || parent === packageDirectory || !within(canonicalRoot, parent)) break;
        packageDirectory = parent;
      }
      if (!manifest) return 'Review this package command: its project scripts could not be inspected.';
      for (const name of [`pre${npm[1]}`, npm[1], `post${npm[1]}`]) {
        const script = manifest.scripts?.[name];
        const key = `${packageDirectory}:${name}`;
        if (typeof script !== 'string' || visited.has(key)) continue;
        visited.add(key);
        const reason = await inspect(script, packageDirectory, depth + 1);
        if (reason) return reason;
      }
    }
    for (const script of scripts) {
      let filename: string;
      try {
        filename = await fs.realpath(path.resolve(directory, script));
      } catch {
        return 'Review this command: a referenced local script could not be inspected.';
      }
      if (!within(canonicalRoot, filename)) return 'Running a script outside the project requires approval.';
      if (visited.has(filename)) continue;
      visited.add(filename);
      const stat = await fs.stat(filename);
      if (stat.size > 512000) return 'Review this command: its launch script exceeds the inspection limit.';
      const reason = await inspect(await fs.readFile(filename, 'utf8'), path.dirname(filename), depth + 1);
      if (reason) return reason;
    }
  };
  return inspect([input.command, ...(input.args ?? []), input.stdin ?? ''].join(' '), cwd, 0);
}

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
