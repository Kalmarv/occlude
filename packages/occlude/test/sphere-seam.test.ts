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
 * coordinates, and the ink stays where the short arc is. That is a
 * STROKE's rule: an AREA's loop — any closed contour — is walked as drawn
 * and keeps the side its winding names (spec 57).
 *
 * The POLES are the other place a coordinate names badly: at `±π/2` of
 * latitude every x names the one point, so the x a pole point carries is
 * noise. A segment to a pole point takes the previous point's x and a
 * segment from it the next point's, so both run along meridians — the
 * geodesics through the pole — and the stretch between the two names is
 * the pole itself.
 *
 * A `line` is not touched — its edge is the geodesic, which already knew.
 * Flat and hyperbolic sketches are byte-identical, which the ink oracle
 * proves.
 */

import { describe, expect, it } from 'vitest';
import { toolkit } from './helpers/run.js';
import { line, rect, space, stroke, strokes, type Execution, type Placement, type ShapeValue, type Toolkit } from '../src/index.js';
import { geodesicBow, lowerShape, lowerToUserContours, unitMm } from '../src/record.js';
import { Shape } from '../src/shapes.js';
import type { TransformOp } from '../src/execution.js';

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

/** A shape's ink, as one point list per inked contour, in drawable units:
 * drawn plain, or inside the groups of `chain`, outermost first. */
