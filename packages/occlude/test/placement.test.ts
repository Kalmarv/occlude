/**
 * `Placement` — ONE isometry value for groups, materials, stations and
 * tilings.
 *
 * The same eleven blocks run in all three geometries, because the whole
 * point is that there is one value and one arithmetic: an isometry is a
 * 3×3 on the model, `point` is `down(M·up(p))`, `then` is the matrix
 * product and `orientation` is the sign of the determinant. What each
 * geometry supplies is only its model door.
 *
 * The last blocks check the doors into the library: a placement in a
 * transform chain lowers the same points the material door hands back, a
 * foreign door (a hyperbolic PICTURE on a flat sheet) bends the chords and
 * says so by sampling them, and a station answers its own placement.
 */

import { describe, expect, it } from 'vitest';
import { toolkit } from './helpers/run.js';
import {
  circle, line, rect, space, group, strokes,
  type Execution, type ShapeValue, type Toolkit,
} from '../src/index.js';
import { stationAt } from '../src/material.js';
import { between, identity, isPlacement, pictureDoor, reflection, type ModelDoor, type Placement } from '../src/placement.js';
import { lowerShape, lowerToUserContours, unitMm } from '../src/record.js';
import { Shape } from '../src/shapes.js';
import type { TransformOp } from '../src/execution.js';
import type { Space } from '../src/space.js';

type Kit = Toolkit & { exec: Execution };

const flat = (): Kit => toolkit({ aspect: [1, 1] });
const disk = (): Kit => toolkit({ aspect: [1, 1], space: space.hyperbolic({ radius: 50 }) });
const ball = (): Kit => toolkit({ aspect: [1, 1], space: space.spherical({ radius: 30 }) });

/** The three geometries, each with the points the blocks below try. Every
 * point sits well inside the drawable, and on the sphere well inside one
 * hemisphere, so nothing here is asking about the far side. */
const WORLDS: { name: string; make: () => Kit }[] = [
  { name: 'the flat plane', make: flat },
  { name: 'the disk', make: disk },
  { name: 'the sphere', make: ball },
];

const PTS: [number, number][] = [[50, 50], [58, 46], [42, 57], [63, 61], [37, 41], [55, 38]];
/** Two points naming a geodesic to mirror in. */
const MIRROR: [[number, number], [number, number]] = [[44, 48], [57, 56]];

const near = (a: readonly number[], b: readonly number[], places: number): void => {
  expect(a[0]).toBeCloseTo(b[0], places);
  expect(a[1]).toBeCloseTo(b[1], places);
};

/** Two headings are the same direction, whichever turn they are written by. */
const sameHeading = (a: number, b: number, places: number): void => {
  const d = Math.atan2(Math.sin(a - b), Math.cos(a - b));
  expect(d).toBeCloseTo(0, places);
};

