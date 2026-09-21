import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hyperbolic, initOcclude, render, sketch, strokes, type Material, type Mobius } from '../src/index.js';

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

// ---- the metric as fields -------------------------------------------------

const { field, density, equidistants } = hyperbolic;

/** The nearest point of a densely sampled geodesic, in hyperbolic distance
 * — the slow, obvious answer `field.halfplane` has a formula for. */
const bruteToGeodesic = (a: [number, number], b: [number, number], p: [number, number]): number => {
  let best = Infinity;
  for (const s of geodesic(a, b, { count: 20000 })) best = Math.min(best, distance(p, s));
  return best;
};

describe('field.disc', () => {
  it('is zero on the hyperbolic circle of the same centre and radius', () => {
    for (const [c, r] of [[[0, 0], 0.9], [[0.2, -0.1], 0.8], [[-0.6, 0.35], 1.7]] as [[number, number], number][]) {
      const f = field.disc(c, r);
      for (const p of circle(c, r, { count: 240 })) expect(f(p[0], p[1])).toBeCloseTo(0, 9);
    }
  });

  it('is the radius at the centre and falls away from it', () => {
    const f = field.disc([0.2, -0.1], 0.8);
    expect(f(0.2, -0.1)).toBeCloseTo(0.8, 12);
    expect(f(0.9, 0.3)).toBeLessThan(0);
    // The value is the radius less the hyperbolic distance, everywhere.
    for (const p of diskPoints(200, 11, 0.95)) {
      expect(f(p[0], p[1])).toBeCloseTo(0.8 - distance([0.2, -0.1], p), 12);
    }
  });

  it('moves with the disc under a transform', () => {
    const m = compose(translation(0.3, 0.2), rotation(41));
    const f = field.disc([0.2, -0.1], 0.8);
    const g = field.disc(apply(m, [0.2, -0.1]), 0.8);
    for (const p of diskPoints(300, 13, 0.95)) {
      const q = apply(m, p);
      expect(g(q[0], q[1])).toBeCloseTo(f(p[0], p[1]), 9);
    }
  });

  it('is NaN outside the disk, and on the rim', () => {
    const f = field.disc([0, 0], 0.5);
    for (const [x, y] of [[1, 0], [0, -1], [1.4, 0.2], [-3, 5]]) expect(f(x, y)).toBeNaN();
  });
});

describe('field.halfplane', () => {
  const a: [number, number] = [-0.5, -0.3];
  const b: [number, number] = [0.6, 0.4];

  it('is zero along the geodesic through its two points', () => {
    const f = field.halfplane(a, b);
    for (const p of geodesic(a, b, { count: 400 })) expect(f(p[0], p[1])).toBeCloseTo(0, 9);
  });

  it('is positive to the left of a → b and negative to the right', () => {
    const f = field.halfplane(a, b);
    const g = field.halfplane(b, a);
    for (const p of diskPoints(300, 17, 0.95)) {
      const v = f(p[0], p[1]);
      expect(g(p[0], p[1])).toBeCloseTo(-v, 9);
      // The left of a → b is where the mid-point's own left-hand normal
      // points; a turn of a quarter circle names it.
      const mid = geodesic(a, b, { count: 2 })[1];
      const side = (p[0] - mid[0]) * (b[1] - a[1]) - (p[1] - mid[1]) * (b[0] - a[0]);
      if (Math.abs(v) > 0.4) expect(Math.sign(v)).toBe(-Math.sign(side));
    }
  });

  it('is the distance to the nearest point of the geodesic', () => {
    const f = field.halfplane(a, b);
    // Points whose nearest geodesic point is well inside the sampled
    // segment, so the dense walk measures the same thing the formula does.
    for (const p of diskPoints(24, 19, 0.5)) {
      expect(Math.abs(f(p[0], p[1]))).toBeCloseTo(bruteToGeodesic(a, b, p), 6);
    }
  });

  it('is NaN outside the disk and refuses one point twice', () => {
    expect(field.halfplane(a, b)(1.2, 0)).toBeNaN();
    expect(() => field.halfplane(a, a)).toThrow(/the same/);
  });
});

describe('field.points', () => {
  it('is the hyperbolic distance to the nearest of the set', () => {
    const set = diskPoints(12, 23, 0.8);
    const f = field.points(set);
    for (const p of diskPoints(300, 29, 0.95)) {
      const best = Math.min(...set.map((s) => distance(s, p)));
      expect(f(p[0], p[1])).toBeCloseTo(best, 9);
    }
    for (const s of set) expect(f(s[0], s[1])).toBeCloseTo(0, 9);
  });

  it('answers Infinity for an empty set, and NaN outside the disk', () => {
    expect(field.points([])(0, 0)).toBe(Infinity);
    expect(field.points([[0, 0]])(1, 0)).toBeNaN();
  });
});

