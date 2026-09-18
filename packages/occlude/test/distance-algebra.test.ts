import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { circle, distanceTo, field, initOcclude, polygon, render, sketch, type SketchDef } from '../src/index.js';
import { isolinesOf } from '../src/isolines.js';

/** The pure contourer, over a fixed 100mm square: isolines needs the paper,
 * so the toolkit owns `t.isolines` and a test states the frame itself. */
const env = { bounds: { x: 0, y: 0, w: 100, h: 100 }, len: (l: number | { value: number }) => (typeof l === 'number' ? l : l.value) };
const contour = (f: (x: number, y: number) => number, step = 0.25) => isolinesOf(env as never, f, 0, { step });

beforeAll(async () => {
  await initOcclude(readFileSync(fileURLToPath(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url))));
});

/** The zero contour of a field, as points. */
const zero = (f: (x: number, y: number) => number) => contour(f);

/** Furthest any contour point sits from an expected radius about a centre. */
const radialError = (cs: { pts: [number, number][] }[], cx: number, cy: number, r: number): number => {
  let worst = 0;
  for (const c of cs) for (const [x, y] of c.pts) worst = Math.max(worst, Math.abs(Math.hypot(x - cx, y - cy) - r));
  return worst;
};

describe('shapes as distance fields', () => {
  it('measures a circle exactly, and its contour is the circle', () => {
    const f = field.circle(50, 50, 18);
    expect(f(50, 50)).toBeCloseTo(18, 10);
    expect(f(68, 50)).toBeCloseTo(0, 10);
    expect(f(78, 50)).toBeCloseTo(-10, 10);
    expect(radialError(zero(f), 50, 50, 18)).toBeLessThan(0.05);
  });

  it('agrees with distanceTo over the same circle', () => {
    const exact = field.circle(50, 50, 18);
    const lowered = distanceTo(contour(exact));
    for (const [x, y] of [[50, 50], [60, 50], [50, 62], [75, 75], [30, 40]] as [number, number][]) {
      expect(lowered(x, y)).toBeCloseTo(exact(x, y), 1);
    }
  });

  it('measures a box exactly, inside and past a corner', () => {
    const f = field.box(50, 50, 40, 20);
    expect(f(50, 50)).toBeCloseTo(10, 10);
    expect(f(70, 50)).toBeCloseTo(0, 10);
    expect(f(74, 50)).toBeCloseTo(-4, 10);
    // Past a corner the distance is the corner's, not an edge's. The
    // corner is at [70, 60], so [73, 64] is a 3-4-5 away from it.
    expect(f(73, 64)).toBeCloseTo(-5, 10);
  });

  it('measures a capsule from its segment', () => {
    const f = field.segment(30, 50, 70, 50, 6);
    expect(f(50, 50)).toBeCloseTo(6, 10);
    expect(f(50, 56)).toBeCloseTo(0, 10);
    expect(f(76, 50)).toBeCloseTo(0, 10);
  });

  it('unions by taking the larger value, because inside is positive', () => {
    const a = field.circle(40, 50, 14);
    const b = field.circle(60, 50, 14);
    const u = field.union(a, b);
    expect(u(40, 50)).toBeCloseTo(14, 10);
    expect(u(50, 50)).toBeCloseTo(Math.max(a(50, 50), b(50, 50)), 10);
    // A point inside either one is inside the union.
    expect(u(30, 50)).toBeGreaterThan(0);
    expect(u(70, 50)).toBeGreaterThan(0);
  });

  it('intersects by taking the smaller value', () => {
    const i = field.intersect(field.circle(40, 50, 14), field.circle(60, 50, 14));
    expect(i(50, 50)).toBeGreaterThan(0);
    expect(i(30, 50)).toBeLessThan(0);
    expect(i(70, 50)).toBeLessThan(0);
  });

  it('subtracts a hole, leaving a ring whose contour has two loops', () => {
    const ring = field.subtract(field.circle(50, 50, 25), field.circle(50, 50, 12));
    expect(ring(50, 50)).toBeLessThan(0);
    expect(ring(50, 68)).toBeGreaterThan(0);
    const cs = zero(ring);
    expect(cs.length).toBe(2);
    const radii = cs.map((c) => Math.hypot(c.pts[0][0] - 50, c.pts[0][1] - 50)).sort((x, y) => x - y);
    expect(radii[0]).toBeCloseTo(12, 0);
    expect(radii[1]).toBeCloseTo(25, 0);
  });

  it('blends two shapes into one, where a union leaves two', () => {
    // Two discs with a 2mm gap between their edges.
    const a = field.circle(42, 50, 12);
    const b = field.circle(68, 50, 12);
    // Just apart: the union is two separate loops.
    expect(zero(field.union(a, b)).length).toBe(2);
    // Blended, the fillet joins them into one.
    expect(zero(field.blend(a, b, 9)).length).toBe(1);
    // A blend with no radius is exactly a union.
    expect(field.blend(a, b, 0)(50, 50)).toBeCloseTo(field.union(a, b)(50, 50), 10);
  });

  it('is ordinary geometry once contoured, and draws with occlusion', () => {
    const shape = field.blend(field.circle(40, 50, 16), field.box(62, 50, 26, 14), 8);
    const def: SketchDef = sketch({}, () => [
      polygon(contour(shape, 0.5), { opaque: true }),
      polygon(circle(50, 50, 40)),
    ]);
    const out = render(def, { paper: { w: 100, h: 100 } });
    expect(out.stats.fragments).toBeGreaterThan(0);
    // The opaque blob hides part of the big circle.
    const plain = render(sketch({}, () => polygon(circle(50, 50, 40))), { paper: { w: 100, h: 100 } });
    expect(out.stats.culledContained + out.stats.fragments).not.toBe(plain.stats.fragments);
  });

  it('refuses a field that is not a function, and reads an empty list as the identity', () => {
    expect(() => field.union(undefined as never)).toThrow(/expected a distance field/);
    // A computed list that came out empty must not blow up the sketch.
    const disc = field.circle(50, 50, 10);
    expect(field.subtract(disc)(50, 50)).toBeCloseTo(10, 10);
    expect(field.union()(50, 50)).toBe(-Infinity);
    expect(field.intersect()(50, 50)).toBe(Infinity);
    expect(zero(field.union())).toEqual([]);
  });

  it('blends exactly like a union away from the joint', () => {
    const a = field.circle(42, 50, 12);
    const b = field.circle(68, 50, 12);
    // The obvious polynomial smooth maximum grows the shape by radius/4
    // everywhere on the locus equidistant from both, out to infinity.
    for (const y of [200, 1000, 100000]) {
      expect(field.blend(a, b, 9)(55, y)).toBeCloseTo(field.union(a, b)(55, y), 9);
    }
  });

  it('degrades to a union rather than to nothing on a non-finite input', () => {
    const a = field.circle(50, 50, 10);
    expect(field.blend(a, () => -Infinity, 5)(50, 50)).toBeCloseTo(10, 10);
    expect(field.blend(a, a, Infinity)(50, 50)).toBeCloseTo(10, 10);
  });
});
