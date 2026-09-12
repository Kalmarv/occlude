// The points vocabulary: scatter (variable-radius Poisson disk), relax and
// settle (Lloyd, with population control), Voronoi construction and face
// measurement — the standard path and the custom-rule ingredients.
// Seeds fixed; medians of 3 unless noted.
import { performance } from 'node:perf_hooks';
import { scatterPoints, relaxMaterial, settleMaterial, type PointsEnv } from '../src/points.js';
import { voronoiOf } from '../src/voronoi.js';
import { material, type Material } from '../src/index.js';

const med = (label: string, f: () => unknown, runs = 3) => {
  const ms: number[] = [];
  let n = 0;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const r = f();
    ms.push(performance.now() - t0);
    n = (r as { n?: number })?.n ?? (r as { length?: number })?.length ?? 0;
  }
  ms.sort((a, b) => a - b);
  console.log(label.padEnd(56), ms[ms.length >> 1].toFixed(0).padStart(6), 'ms', `${n ? ` ${n} ` : '  '}(${ms.map((v) => v.toFixed(0)).join(', ')})`);
};

// A bare env: a fixed seeded stream and a 200 × 200 drawable in user units,
// so the bench does not depend on paper or sketch state.
let rs = 42;
const env: PointsEnv = {
  rnd: () => ((rs = (rs * 48271) % 2147483647) / 2147483647),
  bounds: { x: 0, y: 0, w: 200, h: 200 },
  len: (l) => (typeof l === 'number' ? l : (l as { value: number }).value),
};
const scatter = (field: (x: number, y: number) => number, spacing: number) => scatterPoints(env, field, { spacing });
console.log(`  drawable ${env.bounds.w} × ${env.bounds.h}`);

// a field with structure, so demand varies across the sheet
const tone = (x: number, y: number) => 0.15 + 0.85 * (0.5 + 0.5 * Math.sin(x * 0.09) * Math.cos(y * 0.11));
const flat = () => 1;

for (const [name, field] of [['flat', flat], ['tonal', tone]] as const) {
  for (const sp of [3, 1.5]) {
    let s: Material | undefined;
    med(`scatter ${name}, spacing ${sp}`, () => (s = scatter(field, sp)));
    const base = s!;
    med(`  relax 10 rounds`, () => relaxMaterial(env, base, { iterations: 10, density: field }));
    med(`  settle 10 rounds (standard recipe)`, () => settleMaterial(env, base, { iterations: 10, density: field, spacing: sp }));
    med(`  voronoi (material with shared walls)`, () => voronoiOf(base, env.bounds));
    const cells = voronoiOf(base, env.bounds);
    med(`  faces().measure(field) over those cells`, () => cells.faces().measure(field, { bounds: env.bounds }));
    // The custom path: one round of "move to the weighted centroid" written
    // with the public ingredients, against the kernel's round.
    med(`  custom round: voronoi + measure + move`, () =>
      base.steps(1, (cur, next) => {
        const c = voronoiOf(cur, env.bounds);
        const m = c.faces().measure(field, { bounds: env.bounds });
        next.move(cur.points, (p) => {
          const f = c.cellOf(p);
          const w = f ? m.forFace(f).weightedCentroid : null;
          return w ? [w[0] - p.x, w[1] - p.y] : [0, 0];
        });
      }));
  }
}

// long runs and a fine raster: what a stipple sketch actually asks for
{
  const s = scatter(tone, 1.5);
  med('settle 50 rounds, spacing 1.5', () => settleMaterial(env, s, { iterations: 50, density: tone, spacing: 1.5 }), 2);
  med('settle 10 rounds, resolution 512', () => settleMaterial(env, s, { iterations: 10, density: tone, spacing: 1.5, resolution: 512 }), 2);
}

// degenerate: a field that is zero almost everywhere, one point that the
// population control grows into thousands, and four hundred coincident points
{
  med('scatter over a field that is zero almost everywhere', () => scatter((x, y) => (Math.hypot(x - 50, y - 50) < 2 ? 1 : 0), 1));
  const one = material([[50, 50]]);
  med('settle 20 rounds from a single point', () => settleMaterial(env, one, { iterations: 20, density: tone, spacing: 2 }), 2);
  const dup = material(Array.from({ length: 400 }, () => [50, 50] as [number, number]));
  med('settle 5 rounds on 400 coincident points', () => settleMaterial(env, dup, { iterations: 5, density: tone, spacing: 2 }), 2);
  med('relax 10 rounds on 400 coincident points', () => relaxMaterial(env, dup, { iterations: 10, density: tone }), 2);
  med('voronoi of 400 coincident points', () => voronoiOf(dup, env.bounds), 2);
}
