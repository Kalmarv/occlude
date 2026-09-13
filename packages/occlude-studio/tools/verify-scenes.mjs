/** Public lineArt3 sketches through the actual Studio render worker. */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const base = process.env.OCCLUDE_GPU_URL ?? 'http://127.0.0.1:5273';
const output = resolve(process.env.OCCLUDE_GPU_EVIDENCE ?? '../../development/3d/playwright-scenes');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: false,
  env: { ...process.env, VK_DRIVER_FILES: '/usr/share/vulkan/icd.d/nvidia_icd.json' },
  args: ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan', '--disable-vulkan-surface', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const networkFailures = [];
  page.on('response', response => { if (response.status() >= 400) networkFailures.push({ url: response.url(), status: response.status() }); });
  const errors = []; page.on('pageerror', e => { errors.push(String(e)); console.error(String(e)); });
  page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
  await page.addInitScript(() => {
    window.sceneReports = [];
    window.adapterRequests = 0;
    if (navigator.gpu) {
      const request = navigator.gpu.requestAdapter.bind(navigator.gpu);
      navigator.gpu.requestAdapter = (...args) => { window.adapterRequests++; return request(...args); };
    }
    const OriginalWorker = window.Worker;
    window.Worker = class extends OriginalWorker {
      constructor(...args) {
        super(...args);
        this.addEventListener('message', event => {
          if (event.data.type === 'render' && event.data.three) { window.sceneWorker = this; window.sceneReply = event.data; window.sceneReports.push({ ...event.data.three, primitives: event.data.prims.length, fragments: event.data.frags.length }); }
        });
      }
    };
  });
  await page.goto(`${base}/docs.html#/three`);
  await page.locator('.live-example').first().waitFor().catch(async error => { await writeFile(resolve(output, 'failure.html'), await page.content()); await page.screenshot({ path: resolve(output, 'failure.png') }); throw error; });
  const examples = page.locator('.live-example');
  assert.equal(await examples.count(), 2);
  for (let i = 0; i < 2; i++) {
    const example = examples.nth(i);
    await example.scrollIntoViewIfNeeded();
    await page.waitForFunction(index => { const out = document.querySelectorAll('.live-example')[index]; return out?.querySelector('canvas.live-canvas, .live-error'); }, i, { timeout: 60000 });
    assert.equal(await example.locator('.live-error').count(), 0, await example.innerText());
    await example.locator('canvas.live-canvas').waitFor();
    assert.equal(await example.locator('.live-error').count(), 0);
    await example.screenshot({ path: resolve(output, `scene-${i}.png`) });
  }
  const reports = await page.evaluate(() => window.sceneReports);
  assert.equal(reports.length, 2);
  for (const report of reports) {
    assert.equal(report.adapter.isFallbackAdapter, false);
    assert(report.primitives > 0 && report.fragments > 0);
    assert(report.scenes.every(scene => scene.dispatches > 0 && scene.candidates > 0));
  }
  assert.equal(await page.evaluate(() => window.adapterRequests), 0);
  assert.deepEqual(errors, []);
  await examples.first().getByRole('button', { name: 'open in studio' }).click();
  await page.waitForFunction(() => window.sceneReports?.length > 0, {}, { timeout: 60000 });
  const studio = await page.evaluate(() => window.sceneReports[0]);
  assert.equal(studio.adapter.isFallbackAdapter, false);
  assert(studio.scenes[0].dispatches > 0);
  const svg = await page.evaluate(async () => {
    const worker = window.sceneWorker, reply = window.sceneReply, id = 900000001;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { worker.removeEventListener('message', listener); reject(new Error('SVG export timed out')); }, 10000);
      const listener = event => {
        if (event.data.id !== id) return;
        clearTimeout(timeout); worker.removeEventListener('message', listener);
        if (event.data.type === 'error') reject(new Error(event.data.message)); else resolve(event.data.svg);
      };
      worker.addEventListener('message', listener);
      worker.postMessage({ type: 'plan-svg', id, planHash: reply.planHash, from: 0, to: reply.plan[1], width: reply.paper.w, height: reply.paper.h, onlyPen: -1 });
    });
  });
  assert(svg.includes('<path'));
  await writeFile(resolve(output, 'studio.svg'), svg);
  await page.screenshot({ path: resolve(output, 'studio.png'), fullPage: true });
  assert.deepEqual(errors, []);
  await writeFile(resolve(output, 'report.json'), JSON.stringify({ passed: true, base, reports, studio, svgBytes: svg.length, errors, networkFailures }, null, 2));
  console.log(JSON.stringify({ passed: true, reports }));
} finally { await browser.close(); }
