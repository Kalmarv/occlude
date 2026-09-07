import { describe, expect, it } from 'vitest';
import { append, connect, curve, material, type Vertex } from '../src/material.js';
import { EdgeSelection, PointSelection, components, meanBy } from '../src/relation.js';

// a Y: 0-1-2 trunk, 2-3 and 2-4 branches, plus an isolated point 5
const Y = () =>
  material([[0, 0], [10, 0], [20, 0], [30, 10], [30, -10], [50, 50]], { edges: [[0, 1], [1, 2], [2, 3], [2, 4]], age: [0, 1, 2, 3, 4, 9] })
    .edgeAttribute('strength', (e) => e.index + 1);

describe('selections', () => {
  it('membership is fixed at creation, in source order, with source-bound views', () => {
    const m = Y();
    let calls = 0;
    const old = m.selectPoints((p) => (calls++, p.age >= 2));
    expect(calls).toBe(6);
    expect(old.source).toBe(m);
    expect(old.size).toBe(4);
    expect(old.indices).toEqual([2, 3, 4, 5]);
    expect(Object.isFrozen(old.indices)).toBe(true);
    expect(() => (old.indices as number[]).push(0)).toThrow();
    expect(old.points.map((p) => p.index)).toEqual([2, 3, 4, 5]);
    expect(old.has(m.vertex(3))).toBe(true);
    expect(old.has(m.vertex(0))).toBe(false);
    // the same rows of another state are not members
    const other = m.attribute('age', 0);
    expect(old.has(other.vertex(3))).toBe(false);
    expect(old.has(Y().vertex(3))).toBe(false);
    // wrong domain
    expect(() => old.has(m.edge(0) as unknown as Vertex)).toThrow(/edge view/);
    expect(() => old.has(3 as unknown as Vertex)).toThrow(/vertex view/);
    calls = 0;
    old.points;
    expect(calls).toBe(0); // no re-evaluation
  });

  it('domain comes from the view, not from attribute names', () => {
    const m = material([[0, 0], [1, 0]], { edges: [[0, 1]], a: 1, b: 2, x2: 3 });
    const pts = m.selectPoints(() => true);
    expect(pts.has(m.vertex(0))).toBe(true);
    const es = m.selectEdges(() => true);
    expect(() => es.has(m.vertex(0) as never)).toThrow(/vertex view/);
    expect(() => pts.has(m.edge(0) as never)).toThrow(/edge view/);
    // the edit interface is just as strict: a vertex named a/b is not an edge
    expect(() => m.steps(1, (cur, next) => next.split(cur.vertex(0) as never))).toThrow(/edge row or view/);
    expect(m.steps(1, (cur, next) => next.move(cur.vertex(1), [1, 0])).x[1]).toBe(2);
  });

  it('edge selections: views, deduplicated endpoints in source order, domain checks', () => {
    const m = Y();
    const strong = m.selectEdges((e) => e.attrs.strength >= 3);
    expect(strong.indices).toEqual([2, 3]);
    expect(strong.edges.map((e) => [e.a.index, e.b.index])).toEqual([[2, 3], [2, 4]]);
    expect(strong.points.map((p) => p.index)).toEqual([2, 3, 4]); // 2 once
    expect(strong.has(m.edge(2))).toBe(true);
    expect(strong.has(m.edge(0))).toBe(false);
    expect(strong.has(Y().edge(2))).toBe(false);
    expect(() => strong.has(m.vertex(2) as never)).toThrow(/vertex view/);
  });

  it('union, intersect, subtract: overlap, empties, incompatible inputs', () => {
    const m = Y();
    const a = m.selectPoints((p) => p.index <= 2);
    const b = m.selectPoints((p) => p.index >= 2 && p.index <= 4);
    expect(a.union(b).indices).toEqual([0, 1, 2, 3, 4]);
    expect(a.intersect(b).indices).toEqual([2]);
    expect(a.subtract(b).indices).toEqual([0, 1]);
    expect(b.subtract(a).indices).toEqual([3, 4]);
    expect(a.indices).toEqual([0, 1, 2]); // inputs untouched
    const none = m.selectPoints(() => false);
    expect(none.size).toBe(0);
    expect(a.union(none).indices).toEqual(a.indices);
    expect(a.intersect(none).size).toBe(0);
    expect(none.subtract(a).size).toBe(0);
    expect(none.extract().n).toBe(0);
    expect(() => a.union(Y().selectPoints(() => true))).toThrow(/different states/);
    const e = m.selectEdges(() => true);
    expect(() => a.union(e as unknown as PointSelection)).toThrow(/point selection/);
    expect(() => e.intersect(a as unknown as EdgeSelection)).toThrow(/edge selection/);
    expect(e.subtract(m.selectEdges((x) => x.index === 0)).indices).toEqual([1, 2, 3]);
  });
});