function inked(t: Kit, sv: ShapeValue, chain: TransformOp[] = []): [number, number][][] {
  const frame = t.exec.frame;
  const unit = unitMm(frame);
  let shape!: Shape;
  const run = (i: number): void => {
    if (i === chain.length) shape = new Shape(sv.geom, t.exec);
    else t.exec.push(chain[i], () => run(i + 1));
  };
  run(0);
  return lowerShape(shape, frame).contours.map((contour) => {
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

  it('walks a closed contour as drawn: an area keeps the side its winding names', () => {
    // A rect whose corners are named on either side of the tear: an AREA's
    // loop is walked as drawn (spec 57), so its top and bottom edges run
    // the 340° the numbers name, and nothing is renamed.
    const [r] = placed(t, rect(X(-170), Y, R * 340 * DEG, 5));
    expect(r.closed).toBe(true);
    expect(extent(r.pts)).toBeCloseTo(R * 340 * DEG, 9);
    expect(Math.min(...r.pts.map((p) => p[0]))).toBeCloseTo(X(-170), 9);
    // A closed polyline is a loop too: its closing segment across the tear
    // is walked back the way the loop was drawn.
    const [p] = placed(t, stroke({ pts: [[X(170), Y], [X(170), Y + 5], [X(-170), Y + 5], [X(-170), Y]], closed: true }));
    const last = p.pts[p.pts.length - 1];
    expect(Math.abs(last[0] - p.pts[0][0])).toBeLessThan(1e-9);
    expect(extent(p.pts)).toBeCloseTo(R * 340 * DEG, 9);
    // The same polyline OPEN is a stroke: each segment the short way.
    const [o] = placed(t, stroke([[X(170), Y], [X(170), Y + 5], [X(-170), Y + 5], [X(-170), Y]]));
    for (const s of steps(o.pts)) expect(Math.abs(s)).toBeLessThan(half);
    expect(extent(o.pts)).toBeCloseTo(R * 20 * DEG, 9);
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
      // icosahedron run through a pole, and they pass through it on the
      // meridians either side, as long as the wall too.
      const [door] = placed(t, sv);
      for (const d of steps(door.pts)) expect(Math.abs(d)).toBeLessThan(Math.PI * R);
      expect(Math.abs(length(t, door.pts) / length(t, own) - 1)).toBeLessThan(1e-3);
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

describe('a polyline through a pole of the sphere', () => {
  const t = ball();
  /** The two poles: every x names each of them. */
  const TOP = 50 - (Math.PI / 2) * R;
  const BOTTOM = 50 + (Math.PI / 2) * R;
  /** The geodesic from `a` to `q`, sampled finely. */
  const arc = (a: readonly [number, number], q: readonly [number, number]): [number, number][] =>
    Array.from({ length: 2001 }, (_, k) => t.space.geodesic(a, q, k / 2000) as [number, number]);
  /** How far `p` stands, in the space, from the nearest of `arcs`. */
  const off = (p: readonly [number, number], arcs: readonly [number, number][][]): number =>
    Math.min(...arcs.flatMap((pts) => pts.map((g) => t.space.distance(p, g))));

  for (const [name, P, s] of [['top', TOP, 1], ['bottom', BOTTOM, -1]] as const) {
    it(`turns a corner at the ${name} pole along the two meridians`, () => {
      // Five units up the 20° meridian, a corner at the pole whose own x
      // is noise, and five units down the −100° meridian.
      const a: [number, number] = [X(20), P + 5 * s];
      const b: [number, number] = [X(-100), P + 5 * s];
      const [c] = placed(t, stroke([a, [X(-130), P], b]));
      // Every point sits on one meridian or the other, by name.
      for (const p of c.pts) {
        expect(Math.min(Math.abs(p[0] - a[0]), Math.abs(p[0] - b[0]))).toBeLessThan(1e-9);
      }
      // The pole, under both names, and nothing swept round it: the run is
      // the two legs, five and five.
      expect(c.pts.filter((p) => Math.abs(p[1] - P) < 1e-9).map((p) => p[0])).toEqual([a[0], b[0]]);
      expect(length(t, c.pts)).toBeCloseTo(10, 9);
      // The ink, read back off the sheet, lies on the two meridian arcs to
      // within the ink tolerance and the 0.005 mm snap; the loop round the
      // pole it used to draw stood a third of a unit off.
      const legs = [arc(a, [a[0], P]), arc(b, [b[0], P])];
      const tol = 0.06 / unitMm(t.exec.frame);
      for (const run of inked(t, stroke([a, [X(-130), P], b]))) {
        for (const q of run) expect(off(t.space.fromChart(q), legs)).toBeLessThan(tol);
      }
    });
  }

  it('gives a pole point at either end of a run the one neighbour it has', () => {
    const a: [number, number] = [X(20), TOP + 5];
    const [from] = placed(t, stroke([[X(-130), TOP], a]));
    for (const p of from.pts) expect(p[0]).toBeCloseTo(a[0], 9);
    const [to] = placed(t, stroke([a, [X(77), TOP]]));
    for (const p of to.pts) expect(p[0]).toBeCloseTo(a[0], 9);
    expect(length(t, from.pts)).toBeCloseTo(5, 9);
    expect(length(t, to.pts)).toBeCloseTo(5, 9);
  });

  it('reads a run of pole points as one point with two names', () => {
    const a: [number, number] = [X(20), TOP + 5];
    const b: [number, number] = [X(-100), TOP + 5];
    const [c] = placed(t, stroke([a, [X(1), TOP], [X(2), TOP], [X(3), TOP], b]));
    for (const p of c.pts) {
      expect(Math.min(Math.abs(p[0] - a[0]), Math.abs(p[0] - b[0]))).toBeLessThan(1e-9);
    }
    expect(length(t, c.pts)).toBeCloseTo(10, 9);
  });

  it('leaves a line to the pole alone: its points are the geodesic\'s own', () => {
    const a: [number, number] = [X(20), TOP + 5];
    const q: [number, number] = [X(-130), TOP];
    const [c] = placed(t, line(a, q));
    // Every point lies on the geodesic between the ends. Along a meridian
    // the flat segment IS that geodesic, so it keeps no bow to sample.
    const whole = t.space.distance(a, q);
    for (const p of c.pts) expect(t.space.distance(a, p) + t.space.distance(p, q)).toBeCloseTo(whole, 9);
    expect(t.space.distance(c.pts[0], a)).toBeLessThan(1e-9);
    expect(t.space.distance(c.pts[c.pts.length - 1], q)).toBeLessThan(1e-9);
  });
});

describe('a tiling moved so a wall passes a pole', () => {
  const t = ball();
  const TOP = 50 - (Math.PI / 2) * R;
  const pole: [number, number] = [50, TOP];
  const tiles = t.tiling(3, 5);
  /** A wall's middle, facing along it, and a place `d` from the pole
   * facing along the parallel: the placement between them lays that wall
   * past the pole at distance `d`. */
  const pass = (d: number) => {
    const [A, B] = tiles.cell;
    const from = t.station(t.space.geodesic(A, B, 0.5)).toward(B);
    return t.station([57, TOP + d]).placement({ from });
  };
  /** The moved SOURCE curve near the pole: every edge's flat segment, read
   * the short way round as the ink reads it, sampled finely, moved. */
  const source = (P: ReturnType<typeof pass>): [number, number][] => {
    const out: [number, number][] = [];
    for (let e = 0; e < tiles.edgeCount; e++) {
      const a = tiles.edgeList[2 * e];
      const b = tiles.edgeList[2 * e + 1];
      const pa = P.point([tiles.x[a], tiles.y[a]]);
      const pb = P.point([tiles.x[b], tiles.y[b]]);
      if (Math.min(t.space.distance(pa, pole), t.space.distance(pb, pole)) > 4) continue;
      const x0 = tiles.x[a];
      const y0 = tiles.y[a];
      const dx = tiles.x[b] - x0 - 2 * Math.PI * R * Math.round((tiles.x[b] - x0) / (2 * Math.PI * R));
      const dy = tiles.y[b] - y0;
      for (let i = 0; i <= 200; i++) out.push(P.point([x0 + (dx * i) / 200, y0 + (dy * i) / 200]) as [number, number]);
    }
    return out;
  };
  /** Every inked point within three units of the pole, back off the sheet. */
  const inkNearPole = (drawing: ShapeValue[], chain: TransformOp[] = []): [number, number][] =>
    drawing.flatMap((sv) => inked(t, sv, chain)).flat().map((q) => t.space.fromChart(q) as [number, number])
      .filter((p) => t.space.distance(p, pole) < 3);
  const worst = (ink: [number, number][], cloud: [number, number][]): number =>
    Math.max(0, ...ink.map((p) => Math.min(...cloud.map((c) => t.space.distance(p, c)))));

  for (const d of [0, 0.1, 0.5, 2]) {
    it(`draws the moved walls where they are, ${d} from the pole, through m.transform and through group`, () => {
      const P = pass(d);
      const cloud = source(P);
      // Through the material: the moved edges are sampled where they land.
      const moved = inkNearPole(strokes(tiles.transform(P)));
      expect(moved.length).toBeGreaterThan(0);
      expect(worst(moved, cloud)).toBeLessThan(0.06);
      // Through the drawing: a placement is judged on the sheet after the
      // move, like any other element of the chain.
      const placed = inkNearPole(strokes(tiles), [{ placement: P }]);
      expect(placed.length).toBeGreaterThan(0);
      expect(worst(placed, cloud)).toBeLessThan(0.06);
    });
  }
});

describe('a stored geodesic stays within its bow wherever it is carried', () => {
  const t = ball();
  const frame = t.exec.frame;
  const unit = unitMm(frame);
  /** Points of `truth`, bucketed a millimetre square on the sheet. */
  const index = (truth: [number, number][]) => {
    const grid = new Map<string, [number, number][]>();
    for (const q of truth) {
      if (!Number.isFinite(q[0]) || !Number.isFinite(q[1])) continue;
      const key = `${Math.floor(q[0] * unit)},${Math.floor(q[1] * unit)}`;
      (grid.get(key) ?? grid.set(key, []).get(key)!).push(q);
    }
    /** How far `p` stands from the truth, in sheet mm, looked up nearby. */
    return (p: readonly [number, number]): number => {
      const i = Math.floor(p[0] * unit);
      const j = Math.floor(p[1] * unit);
      let best = Infinity;
      for (let di = -1; di <= 1; di++) {
        for (let dj = -1; dj <= 1; dj++) {
          for (const q of grid.get(`${i + di},${j + dj}`) ?? []) best = Math.min(best, Math.hypot(q[0] - p[0], q[1] - p[1]) * unit);
        }
      }
      return best;
    };
  };

  it('stores a line through the material door within the bow of its geodesic', () => {
    const bow = geodesicBow(t.space, frame);
    const a: [number, number] = [X(10), Y - 30];
    const b: [number, number] = [X(70), Y];
    const [c] = placed(t, line(a, b));
    expect(c.pts.length).toBeGreaterThan(2);
    for (let k = 1; k < c.pts.length; k++) {
      const u = c.pts[k - 1];
      const v = c.pts[k];
      const m: [number, number] = [(u[0] + v[0]) / 2, (u[1] + v[1]) / 2];
      expect(t.space.distance(m, t.space.geodesic(u, v, 0.5))).toBeLessThanOrEqual(bow * (1 + 1e-6));
    }
  });

  const tiles = t.tiling(3, 5);
  /** Every wall of the tiling, carried by `P`, sampled finely along its
   * true geodesic and projected. */
  const geodesics = (P: { point: (p: [number, number]) => [number, number] | number[] }): [number, number][] => {
    const out: [number, number][] = [];
    for (const f of tiles.placements) {
      const cell = tiles.cell.map((v) => f.point(v) as [number, number]);
      for (let k = 0; k < cell.length; k++) {
        const u = P.point(cell[k]) as [number, number];
        const v = P.point(cell[(k + 1) % cell.length]) as [number, number];
        for (let i = 0; i <= 4000; i++) out.push(t.space.project(t.space.geodesic(u, v, i / 4000)) as [number, number]);
      }
    }
    return out;
  };
  const inkOn = (P: Placement | null): [number, number][] =>
    strokes(tiles).flatMap((sv) => inked(t, sv, P ? [{ placement: P }] : [])).flat()
      .filter((q) => q[0] >= 0 && q[0] <= 100 && q[1] >= 0 && q[1] <= 100);
  const TOP = 50 - (Math.PI / 2) * R;

  for (const d of [null, 0, 0.1, 0.5, 2]) {
    it(d === null ? 'inks the unmoved icosahedron within 0.1 mm of its geodesics' : `inks it within 0.1 mm of its geodesics carried ${d} from the pole`, () => {
      const P = d === null ? null : (() => {
        const [A, B] = tiles.cell;
        const from = t.station(t.space.geodesic(A, B, 0.5)).toward(B);
        return t.station([57, TOP + d]).placement({ from });
      })();
      const off = index(geodesics(P ?? { point: (p) => p }));
      const ink = inkOn(P);
      expect(ink.length).toBeGreaterThan(100);
      // The budget is two tolerances: the stored chord may bow the ink's
      // 0.05 mm where the chart is widest, and the ink draws the chord to
      // 0.05 mm again.
      let worst = 0;
      for (const q of ink) worst = Math.max(worst, off(q));
      expect(worst).toBeLessThan(0.1);
    });
  }

  // The same budget through the material: `m.transform` samples a moved
  // edge to the bow its door carries, in the metric, so the moved chords
  // are judged where no placement can change them.
  for (const d of [0, 0.1, 0.5, 2]) {
    it(`inks it moved by m.transform ${d} from the pole within 0.1 mm of its geodesics`, () => {
      const [A, B] = tiles.cell;
      const from = t.station(t.space.geodesic(A, B, 0.5)).toward(B);
      const P = t.station([57, TOP + d]).placement({ from });
      const off = index(geodesics(P));
      const ink = strokes(tiles.transform(P)).flatMap((sv) => inked(t, sv)).flat()
        .filter((q) => q[0] >= 0 && q[0] <= 100 && q[1] >= 0 && q[1] <= 100);
      expect(ink.length).toBeGreaterThan(100);
      let worst = 0;
      for (const q of ink) worst = Math.max(worst, off(q));
      expect(worst).toBeLessThan(0.1);
    });
  }
});
