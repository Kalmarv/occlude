// Isolines: sampling a field over a grid and marching it into contours, the
// path every contour sketch and every `clip`-to-a-field takes. Seeds fixed;
// medians of 5 unless a row says otherwise.
//
// Run it two ways and compare — the difference is the harness, not the library:
//   pnpm exec tsx bench/ibench.mts          (source, esbuild adds __name)
//   pnpm build && node bench/ibench.js      (dist, what a sketch actually runs)
import { performance } from 'node:perf_hooks';
import { isolinesOf, type IsoEnv } from '../src/isolines.js';

const med = (label: string, f: () => unknown, runs = 5) => {
  const ms: number[] = [];
  let n = 0;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const r = f();
    ms.push(performance.now() - t0);
    n = Array.isArray(r) ? (Array.isArray(r[0]) ? (r as unknown[][]).reduce((s, c) => s + c.length, 0) : r.length) : 0;
  }
  ms.sort((a, b) => a - b);
  console.log(label.padEnd(56), ms[ms.length >> 1].toFixed(0).padStart(6), 'ms', ` ${String(n).padStart(6)} contours  (${ms.map((v) => v.toFixed(0)).join(', ')})`);
};

const env = (w: number, h: number): IsoEnv => ({ bounds: { x: 0, y: 0, w, h }, len: (l) => (typeof l === 'number' ? l : (l as { mm: number }).mm ?? 1) });

// a field with plenty of structure: sums of sines makes many nested contours
const wavy = (k: number) => (x: number, y: number) =>
  Math.sin(x * k) * Math.cos(y * k) + Math.sin((x + y) * k * 0.5) * 0.6 + Math.cos(x * k * 0.31) * 0.4;
// a smooth radial field: few, long contours
const bowl = (x: number, y: number) => Math.hypot(x - 100, y - 100) / 100;
// a field with a hole of absent samples: cells touching absence emit nothing
const holed = (x: number, y: number) => (Math.hypot(x - 100, y - 100) < 30 ? NaN : Math.sin(x * 0.1) * Math.cos(y * 0.1));

const E = env(200, 200);
const levels9 = [-0.8, -0.6, -0.4, -0.2, 0, 0.2, 0.4, 0.6, 0.8];

med('one level, step 1 (201² grid), wavy', () => isolinesOf(E, wavy(0.1), 0, { step: 1 }));
med('one level, step 0.25 (801² grid), wavy', () => isolinesOf(E, wavy(0.1), 0, { step: 0.25 }), 3);
med('9 levels, step 1 (201² grid), wavy', () => isolinesOf(E, wavy(0.1), levels9, { step: 1 }));
med('9 levels, step 0.25 (801² grid), wavy', () => isolinesOf(E, wavy(0.1), levels9, { step: 0.25 }), 3);
med('9 levels, step 1, close: true', () => isolinesOf(E, wavy(0.1), levels9, { step: 1, close: true }));
med('20 levels, step 1, smooth bowl (few long contours)', () => isolinesOf(E, bowl, Array.from({ length: 20 }, (_, i) => i / 20), { step: 1 }));
med('9 levels, step 1, a hole of absent samples', () => isolinesOf(E, holed, levels9, { step: 1 }));
med('one level, dense field (k = 0.6), step 0.5', () => isolinesOf(E, wavy(0.6), 0, { step: 0.5 }), 3);

// demanding: a fine grid and many levels at once
med('40 levels, step 0.5 (401² grid), wavy', () => isolinesOf(E, wavy(0.1), Array.from({ length: 40 }, (_, i) => -0.9 + (i * 1.8) / 40), { step: 0.5 }), 3);
med('one level, step 0.1 (2001² grid = 4M samples)', () => isolinesOf(E, wavy(0.05), 0, { step: 0.1 }), 3);
// degenerate: a constant field (no crossings at all) and a field that is all absent
med('constant field, step 0.25 (no crossings)', () => isolinesOf(E, () => 1, 0, { step: 0.25 }), 3);
med('all-absent field, step 0.25', () => isolinesOf(E, () => NaN, 0, { step: 0.25 }), 3);

// ---- streamlines: the other field → geometry path (RK4 tracing + separation)
import { streamlinesOf } from '../src/streamlines.js';

const swirl = (x: number, y: number): [number, number] => {
  const dx = x - 100;
  const dy = y - 100;
  return [-dy + dx * 0.15, dx + dy * 0.15];
};
const noisy = (x: number, y: number): [number, number] => {
  const a = Math.sin(x * 0.04) * 2 + Math.cos(y * 0.05) * 2;
  return [Math.cos(a), Math.sin(a)];
};
// a field that gives out over a disc: tracing stops mid-line, often
const holey = (x: number, y: number): [number, number] =>
  (Math.hypot(x - 100, y - 100) < 25 ? [NaN, NaN] : swirl(x, y));

console.log('');
med('streamlines: swirl, spacing 3', () => streamlinesOf(E, swirl, { spacing: 3 }), 3);
med('streamlines: swirl, spacing 1', () => streamlinesOf(E, swirl, { spacing: 1 }), 3);
med('streamlines: noisy, spacing 2', () => streamlinesOf(E, noisy, { spacing: 2 }), 3);
med('streamlines: noisy, spacing 0.6 (dense)', () => streamlinesOf(E, noisy, { spacing: 0.6 }), 3);
med('streamlines: variable spacing, noisy', () => streamlinesOf(E, noisy, { spacing: (x: number) => 0.8 + (x / 200) * 4 }), 3);
med('streamlines: a field that gives out over a disc', () => streamlinesOf(E, holey, { spacing: 2 }), 3);
med('streamlines: fine step, spacing 2', () => streamlinesOf(E, noisy, { spacing: 2, step: 0.1 }), 3);
