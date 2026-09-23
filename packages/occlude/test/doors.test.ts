/**
 * Doors a sketch keeps hitting: every shape factory takes a point, a faced
 * material is an area, `within` keeps what touches, a face collection reads
 * like the other selections, and a lattice stands where it is told.
 *
 * Each case asks whether the new spelling means exactly what a neighbour
 * already means: the record form of a factory is the positional one, the
 * area of a tiling is the union of its faces, `'touching'` is any shared
 * point, and a moved lattice is the same lattice moved.
 */

import { describe, expect, it } from 'vitest';
import { toolkit } from './helpers/run.js';
import {
  ellipse, material, ngon, path, polygon, rect, type Execution, type Face, type FaceSelection, type ShapeValue, type Toolkit,
} from '../src/index.js';
import { hexes, triangles } from '../src/layout.js';

type Kit = Toolkit & { exec: Execution };

/** A shape through the material door: every chain's points and closure,
 * the geometry the engine draws. */
const lowered = (t: Kit, sv: ShapeValue) => t.material(sv).curves().map((c) => ({ pts: c.pts, closed: c.closed }));

describe('every shape factory takes a point', () => {
  const t = toolkit({ aspect: [1, 1] });
  const start = t.station(44, 53);
  /** [record form, positional form] — the value and the ink must agree. */
  const CASES: [string, ShapeValue, ShapeValue][] = [
    ['rect', rect([10, 20], 30, 15), rect(10, 20, 30, 15)],
    ['rect, a record and a radius', rect({ x: 10, y: 20 }, 30, 15, 4), rect(10, 20, 30, 15, 4)],
    ['rect, centred', rect([50, 50], 30, 15, { mode: 'center', pen: 'ink' }), rect(50, 50, 30, 15, { mode: 'center', pen: 'ink' })],
    ['rect, a radius and options', rect([10, 20], 30, 15, 3, { mode: 'center' }), rect(10, 20, 30, 15, 3, { mode: 'center' })],
    ['rect, a station', rect(start, 20, 10), rect(start.x, start.y, 20, 10)],
    ['ellipse', ellipse([50, 40], 20, 10), ellipse(50, 40, 20, 10)],
    ['ellipse, a rotation', ellipse({ x: 50, y: 40 }, 20, 10, 30), ellipse(50, 40, 20, 10, 30)],
    ['ellipse, options', ellipse([50, 40], 20, 10, { pen: 'ink' }), ellipse(50, 40, 20, 10, { pen: 'ink' })],
    ['ellipse, a station', ellipse(start, 8, 4, 15, { pen: 'ink' }), ellipse(start.x, start.y, 8, 4, 15, { pen: 'ink' })],
    ['ngon', ngon([50, 50], 6, 20), ngon(50, 50, 6, 20)],
    ['ngon, a rotation', ngon({ x: 50, y: 50 }, 5, 20, 18), ngon(50, 50, 5, 20, 18)],
    ['ngon, options', ngon([50, 50], 3, 20, { pen: 'ink' }), ngon(50, 50, 3, 20, { pen: 'ink' })],
    ['ngon, a station', ngon(start, 7, 9, 10, { pen: 'ink' }), ngon(start.x, start.y, 7, 9, 10, { pen: 'ink' })],
    [
      'path',
      path().moveTo([10, 10]).lineTo({ x: 40, y: 10 }).quadTo([50, 30], [40, 50]).bezierTo([30, 60], { x: 20, y: 60 }, [10, 50]).arcTo([10, 10], 25).close().build(),
      path().moveTo(10, 10).lineTo(40, 10).quadTo(50, 30, 40, 50).bezierTo(30, 60, 20, 60, 10, 50).arcTo(10, 10, 25).close().build(),
    ],
    [
      'path, a large arc and a station',
      path().moveTo(start).arcTo([70, 70], 20, { large: true }).build(),
      path().moveTo(start.x, start.y).arcTo(70, 70, 20, { large: true }).build(),
    ],
  ];
  for (const [name, record, positional] of CASES) {
    it(`${name}: the record form is the positional form`, () => {
      expect(record).toEqual(positional);
      expect(lowered(t, record)).toEqual(lowered(t, positional));
    });
  }
});

