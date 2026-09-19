/**
 * Identity: mint, keep, retire.
 *
 * A vertex and an edge each have an id for as long as they exist. New
 * geometry mints; a rebuild that carries a row forward carries its id; a
 * split retires the parent and its children are new. The id is opaque — the
 * type refuses arithmetic — and it is a number underneath so a sketch can
 * store it in an ordinary column and look it up in a later step.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { connect, initOcclude, material, type Material } from '../src/index.js';

beforeAll(async () => {
  const wasmPath = fileURLToPath(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url));
  await initOcclude(readFileSync(wasmPath));
});

const ring = (): Material => connect.ring(material([[0, 0], [10, 0], [10, 10], [0, 10]]));
const ids = (m: Material): number[] => [...m.points].map((p) => p.id as number);

describe('every vertex and edge has one', () => {
  it('mints for new geometry, and never repeats', () => {
    const a = ring();
    const b = ring();
    expect(new Set(ids(a)).size).toBe(4);
    // Two materials built the same way share no identity: they are not the
    // same four points.
    expect(ids(a).some((id) => ids(b).includes(id))).toBe(false);
  });

  it('is on the view without being one of its columns', () => {
    const p = ring().points.at(0);
    expect(typeof p.id).toBe('number');
    expect(Object.keys(p)).not.toContain('id');
    expect(JSON.stringify(p)).not.toContain('"id"');
  });

  it('finds the row an id is at, and says when it is gone', () => {
    const m = ring();
    const id = m.points.at(2).id;
    expect(m.rowOfPoint(id)).toBe(2);
    expect(m.pointOf(id)?.x).toBe(10);
    const other = ring();
    expect(other.rowOfPoint(id)).toBe(-1);
    expect(other.pointOf(id)).toBeUndefined();
  });

  it('gives edges their own, and finds them too', () => {
    const m = ring();
    const e = m.edges.at(1);
    expect(m.rowOfEdge(e.id)).toBe(1);
    expect(m.edgeOf(e.id)?.index).toBe(1);
  });
});

describe('a column can hold one', () => {
  it('stores an id and looks it up in the state that follows', () => {
    const m = ring();
    const partner = m.points.at(0).id;
    // A column is numbers, which is why an id is a number: a sketch marks a
    // partner in one step and finds it in the next.
    const marked = m.attribute('partner', () => partner as number);
    expect(marked.pointOf(marked.points.at(3).partner as never)).toBeDefined();
    expect(marked.rowOfPoint(marked.points.at(3).partner as never)).toBe(0);
  });
});

describe('through a step', () => {
  it('a survivor keeps its id, and a new point gets its own', () => {
    const m = ring();
    const before = ids(m);
    const after = m.steps(1, (cur, next) => {
      next.move(cur.points, () => [0.5, 0]);
    });
    // Moving changes nothing about who a point is.
    expect(ids(after)).toEqual(before);
    expect(after.pointOf(m.points.at(0).id)?.x).toBeCloseTo(0.5, 10);
  });

  it('a split retires the parent edge and gives both children their own', () => {
    const m = ring();
    const parent = m.edges.at(0).id;
    const after = m.steps(1, (cur, next) => {
      next.splitEdges(cur.edges.filter((_, i) => i === 0), { at: 0.5 });
    });
    // The parent is gone: a split ends it, and both halves are new.
    expect(after.rowOfEdge(parent)).toBe(-1);
    expect(after.edgeCount).toBe(m.edgeCount + 1);
    // Every other edge is untouched, and still itself.
    expect(after.rowOfEdge(m.edges.at(2).id)).toBeGreaterThanOrEqual(0);
  });

  it('a removed point is gone, and the rest keep their places', () => {
    const m = ring();
    const doomed = m.points.at(1).id;
    const kept = m.points.at(3).id;
    const after = m.steps(1, (cur, next) => {
      next.remove(cur.points.filter((_, i) => i === 1));
    });
    expect(after.pointOf(doomed)).toBeUndefined();
    expect(after.pointOf(kept)).toBeDefined();
  });

  it('an extracted selection is still made of the same points', () => {
    const m = ring();
    const id = m.points.at(2).id;
    const out = m.points.filter((_, i) => i >= 2).extract();
    expect(out.pointOf(id)).toBeDefined();
    expect(out.pointOf(id)?.x).toBe(10);
  });
});

describe('a selection outlives the state it was made in', () => {
  it('re-binds to a later state, dropping what is gone', () => {
    const m = ring();
    const left = m.points.filter((p) => p.x < 5);
    expect(left.length).toBe(2);
    const after = m.steps(1, (cur, next) => {
      next.remove(cur.points.filter((p) => p.x < 5 && p.y < 5));
    });
    // One of the two is gone; the other is still the same point.
    const again = left.in(after);
    expect(again.length).toBe(1);
    expect(again.at(0).id).toBe(left.at(1).id);
    expect(again.source).toBe(after);
  });

  it('is asked about by identity, not by row', () => {
    const m = ring();
    const some = m.points.filter((_, i) => i < 2);
    const later = m.attribute('age', 0);
    // The same points, a later state: membership holds.
    expect(some.has(later.vertex(1))).toBe(true);
    expect(some.has(later.vertex(3))).toBe(false);
    // A material that shares no identity is not a member, rows or no rows.
    expect(some.has(ring().vertex(1))).toBe(false);
  });

  it('a step verb takes a selection from an earlier state', () => {
    const m = ring();
    const outer = m.points.filter((p) => p.y < 5);
    const moved = m.steps(1, (_cur, next) => {
      // No re-selection: the selection from before the step still names
      // these two points, and the verb finds them.
      next.move(outer, () => [0, 3]);
    });
    expect(Array.from(moved.y)).toEqual([3, 3, 10, 10]);
  });

  it('an edge a split retired is gone from a re-bound selection', () => {
    const m = ring();
    const all = m.edges.filter(() => true);
    const after = m.steps(1, (cur, next) => {
      next.splitEdges(cur.edges.filter((_, i) => i === 0), { at: 0.5 });
    });
    const again = all.in(after);
    expect(again.length).toBe(m.edgeCount - 1); // the split parent is not there
  });
});

describe('lineage: a split ends an edge but not the wall it was', () => {
  it('gives a child a new id and its parent\'s root', () => {
    const m = ring();
    const parent = m.edges.at(0);
    const parentRoot = m.edgeRoots[0];
    const after = m.steps(1, (cur, next) => {
      next.splitEdges(cur.edges.filter((_, i) => i === 0), { at: 0.5 });
    });
    // The parent is retired, so its id resolves to nothing.
    expect(after.rowOfEdge(parent.id)).toBe(-1);
    // Two children carry the wall it was.
    const children = [...after.edges].filter((e) => after.edgeRoots[e.index] === parentRoot);
    expect(children).toHaveLength(2);
    // Each has an id of its own, and neither is the parent's.
    expect(new Set(children.map((e) => e.id as number)).size).toBe(2);
    expect(children.some((e) => (e.id as number) === (parent.id as number))).toBe(false);
  });

  it('a wall split twice still names one root', () => {
    const m = ring();
    const root = m.edgeRoots[0];
    let after = m.steps(1, (cur, next) => next.splitEdges(cur.edges.filter((_, i) => i === 0), { at: 0.5 }));
    after = after.steps(1, (cur, next) => {
      const firstChild = [...cur.edges].find((e) => cur.edgeRoots[e.index] === root)!;
      next.splitEdges(cur.edges.filter((_, i) => i === firstChild.index), { at: 0.5 });
    });
    const pieces = [...after.edges].filter((e) => after.edgeRoots[e.index] === root);
    expect(pieces).toHaveLength(3);
  });

  it('an edge that was never split is its own root', () => {
    const m = ring();
    for (const e of m.edges) expect(m.edgeRoots[e.index]).toBe(e.id as number);
  });
});
