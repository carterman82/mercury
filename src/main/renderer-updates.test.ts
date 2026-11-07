import type { BrowserWindow } from 'electron';
import { expect, it, vi } from 'vitest';
import { sendRendererUpdate } from './renderer-updates';

function renderer() {
  const send = vi.fn();
  const frame = { isDestroyed: vi.fn(() => false), detached: false, send };
  const contents = { isDestroyed: vi.fn(() => false), mainFrame: frame, send };
  const window = { isDestroyed: vi.fn(() => false), webContents: contents };
  return { window: window as unknown as BrowserWindow, contents, frame, send };
}

it('delivers updates to a live renderer', () => {
  const { window, send } = renderer();
  const payload = { chat: { id: 'chat', status: 'running' } };
  sendRendererUpdate(window, 'chat:update', payload);
  expect(send).toHaveBeenCalledExactlyOnceWith('chat:update', payload);
});

it.each(['destroyed contents', 'destroyed frame', 'detached frame'])('skips updates to %s even when the window is alive', state => {
  const { window, contents, frame, send } = renderer();
  if (state === 'destroyed contents') contents.isDestroyed.mockReturnValue(true);
  if (state === 'destroyed frame') frame.isDestroyed.mockReturnValue(true);
  if (state === 'detached frame') frame.detached = true;
  sendRendererUpdate(window, 'chat:update', {});
  expect(send).not.toHaveBeenCalled();
});

it('skips missing and closed windows', () => {
  const { window, send } = renderer();
  vi.mocked(window.isDestroyed).mockReturnValue(true);
  sendRendererUpdate(null, 'state:update', {});
  sendRendererUpdate(window, 'state:update', {});
  expect(send).not.toHaveBeenCalled();
});

it('resumes updates using the replacement frame after a reload', () => {
  const { window, contents, frame, send } = renderer();
  frame.detached = true;
  sendRendererUpdate(window, 'chat:update', { version: 1 });
  const replacement = { isDestroyed: vi.fn(() => false), detached: false, send: vi.fn() };
  contents.mainFrame = replacement;
  sendRendererUpdate(window, 'chat:update', { version: 2 });
  expect(send).not.toHaveBeenCalled();
  expect(replacement.send).toHaveBeenCalledExactlyOnceWith('chat:update', { version: 2 });
});

it('tolerates a frame disposed between the availability check and send', () => {
  const { window, send } = renderer();
  send.mockImplementation(() => { throw new Error('Render frame was disposed before WebFrameMain could be accessed'); });
  expect(() => sendRendererUpdate(window, 'chat:update', {})).not.toThrow();
});

it('preserves unrelated send errors', () => {
  const { window, send } = renderer();
  send.mockImplementation(() => { throw new Error('An object could not be cloned.'); });
  expect(() => sendRendererUpdate(window, 'chat:update', {})).toThrow('An object could not be cloned.');
});

it('does not access the frame of destroyed contents', () => {
  const { window, contents } = renderer();
  contents.isDestroyed.mockReturnValue(true);
  const get = vi.fn(() => { throw new Error('Object has been destroyed'); });
  Object.defineProperty(contents, 'mainFrame', { get });
  sendRendererUpdate(window, 'state:update', {});
  expect(get).not.toHaveBeenCalled();
});
