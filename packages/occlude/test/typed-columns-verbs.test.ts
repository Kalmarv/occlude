/**
 * Every kind of column survives every verb that rebuilds a geometry (spec 74,
 * WP1: one store-level row builder). A number and a vector interpolate by the
 * column's policy; a boolean, a string, a reference and a placement never do —
 * a row made between two rows takes the nearer one's value; an edge made from
 * an edge takes its values. The verbs are the ones that used to rebuild from
 * the numeric flats and dropped the other kinds (bugs#1, promises#2).
 */
import { describe, expect, it } from 'vitest';
import { rect } from '../src/api.js';
import { append, curve, material, type Material } from '../src/index.js';
import { materialFromParts, withinMaterial, type Edge, type Vertex } from '../src/material.js';
import { between, isPlacement, identity, type Placement } from '../src/placement.js';
import { space } from '../src/space.js';
import { restamp } from '../src/tables.js';
import { viewKind } from '../src/views.js';
import { toolkit } from './helpers/run.js';

const PLACE: Placement = identity(toolkit().space.model);

/** Every kind on points and on edges: a number, a string, a boolean, a
 * vector, a reference and a placement. */
function typed(m: Material): Material {
  const first = m.points.at(0);
  return m.points
    .set({ h: (p: Vertex) => p.x, tag: (p: Vertex) => `p${p.index}`, on: (p: Vertex) => p.index % 2 === 0, v: (p: Vertex) => [p.x, 1], ref: first, pl: PLACE })
    .edges.set({ w: (e: Edge) => e.index, lab: (e: Edge) => `e${e.index}`, ok: true, ev: (e: Edge) => [e.index, 2], eref: first, epl: PLACE });
}

const POINT_COLS = ['h', 'tag', 'on', 'v', 'ref', 'pl'];
const EDGE_COLS = ['w', 'lab', 'ok', 'ev', 'eref', 'epl'];

/** Every point and every edge reads every column, each of its kind. */
function expectTyped(m: Material, edges = true): void {
  expect(m.points.length).toBeGreaterThan(0);
  for (const p of m.points) {
    expect(typeof p.h).toBe('number');
    expect(p.tag).toMatch(/^p\d+$/);
    expect(typeof p.on).toBe('boolean');
    expect(p.v).toHaveLength(2);
    expect(p.ref === null || viewKind(p.ref) === 'vertex').toBe(true);
    expect(isPlacement(p.pl)).toBe(true);
  }
  if (!edges) return;
  expect(m.edges.length).toBeGreaterThan(0);
  for (const e of m.edges) {
    expect(typeof e.w).toBe('number');
    expect(e.lab).toMatch(/^e\d+$/);
    expect(e.ok).toBe(true);
    expect(e.ev).toHaveLength(2);
    expect(e.ev[1]).toBe(2);
    expect(e.eref === null || viewKind(e.eref) === 'vertex').toBe(true);
    expect(isPlacement(e.epl)).toBe(true);
  }
}

const ring = (): Material => typed(curve([[0, 0], [40, 0], [40, 30], [0, 30]], { closed: true }));
const chain = (): Material => typed(curve([[0, 0], [20, 5], [40, 0], [60, 5]]));
/** Two chains that cross once. */
const cross = (): Material => typed(append(curve([[0, 0], [40, 40]]), curve([[0, 40], [40, 0]])));

