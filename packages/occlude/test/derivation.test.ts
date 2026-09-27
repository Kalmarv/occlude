import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { circle, curve, line, material, type Material } from '../src/index.js';
import { ownedBy } from '../src/views.js';
import { toolkit } from './helpers/run.js';
import { onEdge } from './helpers/shapes.js';
import { sourceRow } from './helpers/source.js';

// The collector, for the retention contract.
setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;

describe('t.sample keeps its rule: u and source', () => {
  it('a sampled circle: u is the arc-length fraction from the start, a ring stops short of 1', () => {
    const t = toolkit({ aspect: [1, 1] });
    const ring = t.sample(circle(50, 50, 20), { count: 8 });
    expect(ring.points.map((p) => p.u)).toEqual([0, 1 / 8, 2 / 8, 3 / 8, 4 / 8, 5 / 8, 6 / 8, 7 / 8]);
    // A shape has no rows: nothing to name as a source.
    expect(ring.points.map((p) => p.source)).toEqual(Array(8).fill(undefined));
  });

  it('an open chain runs from 0 to 1, and several outlines count each their own', () => {
    const t = toolkit({ aspect: [1, 1] });
    const run = t.sample(line(10, 10, 90, 10), { count: 5 });
    expect(run.points.map((p) => p.u)).toEqual([0, 0.25, 0.5, 0.75, 1]);
    const spaced = t.sample(line(10, 10, 90, 10), { spacing: 20 });
    expect(spaced.points.map((p) => p.u)).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });

  it('a sample of a ring of geometry: each point names the edge it lies on, and u runs round the ring', () => {
    const t = toolkit({ aspect: [1, 1] });
    const square = curve([[10, 10], [60, 10], [60, 60], [10, 60]], { closed: true });
    const beads = t.sample(square.curves.at(0)!, { count: 16 });
    expect(beads.points.map((p) => p.u)).toEqual(Array.from({ length: 16 }, (_, k) => k / 16));
    for (const p of beads.points) {
      // A row of the input value, and the one under the sample.
      const e = sourceRow(square.edges, p);
      expect(ownedBy(e, square)).toBe(true);
      expect(onEdge(p, e)).toBe(true);
    }
    // Four samples a side, in order round the ring: the edges in turn. A
    // sample on a corner ends the edge that leads to it, as the walk
    // places it.
    expect(beads.points.map((p) => sourceRow(square.edges, p).index)).toEqual([0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3]);
    // One row, one value: the source is the input's own view of the edge.
    expect(beads.points.at(1)!.source).toBe(square.edges.at(0));
  });

  it('a face and a selection of curves name edges of the geometry they belong to', () => {
    const t = toolkit({ aspect: [1, 1] });
    const cells = t.voronoi(material([[20, 20], [70, 30], [40, 80]]));
    const face = cells.faces.at(1)!;
    const beads = t.sample(face, { count: 24 });
    for (const p of beads.points) {
      const e = sourceRow(cells.edges, p);
      expect(ownedBy(e, cells)).toBe(true);
      expect(onEdge(p, e)).toBe(true);
    }
    const rings = curve([[10, 10], [60, 10], [60, 60]], { closed: true });
    const along = t.sample(rings.curves, { count: 9 });
    expect(along.points.map((p) => sourceRow(rings.edges, p).index)).toEqual([0, 0, 0, 1, 1, 1, 2, 2, 2]);
  });

  it('a selection of edges is geometry too; a closing chord no edge makes names none', () => {
    const t = toolkit({ aspect: [1, 1] });
    const hook = curve([[10, 10], [60, 10], [60, 60]]);
    // An open chain read as an area closes with a chord from its end back
    // to its start: samples on the chord lie on no edge of the input.
    const beads = t.sample(hook.edges, { count: 12 });
    const named = beads.points.filter((p) => p.source !== undefined);
    expect(named.length).toBeGreaterThan(0);
    expect(named.length).toBeLessThan(12);
    for (const p of named) expect(onEdge(p, sourceRow(hook.edges, p))).toBe(true);
    for (const p of beads.points.filter((q) => q.source === undefined)) expect(p.x - 10).toBeCloseTo(p.y - 10, 9);
  });

  it('source and u are kept by a move and a set, and a row added later has neither', () => {
    const t = toolkit({ aspect: [1, 1] });
    const square = curve([[10, 10], [60, 10], [60, 60], [10, 60]], { closed: true });
    const beads = t.sample(square.curves.at(0)!, { count: 8 });
    const moved = beads.move([5, 5]);
    const marked = moved.points.set('w', (p) => p.index * 2);
    for (const m of [moved, marked]) {
      expect(m.points.map((p) => p.u)).toEqual(beads.points.map((p) => p.u));
      m.points.forEach((p, i) => expect(p.source).toBe(beads.points.at(i)!.source));
    }
    // A column of the row's own called `u` wins over the rule's.
    const own = beads.points.set('u', 7);
    expect(own.points.map((p) => p.u)).toEqual(Array(8).fill(7));
    const grown = marked.points.add([0, 0], { w: 0 });
    expect(grown.points.at(-1)!.source).toBeUndefined();
    expect(grown.points.at(-1)!.u).toBeUndefined();
    expect(grown.points.at(3)!.source).toBe(beads.points.at(3)!.source);
    // A removed row takes its link with it; the rest keep theirs, by row.
    const fewer = marked.points.remove(marked.points.at(0)!);
    fewer.points.forEach((p, i) => {
      expect(p.u).toBe(beads.points.at(i + 1)!.u);
      expect(p.source).toBe(beads.points.at(i + 1)!.source);
    });
    // A run keeps them too: its states are writes of the start.
    const run = t.steps(3, beads, (g) => g.move([1, 0]));
    expect(run.points.map((p) => p.u)).toEqual(beads.points.map((p) => p.u));
  });

});

