#!/usr/bin/env tsx
/**
 * Scene dumper: run a sketch and write the encoded scene buffers — the exact
 * wasm_render arguments — to a directory, for the native profiling harness:
 *
 *   pnpm --filter occlude dump-scene <sketch.ts> <out-dir> [--seed N]
 *        [--paper Square20] [--landscape]
 *
 * then, from crates/occlude-core:
 *
 *   cargo run --release --no-default-features --features profile \
 *     --example replay -- <out-dir> [iterations]
 *
 * profiles the real scene through the serial pipeline with stage timers.
 */

import { transformSync } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as occlude from '../src/index.js';
import {
  compileSketch, initOcclude, isSketch, paperSize, setPaperHint, type SketchDef,
} from '../src/index.js';
import { encodeScene, runFillJobs, type WasmModule } from '../src/render.js';
import * as core from 'occlude-core';

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const sketchFile = positional[0];
const outDir = positional[1];
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

if (!sketchFile || !outDir) {
  console.error('usage: dump-scene <sketch.ts> <out-dir> [--seed N] [--paper Square20] [--landscape]');
  process.exit(1);
}

const seed = opt('seed');
const paper = opt('paper') ?? 'Square20';
const landscape = args.includes('--landscape');

// The sketch reads its seed from the URL; give it one.
if (seed !== undefined) {
  (globalThis as Record<string, unknown>).location = { search: `?seed=${seed}` };
}

const wasmPath = fileURLToPath(
  new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url),
);
await initOcclude(readFileSync(wasmPath));
try {
  const pensPath = fileURLToPath(new URL('../../occlude-studio/sketches/pens.json', import.meta.url));
  occlude.setPenLibrary(JSON.parse(readFileSync(pensPath, 'utf8')));
} catch {
  // default pens
}
const size = paperSize({ paper: paper as never, landscape });
setPaperHint(size.w, size.h);

const js = transformSync(readFileSync(sketchFile, 'utf8'), {
  loader: 'ts',
  format: 'cjs',
}).code;
const { preloadAssetsFromDisk } = await import('./asset-preload.js');
preloadAssetsFromDisk(js);
const module = { exports: {} as Record<string, unknown> };
const requireShim = (name: string): unknown => {
  if (name === 'occlude') return occlude;
  throw new Error(`sketches can only import from 'occlude' (tried '${name}')`);
};
new Function('require', 'exports', 'module', js)(requireShim, module.exports, module);
const exp = module.exports;
const def = (isSketch(exp.default)
  ? exp.default
  : Object.values(exp).find(isSketch)) as SketchDef | undefined;
if (!def) {
  console.error('no sketch exported — write `export default sketch({ … }, (toolkit) => tree)`');
  process.exit(1);
}
compileSketch(def);

const scene = encodeScene({});
mkdirSync(outDir, { recursive: true });
const dump = (name: string, arr: Float64Array | Uint32Array): void => {
  writeFileSync(`${outDir}/${name}`, Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength));
};
dump('prims.f64', scene.prims);
dump('contours.u32', scene.contours);
dump('shapes_u32.u32', scene.shapesU32);
dump('shapes_f64.f64', scene.shapesF64);
dump('mods.f64', scene.mods);
dump('fields.f64', scene.fieldData);
dump('clip_list.u32', scene.clipList);
dump('clips_u32.u32', scene.clipsU32);
// Fills sidecar: run pass 1 + the fill jobs (exactly what a render does)
// and persist the supplied ink for native replay.
{
  const mod = core as unknown as WasmModule;
  const prepared = mod.wasm_prepare(
    scene.prims, scene.contours, scene.shapesU32, scene.shapesF64, scene.mods,
    scene.fieldData, scene.clipList, scene.clipsU32, scene.pensJson,
    scene.paperArr, scene.seed, scene.coarsen, 0,
  );
  const supplied = runFillJobs(
    scene, prepared.jobs_index, prepared.jobs_contours, prepared.jobs_prims,
  );
  prepared.free?.();
  dump('fills_index.u32', supplied.fillsIndex);
  dump('fill_prims.f64', supplied.fillPrims);
  dump('fill_dots.f64', supplied.fillDots);
}
writeFileSync(`${outDir}/pens.json`, scene.pensJson);
writeFileSync(`${outDir}/meta.json`, JSON.stringify({
  paper: Array.from(scene.paperArr), seed: scene.seed, coarsen: scene.coarsen,
}));
console.log(
  `dumped scene to ${outDir}: ${scene.shapesU32.length / 12} shapes, ` +
  `${scene.prims.length / 9} prim rows, seed ${scene.seed}`,
);
