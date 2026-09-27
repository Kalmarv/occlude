/**
 * `Placement` — ONE isometry value for groups, materials, walks and
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
 * foreign door (another space's model, on a flat sheet) bends the chords
 * and says so by sampling them, and a walk is a placement stepped and
 * turned.
 */

import { describe, expect, it } from 'vitest';
import { toolkit } from './helpers/run.js';
import {
  circle, line, rect, space, spaceOf, group, strokes, type ShapeValue, type Toolkit,
} from '../src/index.js';
import { type Execution } from '../src/host.js';
import { material, type Material } from '../src/material.js';
import { between, framePlacement, identity, isPlacement, reflection, type ModelDoor, type Placement } from '../src/placement.js';
import { geodesicBow, lowerShape, lowerToUserContours, unitMm } from '../src/record.js';
import { Shape } from '../src/shapes.js';
import type { TransformOp } from '../src/execution.js';
import type { Space } from '../src/space.js';
import { xy } from './helpers/xy.js';
import { selectionIn } from '../src/selection.js';

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
  /** The placement at a frame: `(x, y)` facing `heading` radians. */
  const at = (x: number, y: number, heading: number): Placement => framePlacement(door, { x, y, heading });

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

  it('carries one frame onto another, exactly', () => {
    const from = at(46, 52, 0.4);
    const to = at(58, 44, -1.1);
    const P = between(door, from, to);
    const got = from.then(P);
    near([got.x, got.y], [to.x, to.y], 9);
    sameHeading(got.heading, to.heading, 9);
    expect(P.orientation).toBe(1);
    // The same isometry, spelled with the two placements alone.
    for (const p of PTS) near(from.inverse().then(to).point(p), P.point(p), 9);
    const M = between(door, from, to, { mirror: true });
    expect(M.orientation).toBe(-1);
    near([from.then(M).x, from.then(M).y], [to.x, to.y], 9);
  });

  it('is the frame it carries the origin to', () => {
    const P = at(43, 57, 0.8);
    near(P.point([0, 0]), [P.x, P.y], 9);
    const Q = reflection(door, MIRROR[0], MIRROR[1]).then(P);
    near(Q.point([0, 0]), [Q.x, Q.y], 9);
  });

  it('composes, inverts, and multiplies its handedness', () => {
    const a = reflection(door, MIRROR[0], MIRROR[1]);
    const b = between(door, at(50, 50, 0), at(57, 45, 0.7));
    for (const p of PTS) near(a.then(b).point(p), b.point(a.point(p)), 9);
    for (const p of PTS) near(a.then(a.inverse()).point(p), p, 9);
    expect(a.then(b).orientation).toBe(-1);
    expect(a.then(a).orientation).toBe(1);
    expect(b.then(b).orientation).toBe(1);
    expect(a.inverse().orientation).toBe(-1);
  });

  it('moves a walker so the walk commutes with the move', () => {
    const s = at(47, 53, 0.9);
    const ps: Placement[] = [
      reflection(door, MIRROR[0], MIRROR[1]),
      between(door, at(50, 50, 0), at(56, 47, -0.5)),
    ];
    for (const P of ps) {
      for (const d of [0, 6, -4]) {
        const one = s.then(P).step(d);
        const two = s.step(d).then(P);
        near([one.x, one.y], [two.x, two.y], 9);
        sameHeading(one.heading, two.heading, 9);
      }
      // A turn goes round the way the placement's hand goes round: an
      // isometry that keeps the hand carries +37 to +37, and a reflection
      // carries it to -37. That is what `orientation` IS, so it is the
      // factor the turn takes.
      for (const deg of [37, -90]) {
        const one = s.then(P).turn(P.orientation * deg);
        const two = s.turn(deg).then(P);
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

  it('refuses a walker of another space, by name', () => {
    const h = identity(disk().space.model);
    expect(() => framePlacement(ball().space.model, { x: 50, y: 50, heading: 0 }).then(h)).toThrow(/spherical/);
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

/** A material's SOURCE curve — the flat segment of every edge — sampled
 * finely and moved point by point: what a moved edge has to draw. */
function movedSource(m: Material, P: Placement, k = 64): [number, number][] {
  const out: [number, number][] = [];
  for (let e = 0; e < m.edgeCount; e++) {
    const a = m.edgeList[2 * e];
    const b = m.edgeList[2 * e + 1];
    for (let i = 0; i <= k; i++) {
      const q = P.point([m.x[a] + ((m.x[b] - m.x[a]) * i) / k, m.y[a] + ((m.y[b] - m.y[a]) * i) / k]);
      out.push([q[0], q[1]]);
    }
  }
  return out;
}

/** How far `q` stands from the nearest of `cloud`, in sketch coordinates. */
function offCloud(q: readonly number[], cloud: readonly (readonly number[])[]): number {
  let best = Infinity;
  for (const c of cloud) best = Math.min(best, Math.hypot(q[0] - c[0], q[1] - c[1]));
  return best;
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
  const P = between(t.space.model, { x: 50, y: 50, heading: 0 }, { x: 57, y: 46, heading: 0.6 });

  it('lowers a shape, and moves its material, onto the moved source curve', () => {
    // An isometry carries a geodesic onto a geodesic but not a coordinate
    // segment onto a coordinate segment, so each door samples its moved
    // source where it lands: the ink door the shape itself, `m.transform`
    // the material's own polyline. Each lies on its own moved source.
    for (const sv of [rect(38, 44, 19, 12), circle(56, 47, 14)]) {
      const source = t.material(sv);
      const moved = source.transform(P);
      // Every source vertex keeps its row and lands where the placement
      // puts it.
      for (let i = 0; i < source.n; i++) near(moved.points.map(xy)[i], P.point(source.points.map(xy)[i]), 9);
      for (const q of moved.points.map(xy)) expect(offCloud(q, movedSource(source, P))).toBeLessThan(0.06);
      const lowered = placedOutline(t, sv, { placement: P });
      expect(lowered.length).toBe(1);
      expect(lowered[0].closed).toBe(true);
      const fine = movedSource(t.material(sv, { tolerance: 1e-4 }), P);
      for (const q of lowered[0].pts) expect(offCloud(q, fine)).toBeLessThan(0.06);
    }
  });

  it('keeps every id, so a selection taken before the move rebinds', () => {
    const m = t.material(circle(50, 50, 20));
    const sel = m.points.rows([0, 1, 2, 3]);
    const moved = m.transform(P);
    const back = selectionIn(sel, moved);
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

describe('m.transform samples the moved curve, and keeps what it can', () => {
  it('moves a flat material vertex for vertex: a plane isometry keeps segments', () => {
    const t = flat();
    const m = t.material(rect(30, 30, 20, 10));
    const P = between(t.space.model, { x: 40, y: 35, heading: 0 }, { x: 58, y: 52, heading: 0.7 });
    const moved = m.transform(P);
    expect(moved.n).toBe(m.n);
    expect([...moved.pointIds]).toEqual([...m.pointIds]);
    expect([...moved.edgeIds]).toEqual([...m.edgeIds]);
  });

  for (const make of [disk, ball]) {
    it(`retires an edge it samples and keeps the rest, in ${make === disk ? 'the disk' : 'the sphere'}`, () => {
      const t = make();
      // A long straight run, far from the centre, carried a long way: its
      // coordinate segment does not stay one.
      const m = t.material(rect(20, 22, 40, 6)).points.set('w', (p) => p.x);
      const P = between(t.space.model, { x: 40, y: 25, heading: 0 }, { x: 80, y: 90, heading: 2 });
      const moved = m.transform(P);
      expect(moved.n).toBeGreaterThan(m.n);
      // Every source vertex keeps its row and its id; every sample after
      // them is a new vertex.
      expect([...moved.pointIds.slice(0, m.n)]).toEqual([...m.pointIds]);
      const old = new Set(m.pointIds);
      for (const id of moved.pointIds.slice(m.n)) expect(old.has(id)).toBe(false);
      // An edge is kept whole or retired; a retired edge's children carry
      // its lineage root, so every root is one the source had.
      const kept = new Set(moved.edgeIds);
      const roots = new Set(m.edgeRoots);
      for (const r of moved.edgeRoots) expect(roots.has(r)).toBe(true);
      let retired = 0;
      for (let e = 0; e < m.edgeCount; e++) {
        const children = [...moved.edgeRoots].filter((r) => r === m.edgeRoots[e]).length;
        if (kept.has(m.edgeIds[e])) expect(children).toBe(1);
        else { retired++; expect(children).toBeGreaterThan(1); }
      }
      expect(retired).toBeGreaterThan(0);
      // A point column is read at a sample by its policy: interpolated
      // along the source parameter, so it runs between its ends.
      const w = moved.attrs.w;
      for (let i = m.n; i < moved.n; i++) {
        expect(w[i]).toBeGreaterThanOrEqual(Math.min(...m.attrs.w) - 1e-9);
        expect(w[i]).toBeLessThanOrEqual(Math.max(...m.attrs.w) + 1e-9);
      }
      // A selection of vertices rebinds by id.
      const sel = m.points.rows([0, 1, 2, 3]);
      expect([...selectionIn(sel, moved).indices]).toEqual([0, 1, 2, 3]);
    });
  }

  it('carries the bow a stored chord may keep on a curved door, and none on the plane', () => {
    expect(flat().space.model.bow).toBeUndefined();
    for (const make of [disk, ball]) {
      const t = make();
      expect(t.space.model.bow).toBeGreaterThan(0);
      expect(t.space.model.bow).toBe(geodesicBow(t.space, t.exec.frame));
    }
    // A space built with no paper has no mm to judge a bow in.
    expect(spaceOf({ curvature: -1 / 2500 }).model.bow).toBeUndefined();
  });

  for (const make of [disk, ball]) {
    const where = make === disk ? 'the disk' : 'the sphere';
    it(`keeps a meridian carried along the base row one piece, in ${where}: its bow is zero`, () => {
      const t = make();
      // A column is a geodesic, and a move along the base row carries a
      // column onto a column: the moved chord IS the moved curve.
      const m = material([[44, 36], [44, 64]], { edges: [[0, 1]] });
      const P = between(t.space.model, { x: 50, y: 50, heading: 0 }, { x: 61, y: 50, heading: 0 });
      const moved = m.transform(P);
      expect(moved.n).toBe(2);
      expect(moved.edgeCount).toBe(1);
      near([moved.x[0], moved.y[0]], [55, 36], 9);
    });

    it(`samples a bent edge only to the door's bow, in ${where}`, () => {
      const t = make();
      const bow = t.space.model.bow!;
      const m = material([[36, 40], [64, 44]], { edges: [[0, 1]] });
      const P = between(t.space.model, { x: 40, y: 25, heading: 0 }, { x: 62, y: 70, heading: 1.2 });
      const moved = m.transform(P);
      expect(moved.edgeCount).toBeGreaterThan(1);
      // The moved source curve, and the metric bow of the chord over a
      // span of its parameter.
      const src = (s: number): [number, number] => P.point([36 + 28 * s, 40 + 4 * s]) as [number, number];
      const bowOver = (s0: number, s1: number): number => {
        const a = src(s0);
        const b = src(s1);
        return t.space.distance([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], src((s0 + s1) / 2));
      };
      // Each stored vertex is the source at a dyadic parameter.
      const along = (i: number): number => {
        for (let k = 0; k <= 4096; k++) {
          const q = src(k / 4096);
          if (Math.hypot(q[0] - moved.x[i], q[1] - moved.y[i]) < 1e-9) return k / 4096;
        }
        return NaN;
      };
      const spans = Array.from({ length: moved.edgeCount }, (_, e) => [along(moved.edgeList[2 * e]), along(moved.edgeList[2 * e + 1])]);
      for (const [s0, s1] of spans) {
        // Every stored chord is within the bow of the moved curve.
        expect(bowOver(s0, s1)).toBeLessThanOrEqual(bow);
        // And none is finer than it had to be: the parent it was halved
        // from — the aligned span twice as long — bowed over.
        const h = s1 - s0;
        const p0 = Math.floor(s0 / (2 * h)) * 2 * h;
        expect(bowOver(p0, p0 + 2 * h)).toBeGreaterThan(bow);
      }
    });
  }

  it('shares a distributed edge column over the children by their share', () => {
    const t = disk();
    const m = t.material(rect(20, 22, 40, 6)).edges.set('len', () => 1, { transfer: 'distribute' });
    const P = between(t.space.model, { x: 40, y: 25, heading: 0 }, { x: 80, y: 90, heading: 2 });
    const moved = m.transform(P);
    expect(moved.edgeCount).toBeGreaterThan(m.edgeCount);
    const sum = [...moved.edgeAttrs.len].reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(m.edgeCount, 9);
  });
});

describe('the door of another space bends the chords on a flat sheet', () => {
  it('samples a long line onto the true image, and grows the point count', () => {
    const t = flat();
    // A hyperbolic space the sketch built itself: its model is not the
    // flat sketch's, so its isometries are no isometries of the sheet.
    const door = spaceOf({ curvature: -1 / 2500, center: [50, 50], size: 50 }).model;
    // A move of the disk: the isometry taking the centre to an off-centre
    // frame. It is NOT an isometry of the sheet, so a straight line under
    // it draws as an arc of the picture.
    const from = { x: 50, y: 50, heading: 0 };
    const to = { x: 62, y: 44, heading: 0.5 };
    const P = between(door, from, to);
    const sv = line(22, 34, 78, 70);
    const plain = placedOutline(t, sv, {});
    const bent = placedOutline(t, sv, { placement: P });
    expect(plain[0].pts.length).toBe(2);
    expect(bent[0].pts.length).toBeGreaterThan(plain[0].pts.length);
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

describe('a walk is a placement', () => {
  it('starts at a point with a heading in degrees, in both point spellings', () => {
    const t = disk();
    const a = t.placement([46, 53], 90);
    const b = t.placement({ x: 46, y: 53 }, 90);
    expect(b.x).toBe(a.x);
    expect(b.y).toBe(a.y);
    // The placement's own field is in radians: every walk verb reads it.
    expect(a.heading).toBe(Math.PI / 2);
    expect(b.heading).toBe(Math.PI / 2);
    expect(t.placement([46, 53]).heading).toBe(0);
    expect(t.placement([46, 53]).door).toBe(t.space.model);
  });

  it('refuses a heading in an options record, and points at the spelling', () => {
    const t = disk();
    expect(() => t.placement([46, 53], { heading: 90 } as never)).toThrow(/t\.placement\(\[x, y\], 90\)/);
    expect(() => t.placement(46 as never)).toThrow(/expected a point/);
  });

  it('turns toward a place: the next step is nearer it', () => {
    for (const make of [flat, disk]) {
      const t = make();
      const s = t.placement([44, 58]);
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
    const s = t.placement([50, 50]);
    const anti = t.space.exp([50, 50], [Math.PI * t.space.radius, 0]);
    expect(() => s.toward(anti)).toThrow(/opposite this place/);
  });

  it('is the isometry that carries the origin frame to it', () => {
    for (const make of WORLDS.map((w) => w.make)) {
      const t = make();
      const s = t.placement([43, 57], 46);
      near(s.point([0, 0]), [s.x, s.y], 9);
      // A walked placement is still the isometry of its frame.
      const w = s.step(4).turn(30);
      near(w.point([0, 0]), [w.x, w.y], 9);
      const ahead = framePlacement(t.space.model, { x: 0, y: 0, heading: 0 }).then(w);
      sameHeading(ahead.heading, w.heading, 9);
    }
  });

  it('places a motif with its +x line along the heading, in a curved sketch', () => {
    const t = disk();
    const s = t.placement([58, 44], 40);
    const g = group(s, line(0, 0, 12, 0));
    expect(isPlacement(g.opts.placement!)).toBe(true);
    const P = g.opts.placement!;
    // The motif is authored about the ORIGIN, and the origin lands on the
    // placement.
    near(P.point([0, 0]), [s.x, s.y], 9);
    // The motif's own +x DIRECTION at the origin leaves along the heading.
    // It is the direction and not the far end: a coordinate row is an
    // equidistant curve, not a geodesic, so it leans away from the heading
    // the further along it a sketch reads.
    const tip = P.point([1e-6, 0]);
    const v = t.space.log([s.x, s.y], tip);
    sameHeading(Math.atan2(v[1], v[0]), s.heading, 6);
  });

  it('places a motif on the flat sheet where the old station frame did', () => {
    const t = flat();
    const s = t.placement([40, 60], 17);
    // offset [2, 1] in the frame, then turned 10 more and scaled 2.
    const g = group(s, group({ translate: [2, 1], rotate: 10, scale: 2 }, circle(0, 0, 3)));
    const h = (17 * Math.PI) / 180;
    const want: [number, number] = [40 + Math.cos(h) * 2 - Math.sin(h) * 1, 60 + Math.sin(h) * 2 + Math.cos(h) * 1];
    near(s.point([2, 1]), want, 9);
    expect(isPlacement(g.opts.placement!)).toBe(true);
  });

  it('p.placement() is the frame at a point that has a heading, and refuses one that has none', () => {
    const t = flat();
    const ring = t.material(circle(50, 50, 10));
    const p = ring.along({ count: 8 }).points.at(2);
    const P = p.placement();
    expect([P.x, P.y, P.heading]).toEqual([p.x, p.y, p.heading]);
    near(P.point([0, 0]), [p.x, p.y], 9);
    const q = ring.curves.at(0).points.at(3);
    expect(q.placement().heading).toBe(q.heading);
    expect(() => ring.points.at(0).placement()).toThrow(/p\.placement: this point has no heading/);
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
