/**
 * Tables: a graph is two tables with ids, and a step is a pass over a
 * value (specs 71, 72). The three writes on each table and every skip
 * rule, the value you hold as the name of its row, the one instant of a
 * `set`, the recipes against their table lines, forces said without a
 * state, `t.steps` over a material, a lattice and an object, `t.pick` by
 * count and by share, and the new pure words.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { isPointSelection } from '../src/relation.js';
import { toolkit } from './helpers/run.js';
import {
  material, curve, connect, force, polar, angleTo, unit, add, distance, point, edge, Material,
  type Vertex, type Edge,
} from '../src/index.js';
import { initOcclude } from '../src/host.js';
import { latticeOf, type LatticeFace, type Lattice } from '../src/lattice.js';

beforeAll(async () => {
  await initOcclude(readFileSync(fileURLToPath(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url))));
});

/** A square: four points, three edges (an open chain 0-1-2-3). */
const chain = () => curve([[0, 0], [10, 0], [10, 10], [0, 10]], { closed: false });
const rows = (m: Material) => ({ x: [...m.x], y: [...m.y], edges: [...m.edgeList], attrs: Object.fromEntries(Object.entries(m.attrs).map(([k, v]) => [k, [...v]])), edgeAttrs: Object.fromEntries(Object.entries(m.edgeAttrs).map(([k, v]) => [k, [...v]])) });
const env = { bounds: { x: 0, y: 0, w: 10, h: 10 }, len: (l: unknown) => l as number };
const lattice = (): Lattice => latticeOf(env, { spacing: 1 });

describe('points: add, remove, set', () => {
  it('add takes one position, a list, and columns; the new rows come last', () => {
    const m = chain();
    const one = m.points.add([5, 5]);
    expect(one.n).toBe(5);
    expect([one.x[4], one.y[4]]).toEqual([5, 5]);
    expect('added' in one).toBe(false);
    const two = m.points.add([[1, 1], { x: 2, y: 2 }]);
    expect([...two.x.slice(4)]).toEqual([1, 2]);
    expect(two.edgeCount).toBe(3);
    // Identity: the old rows keep their ids, the new ones are new.
    expect([...two.pointIds.slice(0, 4)]).toEqual([...m.pointIds]);
    expect(new Set(two.pointIds).size).toBe(6);
    // m is unchanged.
    expect(m.n).toBe(4);
  });

  it('a new row gives every declared column; a new column is declared, 0 elsewhere', () => {
    const m = chain().points.set('age', 3);
    expect(() => m.points.add([1, 1])).toThrow(/must give 'age'/);
    const g = m.points.add([1, 1], { age: 0, heat: 7 });
    expect([...g.attrs.age]).toEqual([3, 3, 3, 3, 0]);
    expect([...g.attrs.heat]).toEqual([0, 0, 0, 0, 7]);
    expect(() => m.points.add([1, 1], { age: 0, index: 2 })).toThrow(/reserved/);
  });

  it('nothing, and a position that is not finite, add nothing', () => {
    const m = chain();
    expect(m.points.add(undefined).n).toBe(4);
    expect(m.points.add([]).n).toBe(4);
    const g = m.points.add([[NaN, 1], [3, 3]]);
    expect(g.n).toBe(5);
    expect([g.x[4], g.y[4]]).toEqual([3, 3]);
    expect(m.points.add([1, 1], { h: Infinity }).n).toBe(4);
  });

  it('remove takes the rows and every edge that names one; points of an earlier state by id', () => {
    const m = chain();
    const g = m.points.remove(m.points.at(1));
    expect(g.n).toBe(3);
    expect(g.edgeCount).toBe(1); // 2-3 is left
    expect([...g.pointIds]).toEqual([m.pointIds[0], m.pointIds[2], m.pointIds[3]]);
    // A selection of the earlier state names the same points by id.
    const later = g.points.add([50, 50]);
    const h = later.points.remove(m.points.filter((p) => p.x === 0));
    expect(h.n).toBe(2);
    // A member that is gone, an empty selection and nothing remove nothing.
    expect(g.points.remove(m.points.at(1)).n).toBe(3);
    expect(g.points.remove(g.points.filter(() => false)).n).toBe(3);
    expect(g.points.remove(undefined).n).toBe(3);
    expect(() => g.points.remove(material([[0, 0]]).points)).toThrow(/unrelated/);
  });

  it('set: a number, a function, a where; one instant for a record, a sequence for a chain', () => {
    const m = chain().points.set({ a: 1, b: 0 });
    // The record reads the table as it was: b sees the OLD a.
    const once = m.points.set({ a: (p) => p.a + 1, b: (p) => p.a * 10 });
    expect([...once.attrs.a]).toEqual([2, 2, 2, 2]);
    expect([...once.attrs.b]).toEqual([10, 10, 10, 10]);
    // A chain is a sequence: the second call reads what the first wrote.
    const seq = m.points.set('a', (p) => p.a + 1).points.set('b', (p) => p.a * 10);
    expect([...seq.attrs.b]).toEqual([20, 20, 20, 20]);
    // where: a selection, a predicate, one member; a filtered selection writes its own members.
    expect([...m.points.set('a', 5, m.points.filter((p) => p.x > 0)).attrs.a]).toEqual([1, 5, 5, 1]);
    expect([...m.points.set('a', 5, (p) => p.y > 0).attrs.a]).toEqual([1, 1, 5, 5]);
    expect([...m.points.set('a', 5, m.points.at(3)).attrs.a]).toEqual([1, 1, 1, 5]);
    expect([...m.points.filter((p) => p.index === 0).set('a', 9).attrs.a]).toEqual([9, 1, 1, 1]);
    // A where that names nothing writes nothing — an undefined one too.
    expect([...m.points.set('a', 5, undefined).attrs.a]).toEqual([1, 1, 1, 1]);
    // A value that is not finite leaves that row as it was.
    expect([...m.points.set('a', (p) => (p.index === 2 ? NaN : 4)).attrs.a]).toEqual([4, 4, 1, 4]);
    // x and y are columns; reserved names are not.
    expect([...m.points.set('x', (p) => p.x + 1).x]).toEqual([1, 11, 11, 1]);
    expect(() => m.points.set('id', 1)).toThrow(/reserved/);
  });
});