describe.each(WORLDS)('a placement of $name', ({ make }) => {
  const t = make();
  const door: ModelDoor = t.space.model;
  const sp: Space = t.space;

  it('has an identity that moves nothing', () => {
    const I = identity(door);
    for (const p of PTS) near(I.point(p), p, 12);
    expect(I.orientation).toBe(1);
  });

  it('mirrors in the geodesic through two points: an involution, orientation −1, and both points fixed', () => {
    const R = reflection(door, MIRROR[0], MIRROR[1]);
    expect(R.orientation).toBe(-1);
    near(R.point(MIRROR[0]), MIRROR[0], 9);
    near(R.point(MIRROR[1]), MIRROR[1], 9);
    for (const p of PTS) near(R.point(R.point(p)), p, 9);
    // An isometry keeps every distance of the space it belongs to.
    for (const a of PTS) {
      for (const b of PTS) {
        expect(sp.distance(R.point(a), R.point(b))).toBeCloseTo(sp.distance(a, b), 9);
      }
    }
  });

  it('refuses a mirror in one point twice, by name', () => {
    expect(() => reflection(door, [40, 40], [40, 40])).toThrow(/two distinct points/);
  });

  it('carries one station\'s frame onto another\'s, exactly', () => {
    const from = stationAt(46, 52, 0.4, sp);
    const to = stationAt(58, 44, -1.1, sp);
    const P = between(door, from, to);
    const got = P.station(from);
    near([got.x, got.y], [to.x, to.y], 9);
    sameHeading(got.heading, to.heading, 9);
    expect(P.orientation).toBe(1);
    const M = between(door, from, to, { mirror: true });
    expect(M.orientation).toBe(-1);
    near([M.station(from).x, M.station(from).y], [to.x, to.y], 9);
  });

  it('composes, inverts, and multiplies its handedness', () => {
    const a = reflection(door, MIRROR[0], MIRROR[1]);
    const b = between(door, stationAt(50, 50, 0, sp), stationAt(57, 45, 0.7, sp));
    for (const p of PTS) near(a.then(b).point(p), b.point(a.point(p)), 9);
    for (const p of PTS) near(a.then(a.inverse()).point(p), p, 9);
    expect(a.then(b).orientation).toBe(-1);
    expect(a.then(a).orientation).toBe(1);
    expect(b.then(b).orientation).toBe(1);
    expect(a.inverse().orientation).toBe(-1);
  });

  it('transports a station so the walk commutes with the move', () => {
    const s = stationAt(47, 53, 0.9, sp);
    const ps: Placement[] = [
      reflection(door, MIRROR[0], MIRROR[1]),
      between(door, stationAt(50, 50, 0, sp), stationAt(56, 47, -0.5, sp)),
    ];
    for (const P of ps) {
      for (const d of [0, 6, -4]) {
        const one = P.station(s).step(d);
        const two = P.station(s.step(d));
        near([one.x, one.y], [two.x, two.y], 9);
        sameHeading(one.heading, two.heading, 9);
      }
      // A turn goes round the way the placement's hand goes round: an
      // isometry that keeps the hand carries +37 to +37, and a reflection
      // carries it to -37. That is what `orientation` IS, so it is the
      // factor the turn takes.
      for (const deg of [37, -90]) {
        const one = P.station(s).turn(P.orientation * deg);
        const two = P.station(s.turn(deg));
        near([one.x, one.y], [two.x, two.y], 9);
        sameHeading(one.heading, two.heading, 9);
      }
    }
  });

  it('is a value and not a function', () => {
    const P = identity(door);
    expect(typeof P).toBe('object');
    expect(isPlacement(P)).toBe(true);
    expect(isPlacement(() => [0, 0])).toBe(false);
    expect(isPlacement({ door })).toBe(false);
    expect(Object.isFrozen(P)).toBe(true);
  });
});

describe('two geometries cannot meet', () => {
  it('names both kinds when one placement would follow the other', () => {
    const h = identity(disk().space.model);
    const s = identity(ball().space.model);
    expect(() => h.then(s)).toThrow(/hyperbolic/);
    expect(() => h.then(s)).toThrow(/spherical/);
    expect(() => s.then(h)).toThrow(/spherical/);
    expect(() => s.then(h)).toThrow(/hyperbolic/);
  });

  it('refuses a station of another space, by name', () => {
    const h = identity(disk().space.model);
    expect(() => h.station(stationAt(50, 50, 0, ball().space))).toThrow(/spherical/);
  });
});

// ---- the doors into the library --------------------------------------------

/** A shape's outlines under one transform op, lowered the way the ink door
 * lowers them, in sketch units. */
function placedOutline(t: Kit, sv: ShapeValue, op: Parameters<typeof lowerToUserContours>[1]): { pts: [number, number][]; closed: boolean }[] {
  const frame = t.exec.frame;
  const unit = unitMm(frame);
  return lowerToUserContours(sv.geom, op, frame).map((c) => ({
    closed: c.closed,
    pts: c.pts.map(([x, y]) => [x / unit, y / unit] as [number, number]),
  }));
}

/** A shape under a whole transform CHAIN, lowered the way the ink door
 * lowers it, in sketch units. The chain is written outermost first, which
 * is how a drawing tree nests it. */
function inked(t: Kit, chain: TransformOp[], sv: ShapeValue): [number, number][] {
  const exec = t.exec;
  let shape!: Shape;
  const run = (i: number): void => {
    if (i === chain.length) {
      shape = new Shape(sv.geom, exec);
      return;
    }
    exec.push(chain[i], () => run(i + 1));
  };
  run(0);
  const frame = exec.frame;
  const unit = unitMm(frame);
  const pts: [number, number][] = [];
  for (const contour of lowerShape(shape, frame).contours) {
    for (const prim of contour) {
      if (prim.t !== 'line') continue;
      if (pts.length === 0) pts.push([(prim.x0 - frame.offsetX) / unit, (prim.y0 - frame.offsetY) / unit]);
      pts.push([(prim.x1 - frame.offsetX) / unit, (prim.y1 - frame.offsetY) / unit]);
    }
  }
  return pts;
}

