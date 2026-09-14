/** Verify cached styles, stroke inspection and camera movement in the named visibility demo. */
import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const base = process.env.OCCLUDE_GPU_URL ?? 'http://127.0.0.1:5273';
const output = resolve('../../development/3d/playwright-visibility-demo');
const source = await readFile('../../development/3d/demos/visibility-laboratory.ts', 'utf8');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: false,
  env: { ...process.env, VK_DRIVER_FILES: '/usr/share/vulkan/icd.d/nvidia_icd.json' },
  args: ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan', '--disable-vulkan-surface', '--ignore-gpu-blocklist'] });
let page;
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [], inspections = []; page.on('pageerror', e => errors.push(String(e)));
  page.on('console', message => { if (message.text().startsWith('visibility-laboratory ')) inspections.push(JSON.parse(message.text().slice('visibility-laboratory '.length))); });
  await page.addInitScript(source => {
    localStorage.setItem('occlude.sketch', source);
    const OriginalWorker = window.Worker;
    window.Worker = class extends OriginalWorker {
      constructor(...args) { super(...args); this.addEventListener('message', e => {
        if (e.data.type === 'render') { window.demoReply = e.data; window.demoWorker = this; }
      }); }
    };
  }, source);
  const ready = () => page.waitForFunction(() => window.demoReply && window.__occlude?.drawing.plan && document.querySelector('#status-msg').textContent === 'ok', {}, { timeout: 60000 });
  const capture = () => page.evaluate(async () => {
    const r = window.demoReply;
    const captured = await new Promise((resolve, reject) => {
      const worker = window.demoWorker, id = 900000001;
      const listener = e => { if (e.data.id === id) { clearTimeout(timer); worker.removeEventListener('message', listener); resolve(e.data); } };
      const timer = setTimeout(() => reject(new Error('capture timed out')), 15000);
      worker.addEventListener('message', listener); worker.postMessage({ type: 'plan-three', id, planHash: r.planHash });
    });
    return { hash: r.planHash, stats: r.three, captured, svg: await window.__occlude.drawing.svg(undefined, -1) };
  });
  await page.goto(base); await ready();
  const first = await capture();
  assert.equal(first.stats.adapter.isFallbackAdapter, false);
  assert.equal(first.stats.scenes.length, 1);
  assert.equal(inspections.length, 1);
  const inspection = inspections[0];
  assert(inspection.dispatchesBeforeStyles > 0);
  assert.equal(inspection.dispatchesBeforeStyles, inspection.dispatchesAfterStyles);
  assert(inspection.visible > 0 && inspection.hidden > 0 && inspection.contour > 0);
  assert(inspection.contour < inspection.visible);
  assert(inspection.inspected.every(stroke => stroke.parts.length && stroke.breaks.length === 2 && stroke.length > 0));
  const scene = first.captured.three.scenes[0];
  assert.deepEqual(scene.objects.map(o => o.id), ['cube', 'open-plane', 'cross-wide', 'cross-tall']);
  assert.equal(scene.wires[0].id, 'authored-wire');
  await page.screenshot({ path: resolve(output, 'visibility.png') });
  await page.getByRole('button', { name: '3D', exact: true }).click();
  await page.waitForFunction(() => !!document.querySelector('#construction-canvas').dataset.revision);
  const bounds = await page.locator('#construction-canvas').boundingBox(); assert(bounds);
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width / 2 + 60, bounds.y + bounds.height / 2 + 20, { steps: 8 }); await page.mouse.up();
  await page.getByRole('button', { name: 'Commit view', exact: true }).click();
  await page.waitForFunction(hash => window.__occlude.drawing.plan.planHash !== hash && document.querySelector('.construction-pick').textContent.startsWith('View committed.'), first.hash, { timeout: 60000 });
  const committed = await capture();
  assert.equal(inspections.length, 2);
  assert.equal(inspections[1].dispatchesBeforeStyles, inspections[1].dispatchesAfterStyles);
  assert.notDeepEqual(committed.captured.three.scenes[0].frame.camera, scene.frame.camera);
  assert.deepEqual(committed.captured.three.scenes[0].objects, scene.objects);
  assert.deepEqual(committed.captured.three.scenes[0].wires, scene.wires);
  assert.equal(committed.stats.scenes.length, 1);
  assert.deepEqual(errors, []);
  await writeFile(resolve(output, 'visibility.svg'), first.svg);
  await writeFile(resolve(output, 'committed.svg'), committed.svg);
  await writeFile(resolve(output, 'report.json'), JSON.stringify({ passed: true, first, committedHash: committed.hash, committedStats: committed.stats, inspections, errors }, null, 2));
  console.log('Visibility demo cached styles, stroke inspection and camera commit passed.');
} catch (error) {
  if (page) { await page.screenshot({ path: resolve(output, 'failure.png') }); await writeFile(resolve(output, 'failure.html'), await page.content()); }
  throw error;
} finally { await browser.close(); }
