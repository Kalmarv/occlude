#!/usr/bin/env tsx
/**
 * Seed-sweep QA: run every scenario in qa-scenarios.ts over many seeds and
 * report violations — mechanized stumbling, so bugs are found before a
 * human opens the unlucky seed.
 *
 *   pnpm --filter occlude qa [--seeds 100] [--base 1000] [--only name]
 *        [--sketches dir]
 *
 * `--sketches dir` additionally sweeps every .ts sketch in `dir` (the
 * adversarial corpus): each is rendered across seeds and papers with the
 * universal invariants — no exception, deterministic, all coordinates
 * finite, exports respond.
 *
 * Bug classes encoded (all shipped at some point, all caught by hand):
 *   chain-connected     mid-chain holes from per-primitive nib rule
 *   nib-floor           sub-nib segments emitted by pre-ops
 *   deform-converged    long chords / S-curves from under-subdivision
 *   identity-*          zero-strength modifiers must be no-ops
 *   occlusion-exact     hidden-line result vs closed-form interval math
 *   post-preserves-hiding  post ops must never change what is hidden
 *   swirl-oracle        engine vs independent analytic field evaluation
 */

import { transformSync } from 'esbuild';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as occlude from '../src/index.js';
import {
  compileSketch, exportSvg, initOcclude, isSketch, render,
  type SketchDef,
} from '../src/index.js';
import { scenarios, type Scenario, type Violation } from './qa-scenarios.js';

/** Load a sketch file the way the studio runner does. */
function loadSketch(file: string): SketchDef {
  const js = transformSync(readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs' }).code;
  const module = { exports: {} as Record<string, unknown> };
  const requireShim = (name: string): unknown => {
    if (name === 'occlude') return occlude;
    throw new Error(`sketches can only import from 'occlude' (tried '${name}')`);
  };
  new Function('require', 'exports', 'module', js)(requireShim, module.exports, module);
  const exp = module.exports;
  const def = (isSketch(exp.default) ? exp.default : Object.values(exp).find(isSketch)) as
    | SketchDef
    | undefined;
  if (!def) throw new Error('no sketch exported');
  return def;
}

/** Universal invariants any sketch must satisfy at any seed. */
function corpusScenario(file: string): Scenario {
  const def = loadSketch(file);
  return (seed) => {
    (globalThis as Record<string, unknown>).location = { search: `?seed=${seed}` };
    const v: Violation[] = [];
    const paper = seed % 2 === 0 ? 'A4' : 'Square20';
    const a = render(def, { paper });
    const b = render(def, { paper });
    if (
      a.raw.frags.length !== b.raw.frags.length ||
      a.raw.frags.some((x, i) => x !== b.raw.frags[i])
    ) {
      v.push({ rule: 'deterministic', detail: 'two renders differ' });
    }
    for (let i = 0; i < a.raw.prims.length; i++) {
      if (!Number.isFinite(a.raw.prims[i])) {
        v.push({ rule: 'finite', detail: `non-finite value in prim table at ${i}` });
        break;
      }
    }
    compileSketch(def);
    const svg = exportSvg({ paper });
    if (svg.includes('NaN')) v.push({ rule: 'finite', detail: 'NaN in exported SVG' });
    return v;
  };
}

const args = process.argv.slice(2);
const opt = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const seeds = parseInt(opt('seeds', '100'), 10);
const base = parseInt(opt('base', '1000'), 10);
const only = opt('only', '');
const sketchDir = opt('sketches', '');

const wasmPath = fileURLToPath(
  new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url),
);
await initOcclude(readFileSync(wasmPath));

const suite: Record<string, Scenario> = { ...scenarios };
if (sketchDir) {
  for (const f of readdirSync(sketchDir).filter((f) => f.endsWith('.ts'))) {
    try {
      suite[`corpus:${f}`] = corpusScenario(join(sketchDir, f));
    } catch (err) {
      console.log(`corpus:${f} failed to load: ${err instanceof Error ? err.message : err}`);
    }
  }
}

let totalRuns = 0;
let totalViolations = 0;
const t0 = performance.now();

for (const [name, fn] of Object.entries(suite)) {
  if (only && name !== only) continue;
  const failures: { seed: number; violations: Violation[] }[] = [];
  for (let i = 0; i < seeds; i++) {
    const seed = base + i * 7919;
    totalRuns++;
    try {
      const violations = fn(seed);
      if (violations.length > 0) failures.push({ seed, violations });
    } catch (err) {
      failures.push({
        seed,
        violations: [{ rule: 'exception', detail: err instanceof Error ? err.message : String(err) }],
      });
    }
  }
  totalViolations += failures.length;
  const status = failures.length === 0 ? 'ok' : `${failures.length}/${seeds} FAILED`;
  console.log(`${name.padEnd(16)} ${status}`);
  for (const f of failures.slice(0, 8)) {
    for (const v of f.violations.slice(0, 3)) {
      console.log(`  seed ${f.seed}: [${v.rule}] ${v.detail}`);
    }
  }
  if (failures.length > 8) console.log(`  … and ${failures.length - 8} more seeds`);
}

const secs = ((performance.now() - t0) / 1000).toFixed(1);
console.log(`\n${totalRuns} runs in ${secs}s — ${totalViolations === 0 ? 'all clean' : `${totalViolations} failing seeds`}`);
process.exit(totalViolations === 0 ? 0 : 1);