describe.each(WORLDS)('a placement in a drawing chain, in $name', ({ make }) => {
  const t = make();
  const P = between(t.space.model, stationAt(50, 50, 0, t.space), stationAt(57, 46, 0.6, t.space));

  it('lowers a shape to the very points the material door hands back', () => {
    for (const sv of [rect(38, 44, 19, 12), circle(56, 47, 14)]) {
      const moved = t.material(sv).transform(P);
      const lowered = placedOutline(t, sv, { placement: P });
      expect(lowered.length).toBe(1);
      expect(lowered[0].closed).toBe(true);
      // `t.material` drops the repeated seam vertex; the lowerer keeps it.
      const want = moved.pts;
      const got = lowered[0].pts;
      expect(got.length).toBeGreaterThanOrEqual(want.length);
      for (let i = 0; i < want.length; i++) near(got[i], want[i], 9);
    }
  });

  it('keeps every id, so a selection taken before the move rebinds', () => {
    const m = t.material(circle(50, 50, 20));
    const sel = m.points.rows([0, 1, 2, 3]);
    const moved = m.transform(P);
    const back = sel.in(moved);
    expect([...back.indices]).toEqual([...sel.indices]);
  });

  it('puts a deforming group inside a placing one, and that is the order', () => {
    // `group(P, group({ scale: 0.5 }, motif))` is `group(P, motif-at-half)`.
    const nested = inked(t, [{ placement: P }, { scale: 0.5, origin: [50, 50] }], rect(42, 45, 16, 10));
    const plain = inked(t, [{ placement: P }], rect(46, 47.5, 8, 5));
    expect(nested.length).toBe(plain.length);
    for (let i = 0; i < plain.length; i++) {
      // One snap step of the 0.005 mm grid is all the two may differ by.
      expect(Math.abs(nested[i][0] - plain[i][0])).toBeLessThan(0.006);
      expect(Math.abs(nested[i][1] - plain[i][1])).toBeLessThan(0.006);
    }
  });

  it('refuses a placement and a deformation in one group, by name', () => {
    expect(() => group({ placement: P, translate: [3, 4] }, circle(50, 50, 5))).toThrow(/nest groups/);
    expect(() => group({ placement: P, rotate: 30 }, circle(50, 50, 5))).toThrow(/nest groups/);
    expect(() => group({ placement: P, scale: 2 }, circle(50, 50, 5))).toThrow(/nest groups/);
    expect(() => group({ placement: P, origin: 'center' }, circle(50, 50, 5))).toThrow(/nest groups/);
  });

  it('takes a placement in place of the options record', () => {
    const g = group(P, circle(50, 50, 5));
    expect(g.opts.placement).toBe(P);
    expect(g.children.length).toBe(1);
  });

  it('refuses anything but a placement on m.transform, by name', () => {
    expect(() => t.material(circle(50, 50, 5)).transform(((p: number[]) => p) as never)).toThrow(/m\.transform/);
  });
});

describe('a picture door on a flat sheet bends the chords', () => {
  it('samples a long line onto the true image, and grows the point count', () => {
    const t = flat();
    const door = pictureDoor('hyperbolic', [50, 50], 50);
    // A move of the disk: the isometry taking the centre to an off-centre
    // station. It is NOT an isometry of the sheet, so a straight line under
    // it draws as an arc of the picture.
    const from = stationAt(50, 50, 0, undefined);
    const to = stationAt(62, 44, 0.5, undefined);
    const P = between(door, from, to);
    const sv = line(22, 34, 78, 70);
    const plain = placedOutline(t, sv, {});
    const bent = placedOutline(t, sv, { placement: P });
    expect(plain[0].pts.length).toBe(2);
    expect(bent[0].pts.length).toBeGreaterThan(8);
    // The true image, sampled finely in the line's own parameter: every
    // lowered point lies on it, and the lowered chords never run further
    // than 0.05 from it.
    const truth: [number, number][] = [];
    for (let i = 0; i <= 4000; i++) {
      const u = i / 4000;
      truth.push(P.point([22 + (78 - 22) * u, 34 + (70 - 34) * u]) as [number, number]);
    }
    const off = (p: readonly [number, number]): number => {
      let best = Infinity;
      for (const q of truth) best = Math.min(best, Math.hypot(q[0] - p[0], q[1] - p[1]));
      return best;
    };
    for (const p of bent[0].pts) expect(off(p)).toBeLessThan(0.05);
    // The chord midpoints too: that is what the sampling promises.
    for (let i = 1; i < bent[0].pts.length; i++) {
      const a = bent[0].pts[i - 1];
      const b = bent[0].pts[i];
      expect(off([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2])).toBeLessThan(0.05);
    }
  });
});

