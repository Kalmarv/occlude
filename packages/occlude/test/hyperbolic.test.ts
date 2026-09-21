import { describe, expect, it } from 'vitest';
import { hyperbolic, type Mobius } from '../src/index.js';

const { mobius, translation, rotation, reflection, apply, compose, inverse, distance, geodesic, circle, polygon, tiling } = hyperbolic;

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

describe('mobius', () => {
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

  it('translation moves the origin to its argument', () => {
    for (const [x, y] of [[0.3, 0.4], [-0.7, 0.1], [0, 0], [0.01, -0.95]]) {
      const o = apply(translation(x, y), [0, 0]);
      expect(o[0]).toBeCloseTo(x, 12);
      expect(o[1]).toBeCloseTo(y, 12);
    }
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
  });

  it('a reflection fixes the geodesic it is taken in', () => {
    for (const [a, b] of [[[0.2, 0.1], [-0.3, 0.6]], [[0.3, 0.3], [-0.3, -0.3]]] as [number, number][][]) {
      const r = reflection(a, b);
      for (const p of geodesic(a, b, { count: 8 })) {
        const q = apply(r, p);
        expect(Math.hypot(q[0] - p[0], q[1] - p[1])).toBeLessThan(1e-9);
      }
    }
  });

  it('builds from four coefficients, and refuses what does not keep the disk', () => {
    const k = 1 / Math.sqrt(1 - 0.25);
    const m = mobius([k, 0], [0.5 * k, 0], [0.5 * k, 0], [k, 0]);
    expect(agree(m, translation(0.5, 0))).toBe(true);
    // The same map, scaled: normalisation takes both to one record.
    expect(agree(mobius([3 * k, 0], [1.5 * k, 0], [1.5 * k, 0], [3 * k, 0]), translation(0.5, 0))).toBe(true);
    expect(() => mobius([1, 0], [2, 0], [0, 0], [1, 0])).toThrow(/does not send the unit disk to itself/);
    expect(() => mobius([1, 0], [1, 0], [1, 0], [1, 0])).toThrow(/degenerate/);
    expect(() => translation(1.2, 0)).toThrow(/not inside the unit disk/);
  });
});

describe('distance', () => {
  const pts = diskPoints(60, 11, 0.95);

  it('is symmetric and zero on equal points', () => {
    for (const p of pts) expect(distance(p, p)).toBeCloseTo(0, 12);
    for (let i = 0; i + 1 < pts.length; i++) {
      expect(distance(pts[i], pts[i + 1])).toBeCloseTo(distance(pts[i + 1], pts[i]), 12);
    }
  });

  it('is invariant under every transform', () => {
    const ms = [translation(0.4, -0.2), rotation(37), reflection([0.2, 0.1], [-0.3, 0.6]), compose(translation(-0.6, 0.3), rotation(110))];
    for (const m of ms) {
      for (let i = 0; i + 1 < pts.length; i++) {
        const [a, b] = [pts[i], pts[i + 1]];
        expect(distance(apply(m, a), apply(m, b))).toBeCloseTo(distance(a, b), 9);
      }
    }
  });

  it('obeys the triangle inequality', () => {
    for (let i = 0; i + 2 < pts.length; i++) {
      const [a, b, c] = [pts[i], pts[i + 1], pts[i + 2]];
      expect(distance(a, c)).toBeLessThanOrEqual(distance(a, b) + distance(b, c) + 1e-9);
    }
  });
});

describe('geodesic', () => {
  it('through the origin is straight', () => {
    const pts = geodesic([-0.6, -0.3], [0.4, 0.2], { count: 10 });
    expect(pts).toHaveLength(11);
    for (const p of pts) expect(Math.abs(p[0] * 0.2 - p[1] * 0.4)).toBeLessThan(1e-12);
  });

  it('off the origin rides a circle orthogonal to the rim, and ends where it was asked to', () => {
    const [a, b] = [[0.7, 0.1], [-0.1, 0.75]] as [number, number][];
    const pts = geodesic(a, b, { count: 32 });
    expect(pts[0]).toEqual(a);
    expect(pts[pts.length - 1]).toEqual(b);
    // Fit the circle through three of the samples, then check |c|² = r² + 1.
    const [p0, p1, p2] = [pts[0], pts[16], pts[32]];
    const d = 2 * (p0[0] * (p1[1] - p2[1]) + p1[0] * (p2[1] - p0[1]) + p2[0] * (p0[1] - p1[1]));
    const n0 = p0[0] ** 2 + p0[1] ** 2;
    const n1 = p1[0] ** 2 + p1[1] ** 2;
    const n2 = p2[0] ** 2 + p2[1] ** 2;
    const cx = (n0 * (p1[1] - p2[1]) + n1 * (p2[1] - p0[1]) + n2 * (p0[1] - p1[1])) / d;
    const cy = (n0 * (p2[0] - p1[0]) + n1 * (p0[0] - p2[0]) + n2 * (p1[0] - p0[0])) / d;
    const r2 = (p0[0] - cx) ** 2 + (p0[1] - cy) ** 2;
    expect(cx * cx + cy * cy).toBeCloseTo(r2 + 1, 9);
    // Every sample is on that circle, and inside the disk.
    for (const p of pts) {
      expect(Math.hypot(p[0] - cx, p[1] - cy)).toBeCloseTo(Math.sqrt(r2), 9);
      expect(Math.hypot(p[0], p[1])).toBeLessThan(1);
    }
  });

  it('is the shortest way: every sample splits the distance exactly', () => {
    for (const [a, b] of [[[0.7, 0.1], [-0.1, 0.75]], [[-0.6, -0.3], [0.4, 0.2]], [[0.05, 0.02], [0.93, 0.1]]] as [number, number][][]) {
      const total = distance(a, b);
      for (const p of geodesic(a, b, { count: 20 })) {
        expect(distance(a, p) + distance(p, b)).toBeCloseTo(total, 6);
      }
    }
  });
});

