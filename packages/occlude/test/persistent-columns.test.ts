/**
 * Materials and lattices on persistent columns: a write shares every leaf
 * it does not touch, a run's states share what they did not write, and a
 * row view is one object per row of a state.
 */

import { describe, expect, it } from 'vitest';
import { curve, material } from '../src/material.js';
import { restamp } from '../src/tables.js';
import { LEAF } from '../src/column.js';
import { toolkit } from './helpers/run.js';

const ring = (n: number) => curve(Array.from({ length: n }, (_, i) => [Math.cos((i / n) * 2 * Math.PI) * 40 + 50, Math.sin((i / n) * 2 * Math.PI) * 40 + 50] as [number, number]), { closed: true });

describe('writes share what they do not touch', () => {
  it('restamp shares every column', () => {
    const m = ring(10).points.set('age', 1).edges.set('rest', 2);
    const r = restamp(m, 7);
    expect(r.iteration).toBe(7);
    for (const key of ['x', 'y', 'pointIds', 'edgeList', 'edgeIds', 'edgeRoots'] as const) expect(r.store[key]).toBe(m.store[key]);
    expect(r.store.attrs.age).toBe(m.store.attrs.age);
    expect(r.store.edgeAttrs.rest).toBe(m.store.edgeAttrs.rest);
  });

  it('a split copies the leaves it touches and shares the rest', () => {
    const m = ring(4 * LEAF);
    const s = m.split(m.edges.at(3 * LEAF));
    const shared = (a: { leaves(): readonly unknown[] }, b: { leaves(): readonly unknown[] }) => a.leaves().filter((leaf, k) => leaf === b.leaves()[k]).length;
    // The new point goes on the end: every whole leaf of the points is shared.
    expect(shared(s.store.x, m.store.x)).toBe(4);
    expect(shared(s.store.pointIds, m.store.pointIds)).toBe(4);
    // The parent edge goes and the children go on the end: the edge rows in
    // front of it are shared (two values a row in the list).
    expect(shared(s.store.edgeIds, m.store.edgeIds)).toBe(3);
    expect(shared(s.store.edgeList, m.store.edgeList)).toBe(6);
    expect(s.points.length).toBe(4 * LEAF + 1);
    expect(s.edges.length).toBe(4 * LEAF + 1);
  });

  it('a move of some points copies only their leaves', () => {
    const m = ring(4 * LEAF);
    const moved = m.move([1, 0], m.points.at(5));
    for (const key of ['x', 'y'] as const) {
      const was = m.store[key].leaves();
      const now = moved.store[key].leaves();
      expect(now[0]).not.toBe(was[0]);
      for (let k = 1; k < was.length; k++) expect(now[k]).toBe(was[k]);
    }
    expect(moved.x[5]).toBe(m.x[5] + 1);
    expect(moved.store.pointIds).toBe(m.store.pointIds);
  });

  it('a run with history keeps the leaves its steps did not write, once', () => {
    const t = toolkit({ seed: 3 });
    const m = ring(3 * LEAF);
    const grown = t.steps(20, m, (g) => g.split(t.pick(g.edges)), { every: 5 });
    const first = grown.history[0];
    for (const s of grown.history) expect(s.store.x.leaves()[0]).toBe(first.store.x.leaves()[0]);
    expect(grown.points.length).toBe(3 * LEAF + 20);
  });

  it('a spend copies the leaves its marks touch', () => {
    const t = toolkit({ seed: 1 });
    const r = t.residual(() => 0.5, { spacing: 0.5 });
    const before = r.columns[0].leaves();
    const after = r.spend([[10, 10], [11, 10]], { width: 0.4 });
    const leaves = after.columns[0].leaves();
    const copied = leaves.filter((leaf, k) => leaf !== before[k]).length;
    expect(before.length).toBeGreaterThan(20);
    expect(copied).toBeGreaterThan(0);
    expect(copied).toBeLessThan(4);
    expect(after.faces.sum('owed')).toBeLessThan(r.faces.sum('owed'));
  });
});

describe('a row view is one object per row of a state', () => {
  it('points and edges read twice are the same view, and frozen', () => {
    const m = ring(12).points.set('age', (p) => p.index);
    const p = m.points.at(3);
    expect(m.points.at(3)).toBe(p);
    expect([...m.points][3]).toBe(p);
    expect(m.points.filter((q) => q.age === 3).at(0)).toBe(p);
    expect(m.points.near([p.x, p.y], { radius: 1 }).at(0)).toBe(p);
    const e = m.edges.at(2);
    expect(m.edges.at(2)).toBe(e);
    expect(e.a).toBe(m.points.at(m.edgeList[4]));
    expect(m.edges.map((x) => x)[2]).toBe(e);
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(e)).toBe(true);
    expect(() => { (p as { x: number }).x = 1; }).toThrow(TypeError);
    // A spread is still the plain record.
    expect({ ...p }).toEqual({ index: 3, x: p.x, y: p.y, age: 3 });
    // Another state has views of its own.
    expect(m.points.set('age', 0).points.at(3)).not.toBe(p);
    // A curve's points carry its own columns, one view per point there too.
    const c = m.curves.at(0);
    expect(c.points.at(1)).toBe(c.points.at(1));
    expect(typeof c.points.at(1).u).toBe('number');
    expect((m.points.at(1) as Record<string, unknown>).u).toBeUndefined();
  });

  it('a view read before many others is the same view after', () => {
    const m = ring(200);
    const p = m.points.at(3);
    const e = m.edges.at(5);
    // Reading every row moves the state's views from a few to all rows.
    const all = [...m.points];
    const edges = [...m.edges];
    expect(all[3]).toBe(p);
    expect(m.points.at(3)).toBe(p);
    expect(edges[5]).toBe(e);
    expect(m.edges.at(5).a).toBe(m.points.at(5));
  });

  it('a write hands its callback the view a read made of that row', () => {
    const m = ring(12);
    const target = m.points.at(2);
    const hit = m.points.set('hit', (p) => (p === target ? 1 : 0));
    expect(Array.from(hit.attrs.hit).indexOf(1)).toBe(2);
    expect(hit.points.filter((p) => p.hit === 1).length).toBe(1);
    const e = m.edges.at(4);
    const cut = m.split(m.edges, (x) => (x === e ? 0.5 : NaN));
    expect(cut.points.length).toBe(13);
  });

  it('a Voronoi face names its site by the site\'s own view', () => {
    const t = toolkit({ seed: 2 });
    const sites = material([[20, 20], [70, 30], [45, 70], [30, 50]]);
    const cells = t.voronoi(sites);
    for (const site of sites.points) {
      const f = cells.faces.find((g) => g.source === site);
      expect(f, `site ${site.index}`).toBeDefined();
      expect(f!.source.index).toBe(site.index);
    }
  });

  it('a lattice face read twice is the same view', () => {
    const t = toolkit({ seed: 1 });
    const l = t.lattice({ spacing: 10 }, () => 1);
    expect(l.faces.at(4)).toBe(l.faces.at(4));
    expect(l.faces.find((f) => f.index === 4)).toBe(l.faces.at(4));
  });
});
