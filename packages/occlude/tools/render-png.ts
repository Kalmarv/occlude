#!/usr/bin/env tsx
/**
 * Headless sketch renderer: run a sketch file and write PNG/SVG without a
 * browser. The debug loop for "what does seed X actually look like".
 *
 *   pnpm --filter occlude render <sketch.ts> [--seed N] [--paper A4]
 *        [--landscape] [--scale 8] [--out out.png] [--svg out.svg]
 *
 * The sketch must export a `sketch(config, fn)` definition (default export
 * preferred, else the first exported definition found).
 */

import { transformSync } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as occlude from '../src/index.js';
import {
  compileSketch, exportPng, exportSvg, initOcclude, isSketch, paperSize,
  setPaperHint, type SketchDef,
} from '../src/index.js';

const args = process.argv.slice(2);
const sketchFile = args.find((a) => !a.startsWith('--'));
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string): boolean => args.includes(`--${name}`);

if (!sketchFile) {
  console.error('usage: render <sketch.ts> [--seed N] [--paper A4] [--landscape] [--scale 8] [--out out.png] [--svg out.svg]');
  process.exit(1);
}

const seed = opt('seed');
const paper = opt('paper') ?? 'A4';
const landscape = has('landscape');
const scale = parseFloat(opt('scale') ?? '8');
const out = opt('out') ?? 'sketch.png';
const svgOut = opt('svg');

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

// Transpile the sketch to CommonJS (exactly like the studio runner) and
// collect its exports.
const js = transformSync(readFileSync(sketchFile, 'utf8'), {
  loader: 'ts',
  format: 'cjs',
}).code;
const { preloadAssetsFromDisk } = await import('./asset-preload.js');
const { preloadFillsFromDisk } = await import('./fill-preload.js');
preloadAssetsFromDisk(js);
preloadFillsFromDisk(js);
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

const paperOpt = { paper: paper as never, landscape };
writeFileSync(out, exportPng({ paper: paperOpt, scale, background: '#f6f2ea' }));
console.log(`wrote ${out} (${size.w}×${size.h}mm at ${scale}px/mm)`);
if (svgOut) {
  writeFileSync(svgOut, exportSvg({ paper: paperOpt, background: '#f6f2ea' }));
  console.log(`wrote ${svgOut}`);
}
