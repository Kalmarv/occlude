/**
 * OFFSETS ARE STEPS: how a shape is placed in a curved space.
 *
 * A sketch coordinate is a position by steps from the drawable's centre —
 * `x` along the base geodesic, then `y` along the perpendicular geodesic
 * there. So a shape is its anchor plus its offsets, and each offset is a
 * step of the space from that anchor: a grid is steps to each cell and
 * then steps inside it, a circle is `XY` and sin/cos like anywhere else,
 * and an edge is the image of the flat edge, sampled until the sheet
 * holds it. The one word that asks for a geodesic by name is `line`, and
 * it gets one.
 *
 * What follows from that is what is checked here: the map round-trips, a
 * grid stays a grid (neighbours still share their walls), a row is an
 * equidistant of the base and a column is a geodesic of exact length, and
 * the sketch-time doors answer in those same coordinates — so a material
 * of a shape is the numbers the sketch wrote, and drawing it again draws
 * the same ink.
 */

import { describe, expect, it } from 'vitest';
import { SQ } from './helpers/run.js';
import {
  bindToolkit, circle, compileSketch, line, rect, sketch, space, strokes,
  Execution as Run,
  type Execution, type SketchConfig, type ShapeValue, type Toolkit,
} from '../src/index.js';
import { lowerShape } from '../src/record.js';

function tk(cfg: SketchConfig = {}): Toolkit & { exec: Execution } {
  const exec = new Run(SQ);
  exec.begin({ aspect: [1, 1], ...cfg });
  return Object.assign(bindToolkit(exec), { exec });
}

function inkContours(cfg: SketchConfig, shape: ShapeValue) {
  const exec = compileSketch(sketch({ aspect: [1, 1], ...cfg }, () => shape), SQ);
  return lowerShape(exec.shapes[0], exec.frame).contours;
}

const HYP: SketchConfig = { space: space.hyperbolic({ radius: 50 }) };
const SPH: SketchConfig = { space: space.spherical({ radius: 42 }) };

describe('the coordinates are steps, and they invert', () => {
  it('round-trips through the chart, in both geometries', () => {
    for (const cfg of [HYP, SPH]) {
      const s = tk(cfg).space;
      for (const p of [[50, 50], [12, 88], [95, 4], [0, 100], [-20, 112]] as [number, number][]) {
        const back = s.fromChart(s.toChart(p));
        expect(back[0]).toBeCloseTo(p[0], 9);
        expect(back[1]).toBeCloseTo(p[1], 9);
      }
      // Past the pole of the base the coordinates wrap round the sphere
      // and name a place a second time, which is what walking that far
      // does. The drawable's centre is the origin of the steps and its own
      // coordinate.
      expect(s.toChart(s.center)).toEqual([...s.center]);
    }
  });

  it('measures a column as arc length and a row as an equidistant', () => {
    for (const cfg of [HYP, SPH]) {
      const t = tk(cfg);
      const s = t.space;
      // A column is a geodesic: `t.distanceTo` of the base row reads the
      // coordinate itself, at every x.
      const base = t.distanceTo(line(-200, 50, 200, 50));
      for (const x of [50, 70, 24, 96]) {
        for (const dy of [-30, -8, 12, 35]) expect(Math.abs(base(x, 50 + dy))).toBeCloseTo(Math.abs(dy), 4);
      }
      // So a column of any length is that length, wherever it stands.
      for (const x of [50, 82, 9]) expect(s.distance([x, 18], [x, 78])).toBeCloseTo(60, 8);
    }
  });
});

