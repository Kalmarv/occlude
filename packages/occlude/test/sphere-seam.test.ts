/**
 * The seam of the sphere: a coordinate segment across the tear is drawn
 * the short way.
 *
 * On a sphere the sketch's x is the azimuth times `ell`, so it comes round
 * every `2π·ell` and TEARS half a turn from the centre: one line has two
 * names, the largest x and the smallest. A segment between two sketch
 * points is the segment between the NEAREST names of its ends, taken
 * cumulatively along a polyline, so a run that crosses the tear goes on
 * past it. Both doors see it: the material door hands back continuous
 * coordinates, and the ink stays where the short arc is.
 *
 * A `line` is not touched — its edge is the geodesic, which already knew.
 * Flat and hyperbolic sketches are byte-identical, which the ink oracle
 * proves.
 */

import { describe, expect, it } from 'vitest';
import { toolkit } from './helpers/run.js';
import { line, rect, space, stroke, strokes, type Execution, type ShapeValue, type Toolkit } from '../src/index.js';
import { lowerShape, lowerToUserContours, unitMm } from '../src/record.js';
import { Shape } from '../src/shapes.js';

type Kit = Toolkit & { exec: Execution };

const R = 30;
const DEG = Math.PI / 180;
const ball = (): Kit => toolkit({ aspect: [1, 1], space: space.spherical({ radius: R }) });

/** The sketch x at an azimuth, in degrees, from the drawable's centre. */
const X = (deg: number): number => 50 + R * deg * DEG;
/** A row at 60° of latitude: well off the base row, so the short arc keeps
 * clear of the one point the stereographic chart cannot draw. */
const Y = 50 + R * 60 * DEG;

/** A shape's contours through the material door, in sketch units. */
function placed(t: Kit, sv: ShapeValue, tol?: number): { pts: [number, number][]; closed: boolean }[] {
  const frame = t.exec.frame;
  const unit = unitMm(frame);
  return lowerToUserContours(sv.geom, {}, frame, tol).map((c) => ({
    closed: c.closed,
    pts: c.pts.map(([x, y]) => [x / unit, y / unit] as [number, number]),
  }));
}

/** A shape's ink, as one point list per inked contour, in drawable units. */
function inked(t: Kit, sv: ShapeValue): [number, number][][] {
  const frame = t.exec.frame;
  const unit = unitMm(frame);
  return lowerShape(new Shape(sv.geom, t.exec), frame).contours.map((contour) => {
    const pts: [number, number][] = [];
    for (const prim of contour) {
      if (prim.t !== 'line') continue;
      if (pts.length === 0) pts.push([(prim.x0 - frame.offsetX) / unit, (prim.y0 - frame.offsetY) / unit]);
      pts.push([(prim.x1 - frame.offsetX) / unit, (prim.y1 - frame.offsetY) / unit]);
    }
    return pts;
  });
}

const extent = (pts: readonly [number, number][]): number => {
  const xs = pts.map((p) => p[0]);
  return Math.max(...xs) - Math.min(...xs);
};

/** The metric length of a run, segment by segment. */
const length = (t: Kit, pts: readonly [number, number][]): number => {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += t.space.distance(pts[i - 1], pts[i]);
  return len;
};

const steps = (pts: readonly [number, number][]): number[] => pts.slice(1).map((p, i) => p[0] - pts[i][0]);

