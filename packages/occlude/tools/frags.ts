#!/usr/bin/env tsx
/**
 * Fragment probe: render a sketch file (or a `ts live` snippet on stdin)
 * and print the visible fragments per shape — count, and each piece's
 * endpoints — so a visibility question is answered by looking, not by
 * guessing a test's expected number.
 *
 *   pnpm --filter occlude frags <sketch.ts> [--seed N] [--shape K]
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as occlude from '../src/index.js';
import {
  initOcclude, isSketch, render, setPaperHint, setPenLibrary,
  DEFAULT_PENS, paperSize,
} from '../src/index.js';
import { liveExampleToJs } from '../src/docsExamples.js';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const seed = opt('--seed') !== undefined ? Number(opt('--seed')) : undefined;
const only = opt('--shape') !== undefined ? Number(opt('--shape')) : undefined;

const wasmPath = fileURLToPath(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url));
await initOcclude(readFileSync(wasmPath));
setPenLibrary(structuredClone(DEFAULT_PENS));
const size = paperSize({ paper: 'Square20' });
setPaperHint(size.w, size.h);

const src = file ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8');
const js = liveExampleToJs(src);
const module = { exports: {} as Record<string, unknown> };
new Function('require', 'exports', 'module', js)(
  (name: string) => { if (name === 'occlude') return occlude; throw new Error(`only 'occlude' (tried '${name}')`); },
  module.exports, module,
);
const def = module.exports.default;
if (!isSketch(def)) throw new Error('no default sketch export');
// A sketch with no seed of its own reads the url seed at compile time.
if (seed !== undefined) (globalThis as Record<string, unknown>).location = { search: `?seed=${seed}` };
const out = render(def, { paper: 'Square20' });

const byShape = new Map<number, typeof out.frags>();
for (const f of out.frags) {
  if (only !== undefined && f.shape !== only) continue;
  (byShape.get(f.shape) ?? byShape.set(f.shape, []).get(f.shape)!).push(f);
}
const fmt = (n: number) => n.toFixed(2);
for (const [shape, frags] of [...byShape].sort((a, b) => a[0] - b[0])) {
  console.log(`shape ${shape}: ${frags.length} frag(s)`);
  for (const f of frags) {
    const g = f.geom;
    const ends = g.t === 'line'
      ? `(${fmt(g.x0)}, ${fmt(g.y0)}) → (${fmt(g.x1)}, ${fmt(g.y1)})`
      : g.t === 'arc' ? `arc c=(${fmt(g.cx)}, ${fmt(g.cy)}) r=${fmt(g.r)}` : g.t;
    console.log(`  ${g.t.padEnd(6)} ${ends}`);
  }
}
