#!/usr/bin/env tsx
/**
 * Headless sketch renderer: run a sketch file and write PNG/SVG without a
 * browser. The debug loop for "what does seed X actually look like".
 *
 *   pnpm --filter occlude render <sketch.ts> [--seed N] [--paper A4]
 *        [--landscape] [--scale 8] [--out out.png] [--svg out.svg]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as occlude from '../src/index.js';
import { exportPng, exportSvg, initOcclude, paperSize, setPaperHint } from '../src/index.js';

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
const size = paperSize({ paper: paper as never, landscape });
setPaperHint(size.w, size.h);

// Execute the sketch: strip its `import … from 'occlude'` and expose the
// whole API as bare names (sketches are plain JS-compatible TS).
const src = readFileSync(sketchFile, 'utf8').replace(
  /import\s*\{[\s\S]*?\}\s*from\s*['"]occlude['"];?/g,
  '',
);
new Function('occlude', `with (occlude) { ${src} }`)(occlude);

const paperOpt = { paper: paper as never, landscape };
writeFileSync(out, exportPng({ paper: paperOpt, scale, background: '#f6f2ea' }));
console.log(`wrote ${out} (${size.w}×${size.h}mm at ${scale}px/mm)`);
if (svgOut) {
  writeFileSync(svgOut, exportSvg({ paper: paperOpt, background: '#f6f2ea' }));
  console.log(`wrote ${svgOut}`);
}
