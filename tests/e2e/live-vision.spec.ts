import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

test('live LM Studio describes an actual image through Mercury, not just OCR', async () => {
  test.skip(!process.env.MERCURY_LIVE_IMAGE || !process.env.MERCURY_LIVE_URL || !process.env.MERCURY_LIVE_MODEL, 'Opt-in live model test.');
  test.setTimeout(180_000);
  const data = mkdtempSync(path.join(os.tmpdir(), 'mercury-live-vision-'));
  const app = await electron.launch({ executablePath: path.resolve('out', process.env.LOCAL_PLAN_AGENT_BUILD_ID ?? '', 'Mercury-win32-x64', 'Mercury.exe'), env: { ...process.env, LOCAL_PLAN_AGENT_USER_DATA: data } });
  try {
    const page = await app.firstWindow();
    await page.evaluate(async ({ url, model }) => window.desktop.updateSettings({ connections: [{ id: 'live', provider: 'lmstudio', label: 'Live model', url }], mainModel: { provider: 'lmstudio', connectionId: 'live', model, contextLimit: 32768 }, plannerModel: null, subagentModel: null }), { url: process.env.MERCURY_LIVE_URL!, model: process.env.MERCURY_LIVE_MODEL! });
    await page.evaluate(() => { const input = document.createElement('input'); input.type = 'file'; input.id = 'live-image'; document.body.appendChild(input); });
    await page.locator('#live-image').setInputFiles(process.env.MERCURY_LIVE_IMAGE!);
    await page.evaluate(() => { const input = document.getElementById('live-image') as HTMLInputElement; const data = new DataTransfer(); data.items.add(input.files![0]); document.querySelector('.chat-layout')!.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data })); input.remove(); });
    await expect(page.locator('.pending-files')).toContainText(path.basename(process.env.MERCURY_LIVE_IMAGE!), { timeout: 60_000 });
    await page.getByLabel('Message', { exact: true }).fill('Describe the characters and their colors in this image. Answer briefly using the actual picture, not the filename.');
    await page.getByRole('button', { name: 'Send ↑' }).click();
    await expect.poll(async () => (await page.evaluate(() => window.desktop.snapshot())).chats[0]?.status, { timeout: 150_000 }).toBe('idle');
    const answer = await page.locator('.chat-assistant .chat-message-content').innerText();
    expect(answer).toMatch(/blue/i); expect(answer).toMatch(/red/i);
    expect(answer).not.toMatch(/only.{0,30}OCR|cannot (?:see|visually)|don't have (?:the ability|visual)/i);
    await page.screenshot({ path: 'test-results/mercury-live-vision.png' });
    console.log('Live image answer:', answer);
  } finally { await app.close(); rmSync(data, { recursive: true, force: true }); }
});