describe('a station answers its own isometry', () => {
  it('reads a heading in radians positionally and in degrees from a record', () => {
    const t = disk();
    const a = t.station(46, 53, Math.PI / 2);
    const b = t.station([46, 53], { heading: 90 });
    expect(b.x).toBe(a.x);
    expect(b.y).toBe(a.y);
    sameHeading(b.heading, a.heading, 12);
    expect(t.station({ x: 46, y: 53 }).heading).toBe(0);
    expect(t.station([46, 53]).space).toBe(t.space);
  });

  it('turns toward a place: the next step is nearer it', () => {
    for (const make of [flat, disk]) {
      const t = make();
      const s = t.station(44, 58);
      const target: [number, number] = [61, 43];
      const aimed = s.toward(target);
      const sp = t.space;
      expect(sp.distance([aimed.step(3).x, aimed.step(3).y], target))
        .toBeLessThan(sp.distance([s.x, s.y], target));
      // The same place names no direction, so the heading stands.
      expect(s.toward([s.x, s.y]).heading).toBe(s.heading);
    }
  });

  it('refuses the place opposite it on the sphere, by name', () => {
    const t = ball();
    const s = t.station(50, 50);
    const anti = t.space.exp([50, 50], [Math.PI * t.space.radius, 0]);
    expect(() => s.toward(anti)).toThrow(/opposite this station/);
  });

  it('is the isometry that carries the origin station to it', () => {
    for (const make of WORLDS.map((w) => w.make)) {
      const t = make();
      const s = t.station(43, 57, 0.8);
      const P = s.placement();
      const origin = stationAt(0, 0, 0, t.space);
      const got = P.station(origin);
      near([got.x, got.y], [s.x, s.y], 9);
      sameHeading(got.heading, s.heading, 9);
      // `from` names another source frame.
      const other = t.station(61, 39, -0.3);
      near([other.placement({ from: s }).station(s).x, other.placement({ from: s }).station(s).y], [other.x, other.y], 9);
    }
  });

  it('places a motif with its +x line along the heading, in a curved sketch', () => {
    const t = disk();
    const s = t.station(58, 44, 0.7);
    const g = s.place(line(0, 0, 12, 0));
    expect(isPlacement(g.opts.placement!)).toBe(true);
    const P = g.opts.placement!;
    // The motif is authored about the ORIGIN, and the origin lands on the
    // station.
    near(P.point([0, 0]), [s.x, s.y], 9);
    // The motif's own +x DIRECTION at the origin leaves the station along
    // its heading. It is the direction and not the far end: a coordinate
    // row is an equidistant curve, not a geodesic, so it leans away from
    // the heading the further along it a sketch reads.
    const tip = P.point([1e-6, 0]);
    const v = t.space.log([s.x, s.y], tip);
    sameHeading(Math.atan2(v[1], v[0]), s.heading, 6);
  });

  it('keeps the flat emission exactly as it was', () => {
    const t = flat();
    const g = t.station(40, 60, 0.3).place(circle(0, 0, 3), { offset: [2, 1], rotate: 10, scale: 2 });
    expect(g.opts.placement).toBeUndefined();
    expect(g.opts.rotate).toBeCloseTo((0.3 * 180) / Math.PI + 10, 12);
    expect(g.opts.scale).toEqual([2, 2]);
  });
});

describe('a tiling hands back placements', () => {
  it('answers isometries, not functions, and the identity is first', () => {
    const t = disk();
    const tl = t.tiling(5, 4, { depth: 2 });
    for (const p of tl.placements) expect(isPlacement(p)).toBe(true);
    for (const v of tl.cell) near(tl.placements[0].point(v), v, 9);
    // An odd generation turns the plane over, and the placement says so.
    expect(tl.placements.slice(1, 6).every((p) => p.orientation === -1)).toBe(true);
  });

  it('places a whole material with one of them', () => {
    const t = disk();
    const tl = t.tiling(5, 4, { depth: 1 });
    const m = t.material(circle(t.space.center[0], t.space.center[1], 6));
    const moved = m.transform(tl.placements[1]);
    expect(moved.n).toBe(m.n);
    // The copy is a rigid move of the space the sketch draws in.
    for (let i = 1; i < m.n; i++) {
      expect(t.space.distance([moved.x[i - 1], moved.y[i - 1]], [moved.x[i], moved.y[i]]))
        .toBeCloseTo(t.space.distance([m.x[i - 1], m.y[i - 1]], [m.x[i], m.y[i]]), 7);
    }
    expect(strokes(moved)).toBeTruthy();
  });
});
