#!/usr/bin/env tsx
/**
 * Render hash: compile a sketch source, render it at each seed, and print
 * one line per seed — `seed  sha256(svg)  frags` — so two engines (or two
 * spellings of one sketch) can be compared byte-for-byte on their output,
 * not on their source. Assets and fills preload from the studio stores
 * exactly as the docs checker does.
 *
 *   pnpm --filter occlude render-hash <sketch.ts> [--seeds 1,42,7] [--probes] [--paper A4] [--svg out.svg]
 *
 * `--svg <path>` also writes the last seed's SVG to that path.
 *
 * `--probes` also prints the sketch's t.probe() stats and the render time
 * per seed.
 *
 * A sketch that fails to compile or render prints `ERROR <message>` on one
 * line and exits 0 — the caller compares that line too.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as occlude from '../src/index.js';
import {
  compileSketch, exportSvg, initOcclude, isSketch, render,
  DEFAULT_PENS, paperSize,
} from '../src/index.js';
import { transformSync } from 'esbuild';
import { inputsFor } from './inputs.js';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) throw new Error('usage: render-hash <sketch.ts> [--seeds a,b,c]');
const si = args.indexOf('--seeds');
const seeds = si >= 0 ? args[si + 1].split(',').map(Number) : [1, 42, 7];
const probes = args.includes('--probes');
const svgOut = args.indexOf('--svg') >= 0 ? args[args.indexOf('--svg') + 1] : undefined;
const pi = args.indexOf('--paper');
const paper = (pi >= 0 ? args[pi + 1] : 'Square20') as 'Square20';

const wasmPath = fileURLToPath(
  new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url),
);
await initOcclude(readFileSync(wasmPath));

// Error text minus anything that names a temp path or a line number, so
// the same failure hashes the same on both sides.
const stableError = (e: unknown) =>
  String(e instanceof Error ? e.message : e).replace(/\/[^\s:]+/g, '<path>').replace(/:\d+(:\d+)?/g, '').slice(0, 200);

let def: unknown;
let js0 = '';
try {
  const src = readFileSync(file, 'utf8');
  // Type-stripped like plotstats does: sketches are real TypeScript.
  const js = transformSync(src, { loader: 'ts', format: 'cjs' }).code;
  js0 = js;
  const module = { exports: {} as Record<string, unknown> };
  new Function('require', 'exports', 'module', js)(
    (name: string) => {
      if (name === 'occlude') return occlude;
      throw new Error(`examples may only import from 'occlude' (tried '${name}')`);
    },
    module.exports,
    module,
  );
  def = module.exports.default;
  if (!isSketch(def)) throw new Error('no default sketch export');
} catch (e) {
  console.log(`ERROR ${stableError(e)}`);
  process.exit(0);
}

for (const seed of seeds) {
  try {
    // A sketch with no seed of its own takes the run's seed.
    const inputs = inputsFor(js0, { paper: 'Square20', seed });
    const exec = compileSketch(def as Parameters<typeof compileSketch>[0], inputs);
    const t0 = performance.now();
    const out = render(exec);
    const renderMs = performance.now() - t0;
    const svg = exportSvg(exec);
    const hash = createHash('sha256').update(svg).digest('hex');
    console.log(`${seed}  ${hash}  ${out.frags.length}`);
    if (svgOut) writeFileSync(svgOut, svg);
    if (probes) {
      console.log(`  render ${renderMs.toFixed(0)} ms`);
      for (const [label, st] of Object.entries(exec.getProbeStats() as Record<string, unknown>)) {
        console.log(`  probe ${label}: ${JSON.stringify(st)}`);
      }
    }
  } catch (e) {
    console.log(`${seed}  ERROR ${stableError(e)}`);
  }
}
