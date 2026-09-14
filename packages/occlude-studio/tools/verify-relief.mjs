/** Verify all required modeling mechanisms in the named relief artifact. */
import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const base = process.env.OCCLUDE_GPU_URL ?? 'http://127.0.0.1:5273';
const output = resolve(process.env.OCCLUDE_GPU_EVIDENCE ?? '../../development/3d/decoration-api/relief');
const source = (await readFile(process.env.OCCLUDE_RELIEF_SOURCE ?? '../../development/3d/demos/procedural-relief.ts', 'utf8')).replace('async t => {', "async t => { console.info('relief-model');");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: false,
  env: { ...process.env, VK_DRIVER_FILES: '/usr/share/vulkan/icd.d/nvidia_icd.json' },
  args: ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan', '--disable-vulkan-surface', '--ignore-gpu-blocklist'] });
let page;
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  let models = 0; page.on('console', m => { if (m.text() === 'relief-model') models++; });
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
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
  const diagnostics = await page.evaluate(() => window.__occlude.editor.diagnostics());
  assert.deepEqual(diagnostics, []);
  assert.equal(first.stats.adapter.isFallbackAdapter, false);
  assert.deepEqual(first.stats.modeling.map(m => [m.operation, m.backend, m.dispatches]), [['deform', 'gpu', 8], ['query', 'gpu', 1]]);
  const scene = first.captured.three.scenes[0], surface = scene.objects[0].surface;
  const caps = surface.faces.filter(f => f.attributes.role === 'cap');
  assert(caps.length > 0 && caps.length < 9, 'seed must select a proper subset of nonadjacent tower sites');
  assert(caps.every(f => f.attributes.occupied === true));
  assert(new Set(caps.map(f => f.attributes.height)).size > 1, 'extrusion must vary');
  const adjusted = surface.points.filter(p => p.attributes.ceilingAdjusted);
  assert(adjusted.length > 0, 'query must actually change positions');
  assert(adjusted.every(p => p.attributes.beforeCeiling > 1.1 && Math.abs(p.position[2] - 1.1) < 1e-5));
  assert(new Set(surface.points.map(p => p.attributes.drift)).size > 2, 'deformation reads varying point attributes');
  const hatch = scene.generated.filter(g => g.curve.kind === 'hatch');
  const sections = scene.generated.filter(g => g.curve.kind === 'section');
  assert(hatch.length > 0 && sections.length > 0);
  const faces = new Map(surface.faces.map(f => [f.id, f]));
  for (const { curve } of hatch) {
    const face = faces.get(curve.attributes.hatchFace); assert(face);
    const multiplier = curve.attributes.hatchFamily === 'cross' ? 2 : 1;
    assert(Math.abs(curve.attributes.hatchSpacingMm - face.attributes.spacing * multiplier) < 1e-10);
  }
  assert(new Set(hatch.map(g => g.curve.attributes.hatchSpacingMm)).size > 2);
  for (const color of ['18202a', '56626a', 'a84932']) assert(first.svg.toLowerCase().includes(color));
  await page.screenshot({ path: resolve(output, 'relief.png') });
  await page.reload(); await ready();
  const repeated = await capture();
  assert.equal(repeated.hash, first.hash); assert.equal(repeated.svg, first.svg);
  assert.deepEqual(repeated.captured.three.scenes, first.captured.three.scenes);
  await page.evaluate(source => window.__occlude.editor.replaceValue(source.replace('seed: 42', 'seed: 43')), source);
  await page.waitForFunction(hash => window.demoReply?.planHash !== hash && window.__occlude.drawing.plan.planHash === window.demoReply.planHash, first.hash, { timeout: 60000 });
  const changed = await capture();
  const otherCaps = changed.captured.three.scenes[0].objects[0].surface.faces.filter(f => f.attributes.role === 'cap');
  assert.notDeepEqual(otherCaps.map(f => f.id), caps.map(f => f.id), 'a different seed changes selected sites');
  assert.equal(models, 3);
  await page.getByRole('button', { name: '3D', exact: true }).click();
  await page.getByLabel('Projection', { exact: true }).selectOption('perspective');
  assert.equal((await capture()).svg, changed.svg);
  await page.getByRole('button', { name: 'Commit view', exact: true }).click();
  await page.waitForFunction(hash => window.demoReply.planHash !== hash && document.querySelector('.construction-pick')?.textContent?.startsWith('View committed.'), changed.hash, { timeout: 60000 });
  const committed = await capture();
  assert.equal(models, 3);
  assert.equal(committed.captured.three.scenes[0].frame.camera.kind, 'perspective');
  assert.deepEqual(committed.captured.three.scenes[0].objects, changed.captured.three.scenes[0].objects);
  assert.notEqual(committed.svg, changed.svg);
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const portable = await readFile(await (await downloadEvent).path(), 'utf8');
  assert(portable.includes(JSON.stringify(committed.captured.three.scenes[0].frame.camera)));
  await writeFile(resolve(output, 'portable.ts'), portable);
  assert.deepEqual(errors, []);
  await writeFile(resolve(output, 'relief.svg'), first.svg);
  await writeFile(resolve(output, 'report.json'), JSON.stringify({ passed: true, base, diagnostics, first, models, committedHash: committed.hash, committedCamera: committed.captured.three.scenes[0].frame.camera, repeatedHash: repeated.hash, changedSeedHash: changed.hash, selectedCaps: caps.map(f => f.id), changedSeedCaps: otherCaps.map(f => f.id), adjustedPoints: adjusted.length, errors }));
  console.log('Relief GPU modeling, query edits, seeded selection and repeatability passed.');
} catch (error) {
  if (page) { await page.screenshot({ path: resolve(output, 'failure.png') }); await writeFile(resolve(output, 'failure.html'), await page.content()); }
  throw error;
} finally { await browser.close(); }