describe('a faced material is an area', () => {
  const t = toolkit({ aspect: [1, 1] });
  /** The loops a `polygon` drew, one per `move`. */
  const loopsOf = (sv: ShapeValue): [number, number][][] => {
    const out: [number, number][][] = [];
    for (const c of (sv.geom as { cmds: { op: string; x?: number; y?: number }[] }).cmds) {
      if (c.op === 'move') out.push([[c.x!, c.y!]]);
      else if (c.op === 'line') out[out.length - 1].push([c.x!, c.y!]);
    }
    return out;
  };

  it('a tiling draws its rim, the loops its faces answer', () => {
    const tiling = t.tiling(4, 4);
    expect(tiling.contours()).toHaveLength(0);
    const rim = tiling.faces().contours().map((c) => c.pts);
    expect(rim.length).toBeGreaterThan(0);
    expect(loopsOf(polygon(tiling))).toEqual(rim);
  });

  it('a hex field draws its rim, which is the drawable', () => {
    const cells = t.hexes({ spacing: 10 });
    const loops = loopsOf(polygon(cells));
    expect(loops).toEqual(cells.faces().contours().map((c) => c.pts));
    expect(loops).toHaveLength(1);
    const xs = loops[0].map((p) => p[0]);
    const ys = loops[0].map((p) => p[1]);
    const b = t.bounds();
    const box = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    [0, b.w, 0, b.h].forEach((v, k) => expect(box[k]).toBeCloseTo(v, 9));
  });

  it('a ring still draws its ring', () => {
    const ring = t.material(rect(10, 10, 30, 20));
    expect(loopsOf(polygon(ring))).toEqual(ring.contours().map((c) => c.pts));
  });

  it('a material with neither closed chains nor faces draws nothing, and does not throw', () => {
    // A cross: four arms from one vertex, branching and enclosing nothing.
    const cross = material([[50, 50], [60, 50], [50, 60], [40, 50], [50, 40]], { edges: [[0, 1], [0, 2], [0, 3], [0, 4]] });
    expect(cross.faces().length).toBe(0);
    expect(loopsOf(polygon(cross))).toEqual([]);
    expect(loopsOf(polygon(material([])))).toEqual([]);
  });

  it('a branching material whose edges cross without a vertex is refused by the consumer, with the way out', () => {
    const crossed = material([[0, 0], [10, 0], [5, 5], [5, -5], [20, 0]], { edges: [[0, 1], [2, 3], [1, 4], [1, 2]] });
    expect(() => polygon(crossed)).toThrow(/^polygon: faces: .*planarize\(\) first/);
  });

  it('within bounds points by a tiling rim, and distanceTo agrees', () => {
    const tiling = t.tiling(4, 4, { side: 20 });
    const pts = material([[50, 50], [5000, 5000], [-5000, 50]]).points;
    const kept = t.within(pts, tiling);
    expect(kept.map((p) => [p.x, p.y])).toEqual([[50, 50]]);
    expect(t.distanceTo(tiling)(50, 50)).toBeGreaterThan(0);
    expect(t.distanceTo(tiling)(5000, 5000)).toBeLessThan(0);
  });
});