describe('edges: add, remove, set', () => {
  it('add takes views and point values; a bare position or an id is a wrong program', () => {
    const m = chain();
    const [p0, , p2, p3] = [...m.points];
    const g = m.edges.add([p0, p2]);
    expect(g.edgeCount).toBe(4);
    expect([g.edgeList[6], g.edgeList[7]]).toEqual([0, 2]);
    // A list of pairs.
    expect(m.edges.add([[p0, p2], [p0, p3]]).edgeCount).toBe(5);
    // A view of an earlier state names the same point by id.
    const q = point([20, 20]);
    const later = m.points.add(q);
    const h = later.edges.add([p0, q]);
    expect([...h.edgeList.slice(6)]).toEqual([0, 4]);
    // A position names nothing: the write refuses it by name.
    expect(() => m.edges.add([[0, 0], [10, 10]] as never)).toThrow(/expected a point — a vertex view or a point value; make one with point/);
    expect(() => m.edges.add([p0, [10, 10]] as never)).toThrow(/expected a point — a vertex view or a point value/);
    expect(() => m.edges.add([p0, { x: 10, y: 10 }] as never)).toThrow(/expected a point — a vertex view or a point value/);
    expect(() => m.edges.add([m.pointIds[0], m.pointIds[3]] as never)).toThrow(/expected a point — a vertex view or a point value/);
  });

  it('skips gone, self and already, and a row with an undefined end', () => {
    const m = chain();
    const [p0, p1, p2] = [...m.points];
    const gone = m.points.remove(p2);
    expect(gone.edges.add([p0, p2]).edgeCount).toBe(gone.edgeCount); // gone
    expect(m.edges.add([p0, p0]).edgeCount).toBe(3); // self
    expect(m.edges.add([p1, p0]).edgeCount).toBe(3); // already, either way round
    expect(m.edges.add([[p0, p2], [p2, p0]]).edgeCount).toBe(4); // already within one write
    expect(m.edges.add([p0, undefined]).edgeCount).toBe(3);
    expect(m.edges.add([p0, point([0, 0])]).edgeCount).toBe(3); // a point value this graph does not hold: gone
    expect(m.edges.add(undefined).edgeCount).toBe(3);
    expect(m.edges.add([]).edgeCount).toBe(3);
  });

  it('remove keeps the points; set is the same contract on edges', () => {
    const m = chain();
    const g = m.edges.remove(m.edges.at(1));
    expect(g.n).toBe(4);
    expect(g.edgeCount).toBe(2);
    expect([...g.edgeIds]).toEqual([m.edgeIds[0], m.edgeIds[2]]);
    const w = m.edges.set('w', (e) => e.length, m.edges.filter((e) => e.index > 0));
    expect([...w.edgeAttrs.w]).toEqual([0, 10, 10]);
    expect(() => m.edges.set('length', 1)).toThrow(/reserved/);
    // A new edge gives every declared edge column.
    expect(() => w.edges.add([w.points.at(0), w.points.at(2)])).toThrow(/must give 'w'/);
    expect(w.edges.add([w.points.at(0), w.points.at(2)], { w: 3 }).edgeAttrs.w[3]).toBe(3);
  });
});

