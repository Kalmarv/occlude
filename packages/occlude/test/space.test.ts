/**
 * `space` and `projection` on the sketch frame.
 *
 * Two things are checked here: that the hyperbolic space IS the hyperbolic
 * plane (its metric agrees with the unit disk's after the chart scaling,
 * `exp` and `log` invert, a midpoint is equidistant, a circle is at its
 * stated radius), and that a sketch WITHOUT a `space` key lowers to exactly
 * the numbers it always lowered to.
 *
 * A sketch coordinate is a position by steps from the drawable's centre —
 * `x` along the base geodesic, then `y` along the perpendicular geodesic
 * there — so `(x, y)` names a place and never a chart point. The stepped
 * placement itself is `space-steps.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { SQ } from './helpers/run.js';
import { compileSketch, circle, line, rect, sketch, space, type SketchConfig, type ShapeValue, type Toolkit, type Execution, bindToolkit, Execution as Run } from '../src/index.js';
import { hyperbolicSpaceOf } from '../src/space.js';
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
  /** A point of the sketch as a point of the unit disk, which is the model
   * the maths is written in everywhere else. The disk is drawn at the
   * space's own `size`, which is a paper setting and not the radius. */
  const model = (p: readonly [number, number]): [number, number] => {
    const z = s.toChart(p);
    return [(z[0] - 50) / s.size, (z[1] - 50) / s.size];
  };

  it('names itself, its disk and its curvature', () => {
    expect(s.kind).toBe('hyperbolic');
    expect(s.projection).toBe('poincare');
    expect(s.radius).toBeCloseTo(80, 12);
    expect(s.center).toEqual([50, 50]);
    expect(s.curvature).toBeCloseTo(-4 / (80 * 80), 15);
    expect(s.straight).toBe(false);
  });

  it('measures what the unit disk measures, scaled by radius/2', () => {
    for (const [a, b] of [
      [[50, 50], [60, 50]],
      [[20, 30], [85, 75]],
      [[50, 50], [50, 110]],
      [[12, 12], [13, 90]],
    ] as [number, number][][]) {
      // The unit disk's own metric, `ds = 2|dz|/(1 − |z|²)`, is twice the
      // metric of the space whose chart IS that disk. That space reads its
      // own coordinates, so the disk points go in through `fromChart`.
      const unit = hyperbolicSpaceOf([0, 0], 1, 'poincare');
      const want = (80 / 2) * 2 * unit.distance(unit.fromChart(model(a)), unit.fromChart(model(b)));
      expect(s.distance(a, b)).toBeCloseTo(want, 10);
    }
  });

  it('is a coordinate by steps: a column is arc length, a row is longer', () => {
    // Every column is a geodesic walked at unit speed, wherever it is.
    for (const x of [50, 92, 8]) expect(s.distance([x, 20], [x, 74])).toBeCloseTo(54, 9);
    // The base row is a geodesic too, so it is arc length as well.
    expect(s.distance([12, 50], [92, 50])).toBeCloseTo(80, 9);
    expect(s.distance([50, 50], [50.001, 50])).toBeCloseTo(0.001, 9);
    // A step ALONG a row away from the base is worth MORE: the rows open
    // out, by `cosh` of the distance to the base.
    const b = 40 / (80 / 2);
    expect(s.distance([50, 90], [50.001, 90])).toBeCloseTo(0.001 * Math.cosh(b), 9);
    // Which makes the row itself longer than the geodesic that joins its
    // ends, and never shorter.
    expect(s.distance([20, 90], [80, 90])).toBeLessThan(60 * Math.cosh(b));
    expect(s.distance([20, 90], [80, 90])).toBeGreaterThan(60);
  });

  it('maps a coordinate to the disk and reads it back', () => {
    for (const p of [[50, 50], [70, 62], [10, 95], [100, 0], [-40, 160]] as [number, number][]) {
      const z = s.toChart(p);
      // Every coordinate is a place, and the disk is where it is DRAWN, so
      // the chart point is always inside the rim.
      expect(Math.hypot(z[0] - 50, z[1] - 50)).toBeLessThan(80);
      const back = s.fromChart(z);
      expect(back[0]).toBeCloseTo(p[0], 8);
      expect(back[1]).toBeCloseTo(p[1], 8);
    }
    expect(s.toChart([50, 50])).toEqual([50, 50]);
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

  it('has a density of 1 on the base row, growing away from it, never NaN', () => {
    expect(s.density([50, 50])).toBeCloseTo(1, 12);
    expect(s.density([300, 50])).toBeCloseTo(1, 12);
    expect(s.density([50, 90])).toBeCloseTo(Math.cosh(40 / 40), 12);
    expect(s.density([50, 150])).toBeGreaterThan(s.density([50, 90]));
    // There is no horizon in the coordinates: every pair names a place.
    for (const p of [[150, 50], [-400, 900]] as [number, number][]) {
      expect(Number.isFinite(s.density(p))).toBe(true);
    }
  });
});

