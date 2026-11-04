import { promises as fs, openSync, readSync, closeSync, readFileSync, createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const tar = require('tar');
const extractZip = require('extract-zip');
const plist = require('plist');
const { downloadArtifact } = require('@electron/get');
const asar = require('@electron/asar');
const { Listr } = require('listr2');
const root = path.resolve(import.meta.dirname, '..');
const targets = {
  'linux-x64': { platform: 'linux', arch: 'x64', browser: 'ubuntu24.04-x64', canvas: 'linux-x64-gnu' },
  'darwin-arm64': { platform: 'darwin', arch: 'arm64', browser: 'mac15-arm64', canvas: 'darwin-arm64' },
  'darwin-x64': { platform: 'darwin', arch: 'x64', browser: 'mac15', canvas: 'darwin-x64' },
};
const prepareOnly = process.argv.includes('--prepare-only');
const useCurrentBundles = process.argv.includes('--use-current-bundles');
const requested = process.argv.slice(2).filter(arg => !['--prepare-only', '--use-current-bundles'].includes(arg));
if (!requested.length) requested.push(...Object.keys(targets));
for (const name of requested) if (!targets[name]) throw new Error(`Unsupported target ${name}; choose ${Object.keys(targets).join(', ')}.`);
const run = (args, env = {}) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env }, stdio: 'inherit' });
  child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${args[0]} exited ${code}`)));
});
const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const canvas = JSON.parse(await fs.readFile(path.join(root, 'node_modules/@napi-rs/canvas/package.json'), 'utf8'));
const electron = JSON.parse(await fs.readFile(path.join(root, 'node_modules/electron/package.json'), 'utf8'));
const resourcesFor = name => path.join(root, '.build-resources', 'targets', name);
const posix = file => file.replaceAll('\\', '/');
async function sha256(file) { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex'); }
async function sourceFingerprint() {
  const files = ['package.json', 'package-lock.json', 'forge.config.ts', 'vite.main.config.ts', 'vite.preload.config.ts', 'vite.renderer.config.ts', 'scripts/build-cross-platform.mjs'];
  const collect = async directory => { for (const item of await fs.readdir(path.join(root, directory), { withFileTypes: true })) { const file = path.join(directory, item.name); if (item.isDirectory()) await collect(file); else if (!/\.(test|spec)\./.test(item.name)) files.push(file); } };
  await collect('src'); const hash = createHash('sha256');
  for (const file of files.sort()) { hash.update(posix(file)); hash.update('\0'); hash.update(await fs.readFile(path.join(root, file))); hash.update('\0'); }
  return hash.digest('hex');
}
async function packageFromRegistry(name, version, destination) {
  if (await fs.readFile(path.join(destination, 'package.json'), 'utf8').then(raw => JSON.parse(raw).version === version, () => false)) return;
  const response = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2f')}/${version}`);
  if (!response.ok) throw new Error(`${name} metadata: HTTP ${response.status}`);
  const metadata = await response.json();
  if (!metadata.dist?.integrity?.startsWith('sha512-') || !metadata.dist.tarball.startsWith('https://registry.npmjs.org/')) throw new Error(`Untrusted registry metadata for ${name}.`);
  const archiveResponse = await fetch(metadata.dist.tarball);
  if (!archiveResponse.ok) throw new Error(`${name} archive: HTTP ${archiveResponse.status}`);
  const bytes = Buffer.from(await archiveResponse.arrayBuffer());
  if (`sha512-${createHash('sha512').update(bytes).digest('base64')}` !== metadata.dist.integrity) throw new Error(`${name} failed integrity verification.`);
  const cache = path.join(root, '.build-resources', 'downloads'); await fs.mkdir(cache, { recursive: true });
  const archive = path.join(cache, `${name.replaceAll('/', '-')}-${version}.tgz`); await fs.writeFile(archive, bytes);
  await fs.mkdir(destination, { recursive: true }); await tar.x({ file: archive, cwd: destination, strip: 1 });
}
async function verifyNative(file, target) {
  const handle = await fs.open(file, 'r'); const bytes = Buffer.alloc(24);
  try { await handle.read(bytes, 0, 24, 0); } finally { await handle.close(); }
  const valid = target.platform === 'linux' ? bytes.subarray(0, 4).toString('hex') === '7f454c46' && bytes.readUInt16LE(18) === 62 : bytes.subarray(0, 4).toString('hex') === 'cffaedfe' && bytes.readUInt32LE(4) === (target.arch === 'arm64' ? 0x100000c : 0x1000007);
  if (!valid) throw new Error('Wrong native platform/architecture: ' + file);
}
async function prepare(name) {
  const target = targets[name], resources = resourcesFor(name);
  await fs.mkdir(resources, { recursive: true }); console.log(`Preparing ${name} native agent, PDF and browser runtimes...`);
  const ripgrepVersion = JSON.parse(await fs.readFile(path.join(root, 'node_modules/@vscode/ripgrep/package.json'), 'utf8')).version;
  const searchPackage = `@vscode/ripgrep-${target.platform}-${target.arch}`;
  await packageFromRegistry(searchPackage, ripgrepVersion, path.join(resources, 'search-runtime/node_modules', searchPackage));
  await fs.chmod(path.join(resources, 'search-runtime/node_modules', searchPackage, 'bin/rg'), 0o755);
  await verifyNative(path.join(resources, 'search-runtime/node_modules', searchPackage, 'bin/rg'), target);
  await packageFromRegistry(`@anthropic-ai/claude-agent-sdk-${name}`, manifest.dependencies['@anthropic-ai/claude-agent-sdk'], path.join(resources, 'agent-runtime/node_modules/@anthropic-ai', `claude-agent-sdk-${name}`));
  await packageFromRegistry(`@napi-rs/canvas-${target.canvas}`, canvas.version, path.join(resources, 'pdf-runtime/node_modules/@napi-rs', `canvas-${target.canvas}`));
  const env = { MERCURY_BUILD_PLATFORM: target.platform, MERCURY_BUILD_ARCH: target.arch, MERCURY_BUILD_RESOURCES: resources, PLAYWRIGHT_HOST_PLATFORM_OVERRIDE: target.browser, PLAYWRIGHT_BROWSERS_PATH: path.join(resources, 'browser-runtime'), PLAYWRIGHT_SKIP_BROWSER_GC: '1' };
  // The pinned Playwright CLI adds Windows-only winldd even when cross-installing.
  await run(['-e', `const {registry}=require(process.argv[1]).registry; registry.install([registry.findExecutable('chromium-headless-shell')]).catch(error=>{console.error(error);process.exitCode=1})`, path.join(root, 'node_modules/playwright-core/lib/coreBundle.js')], env);
  const browserDirectory = (await fs.readdir(path.join(resources, 'browser-runtime'))).find(entry => entry.startsWith('chromium_headless_shell-'));
  const shell = target.platform === 'linux' ? 'linux64' : target.arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  await verifyNative(path.join(resources, 'browser-runtime', browserDirectory, 'chrome-headless-shell-' + shell, 'chrome-headless-shell'), target);
  await verifyNative(path.join(resources, 'agent-runtime/node_modules/@anthropic-ai', 'claude-agent-sdk-' + name, 'claude'), target);
  const canvasDirectory = path.join(resources, 'pdf-runtime/node_modules/@napi-rs', 'canvas-' + target.canvas);
  for (const file of await fs.readdir(canvasDirectory)) if (file.endsWith('.node')) await verifyNative(path.join(canvasDirectory, file), target);
  return env;
}
function allowedNativeFile(file, name) {
  const normalized = posix(file);
  const sdk = normalized.match(/(?:^|\/)claude-agent-sdk-((?:linux|darwin|win32)-[^/]+)/)?.[1];
  const nativeCanvas = normalized.match(/(?:^|\/)canvas-((?:linux|darwin|win32)-[^/]+)/)?.[1];
  return (!sdk || sdk === name) && (!nativeCanvas || nativeCanvas === targets[name].canvas);
}
function portableMode(file, stat) {
  if (!stat.isFile()) return true;
  const handle = openSync(path.resolve(root, file), 'r'); const head = Buffer.alloc(4);
  try { readSync(handle, head, 0, 4, 0); } finally { closeSync(handle); }
  const magic = head.toString('hex');
  stat.mode = (stat.mode & ~0o7777) | (['7f454c46', 'cffaedfe', 'cefaedfe', 'feedfacf', 'feedface', 'cafebabe'].includes(magic) || head.subarray(0, 2).toString() === '#!' ? 0o755 : 0o644);
  return true;
}
const bundleReceipt = path.join(root, 'out', '.cross-build-bundle.json');
let bundleHash;
async function ensureBundle() {
  const current = await sourceFingerprint();
  const previous = await fs.readFile(bundleReceipt, 'utf8').then(JSON.parse, () => null);
  if (previous?.sourceFingerprint === current && await fs.access(path.join(root, 'out/Mercury-linux-x64/resources/app.asar')).then(() => true, () => false)) { bundleHash = current; return; }
  const env = await prepare('linux-x64'); Object.assign(process.env, env);
  const config = (await import(pathToFileURL(path.join(root, 'forge.config.ts')).href)).default;
  if (!useCurrentBundles) {
    await config.hooks.generateAssets();
    const plugin = config.plugins[0]; await plugin.init(root, config);
    const hook = plugin.getHooks().prePackage[0];
    await new Listr([{ title: 'Compile production application', task: (_context, task) => hook.call(task, config) }]).run();
  } else {
    // Explicit adoption of a just-finished Forge compile. Reject source changes
    // newer than either output; this option is never enabled by npm scripts.
    const buildTime = Math.min((await fs.stat(path.join(root, '.vite/build/main.js'))).mtimeMs, (await fs.stat(path.join(root, '.vite/renderer/main_window/index.html'))).mtimeMs);
    const check = async directory => { for (const item of await fs.readdir(path.join(root, directory), { withFileTypes: true })) { const file = path.join(directory, item.name); if (item.isDirectory()) await check(file); else if (!/\.(test|spec)\./.test(item.name) && (await fs.stat(path.join(root, file))).mtimeMs > buildTime) throw new Error('Source changed after compilation: ' + file); } };
    await check('src');
  }
  if (await sourceFingerprint() !== current) throw new Error('Application sources changed during compilation. Run the build again to avoid packaging a stale application.');
  const application = path.join(root, '.build-resources', 'app-bundle');
  if (path.relative(path.join(root, '.build-resources'), application) !== 'app-bundle') throw new Error('Invalid application staging directory.');
  await fs.rm(application, { recursive: true, force: true }); await fs.mkdir(application, { recursive: true });
  await fs.cp(path.join(root, '.vite'), path.join(application, '.vite'), { recursive: true });
  await config.hooks.packageAfterCopy(config, application);
  await fs.copyFile(path.join(root, 'package.json'), path.join(application, 'package.json'));
  const linux = path.join(root, 'out', 'Mercury-linux-x64');
  if (path.relative(path.join(root, 'out'), linux) !== 'Mercury-linux-x64') throw new Error('Invalid Linux staging directory.');
  await fs.rm(linux, { recursive: true, force: true }); await fs.mkdir(linux, { recursive: true });
  const zip = await downloadArtifact({ version: electron.version, artifactName: 'electron', platform: 'linux', arch: 'x64' });
  await extractZip(zip, { dir: linux }); await fs.rename(path.join(linux, 'electron'), path.join(linux, 'Mercury'));
  await fs.rm(path.join(linux, 'resources/default_app.asar'), { force: true });
  await asar.createPackage(application, path.join(linux, 'resources/app.asar'));
  if (await sourceFingerprint() !== current) throw new Error('Application sources changed during packaging. Run the build again.');
  bundleHash = current; await fs.writeFile(bundleReceipt, JSON.stringify({ sourceFingerprint: current, at: new Date().toISOString() }));
}
async function archiveMac(name, archive) {
  const target = targets[name], staging = path.join(root, '.build-resources', 'mac-staging', name);
  const zip = await downloadArtifact({ version: electron.version, artifactName: 'electron', platform: 'darwin', arch: target.arch });
  const stagingParent = path.join(root, '.build-resources', 'mac-staging');
  if (path.relative(stagingParent, staging) !== name) throw new Error('Invalid staging directory.');
  await fs.rm(staging, { recursive: true, force: true });
  await fs.mkdir(staging, { recursive: true });
  const links = new Map();
  // Windows cannot create POSIX links without extra privileges. Keep their
  // original ZIP bodies as staging files and restore link headers in the tar.
  await extractZip(zip, { dir: staging, onEntry(entry) { const mode = entry.externalFileAttributes >>> 16; if ((mode & 0o170000) === 0o120000) { links.set(entry.fileName, true); entry.externalFileAttributes = (0o100644 << 16) >>> 0; } } });
  const infoFile = path.join(staging, 'Electron.app/Contents/Info.plist');
  const info = plist.parse(await fs.readFile(infoFile, 'utf8'));
  Object.assign(info, { CFBundleDisplayName: 'Mercury', CFBundleName: 'Mercury', CFBundleIdentifier: 'com.mercury.desktop', CFBundleVersion: manifest.version, CFBundleShortVersionString: manifest.version });
  await fs.writeFile(infoFile, plist.build(info));
  await fs.copyFile(path.join(root, 'out/Mercury-linux-x64/resources/app.asar'), path.join(staging, 'Electron.app/Contents/Resources/app.asar'));
  await fs.rm(path.join(staging, 'Electron.app/Contents/Resources/default_app.asar'), { force: true });
  const base = posix(path.relative(root, staging));
  const entries = [base];
  const mappings = [{ from: base, to: `Mercury-${name}` }];
  const common = resourcesFor('linux-x64');
  for (const resource of ['browser-tools', 'file-runtime', 'map-runtime', 'agent-runtime', 'pdf-runtime']) {
    const from = posix(path.relative(root, path.join(common, resource))); entries.push(from); mappings.push({ from, to: `Mercury-${name}/Mercury.app/Contents/Resources/${resource}` });
  }
  for (const resource of ['browser-runtime', 'agent-runtime', 'pdf-runtime', 'search-runtime']) {
    const from = posix(path.relative(root, path.join(resourcesFor(name), resource))); entries.push(from); mappings.push({ from, to: `Mercury-${name}/Mercury.app/Contents/Resources/${resource}` });
  }
  let restoredLinks = 0;
  await tar.c({ cwd: root, file: archive, gzip: true, portable: true,
    filter(file, stat) { if (!allowedNativeFile(file, name)) return false; return portableMode(file, stat); },
    onWriteEntry(entry) {
      const original = posix(entry.path); const relative = original.startsWith(base + '/') ? original.slice(base.length + 1) : '';
      if (links.has(relative)) { entry.type = 'SymbolicLink'; entry.linkpath = readFileSync(entry.absolute, 'utf8'); entry.stat.size = 0; entry.stat.mode = 0o777; restoredLinks++; }
      const mapping = mappings.find(item => original === item.from || original.startsWith(item.from + '/'));
      if (!mapping) throw new Error('Unexpected archive path ' + original);
      entry.path = (mapping.to + original.slice(mapping.from.length)).replace('/Electron.app/', '/Mercury.app/');
    },
  }, entries);
  if (restoredLinks !== links.size) throw new Error('macOS link metadata was not completely preserved.');
  return restoredLinks;
}
await fs.mkdir(path.join(root, 'out', 'releases'), { recursive: true });
for (const name of requested) {
  await prepare(name); if (prepareOnly) continue;
  await ensureBundle(); const target = targets[name];
  const archive = path.join(root, 'out/releases', `Mercury-${manifest.version}-${name}.tar.gz`);
  let restoredLinks = 0;
  if (target.platform === 'darwin') restoredLinks = await archiveMac(name, archive);
  else {
    const resourceBase = posix(path.relative(root, resourcesFor(name)));
    const resources = ['browser-tools', 'pdf-runtime', 'file-runtime', 'browser-runtime', 'agent-runtime', 'map-runtime', 'search-runtime'].map(resource => resourceBase + '/' + resource);
    await tar.c({ cwd: root, file: archive, gzip: true, portable: true, filter: (file, stat) => allowedNativeFile(file, name) && portableMode(file, stat), onWriteEntry(entry) {
      const original = posix(entry.path);
      entry.path = original.startsWith(resourceBase + '/') ? 'Mercury-' + name + '/resources/' + original.slice(resourceBase.length + 1) : original.replace(/^out\//, '');
    } }, ['out/Mercury-linux-x64', ...resources]);
  }
  if (await sourceFingerprint() !== bundleHash) throw new Error('Application sources changed after compilation. Run the build again.');
  const digest = await sha256(archive);
  await fs.writeFile(`${archive}.sha256`, `${digest}  ${path.basename(archive)}\n`);
  const runtimeBuild = (await fs.readFile(path.join(root, 'src/main/project-agent-runtime.ts'), 'utf8')).match(/PROJECT_RUNTIME_BUILD\s*=\s*['"]([^'"]+)/)?.[1];
  await fs.writeFile(`${archive}.json`, JSON.stringify({ product: 'Mercury', version: manifest.version, platform: target.platform, arch: target.arch, electron: electron.version, builtAt: new Date().toISOString(), runtimeBuild, sourceFingerprint: bundleHash, sha256: digest, lockfileSha256: await sha256(path.join(root, 'package-lock.json')), nativeArchitecturesVerified: true, restoredLinks, signed: false, platformRuntimeTested: false, limitation: 'Confined project process execution currently requires Windows MXC; unavailable modes fail closed.' }, null, 2) + '\n');
  console.log(`Built ${archive}`);
}
