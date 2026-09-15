/** Ink digest of every benchmark workload, taken from the served Studio on
 * the real WebGPU adapter.
 *
 * There is no oracle for the GPU interval classification other than a
 * before/after comparison of what it actually draws, so this captures the
 * same digest the renderhash oracle uses — sha256 over the raw prims and
 * frags buffers, which is exactly what the preview, the export and the paper
 * are made of — for one built image. Run it against the image built at the
 * branch point and again against the image under test, and diff the files:
 * every workload must carry the identical digest.
 *
 * The Studio owns the run inputs (its own paper, margin, pens and seed), and
 * they are recorded here so two captures can be shown to be comparable.
 *
 *   cd packages/occlude-studio
 *   DISPLAY=:93 OCCLUDE_STAMP=<stamp> OCCLUDE_INK_OUT=<file.json> \
 *     node --input-type=module < ../../development/3d/optimization/ink-digest.mjs
 *
 * A software fallback adapter would make the capture meaningless, so the
 * adapter is recorded and asserted.
 */
import {chromium} from 'playwright';
import {writeFile} from 'node:fs/promises';
import {workloads} from '/home/kalmarv/containers/occlude-3d/development/3d/benchmark-surface/workloads.mjs';

const base = process.env.OCCLUDE_GPU_URL ?? 'http://127.0.0.1:5273';
const stamp = process.env.OCCLUDE_STAMP ?? '';
const out = process.env.OCCLUDE_INK_OUT ?? '../../development/3d/optimization/ink-digest.json';
// A trailing comment cannot change ink, and makes the source differ from
// whatever the store held so the worker actually re-runs the sketch.
const TAG = '\n// ink-digest';

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome', headless: false,
  env: {...process.env, VK_DRIVER_FILES: '/usr/share/vulkan/icd.d/nvidia_icd.json'},
  args: ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan', '--disable-vulkan-surface', '--ignore-gpu-blocklist'],
});
const rows = [], errors = [];
let adapter = null, inputs = null;
try {
  const page = await browser.newPage();
  page.on('pageerror', e => errors.push(String(e)));
  await page.addInitScript(source => {
    localStorage.setItem('occlude.sketch', source);
    const Original = Worker;
    window.Worker = class extends Original {
      constructor(...a) { super(...a); this.addEventListener('message', e => { if (e.data.type === 'render') { window.reply = e.data; window.count = (window.count ?? 0) + 1; } }); }
    };
  }, workloads[0].src);
  await page.goto(base);
  if (stamp) await page.waitForFunction(s => document.querySelector('#status-build')?.textContent.includes(s), stamp, {timeout: 120000});
  await page.waitForFunction(() => window.reply && document.querySelector('#status-msg').textContent === 'ok', {}, {timeout: 300000});
  for (const {name, src} of workloads) {
    const prior = await page.evaluate(() => window.count);
    await page.evaluate(s => { window.__occlude.editor.setValue(s); }, src + TAG);
    try {
      await page.waitForFunction(n => window.count > n && document.querySelector('#status-msg').textContent === 'ok', prior, {timeout: 600000});
    } catch (e) {
      const status = await page.evaluate(() => document.querySelector('#status-msg')?.textContent);
      rows.push({name, digest: null, status, note: String(e).split('\n')[0]});
      console.log('NO REPLY', name.padEnd(22), status);
      continue;
    }
    const row = await page.evaluate(async () => {
      const r = window.reply;
      const prims = new Uint8Array(r.prims.buffer, r.prims.byteOffset, r.prims.byteLength);
      const frags = new Uint8Array(r.frags.buffer, r.frags.byteOffset, r.frags.byteLength);
      const joined = new Uint8Array(prims.length + frags.length);
      joined.set(prims); joined.set(frags, prims.length);
      const bits = await crypto.subtle.digest('SHA-256', joined);
      const hex = [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
      return {digest: hex.slice(0, 32), prims: r.prims.length, frags: r.frags.length,
        adapter: r.three?.adapter ?? null,
        scenes: (r.three?.scenes ?? []).map(s => ({candidates: s.candidates, dispatches: s.dispatches, refinements: s.refinements})),
        inputs: {seed: r.seedUsed, paper: r.paper, frame: r.frame, pens: r.pens}};
    });
    adapter ??= row.adapter; inputs ??= row.inputs;
    rows.push({name, digest: row.digest, prims: row.prims, frags: row.frags, scenes: row.scenes});
    console.log('ink', name.padEnd(22), row.digest, row.prims + '/' + row.frags);
  }
} finally { await browser.close(); }
const real = adapter && adapter.isFallbackAdapter === false;
await writeFile(out, JSON.stringify({base, stamp, adapter, realAdapter: real, inputs, rows, errors}, null, 2) + '\n');
console.log(real ? 'captured on a real adapter' : 'WARNING: fallback adapter, capture is meaningless');