describe('the projection', () => {
  it('poincare is the chart of the coordinates and klein sends a geodesic to a chord', () => {
    const p = tk({ space: 'hyperbolic' });
    // Poincaré draws the chart itself, so the projection IS the coordinate
    // map — and it is not the identity, because a coordinate is a place.
    expect(p.space.project([70, 30])).toEqual([...p.space.toChart([70, 30])]);
    expect(p.space.straight).toBe(false);

    const k = tk({ space: space.hyperbolic({ radius: 80 }), projection: 'klein' });
    expect(k.space.straight).toBe(true);
    // `z ↦ 2z/(1 + |z|²)`, read back in drawable units.
    const c = k.space.toChart([70, 50]);
    const m = k.space.size;
    const z = (c[0] - 50) / m;
    expect(k.space.project([70, 50])[0]).toBeCloseTo(50 + m * ((2 * z) / (1 + z * z)), 10);
    // The projected midpoint of a geodesic IS the midpoint of the projected
    // chord: that is what `straight` means.
    const a: [number, number] = [22, 30];
    const b: [number, number] = [84, 76];
    // Every point of a projected geodesic sits ON the projected chord —
    // though not at its middle, because Klein is not an isometry.
    const pa = k.space.project(a);
    const pb = k.space.project(b);
    for (const u of [0.15, 0.5, 0.82]) {
      const p2 = k.space.project(k.space.geodesic(a, b, u));
      const cross = (pb[0] - pa[0]) * (p2[1] - pa[1]) - (pb[1] - pa[1]) * (p2[0] - pa[0]);
      expect(Math.abs(cross) / Math.hypot(pb[0] - pa[0], pb[1] - pa[1])).toBeLessThan(1e-9);
    }
  });
});

