/**
 * `space` and `projection` on the sketch frame.
 *
 * Two things are checked here: that the hyperbolic space IS the hyperbolic
 * plane (its metric agrees with `hyperbolic.distance` after the chart
 * scaling, `exp` and `log` invert, a midpoint is equidistant, a circle is
 * at its stated radius), and that a sketch WITHOUT a `space` key lowers to
 * exactly the numbers it always lowered to.
 */

import { describe, expect, it } from 'vitest';
import { SQ } from './helpers/run.js';
import { compileSketch, circle, hyperbolic, line, rect, sketch, space, type SketchConfig, type ShapeValue, type Toolkit, type Execution, bindToolkit, Execution as Run } from '../src/index.js';
import { lowerShape } from '../src/record.js';

/** A toolkit on a 100 × 100 drawable, with the config's own space. */
function tk(cfg: SketchConfig = {}): Toolkit & { exec: Execution } {
  const exec = new Run(SQ);
  exec.begin({ aspect: [1, 1], ...cfg });
  return Object.assign(bindToolkit(exec), { exec });
}

/** The contours of one shape as the ink door lowers it, in paper mm: the
 * shape is recorded by a real run, so its transform chain is the real one. */
function inkContours(cfg: SketchConfig, shape: ShapeValue) {
  const exec = compileSketch(sketch({ aspect: [1, 1], ...cfg }, () => shape), SQ);
  return lowerShape(exec.shapes[0], exec.frame).contours;
}

describe('the hyperbolic space is the hyperbolic plane', () => {
  const t = tk({ space: space.hyperbolic({ radius: 80 }) });
  const s = t.space;
  const model = (p: readonly [number, number]): [number, number] => [(p[0] - 50) / 80, (p[1] - 50) / 80];

  it('names itself, its horizon and its curvature', () => {
    expect(s.kind).toBe('hyperbolic');
    expect(s.projection).toBe('poincare');
    expect(s.radius).toBeCloseTo(80, 12);
    expect(s.center).toEqual([50, 50]);
    expect(s.curvature).toBeCloseTo(-4 / (80 * 80), 15);
    expect(s.straight).toBe(false);
  });

  it('measures what `hyperbolic.distance` measures, scaled by radius/2', () => {
    for (const [a, b] of [
      [[50, 50], [60, 50]],
      [[20, 30], [85, 75]],
      [[50, 50], [50, 110]],
      [[12, 12], [13, 90]],
    ] as [number, number][][]) {
      const want = (80 / 2) * hyperbolic.distance(model(a), model(b));
      expect(s.distance(a, b)).toBeCloseTo(want, 10);
    }
  });

  it('is one drawable unit a step at the centre and longer toward the horizon', () => {
    expect(s.distance([50, 50], [50.001, 50])).toBeCloseTo(0.001, 9);
    // The same chart step, taken out near the horizon, is worth more.
    expect(s.distance([110, 50], [110.001, 50])).toBeGreaterThan(0.0018);
  });

  it('inverts: exp of log is the point again, and |log| is the distance', () => {
    for (const [p, q] of [
      [[50, 50], [70, 62]],
      [[30, 80], [90, 20]],
      [[55, 51], [54, 52]],
    ] as [number, number][][]) {
      const v = s.log(p, q);
      expect(Math.hypot(v[0], v[1])).toBeCloseTo(s.distance(p, q), 9);
      const back = s.exp(p, v);
      expect(back[0]).toBeCloseTo(q[0], 8);
      expect(back[1]).toBeCloseTo(q[1], 8);
    }
    // `exp` walks exactly the length it is given, in any direction.
    const out = s.exp([70, 40], [6, 8]); // |v| = 10
    expect(s.distance([70, 40], out)).toBeCloseTo(10, 9);
  });

  it('puts geodesic(a, b, ½) equidistant from both ends', () => {
    for (const [a, b] of [
      [[20, 25], [88, 79]],
      [[50, 50], [100, 50]],
      [[41, 90], [95, 44]],
    ] as [number, number][][]) {
      const mid = s.geodesic(a, b, 0.5);
      const d = s.distance(a, b);
      expect(s.distance(a, mid)).toBeCloseTo(d / 2, 8);
      expect(s.distance(mid, b)).toBeCloseTo(d / 2, 8);
      // and the ends are the points asked for
      expect(s.geodesic(a, b, 0)).toEqual([a[0], a[1]]);
      expect(s.geodesic(a, b, 1)[0]).toBeCloseTo(b[0], 8);
    }
  });

  it('samples a circle at the radius it states, wherever its centre is', () => {
    for (const [c, r] of [[[50, 50], 12], [[86, 64], 9], [[50, 50], 40]] as [number[], number][]) {
      const loop = s.circle(c as [number, number], r, 24);
      expect(loop.length).toBe(24);
      for (const p of loop) expect(s.distance(c as [number, number], p)).toBeCloseTo(r, 7);
    }
    // A radius with nothing in it draws nothing, it does not throw.
    expect(s.circle([50, 50], 0, 24)).toEqual([]);
  });

  it('has a density of 1 at the centre, growing to the horizon, and NaN past it', () => {
    expect(s.density([50, 50])).toBeCloseTo(1, 12);
    expect(s.density([100, 50])).toBeGreaterThan(s.density([70, 50]));
    expect(Number.isNaN(s.density([150, 50]))).toBe(true);
  });
});

