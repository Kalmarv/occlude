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
import * as coreMod from 'occlude-core';
import { type SketchDef } from '../src/index.js';
import {
  compileSketchAsync, decodeRender, encodeScene, initOcclude, isSketch, planBuffer, renderAsync, renderEncoded,
} from '../src/host.js';
import { inputsFor, paperLibrary, penLibrary, requireFor } from '../tools/inputs.js';

const wasm = fileURLToPath(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url));
await initOcclude(readFileSync(wasm));

for (const file of process.argv.slice(2)) try {
  const js = transformSync(readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs' }).code;
  const module = { exports: {} as Record<string, unknown> };
  new Function('require', 'exports', 'module', js)(requireFor(penLibrary(), paperLibrary()), module.exports, module);
  const exp = module.exports;
  const def = (isSketch(exp.default) ? exp.default : Object.values(exp).find(isSketch)) as SketchDef;
  const inputs = inputsFor(js, { paper: 'A4', seed: 42 });
  const sketchMs: number[] = [];
  const planMs: number[] = [];
  const hashMs: number[] = [];
  const decodeMs: number[] = [];
  let frags = 0;
  let planBytes = 0;
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    const r = await renderAsync(def, inputs);
    const t1 = performance.now();
    // exactly what the studio worker does once per render: wasm_plan (with
    // the sketch's own `t.plan`), then the plan's sha256
    const { buffer } = planBuffer(r);
    const t2 = performance.now();
    const h = await crypto.subtle.digest('SHA-256', buffer.buffer as ArrayBuffer);
    const t3 = performance.now();
    hashMs.push(t3 - t2);
    planBytes = buffer.length * 8;
    void h;
    // What the MAIN THREAD then does with the worker's buffers: decode every
    // primitive and every fragment into objects before it can draw a pixel.
    const scene2 = encodeScene(await compileSketchAsync(def, inputs));
    const raw2 = renderEncoded(coreMod as never, scene2);
    const t4 = performance.now();
    decodeRender(scene2, raw2);
    decodeMs.push(performance.now() - t4);
    sketchMs.push(t1 - t0);
    planMs.push(t2 - t1);
    frags = r.frags.length;
  }
  sketchMs.sort((a, b) => a - b); planMs.sort((a, b) => a - b); hashMs.sort((a, b) => a - b); decodeMs.sort((a, b) => a - b);
  console.log(`${basename(file, '.ts').padEnd(24)} frags ${String(frags).padStart(7)}  render ${sketchMs[1].toFixed(0).padStart(6)}   wasm_plan ${planMs[1].toFixed(0).padStart(5)}   sha256 ${hashMs[1].toFixed(0).padStart(4)}   decodeRender ${decodeMs[1].toFixed(0).padStart(5)} ms   plan ${(planBytes / 1024).toFixed(0)} KB`);
} catch (e) {
  // one stale sketch does not stop the rest
  console.log(`${basename(file, '.ts').padEnd(24)} ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
