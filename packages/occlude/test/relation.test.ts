import { describe, expect, it } from 'vitest';
import { append, connect, curve, material, type Vertex } from '../src/material.js';
import { rec } from './helpers/xy.js';

// a Y: 0-1-2 trunk, 2-3 and 2-4 branches, plus an isolated point 5
const Y = () =>
  material([[0, 0], [10, 0], [20, 0], [30, 10], [30, -10], [50, 50]], { edges: [[0, 1], [1, 2], [2, 3], [2, 4]], age: [0, 1, 2, 3, 4, 9] })
    .edges.set('strength', (e) => e.index + 1);

describe('selections', () => {
  it('membership is fixed at creation, in source order, with source-bound views', () => {
    const m = Y();
    let calls = 0;
    const old = m.points.filter((p) => (calls++, p.age >= 2));
    expect(calls).toBe(6);
    expect(old.owner).toBe(m);
    expect(old.length).toBe(4);
    expect(old.indices).toEqual([2, 3, 4, 5]);
    expect(Object.isFrozen(old.indices)).toBe(true);
    expect(() => (old.indices as number[]).push(0)).toThrow();
    expect(old.map((p) => p.index)).toEqual([2, 3, 4, 5]);
    expect(old.has(m.vertex(3))).toBe(true);
    expect(old.has(m.vertex(0))).toBe(false);
    // A vertex of a LATER state of the same evolution is the same vertex:
    // `has` asks by identity, not by row. A vertex of a material that
    // shares no identity is not a member, however its rows line up.
    const other = m.points.set('age', 0);
    expect(old.has(other.vertex(3))).toBe(true);
    expect(old.has(Y().vertex(3))).toBe(false);
    // wrong domain
    expect(() => old.has(m.edge(0) as unknown as Vertex)).toThrow(/edge view/);
    expect(() => old.has(3 as unknown as Vertex)).toThrow(/expected a point — a vertex view or a point value/);
    calls = 0;
    [...old];
    expect(calls).toBe(0); // no re-evaluation
  });

  it('domain comes from the view, not from attribute names', () => {
    const m = material([[0, 0], [1, 0]], { edges: [[0, 1]], a: 1, b: 2, x2: 3 });
    const pts = m.points.filter(() => true);
    expect(pts.has(m.vertex(0))).toBe(true);
    const es = m.edges.filter(() => true);
    expect(() => es.has(m.vertex(0) as never)).toThrow(/vertex view/);
    expect(() => pts.has(m.edge(0) as never)).toThrow(/edge view/);
    // the writes are just as strict: a vertex named a/b is not an edge
    expect(() => m.split(m.vertex(0) as never)).toThrow(/expected an edge — an edge view or an edge value/);
    expect(m.move([1, 0], m.vertex(1)).x[1]).toBe(2);
  });

  it('edge selections: views, deduplicated endpoints in source order, domain checks', () => {
    const m = Y();
    const strong = m.edges.filter((e) => e.strength >= 3);
    expect(strong.indices).toEqual([2, 3]);
    expect(strong.map((e) => [e.a.index, e.b.index])).toEqual([[2, 3], [2, 4]]);
    expect(strong.points.map((p) => p.index)).toEqual([2, 3, 4]); // 2 once
    expect(strong.has(m.edge(2))).toBe(true);
    expect(strong.has(m.edge(0))).toBe(false);
    expect(strong.has(Y().edge(2))).toBe(false);
    expect(() => strong.has(m.vertex(2) as never)).toThrow(/vertex view/);
  });

  it('union, intersect, without: overlap, empties, incompatible inputs', () => {
    const m = Y();
    const a = m.points.filter((p) => p.index <= 2);
    const b = m.points.filter((p) => p.index >= 2 && p.index <= 4);
    expect(a.union(b).indices).toEqual([0, 1, 2, 3, 4]);
    expect(a.intersect(b).indices).toEqual([2]);
    expect(a.without(b).indices).toEqual([0, 1]);
    expect(b.without(a).indices).toEqual([3, 4]);
    expect(a.indices).toEqual([0, 1, 2]); // inputs untouched
    const none = m.points.filter(() => false);
    expect(none.length).toBe(0);
    expect(a.union(none).indices).toEqual(a.indices);
    expect(a.intersect(none).length).toBe(0);
    expect(none.without(a).length).toBe(0);
    expect(none.extract().n).toBe(0);
    expect(() => a.union(Y().points.filter(() => true))).toThrow(/unrelated materials/);
    const e = m.edges.filter(() => true);
    expect(() => a.union(e)).toThrow(/point selection/);
    expect(() => e.intersect(a)).toThrow(/edge selection/);
    expect(e.without(m.edges.filter((x) => x.index === 0)).indices).toEqual([1, 2, 3]);
  });
});