describe('the projection', () => {
  it('poincare is the chart itself and klein sends a geodesic to a chord', () => {
    const p = tk({ space: 'hyperbolic' });
    expect(p.space.project([70, 30])).toEqual([70, 30]);
    expect(p.space.straight).toBe(false);

    const k = tk({ space: space.hyperbolic({ radius: 80 }), projection: 'klein' });
    expect(k.space.straight).toBe(true);
    // `z ↦ 2z/(1 + |z|²)`, read back in drawable units.
    const z = (70 - 50) / 80;
    expect(k.space.project([70, 50])[0]).toBeCloseTo(50 + 80 * ((2 * z) / (1 + z * z)), 10);
    // The projected midpoint of a geodesic IS the midpoint of the projected
    // chord: that is what `straight` means.
    const a: [number, number] = [22, 30];
    const b: [number, number] = [84, 76];
    // Every point of a projected geodesic sits ON the projected chord —
    // though not at its middle, because Klein is not an isometry.
    const pa = k.space.project(a);
    const pb = k.space.project(b);
    for (const u of [0.15, 0.5, 0.82]) {
      const p = k.space.project(k.space.geodesic(a, b, u));
      const cross = (pb[0] - pa[0]) * (p[1] - pa[1]) - (pb[1] - pa[1]) * (p[0] - pa[0]);
      expect(Math.abs(cross) / Math.hypot(pb[0] - pa[0], pb[1] - pa[1])).toBeLessThan(1e-9);
    }
  });
});

describe('lowering through the space', () => {
  it("gives a rect geodesic edges under 'poincare'", () => {
    const t = tk({ space: space.hyperbolic({ radius: 80 }) });
    // Four corners become many points: each edge is bent onto its geodesic.
    expect(t.material(rect(12, 12, 70, 50)).n).toBeGreaterThan(20);
    // One edge on its own, so there is nothing to disentangle: in MODEL
    // coordinates a geodesic is an arc of the circle that meets the horizon
    // at right angles, `|centre|² = r² + 1`.
    const pts = t.material(line(16, 22, 88, 74)).pts;
    expect(pts.length).toBeGreaterThan(4);
    const model = (p: readonly [number, number]): [number, number] => [(p[0] - 50) / 80, (p[1] - 50) / 80];
    const A = model(pts[0]);
    const B = model(pts[pts.length - 1]);
    // `2·centre·P = |P|² + 1` at both ends solves for the centre.
    const det = 2 * (A[0] * B[1] - A[1] * B[0]);
    const ka = A[0] * A[0] + A[1] * A[1] + 1;
    const kb = B[0] * B[0] + B[1] * B[1] + 1;
    const cx = (ka * B[1] - kb * A[1]) / det;
    const cy = (kb * A[0] - ka * B[0]) / det;
    const r = Math.sqrt(cx * cx + cy * cy - 1);
    for (const p of pts) {
      const z = model(p);
      expect(Math.hypot(z[0] - cx, z[1] - cy)).toBeCloseTo(r, 9);
    }
    // and it really bends: the middle point is off the straight chord.
    const mid = pts[Math.floor(pts.length / 2)];
    const a = pts[0];
    const b = pts[pts.length - 1];
    const off = Math.abs((b[0] - a[0]) * (mid[1] - a[1]) - (b[1] - a[1]) * (mid[0] - a[0])) / Math.hypot(b[0] - a[0], b[1] - a[1]);
    expect(off).toBeGreaterThan(0.5);
  });

  it("leaves a rect four straight edges under 'klein'", () => {
    const contours = inkContours({ space: space.hyperbolic({ radius: 80 }), projection: 'klein' }, rect(12, 12, 70, 50));
    expect(contours.length).toBe(1);
    expect(contours[0].length).toBe(4);
    expect(contours[0].every((p) => p.t === 'line')).toBe(true);
  });

  it('draws a circle as the circle of the space, not a chart circle', () => {
    const t = tk({ space: space.hyperbolic({ radius: 80 }) });
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    // A circle away from the centre: its chart picture is still a circle,
    // but not about the point its centre names.
    const m = t.material(circle(75, 50, 20));
    for (const p of m.pts) expect(t.space.distance([75, 50], p)).toBeCloseTo(20, 6);
  });

  it('keeps the flat lowering literally unchanged with no space key', () => {
    const t = tk();
    // Square20 is a 200 × 200 mm sheet with no margin: a 100 × 100 drawable
    // at 2 mm the unit, so a bare 10 is 20 mm of paper. These are HEAD's
    // numbers, snapped as the ink door has always snapped them.
    const contours = inkContours({}, rect(10, 20, 30, 40));
    expect(contours).toEqual([[
      { t: 'line', x0: 20, y0: 40, x1: 80, y1: 40 },
      { t: 'line', x0: 80, y0: 40, x1: 80, y1: 120 },
      { t: 'line', x0: 80, y0: 120, x1: 20, y1: 120 },
      { t: 'line', x0: 20, y0: 120, x1: 20, y1: 40 },
    ]]);
    // A flat circle is still two arcs flattened at the door's tolerance,
    // starting on the positive x axis.
    const round = t.material(circle(50, 50, 25));
    expect(round.n).toBe(72);
    expect([...round.pts[0]]).toEqual([75, 50]);
    expect(t.exec.space.kind).toBe('euclidean');
    expect(t.exec.frame.space).toBeUndefined();
  });
});

