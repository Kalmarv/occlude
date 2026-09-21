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
 * chart IS the unit disk. It measures with `ds = |dz|/(1 − |z|²)`, half
 * the disk's own `2|dz|/(1 − |z|²)`, so the disk's distance is twice it.
 */

import { describe, expect, it } from 'vitest';
import { apply, circle, compose, halfplane, inverse, reflection, rotation, translation, type Mobius } from '../src/hyperbolic.js';
import { hyperbolicSpaceOf } from '../src/space.js';

/** The unit disk's own hyperbolic distance. */
const unit = hyperbolicSpaceOf([0, 0], 1, 'poincare');
const hdist = (a: readonly [number, number], b: readonly [number, number]): number => 2 * unit.distance(a, b);
/** The point a fraction `t` along the geodesic from `a` to `b`. */
const along = (a: readonly [number, number], b: readonly [number, number], t: number): [number, number] => {
  const p = unit.geodesic(a, b, t);
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
    const ms = [translation(0.4, -0.2), rotation(37), compose(translation(-0.6, 0.3), rotation(110)), reflection([0.2, 0.1], [-0.3, 0.6])];
    for (const p of diskPoints(1000)) {
      for (const m of ms) expect(abs(apply(m, p))).toBeLessThan(1);
    }
  });

  it('is undone by its inverse', () => {
    const ms = [translation(0.4, -0.2), rotation(-73), reflection([0.2, 0.1], [-0.3, 0.6]), compose(reflection([0.1, 0], [0.5, 0.5]), translation(0.3, 0.3))];
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

  it('a reflection turns the disk over and is its own inverse', () => {
    const r = reflection([0.2, 0.1], [-0.3, 0.6]);
    expect(r.mirror).toBe(true);
    expect(agree(compose(r, r), rotation(0))).toBe(true);
    // Two reflections make a Möbius transform, which does not.
    expect(compose(r, reflection([0.4, -0.2], [0, 0.5])).mirror).toBe(false);
    expect(() => reflection([0.2, 0.1], [0.2, 0.1])).toThrow(/two points are the same/);
  });

  it('a reflection fixes the geodesic it is taken in', () => {
    for (const [a, b] of [[[0.2, 0.1], [-0.3, 0.6]], [[0.3, 0.3], [-0.3, -0.3]]] as [number, number][][]) {
      const r = reflection(a, b);
      for (let k = 0; k <= 8; k++) {
        const p = along(a, b, k / 8);
        const q = apply(r, p);
        expect(Math.hypot(q[0] - p[0], q[1] - p[1])).toBeLessThan(1e-9);
      }
    }
  });

  it('keeps every hyperbolic distance', () => {
    const ms = [translation(0.4, -0.2), rotation(-73), reflection([0.2, 0.1], [-0.3, 0.6]), compose(reflection([0.1, 0], [0.5, 0.5]), translation(0.3, 0.3))];
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

describe('circle', () => {
  it('holds every sample at the hyperbolic radius asked for', () => {
    for (const c of [[0, 0], [0.5, 0.2], [-0.8, 0.1]] as [number, number][]) {
      for (const r of [0.2, 1, 3]) {
        for (const p of circle(c, r, { count: 24 })) expect(hdist(c, p)).toBeCloseTo(r, 9);
      }
    }
  });

  it('is a Euclidean circle whose centre is not the hyperbolic one', () => {
    const c: [number, number] = [0.6, 0];
    const loop = circle(c, 1.1, { count: 64 });
    // Fit a circle through three of the samples, then hold the rest to it.
    const [p0, p1, p2] = [loop[0], loop[21], loop[42]];
    const d = 2 * (p0[0] * (p1[1] - p2[1]) + p1[0] * (p2[1] - p0[1]) + p2[0] * (p0[1] - p1[1]));
    const n = (p: readonly number[]) => p[0] ** 2 + p[1] ** 2;
    const cx = (n(p0) * (p1[1] - p2[1]) + n(p1) * (p2[1] - p0[1]) + n(p2) * (p0[1] - p1[1])) / d;
    const cy = (n(p0) * (p2[0] - p1[0]) + n(p1) * (p0[0] - p2[0]) + n(p2) * (p1[0] - p0[0])) / d;
    const r = Math.hypot(p0[0] - cx, p0[1] - cy);
    for (const p of loop) expect(Math.hypot(p[0] - cx, p[1] - cy)).toBeCloseTo(r, 9);
    // The hyperbolic centre sits nearer the rim than the Euclidean one:
    // that shift is the whole point of the picture.
    expect(cy).toBeCloseTo(0, 9);
    expect(cx).toBeLessThan(c[0] - 0.05);
  });

  it('draws nothing for a radius or a count that holds no loop', () => {
    expect(circle([0, 0], 0)).toEqual([]);
    expect(circle([0, 0], -1)).toEqual([]);
    expect(circle([0, 0], 1, { count: 2 })).toEqual([]);
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