describe('extraction', () => {
  it('point extraction keeps points and columns, no edges; induced edges keep existing connections only', () => {
    const m = Y();
    const branchAndLoner = m.points.filter((p) => p.index >= 2);
    const pts = branchAndLoner.extract();
    expect(pts.n).toBe(4);
    expect(pts.edgeCount).toBe(0);
    expect(Array.from(pts.attrs.age)).toEqual([2, 3, 4, 9]);
    expect(Object.keys(pts.edgeAttrs)).toEqual(['strength']); // schema kept, empty
    expect(pts.edgeAttrs.strength.length).toBe(0);
    expect(pts.history).toEqual([]);
    const induced = branchAndLoner.edges;
    expect(induced.indices).toEqual([2, 3]); // 2-3, 2-4; nothing is invented for 5
    const patch = induced.extract();
    expect(patch.n).toBe(3); // the isolated 5 is absent
    expect(patch.edgeCount).toBe(2);
    expect(Array.from(patch.x)).toEqual([20, 30, 30]);
    // point-only material still takes new rows and joins
    const grown = pts.points.add(pts.points.map((p) => [p.x, p.y + 1] as [number, number]), { age: 0 });
    const joined = grown.edges.add(pts.points.map((p, i) => [p, grown.points.at(pts.n + i)] as const), { strength: 1 });
    expect(joined.n).toBe(8);
    expect(joined.edgeCount).toBe(4);
  });

  it('edge extraction: remapped rows, stored orientation, both attribute domains, transfers, independence', () => {
    const src = Y().points.set('kind', 7, { transfer: 'nearest' });
    // select the trunk in reverse-stored orientation to check it is kept
    const flipped = material([[0, 0], [10, 0], [20, 0]], { edges: [[2, 1], [1, 0]] }).edges.set('strength', (e) => e.index + 10);
    const rev = flipped.edges.filter(() => true).extract();
    expect(Array.from(rev.edgeList)).toEqual([2, 1, 1, 0]);
    const branches = src.edges.filter((e) => e.index >= 2).extract();
    expect(branches.n).toBe(3);
    expect(Array.from(branches.x)).toEqual([20, 30, 30]);
    expect(Array.from(branches.edgeList)).toEqual([0, 1, 0, 2]);
    expect(Array.from(branches.edgeAttrs.strength)).toEqual([3, 4]);
    expect(Array.from(branches.attrs.age)).toEqual([2, 3, 4]);
    expect(Array.from(branches.attrs.kind)).toEqual([7, 7, 7]);
    expect(branches.transfers.kind).toBe('nearest');
    // independent: writing the copy leaves the source alone. The extracted
    // edge IS one of the source's edges — extraction carries identity, which
    // is what makes an extracted piece still about the same material — so
    // `has` says so.
    branches.x[0] = 999;
    expect(src.x[2]).toBe(20);
    expect(src.edges.filter(() => true).has(branches.edge(0))).toBe(true);
    // a split afterwards obeys the carried policy (nearest copies)
    const split = branches.split(branches.edge(0), 0.3);
    expect(split.attrs.kind[3]).toBe(7);
    expect(split.attrs.age[3]).toBeCloseTo(2.3);
  });

  it('continued editing and combining of extracted results through existing APIs', () => {
    const m = Y();
    const branch = m.edges.filter((e) => e.index === 2).extract();
    const other = m.edges.filter((e) => e.index === 3).extract();
    const joined = append(branch, other);
    expect(joined.n).toBe(4);
    expect(joined.edgeCount).toBe(2);
    const paired = connect.pairs(branch, other, { strength: 0 });
    expect(paired.edgeCount).toBe(4);
    const nearestPolicy = m.points.set('age', 1, { transfer: 'nearest' }).edges.filter(() => true).extract();
    expect(() => append(branch, nearestPolicy)).toThrow(/transfer/);
  });
});