describe("within keeps what touches", () => {
  const t = toolkit({ aspect: [1, 1] });
  // Two unit squares side by side, and an area over the right one and the
  // right part of the left one.
  const two = material(
    [[0, 0], [10, 0], [20, 0], [20, 10], [10, 10], [0, 10]],
    { edges: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 0], [1, 4]] },
  );
  const area: [number, number][] = [[7, -5], [30, -5], [30, 25], [7, 25]];
  const leftOf = (sel: FaceSelection) => sel.map((f) => f.centroid[0] < 10);

  it('a face half inside touches, and is neither contained nor centred', () => {
    const cells = two.faces();
    expect(leftOf(t.within(cells, area, { keep: 'touching' })).sort()).toEqual([false, true]);
    expect(leftOf(t.within(cells, area))).toEqual([false]);
    expect(leftOf(t.within(cells, area, { keep: 'centroid' }))).toEqual([false]);
  });

  it('an area wholly inside one big face touches that face', () => {
    const big = t.material(rect(0, 0, 100, 100)).planarize().faces();
    const small: [number, number][] = [[40, 40], [60, 40], [60, 60], [40, 60]];
    expect(t.within(big, small, { keep: 'touching' }).length).toBe(1);
    expect(t.within(big, small).length).toBe(0);
    // Far away, nothing is shared.
    expect(t.within(big, [[200, 200], [210, 200], [210, 210]], { keep: 'touching' }).length).toBe(0);
  });

  it('an edge crossing the boundary touches, and is not kept by its midpoint', () => {
    const m = material(
      [[0, 20], [10, 20], [0, 2], [14, -12], [40, 40], [50, 40], [8, 0], [12, 0]],
      { edges: [[0, 1], [2, 3], [4, 5], [6, 7]] },
    );
    const ends = (sel: { map<T>(fn: (e: { a: { x: number } }) => T): T[] }) => sel.map((e) => e.a.x);
    // (0,20)–(10,20) crosses x = 7 with its midpoint outside. (0,2)–(14,-12)
    // meets the area only at its corner (7,-5), exactly. (40,40)–(50,40) is
    // far outside. (8,0)–(12,0) is wholly inside.
    expect(ends(t.within(m.edges, area, { keep: 'touching' }))).toEqual([0, 0, 8]);
    // The second edge's middle IS the corner: on the boundary, which
    // belongs to the area under every `keep`.
    expect(ends(t.within(m.edges, area, { keep: 'centroid' }))).toEqual([0, 8]);
    expect(ends(t.within(m.edges, area))).toEqual([8]);
  });

  it('names the three words when the option is wrong', () => {
    expect(() => t.within(two.faces(), area, { keep: 'near' as 'touching' })).toThrow(/'contained', 'centroid' or 'touching'/);
    expect(() => t.within(two.edges, area, { keep: 'near' as 'touching' })).toThrow(/'contained', 'centroid' or 'touching'/);
  });
});

describe('a face collection reads like a point or edge selection', () => {
  const t = toolkit({ aspect: [1, 1] });
  const cells = t.hexes({ spacing: 20 }).faces();
  const whole = (f: Face) => f.adjacent.length === 6;
  for (const [name, collection] of [['Faces', cells], ['FaceSelection', cells.filter((f) => f.centroid[1] < 60)]] as const) {
    it(`${name}: map, find, some, every agree with the faces array; filter is a selection`, () => {
      // The members as a plain array, through iteration: `Faces` also keeps
      // its `faces` array, which must be that same list.
      const members = [...collection];
      if (collection === cells) expect(cells.faces).toEqual(members);
      expect(collection.length).toBe(members.length);
      expect(collection.map((f) => f.index)).toEqual(members.map((f) => f.index));
      expect(collection.find(whole)).toBe(members.find(whole));
      expect(collection.some(whole)).toBe(members.some(whole));
      expect(collection.every(whole)).toBe(members.every(whole));
      expect(collection.every((f) => f.area > 0)).toBe(true);
      expect(collection.at(1)).toBe(members[1]);
      const sel = collection.filter(whole);
      expect([...sel]).toEqual(members.filter(whole));
      expect(typeof sel.contours).toBe('function');
      expect(sel.groupBy((f) => (f.j as number) % 2).reduce((n, g) => n + g.length, 0)).toBe(sel.length);
    });
  }
});

