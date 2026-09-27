import { describe, expect, it } from 'vitest';
import { circle, curve, line, material, type Edge, type Vertex } from '../src/index.js';
import { memoisable, nodeOf } from '../src/derivation.js';
import { ownedBy } from '../src/views.js';
import { toolkit } from './helpers/run.js';

// `source` is typed by the view; a test reads it as the row it is.
const edgeUnder = (p: Vertex): Edge | undefined => p.source as unknown as Edge | undefined;
const parentOf = (p: Vertex): Vertex | undefined => p.source as unknown as Vertex | undefined;
/** Does `p` lie on the segment of `e` (to rounding)? */
const onEdge = (p: { x: number; y: number }, e: Edge): boolean => {
  const ax = e.a.x; const ay = e.a.y; const bx = e.b.x; const by = e.b.y;
  const cross = (bx - ax) * (p.y - ay) - (by - ay) * (p.x - ax);
  const dot = (p.x - ax) * (bx - ax) + (p.y - ay) * (by - ay);
  const len2 = (bx - ax) ** 2 + (by - ay) ** 2;
  return Math.abs(cross) / Math.sqrt(len2) < 1e-9 && dot >= -1e-9 && dot <= len2 + 1e-9;
};

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
      const e = edgeUnder(p)!;
      expect(e).toBeDefined();
      // A row of the input value, and the one under the sample.
      expect(ownedBy(e, square)).toBe(true);
      expect(onEdge(p, e)).toBe(true);
    }
    // Four samples a side, in order round the ring: the edges in turn. A
    // sample on a corner ends the edge that leads to it, as the walk
    // places it.
    expect(beads.points.map((p) => edgeUnder(p)!.index)).toEqual([0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3]);
    // One row, one value: the source is the input's own view of the edge.
    expect(edgeUnder(beads.points.at(1)!)).toBe(square.edges.at(0));
  });

  it('a face and a selection of curves name edges of the geometry they belong to', () => {
    const t = toolkit({ aspect: [1, 1] });
    const cells = t.voronoi(material([[20, 20], [70, 30], [40, 80]]));
    const face = cells.faces.at(1)!;
    const beads = t.sample(face, { count: 24 });
    for (const p of beads.points) {
      expect(ownedBy(edgeUnder(p)!, cells)).toBe(true);
      expect(onEdge(p, edgeUnder(p)!)).toBe(true);
    }
    const rings = curve([[10, 10], [60, 10], [60, 60]], { closed: true });
    const along = t.sample(rings.curves, { count: 9 });
    expect(along.points.map((p) => edgeUnder(p)!.index)).toEqual([0, 0, 0, 1, 1, 1, 2, 2, 2]);
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
    for (const p of named) expect(onEdge(p, edgeUnder(p)!)).toBe(true);
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

  it('the node: the shape in, the count or spacing as asked', () => {
    const t = toolkit({ aspect: [1, 1] });
    const c = circle(50, 50, 20);
    const ring = t.sample(c, { count: 30 });
    const node = nodeOf(ring)!;
    expect(node.op).toBe('t.sample');
    expect(node.inputs).toEqual([c]);
    expect(node.inputs[0]).toBe(c);
    expect(node.params).toEqual({ count: 30 });
    expect(memoisable(node)).toBe(true);
    // A write is a value of its own, with no node from the sample.
    expect(nodeOf(ring.move([1, 0]))).toBeUndefined();
    // Material through the door is `resample`; the node says what was asked.
    const again = t.sample(ring, { count: 10 });
    expect(nodeOf(again)).toMatchObject({ op: 't.sample', params: { count: 10 } });
    expect(nodeOf(again)!.inputs[0]).toBe(ring);
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
      const from = parentOf(p)!;
      expect(from).toBeDefined();
      expect(ownedBy(from, cloud)).toBe(true);
    }
    // Several children of one parent: many rows share one source row.
    const parents = new Set(settled.points.map((p) => parentOf(p)!.index));
    expect(parents.size).toBeLessThan(settled.n);
    const node = nodeOf(settled)!;
    expect(node.op).toBe('t.settle');
    expect(node.inputs[0]).toBe(cloud);
    expect(node.inputs[1]).toBe(dense);
    expect(node.params).toMatchObject({ spacing: 4, iterations: 6 });
    expect(node.seeded).toBe(true);
    expect(memoisable(node)).toBe(false);
  });

  it('t.settle of a selection names rows of the selection\'s material', () => {
    const t = toolkit({ aspect: [1, 1], seed: 4 });
    const cloud = t.scatter({ spacing: 6 });
    const left = cloud.points.filter((p) => p.x < 50);
    const settled = t.settle(left, { density: () => 1, spacing: 6, iterations: 3 });
    for (const p of settled.points) {
      const from = parentOf(p)!;
      expect(ownedBy(from, cloud)).toBe(true);
      expect(from.x).toBeLessThan(50);
    }
    // Kept through the space the toolkit stamps and a move after it.
    const moved = settled.move([1, 0]);
    moved.points.forEach((p, i) => expect(p.source).toBe(settled.points.at(i)!.source));
  });

  it('t.scatter, t.throw and t.relax record their nodes, and the cloud keeps its area', () => {
    const t = toolkit({ aspect: [1, 1], seed: 5 });
    const disc = circle(50, 50, 20);
    const cloud = t.scatter(disc, { spacing: 5 });
    const node = nodeOf(cloud)!;
    expect(node.op).toBe('t.scatter');
    expect(node.inputs[0]).toBe(disc);
    expect(node.params.spacing).toBe(5);
    expect(Array.isArray(node.params.within)).toBe(true);
    expect(node.seeded).toBe(true);
    const relaxed = t.relax(cloud);
    expect(nodeOf(relaxed)).toMatchObject({ op: 't.relax', seeded: false });
    expect(nodeOf(relaxed)!.inputs[0]).toBe(cloud);
    // The area the cloud was scattered in rides the relax.
    expect(nodeOf(relaxed)!.params.within).toBe(node.params.within);
    expect(nodeOf(t.throw({ count: 10 }))).toMatchObject({ op: 't.throw', params: { count: 10 }, seeded: true });
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
    expect(nodeOf(lines)).toMatchObject({ op: 't.streamlines', params: { spacing: 10 } });
  });
});