describe('drawing selections', () => {
  it('curves of the selected graph: junctions and ends from selected edges only, indices are source rows', () => {
    const m = Y();
    const all = m.edges.filter(() => true).curves.map(rec);
    expect(all).toHaveLength(3); // trunk, and two branches meeting at the junction 2
    const noLeft = m.edges.filter((e) => e.index !== 2).curves.map(rec);
    expect(noLeft).toHaveLength(1);
    expect(noLeft[0].indices).toEqual([0, 1, 2, 4]); // vertex 2 is no longer a junction
    expect(noLeft[0].closed).toBe(false);
    const ring = curve([[0, 0], [1, 0], [1, 1], [0, 1]], { closed: true }).edges.filter(() => true).curves.map(rec);
    expect(ring).toHaveLength(1);
    expect(ring[0].closed).toBe(true);
    // each selected edge exactly once across the chains
    const covered = all.flatMap((c) => c.indices.slice(0, -1).map((v, k) => [v, c.indices[k + 1]]));
    expect(covered).toHaveLength(4);
    expect(m.edges.filter(() => false).curves.map(rec)).toEqual([]);
  });
});

describe('selections in edits', () => {
  it('a selection drives the writes, and one of an earlier state re-binds by identity', () => {
    const m = Y();
    const outer = m.points.filter((p) => p.age >= 3);
    const first = m.points.set('seen', 1);
    // A write carries identity, so a selection made before it is still
    // about the same points: `has` answers by who, not by which row.
    expect(outer.has(first.vertex(3))).toBe(true);
    const strong = m.edges.filter((e) => e.strength >= 3);
    const moved = first
      .move([0, 5], outer)
      .edges.set('strength', 100, strong)
      .edges.remove(m.edges.filter((e) => e.index === 0 && !strong.has(e)));
    expect(Array.from(moved.y)).toEqual([0, 0, 0, 15, -5, 55]);
    expect(Array.from(moved.edgeAttrs.strength)).toEqual([2, 100, 100]);
    // A split takes a selection, one edge, or an edge of an earlier state.
    expect(m.split(strong).n).toBe(8);
    let each = m;
    for (const e of strong) each = each.split(e);
    expect(each.n).toBe(8);
  });
});