describe('the value you hold is the name', () => {
  it('a point value made outside names its row in every later state and write', () => {
    const m = chain();
    const q = point([20, 20]);
    const r = point([30, 30]);
    // The id is minted when the value is made, and the row keeps it.
    const g = m.points.add([q, r]);
    expect(g.pointIds[4]).toBe(q.id);
    expect(g.pointIds[5]).toBe(r.id);
    // Add an edge by the values, three states later.
    const later = g.points.set('h', 1).points.remove(g.points.at(0)).points.add([7, 7], { h: 0 });
    const joined = later.edges.add([q, r]);
    const e = joined.edges.at(-1);
    expect([e.a.id, e.b.id]).toEqual([q.id, r.id]);
    // Set, split, remove, move and extrude reach the same row.
    expect(joined.points.set('h', 5, q).pointOf(q.id)!.h).toBe(5);
    expect(joined.move([1, 0], q).pointOf(q.id)!.x).toBe(21);
    expect(joined.split(e).edges.filter((x) => x.a.id === q.id || x.b.id === q.id).length).toBe(1);
    expect(joined.points.remove(q).rowOfPoint(q.id)).toBe(-1);
    expect(joined.extrude(q, [0, 1], { h: 0 }).edges.at(-1).a.id).toBe(q.id);
    expect(joined.points.without(q).length).toBe(joined.n - 1);
    // A spread copy is a plain position, with no name.
    expect({ ...q }).toEqual({ x: 20, y: 20 });
  });

  it('a view from an earlier state names its row the same way', () => {
    const m = chain();
    const p1 = m.points.at(1);
    const g = m.points.add([50, 50]).points.remove(m.points.at(0));
    expect(g.points.set('h', 2, p1).pointOf(p1.id)!.h).toBe(2);
    expect(g.edges.add([p1, g.points.at(-1)]).edges.at(-1).a.id).toBe(p1.id);
    expect(g.points.remove(p1).rowOfPoint(p1.id)).toBe(-1);
    // An edge view of an earlier state names its edge.
    const e = m.edges.at(2);
    expect(g.split(e).rowOfEdge(e.id)).toBe(-1);
    expect(g.edges.remove(e).edgeCount).toBe(g.edgeCount - 1);
  });

  it('an edge value names two points and the row it becomes', () => {
    const m = chain();
    const q = point([20, 20]);
    const e = edge(m.points.at(3), q, { w: 2 });
    const g = m.points.add(q).edges.add(e);
    expect(g.edgeIds[3]).toBe(e.id);
    expect(g.edgeAttrs.w[3]).toBe(2);
    expect(g.edges.set('w', 7, e).edgeAttrs.w[3]).toBe(7);
    expect(g.edges.remove(e).edgeCount).toBe(3);
    const cut = g.split(e);
    expect(cut.rowOfEdge(e.id)).toBe(-1);
    expect(cut.n).toBe(6);
    // Its ends must be values or views.
    expect(() => edge([0, 0] as never, q)).toThrow(/expected a point — a vertex view or a point value/);
  });

  it('a value added twice is already; a value the geometry does not hold is gone', () => {
    const m = chain();
    const q = point([20, 20]);
    const g = m.points.add(q);
    expect(g.points.add(q)).toBe(g);
    expect(m.points.add([q, q]).n).toBe(5);
    // A view is a value: adding a row the state holds is already.
    expect(m.points.add(m.points.at(0))).toBe(m);
    const e = edge(g.points.at(0), q);
    const h = g.edges.add(e);
    expect(h.edges.add(e)).toBe(h);
    // From another geometry: gone, and skipped, in every write.
    const other = material([[1, 1], [2, 2]]);
    const stranger = other.points.at(0);
    const s = point([9, 9]);
    expect(m.edges.add([m.points.at(0), stranger]).edgeCount).toBe(3);
    expect(m.edges.add([m.points.at(0), s]).edgeCount).toBe(3);
    expect(m.points.remove(s)).toBe(m);
    expect(m.points.set('h', 1, s)).toBe(m);
    expect(m.extrude(s, [1, 1])).toBe(m);
    expect(m.split(edge(s, q))).toBe(m);
  });

  it('a bare position in a reference slot throws by name', () => {
    const m = chain();
    const msg = /expected a point — a vertex view or a point value; make one with point\(…\)/;
    expect(() => m.extrude([0, 0] as never, [1, 1])).toThrow(msg);
    expect(() => m.points.remove([0, 0] as never)).toThrow(msg);
    expect(() => m.points.set('h', 1, [0, 0] as never)).toThrow(msg);
    expect(() => m.points.without([0, 0] as never)).toThrow(msg);
    expect(() => m.split([0, 0] as never)).toThrow(/expected an edge — an edge view or an edge value/);
  });

  it('a point value gives every declared column; its own columns ride in', () => {
    const m = chain().points.set('age', 3);
    expect(() => m.points.add(point([1, 1]))).toThrow(/must give 'age'/);
    const g = m.points.add(point([1, 1], { age: 0 }));
    expect(g.attrs.age[4]).toBe(0);
    // `cols` gives the rest; the value's own columns win.
    expect(m.points.add(point([1, 1], { age: 5 }), { age: 9 }).attrs.age[4]).toBe(5);
    expect(m.points.add(point([1, 1]), { age: 9 }).attrs.age[4]).toBe(9);
    expect(() => point([1, 1], { id: 3 })).toThrow(/reserved/);
    expect(() => point([1, 1], { x: 3 })).toThrow(/reserved/);
  });
});

