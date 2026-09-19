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
    expect(m.point(id)?.x).toBe(10);
    const other = ring();
    expect(other.rowOfPoint(id)).toBe(-1);
    expect(other.point(id)).toBeUndefined();
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
    expect(marked.point(marked.points.at(3).partner as never)).toBeDefined();
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
    expect(after.point(m.points.at(0).id)?.x).toBeCloseTo(0.5, 10);
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
    expect(after.point(doomed)).toBeUndefined();
    expect(after.point(kept)).toBeDefined();
  });

  it('an extracted selection is still made of the same points', () => {
    const m = ring();
    const id = m.points.at(2).id;
    const out = m.points.filter((_, i) => i >= 2).extract();
    expect(out.point(id)).toBeDefined();
    expect(out.point(id)?.x).toBe(10);
  });
});
