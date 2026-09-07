// The plan, built once per render — what a studio render pays and renderhash
// never shows. `renderhash` stops at the fragments; the studio worker then
// calls `wasm_plan` (merge + tour + bridge + encode) and hashes the result
// before it can show anything, so this is the phase that decides how long a
// dense sketch takes to come back on screen.
//
//   pnpm exec tsx bench/planbench.mts ../occlude-studio/sketches/<name>.ts …
//
// Medians of 3, seed 42, A4. The studio's shared pen library is loaded, so
// sketches naming real pens work.
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { transformSync } from 'esbuild';
import { fileURLToPath } from 'node:url';
import * as core from 'occlude-core';
import * as occlude from '../src/index.js';
import { compileSketch, initOcclude, isSketch, render, pensToJson, type SketchDef } from '../src/index.js';
import { preloadAssetsFromDisk } from '../tools/asset-preload.js';
import { preloadFillsFromDisk } from '../tools/fill-preload.js';

const wasm = fileURLToPath(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url));
await initOcclude(readFileSync(wasm));
// the studio's shared pen library, so sketches naming real pens work
try {
  const pensPath = fileURLToPath(new URL('../../occlude-studio/sketches/pens.json', import.meta.url));
  (occlude as unknown as { setPenLibrary(p: unknown): void }).setPenLibrary(JSON.parse(readFileSync(pensPath, 'utf8')));
} catch { /* defaults */ }

for (const file of process.argv.slice(2)) {
  const js = transformSync(readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs' }).code;
  preloadAssetsFromDisk(js);
  preloadFillsFromDisk(js);
  const module = { exports: {} as Record<string, unknown> };
  new Function('require', 'exports', 'module', js)((n: string) => { if (n === 'occlude') return occlude; throw new Error(n); }, module.exports, module);
  const exp = module.exports;
  const def = (isSketch(exp.default) ? exp.default : Object.values(exp).find(isSketch)) as SketchDef;
  const sketchMs: number[] = [];
  const planMs: number[] = [];
  const hashMs: number[] = [];
  let frags = 0;
  let planBytes = 0;
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    compileSketch(def, { seed: 42 });
    const r = render({ paper: 'A4' });
    const t1 = performance.now();
    // exactly what the studio worker does once per render: wasm_plan, then
    // the plan's sha256
    const buf = (core as never as { wasm_plan(p: Float64Array, f: Float64Array, pens: string, b: number, g: number): Float64Array })
      .wasm_plan(r.raw.prims, r.raw.frags, pensToJson(r.pens), 200_000, -1);
    const t2 = performance.now();
    const h = await crypto.subtle.digest('SHA-256', buf.buffer as ArrayBuffer);
    const t3 = performance.now();
    hashMs.push(t3 - t2);
    planBytes = buf.length * 8;
    void h;
    sketchMs.push(t1 - t0);
    planMs.push(t2 - t1);
    frags = r.frags.length;
  }
  sketchMs.sort((a, b) => a - b); planMs.sort((a, b) => a - b); hashMs.sort((a, b) => a - b);
  console.log(`${basename(file, '.ts').padEnd(24)} frags ${String(frags).padStart(7)}  render ${sketchMs[1].toFixed(0).padStart(6)}   wasm_plan ${planMs[1].toFixed(0).padStart(5)}   sha256 ${hashMs[1].toFixed(0).padStart(4)} ms   plan ${(planBytes / 1024).toFixed(0)} KB`);
}
