/** Actual Studio download/reopen, including foreign pen and paper libraries. */
import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const base = process.env.OCCLUDE_GPU_URL ?? 'http://127.0.0.1:5273';
const output = resolve(process.env.OCCLUDE_GPU_EVIDENCE ?? '../../development/3d/demo-migration/paper');
await mkdir(output, { recursive: true });
const source = await readFile('../../development/3d/demos/paper-composition.ts', 'utf8');
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: false,
  env: { ...process.env, VK_DRIVER_FILES: '/usr/share/vulkan/icd.d/nvidia_icd.json' },
  args: ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan', '--disable-vulkan-surface', '--ignore-gpu-blocklist'] });
let page;
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.addInitScript(source => {
    if (!sessionStorage.getItem('paper-demo-initialized')) {
      localStorage.setItem('occlude.sketch', source);
      sessionStorage.setItem('paper-demo-initialized', '1');
    }
    const OriginalWorker = window.Worker;
    window.Worker = class extends OriginalWorker {
      constructor(...args) { super(...args); this.addEventListener('message', e => {
        if (e.data.type === 'render') window.demoReply = e.data;
      }); }
    };
  }, source);
  const ready = () => page.waitForFunction(() => window.demoReply && window.__occlude?.drawing.plan && document.querySelector('#status-msg').textContent === 'ok', {}, { timeout: 60000 });
  const capture = () => page.evaluate(async () => {
    const r = window.demoReply;
    return { hash: r.planHash, paper: r.paper, pens: r.pens, settings: r.planSettings,
      camera: r.construction[0].camera, three: r.three, svg: await window.__occlude.drawing.svg('#F5F0E6', -1) };
  });
  await page.goto(base); await ready();
  const initial = await capture();
  const diagnostics = await page.evaluate(() => window.__occlude.editor.diagnostics());
  assert.deepEqual(diagnostics, []);
  await page.screenshot({ path: resolve(output, 'initial.png') });
  assert.equal(initial.three.adapter.isFallbackAdapter, false);
  assert.equal(initial.paper.w, 215.9); assert.equal(initial.paper.h, 279.4);
  assert.equal(initial.paper.color, '#F5F0E6');
  assert(initial.settings && initial.pens.length === 3);
  const pens = Object.fromEntries(initial.pens.map(p => [p.name, p]));
  assert.equal(pens.graphite.width, 0.25); assert.equal(pens.rust.width, 0.25);
  assert.equal(pens.graphite.feed, pens.rust.feed);
  assert.equal(pens.caption.width, 0.4); assert.equal(pens.caption.feed, 2100);
  assert.equal(pens.caption.penDelay, 140);
  const canvas = page.locator('#construction-canvas');
  await page.getByRole('button', { name: '3D', exact: true }).click();
  await page.waitForFunction(() => !!document.querySelector('#construction-canvas').dataset.revision);
  const bounds = await canvas.boundingBox(); assert(bounds);
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width / 2 + 55, bounds.y + bounds.height / 2 + 12, { steps: 8 }); await page.mouse.up();
  await page.getByRole('button', { name: 'Commit view', exact: true }).click();
  await page.waitForFunction(hash => window.__occlude.drawing.plan.planHash !== hash && document.querySelector('.construction-pick').textContent.startsWith('View committed.'), initial.hash, { timeout: 60000 });
  const committed = await capture();
  await page.getByRole('button', { name: '3D', exact: true }).click();
  await page.screenshot({ path: resolve(output, 'composition.png') });
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const downloaded = await readFile(await (await downloadEvent).path(), 'utf8');
  assert(downloaded.includes('@user/pens bundled: pigma-01-black'));
  assert(downloaded.includes('@user/papers bundled: Letter'));
  assert(downloaded.includes('cameras3:'));
  await writeFile(resolve(output, 'paper-composition.ts'), downloaded);
  await page.route('**/api/pens', route => route.fulfill({ json: [{ name: 'pigma-01-black', width: 2, color: '#00FF00', feed: 500, penDown: 1, penUp: 8, penDelay: 999 }] }));
  await page.route('**/api/papers', route => route.fulfill({ json: [{ name: 'Letter', w: 80, h: 90, color: '#FF00FF' }] }));
  await page.evaluate(source => localStorage.setItem('occlude.sketch', source), downloaded);
  await page.reload(); await ready();
  const reopened = await capture();
  assert.equal(reopened.hash, committed.hash);
  assert.deepEqual(reopened.paper, committed.paper); assert.deepEqual(reopened.pens, committed.pens);
  assert.deepEqual(reopened.settings, committed.settings); assert.deepEqual(reopened.camera, committed.camera);
  assert.equal(reopened.svg, committed.svg);
  for (const color of ['18202a', 'a84932', '234b65']) assert(reopened.svg.toLowerCase().includes(color));
  assert.deepEqual(errors, []);
  await writeFile(resolve(output, 'composition.svg'), committed.svg);
  await writeFile(resolve(output, 'report.json'), JSON.stringify({ passed: true, diagnostics, initial, committed, reopened, errors }, null, 2));
  console.log('Imperial paper, bundled imports, committed camera and exact SVG reopen passed.');
} catch (error) {
  if (page) { await page.screenshot({ path: resolve(output, 'failure.png') }); await writeFile(resolve(output, 'failure.html'), await page.content()); }
  throw error;
} finally { await browser.close(); }
