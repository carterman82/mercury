import { expect, it, vi } from 'vitest';
import { ChatCapabilities, chatCapabilityTools } from './chat-capabilities';
import type { ChatBrowser } from './chat-browser';
import type { ChatPlugins } from './chat-plugins';
import { browserEvidenceKind, browserToolDefinitions } from './browser-tool-registry';

const signal = new AbortController().signal;
const url = 'https://example.org/';
const cases = [
  ['browser_search', 'search', { query: 'query' }, ['chat', 'query', signal]],
  ['browser_open', 'open', { url }, ['chat', url, signal]],
  ['browser_read', 'read', {}, ['chat', 0, signal, undefined]],
  ['browser_click_button', 'clickButton', { selector: '#load' }, ['chat', '#load', signal]],
  ['browser_click', 'click', { url }, ['chat', url, signal]],
  ['browser_fill', 'fill', { selector: '#question', text: 'Hello' }, ['chat', '#question', 'Hello', false, signal, undefined]],
  ['browser_close', 'close', {}, ['chat']],
  ['browser_screenshot', 'screenshot', {}, ['chat', signal]],
  ['browser_enable_controls', 'enableControls', {}, ['chat', signal]],
  ['browser_press', 'press', { keys: ['Enter'] }, ['chat', ['Enter'], signal, undefined]],
  ['browser_pointer', 'pointer', { x: 0, y: 899 }, ['chat', 0, 899, signal]],
  ['browser_wait', 'wait', { milliseconds: 50 }, ['chat', 50, signal]],
] as const;

function fixture(result: unknown = { observed: true }) {
  const browser = Object.fromEntries(cases.map(([, method]) => [method, vi.fn().mockResolvedValue(result)]));
  return { browser, tools: new ChatCapabilities(browser as unknown as ChatBrowser, {} as ChatPlugins) };
}

it('preserves advertised browser order, descriptions and schemas', () => {
  const tools = chatCapabilityTools.filter(tool => tool.function.name.startsWith('browser_'));
  expect(tools.map(tool => tool.function.name)).toEqual(cases.map(([name]) => name));
  expect(tools).toMatchSnapshot();
});

it('classifies browser evidence without registering historical or prototype tools', () => {
  expect(browserToolDefinitions.map(({ name }) => [name, browserEvidenceKind(name)])).toEqual([
    ['browser_search', 'none'], ['browser_open', 'open'], ['browser_read', 'observation'],
    ['browser_click_button', 'interaction'], ['browser_click', 'none'], ['browser_fill', 'interaction'],
    ['browser_close', 'none'], ['browser_screenshot', 'observation'], ['browser_enable_controls', 'none'],
    ['browser_press', 'interaction'], ['browser_pointer', 'interaction'], ['browser_wait', 'none'],
  ]);
  expect(browserEvidenceKind('browser_act')).toBe('interaction');
  expect(browserEvidenceKind('constructor')).toBeUndefined();
  expect(browserEvidenceKind('unknown')).toBeUndefined();
});

it.each(cases)('dispatches %s with the existing argument order and defaults', async (name, method, args, expected) => {
  const result = { observed: true };
  const { browser, tools } = fixture(result);
  expect(await tools.execute('chat', name, args, signal)).toEqual(name === 'browser_close' ? { closed: true } : result);
  expect(browser[method]).toHaveBeenCalledExactlyOnceWith(...expected);
  expect(Object.values(browser).filter(mock => mock.mock.calls.length)).toHaveLength(1);
});

it('forwards explicit optional arguments and preserves strict versus stripped unknown fields', async () => {
  const { browser, tools } = fixture();
  await tools.execute('chat', 'browser_read', { offset: 17, selector: '#reply', extra: 'stripped' }, signal);
  expect(browser.read).toHaveBeenCalledExactlyOnceWith('chat', 17, signal, '#reply');
  await tools.execute('chat', 'browser_fill', { selector: '#q', text: 'Hello', submit: true, responseSelector: '#reply' }, signal);
  expect(browser.fill).toHaveBeenCalledExactlyOnceWith('chat', '#q', 'Hello', true, signal, '#reply');
  await tools.execute('chat', 'browser_press', { keys: ['Space'], intervalMs: 25 }, signal);
  expect(browser.press).toHaveBeenCalledExactlyOnceWith('chat', ['Space'], signal, 25);
  await expect(tools.execute('chat', 'browser_click_button', { selector: '#load', extra: true }, signal)).rejects.toMatchObject({ name: 'ZodError' });
  await expect(tools.execute('chat', 'browser_fill', { selector: '#q', text: '', extra: true }, signal)).rejects.toMatchObject({ name: 'ZodError' });
  expect(browser.clickButton).not.toHaveBeenCalled();
  expect(browser.fill).toHaveBeenCalledTimes(1);
});

it.each(cases.filter(([name]) => name !== 'browser_close'))('preserves the response mode for %s', async (name, _method, args) => {
  const result = { content: 'x'.repeat(60000), _browserImage: { data: 'image' }, isError: true };
  const { tools } = fixture(result);
  const actual = await tools.execute('chat', name, args, signal);
  if (['browser_fill', 'browser_click_button', 'browser_screenshot'].includes(name)) expect(actual).toBe(result);
  else expect(actual).toEqual({ truncated: true, isError: true, content: [{ type: 'text', text: JSON.stringify(result).slice(0, 48000) }], note: 'Untrusted plugin result truncated. Narrow the query or request fewer results.' });
});

it('rejects invalid or aborted calls before browser effects and propagates runtime failures', async () => {
  const { browser, tools } = fixture();
  for (const name of ['constructor', '__proto__', 'browser_act']) {
    expect(tools.handles(name)).toBe(false);
    await expect(tools.execute('chat', name, {}, signal)).rejects.toThrow('Unknown chat capability.');
  }
  await expect(tools.execute('chat', 'browser_search', { query: 'x'.repeat(100001) }, signal)).rejects.toThrow('Tool arguments exceed 100,000 characters.');
  await expect(tools.execute('chat', 'browser_wait', { milliseconds: 49 }, signal)).rejects.toMatchObject({ name: 'ZodError' });
  const reason = new Error('Stopped');
  await expect(tools.execute('chat', 'browser_open', { url }, AbortSignal.abort(reason))).rejects.toBe(reason);
  expect(Object.values(browser).every(mock => mock.mock.calls.length === 0)).toBe(true);
  const denied = new Error('Runtime policy denial');
  browser.clickButton.mockRejectedValueOnce(denied);
  await expect(tools.execute('chat', 'browser_click_button', { selector: '#load' }, signal)).rejects.toBe(denied);
});
