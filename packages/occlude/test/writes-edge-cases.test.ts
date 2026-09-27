/**
 * Table writes and selections at their edges (spec 74, WP2): what lands is
 * decided before a row is numbered, a new column's kind settles on the first
 * value that lands, face columns are keyed by face id, a level set keeps its
 * area through a write that keeps its rows, a re-added edge is the wall it
 * was, and a list of the views a sketch holds names rows wherever a `where`
 * or a reference is taken.
 */
import { describe, expect, it } from 'vitest';
import { curve, material, type Material } from '../src/index.js';
import type { Vertex } from '../src/material.js';
import { toolkit } from './helpers/run.js';

const h = (m: Material): number[] => m.points.map((p) => p.h);

describe('split and replace decide what lands before numbering (bugs#2)', () => {
  const m = material([{ x: 0, y: 0, h: NaN }, { x: 10, y: 0, h: 1 }, { x: 20, y: 0, h: 2 }, { x: 30, y: 0, h: 3 }], { edges: [[0, 1], [1, 2], [2, 3]] });

  it('a cut whose point would not land leaves that edge as it is', () => {
    const out = m.split(m.edges);
    // The edge from the NaN row stays whole; the other two are cut.
    expect(out.edges.length).toBe(5);
    expect(h(out).slice(1)).toEqual([1, 2, 3, 1.5, 2.5]);
    expect(out.edges.map((e) => [e.a.x, e.b.x])).toContainEqual([0, 10]);
  });

  it('a motif whose points would not land leaves that edge as it is', () => {
    const motif = curve([[0, 0], [0.5, 0.3], [1, 0]]);
    const out = m.replace(m.edges, motif);
    expect(out.points.length).toBe(6);
    expect(out.edges.map((e) => [e.a.x, e.b.x])).toContainEqual([0, 10]);
  });
});

describe('a new column settles on the first value that lands (bugs#5)', () => {
  const c = curve([[0, 0], [1, 0], [2, 0]]);
  it('a number then a string is refused by name, as a string then a number is', () => {
    expect(() => c.points.set('tag', (p: Vertex) => (p.index === 0 ? 5 : 'a'))).toThrow(/points\.set: the column 'tag' holds a number a row, and this value is a string/);
    expect(() => c.points.set('tag', (p: Vertex) => (p.index === 0 ? 'a' : 5))).toThrow(/points\.set: the column 'tag' holds a string a row, and this value is a number/);
  });

  it('a value that does not land leaves the kind open', () => {
    const g = c.points.set('tag', (p: Vertex) => (p.index === 0 ? NaN : 'a'));
    expect(g.points.map((p) => p.tag)).toEqual(['', 'a', 'a']);
  });
});

describe('face columns are keyed by face id (bugs#3)', () => {
  it('two faces with the same walls keep their own values', () => {
    // A zig-zag made of one wall split twice, crossed by a line: three faces
    // whose walls are the same two lineages.
    let m = material([[0, 10], [20, 10], [-1, 5], [21, 5]], { edges: [[0, 1], [2, 3]] });
    const top = (g: Material) => g.edges.filter((e) => e.a.y === 10 && e.b.y === 10);
    m = m.split(top(m));
    m = m.split(top(m));
    m = m.move([0, -10], m.points.filter((p) => p.x === 5 || p.x === 15));
    const w = m.planarize();
    expect(w.faces.length).toBe(3);
    expect(w.faces.set('c', (f) => f.index + 1).faces.map((f) => f.c)).toEqual([1, 2, 3]);
    expect(w.faces.set('d', 7, w.faces.at(0)).faces.map((f) => f.d)).toEqual([7, 0, 0]);
  });
});

