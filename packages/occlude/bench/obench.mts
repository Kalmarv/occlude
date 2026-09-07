// Heavy occlusion — the thing the engine exists to do, and the one workload
// none of the other harnesses covers. Every row is a scaling series, because
// what matters here is not the absolute time but whether the cost per shape
// stays flat as the stack deepens: an occluder index that degrades turns a
// deep stack quadratic, and a deep stack is what a plotter drawing IS.
//
//   pnpm exec tsx bench/obench.mts        (add --deep for the 800-shape rows)
//
// Seeds fixed; medians of 3.
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as core from 'occlude-core';
import { circle, fill, initOcclude, line, rect, render, setPenLibrary, sketch, type Shape } from '../src/index.js';

await initOcclude(readFileSync(fileURLToPath(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url))));
void core;
// the studio's shared pen library, so the rows can name real pens
try {
  setPenLibrary(JSON.parse(readFileSync(fileURLToPath(new URL('../../occlude-studio/sketches/pens.json', import.meta.url)), 'utf8')));
} catch { /* defaults */ }

const deep = process.argv.includes('--deep');
const med = (label: string, f: () => { frags: number }, runs = 3) => {
  const ms: number[] = [];
  let frags = 0;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    frags = f().frags;
    ms.push(performance.now() - t0);
  }
  ms.sort((a, b) => a - b);
  const t = ms[ms.length >> 1];
  console.log(label.padEnd(50), t.toFixed(0).padStart(6), 'ms', `${String(frags).padStart(8)} frags  ${(t / Math.max(1, frags) * 1000).toFixed(1)} µs/frag  (${ms.map((v) => v.toFixed(0)).join(', ')})`);
};

const run = (build: (t: never) => Shape[]) => {
  const out = render(sketch({ aspect: [1, 1], seed: 4 }, build as never), { paper: 'Square20' });
  return { frags: out.frags.length };
};

// ---- a deep stack of opaque discs: every disc hides everything under it, so
// the shape at the bottom is judged against all the ones above it
for (const n of deep ? [50, 100, 200, 400, 800] : [50, 100, 200, 400]) {
  med(`stack: ${n} opaque discs, each covering a third of the sheet`, () => run((t: never) => {
    const tk = t as unknown as { rnd(a: number, b: number): number; times<T>(n: number, f: (i: number) => T): T[] };
    return tk.times(n, () => circle(tk.rnd(20, 80), tk.rnd(20, 80), 30, { fill: fill('solid'), pen: 'micron-03' }));
  }));
}

// ---- the same discs with NO fill: outlines only, so nothing occludes and the
// index is queried just as often. The gap between this and the row above is
// the cost of occlusion itself, not of having many shapes.
for (const n of deep ? [50, 100, 200, 400, 800] : [50, 100, 200, 400]) {
  med(`no occlusion: ${n} outline discs, same positions`, () => run((t: never) => {
    const tk = t as unknown as { rnd(a: number, b: number): number; times<T>(n: number, f: (i: number) => T): T[] };
    return tk.times(n, () => circle(tk.rnd(20, 80), tk.rnd(20, 80), 30, { pen: 'micron-03' }));
  }));
}

// ---- concentric rings: the case the arc-inside rejection exists for. Every
// ring is entirely inside every larger one, so a naive test is O(n²).
for (const n of deep ? [200, 400, 800] : [200, 400]) {
  med(`concentric: ${n} nested rings, largest last`, () => run((t: never) => {
    const tk = t as unknown as { times<T>(n: number, f: (i: number) => T): T[] };
    return tk.times(n, (i) => circle(50, 50, 2 + (i * 45) / n, { fill: fill('solid'), pen: 'micron-03' }));
  }));
}

// ---- a dense hatched field under one big opaque cover: many small fragments
// against one large occluder, the shape a filled portrait takes
for (const n of deep ? [200, 400, 800] : [200, 400]) {
  med(`cover: ${n} hatched rects under one opaque disc`, () => run((t: never) => {
    const tk = t as unknown as { rnd(a: number, b: number): number; times<T>(n: number, f: (i: number) => T): T[] };
    const under = tk.times(n, () => rect(tk.rnd(5, 85), tk.rnd(5, 85), 10, 10, { fill: fill('hatch'), pen: 'micron-01' }));
    return [...under, circle(50, 50, 35, { fill: fill('solid'), pen: 'micron-03' })];
  }));
}

// ---- the case that favours sorting the whole answer over reading the top of
// it: long lines whose bbox overlaps hundreds of small opaque discs but which
// pass BETWEEN them, so the clip walk never exits early and reads every one.
for (const n of deep ? [200, 400, 800] : [200, 400]) {
  med(`gauntlet: 40 long lines across ${n} small opaque discs`, () => run((t: never) => {
    const tk = t as unknown as { rnd(a: number, b: number): number; times<T>(n: number, f: (i: number) => T): T[] };
    const dots = tk.times(n, () => circle(tk.rnd(5, 95), tk.rnd(5, 95), 1.2, { fill: fill('solid'), pen: 'micron-03' }));
    const over = tk.times(40, (i) => line(0, i * 2.5, 100, i * 2.5 + 1, { pen: 'micron-03' }));
    return [...dots, ...over];
  }));
}

// ---- degenerate: every shape exactly on top of every other
med('coincident: 300 identical opaque discs', () => run((t: never) => {
  const tk = t as unknown as { times<T>(n: number, f: (i: number) => T): T[] };
  return tk.times(300, () => circle(50, 50, 30, { fill: fill('solid'), pen: 'micron-03' }));
}));
