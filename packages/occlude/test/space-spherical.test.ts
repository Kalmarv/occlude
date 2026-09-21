/**
 * `space: 'spherical'` and its three projections.
 *
 * The space is checked against the sphere itself — the metric against the
 * great-circle angle worked out from the inverse stereographic map, `exp`
 * and `log` against each other, a midpoint against both ends, a circle
 * against its stated radius — and then the lowering: a straight line comes
 * down as a great circle under `'stereographic'`, as a straight prim under
 * `'gnomonic'`, and a shape that runs over the equator loses the far half
 * under either hemisphere chart.
 */

import { describe, expect, it } from 'vitest';
import { SQ } from './helpers/run.js';
import {
  bindToolkit, circle, compileSketch, line, rect, sketch, space,
  Execution as Run,
  type Execution, type ShapeValue, type SketchConfig, type Toolkit,
} from '../src/index.js';
import { lowerShape } from '../src/record.js';

/** A toolkit on a 100 × 100 drawable, with the config's own space. */
function tk(cfg: SketchConfig = {}): Toolkit & { exec: Execution } {
  const exec = new Run(SQ);
  exec.begin({ aspect: [1, 1], ...cfg });
  return Object.assign(bindToolkit(exec), { exec });
}

/** The contours of one shape as the ink door lowers it, in paper mm. */
function inkContours(cfg: SketchConfig, shape: ShapeValue) {
  const exec = compileSketch(sketch({ aspect: [1, 1], ...cfg }, () => shape), SQ);
  return lowerShape(exec.shapes[0], exec.frame).contours;
}

const R = 40;
const C: [number, number] = [50, 50];

/** The sphere point a drawable point stands for, worked out here from the
 * definition rather than from anything the space says. */
function onSphere(p: readonly [number, number]): [number, number, number] {
  const zx = (p[0] - C[0]) / (2 * R);
  const zy = (p[1] - C[1]) / (2 * R);
  const s = 1 + zx * zx + zy * zy;
  return [(2 * zx) / s, (2 * zy) / s, 2 / s - 1];
}

/** The great-circle length between two drawable points, the same way. */
function greatCircle(a: readonly [number, number], b: readonly [number, number]): number {
  const u = onSphere(a);
  const v = onSphere(b);
  return R * Math.acos(Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1] + u[2] * v[2])));
}