describe('every kind of column survives every rebuild', () => {
  it('resample: a vector interpolates, the other kinds take the nearer row', () => {
    const out = ring().resample({ count: 9 });
    expectTyped(out);
    // A straight edge, so `v`'s first number, which is x at the source rows,
    // is x at every new row.
    for (const p of out.points) expect(p.v[0]).toBeCloseTo(p.x, 9);
    // The whole value is new rows: a reference to a source row names nothing.
    expect(out.points.at(0).ref).toBe(null);
    const r = ring();
    const partial = r.resample({ count: 6, where: r.edges.filter((e) => e.index === 0) });
    expectTyped(partial);
    // The nearer row's value, the first on a tie.
    const ab = curve([[0, 0], [10, 0]]).points.set('tag', (p: Vertex) => (p.index === 0 ? 'a' : 'b'));
    expect(ab.resample({ count: 5 }).points.map((p) => p.tag)).toEqual(['a', 'a', 'a', 'b', 'b']);
    // Outside the run the rows are the rows they were, and so is a reference.
    expect(partial.points.at(1).ref).toBe(partial.points.at(0));
  });

  it('spline, trim, curve', () => {
    expectTyped(ring().spline());
    expectTyped(chain().trim({ start: 3, end: 2 }));
    const through = curve(chain().points);
    expectTyped(through, false);
    expect(through.edges.length).toBe(3);
  });

  it('along: a point reads the point columns and the edge columns under it', () => {
    const out = chain().along({ count: 7 });
    for (const p of out.points) {
      for (const name of [...POINT_COLS, ...EDGE_COLS, 's', 'u', 'heading']) expect(p[name]).not.toBe(undefined);
      expect(p.v[0]).toBeCloseTo(p.x, 9);
      expect(p.lab).toMatch(/^e\d+$/);
    }
  });

  it('within, planarize, merge, interlace', () => {
    expectTyped(withinMaterial(ring(), [[[10, -5], [30, -5], [30, 40], [10, 40]]]));
    const flat = cross().planarize();
    expect(flat.points.length).toBe(5);
    expectTyped(flat);
    expectTyped(append(ring(), ring()).merge());
    expectTyped(cross().interlace({ gap: 2 }));
  });

  it('oscillate, warp, a face walked the other way round', () => {
    expectTyped(chain().oscillate({ wavelength: 8, amplitude: 1 }));
    const cage = { from: [[-1, -1], [41, -1], [41, 31], [-1, 31]] as [number, number][], to: [[-1, -1], [41, 5], [41, 31], [-1, 31]] as [number, number][] };
    expectTyped(ring().warp(cage));
    // Drawn clockwise: the extracted face's walls are turned to run round it.
    const cw = typed(curve([[0, 0], [0, 30], [40, 30], [40, 0]], { closed: true }));
    const face = cw.faces.at(0).extract();
    expectTyped(face);
  });

  it('a transform that samples its edges', () => {
    const t = toolkit({ aspect: [1, 1], space: space.hyperbolic({ radius: 50 }) });
    const m = typed(t.material(rect(20, 22, 40, 6)));
    const moved = m.transform(between(t.space.model, { x: 40, y: 25, heading: 0 }, { x: 80, y: 90, heading: 2 }));
    expect(moved.points.length).toBeGreaterThan(m.points.length);
    expectTyped(moved);
    // A vertex that came through is the vertex it was, and so is its reference.
    expect(moved.points.at(1).ref).toBe(moved.points.at(0));
  });

  it('relax and settle', () => {
    const t = toolkit();
    const cloud = typed(material([[50, 50], [60, 52], [55, 70], [80, 40]]));
    expectTyped(t.relax(cloud, { iterations: 2 }), false);
    const settled = t.settle(cloud.points.extract(), { density: () => 1, spacing: 40, iterations: 3 });
    expectTyped(settled, false);
  });

  it('a vector column that distributes is shared out, and a rule for numbers is refused by name on it', () => {
    const m = curve([[0, 0], [10, 0], [20, 0]]).edges.set('ev', [2, 4], { transfer: 'distribute' });
    const out = m.resample({ count: 5 });
    const sum = [0, 0];
    for (const e of out.edges) {
      sum[0] += e.ev[0];
      sum[1] += e.ev[1];
    }
    expect(sum[0]).toBeCloseTo(4, 12);
    expect(sum[1]).toBeCloseTo(8, 12);
    expect(() => ring().resample({ count: 5, transfer: { tag: 0 } })).toThrow(/resample: the transfer of 'tag' is a number, a rule for a column of numbers/);
  });
});

describe('a value keeps its key', () => {
  it('through a write, an extract, a move, a transform, a resample and a step', () => {
    const m = materialFromParts({ x: [0, 10, 10, 0], y: [0, 0, 10, 10], edges: [0, 1, 1, 2, 2, 3, 3, 0], key: 'crate' });
    expect(m.key).toBe('crate');
    expect(m.points.add([5, 5]).key).toBe('crate');
    expect(m.points.filter((p) => p.x > 0).extract().key).toBe('crate');
    expect(m.faces.at(0).extract().key).toBe('crate');
    expect(m.move([1, 2]).key).toBe('crate');
    expect(m.translate([3, 0]).rotate(30).key).toBe('crate');
    expect(m.resample({ count: 8 }).key).toBe('crate');
    expect(restamp(m, 3).key).toBe('crate');
    // A value nothing named has none, and a key is not a column.
    expect(material([[0, 0]]).key).toBe(undefined);
    expect(Object.keys(m)).not.toContain('key');
  });
});