describe('field.cell', () => {
  it('is the inradius at the origin and zero at every edge mid-point', () => {
    const f = field.cell(7, 3);
    // `arccosh(cos(π/q)/sin(π/p))` is the inradius of the {p, q} polygon.
    expect(f(0, 0)).toBeCloseTo(Math.acosh(Math.cos(Math.PI / 3) / Math.sin(Math.PI / 7)), 12);
    const verts = polygon(7, 3);
    for (let i = 0; i < 7; i++) {
      const mid = geodesic(verts[i], verts[(i + 1) % 7], { count: 2 })[1];
      expect(f(mid[0], mid[1])).toBeCloseTo(0, 9);
      expect(f(verts[i][0], verts[i][1])).toBeCloseTo(0, 9);
    }
  });

  it('is negative at a vertex folded over an edge it does not touch', () => {
    const f = field.cell(7, 3);
    const verts = polygon(7, 3);
    for (let i = 0; i < 7; i++) {
      const fold = reflection(verts[i], verts[(i + 1) % 7]);
      for (const j of [i + 2, i + 3, i + 4, i + 5]) {
        const img = apply(fold, verts[j % 7]);
        expect(f(img[0], img[1])).toBeLessThan(0);
      }
    }
  });

  it('is NaN outside the disk and refuses a pair that is not hyperbolic', () => {
    expect(field.cell(7, 3)(1.5, 0)).toBeNaN();
    expect(() => field.cell(6, 3)).toThrow(/not a hyperbolic tiling/);
  });
});

describe('density', () => {
  it('is 4 at the origin and grows without bound toward the rim', () => {
    const d = density();
    expect(d(0, 0)).toBe(4);
    let last = 4;
    for (const r of [0.5, 0.9, 0.99, 0.9999]) {
      const v = d(r, 0);
      expect(v).toBeGreaterThan(last);
      last = v;
    }
    expect(last).toBeGreaterThan(1e8);
    for (const [x, y] of [[1, 0], [0, 1], [2, 2]]) expect(d(x, y)).toBeNaN();
  });

  it('integrates to the hyperbolic area of a hyperbolic disc', () => {
    // `4π sinh²(r/2)` is the area of a hyperbolic disc of radius r. The
    // quadrature is a midpoint rule over the Euclidean square the disc
    // sits in, with the density weighting each cell.
    const d = density();
    for (const [center, r] of [[[0, 0], 0.7], [[0.35, -0.2], 0.9]] as [[number, number], number][]) {
      const inside = field.disc(center, r);
      const loop = circle(center, r, { count: 720 });
      const x0 = Math.min(...loop.map((p) => p[0]));
      const x1 = Math.max(...loop.map((p) => p[0]));
      const y0 = Math.min(...loop.map((p) => p[1]));
      const y1 = Math.max(...loop.map((p) => p[1]));
      const n = 1200;
      const dx = (x1 - x0) / n;
      const dy = (y1 - y0) / n;
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const x = x0 + (i + 0.5) * dx;
        for (let j = 0; j < n; j++) {
          const y = y0 + (j + 0.5) * dy;
          if (inside(x, y) > 0) sum += d(x, y);
        }
      }
      const area = sum * dx * dy;
      const want = 4 * Math.PI * Math.sinh(r / 2) ** 2;
      expect(Math.abs(area - want) / want).toBeLessThan(0.01);
    }
  });
});

describe('equidistants', () => {
  const a: [number, number] = [-0.55, -0.3];
  const b: [number, number] = [0.62, 0.4];

  it('puts every sample at the stated hyperbolic distance from the geodesic', () => {
    const f = field.halfplane(a, b);
    const spacing = 0.4;
    const count = 3;
    const curves = equidistants(a, b, { spacing, count, samples: 40 });
    expect(curves).toHaveLength(2 * count);
    const levels = [-3, -2, -1, 1, 2, 3].map((k) => k * spacing);
    curves.forEach((curve, i) => {
      expect(curve).toHaveLength(41);
      for (const p of curve) {
        expect(abs(p)).toBeLessThan(1);
        expect(f(p[0], p[1])).toBeCloseTo(levels[i], 6);
      }
    });
  });

  it('runs alongside the segment, square off one end and the other', () => {
    const [curve] = equidistants(a, b, { spacing: 0.3, count: 1, samples: 8 });
    // The first sample sits square off `a`, the last square off `b`: each
    // is the stated distance from its own end and no further.
    expect(distance(curve[0], a)).toBeCloseTo(0.3, 9);
    expect(distance(curve[curve.length - 1], b)).toBeCloseTo(0.3, 9);
  });

  it('draws nothing for degenerate input', () => {
    expect(equidistants(a, a)).toEqual([]);
    expect(equidistants(a, b, { spacing: 0 })).toEqual([]);
    expect(equidistants(a, b, { count: 0 })).toEqual([]);
    expect(equidistants(a, b, { samples: 0 })).toEqual([]);
  });
});

describe('the fields in a sketch', () => {
  it('contours field.cell inside the disk with t.isolines', async () => {
    const wasmPath = fileURLToPath(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url));
    await initOcclude(readFileSync(wasmPath));
    let got: Material | null = null;
    let disk = { cx: 0, cy: 0, r: 0 };
    const def = sketch({ aspect: [1, 1] }, (t) => {
      const bx = t.bounds();
      const R = Math.min(bx.w, bx.h) / 2 - 1;
      disk = { cx: bx.cx, cy: bx.cy, r: R };
      const cell = hyperbolic.field.cell(7, 3);
      got = t.isolines((x, y) => cell((x - bx.cx) / R, (y - bx.cy) / R), [0.2, 0.4]);
      return strokes(got);
    });
    render(def, { paper: 'Square20' });
    const curves = (got as unknown as Material).curves();
    expect(curves.length).toBeGreaterThan(0);
    for (const c of curves) {
      // The cell sits well inside the disk, so every contour closes, and
      // every point of it is inside the drawn rim.
      expect(c.closed).toBe(true);
      for (const [x, y] of c.pts) expect(Math.hypot(x - disk.cx, y - disk.cy)).toBeLessThan(disk.r);
    }
  });
});
