import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { DiscoveryResult, ModelConnection, ProviderKind, Settings } from '../shared/types';
import { LocalProviders } from './providers';

const run = promisify(execFile);
const local: ModelConnection[] = [
  { id: 'local-ollama', provider: 'ollama', label: 'Ollama on this computer', url: 'http://127.0.0.1:11434' },
  { id: 'local-lmstudio', provider: 'lmstudio', label: 'LM Studio on this computer', url: 'http://127.0.0.1:1234' },
];

async function installed(command: string, paths: string[] = []): Promise<boolean> {
  if (await Promise.all(paths.map(async candidate => access(candidate).then(() => true, () => false))).then(items => items.some(Boolean))) return true;
  try { await run(process.platform === 'win32' ? 'where.exe' : 'which', [command], { timeout: 2000, windowsHide: true }); return true; }
  catch { return false; }
}

async function tailscalePeers(): Promise<ModelConnection[]> {
  try {
    const { stdout } = await run('tailscale', ['status', '--json'], { timeout: 4000, windowsHide: true, maxBuffer: 500_000 });
    const status = JSON.parse(stdout);
    return Object.values(status.Peer ?? {}).filter((peer: any) => peer.Online).slice(0, 16).flatMap((peer: any) => {
      const ip = (peer.TailscaleIPs ?? []).find((value: string) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(value));
      if (!ip) return [];
      const name = String(peer.HostName || peer.DNSName || ip);
      return ([['lmstudio', 1234], ['ollama', 11434]] as [ProviderKind, number][]).map(([provider, port]) => ({
        id: `tailscale-${ip}-${provider}`, provider, label: `${provider === 'lmstudio' ? 'LM Studio' : 'Ollama'} on ${name} (Tailscale)`, url: `http://${ip}:${port}`,
      }));
    });
  } catch { return []; }
}

function privateAddress(value: string): boolean {
  const parts = value.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127);
}

async function otherVpnPeers(): Promise<ModelConnection[]> {
  const peers = new Map<string, string>();
  try {
    const { stdout } = await run('wg', ['show', 'all', 'allowed-ips'], { timeout: 3000, windowsHide: true, maxBuffer: 100_000 });
    for (const match of stdout.matchAll(/\b(\d{1,3}(?:\.\d{1,3}){3})\/32\b/g)) if (privateAddress(match[1])) peers.set(match[1], 'WireGuard');
  } catch { /* WireGuard may not be installed or active. */ }
  if (process.platform === 'win32') {
    try {
      const script = "Get-NetNeighbor -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -match 'ZeroTier|WireGuard' -and $_.State -ne 'Unreachable' } | Select-Object -ExpandProperty IPAddress";
      const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 4000, windowsHide: true, maxBuffer: 100_000 });
      for (const ip of stdout.split(/\s+/)) if (privateAddress(ip)) peers.set(ip, 'VPN');
    } catch { /* A VPN may not expose an IPv4 neighbor table. */ }
  }
  return [...peers].slice(0, 16).flatMap(([ip, name]) => ([['lmstudio', 1234], ['ollama', 11434]] as [ProviderKind, number][]).map(([provider, port]) => ({
    id: `vpn-${ip}-${provider}`, provider, label: `${provider === 'lmstudio' ? 'LM Studio' : 'Ollama'} on ${ip} (${name})`, url: `http://${ip}:${port}`,
  })));
}

export async function autoDiscover(settings: Settings, providers: LocalProviders): Promise<DiscoveryResult> {
  const diagnostics: string[] = [];
  const candidates = new Map<string, ModelConnection>();
  for (const item of [...settings.connections, ...local, ...await tailscalePeers(), ...await otherVpnPeers()]) {
    const key = `${item.provider}:${item.url.replace(/\/$/, '').toLowerCase()}`;
    if (!candidates.has(key)) candidates.set(key, item);
  }
  const results = await Promise.all([...candidates.values()].map(async connection => {
    try { return { connection, models: await providers.discover(connection) }; }
    catch (error) {
      if (settings.connections.some(item => item.id === connection.id)) diagnostics.push(`${connection.label}: ${String(error)}`);
      return null;
    }
  }));
  const found = results.filter((item): item is NonNullable<typeof item> => item !== null);
  const localAppData = process.env.LOCALAPPDATA ?? '';
  const programFiles = process.env.ProgramFiles ?? '';
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? '';
  const apps: { name: string; command: string; paths: string[]; provider?: ProviderKind }[] = [
    { name: 'Ollama', command: 'ollama', provider: 'ollama', paths: [path.join(localAppData, 'Programs', 'Ollama', 'ollama.exe')] },
    { name: 'LM Studio', command: 'lms', provider: 'lmstudio', paths: [path.join(localAppData, 'Programs', 'LM Studio', 'LM Studio.exe')] },
    { name: 'Tailscale', command: 'tailscale', paths: [path.join(programFiles, 'Tailscale', 'tailscale.exe')] },
    { name: 'ZeroTier', command: 'zerotier-cli', paths: [path.join(programFilesX86, 'ZeroTier', 'One', 'zerotier-cli.bat')] },
    { name: 'WireGuard', command: 'wg', paths: [path.join(programFiles, 'WireGuard', 'wireguard.exe')] },
  ];
  const applications: string[] = [];
  for (const app of apps) {
    if (!await installed(app.command, app.paths)) continue;
    applications.push(app.name);
    if (app.provider && !found.some(item => item.connection.id === `local-${app.provider}`)) diagnostics.push(`${app.name} is installed, but its local model server is not responding. Start its API server, then refresh.`);
    if (app.name === 'ZeroTier' || app.name === 'WireGuard') diagnostics.push(`${app.name} is installed. Use Other to connect to a model server reachable through it.`);
  }
  return { connections: found.map(item => item.connection), models: found.flatMap(item => item.models), applications, diagnostics };
}
