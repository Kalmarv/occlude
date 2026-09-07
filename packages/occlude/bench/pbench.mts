// The points vocabulary: scatter (variable-radius Poisson disk), relax and
// settle (Lloyd, with population control), and the derived structures.
// Seeds fixed; medians of 3 unless noted.
import { performance } from 'node:perf_hooks';
import { scatterPoints, liftPoints, type PointsEnv } from '../src/points.js';

const med = (label: string, f: () => unknown, runs = 3) => {
  const ms: number[] = [];
  let n = 0;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const r = f();
    ms.push(performance.now() - t0);
    n = (r as { length?: number })?.length ?? 0;
  }
  ms.sort((a, b) => a - b);
  console.log(label.padEnd(52), ms[ms.length >> 1].toFixed(0).padStart(6), 'ms', `${n ? ` ${n} pts ` : '  '}(${ms.map((v) => v.toFixed(0)).join(', ')})`);
};

// A bare env: a fixed seeded stream and a 200 × 200 drawable in user units,
// so the bench does not depend on paper or sketch state.
let rs = 42;
const env: PointsEnv = {
  rnd: () => ((rs = (rs * 48271) % 2147483647) / 2147483647),
  bounds: { x: 0, y: 0, w: 200, h: 200 },
  len: (l) => (typeof l === 'number' ? l : (l as { value: number }).value),
};
const scatter = (field: (x: number, y: number) => number, opts: { spacing: number; resolution?: number }) =>
  scatterPoints(env, field, opts as never);
const points = (raw: [number, number][], opts: { spacing: number }) => liftPoints(env, raw as never, opts as never);
console.log(`  drawable ${env.bounds.w} × ${env.bounds.h}`);

// a field with structure, so demand varies across the sheet
const tone = (x: number, y: number) => 0.15 + 0.85 * (0.5 + 0.5 * Math.sin(x * 0.09) * Math.cos(y * 0.11));
const flat = () => 1;

for (const [name, field] of [['flat', flat], ['tonal', tone]] as const) {
  for (const sp of [3, 1.5]) {
    let s: ReturnType<typeof scatter> | undefined;
    med(`scatter ${name}, spacing ${sp}`, () => { s = scatter(field, { spacing: sp }); return [...s!]; });
    const base = s!;
    console.log(`  -> ${[...base].length} points`);
    med(`  relax(10) on it`, () => [...base.relax(10)]);
    med(`  settle(10) on it`, () => [...base.settle(10)]);
    med(`  cells()`, () => base.cells());
    med(`  mesh()`, () => base.mesh());
  }
}

// long runs and a fine raster: what a stipple sketch actually asks for
{
  const s = scatter(tone, { spacing: 1.5 });
  med('settle(50), spacing 1.5', () => [...s.settle(50)], 2);
  const fine = scatter(tone, { spacing: 1.5, resolution: 512 });
  med('settle(10), resolution 512', () => [...fine.settle(10)], 2);
}

// degenerate: a field that is zero almost everywhere, one point that the
// population control grows into thousands (simulation growth, not overhead),
// and four hundred points at exactly the same position
{
  med('scatter over a field that is zero almost everywhere', () => [...scatter((x, y) => (Math.hypot(x - 50, y - 50) < 2 ? 1 : 0), { spacing: 1 })]);
  const one = points([[50, 50]], { spacing: 2 });
  med('settle(20) on a single point', () => [...one.settle(20)], 2);
  const dup = points(Array.from({ length: 400 }, () => [50, 50] as [number, number]), { spacing: 2 });
  med('settle(5) on 400 coincident points', () => [...dup.settle(5)], 2);
  med('relax(10) on 400 coincident points', () => [...dup.relax(10)], 2);
}