describe('relational attributes', () => {
  it('connectedPoints, a mean over the neighbours, degree as attributes', () => {
    const m = Y();
    expect(m.vertex(2).adjacent.map((p) => p.index)).toEqual([1, 3, 4]);
    expect(m.points.at(5).adjacent.indices).toEqual([]);
    // `p.adjacent` closes over the material that made the view, so a
    // vertex of another state answers about ITS state instead of throwing.
    // The cross-state guard now lives where it matters: the step verbs.
    expect(Y().vertex(2).adjacent.owner).not.toBe(m);
    expect(() => m.points.at(9).adjacent).toThrow(/no member/);
    // The mean of nothing is NaN, and a value that is not finite leaves the
    // row as it was: the isolated point keeps the column's 0.
    const marked = m.points.set('neighbourAge', (p) => p.adjacent.mean('age'));
    expect(Array.from(marked.attrs.neighbourAge)).toEqual([1, 1, (1 + 3 + 4) / 3, 2, 2, 0]);
    expect(m.points.at(5).adjacent.mean('age')).toBeNaN();
    expect(m.points.mean((p) => p.age)).toBe(19 / 6);
    const deg = m.points.set('degree', (p) => p.adjacent.length);
    expect(Array.from(deg.attrs.degree)).toEqual([1, 2, 3, 1, 1, 0]);
  });

  it('components: one selection per piece, isolated vertices, empty material', () => {
    const m = material([[0, 0], [5, 0], [9, 9], [1, 1], [2, 2]], { edges: [[3, 4], [0, 1]] });
    const pieces = m.points.components();
    expect(pieces.map((c) => c.indices)).toEqual([[0, 1], [2], [3, 4]]);
    expect(pieces.map((c) => c.key)).toEqual([0, 1, 2]);
    expect(material([]).points.components()).toEqual([]);
    // The piece a row belongs to, as a column: what `components(m).label` was.
    const partOf = new Map<number, number>();
    pieces.forEach((piece, k) => { for (const i of piece.indices) partOf.set(i, k); });
    const labelled = m.points.set('piece', (p) => partOf.get(p.index) ?? 0, { transfer: 'nearest' });
    expect(Array.from(labelled.attrs.piece)).toEqual([0, 0, 1, 2, 2]);
    expect(labelled.transfers.piece).toBe('nearest');
    expect(Y().points.components().map((c) => c.indices)).toEqual([[0, 1, 2, 3, 4], [5]]);
  });

  it('components of a selection use the edges among the members alone', () => {
    const m = material([[0, 0], [1, 0], [2, 0], [3, 0]], { edges: [[0, 1], [1, 2], [2, 3]] });
    const ends = m.points.filter((p) => p.index === 0 || p.index === 3);
    expect(ends.components().map((c) => c.indices)).toEqual([[0], [3]]);
    expect(m.points.components().map((c) => c.indices)).toEqual([[0, 1, 2, 3]]);
  });

  it('adjacent and connected: one step out, then everything reachable', () => {
    const m = material([[0, 0], [1, 0], [2, 0], [9, 9], [10, 9]], { edges: [[0, 1], [1, 2], [3, 4]] });
    const first = m.points.filter((p) => p.index === 0);
    expect(first.adjacent().indices).toEqual([1]); // members are never their own neighbours
    expect(first.connected().indices).toEqual([0, 1, 2]);
    // A loose vertex reaches nothing and is a piece of its own.
    const loose = material([[0, 0]]);
    expect(loose.points.adjacent().indices).toEqual([]);
    expect(loose.points.connected().indices).toEqual([0]);
    expect(loose.points.components().map((c) => c.indices)).toEqual([[0]]);
  });

  it('a vertex knows its edges; degree is their count', () => {
    const m = material([[0, 0], [1, 0], [2, 0], [1, 1]], { edges: [[0, 1], [1, 2], [1, 3]] });
    expect(m.points.at(1).edges.indices).toEqual([0, 1, 2]);
    expect(m.points.at(1).edges.length).toBe(3); // the degree, where `maxDegree` used to be asked
    expect(m.points.at(0).edges.indices).toEqual([0]);
    expect(m.points.at(0).edges.at(0).b.index).toBe(1);
    // An `edges` column cannot shadow the word.
    expect(() => material([[0, 0]], { edges: [] }).points.set('edges', 1)).toThrow(/reserved/);
  });

  it('edge selections say the same three words', () => {
    const m = material([[0, 0], [1, 0], [2, 0], [9, 9], [10, 9]], { edges: [[0, 1], [1, 2], [3, 4]] });
    const first = m.edges.filter((e) => e.index === 0);
    expect(first.adjacent().indices).toEqual([1]);
    expect(first.connected().indices).toEqual([0, 1]);
    expect(m.edges.components().map((c) => c.indices)).toEqual([[0, 1], [2]]);
    // The edges among a point selection, and the edges touching it.
    const mid = m.points.filter((p) => p.index === 1 || p.index === 2);
    expect(mid.edges.indices).toEqual([1]);
    expect(mid.edges.adjacent().indices).toEqual([0]);
  });
});
