/** Direct Playwright coverage of the async live example through Studio's worker. */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const base = process.env.OCCLUDE_GPU_URL ?? 'http://127.0.0.1:5273';
const output = resolve(process.env.OCCLUDE_GPU_EVIDENCE ?? '../../development/3d/playwright-async');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: false,
  env: { ...process.env, VK_DRIVER_FILES: '/usr/share/vulkan/icd.d/nvidia_icd.json' },
  args: ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan', '--disable-vulkan-surface', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.goto(`${base}/docs.html#/getting-started`);
  const example = page.locator('.live-example').last();
  await example.scrollIntoViewIfNeeded();
  await example.locator('canvas.live-canvas').waitFor({ timeout: 60000 });
  assert((await example.innerText()).includes('sketchAsync'));
  assert.equal(await example.locator('.live-error').count(), 0);
  const ink = await example.locator('canvas.live-canvas').evaluate(canvas => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let dark = 0; for (let i = 0; i < data.length; i += 4) if (data[i] < 100 && data[i + 1] < 100 && data[i + 2] < 100 && data[i + 3] > 0) dark++;
    return dark;
  });
  assert(ink > 100, 'async example must render actual ink');
  assert.deepEqual(errors, []);
  await example.screenshot({ path: resolve(output, 'async-example.png') });
  await writeFile(resolve(output, 'report.json'), JSON.stringify({ passed: true, base, inkPixels: ink, errors }, null, 2));
  console.log(JSON.stringify({ passed: true, inkPixels: ink }));
} finally { await browser.close(); }
