#!/usr/bin/env tsx
/**
 * Byte-identity oracle + phase timer for optimisation work: render sketches
 * headless, hash the raw output buffers (prims + frags, exactly what the
 * preview, export, and paper are made of), and time every phase:
 *
 *   pnpm --filter occlude renderhash <sketch.ts...> [--seed N] [--paper A4]
 *        [--landscape] [--save file.json] [--check file.json] [--runs N]
 *
 * --save writes {name: {hash, ...timings}}; --check compares hashes against
 * a saved file and exits non-zero on any drift — the gate every
 * optimisation must pass before its speed-up counts.
 */

import { transformSync } from 'esbuild';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from 'occlude-core';
import * as occlude from '../src/index.js';
import {
  compileSketch, initOcclude, isSketch, paperSize, setPaperHint, setPenLibrary,
  type SketchDef,
} from '../src/index.js';
import { encodeScene, runFillJobs, type WasmModule } from '../src/render.js';
import { preloadAssetsFromDisk } from './asset-preload.js';
import { preloadFillsFromDisk } from './fill-preload.js';

const args = process.argv.slice(2);
const files = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && !['--landscape'].includes(args[i - 1])));
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const paper = opt('paper') ?? 'A4';
const landscape = args.includes('--landscape');
const seed = opt('seed');
const runs = Number(opt('runs') ?? 1);
if (seed !== undefined) (globalThis as Record<string, unknown>).location = { search: `?seed=${seed}` };

const wasmPath = fileURLToPath(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url));
await initOcclude(readFileSync(wasmPath));
try {
  const pensPath = fileURLToPath(new URL('../../occlude-studio/sketches/pens.json', import.meta.url));
  setPenLibrary(JSON.parse(readFileSync(pensPath, 'utf8')));
} catch {
  // default pens
}
const size = paperSize({ paper: paper as never, landscape });
setPaperHint(size.w, size.h);

interface Row {
  hash: string;
  frags: number;
  sketchMs: number;
  encodeMs: number;
  prepareMs: number;
  fillsMs: number;
  finishMs: number;
  totalMs: number;
}

function renderOnce(js: string): Row {
  const mod = core as unknown as WasmModule;
  const t0 = performance.now();
  const module = { exports: {} as Record<string, unknown> };
  new Function('require', 'exports', 'module', js)(
    (name: string) => {
      if (name === 'occlude') return occlude;
      throw new Error(`sketches can only import from 'occlude' (tried '${name}')`);
    },
    module.exports, module,
  );
  const exp = module.exports;
  const def = (isSketch(exp.default) ? exp.default : Object.values(exp).find(isSketch)) as SketchDef | undefined;
  if (!def) throw new Error('no sketch exported');
  compileSketch(def);
  const t1 = performance.now();
  const scene = encodeScene({ paper: { paper: paper as never, landscape } });
  const t2 = performance.now();
  const prepared = mod.wasm_prepare(
    scene.prims, scene.contours, scene.shapesU32, scene.shapesF64, scene.mods,
    scene.fieldData, scene.fieldUses, scene.domainList, scene.clipList, scene.clipsU32,
    scene.pensJson, scene.paperArr, scene.seed, scene.coarsen, 0,
  );
  const t3 = performance.now();
  let supplied;
  try {
    supplied = runFillJobs(scene, prepared.jobs_index, prepared.jobs_contours, prepared.jobs_prims);
  } catch (e) {
    prepared.free?.();
    throw e;
  }
  const t4 = performance.now();
  const result = mod.wasm_finish(prepared, supplied.fillsIndex, supplied.fillChains, supplied.fillPrims, supplied.fillDots);
  const t5 = performance.now();
  const h = createHash('sha256');
  h.update(new Uint8Array(result.prims.buffer, result.prims.byteOffset, result.prims.byteLength));
  h.update(new Uint8Array(result.frags.buffer, result.frags.byteOffset, result.frags.byteLength));
  const frags = result.frags.length / 6;
  result.free?.();
  return {
    hash: h.digest('hex').slice(0, 16), frags,
    sketchMs: t1 - t0, encodeMs: t2 - t1, prepareMs: t3 - t2, fillsMs: t4 - t3, finishMs: t5 - t4,
    totalMs: t5 - t0,
  };
}

const results: Record<string, Row> = {};
for (const file of files) {
  const name = basename(file, '.ts');
  try {
    const js = transformSync(readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs' }).code;
    preloadAssetsFromDisk(js);
    preloadFillsFromDisk(js);
    let best: Row | null = null;
    for (let r = 0; r < runs; r++) {
      const row = renderOnce(js);
      if (best && row.hash !== best.hash) throw new Error(`non-deterministic: ${best.hash} vs ${row.hash}`);
      if (!best || row.totalMs < best.totalMs) best = row;
    }
    results[name] = best!;
  } catch (e) {
    console.error(`${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const fmt = (n: number): string => n.toFixed(0).padStart(7);
console.log('sketch'.padEnd(18), 'hash'.padEnd(17), 'frags'.padStart(7), 'sketch'.padStart(7), 'encode'.padStart(7), 'pass1'.padStart(7), 'fills'.padStart(7), 'pass2'.padStart(7), 'total'.padStart(7));
for (const [name, r] of Object.entries(results)) {
  console.log(name.padEnd(18), r.hash.padEnd(17), String(r.frags).padStart(7), fmt(r.sketchMs), fmt(r.encodeMs), fmt(r.prepareMs), fmt(r.fillsMs), fmt(r.finishMs), fmt(r.totalMs));
}
const save = opt('save');
if (save) writeFileSync(save, JSON.stringify(results, null, 2));
const check = opt('check');
if (check) {
  const base = JSON.parse(readFileSync(check, 'utf8')) as Record<string, Row>;
  let drift = 0;
  for (const [name, r] of Object.entries(results)) {
    const b = base[name];
    if (!b) { console.log(`${name}: no baseline`); continue; }
    if (b.hash !== r.hash) { drift++; console.log(`DRIFT ${name}: ${b.hash} → ${r.hash}`); }
    else console.log(`same  ${name}  ${(b.totalMs / Math.max(1, r.totalMs)).toFixed(2)}× (${b.totalMs.toFixed(0)} → ${r.totalMs.toFixed(0)} ms)`);
  }
  process.exit(drift ? 1 : 0);
}
