import { describe, expect, it } from 'vitest';
import { append, connect, curve, material } from '../src/index.js';
import { toolkit } from './helpers/run.js';
import { rec } from './helpers/xy.js';
import { seg } from './helpers/shapes.js';


describe('transfer contracts (con2 stage B)', () => {
  it('point columns: a continuous column interpolates and a categorical one copies through split, resample and extract', () => {
    const m = curve([[0, 0], [10, 0], [20, 0]], { closed: false })
      .points.set('age', (p) => p.index * 10)
      .points.set('kind', (p) => (p.index < 1 ? 1 : 2), { transfer: 'nearest' });
    const split = m.split(m.edge(0), 0.25);
    // The new point is a new row, at the end.
    expect(split.attrs.age[3]).toBeCloseTo(2.5);
    expect(split.attrs.kind[3]).toBe(1); // nearest: the start
    const rs = split.resample({ count: 9 });
    expect(rs.transfers.kind).toBe('nearest');
    expect(Array.from(rs.attrs.kind).every((v) => v === 1 || v === 2)).toBe(true);
    expect(rs.attrs.age[4]).toBeCloseTo(10, 6);
    const ex = rs.edges.filter((e) => e.index < 4).extract();
    expect(ex.transfers.kind).toBe('nearest');
    // an explicit per-operation rule wins over the policy for that call only
    // It says what a NEW vertex gets: the two ends are kept, as they were.
    const forced = split.resample({ count: 5, transfer: { kind: 7 } });
    expect(Array.from(forced.attrs.kind)).toEqual([1, 7, 7, 7, 2]);
    expect(forced.transfers.kind).toBe('nearest');
  });

  it("edge columns: 'copy' is categorical, 'distribute' is a length share — split, planarize, resample across several source edges", () => {
    const base = material([[0, 0], [10, 0], [20, 0]], { edges: [[0, 1], [1, 2]] })
      .edges.set('pen', (e) => e.index + 1)
      .edges.set('rest', (e) => (e.index === 0 ? 10 : 30), { transfer: 'distribute' });
    expect(base.edgeTransfers).toEqual({ rest: 'distribute' });
    // split at 0.25: the copy column repeats, the distributed one shares 10
    // into 2.5 + 7.5; the first child takes the parent's row, the second
    // goes last
    const split = base.split(base.edge(0), 0.25);
    expect(Array.from(split.edgeAttrs.pen)).toEqual([1, 2, 1]);
    expect(Array.from(split.edgeAttrs.rest)).toEqual([2.5, 30, 7.5]);
    expect(split.edgeTransfers.rest).toBe('distribute');
    // resample into 4 edges of 5 mm each: each covers half a source edge → 5, 5, 15, 15; pen by midpoint
    const rs = base.resample({ count: 5 });
    expect(Array.from(rs.edgeAttrs.rest).map((v) => +v.toFixed(9))).toEqual([5, 5, 15, 15]);
    expect(Array.from(rs.edgeAttrs.pen)).toEqual([1, 1, 2, 2]);
    // a new edge spanning both source edges sums its shares: 2 edges of 10 → [0,10] covers all of edge 0 → 10; [10,20] → 30
    const two = base.resample({ count: 3 });
    expect(Array.from(two.edgeAttrs.rest).map((v) => +v.toFixed(9))).toEqual([10, 30]);
    // and three edges over 20 mm: [0,6.67]=6.67 of 10 → 6.67; [6.67,13.33] = 3.33 of 10 + 3.33 of 30 = 3.33+10; [13.33,20] = 20
    const three = base.resample({ count: 4 });
    const r = Array.from(three.edgeAttrs.rest);
    expect(r[0] + r[1] + r[2]).toBeCloseTo(40, 6); // the total is conserved
    expect(r[1]).toBeCloseTo(10 * (1 / 3) + 30 * (1 / 3), 6);
    // planarize shares too
    const cross = append(seg([0, 0], [10, 10]), seg([0, 10], [10, 0])).edges.set('rest', 8, { transfer: 'distribute' });
    expect(Array.from(cross.planarize().edgeAttrs.rest)).toEqual([4, 4, 4, 4]);
    // a value update keeps the policy; explicit copy restores the default; append compares effective policies
    expect(base.edges.set('rest', 1).edgeTransfers.rest).toBe('distribute');
    expect(base.edges.set('rest', 1, { transfer: 'copy' }).edgeTransfers.rest).toBeUndefined();
    // a declaration names the domain's own policies
    expect(() => base.edges.set('rest', 1, { transfer: 'nearest' as never })).toThrow(/'copy' or 'distribute'/);
    expect(() => base.points.set('age', 1, { transfer: 'distribute' as never })).toThrow(/'interpolate' or 'nearest'/);
    expect(() => base.points.set('x', 1, { transfer: 'nearest' })).toThrow(/a position has no transfer policy/);
    expect(() => base.edges.set('rest', 1, { fallback: 0 } as never)).toThrow(/option of a face column/);
    // the options record comes last, after a where; nothing in the where still declares
    expect(base.edges.set('rest', 1, base.edge(0), { transfer: 'copy' }).edgeTransfers.rest).toBeUndefined();
    expect(Array.from(base.edges.set('rest', 1, base.edge(0), { transfer: 'distribute' }).edgeAttrs.rest)).toEqual([1, 30]);
    expect(base.edges.set('rest', 1, undefined, { transfer: 'copy' }).edgeTransfers.rest).toBeUndefined();
    const other = material([[30, 0], [40, 0]], { edges: [[0, 1]] }).edges.set({ pen: 1, rest: 5 });
    expect(() => append(base, other)).toThrow(/edge column 'rest'/);
  });

  it('crossings: agreeing candidates pass, disagreeing ones take the first edge\'s value unless the resolver says, whatever the policy', () => {
    const a = seg([0, 0], [10, 10]).points.set('kind', 1, { transfer: 'nearest' });
    const b = seg([0, 10], [10, 0]).points.set('kind', 1, { transfer: 'nearest' });
    expect(append(a, b).planarize().attrs.kind[4]).toBe(1);
    const c = seg([0, 10], [10, 0]).points.set('kind', 2, { transfer: 'nearest' });
    expect(append(a, c).planarize().attrs.kind[4]).toBe(1);
    expect(append(a, c).planarize({ point: () => ({ kind: 9 }) }).attrs.kind[4]).toBe(9);
  });

  it('writes take a selection of this state — for points, edges and splits — and re-bind an earlier one', () => {
    const m = curve([[0, 0], [10, 0], [20, 0], [30, 0]], { closed: false, active: [1, 0, 1, 0] });
    const stale = m.points.filter((p) => p.active === 1);
    const tips = m.points.filter((p) => p.active === 1);
    const longEdges = m.edges.filter((e) => e.index >= 1);
    const out = m.move([0, 5], tips).points.set('active', 2, tips).split(longEdges).edges.remove(m.edges.filter((e) => e.index === 0));
    // rows 0 and 2 moved and set; the cuts of edges 1 and 2 are new rows at
    // the end, and interpolate the MOVED and written state
    expect(Array.from(out.y)).toEqual([5, 0, 5, 0, 2.5, 2.5]);
    expect(Array.from(out.attrs.active)).toEqual([2, 0, 2, 0, 1, 1]);
    expect(out.edgeCount).toBe(4); // edge 0 gone; edges 1 and 2 split into two each
    // A selection made before the writes is about the same points, so the
    // verb takes it and moves them.
    const rebound = out.move([1, 0], stale);
    for (const i of stale.indices) expect(rebound.x[i]).toBe(out.x[i] + 1);
    expect(() => m.points.remove(m.edges.filter(() => true) as never)).toThrow(/points\.remove: a point selection combines only with a point selection — got an edge selection; its points are sel\.points/);
  });

  it('edges by view or value; vertex accessors take rows or views of this state', () => {
    const m = curve([[0, 0], [10, 0], [20, 0], [30, 0]], { closed: false }).edges.set('w', 0);
    const out = m.edges.set('w', 5, m.edge(0)).split(m.edge(1), 0.5).edges.remove(m.edge(2));
    expect(out.edgeCount).toBe(3);
    expect(out.edgeAttrs.w[0]).toBe(5);
    // A number is no reference: ids are the engine's, and a sketch holds values.
    expect(() => m.edges.set('w', 1, 9 as never)).toThrow(/expected an edge — an edge view or an edge value/);
    expect(() => m.edges.set('w', 1, m.points.at(0) as never)).toThrow(/expected an edge — an edge view or an edge value/);
    expect(m.points.at(1).adjacent.length).toBe(2);
    expect(m.points.at(0).adjacent.indices).toEqual([1]);
    expect(m.points.at(0).adjacent.has(m.points.at(1))).toBe(true);
    expect(m.points.at(1).adjacent.indices).toEqual([0, 2]);
    expect(m.points.at(1).edges.length).toBe(2);
    // A foreign vertex describes its own state now; it does not throw.
    expect(curve([[0, 0], [1, 1]], { closed: false }).points.at(0).adjacent.length).toBe(1);
    expect(() => m.points.at(7).adjacent.length).toThrow(/no member 7/);
    expect(m.curves.map(rec)[0].indices).toEqual([0, 1, 2, 3]);
  });

  it('history comes only from t.steps; a write, connect and resample keep the count, append/extract/planarize start one', () => {
    const g = toolkit({ seed: 1 }).steps(3, curve([[0, 0], [10, 0], [10, 10]], { closed: true }), (m) => m, { every: 1 });
    expect(g.iteration).toBe(3);
    expect(g.history).toHaveLength(4);
    expect(g.points.set('a', 1).iteration).toBe(3);
    expect(g.points.set('a', 1).history).toEqual([]);
    expect(g.resample({ count: 6 }).iteration).toBe(3);
    expect(curve(g).iteration).toBe(3);
    expect(append(g, g).iteration).toBe(0);
    expect(g.edges.filter(() => true).extract().iteration).toBe(0);
    expect(g.planarize().iteration).toBe(0);
  });
});
