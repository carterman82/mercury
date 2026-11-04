import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createRequire, isBuiltin } from 'node:module';

const resourceRoot = process.env.MERCURY_BUILD_RESOURCES ?? '.build-resources';
const targetPlatform = process.env.MERCURY_BUILD_PLATFORM ?? process.platform;
const targetArch = process.env.MERCURY_BUILD_ARCH ?? process.arch;

async function copyRuntimePackages(target: string, dependencies = ['docx', 'exceljs', 'pptxgenjs', 'tesseract.js', '@tesseract.js-data/eng', '@modelcontextprotocol/sdk', 'npm']): Promise<void> {
  const modules = path.resolve('node_modules');
  const copied = new Set<string>();
  const copy = async (name: string, from = process.cwd()): Promise<void> => {
    if (name.startsWith('@types/') || isBuiltin(name)) return;
    const require = createRequire(path.join(from, 'package.json'));
    for (const directory of require.resolve.paths(name) ?? []) {
      const source = path.join(directory, name);
      const manifest = await fs.readFile(path.join(source, 'package.json'), 'utf8').then(raw => JSON.parse(raw), () => null);
      if (manifest?.name === name) {
        if (manifest.os && !manifest.os.includes(targetPlatform)) return;
        if (manifest.cpu && !manifest.cpu.includes(targetArch)) return;
        if (copied.has(source)) return;
        copied.add(source);
        const relative = path.relative(modules, source);
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Runtime dependency is outside project node_modules.');
        await fs.cp(source, path.join(target, relative), { recursive: true });
        for (const dependency of Object.keys(manifest.dependencies ?? {})) await copy(dependency, source);
        for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) { try { await copy(dependency, source); } catch { /* Platform-specific optional module. */ } }
        return;
      }
    }
    throw new Error(`Could not locate runtime package ${name}.`);
  };
  for (const dependency of dependencies) await copy(dependency);
}

const config: ForgeConfig = {
  buildIdentifier: () => process.env.LOCAL_PLAN_AGENT_BUILD_ID ?? '',
  // Playwright is a built-in capability rather than an import in the UI bundle,
  // so copy its runtime explicitly into every packaged app.
  packagerConfig: { asar: true, name: 'Mercury', extraResource: process.env.MERCURY_BUNDLE_ONLY === '1' ? [] : ['browser-tools', 'pdf-runtime', 'file-runtime', 'browser-runtime', 'agent-runtime', 'map-runtime', 'search-runtime', ...(targetPlatform === 'win32' ? ['mxc-runtime'] : [])].map(name => path.join(resourceRoot, name)) },
  hooks: { packageAfterCopy: async (_config, buildPath) => {
    await copyRuntimePackages(path.join(buildPath, 'node_modules'), ['jsdom']);
  }, generateAssets: async () => {
    const searchPackage = `@vscode/ripgrep-${targetPlatform}-${targetArch}`;
    const searchTarget = path.join(resourceRoot, 'search-runtime', 'node_modules', searchPackage);
    if (targetPlatform === process.platform && targetArch === process.arch) await copyRuntimePackages(path.join(resourceRoot, 'search-runtime', 'node_modules'), [searchPackage]);
    await fs.access(path.join(searchTarget, 'bin', targetPlatform === 'win32' ? 'rg.exe' : 'rg'));
    const browserEntries = await fs.readdir(path.join(resourceRoot, 'browser-runtime')).catch(() => []);
    if (!browserEntries.some(name => name.startsWith('chromium_headless_shell-'))) throw new Error('Install the bundled Chromium runtime: set PLAYWRIGHT_BROWSERS_PATH=.build-resources/browser-runtime and run npx playwright install chromium --only-shell.');
    for (const dependency of ['playwright', 'playwright-core']) await fs.cp(path.join('node_modules', dependency), path.join(resourceRoot, 'browser-tools', 'node_modules', dependency), { recursive: true });
    const target = path.join(resourceRoot, 'pdf-runtime', 'node_modules');
    await fs.mkdir(target, { recursive: true });
    await copyRuntimePackages(target, ['pdfjs-dist', '@napi-rs/canvas']);
    await copyRuntimePackages(path.join(resourceRoot, 'file-runtime', 'node_modules'));
    await copyRuntimePackages(path.join(resourceRoot, 'agent-runtime', 'node_modules'), ['@anthropic-ai/claude-agent-sdk', '@anthropic-ai/sdk', '@modelcontextprotocol/sdk', 'zod']);
    const maps = path.join(resourceRoot, 'map-runtime'); await fs.mkdir(maps, { recursive: true });
    await fs.copyFile(path.join('node_modules', 'web-tree-sitter', 'web-tree-sitter.wasm'), path.join(maps, 'web-tree-sitter.wasm'));
    await fs.cp(path.join('node_modules', '@repomix', 'tree-sitter-wasms', 'out'), path.join(maps, 'grammars'), { recursive: true });
    if (targetPlatform !== 'win32') return;
    const manifest = JSON.parse(await fs.readFile(path.join(resourceRoot, 'mxc-runtime', 'runtime.json'), 'utf8').catch(() => { throw new Error('Run npm run prepare:mxc to install the pinned verified Windows executor.'); }));
    if (manifest.version !== '1.0.1') throw new Error('The packaged MXC version does not match the supported runtime.');
  } },
  makers: [new MakerSquirrel({})],
  plugins: [new VitePlugin({
    build: [
      { entry: 'src/main/main.ts', config: 'vite.main.config.ts' },
      { entry: 'src/main/preload.ts', config: 'vite.preload.config.ts' },
    ],
    renderer: [{ name: 'main_window', config: 'vite.renderer.config.ts' }],
  })],
};

export default config;
