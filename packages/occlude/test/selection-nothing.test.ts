/**
 * The set words take nothing. `has(undefined)` is false; `rows`,
 * `intersect` and `without` read a nothing — `undefined` alone, or a hole
 * in a list — as naming no row. A sketch hands them `p.source` or a
 * `find` that found nothing without a guard, and the types agree.
 */

import { describe, expect, it } from 'vitest';
import { curve, type Edge, type Selection, type Vertex } from '../src/index.js';

const chain = () => curve([[0, 0], [10, 0], [10, 10], [0, 10], [0, 20]]);

describe('has takes nothing', () => {
  it('answers false for undefined, and true for a member', () => {
    const m = chain();
    const [a] = m.points;
    expect(m.points.has(undefined)).toBe(false);
    expect(m.edges.has(undefined)).toBe(false);
    expect(m.points.has(a)).toBe(true);
  });

  it('asks about a source without a guard: a row with none is not a member', () => {
    const g = chain();
    const cut = g.split(g.edges.at(1)!);
    const made = cut.points.at(-1)!;
    const first = cut.points.at(0)!;
    expect(first.source).toBeUndefined();
    // The typed call compiles: `source` may be undefined.
    const from: Selection<Edge> = g.edges;
    expect(from.has(made.source)).toBe(true);
    expect(from.has(first.source)).toBe(false);
  });
});

describe('rows, intersect and without skip a nothing', () => {
  it('rows of a list with holes holds the rows, in order; rows of nothing is empty', () => {
    const m = chain();
    const [a, b, c] = m.points;
    const holes: (Vertex | undefined)[] = [c, undefined, a, undefined];
    expect(m.points.rows(holes).indices).toEqual([2, 0]);
    expect(m.points.rows([a, undefined, b]).indices).toEqual([0, 1]);
    expect(m.points.rows(undefined).length).toBe(0);
    expect(m.points.rows([undefined]).length).toBe(0);
  });

  it('intersect keeps the members a list with holes names; nothing names none', () => {
    const m = chain();
    const [a, , c, d] = m.points;
    expect(m.points.intersect([d, undefined, a]).indices).toEqual([0, 3]);
    expect(m.points.intersect(c).indices).toEqual([2]);
    expect(m.points.intersect(undefined).length).toBe(0);
    expect(m.points.intersect([undefined, undefined]).length).toBe(0);
  });

  it('without takes away what a list with holes names; nothing takes nothing away', () => {
    const m = chain();
    const [a, , c] = m.points;
    expect(m.points.without([undefined, c, a]).indices).toEqual([1, 3, 4]);
    const all = m.points;
    expect(all.without(undefined)).toBe(all);
    expect(all.without([undefined]).indices).toEqual([0, 1, 2, 3, 4]);
  });

  it('a find that found nothing needs no guard', () => {
    const m = chain();
    const far = m.edges.find((e) => e.length > 100);
    expect(far).toBeUndefined();
    expect(m.edges.without(far).length).toBe(m.edges.length);
    expect(m.edges.intersect(far).length).toBe(0);
    expect(m.edges.rows(far).length).toBe(0);
    expect(m.edges.has(far)).toBe(false);
  });

  it('a hole is skipped, but a row of an unrelated material in the list is still refused', () => {
    const here = chain();
    const other = curve([[0, 0], [5, 0], [5, 5]]);
    expect(() => here.points.without([undefined, other.points.at(0)])).toThrow(/points\.without: that point is a row of an unrelated material/);
    expect(() => here.points.intersect([other.points.at(0), undefined])).toThrow(/points\.intersect: that point is a row of an unrelated material/);
  });

  it('a row that is gone drops out beside a hole', () => {
    const m = chain();
    const gone = m.points.at(4)!;
    const later = m.points.remove(gone);
    expect(later.points.rows([gone, undefined, m.points.at(1)]).indices).toEqual([1]);
    expect(later.points.without([gone, undefined]).length).toBe(later.points.length);
  });
});