describe('a shape is its anchor plus offsets', () => {
  it('keeps a grid a grid: neighbours share their wall to the last digit', () => {
    for (const cfg of [HYP, SPH]) {
      const t = tk(cfg);
      const cells = t.grid({ cols: 9, rows: 9 });
      const corners = (c: { x: number; y: number; w: number; h: number }) =>
        t.material(rect(c.x, c.y, c.w, c.h)).pts;
      // The right wall of one cell and the left wall of the next are the
      // same two places: a placement that moved a shape's own points about
      // would tear them apart.
      const a = cells[30];
      const b = cells[31];
      expect(b.x).toBeCloseTo(a.x + a.w, 9);
      const ca = corners(a);
      const cb = corners(b);
      const onWall = (pts: readonly (readonly number[])[], x: number) =>
        pts.filter((p) => Math.abs(p[0] - x) < 1e-9).map((p) => p[1]).sort((u, v) => u - v);
      const right = onWall(ca, a.x + a.w);
      const left = onWall(cb, b.x);
      expect(right.length).toBeGreaterThan(1);
      expect(left).toEqual(right);
    }
  });

  it('places a rect at its own corners, with geodesic walls of the height asked for', () => {
    const t = tk(HYP);
    const m = t.material(rect(20, 60, 40, 24));
    const pts = m.pts.map((p) => [p[0], p[1]] as [number, number]);
    // The four corners are among the points, as the numbers the sketch
    // wrote them.
    for (const c of [[20, 60], [60, 60], [60, 84], [20, 84]] as [number, number][]) {
      expect(pts.some((p) => Math.abs(p[0] - c[0]) < 1e-9 && Math.abs(p[1] - c[1]) < 1e-9)).toBe(true);
    }
    // The two walls are geodesics of the space, and each is exactly the
    // height the sketch asked for.
    expect(t.space.distance([20, 60], [20, 84])).toBeCloseTo(24, 9);
    expect(t.space.distance([60, 60], [60, 84])).toBeCloseTo(24, 9);
    // The two rows are equidistants, not geodesics: the numbers on them
    // are worth `cosh` of the distance to the base, so the geodesic that
    // joins their ends is longer than 40 and shorter than the row itself.
    const open = Math.cosh(10 / 25);
    expect(t.space.distance([20, 60], [60, 60])).toBeGreaterThan(40);
    expect(t.space.distance([20, 60], [60, 60])).toBeLessThan(40 * open);
    // Every added point is on the outline, not off it: the edges are
    // sampled, not bent.
    for (const p of pts) {
      const onX = Math.abs(p[0] - 20) < 1e-9 || Math.abs(p[0] - 60) < 1e-9;
      const onY = Math.abs(p[1] - 60) < 1e-9 || Math.abs(p[1] - 84) < 1e-9;
      expect(onX || onY).toBe(true);
    }
  });

  it('draws a circle as steps of r from its centre, wherever it sits', () => {
    // A round shape's offsets are steps from its anchor (spec 57): every
    // point is at distance r of the space from the centre.
    for (const cfg of [HYP, SPH]) {
      const t = tk(cfg);
      for (const c of [[50, 50], [78, 30], [24, 86]] as [number, number][]) {
        for (const p of t.material(circle(c[0], c[1], 14)).pts) {
          expect(t.space.distance(c, p)).toBeCloseTo(14, 9);
        }
      }
    }
  });

  it('draws a line as the geodesic between its two ends', () => {
    for (const cfg of [HYP, SPH]) {
      const t = tk(cfg);
      const a: [number, number] = [18, 26];
      const b: [number, number] = [84, 72];
      // `t.material` keeps the line's own two ends; `t.sample` walks it.
      expect(t.material(line(a[0], a[1], b[0], b[1])).n).toBe(2);
      const pts = t.sample(line(a[0], a[1], b[0], b[1]), { count: 24 }).pts;
      expect(pts.length).toBeGreaterThan(4);
      // Every sample is on the geodesic: the two legs add up to the whole.
      const whole = t.space.distance(a, b);
      for (const p of pts) {
        expect(t.space.distance(a, p) + t.space.distance(p, b)).toBeCloseTo(whole, 6);
      }
      // The ends are the points the sketch asked for.
      expect(pts[0][0]).toBeCloseTo(a[0], 9);
      expect(pts[pts.length - 1][1]).toBeCloseTo(b[1], 9);
    }
  });

  it('turns the offsets with the shape: a rotated rect is a rotated rect', () => {
    const t = tk(HYP);
    // `rotate` turns the offsets in the flat coordinates, as it always
    // has, and the placement reads the turned numbers.
    const pts = t.material(rect(40, 40, 20, 20, { rotate: 45, origin: 'center' })).pts;
    const c: [number, number] = [50, 50];
    const far = Math.max(...pts.map((p) => Math.hypot(p[0] - c[0], p[1] - c[1])));
    expect(far).toBeCloseTo(Math.hypot(10, 10), 6);
  });
});