describe('the point words keep their rule', () => {
  it('t.settle: every point names the input point it descends from', () => {
    const t = toolkit({ aspect: [1, 1], seed: 3 });
    const cloud = t.scatter({ spacing: 8 });
    const dense = (x: number) => (x < 50 ? 1 : 0.2);
    const settled = t.settle(cloud, { density: dense, spacing: 4, iterations: 6 });
    expect(settled.n).toBeGreaterThan(cloud.n); // children were born
    for (const p of settled.points) {
      const from = sourceRow(cloud.points, p);
      expect(ownedBy(from, cloud)).toBe(true);
    }
    // Several children of one parent: many rows share one source row.
    const parents = new Set(settled.points.map((p) => sourceRow(cloud.points, p).index));
    expect(parents.size).toBeLessThan(settled.n);
  });

  it('t.settle of a selection names rows of the selection\'s material', () => {
    const t = toolkit({ aspect: [1, 1], seed: 4 });
    const cloud = t.scatter({ spacing: 6 });
    const left = cloud.points.filter((p) => p.x < 50);
    const settled = t.settle(left, { density: () => 1, spacing: 6, iterations: 3 });
    for (const p of settled.points) {
      const from = sourceRow(cloud.points, p);
      expect(ownedBy(from, cloud)).toBe(true);
      expect(from.x).toBeLessThan(50);
    }
    // Kept through the space the toolkit stamps and a move after it.
    const moved = settled.move([1, 0]);
    moved.points.forEach((p, i) => expect(p.source).toBe(settled.points.at(i)!.source));
  });

  it('a scattered cloud keeps its area: a relax of it stays inside, a written value keeps none', () => {
    const t = toolkit({ aspect: [1, 1], seed: 5 });
    const cloud = t.scatter(circle(50, 50, 20), { spacing: 5 });
    const reach = (m: Material) => Math.max(...m.points.map((p) => Math.hypot(p.x - 50, p.y - 50)));
    expect(reach(cloud)).toBeLessThan(20);
    // The area the cloud was scattered in rides the relax, and the one after.
    const relaxed = t.relax(cloud);
    expect(relaxed.points.length).toBe(cloud.points.length);
    expect(reach(relaxed)).toBeLessThan(20);
    expect(reach(t.relax(relaxed))).toBeLessThan(20);
    // A write makes a value of its own: its relax spreads over the drawable.
    expect(reach(t.relax(cloud.points.set('k', 1)))).toBeGreaterThan(20);
    // So does a cloud made by hand: it was bounded by nothing.
    expect(reach(t.relax(material(cloud.points.map((p) => [p.x, p.y] as [number, number]))))).toBeGreaterThan(20);
  });

  it('a relax loop written by hand holds the state it ends with, not every state it passed through', async () => {
    const t = toolkit({ aspect: [1, 1], seed: 5 });
    let m = t.scatter(circle(50, 50, 20), { spacing: 4 });
    const states: WeakRef<Material>[] = [];
    for (let i = 0; i < 30; i++) {
      m = t.relax(m, { iterations: 1 });
      states.push(new WeakRef(m));
    }
    // A weak reference holds its value to the end of the task that made it.
    await new Promise((r) => setTimeout(r, 0));
    gc();
    expect(states.filter((s) => s.deref() !== undefined).length).toBe(1);
    // The one it holds still keeps the area its cloud was bounded by.
    expect(Math.max(...t.relax(m).points.map((p) => Math.hypot(p.x - 50, p.y - 50)))).toBeLessThan(20);
  });

  it('a relaxed sample keeps its u: relax moves rows, it makes none', () => {
    const t = toolkit({ aspect: [1, 1] });
    const ring = t.sample(circle(50, 50, 20), { count: 12 });
    const relaxed = t.relax(ring);
    expect(relaxed.points.at(3)!.x).not.toBe(ring.points.at(3)!.x);
    expect(relaxed.points.map((p) => p.u)).toEqual(ring.points.map((p) => p.u));
  });

  it('t.streamlines: every point carries u along its own line', () => {
    const t = toolkit({ aspect: [1, 1] });
    const lines = t.streamlines(() => [1, 0.3], { spacing: 10 });
    expect(lines.curves.length).toBeGreaterThan(0);
    for (const c of lines.curves) {
      const us = c.points.map((p) => lines.points.at(p.index)!.u!);
      expect(us[0]).toBe(0);
      expect(us.at(-1)).toBeCloseTo(1, 12);
      for (let k = 1; k < us.length; k++) expect(us[k]).toBeGreaterThan(us[k - 1]);
    }
  });
});

describe('the field and area words', () => {
  it('t.isolines traces each level asked for, and every curve says which', () => {
    const t = toolkit({ aspect: [1, 1] });
    const rings = t.isolines((x: number, y: number) => Math.hypot(x - 50, y - 50) / 50, { count: 4 });
    expect(new Set(rings.curves.map((c) => c.level)).size).toBe(4);
    for (const c of rings.curves) expect(typeof c.level).toBe('number');
  });

  it('t.voronoi names each face\'s site; a material through t.material is handed back as it is', () => {
    const t = toolkit({ aspect: [1, 1] });
    const sites = material([[20, 20], [70, 30], [40, 80]]);
    const cells = t.voronoi(sites);
    expect(cells.faces.map((f) => f.source)).toEqual([sites.vertex(0), sites.vertex(1), sites.vertex(2)]);
    expect(t.material(sites)).toBe(sites);
  });
});
