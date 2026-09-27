/**
 * One Selection over every domain (selection.ts): one class, one
 * implementation of the shared words, the words a domain lacks refused by
 * name, rows held in an order, `near` nearest first, `union` n-ary, the
 * reductions, and `edges.nearest` / `edges.firstHit` answering what
 * `query.edges` answered.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import { toolkit } from './helpers/run.js';
import { connect, curve, material, type Material } from '../src/index.js';
import { Selection } from '../src/selection.js';
import { edges as edgeIndex } from '../src/query.js';
import { box, plane, pointCloud, instanceOnPoints } from '../src/three/api/index.js';

/** A 5 × 5 grid of points 10 apart, joined along rows and columns. */
function grid(): Material {
  const pts: [number, number][] = [];
  const eds: [number, number][] = [];
  for (let j = 0; j < 5; j++) for (let i = 0; i < 5; i++) pts.push([i * 10, j * 10]);
  for (let j = 0; j < 5; j++) for (let i = 0; i < 5; i++) {
    if (i < 4) eds.push([j * 5 + i, j * 5 + i + 1]);
    if (j < 4) eds.push([j * 5 + i, (j + 1) * 5 + i]);
  }
  return material(pts, { edges: eds });
}

const lattice = () => toolkit({ aspect: [1, 1] }).lattice({ spacing: 10 });

