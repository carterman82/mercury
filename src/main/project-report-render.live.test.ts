import { it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

it.skipIf(process.env.MERCURY_RENDER_REPORT !== '1')('renders the saved Wordpress report without network access', async () => {
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.resolve('.build-resources/browser-runtime');
  const source = await fs.readFile('test-results/live-reports/Wordpress.mmd', 'utf8');
  const browser = await chromium.launch({ headless: true, executablePath: path.resolve('.build-resources/browser-runtime/chromium_headless_shell-1248/chrome-headless-shell-win64/chrome-headless-shell.exe') });
  try {
    const page = await browser.newPage({ viewport: { width: 1800, height: 1200 } });
    await page.route('**/*', route => route.abort());
    await page.setContent('<html><body style="margin:20px;background:white"><div id="diagram"></div></body></html>');
    await page.addScriptTag({ path: path.resolve('node_modules/mermaid/dist/mermaid.min.js') });
    const svg = await page.evaluate(async content => {
      const mermaid = (window as any).mermaid;
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default', flowchart: { htmlLabels: false } });
      const rendered = await mermaid.render('wordpressReport', content);
      document.getElementById('diagram')!.innerHTML = rendered.svg;
      return rendered.svg;
    }, source);
    expect(await page.locator('#diagram svg').count()).toBe(1);
    expect(await page.locator('#diagram svg text').count()).toBeGreaterThan(3);
    await fs.writeFile('test-results/live-reports/Wordpress.svg', svg);
    await page.locator('#diagram').screenshot({ path: 'test-results/live-reports/Wordpress.png' });
  } finally { await browser.close(); }
}, 60000);