describe('a coordinate segment across the tear of the sphere', () => {
  const t = ball();
  const half = Math.PI * R;

  it('comes through the material door continuous, the short way, at the length of the short arc', () => {
    const a = X(170);
    const b = X(-170);
    const [c] = placed(t, stroke([[a, Y], [b, Y]]));
    for (const d of steps(c.pts)) expect(Math.abs(d)).toBeLessThan(half);
    // 20° of azimuth, not 340°.
    expect(extent(c.pts)).toBeCloseTo(R * 20 * DEG, 9);
    // The run starts where it was asked to and ends on the other name of
    // the far end: one period on.
    expect(c.pts[0][0]).toBeCloseTo(a, 9);
    expect(c.pts[c.pts.length - 1][0]).toBeCloseTo(b + 2 * half, 9);
    // The row is an equidistant, not a geodesic: its length is `ell·Δa`
    // shortened by the cosine of how far it sits off the base row. The
    // chords stand in for the arc to within the sampling tolerance, so the
    // run is sampled finely enough for the digits asked of it.
    const [fine] = placed(t, stroke([[a, Y], [b, Y]]), 1e-4);
    const len = length(t, fine.pts);
    const want = R * 20 * DEG * Math.cos((Y - 50) / R);
    expect(Math.abs(len - want) / want).toBeLessThan(1e-6);
    // `t.material` hands back the same continuous run.
    const m = t.material(stroke([[a, Y], [b, Y]]));
    for (const d of steps(m.pts as [number, number][])) expect(Math.abs(d)).toBeLessThan(half);
  });

  it('inks the short arc, near the two ends, and not the long way round the picture', () => {
    const a: [number, number] = [X(170), Y];
    const b: [number, number] = [X(-170), Y];
    const runs = inked(t, stroke([a, b]));
    expect(runs.length).toBe(1);
    const pa = t.space.project(a);
    const pb = t.space.project(b);
    const span = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
    let longest = 0;
    let length = 0;
    for (let i = 1; i < runs[0].length; i++) {
      const l = Math.hypot(runs[0][i][0] - runs[0][i - 1][0], runs[0][i][1] - runs[0][i - 1][1]);
      longest = Math.max(longest, l);
      length += l;
    }
    // Before the fix the run went 340° round and inked 164 units; the
    // short arc is a little longer than the chord between its ends.
    expect(longest).toBeLessThan(3);
    expect(length).toBeGreaterThanOrEqual(span);
    expect(length).toBeLessThan(1.1 * span);
    const lo = [Math.min(pa[0], pb[0]) - 2, Math.min(pa[1], pb[1]) - 2];
    const hi = [Math.max(pa[0], pb[0]) + 2, Math.max(pa[1], pb[1]) + 2];
    for (const p of runs[0]) {
      expect(p[0]).toBeGreaterThan(lo[0]);
      expect(p[0]).toBeLessThan(hi[0]);
      expect(p[1]).toBeGreaterThan(lo[1]);
      expect(p[1]).toBeLessThan(hi[1]);
    }
  });

  it('unwraps cumulatively: a run that crosses the tear twice keeps going', () => {
    // Three steps of 179° each way round: across the tear, on, and across
    // it again one period later.
    const pts: [number, number][] = [[X(175), Y], [X(-6), Y], [X(173), Y], [X(-8), Y]];
    const [c] = placed(t, stroke(pts));
    const d = steps(c.pts);
    for (const s of d) {
      expect(s).toBeGreaterThan(0);
      expect(s).toBeLessThan(half);
    }
    expect(c.pts[c.pts.length - 1][0]).toBeCloseTo(X(-8) + 4 * half, 9);
  });

  it('closes a closed contour the short way', () => {
    // A rect whose corners are named on either side of the tear: its top
    // and bottom edges are 20° long, not 340°.
    const [r] = placed(t, rect(X(-170), Y, R * 340 * DEG, 5));
    expect(r.closed).toBe(true);
    const all = [...r.pts, r.pts[0]];
    for (const s of steps(all)) expect(Math.abs(s)).toBeLessThan(half);
    expect(extent(r.pts)).toBeCloseTo(R * 20 * DEG, 9);
    // And a closed polyline whose own closing segment is the one across.
    const [p] = placed(t, stroke({ pts: [[X(170), Y], [X(170), Y + 5], [X(-170), Y + 5], [X(-170), Y]], closed: true }));
    const last = p.pts[p.pts.length - 1];
    expect(Math.abs(last[0] - p.pts[0][0])).toBeLessThan(1e-9);
    for (const s of steps(p.pts)) expect(Math.abs(s)).toBeLessThan(half);
    expect(extent(p.pts)).toBeCloseTo(R * 20 * DEG, 9);
  });

  it('leaves a line alone: its points are the geodesic the space already walks', () => {
    const a: [number, number] = [X(170), Y];
    const b: [number, number] = [X(-170), Y];
    const [c] = placed(t, line(a, b));
    const whole = t.space.distance(a, b);
    for (const p of c.pts) {
      // On the great circle between the ends, and named in the principal
      // range the geodesic's own `down` answers in.
      expect(t.space.distance(a, p) + t.space.distance(p, b)).toBeCloseTo(whole, 9);
      expect(Math.abs(p[0] - 50)).toBeLessThanOrEqual(half + 1e-9);
    }
    // The samples are the geodesic's own: its midpoint is one of them.
    const mid = t.space.geodesic(a, b, 0.5);
    expect(c.pts.some((p) => Math.abs(p[0] - mid[0]) < 1e-12 && Math.abs(p[1] - mid[1]) < 1e-12)).toBe(true);
  });
});

describe('strokes(t.tiling(3, 5)) whole', () => {
  const t = ball();
  const tiles = t.tiling(3, 5);

  it('inks every wall where the wall is: nothing sweeps the picture', () => {
    let worst = 0;
    for (const sv of strokes(tiles)) {
      // The wall's own samples, as the tiling named them: each out of
      // `down`, in the principal range.
      if (sv.geom.kind !== 'path') throw new Error('a wall strokes as a path');
      const own = sv.geom.cmds.flatMap((c) => ('x' in c ? [[c.x as number, c.y as number] as [number, number]] : []));
      let spacing = 0;
      for (let i = 1; i < own.length; i++) spacing = Math.max(spacing, t.space.distance(own[i - 1], own[i]));
      // The material door: continuous, and as long as the wall. The door
      // samples the coordinate segment between two wall samples, which
      // bows off the geodesic by less than the tiling's own tolerance; the
      // long way round would be many times longer. Two walls of this
      // icosahedron run through a pole, where x names no place and a
      // coordinate segment is not the short arc of anything: that is not
      // the seam, and it keeps the behaviour it had.
      const [door] = placed(t, sv);
      for (const d of steps(door.pts)) expect(Math.abs(d)).toBeLessThan(Math.PI * R);
      const pole = own.some((p) => Math.abs(Math.abs(p[1] - 50) - (Math.PI / 2) * R) < 1e-6);
      if (!pole) expect(Math.abs(length(t, door.pts) / length(t, own) - 1)).toBeLessThan(1e-3);
      // The ink door: every inked point, read back off the stereographic
      // sheet, lies within one sample spacing of the wall it belongs to.
      for (const run of inked(t, sv)) {
        for (const q of run) {
          const p = t.space.fromChart(q);
          let near = Infinity;
          for (const s of own) near = Math.min(near, t.space.distance(p, s));
          worst = Math.max(worst, near / spacing);
        }
      }
    }
    expect(worst).toBeLessThanOrEqual(1);
  });
});