describe('circle', () => {
  it('holds every sample at the hyperbolic radius asked for', () => {
    for (const [centre, r] of [[[0, 0], 1], [[0.5, -0.2], 0.8], [[-0.7, 0.3], 2.4]] as [[number, number], number][]) {
      const loop = circle(centre, r, { count: 48 });
      expect(loop).toHaveLength(48);
      for (const p of loop) expect(distance(centre, p)).toBeCloseTo(r, 9);
    }
  });

  it('is a Euclidean circle whose centre is not the hyperbolic one', () => {
    const centre: [number, number] = [0.6, 0];
    const loop = circle(centre, 1.1, { count: 64 });
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
    expect(cx).toBeLessThan(centre[0] - 0.05);
    expect(circle(centre, 0)).toEqual([]);
  });
});

describe('polygon', () => {
  it('is regular, and its corners carry the {p, q} angle', () => {
    const p = polygon(7, 3);
    expect(p).toHaveLength(7);
    const R = distance([0, 0], p[0]);
    for (const v of p) expect(distance([0, 0], v)).toBeCloseTo(R, 12);
    // The interior angle, measured between the two geodesics at a corner.
    const at = (i: number) => {
      const v = p[i];
      const back = inverse(translation(v[0], v[1]));
      const dir = (w: readonly [number, number]) => {
        const g = geodesic(v, w, { count: 8 })[1];
        const q = apply(back, g);
        return Math.atan2(q[1], q[0]);
      };
      let a = dir(p[(i + 1) % 7]) - dir(p[(i + 6) % 7]);
      while (a < 0) a += 2 * Math.PI;
      return Math.min(a, 2 * Math.PI - a);
    };
    for (let i = 0; i < 7; i++) expect(at(i)).toBeCloseTo((2 * Math.PI) / 3, 6);
  });

  it('refuses the Euclidean and spherical pairs by name', () => {
    expect(() => polygon(4, 4)).toThrow(/not a hyperbolic tiling/);
    expect(() => polygon(3, 6)).toThrow(/not a hyperbolic tiling/);
    expect(() => polygon(2, 9)).toThrow(/whole numbers of 3 or more/);
  });
});

describe('tiling', () => {
  it('puts the identity first and one placement on each copy', () => {
    const ms = tiling(7, 3, { depth: 3 });
    expect(agree(ms[0], rotation(0))).toBe(true);
    const centres = ms.map((m) => apply(m, [0, 0]));
    for (let i = 0; i < centres.length; i++) {
      for (let j = i + 1; j < centres.length; j++) {
        expect(Math.hypot(centres[i][0] - centres[j][0], centres[i][1] - centres[j][1])).toBeGreaterThan(1e-6);
      }
    }
  });

  it('keeps every copy of the fundamental polygon inside the disk', () => {
    const verts = polygon(7, 3);
    for (const m of tiling(7, 3, { depth: 3 })) {
      for (const v of verts) expect(abs(apply(m, v))).toBeLessThan(1);
    }
  });

  it('grows the way the {7, 3} tiling grows', () => {
    // The centre, then a ring per generation. Every tile has seven edges;
    // a tile in ring n shares some of them with tiles already counted, so
    // the ring counts are 7, 21, 56, 147 — each ring about 2.6 times the
    // one before, which is the tiling's growth rate.
    const counts = [0, 1, 2, 3, 4].map((depth) => tiling(7, 3, { depth }).length);
    expect(counts).toEqual([1, 8, 29, 85, 232]);
    expect(tiling(7, 3)).toHaveLength(85); // the default depth is 3
    expect(tiling(5, 4, { depth: 1 })).toHaveLength(6);
    expect(tiling(8, 3, { depth: 1 })).toHaveLength(9);
  });

  it('refuses a pair that is not hyperbolic', () => {
    expect(() => tiling(6, 3, { depth: 1 })).toThrow(/not a hyperbolic tiling/);
  });
});