describe('a lattice stands where it is told', () => {
  const env = { bounds: { w: 141.4, h: 100 }, len: (l: unknown) => l as number };
  const dump = (m: ReturnType<typeof hexes>) => ({
    pts: m.points.map((p) => [p.x, p.y]),
    faces: m.faces().map((f) => [f.i, f.j, f.contours()]),
  });
  /** Centres of the uncut cells — the largest area — by their i and j. */
  const centres = (m: ReturnType<typeof hexes>) => {
    const cells = m.faces().faces;
    const full = Math.max(...cells.map((f) => f.area));
    return new Map(cells.filter((f) => f.area > full * (1 - 1e-9)).map((f) => [`${f.i},${f.j}`, f.centroid] as const));
  };
  const drawableRim = (m: ReturnType<typeof hexes>) => {
    const rim = m.faces().contours();
    expect(rim).toHaveLength(1);
    const xs = rim[0].pts.map((p) => p[0]);
    const ys = rim[0].pts.map((p) => p[1]);
    const box = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    // The cut's own arithmetic: a crossing lands within a rounding of the edge.
    [0, env.bounds.w, 0, env.bounds.h].forEach((v, k) => expect(box[k]).toBeCloseTo(v, 9));
  };

  for (const [name, make] of [
    ['hexes', (o: object) => hexes(env, { spacing: 12, ...o })],
    ['triangles', (o: object) => triangles(env, { size: 12, ...o })],
  ] as const) {
    it(`${name}: the default is the user origin, unturned`, () => {
      expect(dump(make({ origin: [0, 0], rotate: 0 }))).toStrictEqual(dump(make({})));
      expect(dump(make({ origin: { x: 0, y: 0 } }))).toStrictEqual(dump(make({})));
    });

    it(`${name}: origin moves every cell by one vector and keeps i and j`, () => {
      const at = centres(make({}));
      const moved = centres(make({ origin: { x: 3.5, y: -2 } }));
      let shared = 0;
      for (const [key, [x, y]] of moved) {
        const c = at.get(key);
        if (!c) continue;
        shared++;
        expect(x - c[0]).toBeCloseTo(3.5, 9);
        expect(y - c[1]).toBeCloseTo(-2, 9);
      }
      expect(shared).toBeGreaterThan(20);
    });

    it(`${name}: a placed and turned lattice is still cut to the drawable`, () => {
      drawableRim(make({}));
      drawableRim(make({ origin: [30, 40], rotate: 17 }));
      drawableRim(make({ rotate: -90 }));
    });

    it(`${name}: a mid-edit placement lays out nothing`, () => {
      expect(make({ rotate: Number.NaN }).n).toBe(0);
      expect(make({ origin: [Number.NaN, 0] }).n).toBe(0);
    });
  }

  it('hexes: a quarter turn makes pointy cells flat, at the flat lattice centres', () => {
    // The turn keeps the pointy lattice's own i and j, which are not the
    // flat lattice's: the SET of centres and the cell shapes are the same.
    const r6 = (v: number) => String(Math.round(v * 1e6) / 1e6 + 0);
    const key = (f: Face) => `${r6(f.centroid[0])},${r6(f.centroid[1])}`;
    const turned = hexes(env, { spacing: 12, rotate: 90 }).faces();
    const uncut = turned.faces.filter((g) => Math.abs(g.area - (Math.sqrt(3) / 2) * 144) < 1e-9);
    expect(uncut.length).toBeGreaterThan(20);
    const flat = hexes(env, { spacing: 12, orientation: 'flat' }).faces();
    expect(turned.length).toBe(flat.length);
    expect(new Set(turned.map(key))).toEqual(new Set(flat.map(key)));
    const shape = (f: Face) =>
      f.contours()[0].pts.map(([x, y]) => `${r6(x - f.centroid[0])},${r6(y - f.centroid[1])}`).sort();
    const byKey = new Map(flat.map((f) => [key(f), f]));
    for (const f of uncut) expect(shape(f)).toEqual(shape(byKey.get(key(f))!));
    // The columns are the pointy lattice's own coordinates, turned with it:
    // the pointy centre (12·(i + j/2), 1.5·R·j) a quarter turn on.
    const R = 12 / Math.sqrt(3);
    for (const f of uncut) {
      const i = f.i as number;
      const j = f.j as number;
      expect(f.centroid[0]).toBeCloseTo(-1.5 * R * j, 9);
      expect(f.centroid[1]).toBeCloseTo(12 * (i + j / 2), 9);
    }
  });
});