describe('the sketch-time doors answer in sketch coordinates', () => {
  it('hands back the numbers the sketch wrote, not chart points', () => {
    const t = tk(HYP);
    const m = t.material(rect(20, 60, 40, 24));
    // The chart would have moved every one of them: the corner at (20, 84)
    // is drawn well inside that.
    const z = t.space.toChart([20, 84]);
    expect(Math.hypot(z[0] - 20, z[1] - 84)).toBeGreaterThan(5);
    expect(Math.min(...m.pts.map((p) => p[0]))).toBeCloseTo(20, 9);
    expect(Math.max(...m.pts.map((p) => p[1]))).toBeCloseTo(84, 9);
  });

  it('draws a material of a shape exactly as the shape itself draws', () => {
    // The door places and hands the numbers back, so placing them again
    // is placing the same points: a sketch can take a shape apart, work
    // on the pieces, and draw them without the picture shifting.
    const shape = () => circle(70, 36, 18);
    const direct = inkContours(HYP, shape());
    const run = compileSketch(sketch({ aspect: [1, 1], ...HYP }, (t) => strokes(t.material(shape()))), SQ);
    const viaMaterial = lowerShape(run.shapes[0], run.frame).contours;
    expect(viaMaterial.length).toBe(direct.length);
    const ends = (cs: typeof direct) => cs.flatMap((c) => c.map((p) => (p.t === 'line' ? [p.x1, p.y1] : [NaN, NaN])));
    const A = ends(direct);
    const B = ends(viaMaterial);
    expect(B.length).toBe(A.length);
    for (let i = 0; i < A.length; i++) {
      expect(B[i][0]).toBeCloseTo(A[i][0], 6);
      expect(B[i][1]).toBeCloseTo(A[i][1], 6);
    }
  });

  it('samples the edges of a shape, and every sample is on the sheet', () => {
    // The refinement is the sheet's: an edge is halved until the projected
    // chord holds the projected image, so a long edge far from the centre
    // gets more of them than a short one at it. The ink does the halving;
    // `t.material` keeps the rect's four corners either way (spec 57).
    const t = tk(HYP);
    const near = inkContours(HYP, rect(46, 46, 8, 8))[0].length;
    const far = inkContours(HYP, rect(4, 4, 92, 92))[0].length;
    expect(far).toBeGreaterThan(near);
    expect(near).toBeGreaterThanOrEqual(4);
    expect(t.material(rect(46, 46, 8, 8)).n).toBe(4);
    expect(t.material(rect(4, 4, 92, 92)).n).toBe(4);
  });
});

describe('the flat plane is the code it always was', () => {
  it('places nothing and samples nothing without a space key', () => {
    const contours = inkContours({}, rect(10, 20, 30, 40));
    expect(contours).toEqual([[
      { t: 'line', x0: 20, y0: 40, x1: 80, y1: 40 },
      { t: 'line', x0: 80, y0: 40, x1: 80, y1: 120 },
      { t: 'line', x0: 80, y0: 120, x1: 20, y1: 120 },
      { t: 'line', x0: 20, y0: 120, x1: 20, y1: 40 },
    ]]);
    // A line is two points, as it always was: the geodesic of the flat
    // plane is the segment itself.
    const seg = inkContours({}, line(10, 10, 80, 60));
    expect(seg).toEqual([[{ t: 'line', x0: 20, y0: 20, x1: 160, y1: 120 }]]);
  });

  it('leaves a line straight under klein, where a geodesic draws straight', () => {
    const k = inkContours({ space: space.hyperbolic({ radius: 50 }), projection: 'klein' }, line(10, 10, 80, 60));
    expect(k.length).toBe(1);
    expect(k[0].length).toBe(1);
  });
});