describe('the field and area words record their nodes', () => {
  it('t.isolines keeps its field and the levels it traced', () => {
    const t = toolkit({ aspect: [1, 1] });
    const field = (x: number, y: number) => Math.hypot(x - 50, y - 50) / 50;
    const rings = t.isolines(field, { count: 4 });
    const node = nodeOf(rings)!;
    expect(node.op).toBe('t.isolines');
    expect(node.inputs[0]).toBe(field);
    expect(node.params).toEqual({ at: { count: 4 } });
    const levels = node.kept.levels as number[];
    expect(levels.length).toBe(4);
    // Every curve's level is one of the levels the node keeps.
    for (const c of rings.curves) expect(levels).toContain(c.level);
    expect(memoisable(node)).toBe(false); // a closure is never memoised
  });

  it('t.voronoi, t.quadtree, t.tiling and t.material: the inputs as given, and the source Stage D built', () => {
    const t = toolkit({ aspect: [1, 1] });
    const sites = material([[20, 20], [70, 30], [40, 80]]);
    const cells = t.voronoi(sites);
    expect(nodeOf(cells)).toMatchObject({ op: 't.voronoi', params: {} });
    expect(nodeOf(cells)!.inputs[0]).toBe(sites);
    expect(cells.faces.map((f) => f.source)).toEqual([sites.vertex(0), sites.vertex(1), sites.vertex(2)]);
    const tree = t.quadtree(sites, { capacity: 1 });
    expect(nodeOf(tree)).toMatchObject({ op: 't.quadtree', params: { capacity: 1 } });
    expect(nodeOf(tree)!.inputs[0]).toBe(sites);
    const tiles = t.tiling(4, 4, { side: 25 });
    expect(nodeOf(tiles)).toMatchObject({ op: 't.tiling', inputs: [], params: { p: 4, q: 4, side: 25 } });
    const c = circle(50, 50, 10);
    expect(nodeOf(t.material(c))).toMatchObject({ op: 't.material', params: {} });
    expect(nodeOf(t.material(c))!.inputs[0]).toBe(c);
    // A material through `t.material` is handed back as it is: no node of its own.
    expect(t.material(sites)).toBe(sites);
    expect(nodeOf(sites)).toBeUndefined();
  });
});
