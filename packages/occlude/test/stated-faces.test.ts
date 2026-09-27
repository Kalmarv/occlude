/**
 * Stated faces and derived faces: one faces interface.
 *
 * `g.faces` is a property. A word that knows its faces — `t.grid`,
 * `t.tiling`, `t.voronoi`, `t.quadtree` — states them, in the order it
 * made them; any other material's faces are read off the picture by the
 * planar walk. A write that leaves the edges alone keeps a statement; a
 * write that changes them drops it, and the faces are derived, their
 * columns carried by wall lineage. Face columns are dense.
 */
import { describe, expect, it } from 'vitest';
import { material, type Face, type Material } from '../src/index.js';
import { grid } from '../src/layout.js';
import { toolkit } from './helpers/run.js';

const key = (f: Face) => `${f.centroid[0].toFixed(6)},${f.centroid[1].toFixed(6)}`;

/** The same 3 × 2 grid drawn by hand: its faces are read off the picture. */
function handGrid(): Material {
  const pts: [number, number][] = [];
  for (let j = 0; j <= 2; j++) for (let i = 0; i <= 3; i++) pts.push([i * 10, j * 10]);
  const at = (i: number, j: number) => j * 4 + i;
  const edges: [number, number][] = [];
  // Verticals first, so the rows are not the grid's own.
  for (let i = 0; i <= 3; i++) for (let j = 0; j < 2; j++) edges.push([at(i, j), at(i, j + 1)]);
  for (let j = 0; j <= 2; j++) for (let i = 0; i < 3; i++) edges.push([at(i, j), at(i + 1, j)]);
  return material(pts, { edges });
}

describe('stated and derived faces answer one interface', () => {
  it('a property, kept on the state; the same regions either way, the stated ones in their own order', () => {
    const stated = grid({ w: 30, h: 20 }, { cols: 3, rows: 2 });
    const derived = handGrid();
    expect(stated.faces).toBe(stated.faces);
    expect(derived.faces).toBe(derived.faces);
    // The same six squares.
    expect(stated.faces.map(key).sort()).toEqual(derived.faces.map(key).sort());
    // The grid says its order: row-major, with i and j.
    expect(stated.faces.map((f) => [f.i, f.j])).toEqual([[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1]]);
    // Every word of a face row answers on both.
    for (const cells of [stated.faces, derived.faces]) {
      for (const f of cells) {
        expect(f.area).toBeCloseTo(100, 9);
        expect(f.perimeter).toBeCloseTo(40, 9);
        expect(f.bounds.w).toBeCloseTo(10, 9);
        expect(f.contours()).toHaveLength(1);
        expect(f.edges.length).toBe(4);
        expect(f.boundaryEdges.length).toBe(4);
        expect(f.points.length).toBe(4);
        expect([f.depth, f.leaf, f.parent, f.children.length]).toEqual([0, true, undefined, 0]);
      }
      expect(cells.at(0).adjacent.length).toBe(2);
      expect(cells.boundaryEdges().length).toBe(10);
      expect(cells.contours()).toHaveLength(1);
    }
    // A face read off the picture came from nothing.
    expect(derived.faces.every((f) => f.source === undefined)).toBe(true);
  });

  it('a write that leaves the edges alone keeps the statement: a move, a point column, a face column, a step', () => {
    const t = toolkit({ aspect: [1, 1], seed: 2 });
    const g = t.grid({ cols: 4, rows: 3 });
    const order = (m: Material) => m.faces.map((f) => `${f.i},${f.j}`);
    const want = order(g);
    expect(order(g.move([2, 1]))).toEqual(want);
    expect(order(g.points.set('w', (p) => p.x))).toEqual(want);
    expect(order(g.faces.set('tone', 1))).toEqual(want);
    expect(order(g.edges.set('pen', 2))).toEqual(want); // a column is not an edge change
    expect(order(g.translate([3, 3]).rotate(10, { origin: [50, 50] }))).toEqual(want);
    expect(order(t.steps(3, g, (m) => m.move([0.5, 0])))).toEqual(want);
    // A point added apart from the walls touches no edge.
    expect(order(g.points.add([[500, 500]]))).toEqual(want);
    // A cell stays a cell when a move bends it past what the picture could read.
    const folded = g.move((p) => (p.x > 60 ? [-40, 0] : [0, 0]));
    expect(folded.faces.length).toBe(12);
  });

  it('a write that changes the edges drops it: the faces are read off the picture, columns carried by lineage', () => {
    const t = toolkit({ aspect: [1, 1] });
    const g = t.grid({ cols: 3, rows: 3 }).faces.set('mark', (f) => 10 * f.j + f.i);
    const middle = g.faces.find((f) => f.i === 1 && f.j === 1)!;
    // Remove the wall between (1, 1) and (2, 1): two cells become one.
    const wall = middle.boundaryEdges.filter((e) => e.faces.some((f) => f.i === 2 && f.j === 1)).at(0);
    const opened = g.edges.remove(wall);
    expect(opened.faces.length).toBe(8);
    // The untouched cells keep their columns, whatever order the walk found them in.
    const byCell = new Map(g.faces.map((f) => [key(f), f] as const));
    let kept = 0;
    for (const f of opened.faces) {
      const was = byCell.get(key(f));
      if (!was) continue;
      kept++;
      expect([f.i, f.j, f.mark]).toEqual([was.i, was.j, was.mark]);
    }
    expect(kept).toBe(7);
    // The merged face inherits from an old face it shares walls with.
    const merged = opened.faces.find((f) => f.area > 1.5 * middle.area)!;
    expect([11, 12]).toContain(merged.mark);
    // A split edge is a new edge too: the statement goes, the walls' lineage stays.
    const split = g.split(g.edges.at(0));
    expect(split.faces.map((f) => f.mark).sort((a, b) => a - b)).toEqual(g.faces.map((f) => f.mark).sort((a, b) => a - b));
  });

  it('face columns are dense: a face no write reached reads the fallback, else 0', () => {
    const g = grid({ w: 30, h: 20 }, { cols: 3, rows: 2 });
    const some = g.faces.filter((f) => f.i === 0).set('ink', 5);
    expect(some.faces.map((f) => f.ink)).toEqual([5, 0, 0, 5, 0, 0]);
    const withFallback = g.faces.filter((f) => f.i === 0).set('ink', 5, { fallback: -1 });
    expect(withFallback.faces.map((f) => f.ink)).toEqual([5, -1, -1, 5, -1, -1]);
    // Every face answers every column with a number.
    for (const f of some.faces) expect(typeof f.ink).toBe('number');
    // The stated columns are ordinary face columns: rewritten, and carried the same way.
    expect(g.faces.set('i', (f) => f.i * 2).faces.map((f) => f.i)).toEqual([0, 2, 4, 0, 2, 4]);
  });

  it('face selections of a stated state resolve on a later state by identity', () => {
    const g = grid({ w: 30, h: 20 }, { cols: 3, rows: 2 });
    const left = g.faces.filter((f) => f.i === 0);
    const moved = g.move([1, 1]);
    expect(moved.faces.intersect(left).map((f) => [f.i, f.j])).toEqual([[0, 0], [0, 1]]);
    expect(moved.faces.set('hit', 1, left).faces.map((f) => f.hit)).toEqual([1, 0, 0, 1, 0, 0]);
    // edge.faces reads the stated faces too.
    const e = g.faces.at(0).boundaryEdges.find((x) => x.faces.some((f) => f.index === 1))!;
    expect(e.faces.map((f) => f.index).sort()).toEqual([0, 1]);
  });
});