describe('extraction', () => {
  it('point extraction keeps points and columns, no edges; induced edges keep existing connections only', () => {
    const m = Y();
    const branchAndLoner = m.selectPoints((p) => p.index >= 2);
    const pts = branchAndLoner.extract();
    expect(pts.n).toBe(4);
    expect(pts.edgeCount).toBe(0);
    expect(Array.from(pts.attrs.age)).toEqual([2, 3, 4, 9]);
    expect(pts.edgeAttrNames).toEqual(['strength']); // schema kept, empty
    expect(pts.edgeAttrs.strength.length).toBe(0);
    expect(pts.iteration).toBe(0);
    expect(pts.history).toEqual([]);
    const induced = branchAndLoner.inducedEdges();
    expect(induced.indices).toEqual([2, 3]); // 2-3, 2-4; nothing is invented for 5
    const patch = induced.extract();
    expect(patch.n).toBe(3); // the isolated 5 is absent
    expect(patch.edgeCount).toBe(2);
    expect(Array.from(patch.x)).toEqual([20, 30, 30]);
    // point-only material still accepts steps and append
    const grown = pts.steps(1, (_, next) => next.extend(() => ({ position: [0, 1], attributes: { age: 0 }, edgeAttributes: { strength: 1 } })));
    expect(grown.n).toBe(8);
    expect(grown.edgeCount).toBe(4);
  });

  it('edge extraction: remapped rows, stored orientation, both attribute domains, transfers, independence', () => {
    const src = Y().attribute('kind', 7, { transfer: 'nearest' });
    // select the trunk in reverse-stored orientation to check it is kept
    const flipped = material([[0, 0], [10, 0], [20, 0]], { edges: [[2, 1], [1, 0]] }).edgeAttribute('strength', (e) => e.index + 10);
    const rev = flipped.selectEdges(() => true).extract();
    expect(Array.from(rev.edgeList)).toEqual([2, 1, 1, 0]);
    const branches = src.selectEdges((e) => e.index >= 2).extract();
    expect(branches.n).toBe(3);
    expect(Array.from(branches.x)).toEqual([20, 30, 30]);
    expect(Array.from(branches.edgeList)).toEqual([0, 1, 0, 2]);
    expect(Array.from(branches.edgeAttrs.strength)).toEqual([3, 4]);
    expect(Array.from(branches.attrs.age)).toEqual([2, 3, 4]);
    expect(Array.from(branches.attrs.kind)).toEqual([7, 7, 7]);
    expect(branches.transfers.kind).toBe('nearest');
    expect(branches.iteration).toBe(0);
    // independent: writing the copy leaves the source alone, and the source's views are not owned by it
    branches.x[0] = 999;
    expect(src.x[2]).toBe(20);
    expect(src.selectEdges(() => true).has(branches.edge(0))).toBe(false);
    // a split afterwards obeys the carried policy (nearest copies)
    const split = branches.steps(1, (cur, next) => next.split(cur.edge(0), { at: 0.3 }));
    expect(split.attrs.kind[1]).toBe(7);
    expect(split.attrs.age[1]).toBeCloseTo(2.3);
  });

  it('continued editing and combining of extracted results through existing APIs', () => {
    const m = Y();
    const branch = m.selectEdges((e) => e.index === 2).extract();
    const other = m.selectEdges((e) => e.index === 3).extract();
    const joined = append(branch, other);
    expect(joined.n).toBe(4);
    expect(joined.edgeCount).toBe(2);
    const paired = connect.pairs(branch, other, { strength: 0 });
    expect(paired.edgeCount).toBe(4);
    const nearestPolicy = m.attribute('age', 1, { transfer: 'nearest' }).selectEdges(() => true).extract();
    expect(() => append(branch, nearestPolicy)).toThrow(/transfer/);
  });
});

