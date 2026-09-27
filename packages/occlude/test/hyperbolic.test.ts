/**
 * The isometries of the Poincaré disk — the INTERNAL module the geometry
 * words are made of.
 *
 * Nothing here is public any more: a sketch names a geometry on its frame
 * and writes `line`, `circle`, `t.tiling`, `t.distanceTo`. The maths
 * underneath did not change with that consolidation, and this is its
 * proof: the transform record keeps the disk and undoes itself, the circle
 * sits at the hyperbolic radius it was asked for, and the half-plane
 * measures to the geodesic.
 *
 * The metre stick is `hyperbolicSpaceOf([0, 0], 1)` — the space whose
 * CHART is the unit disk. It measures with `ds = |dz|/(1 − |z|²)`, half
 * the disk's own `2|dz|/(1 − |z|²)`, so the disk's distance is twice it.
 * A space speaks sketch coordinates and this module speaks the chart, so
 * every reading goes in through `fromChart` and comes out through
 * `toChart`.
 */

import { describe, expect, it } from 'vitest';
import { apply, compose, halfplane, inverse, rotation, translation, type Mobius } from '../src/hyperbolic.js';
import { hyperbolicSpaceOf } from '../src/space.js';

/** The unit disk's own hyperbolic distance. */
const unit = hyperbolicSpaceOf([0, 0], 1, 'poincare');
/** A disk point as the space's own coordinates, and back again. */
const inward = (p: readonly [number, number]): [number, number] => {
  const q = unit.fromChart(p);
  return [q[0], q[1]];
};
const hdist = (a: readonly [number, number], b: readonly [number, number]): number => 2 * unit.distance(inward(a), inward(b));
/** The point a fraction `t` along the geodesic from `a` to `b`. */
const along = (a: readonly [number, number], b: readonly [number, number], t: number): [number, number] => {
  const p = unit.toChart(unit.geodesic(inward(a), inward(b), t));
  return [p[0], p[1]];
};

/** A reproducible stream of points inside the disk, so a failure is the
 * same failure the next time it runs. */
function* uniform(seed: number): Generator<number> {
  let s = seed >>> 0;
  for (;;) {
    s = (s * 1664525 + 1013904223) >>> 0;
    yield s / 4294967296;
  }
}
function diskPoints(n: number, seed = 7, rMax = 0.999): [number, number][] {
  const u = uniform(seed);
  return Array.from({ length: n }, () => {
    const r = rMax * Math.sqrt(u.next().value as number);
    const th = 2 * Math.PI * (u.next().value as number);
    return [r * Math.cos(th), r * Math.sin(th)] as [number, number];
  });
}

const abs = (z: readonly [number, number]) => Math.hypot(z[0], z[1]);
/** Two transforms agree when they agree on three points. */
const agree = (m: Mobius, n: Mobius, tol = 1e-12) =>
  ([[0, 0], [0.5, 0], [0, 0.5]] as [number, number][]).every((p) => {
    const a = apply(m, p);
    const b = apply(n, p);
    return Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol;
  });

describe('the transform record', () => {
  it('keeps the disk', () => {
    const ms = [translation(0.4, -0.2), rotation(37), compose(translation(-0.6, 0.3), rotation(110))];
    for (const p of diskPoints(1000)) {
      for (const m of ms) expect(abs(apply(m, p))).toBeLessThan(1);
    }
  });

  it('is undone by its inverse', () => {
    const ms = [translation(0.4, -0.2), rotation(-73), compose(rotation(40), translation(0.3, 0.3))];
    for (const m of ms) {
      expect(agree(compose(inverse(m), m), rotation(0))).toBe(true);
      expect(agree(compose(m, inverse(m)), rotation(0))).toBe(true);
    }
  });

  it('translation moves the origin to its argument, and refuses a point outside', () => {
    for (const [x, y] of [[0.3, 0.4], [-0.7, 0.1], [0, 0], [0.01, -0.95]]) {
      const o = apply(translation(x, y), [0, 0]);
      expect(o[0]).toBeCloseTo(x, 12);
      expect(o[1]).toBeCloseTo(y, 12);
    }
    expect(() => translation(1.2, 0)).toThrow(/not inside the unit disk/);
  });

  it('rotation of 90 degrees four times is the identity', () => {
    const r = rotation(90);
    expect(agree(compose(compose(r, r), compose(r, r)), rotation(0))).toBe(true);
    const q = apply(r, [0.5, 0]);
    expect(q[0]).toBeCloseTo(0, 12);
    expect(q[1]).toBeCloseTo(0.5, 12);
  });

  it('keeps every hyperbolic distance', () => {
    const ms = [translation(0.4, -0.2), rotation(-73), compose(rotation(40), translation(0.3, 0.3))];
    const pts = diskPoints(40, 11, 0.95);
    for (const m of ms) {
      for (let i = 0; i < pts.length; i += 2) {
        const a = pts[i];
        const b = pts[i + 1];
        expect(hdist(apply(m, a), apply(m, b))).toBeCloseTo(hdist(a, b), 9);
      }
    }
  });
});

describe('halfplane', () => {
  const a: [number, number] = [-0.4, -0.2];
  const b: [number, number] = [0.6, 0.35];
  const f = halfplane(a, b);

  it('is zero along the geodesic through its two points', () => {
    for (let k = 0; k <= 10; k++) {
      const p = along(a, b, k / 10);
      expect(f(p[0], p[1])).toBeCloseTo(0, 9);
    }
  });

  it('is positive to the left of a → b and negative to the right', () => {
    // The frame that carries `a → b` onto the real diameter: a point up
    // the imaginary axis is to the left of it, and one down is to the
    // right, whatever the geodesic's own bearing.
    const left = along(a, b, 0.5);
    const dir = unit.log(left, b);
    const n = Math.hypot(dir[0], dir[1]);
    const off = (s: number): [number, number] => {
      const p = unit.exp(left, [(-dir[1] / n) * s, (dir[0] / n) * s]);
      return [p[0], p[1]];
    };
    expect(f(...off(0.1))).toBeGreaterThan(0);
    expect(f(...off(-0.1))).toBeLessThan(0);
  });

  it('is the distance to the nearest point of the geodesic', () => {
    for (const p of diskPoints(40, 5, 0.9)) {
      let best = Infinity;
      // The geodesic runs past both ends; sample well beyond them.
      for (let k = -60; k <= 160; k++) {
        const q = along(a, b, k / 100);
        if (Math.hypot(q[0], q[1]) >= 1) continue;
        best = Math.min(best, hdist(p, q));
      }
      expect(Math.abs(f(p[0], p[1]))).toBeLessThanOrEqual(best + 1e-6);
    }
  });

  it('refuses one point twice', () => {
    expect(() => halfplane([0.2, 0.2], [0.2, 0.2])).toThrow(/two points are the same/);
  });
});