describe('one class over every domain', () => {
  const m = grid();
  const mesh = box().subdivide(1);
  const all = {
    points: m.points, edges: m.edges, faces: m.faces, 'lattice faces': lattice().faces,
    'mesh points': mesh.points, 'mesh edges': mesh.edges, 'mesh faces': mesh.faces, 'mesh corners': mesh.corners,
    'cloud points': pointCloud([[0, 0, 0], [1, 0, 0]]).points,
    'curve edges': mesh.edges.extract().edges,
    instances: instanceOnPoints(plane(), pointCloud([[0, 0, 0]]).points).points,
  };

  it('is one runtime class, with one implementation of the shared words', () => {
    for (const [name, sel] of Object.entries(all)) {
      expect(sel instanceof Selection, name).toBe(true);
      for (const word of ['filter', 'map', 'union', 'without', 'groupBy', 'adjacent', 'near', 'sum', 'mean'] as const) {
        expect((sel as unknown as Record<string, unknown>)[word], `${name}.${word}`).toBe((Selection.prototype as unknown as Record<string, unknown>)[word]);
      }
    }
  });

  it('answers the protocol words honestly: a word a kind has no answer to is absent', () => {
    expect(typeof m.faces.contours).toBe('function');
    expect('contours' in m.points).toBe(false);
    expect('contours' in m.edges).toBe(false);
    expect(m.points.curves.length).toBeGreaterThan(0);
    expect(m.points.curves).toBe(m.points.curves); // read once, kept
    // A value in space is the one geometry: its points walk into chains too.
    expect(mesh.points.curves).toBeDefined();
    expect('faces' in all['cloud points']).toBe(false);
    expect('faces' in m.points).toBe(false);
    expect('points' in lattice().faces).toBe(false);
    expect('edges' in lattice().faces).toBe(false);
    expect(lattice().faces.faces).toBeDefined();
    // A selection of a kind answers that kind with itself.
    const points = m.points;
    const edges = m.edges;
    const cells = m.faces;
    const corners = mesh.corners;
    expect(points.points).toBe(points);
    expect(edges.edges).toBe(edges);
    expect(cells.faces).toBe(cells);
    expect(corners.corners).toBe(corners);
  });

  it('refuses a word the domain cannot answer, by name', () => {
    expect(() => (m.faces.near as (p: unknown, o: unknown) => unknown)([0, 0], { radius: 5 })).toThrow('faces.near: faces have no near');
    expect(() => (m.points.nearest as (p: unknown, o: unknown) => unknown)([0, 0], { within: 5 })).toThrow('points.nearest: points have no nearest');
    expect(() => (m.points.boundaryEdges as () => unknown)()).toThrow('points.boundaryEdges: points have no boundaryEdges');
    expect(() => (m.edges.measure as () => unknown)()).toThrow('edges.measure: edges have no measure');
    expect(() => mesh.corners.adjacent()).toThrow('corners.adjacent: a corner has no');
    // Points with no edges are the one geometry too: each is its own piece.
    expect(all['cloud points'].components().length).toBe(2);
    expect(() => (all['mesh faces'].near as (p: unknown, o: unknown) => unknown)([0, 0, 0], { radius: 1 })).toThrow('faces.near: faces have no near');
    // A kind may say why.
    expect(() => (lattice().faces.extract as () => unknown)()).toThrow(/faces\.extract: a lattice's faces are squares of its own grid/);
    expect(() => (lattice().faces.add as () => unknown)()).toThrow(/faces\.add: a lattice's faces are fixed/);
  });

  it('has the relations on every domain with neighbours: points, edges, faces, lattice faces, mesh rows', () => {
    const cells = lattice().faces;
    const middle = cells.filter((c) => c.i === 4 && c.j === 4);
    expect(middle.adjacent().map((c) => [c.i, c.j])).toEqual([[4, 3], [3, 4], [5, 4], [4, 5]]);
    expect(middle.connected().length).toBe(cells.length);
    expect(cells.filter((c) => c.i === 0 || c.i === 9).components().length).toBe(2);
    const faces = m.faces;
    expect(faces.filter((f) => f.index === 0).adjacent().length).toBe(2); // a corner cell
    expect(mesh.faces.filter((f) => f.index === 0).adjacent().length).toBe(4);
  });
});

describe('a selection keeps an order', () => {
  const m = grid();

  it('is in row order as a whole collection; filter, without, intersect and slice keep the receiver order', () => {
    expect(m.points.indices).toEqual([...Array(25).keys()]);
    const mixed = m.points.rows([7, 3, 12, 1, 20]);
    expect(mixed.indices).toEqual([7, 3, 12, 1, 20]);
    expect(mixed.filter((p) => p.index !== 12).indices).toEqual([7, 3, 1, 20]);
    expect(mixed.without(m.points.at(3)).indices).toEqual([7, 12, 1, 20]);
    expect(mixed.without(m.points.rows([1, 7])).indices).toEqual([3, 12, 20]);
    expect(mixed.intersect(m.points.rows([20, 7, 1])).indices).toEqual([7, 1, 20]);
    expect(mixed.without(m.points.rows([3])).indices).toEqual([7, 12, 1, 20]);
    expect(mixed.slice(1, 3).indices).toEqual([3, 12]);
    expect(mixed.map((p) => p.index)).toEqual([7, 3, 12, 1, 20]);
    expect([...mixed].map((p) => p.index)).toEqual([7, 3, 12, 1, 20]);
    expect(mixed.at(-1).index).toBe(20);
  });

  it('union takes any number of selections: its own members, then each other’s new members in their order', () => {
    const a = m.points.rows([5, 2]);
    const b = m.points.rows([9, 2, 4]);
    const c = m.points.rows([4, 0, 5, 11]);
    expect(a.union(b, c).indices).toEqual([5, 2, 9, 4, 0, 11]);
    expect(a.union().indices).toEqual([5, 2]);
    expect(c.union(a).indices).toEqual([4, 0, 5, 11, 2]);
    // An operand of an earlier state is read by id.
    const later = m.points.set('h', 1);
    expect(later.points.rows([1]).union(a).indices).toEqual([1, 5, 2]);
  });

  it('keeps the order in each group and each component; the relations answer in row order', () => {
    const mixed = m.points.rows([24, 3, 13, 1, 20, 0]);
    expect(mixed.groupBy((p) => p.index % 2).map((g) => [g.key, g.indices])).toEqual([[0, [24, 20, 0]], [1, [3, 13, 1]]]);
    // Components meet in the receiver's order; each piece is in row order.
    expect(m.points.rows([24, 0, 1]).components().map((c) => c.indices)).toEqual([[24], [0, 1]]);
    expect(m.points.rows([12]).adjacent().indices).toEqual([7, 11, 13, 17]);
  });

  it('extracts the points in the selection’s order, and an edge selection’s edges in its order', () => {
    const picked = m.points.rows([4, 0]);
    const out = picked.extract();
    expect([out.x[0], out.x[1]]).toEqual([40, 0]);
    const ends = m.edges.rows([m.edges.length - 1, 0]).extract();
    expect(ends.edgeCount).toBe(2);
    expect(ends.edge(0).a.x).toBeGreaterThan(ends.edge(1).a.x);
  });
});

describe('near answers nearest first, ties by row', () => {
  it('points, in the plane: the ring at one distance comes in row order', () => {
    const m = grid();
    // From (21, 20): row 12 at 1, then row 13 at 9, then rows 7 and 17 at √82, then …
    const near = m.points.near([21, 20], { radius: 12 });
    const d = near.map((p) => Math.hypot(p.x - 21, p.y - 20));
    for (let k = 1; k < d.length; k++) expect(d[k]).toBeGreaterThanOrEqual(d[k - 1]);
    expect(near.indices.slice(0, 4)).toEqual([12, 13, 7, 17]);
    // From the middle of a cell, four corners at one distance: row order.
    expect(m.points.near([15, 15], { radius: 8 }).indices).toEqual([6, 7, 11, 12]);
    // A member is never its own neighbour; a selection answers with its own members.
    expect(m.points.near(m.points.at(12), { radius: 10.5 }).indices).toEqual([7, 11, 13, 17]);
    expect(m.points.rows([17, 13]).near(m.points.at(12), { radius: 10.5 }).indices).toEqual([13, 17]);
  });

  it('edges, by the distance to the whole edge', () => {
    const c = curve([[0, 0], [10, 0], [20, 0], [30, 0]], { closed: false });
    expect(c.edges.near([22, 1], { radius: 20 }).indices).toEqual([2, 1, 0]);
    expect(c.edges.near([15, 0], { radius: 20 }).indices).toEqual([1, 0, 2]);
  });

  it('lattice faces, by the distance to the centroid', () => {
    const cells = lattice().faces;
    const near = cells.near([52, 51], { radius: 16 });
    expect([near.at(0).i, near.at(0).j]).toEqual([5, 5]);
    const d = near.map((c) => Math.hypot(c.centroid[0] - 52, c.centroid[1] - 51));
    for (let k = 1; k < d.length; k++) expect(d[k]).toBeGreaterThanOrEqual(d[k - 1]);
  });

  it('3D points and edges', () => {
    const cube = box(2).subdivide(2);
    const p = cube.points.at(7)!;
    const near = cube.points.near(p, { radius: 1.2 });
    const d = near.map((q) => Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z));
    for (let k = 1; k < d.length; k++) expect(d[k]).toBeGreaterThanOrEqual(d[k - 1]);
    expect(near.has(p)).toBe(false);
    const at = { x: 0.3, y: -1, z: 0.2 };
    const edges = cube.edges.near(at, { radius: 0.8 });
    expect(edges.length).toBeGreaterThan(1);
    const seg = (e: { a: typeof at; b: typeof at }) => {
      const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y, dz = e.b.z - e.a.z;
      const t = Math.max(0, Math.min(1, ((at.x - e.a.x) * dx + (at.y - e.a.y) * dy + (at.z - e.a.z) * dz) / (dx * dx + dy * dy + dz * dz)));
      return Math.hypot(at.x - e.a.x - dx * t, at.y - e.a.y - dy * t, at.z - e.a.z - dz * t);
    };
    const de = edges.map(seg);
    for (let k = 1; k < de.length; k++) expect(de[k]).toBeGreaterThanOrEqual(de[k - 1]);
  });
});

describe('reductions', () => {
  const m = material([[0, 0], [10, 0], [20, 0], [30, 0]], { edges: [[0, 1], [1, 2], [2, 3]], age: [1, 2, 3, 6] });

  it('read a column by name or a function of the row', () => {
    expect(m.points.sum('age')).toBe(12);
    expect(m.points.mean('age')).toBe(3);
    expect(m.points.min('age')).toBe(1);
    expect(m.points.max('age')).toBe(6);
    expect(m.points.sum((p) => p.x)).toBe(60);
    expect(m.edges.mean('length')).toBe(10);
    expect(m.points.at(1).adjacent.mean('age')).toBe(2);
    expect(box().faces.sum('area')).toBeCloseTo(6, 9);
  });

  it('leave a value that is not finite out; nothing sums to 0 and means NaN', () => {
    expect(m.points.sum((p) => (p.index === 0 ? NaN : p.age))).toBe(11);
    const none = m.points.filter(() => false);
    expect(none.sum('age')).toBe(0);
    expect(none.mean('age')).toBeNaN();
    expect(none.min('age')).toBe(Infinity);
    expect(none.max('age')).toBe(-Infinity);
  });

  it('refuse a column that is not a number, by name', () => {
    expect(() => m.points.sum('nope')).toThrow("points.sum: 'nope' is not a number on every point");
    expect(() => m.points.mean(() => 'x' as unknown as number)).toThrow(/points\.mean: the function answered/);
  });
});

describe('edges.nearest and edges.firstHit answer what query.edges answered', () => {
  // A fixed web: a triangulation of a jittered grid.
  const web = connect.triangulate(material(Array.from({ length: 64 }, (_, k) => [(k % 8) * 12 + ((k * 7) % 5), Math.floor(k / 8) * 12 + ((k * 3) % 4)] as [number, number])));
  const old = edgeIndex(web);
  let s = 99;
  const rnd = () => ((s = (s * 48271) % 2147483647) / 2147483647);

  it('nearest: the same hit on a fixed case, with and without excludeIncident', () => {
    for (let k = 0; k < 200; k++) {
      const p: [number, number] = [rnd() * 100, rnd() * 100];
      const want = old.nearest(p, { within: 9 });
      const got = web.edges.nearest(p, { within: 9 });
      expect(got?.edge.index ?? -1).toBe(want?.edge.index ?? -1);
      if (got && want) {
        expect(got.distance).toBe(want.distance);
        expect(got.position).toEqual(want.position);
        expect(got.t).toBe(want.t);
      }
    }
    const v = web.points.at(20);
    expect(web.edges.nearest(v, { within: 30, excludeIncident: v })?.edge.index).toBe(old.nearest(v, { within: 30, excludeIncident: v })?.edge.index);
  });

  it('firstHit: the same hit on a fixed case', () => {
    for (let k = 0; k < 200; k++) {
      const from: [number, number] = [rnd() * 100, rnd() * 100];
      const to: [number, number] = [from[0] + (rnd() - 0.5) * 40, from[1] + (rnd() - 0.5) * 40];
      const want = old.firstHit(from, to);
      const got = web.edges.firstHit(from, to);
      expect(got?.edge.index ?? -1).toBe(want?.edge.index ?? -1);
      if (got && want) {
        expect(got.along).toBe(want.along);
        expect(got.kind).toBe(want.kind);
      }
    }
  });

  it('a selection of part of the state answers with its own members only', () => {
    const half = web.edges.filter((e) => e.center[0] < 50);
    for (let k = 0; k < 60; k++) {
      const p: [number, number] = [rnd() * 100, rnd() * 100];
      const got = half.nearest(p, { within: 25 });
      // The brute force among the members.
      let best = -1;
      let bestD = Infinity;
      for (const e of half) {
        const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y;
        const t = Math.max(0, Math.min(1, ((p[0] - e.a.x) * dx + (p[1] - e.a.y) * dy) / (dx * dx + dy * dy)));
        const d = Math.hypot(p[0] - e.a.x - dx * t, p[1] - e.a.y - dy * t);
        if (d <= 25 && (d < bestD || (d === bestD && e.index < best))) { best = e.index; bestD = d; }
      }
      expect(got?.edge.index ?? -1).toBe(best);
    }
    const from: [number, number] = [0, 50];
    const hit = half.firstHit(from, [100, 50]);
    expect(hit === null || half.has(hit.edge)).toBe(true);
  });
});

describe('relations answer selections', () => {
  it('edge.faces is a selection of the faces: the left, then the right', () => {
    const m = grid();
    const wall = m.edges.find((e) => e.a.x === 10 && e.b.x === 10 && e.a.y === 10)!;
    expect(wall.faces instanceof Selection).toBe(true);
    expect(wall.faces.length).toBe(2);
    expect(wall.faces.map((f) => f.centroid[0]).sort((a, b) => a - b)).toEqual([5, 15]);
    expect(m.faces.has(wall.faces.at(0))).toBe(true);
  });

  it('the 3D cross-domain words are properties, as `points` and `edges` are', () => {
    const cube = box();
    const top = cube.faces.filter((f) => f.normal[2] > 0.5);
    expect(top.corners.length).toBe(4);
    expect(top.corners.faces.length).toBe(1);
    // One edge's faces and one point's faces are row words.
    expect(cube.edges.at(0)!.faces.length).toBe(2);
    expect(cube.points.at(0)!.faces.length).toBe(3);
  });

  it('a group keeps its key type through filter, union and slice', () => {
    const m = grid();
    const [first] = m.points.groupBy((p) => (p.x < 20 ? 'left' : 'right'));
    expectTypeOf(first.filter(() => true).key).toEqualTypeOf<'left' | 'right'>();
    expect(first.filter((p) => p.y > 0).key).toBe('left');
    expect(first.union(m.points.rows([24])).key).toBe('left');
    expect(first.slice(0, 1).key).toBe('left');
  });
});