describe('a level set keeps its area through a write that keeps its rows (bugs#7)', () => {
  const t = toolkit();
  const m = t.isolines((x: number, y: number) => Math.sin(x / 15) + Math.cos(y / 20), [0.5]);
  const count = (g: Material) => [g.contours().length, g.faces.length];

  it('a column write, a face write and a step of t.steps', () => {
    const [contours, faces] = count(m);
    expect(contours).toBeGreaterThan(0);
    expect(count(m.edges.set('k', 1))).toEqual([contours, faces]);
    expect(count(m.points.set('h', 1))).toEqual([contours, faces]);
    expect(count(t.steps(1, m, (g) => g))).toEqual([contours, faces]);
  });

  it('a write that moves the rows leaves the area behind', () => {
    expect(m.move([0, 0]).contours().length).toBe(0);
    expect(m.points.set('x', (p: Vertex) => p.x).contours().length).toBe(0);
  });
});

describe('a re-added edge is the wall it was (bugs#10)', () => {
  it('keeps its lineage, so the faces through it resolve', () => {
    const t = toolkit();
    let g = t.grid({ cols: 2, rows: 1 });
    const wall = g.edges.find((e) => e.faces.length === 2)!;
    g = g.split(wall).faces.set('c', (f) => (f.i + 1) * 10);
    const piece = g.edges.filter((e) => e.faces.length === 2).at(0);
    const back = g.edges.remove(piece).edges.add(piece);
    expect(back.faces.intersect(g.faces).length).toBe(g.faces.length);
    expect(back.faces.map((f) => f.c)).toEqual([10, 20]);
  });
});

describe('a lattice place that is not finite is on no cell (bugs#12)', () => {
  it('answers the grid place -1, -1', () => {
    const l = toolkit().lattice({ spacing: 10 });
    const off = l.face([NaN, 1])!;
    expect([off.i, off.j, off.index]).toEqual([-1, -1, -1]);
  });
});

describe('rows and lists of views (promises#13, promises#34)', () => {
  const m = curve([[0, 0], [10, 0], [20, 0]]);
  const p = m.points.at(1);
  const later = m.points.remove(p);

  it('rows skips a gone view, and refuses a view of an unrelated geometry', () => {
    expect(later.points.rows(p).length).toBe(0);
    expect(later.points.rows([p, m.points.at(0)]).length).toBe(1);
    const other = curve([[0, 0], [5, 5]]);
    expect(() => later.points.rows(other.points.at(0))).toThrow(/points\.rows: .*unrelated materials/);
  });

  it('a plain list of views is a where and a reference', () => {
    const g = curve([[0, 0], [10, 0], [10, 10]]);
    const [a, b] = [g.points.at(0), g.points.at(1)];
    // `remove` is typed in relation.ts; a plain list reaches it as a sketch
    // writes it.
    const list = (...v: unknown[]): never => v as never;
    expect(g.points.remove(list(a, b)).points.length).toBe(1);
    expect(g.edges.remove(list(g.edges.at(0), g.edges.at(1))).edges.length).toBe(0);
    expect(g.move([1, 0], [a]).points.map((q) => q.x)).toEqual([1, 10, 10]);
    expect(g.points.set('w', 1, [b]).points.map((q) => q.w)).toEqual([0, 1, 0]);
    expect(g.split([g.edges.at(0)]).points.length).toBe(4);
    // A list that names a gone point skips it.
    expect(g.points.remove(list(a)).points.remove(list(a, b)).points.length).toBe(1);
  });
});

describe('move and the grid (promises#30, promises#36)', () => {
  it('a step with a third number moves in space, even a step of 0', () => {
    const sq = curve([[0, 0], [10, 0], [10, 10], [0, 10]], { closed: true });
    expect(sq.move([0, 0, 0]).points.map((q) => q.z)).toEqual([0, 0, 0, 0]);
    expect(sq.move([0, 0]).points.at(0).z).toBe(undefined);
    expect(sq.move((q: Vertex) => [0, 0, q.index]).points.map((q) => q.z)).toEqual([0, 1, 2, 3]);
  });

  it('t.grid refuses what is not a record, by name', () => {
    expect(() => (toolkit().grid as (a: unknown, b: unknown) => unknown)(3, 3)).toThrow(/t\.grid\(\{ cols, rows \}\)/);
  });
});