describe('the spherical space is the sphere', () => {
  const t = tk({ space: space.spherical({ radius: R }) });
  const s = t.space;

  it('names itself, its radius and its curvature', () => {
    expect(s.kind).toBe('spherical');
    expect(s.projection).toBe('stereographic');
    expect(s.radius).toBeCloseTo(R, 12);
    expect(s.center).toEqual([50, 50]);
    expect(s.curvature).toBeCloseTo(1 / (R * R), 15);
    expect(s.straight).toBe(false);
  });

  it('defaults the sphere to half the drawable short side', () => {
    expect(tk({ space: 'spherical' }).space.radius).toBeCloseTo(50, 12);
  });

  it('measures the great-circle length, after the chart scaling', () => {
    for (const [a, b] of [
      [[50, 50], [60, 50]],
      [[20, 30], [85, 75]],
      [[50, 50], [50, 190]],
      [[12, 12], [13, 90]],
    ] as [number, number][][]) {
      expect(s.distance(a, b)).toBeCloseTo(greatCircle(a, b), 10);
    }
    // Half the sphere across is a quarter of its circumference.
    expect(s.distance([50, 50], [50 + 2 * R, 50])).toBeCloseTo((Math.PI / 2) * R, 10);
  });

  it('is one drawable unit a step at the centre and shorter away from it', () => {
    expect(s.distance([50, 50], [50.001, 50])).toBeCloseTo(0.001, 9);
    // The same chart step out near the equator is worth LESS: a sphere's
    // chart stretches, where the disk's crowds.
    expect(s.distance([130, 50], [130.001, 50])).toBeLessThan(0.0006);
  });

  it('inverts: exp of log is the point again, and |log| is the distance', () => {
    for (const [p, q] of [
      [[50, 50], [70, 62]],
      [[30, 80], [90, 20]],
      [[55, 51], [54, 52]],
      [[12, 140], [150, 9]],
    ] as [number, number][][]) {
      const v = s.log(p, q);
      expect(Math.hypot(v[0], v[1])).toBeCloseTo(s.distance(p, q), 9);
      const back = s.exp(p, v);
      expect(back[0]).toBeCloseTo(q[0], 7);
      expect(back[1]).toBeCloseTo(q[1], 7);
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
    expect(s.circle([50, 50], 0, 24)).toEqual([]);
  });

  it('has a density of 1 at the centre and never more, so nothing runs away', () => {
    expect(s.density([50, 50])).toBeCloseTo(1, 12);
    // `1/(1 + |z|²)²` — a quarter at the equator, and falling from there.
    expect(s.density([50 + 2 * R, 50])).toBeCloseTo(0.25, 12);
    expect(s.density([300, 300])).toBeLessThan(0.01);
    for (const p of [[50, 50], [90, 20], [200, 5], [-100, 400]] as [number, number][]) {
      expect(s.density(p)).toBeGreaterThan(0);
      expect(s.density(p)).toBeLessThanOrEqual(1);
    }
  });
});

describe('the spherical projections', () => {
  it('stereographic is the chart itself', () => {
    const s = tk({ space: space.spherical({ radius: R }) }).space;
    expect(s.project([70, 30])).toEqual([70, 30]);
    expect(s.straight).toBe(false);
  });

  it('gnomonic draws every geodesic straight, and has no far side', () => {
    const s = tk({ space: space.spherical({ radius: R }), projection: 'gnomonic' }).space;
    expect(s.straight).toBe(true);
    const a: [number, number] = [30, 34];
    const b: [number, number] = [78, 66];
    const pa = s.project(a);
    const pb = s.project(b);
    for (const u of [0.15, 0.5, 0.82]) {
      const p = s.project(s.geodesic(a, b, u));
      const cross = (pb[0] - pa[0]) * (p[1] - pa[1]) - (pb[1] - pa[1]) * (p[0] - pa[0]);
      expect(Math.abs(cross) / Math.hypot(pb[0] - pa[0], pb[1] - pa[1])).toBeLessThan(1e-9);
    }
    // The equator is |p − c| = 2R, and past it there is no sheet.
    expect(Number.isFinite(s.project([50 + 2 * R + 1, 50])[0])).toBe(false);
    expect(Number.isFinite(s.project([50 + 2 * R - 1, 50])[0])).toBe(true);
  });

  it('orthographic is the sphere from far away: the near half inside a circle of R', () => {
    const s = tk({ space: space.spherical({ radius: R }), projection: 'orthographic' }).space;
    expect(s.straight).toBe(false);
    // A point at angle θ from the contact lands at R·sin θ.
    const p: [number, number] = [50 + 2 * R * Math.tan(Math.PI / 8), 50];
    expect(s.project(p)[0] - 50).toBeCloseTo(R * Math.sin(Math.PI / 4), 10);
    // The equator itself is the rim; past it, nothing.
    expect(s.project([50 + 2 * R, 50])[0] - 50).toBeCloseTo(R, 10);
    expect(Number.isFinite(s.project([50 + 2 * R + 1, 50])[0])).toBe(false);
  });

  it('refuses a projection from the other geometry, by name', () => {
    expect(() => tk({ space: 'spherical', projection: 'poincare' })).toThrow(/belongs to hyperbolic space/);
    expect(() => tk({ space: 'hyperbolic', projection: 'gnomonic' })).toThrow(/belongs to spherical space/);
    expect(() => tk({ projection: 'stereographic' })).toThrow(/needs spherical space/);
  });
});

describe('lowering through the spherical space', () => {
  it('bends a line onto a great circle under stereographic', () => {
    const t = tk({ space: space.spherical({ radius: R }) });
    const pts = t.material(line(16, 22, 88, 74)).pts;
    expect(pts.length).toBeGreaterThan(4);
    // Back on the sphere, every sample sits on ONE plane through the
    // centre: that is what a great circle is.
    const a = onSphere(pts[0]);
    const b = onSphere(pts[pts.length - 1]);
    const n = [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
    const len = Math.hypot(n[0], n[1], n[2]);
    for (const p of pts) {
      const u = onSphere(p);
      expect(Math.abs((u[0] * n[0] + u[1] * n[1] + u[2] * n[2]) / len)).toBeLessThan(1e-9);
    }
    // and it really bends: the middle sample is off the straight chord.
    const mid = pts[Math.floor(pts.length / 2)];
    const off = Math.abs((pts[pts.length - 1][0] - pts[0][0]) * (mid[1] - pts[0][1])
      - (pts[pts.length - 1][1] - pts[0][1]) * (mid[0] - pts[0][0]))
      / Math.hypot(pts[pts.length - 1][0] - pts[0][0], pts[pts.length - 1][1] - pts[0][1]);
    expect(off).toBeGreaterThan(0.3);
  });

  it('leaves a rect four straight edges under gnomonic', () => {
    const contours = inkContours({ space: space.spherical({ radius: R }), projection: 'gnomonic' }, rect(22, 22, 50, 50));
    expect(contours.length).toBe(1);
    expect(contours[0].length).toBe(4);
    expect(contours[0].every((p) => p.t === 'line')).toBe(true);
  });

  it('draws a circle as the circle of the space, not a chart circle', () => {
    const t = tk({ space: space.spherical({ radius: R }) });
    const m = t.material(circle(75, 50, 20));
    for (const p of m.pts) expect(t.space.distance([75, 50], p)).toBeCloseTo(20, 6);
  });

  it('drops the far piece of a shape that runs over the equator', () => {
    // A long line from the middle of the drawable out past |p − c| = 2R.
    const far: [number, number] = [50 + 2 * R + 30, 50];
    for (const projection of ['gnomonic', 'orthographic'] as const) {
      const t = tk({ space: space.spherical({ radius: R }), projection });
      const contours = inkContours(
        { space: space.spherical({ radius: R }), projection },
        line(50, 50, far[0], far[1]),
      );
      const pts = contours.flatMap((c) => c.map((p) => (p.t === 'line' ? [p.x1, p.y1] : [NaN, NaN])));
      expect(pts.length).toBeGreaterThan(0);
      // Nothing that has no place on the sheet got drawn …
      for (const [x, y] of pts) {
        expect(Number.isFinite(x)).toBe(true);
        expect(Number.isFinite(y)).toBe(true);
      }
      // … and the stroke stops AT the equator, not at the last sample
      // before it. Orthographic puts the equator on the rim, a circle of
      // R about the centre, so the furthest drawn point lands there to a
      // hair. Gnomonic puts it infinitely far away, so the stroke runs out
      // past every bound the sheet has — which is what gnomonic IS, and
      // why a drawing under it stays well inside the near hemisphere.
      const unit = 2; // a 100 × 100 drawable on a 200 × 200 sheet
      const reach = Math.max(...pts.map(([x]) => x)) / unit;
      if (projection === 'orthographic') expect(reach).toBeCloseTo(t.space.project([50 + 2 * R, 50])[0], 4);
      else expect(reach).toBeGreaterThan(1e4);
    }
    // The whole of the far side draws nothing at all, and nothing throws.
    const none = inkContours(
      { space: space.spherical({ radius: R }), projection: 'gnomonic' },
      line(far[0], far[1], far[0] + 20, far[1] + 20),
    );
    expect(none.flat().length).toBe(0);
  });

  it('keeps the whole chart at the sketch-time doors, whatever the projection', () => {
    // `t.material` answers in the CHART, where the far side is a place
    // like any other: only the ink door drops it.
    const t = tk({ space: space.spherical({ radius: R }), projection: 'orthographic' });
    const m = t.material(line(50, 50, 50 + 2 * R + 30, 50));
    expect(Math.max(...m.pts.map((p) => p[0]))).toBeGreaterThan(50 + 2 * R);
  });
});

describe('t.scatter on the sphere', () => {
  /** The closest two points come, measured by the METRIC — which is what
   * `spacing` asks about. */
  const closest = (pts: readonly (readonly number[])[], distance: (a: [number, number], b: [number, number]) => number): number => {
    let best = Infinity;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        best = Math.min(best, distance([pts[i][0], pts[i][1]], [pts[j][0], pts[j][1]]));
      }
    }
    return best;
  };

  it('keeps the spacing it was asked for, out where the chart stretches', () => {
    // THE BUG THIS CATCHES. The bucket grid is laid out in the CHART while
    // every radius in the flood is a length of the SPACE. On a sphere the
    // chart is longer than the metric — its density runs below 1 — so a
    // cell search sized in space units comes up short away from the point
    // of contact, misses a neighbour, and lets two points land closer than
    // the spacing. The fix widens the search by `1/sqrt(min density)`,
    // which is exactly 1 in the flat plane and in the hyperbolic disk.
    const t = tk({ space: space.spherical({ radius: 14 }), seed: 3 });
    const m = t.scatter({ spacing: 6 });
    expect(m.n).toBeGreaterThan(30);
    expect(closest(m.pts, (a, b) => t.space.distance(a, b))).toBeGreaterThanOrEqual(6 - 1e-9);
  });

  it('still keeps it in the flat plane and in the disk', () => {
    const flat = tk({ seed: 3 });
    expect(closest(flat.scatter({ spacing: 6 }).pts, (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]))).toBeGreaterThanOrEqual(6 - 1e-9);
    const disk = tk({ space: space.hyperbolic({ radius: 60 }), seed: 3 });
    expect(closest(disk.scatter({ spacing: 6 }).pts, (a, b) => disk.space.distance(a, b))).toBeGreaterThanOrEqual(6 - 1e-9);
  });
});