describe('lowering through the space', () => {
  it('draws a line as the geodesic between its two ends', () => {
    const t = tk({ space: space.hyperbolic({ radius: 80 }) });
    // One edge on its own, so there is nothing to disentangle: in the
    // MODEL a geodesic is an arc of the circle that meets the rim at right
    // angles, `|centre|² = r² + 1`.
    const pts = t.material(line(16, 22, 88, 74)).pts;
    expect(pts.length).toBeGreaterThan(4);
    const model = (p: readonly [number, number]): [number, number] => {
      const z = t.space.toChart(p);
      return [(z[0] - 50) / t.space.size, (z[1] - 50) / t.space.size];
    };
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
    // The ends are the points the sketch asked for, and no others.
    expect(pts[0][0]).toBeCloseTo(16, 9);
    expect(pts[pts.length - 1][1]).toBeCloseTo(74, 9);
  });

  it("leaves a line two points under 'klein', where a geodesic draws straight", () => {
    const contours = inkContours({ space: space.hyperbolic({ radius: 80 }), projection: 'klein' }, line(12, 12, 82, 62));
    expect(contours.length).toBe(1);
    expect(contours[0].length).toBe(1);
    expect(contours[0][0].t).toBe('line');
    // A rect is not a line: its rows are equidistants, and an equidistant
    // is not straight in any chart.
    const box = inkContours({ space: space.hyperbolic({ radius: 80 }), projection: 'klein' }, rect(12, 12, 70, 50));
    expect(box[0].length).toBeGreaterThan(4);
  });

  it('draws a circle as the sin/cos circle of the coordinates', () => {
    const t = tk({ space: space.hyperbolic({ radius: 80 }) });
    // A circle away from the base row: `XY` and sin/cos, placed by the
    // same steps as everything else.
    const m = t.material(circle(50, 85, 20));
    for (const p of m.pts) expect(Math.hypot(p[0] - 50, p[1] - 85)).toBeCloseTo(20, 6);
    // Which is NOT the circle of the space up there: a step along a row is
    // worth more than a step down a column, so the loop is an oval in the
    // metric. `t.space.circle` is the word for the other one.
    const along = m.pts.map((p) => t.space.distance([50, 85], p));
    expect(Math.max(...along)).toBeGreaterThan(Math.min(...along) * 1.1);
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
    const m = t.sample(line(12, 96, 92, 4), { count: 12 });
    expect(m.n).toBe(12);
    const gaps: number[] = [];
    for (let i = 1; i < m.n; i++) gaps.push(t.space.distance(m.pts[i - 1], m.pts[i]));
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    for (const g of gaps) expect(g).toBeCloseTo(mean, 4);
    // On the SHEET they are not even at all: the ends are crowded, because
    // the chart has to hold the whole plane inside one disk.
    const flat: number[] = [];
    for (let i = 1; i < m.n; i++) {
      const a = t.space.project(m.pts[i - 1]);
      const b = t.space.project(m.pts[i]);
      flat.push(Math.hypot(b[0] - a[0], b[1] - a[1]));
    }
    expect(Math.max(...flat) / Math.min(...flat)).toBeGreaterThan(1.3);
  });

  it('crowds t.scatter where the rows open out', () => {
    const t = tk({ space: space.hyperbolic({ radius: 60 }), seed: 7 });
    const m = t.scatter({ spacing: 5 });
    expect(m.n).toBeGreaterThan(50);
    // `spacing` is a length of the SPACE, and a row far from the base is
    // longer than the numbers on it, so the same spacing takes fewer
    // coordinates up there: the points crowd, read in coordinates.
    const band = (y0: number, y1: number): number =>
      m.pts.filter((p) => Math.abs(p[1] - 50) >= y0 && Math.abs(p[1] - 50) < y1).length / (2 * (y1 - y0) * 100);
    expect(band(35, 50) / band(0, 15)).toBeGreaterThan(1.5);
    // Flat, the same call is even — the ratio is the yardstick, so the
    // bands' own edge effects cancel.
    const flat = tk({ seed: 7 }).scatter({ spacing: 5 });
    const fBand = (y0: number, y1: number): number =>
      flat.pts.filter((p) => Math.abs(p[1] - 50) >= y0 && Math.abs(p[1] - 50) < y1).length / (2 * (y1 - y0) * 100);
    expect(fBand(35, 50) / fBand(0, 15)).toBeLessThan(1.2);
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

  it('names an unknown space, and knows the three there are', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => tk({ space: 'elliptic' as any })).toThrow(/unknown space 'elliptic'/);
    for (const kind of ['euclidean', 'hyperbolic', 'spherical'] as const) {
      expect(tk({ space: kind }).space.kind).toBe(kind);
    }
    expect(space.spherical().kind).toBe('spherical');
  });

  it('refuses a radius that is not a length', () => {
    expect(() => tk({ space: space.hyperbolic({ radius: -3 }) })).toThrow(/positive length/);
  });
});
