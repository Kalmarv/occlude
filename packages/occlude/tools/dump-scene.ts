#!/usr/bin/env tsx
/**
 * Scene dumper: run a sketch and write the encoded scene buffers — the exact
 * wasm_prepare arguments plus the fills sidecar the JS fill modules produce
 * — to a directory, for the native profiling harness:
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
 * The golden fixture is written by the sentinel test instead
 * (UPDATE_GOLDEN=1 pnpm --filter occlude test -- golden-fixture).
 */

import { transformSync } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as occlude from '../src/index.js';
import { initOcclude } from '../src/index.js';
import { dumpSceneFiles } from './scene-dump.js';

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

const js = transformSync(readFileSync(sketchFile, 'utf8'), {
  loader: 'ts',
  format: 'cjs',
}).code;
const { preloadAssetsFromDisk } = await import('./asset-preload.js');
const { preloadFillsFromDisk } = await import('./fill-preload.js');
preloadAssetsFromDisk(js);
preloadFillsFromDisk(js);
const files = dumpSceneFiles(js, { paper: { paper: paper as never, landscape } });
mkdirSync(outDir, { recursive: true });
for (const [name, content] of Object.entries(files)) writeFileSync(`${outDir}/${name}`, content);
const meta = JSON.parse(files['meta.json'] as string) as { shapes: number; primRows: number; seed: number };
console.log(`dumped scene to ${outDir}: ${meta.shapes} shapes, ${meta.primRows} prim rows, seed ${meta.seed}`);