describe('drawing selections', () => {
  it('curves of the selected graph: junctions and ends from selected edges only, indices are source rows', () => {
    const m = Y();
    const all = m.selectEdges(() => true).curves();
    expect(all).toHaveLength(3); // trunk, and two branches meeting at the junction 2
    const noLeft = m.selectEdges((e) => e.index !== 2).curves();
    expect(noLeft).toHaveLength(1);
    expect(noLeft[0].indices).toEqual([0, 1, 2, 4]); // vertex 2 is no longer a junction
    expect(noLeft[0].closed).toBe(false);
    const ring = curve([[0, 0], [1, 0], [1, 1], [0, 1]], { closed: true }).selectEdges(() => true).curves();
    expect(ring).toHaveLength(1);
    expect(ring[0].closed).toBe(true);
    // each selected edge exactly once across the chains
    const covered = all.flatMap((c) => c.indices.slice(0, -1).map((v, k) => [v, c.indices[k + 1]]));
    expect(covered).toHaveLength(4);
    expect(m.selectEdges(() => false).curves()).toEqual([]);
  });
});

describe('selections in edits', () => {
  it('a current-state selection drives existing selectors; outer selections do not rebind', () => {
    const m = Y();
    const outer = m.selectPoints((p) => p.age >= 3);
    const moved = m.steps(1, (current, next) => {
      const old = current.selectPoints((p) => p.age >= 3);
      expect(current).not.toBe(m); // steps works on its own copy: the outer selection is of another state
      expect(outer.has(current.vertex(3))).toBe(false);
      next.move(() => [0, 5], { where: (p) => old.has(p) });
      const strong = current.selectEdges((e) => e.attrs.strength >= 3);
      next.setEdges(() => ({ strength: 100 }), { where: (e) => strong.has(e) });
      next.disconnect((e) => e.index === 0 && !strong.has(e));
    });
    expect(Array.from(moved.y)).toEqual([0, 0, 0, 15, -5, 55]);
    expect(Array.from(moved.edgeAttrs.strength)).toEqual([2, 100, 100]);
    // bulk split sees MOVED edges: a current-state selection cannot vouch for them
    const strongSplit = m.steps(1, (current, next) => {
      const strong = current.selectEdges((e) => e.attrs.strength >= 3);
      expect(() => next.splitEdges((e) => strong.has(e))).not.toThrow(); // recorded now…
    });
    // …but evaluated on moved views, which the selection does not own: nothing split
    expect(strongSplit.n).toBe(6);
    const explicit = m.steps(1, (current, next) => {
      const strong = current.selectEdges((e) => e.attrs.strength >= 3);
      for (const e of strong.edges) next.split(e);
    });
    expect(explicit.n).toBe(8);
  });
});

describe('relational attributes', () => {
  it('connectedPoints, meanBy, degree as attributes', () => {
    const m = Y();
    expect(m.connectedPoints(m.vertex(2)).map((p) => p.index)).toEqual([1, 3, 4]);
    expect(m.connectedPoints(5)).toEqual([]);
    expect(() => m.connectedPoints(Y().vertex(2))).toThrow(/another state/);
    expect(() => m.connectedPoints(9)).toThrow(/no vertex/);
    const marked = m.attribute('neighbourAge', (p) => meanBy(m.connectedPoints(p), (q) => q.age));
    expect(Array.from(marked.attrs.neighbourAge)).toEqual([1, 1, (1 + 3 + 4) / 3, 2, 2, 0]);
    expect(meanBy([], () => 1)).toBe(0);
    expect(meanBy([1, NaN], (v) => v)).toBeNaN();
    expect(meanBy(new Set([2, 4]), (v) => v)).toBe(3);
    const deg = m.attribute('degree', (p) => m.degree(p.index));
    expect(Array.from(deg.attrs.degree)).toEqual([1, 2, 3, 1, 1, 0]);
  });

  it('components: deterministic labels, isolated vertices, ownership, empty material', () => {
    const m = material([[0, 0], [5, 0], [9, 9], [1, 1], [2, 2]], { edges: [[3, 4], [0, 1]] });
    const c = components(m);
    expect(c.count).toBe(3);
    expect(Array.from(c.labels)).toEqual([0, 0, 1, 2, 2]);
    expect(c.label(m.vertex(4))).toBe(2);
    expect(c.label(2)).toBe(1);
    expect(() => c.label(material([[0, 0]]).vertex(0))).toThrow(/another state/);
    expect(() => c.label(7)).toThrow(/no vertex/);
    expect(components(material([])).count).toBe(0);
    const labelled = m.attribute('piece', (p) => c.label(p), { transfer: 'nearest' });
    expect(labelled.transfers.piece).toBe('nearest');
    const y = Y();
    expect(Array.from(components(y).labels)).toEqual([0, 0, 0, 0, 0, 1]);
  });
});