describe('the words that read the space', () => {
  it('spaces t.sample evenly in the metric, not on the sheet', () => {
    const t = tk({ space: space.hyperbolic({ radius: 80 }) });
    const m = t.sample(line(12, 50, 92, 50), { count: 12 });
    expect(m.n).toBe(12);
    const gaps: number[] = [];
    for (let i = 1; i < m.n; i++) gaps.push(t.space.distance(m.pts[i - 1], m.pts[i]));
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    for (const g of gaps) expect(g).toBeCloseTo(mean, 4);
    // On the SHEET they are not even at all: the far end is stretched.
    const flat: number[] = [];
    for (let i = 1; i < m.n; i++) flat.push(Math.hypot(m.pts[i][0] - m.pts[i - 1][0], m.pts[i][1] - m.pts[i - 1][1]));
    expect(Math.max(...flat) / Math.min(...flat)).toBeGreaterThan(1.3);
  });

  it('crowds t.scatter toward the horizon', () => {
    const t = tk({ space: space.hyperbolic({ radius: 60 }), seed: 7 });
    const m = t.scatter({ spacing: 5 });
    expect(m.n).toBeGreaterThan(50);
    // Two annuli about the drawable's centre, by chart area.
    const count = (r0: number, r1: number): number =>
      m.pts.filter((p) => {
        const d = Math.hypot(p[0] - 50, p[1] - 50);
        return d >= r0 && d < r1;
      }).length;
    const area = (r0: number, r1: number) => Math.PI * (r1 * r1 - r0 * r0);
    const ratio = (count(30, 45) / area(30, 45)) / (count(0, 20) / area(0, 20));
    expect(ratio).toBeGreaterThan(2);
    // Flat, the same call is even — the ratio is the yardstick, so the
    // annuli's own edge effects cancel.
    const flat = tk({ seed: 7 }).scatter({ spacing: 5 });
    const fCount = (r0: number, r1: number): number =>
      flat.pts.filter((p) => {
        const d = Math.hypot(p[0] - 50, p[1] - 50);
        return d >= r0 && d < r1;
      }).length;
    const flatRatio = (fCount(30, 45) / area(30, 45)) / (fCount(0, 20) / area(0, 20));
    expect(flatRatio).toBeLessThan(1.2);
    expect(ratio).toBeGreaterThan(flatRatio * 1.8);
  });
});

describe('the refusals name what is wrong', () => {
  it('asks for the space a projection needs', () => {
    expect(() => tk({ projection: 'klein' })).toThrow(/needs hyperbolic space/);
    expect(() => tk({ projection: 'stereographic' })).toThrow(/needs spherical space/);
  });

  it('names the family a projection belongs to', () => {
    expect(() => tk({ space: 'hyperbolic', projection: 'orthographic' })).toThrow(/belongs to spherical space/);
    expect(() => tk({ space: 'hyperbolic', projection: 'halfplane' })).toThrow(/lands in a later step/);
  });

  it('says spherical space is not here yet', () => {
    expect(() => tk({ space: 'spherical' })).toThrow(/lands in the next step/);
    expect(() => space.spherical()).toThrow(/lands in the next step/);
  });

  it('refuses a radius that is not a length', () => {
    expect(() => tk({ space: space.hyperbolic({ radius: -3 }) })).toThrow(/positive length/);
  });
});
