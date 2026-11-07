import type { BrowserWindow } from 'electron';

export function sendRendererUpdate(window: BrowserWindow | null, channel: string, payload: unknown): void {
  if (!window || window.isDestroyed()) return;
  try {
    const contents = window.webContents;
    if (contents.isDestroyed()) return;
    const frame = contents.mainFrame;
    if (!frame || frame.isDestroyed() || frame.detached) return;
    // A live window can outlast its renderer during reload or shutdown. The
    // replacement renderer requests a snapshot, so transient updates can be skipped.
    frame.send(channel, payload);
  } catch (error) {
    // Disposal can also race the checks above. Keep serialization and other
    // programming errors visible rather than treating every failure as shutdown.
    if (error instanceof Error && /^(?:Object has been destroyed|Render frame was disposed before WebFrameMain could be accessed)\.?$/.test(error.message)) return;
    throw error;
  }
}