describe('selections', () => {
  it('at(-1), without and slice', () => {
    const m = chain();
    expect(m.points.at(-1).index).toBe(3);
    expect(m.edges.at(-1).index).toBe(2);
    expect(m.points.without(m.points.at(1)).indices).toEqual([0, 2, 3]);
    expect(m.points.without(m.points.filter((p) => p.x > 0)).indices).toEqual([0, 3]);
    expect(m.points.without(undefined).indices).toEqual([0, 1, 2, 3]);
    expect(m.points.slice(1, 3).indices).toEqual([1, 2]);
    expect(m.edges.slice(-1).indices).toEqual([2]);
    expect(m.edges.without(m.edges.at(0)).indices).toEqual([1, 2]);
  });
});

describe('snapshot writes: a set reads the table as it was', () => {
  it('on a material: set(col, fn) and set({…}) read the pre-write rows; a chain is a sequence', () => {
    // A line of five points, h = 1 at the first and 0 elsewhere. Each point
    // takes the h of the point before it: read from the old table, the 1
    // moves one row; read as it is written, it would run to the end.
    const line = curve([[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]], { closed: false }).points.set('h', (p) => (p.index === 0 ? 1 : 0));
    const before = (p: Vertex) => (p.index === 0 ? 0 : line.vertex(p.index - 1).h);
    const shiftOld = (p: Vertex) => (p.index === 0 ? 0 : p.adjacent.filter((a) => a.index < p.index).at(0).h);
    expect(shiftOld(line.points.at(1))).toBe(before(line.points.at(1)));
    const one = line.points.set('h', shiftOld);
    expect([...one.attrs.h]).toEqual([0, 1, 0, 0, 0]);
    const both = line.points.set({ h: shiftOld, k: (p) => p.h * 10 });
    expect([...both.attrs.h]).toEqual([0, 1, 0, 0, 0]);
    expect([...both.attrs.k]).toEqual([10, 0, 0, 0, 0]);
    const chained = line.points.set('h', shiftOld).points.set('h', shiftOld);
    expect([...chained.attrs.h]).toEqual([0, 0, 1, 0, 0]);
    // Edges: the same contract. Each edge takes the w of the edge before it.
    const w = line.edges.set('w', (e) => (e.index === 0 ? 1 : 0));
    const prev = (e: Edge) => (e.index === 0 ? 0 : e.a.edges.filter((x) => x.index === e.index - 1).at(0).w);
    expect([...w.edges.set('w', prev).edgeAttrs.w]).toEqual([0, 1, 0, 0]);
    expect([...w.edges.set({ w: prev, v: (e) => e.w }).edgeAttrs.v]).toEqual([1, 0, 0, 0]);
    expect([...w.edges.set('w', prev).edges.set('w', prev).edgeAttrs.w]).toEqual([0, 0, 1, 0]);
  });

  it('on a lattice: set(col, fn) and set({…}) read the pre-write faces; a chain is a sequence', () => {
    // A face takes the value of the face to its west, read from the old grid.
    const l = lattice().faces.set('v', (c) => (c.i === 0 ? 1 : 0));
    const west = (c: LatticeFace) => {
      const w = c.adjacent.filter((d) => d.i === c.i - 1 && d.j === c.j);
      return w.length === 0 ? 0 : w.at(0).v;
    };
    const one = l.faces.set('v', west);
    expect([...one.values.v.slice(0, 10)]).toEqual([0, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
    const both = l.faces.set({ v: west, u: (c) => c.v * 10 });
    expect([...both.values.v.slice(0, 3)]).toEqual([0, 1, 0]);
    expect([...both.values.u.slice(0, 3)]).toEqual([10, 0, 0]);
    const chained = l.faces.set('v', west).faces.set('v', west);
    expect([...chained.values.v.slice(0, 4)]).toEqual([0, 0, 1, 0]);
    // The laplacian reads the old grid too: one face of 4 spreads 1 to each side.
    const spot = lattice().faces.set('h', 0).faces.set('h', 4, [5.5, 5.5]);
    const spread = spot.faces.set('h', (c) => c.h + 0.25 * c.laplacian('h'));
    expect([spread.values.h[55], spread.values.h[54], spread.values.h[56], spread.values.h[45], spread.values.h[65], spread.values.h[53]]).toEqual([0, 1, 1, 1, 1, 0]);
  });
});

describe('recipes equal their table lines', () => {
  it('extrude is add a point, then add the edge', () => {
    const m = chain().points.set('age', 1);
    const from = m.points.at(2);
    const recipe = m.extrude(from, [3, 4], { age: 0 });
    const q = point(add(from, [3, 4]), { age: 0 });
    const lines = m.points.add(q).edges.add([from, q]);
    expect(rows(recipe)).toEqual(rows(lines));
    expect(m.extrude(undefined, [1, 1])).toBe(m);
    // A declared edge column is owed by the new edge: extrude says to write the two writes.
    expect(() => m.edges.set('w', 1).extrude(from, [1, 1], { age: 0 })).toThrow(/edge column 'w'/);
  });

  it('split is add the point, remove the edge, add two — the first child in the parent row', () => {
    const m = chain().points.set('h', (p) => p.index).edges.set('w', 4);
    const recipe = m.split(m.edges.filter((e) => e.index !== 1), 0.25);
    let lines = m;
    const cuts = [0, 2].map((e) => m.edges.at(e));
    // Each new point with its column by the transfer rule: h interpolates.
    for (const e of cuts) lines = lines.points.add([e.a.x + (e.b.x - e.a.x) * 0.25, e.a.y + (e.b.y - e.a.y) * 0.25], { h: e.a.h + (e.b.h - e.a.h) * 0.25 });
    lines = lines.edges.remove(lines.edges.filter((e) => e.index !== 1));
    lines = lines.edges.add([[lines.points.at(0), lines.points.at(4)], [lines.points.at(4), lines.points.at(1)], [lines.points.at(2), lines.points.at(5)], [lines.points.at(5), lines.points.at(3)]], { w: 4 });
    // The same rows as the lines, in another order: the first child takes
    // the parent's row and the second goes after the last row, so every
    // other edge keeps its row.
    const byEdge = (g: Material) => ({ ...rows(g), edges: [], edgeAttrs: {}, edgeRows: [...g.edges].map((e) => [e.a.index, e.b.index, e.w]).sort() });
    expect(byEdge(recipe)).toEqual(byEdge(lines));
    expect([...recipe.edges].map((e) => [e.a.index, e.b.index])).toEqual([[0, 4], [1, 2], [2, 5], [4, 1], [5, 3]]);
    expect(recipe.edgeIds[1]).toBe(m.edgeIds[1]);
    // The children keep the parent's lineage root.
    expect(recipe.edgeRoots[0]).toBe(m.edgeRoots[0]);
    expect(recipe.edgeRoots[3]).toBe(m.edgeRoots[0]);
    // at as a function; NaN skips that edge.
    expect(m.split(m.edges, (e) => (e.index === 0 ? NaN : 0.5)).n).toBe(6);
  });

  it('move is set x and y in one instant; move(...forces) is move(p => their sum)', () => {
    const m = chain();
    const recipe = m.move((p) => [p.y, 1]);
    const lines = m.points.set({ x: (p) => p.x + p.y, y: (p) => p.y + 1 });
    expect(rows(recipe)).toEqual(rows(lines));
    expect(rows(m.move([2, 3], m.points.at(1)))).toEqual(rows(m.points.set({ x: (p) => p.x + 2, y: (p) => p.y + 3 }, m.points.at(1))));
    const ring = curve([[0, 0], [3, 0], [3, 3], [0, 3], [1.5, 1.2]], { closed: true });
    const summed = ring.move(force.tension({ rest: 1 }), force.separation({ radius: 4, amount: (p: Vertex) => p.x / 3 }), force.relax({ amount: 0.5 }));
    // A force said without its state is prepared from the graph the move
    // reads: `prepare` is that step.
    type Pull = (p: Vertex) => [number, number];
    const t = force.tension({ rest: 1 }).prepare(ring) as Pull;
    const s = force.separation({ radius: 4 }).prepare(ring) as Pull;
    const r = force.relax({ amount: 0.5 }).prepare(ring) as Pull;
    const byHand = ring.move((p) => {
      const a = t(p);
      const b = s(p);
      const c = r(p);
      const k = p.x / 3;
      return [a[0] + b[0] * k + c[0], a[1] + b[1] * k + c[1]];
    });
    expect(rows(summed)).toEqual(rows(byHand));
    // tension takes an amount too, a number or one per point.
    const slow = ring.move(force.tension({ rest: 1, amount: 0.25 }));
    expect(rows(slow)).toEqual(rows(ring.move((p) => { const a = t(p); return [a[0] * 0.25, a[1] * 0.25]; })));
    // A move that is not finite leaves that point where it is.
    expect([...m.move((p) => (p.index === 1 ? [NaN, 0] : [1, 0])).x]).toEqual([1, 10, 11, 1]);
  });

  it('a force said without its state steps by half the mean of its pulls: calm with no amount', () => {
    // A lone pair closer than the radius is at the radius after one move,
    // each point taking half the way.
    const pair = material([[0, 0], [1, 0]]);
    const apart = pair.move(force.separation({ radius: 4 }));
    expect(apart.points.at(1)!.x - apart.points.at(0)!.x).toBeCloseTo(4, 12);
    // A lone stretched edge is at its rest length after one move.
    const edge = curve([[0, 0], [10, 0]]);
    const pulled = edge.move(force.tension({ rest: 2 }));
    expect(pulled.points.at(1)!.x - pulled.points.at(0)!.x).toBeCloseTo(2, 12);
    // A crowd moves no further than one push: however many sources are in
    // reach, a step is at most half the radius. The state-first form is the
    // sum, for a sketch that scales it itself.
    const crowd = material([[0, 0], ...Array.from({ length: 30 }, (_, k) => [0.01 * Math.cos(k), 0.2 + 0.01 * Math.sin(k)] as [number, number])]);
    const stepped = force.separation({ radius: 4 }).prepare(crowd)(crowd.points.at(0)!) as [number, number];
    const summed = force.separation(crowd, { radius: 4 })(crowd.points.at(0)!);
    expect(Math.hypot(stepped[0], stepped[1])).toBeLessThanOrEqual(2);
    expect(Math.hypot(summed[0], summed[1])).toBeGreaterThan(50);
  });
});

describe('the lattice as one table', () => {
  it('set on faces: number, function, where; l.set is l.faces.set; add and remove refuse', () => {
    const l = lattice().faces.set('ink', 0);
    expect(l.channels).toEqual(['a', 'ink']);
    const one = l.faces.set('ink', 3, l.faces.at(5));
    expect(one.values.ink[5]).toBe(3);
    expect(one.values.ink.reduce((s, v) => s + v, 0)).toBe(3);
    expect(l.faces.set('ink', 3, l.faces.at(5)).values.ink).toEqual(one.values.ink);
    const byTest = l.faces.set('ink', (c) => c.centroid[0], (c) => c.j === 0);
    expect(byTest.values.ink[3]).toBe(3.5);
    expect(byTest.values.ink[13]).toBe(0);
    expect(l.faces.set('ink', 3, undefined).values.ink.every((v) => v === 0)).toBe(true);
    // @ts-expect-error a lattice's faces have no add
    expect(() => l.faces.add()).toThrow(/faces are fixed/);
    // @ts-expect-error a lattice's faces have no remove
    expect(() => l.faces.remove()).toThrow(/faces are fixed/);
    expect(() => l.faces.set('i', 1)).toThrow(/reserved/);
    // A value that is not finite leaves the face as it was.
    expect(l.faces.set('ink', (c) => (c.index === 0 ? NaN : 1)).values.ink[0]).toBe(0);
  });

  it('points name the faces they fall in', () => {
    const l = lattice().faces.set('h', 5, material([[0.5, 0.5], [0.7, 0.2], [3.5, 4.5], [50, 50]]));
    expect([...l.values.h.keys()].filter((i) => l.values.h[i] === 5)).toEqual([0, 43]);
    expect(l.faces.set('h', 1, [2.5, 2.5]).values.h[22]).toBe(1);
  });

  it('a record set is one instant; a chain is a sequence', () => {
    const l = lattice().faces.set({ a: 1, b: 0 });
    const once = l.faces.set({ a: (c) => c.a + 1, b: (c) => c.a * 10 });
    expect(once.values.b[0]).toBe(10);
    const seq = l.faces.set('a', (c) => c.a + 1).faces.set('b', (c) => c.a * 10);
    expect(seq.values.b[0]).toBe(20);
  });

  it('a face answers its centroid, columns, laplacian and adjacent; face(p) names the face under a point', () => {
    const l = lattice().faces.set('v', (c) => c.i * c.i + c.j);
    const c = l.face([3.5, 2.2])!;
    expect([c.i, c.j, ...c.centroid, c.index]).toEqual([3, 2, 3.5, 2.5, 23]);
    expect(c.v).toBe(11);
    expect(c.laplacian('v')).toBe((4 + 2) + (16 + 2) + (9 + 1) + (9 + 3) - 4 * 11);
    expect(c.adjacent.indices).toEqual([13, 22, 24, 33]);
    // The five-point stencil, zero-flux: west, east, south, north.
    const at = (i: number, j: number) => l.values.v[j * l.cols + i];
    expect(c.laplacian('v')).toBe((at(2, 2) - 11) + (at(4, 2) - 11) + (at(3, 1) - 11) + (at(3, 3) - 11));
    // Off the lattice: a face that reads 0 and that no write reaches.
    const off = l.face([-5, 2])!;
    expect(off.v).toBe(0);
    expect(l.faces.set('v', 99, off).values.v).toEqual(l.values.v);
    expect(l.face(undefined)).toBeUndefined();
    expect(l.faces.near([0.5, 0.5], { radius: 1.1 }).indices).toEqual([0, 1, 10]);
    expect(l.faces.at(-1).index).toBe(99);
  });
});

describe('t.steps', () => {
  it('folds the passes over a material, in order, n times, and keeps every m-th state', () => {
    const t = toolkit({ seed: 1 });
    const seen: string[] = [];
    const out = t.steps(3, chain(), (g) => { seen.push('a'); return g.points.add([g.n, 99]); }, (g) => { seen.push('b'); return g; });
    expect(seen).toEqual(['a', 'b', 'a', 'b', 'a', 'b']);
    expect(out.n).toBe(7);
    expect([...out.x.slice(4)]).toEqual([4, 5, 6]);
    const kept = t.steps(4, chain(), (g) => g.move([1, 0]), { every: 2 });
    expect(kept.history.map((h) => h.x[0])).toEqual([0, 2, 4]);
  });

  it('over a lattice and over a plain object', () => {
    const t = toolkit({ seed: 1 });
    const l = t.steps(5, lattice(), (x) => x.faces.set('a', (c) => c.a + 1), { every: 5 });
    expect(l.values.a[0]).toBe(5);
    expect(l.history.map((h) => h.values.a[0])).toEqual([0, 5]);
    const both = t.steps(2, { g: chain(), n: 0 }, ({ g, n }) => ({ g: g.move([1, 0]), n: n + 1 }), { every: 1 });
    expect(both.n).toBe(2);
    expect(both.g.x[0]).toBe(2);
    expect('history' in both).toBe(false);
    expect(() => t.steps(1, chain(), (() => undefined) as never)).toThrow(/returned nothing/);
  });

  it('history reaches any value that answers withHistory, and a kept state carries none of its own', () => {
    const t = toolkit({ seed: 1 });
    class Tally {
      constructor(readonly v: number, readonly history: readonly Tally[] = []) {}
      withHistory(states: readonly Tally[]): Tally { return new Tally(this.v, states); }
    }
    const tally = t.steps(3, new Tally(0), (x) => new Tally(x.v + 1), { every: 1 });
    expect(tally.v).toBe(3);
    expect(tally.history.map((x) => x.v)).toEqual([0, 1, 2, 3]);
    // A material run from a state that kept a history: the start is kept bare.
    const first = t.steps(2, chain(), (g) => g.move([1, 0]), { every: 1 });
    const second = t.steps(1, first, (g) => g.move([1, 0]), { every: 1 });
    expect(second.history.map((h) => h.x[0])).toEqual([2, 3]);
    expect(second.history.every((h) => h.history.length === 0)).toBe(true);
    // A lattice likewise.
    const l1 = t.steps(2, lattice(), (x) => x.faces.set('a', (c) => c.a + 1), { every: 1 });
    const l2 = t.steps(1, l1, (x) => x.faces.set('a', (c) => c.a + 1), { every: 1 });
    expect(l2.history.map((h) => h.values.a[0])).toEqual([2, 3]);
    expect(l2.history.every((h) => h.history.length === 0)).toBe(true);
    // Without { every }, nothing is kept.
    expect(t.steps(2, lattice(), (x) => x).history).toEqual([]);
  });

  it('a pass is (value) => value: no step count; a counter column is how a pass counts', () => {
    const t = toolkit({ seed: 1 });
    // @ts-expect-error a pass takes one argument
    expect(() => t.steps(2, chain(), (g, k: number) => g.move([k, 0]))).toThrow(/a pass is \(value\) => value/);
    const counted = t.steps(3, chain().points.set('age', 0), (g) => g.points.set('age', (p) => p.age + 1));
    expect([...counted.attrs.age]).toEqual([3, 3, 3, 3]);
    const byStep = t.steps(3, { g: chain(), k: 0 }, ({ g, k }) => ({ g: g.points.add([k, 50]), k: k + 1 }));
    expect([...byStep.g.x.slice(4)]).toEqual([0, 1, 2]);
  });
});

describe('t.pick by count and by share', () => {
  it('counts, distinct members, the collection kept, and the same picks under one seed', () => {
    const m = material(Array.from({ length: 20 }, (_, i) => [i, 0] as [number, number]));
    const a = toolkit({ seed: 7 });
    const five = a.pick(m.points, 5);
    expect(isPointSelection(five)).toBe(true);
    expect(five.length).toBe(5);
    expect(new Set(five.indices).size).toBe(5);
    expect(a.pick(m.points, 50).length).toBe(20);
    expect(a.pick(m.points, 0).length).toBe(0);
    expect(a.pick([1, 2, 3, 4], 2)).toHaveLength(2);
    expect(a.pick(m.points.filter(() => false), 3).length).toBe(0);
    const b = toolkit({ seed: 7 });
    expect(b.pick(m.points, 5).indices).toEqual(five.indices);
  });

  it('a share below one is a chance per member: one draw each, in order', () => {
    const m = material(Array.from({ length: 2000 }, (_, i) => [i, 0] as [number, number]));
    const a = toolkit({ seed: 5 });
    const some = a.pick(m.points, 0.25);
    expect(some.length).toBeGreaterThan(420);
    expect(some.length).toBeLessThan(580);
    // one draw per member: after the pick the stream is where 2000 draws put it
    const b = toolkit({ seed: 5 });
    for (let i = 0; i < 2000; i++) b.rnd();
    expect(a.rnd()).toBe(b.rnd());
    // a small selection can still fire
    const few = material([[0, 0], [1, 0], [2, 0]]);
    const t = toolkit({ seed: 1 });
    let fired = 0;
    for (let k = 0; k < 400; k++) fired += t.pick(few.points, 1 / 50).length;
    expect(fired).toBeGreaterThan(5);
    expect(fired).toBeLessThan(60);
  });

  it('an empty collection gives no member, and the draw is still taken', () => {
    const a = toolkit({ seed: 3 });
    const b = toolkit({ seed: 3 });
    expect(a.pick([])).toBeUndefined();
    b.pick([0]);
    expect(a.rnd()).toBe(b.rnd());
  });
});

describe('pure words', () => {
  it('polar, angleTo, unit', () => {
    const [x, y] = polar(2, Math.PI / 2);
    expect(x).toBeCloseTo(0, 12);
    expect(y).toBe(2);
    expect(angleTo([1, 1], [1, 3])).toBe(Math.PI / 2);
    expect(angleTo({ x: 0, y: 0 }, [-1, 0])).toBe(Math.PI);
    expect(unit([3, 4])).toEqual([0.6, 0.8]);
  });

  it('connect.pairs joins row i of one to row i of the other', () => {
    const g = connect.pairs(material([[0, 0], [1, 0]]), material([[0, 5], [1, 5]]));
    expect([...g.edgeList]).toEqual([0, 2, 1, 3]);
  });

  it('connect.unimpeded({ room: 2 }): a pair with no third point nearer both', () => {
    // A square and its middle: the sides have the middle nearer both ends
    // (distance 7.07 < 10), so only the four spokes are left.
    const g = connect.unimpeded(material([[0, 0], [10, 0], [10, 10], [0, 10], [5, 5]]), { room: 2 });
    const pairs = (m: Material) => [...m.edges].map((e) => [e.a.index, e.b.index].sort((p, q) => p - q).join('-')).sort();
    expect(pairs(g)).toEqual(['0-4', '1-4', '2-4', '3-4']);
    // Without the middle, the four sides; the diagonals have a corner nearer both.
    expect(pairs(connect.unimpeded(material([[0, 0], [10, 0], [10, 10], [0, 10]]), { room: 2 }))).toEqual(['0-1', '0-3', '1-2', '2-3']);
    // Points on a line: each joins the next.
    expect(pairs(connect.unimpeded(material([[0, 0], [3, 0], [1, 0]]), { room: 2 }))).toEqual(['0-2', '1-2']);
    // Against the definition, pair by pair, on a cloud.
    const t = toolkit({ seed: 4 });
    const cloud = t.throw({ count: 60 });
    const brute: string[] = [];
    for (let a = 0; a < cloud.n; a++) for (let b = a + 1; b < cloud.n; b++) {
      const d = distance(cloud.points.at(a), cloud.points.at(b));
      let empty = true;
      for (let r = 0; r < cloud.n && empty; r++) {
        if (r !== a && r !== b && distance(cloud.points.at(r), cloud.points.at(a)) < d && distance(cloud.points.at(r), cloud.points.at(b)) < d) empty = false;
      }
      if (empty) brute.push(`${a}-${b}`);
    }
    expect(pairs(connect.unimpeded(cloud, { room: 2 }))).toEqual(brute.sort());
    // A row read twice stands in nobody's way.
    expect(pairs(connect.unimpeded(material([[0, 0], [10, 0], [0, 0]]), { room: 2 }))).toEqual(['0-1']);
  });

  it('resample at a spacing keeps the network\'s junctions and ends', () => {
    const cross = connect.pairs(material([[0, 5], [5, 0]]), material([[10, 5], [5, 10]])).planarize();
    const r = cross.resample({ spacing: 1 });
    const middle = r.points.filter((p) => p.edges.length === 4);
    expect(middle.length).toBe(1);
    expect([middle.at(0).x, middle.at(0).y]).toEqual([5, 5]);
    expect(r.points.filter((p) => p.edges.length === 1).length).toBe(4);
    expect(r.n).toBe(21);
  });
});
