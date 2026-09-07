import { describe, expect, it } from 'vitest';
import { append, connect, curve, material, planarize } from '../src/index.js';

const seg = (a: [number, number], b: [number, number]) => material([a, b], { edges: [[0, 1]] });

describe('transfer contracts (con2 stage B)', () => {
  it('point columns: a continuous column interpolates and a categorical one copies through split, resample and extract', () => {
    const m = curve([[0, 0], [10, 0], [20, 0]], { closed: false })
      .attribute('age', (p) => p.index * 10)
      .attribute('kind', (p) => (p.index < 1 ? 1 : 2), { transfer: 'nearest' });
    const split = m.steps(1, (c, n) => n.split(c.edge(0), { at: 0.25 }));
    expect(split.attrs.age[1]).toBeCloseTo(2.5);
    expect(split.attrs.kind[1]).toBe(1); // nearest: the start
    const rs = split.resample({ count: 9 });
    expect(rs.transfers.kind).toBe('nearest');
    expect(Array.from(rs.attrs.kind).every((v) => v === 1 || v === 2)).toBe(true);
    expect(rs.attrs.age[4]).toBeCloseTo(10, 6);
    const ex = rs.selectEdges((e) => e.index < 4).extract();
    expect(ex.transfers.kind).toBe('nearest');
    expect(ex.iteration).toBe(0);
    // an explicit per-operation rule wins over the policy for that call only
    const forced = split.resample({ count: 5, transfer: { kind: 7 } });
    expect(Array.from(forced.attrs.kind)).toEqual([7, 7, 7, 7, 7]);
    expect(forced.transfers.kind).toBe('nearest');
  });

  it("edge columns: 'copy' is categorical, 'distribute' is a length share — split, planarize, resample across several source edges", () => {
    const base = material([[0, 0], [10, 0], [20, 0]], { edges: [[0, 1], [1, 2]] })
      .edgeAttribute('pen', (e) => e.index + 1)
      .edgeAttribute('rest', (e) => (e.index === 0 ? 10 : 30), { transfer: 'distribute' });
    expect(base.edgeTransfers).toEqual({ rest: 'distribute' });
    // split at 0.25: the copy column repeats, the distributed one shares 10 into 2.5 + 7.5
    const split = base.steps(1, (c, n) => n.split(c.edge(0), { at: 0.25 }));
    expect(Array.from(split.edgeAttrs.pen)).toEqual([1, 1, 2]);
    expect(Array.from(split.edgeAttrs.rest)).toEqual([2.5, 7.5, 30]);
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
    // per-operation override wins
    const over = base.steps(1, (c, n) => n.split(c.edge(0), { edges: () => ({ rest: 1 }) }));
    expect(Array.from(over.edgeAttrs.rest)).toEqual([1, 1, 30]);
    // planarize shares too
    const cross = append(seg([0, 0], [10, 10]), seg([0, 10], [10, 0])).edgeAttribute('rest', 8, { transfer: 'distribute' });
    expect(Array.from(planarize(cross).edgeAttrs.rest)).toEqual([4, 4, 4, 4]);
    // a value update keeps the policy; explicit copy restores the default; append compares effective policies
    expect(base.edgeAttribute('rest', 1).edgeTransfers.rest).toBe('distribute');
    expect(base.edgeAttribute('rest', 1, { transfer: 'copy' }).edgeTransfers.rest).toBeUndefined();
    const other = material([[30, 0], [40, 0]], { edges: [[0, 1]] }).edgeAttribute('pen', 1).edgeAttribute('rest', 5);
    expect(() => append(base, other)).toThrow(/edge column 'rest'/);
  });

  it('crossings: agreeing candidates pass, disagreeing ones need the resolver, whatever the policy', () => {
    const a = seg([0, 0], [10, 10]).attribute('kind', 1, { transfer: 'nearest' });
    const b = seg([0, 10], [10, 0]).attribute('kind', 1, { transfer: 'nearest' });
    expect(planarize(append(a, b)).attrs.kind[4]).toBe(1);
    const c = seg([0, 10], [10, 0]).attribute('kind', 2, { transfer: 'nearest' });
    expect(() => planarize(append(a, c))).toThrow(/conflicting 'kind'/);
    expect(planarize(append(a, c), { point: () => ({ kind: 9 }) }).attrs.kind[4]).toBe(9);
  });

  it('where takes a selection of the current state — for points, edges and bulk splits — and refuses another state', () => {
    const m = curve([[0, 0], [10, 0], [20, 0], [30, 0]], { closed: false, active: [1, 0, 1, 0] });
    const stale = m.selectPoints((p) => p.active === 1);
    const out = m.steps(1, (cur, next) => {
      const tips = cur.selectPoints((p) => p.active === 1);
      const longEdges = cur.selectEdges((e) => e.index >= 1);
      next.move(() => [0, 5], { where: tips });
      next.set(() => ({ active: 2 }), { where: tips });
      next.splitEdges(longEdges);
      next.disconnect(cur.selectEdges((e) => e.index === 0));
    });
    // rows 0 and 2 moved and set; the cuts of edges 1 and 2 sit after rows 1 and 2 and interpolate the MOVED state
    expect(Array.from(out.y)).toEqual([5, 0, 2.5, 5, 2.5, 0]);
    expect(Array.from(out.attrs.active)).toEqual([2, 0, 1, 2, 1, 0]);
    expect(out.edgeCount).toBe(4); // edge 0 gone; edges 1 and 2 split into two each
    expect(() => m.steps(1, (_, next) => next.move(() => [1, 0], { where: stale }))).toThrow(/another state/);
    expect(() => m.steps(1, (cur, next) => next.remove(cur.selectEdges(() => true) as never))).toThrow(/point selection/);
  });

  it('edges by row or view; vertex accessors take rows or views of this state', () => {
    const m = curve([[0, 0], [10, 0], [20, 0], [30, 0]], { closed: false }).edgeAttribute('w', 0);
    const out = m.steps(1, (cur, next) => {
      next.setEdge(0, { w: 5 });
      next.split(1, { at: 0.5 });
      next.disconnect(2);
    });
    expect(out.edgeCount).toBe(3);
    expect(out.edgeAttrs.w[0]).toBe(5);
    expect(() => m.steps(1, (_, next) => next.setEdge(9, { w: 1 }))).toThrow(/no edge 9/);
    expect(m.degree(m.vertex(1))).toBe(2);
    expect(m.connected(m.vertex(0))).toEqual([1]);
    expect(m.isConnected(m.vertex(0), 1)).toBe(true);
    expect(m.prev(m.vertex(1))).toBe(0);
    expect(m.next(m.vertex(1))).toBe(2);
    expect(() => m.degree(curve([[0, 0], [1, 1]], { closed: false }).vertex(0))).toThrow(/another state/);
    expect(() => m.degree(7)).toThrow(/no vertex 7/);
    expect(m.contour.indices).toEqual([0, 1, 2, 3]);
  });

  it('iteration and history: a new lineage at append/extract/planarize, kept through attribute/connect/resample; history only from steps', () => {
    const g = curve([[0, 0], [10, 0], [10, 10]], { closed: true }).steps(3, () => {}, { every: 1 });
    expect(g.iteration).toBe(3);
    expect(g.history).toHaveLength(4);
    expect(g.attribute('a', 1).iteration).toBe(3);
    expect(g.attribute('a', 1).history).toEqual([]);
    expect(g.resample({ count: 6 }).iteration).toBe(3);
    expect(connect.chain(g).iteration).toBe(3);
    expect(append(g, g).iteration).toBe(0);
    expect(g.selectEdges(() => true).extract().iteration).toBe(0);
    expect(planarize(g).iteration).toBe(0);
  });
});
