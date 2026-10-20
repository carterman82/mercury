import { expect, it } from 'vitest';
import { ChatCapabilities } from './chat-capabilities';
import type { ChatPlugins } from './chat-plugins';
import type { ChatBrowser } from './chat-browser';
const id = 'a'.repeat(32), signal = new AbortController().signal;
it('preserves MCP content and error flags while bounding oversized responses', async () => {
  const plugins = { call: async () => ({ isError: true, content: [{ type: 'text', text: 'x'.repeat(100_000) }] }) } as unknown as ChatPlugins;
  const tools = new ChatCapabilities({} as ChatBrowser, plugins);
  const result: any = await tools.execute('chat', 'plugin_call_tool', { pluginId: id, tool: 'query', arguments: {} }, signal);
  expect(result.truncated).toBe(true); expect(result.isError).toBe(true); expect(result.content[0].text.length).toBe(48_000);
  expect(JSON.stringify(result).length).toBeLessThan(50_000);
});
it('keeps plugin IDs and tool names when full input schemas are too large', async () => {
  const plugins = { install: async () => ({ installed: true, pluginId: id, tools: [{ name: 'large_tool', description: 'Description', inputSchema: { description: 'x'.repeat(60_000) } }] }) } as unknown as ChatPlugins;
  const tools = new ChatCapabilities({} as ChatBrowser, plugins);
  const result: any = await tools.execute('chat', 'install_plugin', { candidateId: '123e4567-e89b-42d3-a456-426614174000' }, signal);
  expect(result).toMatchObject({ installed: true, pluginId: id, schemasOmitted: true, tools: [{ name: 'large_tool' }] });
  expect(result.note).toContain('toolName');
});
it('refuses prototype method names, invented tools, and oversized arguments', async () => {
  const tools = new ChatCapabilities({} as ChatBrowser, {} as ChatPlugins);
  expect(tools.handles('constructor')).toBe(false); expect(tools.handles('__proto__')).toBe(false);
  await expect(tools.execute('chat', 'invented', {}, signal)).rejects.toThrow('Unknown');
  await expect(tools.execute('chat', 'browser_search', { query: 'x'.repeat(100_001) }, signal)).rejects.toThrow('exceed');
});
it('preserves structured discovery candidates instead of turning a large search into clipped JSON', async () => {
  const plugins = { discover: async () => ({ status: 'found', matches: Array.from({ length: 64 }, (_, index) => ({ candidateId: `candidate-${index}`, name: `plugin-${index}`, description: 'x'.repeat(2000), installable: true })), installed: Array.from({ length: 100 }, () => ({ id, name: 'Saved plugin', description: 'y'.repeat(2000) })), searches: [{ query: 'website', returned: 64 }] }) } as unknown as ChatPlugins;
  const tools = new ChatCapabilities({} as ChatBrowser, plugins);
  const result: any = await tools.execute('chat', 'discover_plugins', { query: 'website' }, signal);
  expect(result.matches.length).toBeGreaterThan(0); expect(result.matches[0].candidateId).toBe('candidate-0');
  expect(result.status).toBe('found'); expect(result.resultsTruncated).toBe(true);
  expect(JSON.stringify(result).length).toBeLessThan(50_000);
});
