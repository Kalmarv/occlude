import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { material, type Face } from '../src/index.js';
import { initOcclude } from '../src/host.js';
import { quadtree } from '../src/quadtree.js';
import { toolkit } from './helpers/run.js';
import { sourceSelection } from './helpers/source.js';

beforeAll(async () => {
  await initOcclude(readFileSync(fileURLToPath(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url))));
});

const B = { x: 0, y: 0, w: 64, h: 64 };
const cloud = (n: number, seed = 1) => {
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  return material(Array.from({ length: n }, () => [rnd() * 64, rnd() * 64] as [number, number]));
};
const inside = (f: Face, x: number, y: number) => x >= f.bounds.x && x <= f.bounds.x + f.bounds.w && y >= f.bounds.y && y <= f.bounds.y + f.bounds.h;

describe('quadtree', () => {
  it('splits where the points are: the leaves are the partition', () => {
    // All the points in one corner: that corner subdivides and the rest does
    // not, so the lattice is fine there and coarse everywhere else.
    const corner = material(Array.from({ length: 60 }, (_, k) => [1 + (k % 8) * 0.7, 1 + Math.floor(k / 8) * 0.7] as [number, number]));
    const tree = quadtree(corner, B, { capacity: 1 });
    const leaves = tree.faces.filter((f) => f.leaf);
    expect(leaves.length).toBeGreaterThan(40);
    const areas = leaves.map((f) => f.area).sort((a, b) => a - b);
    expect(areas[areas.length - 1] / areas[0]).toBeGreaterThan(100); // coarse and fine in one lattice
    // The whole rectangle is accounted for, exactly once, by the leaves.
    expect(leaves.sum('area')).toBeCloseTo(64 * 64, 6);
    // The walls are already planar: reading the picture finds the leaves.
    expect(tree.planarize().faces.length).toBe(tree.faces.length);
    expect(tree.planarize().edgeCount).toBe(tree.edgeCount);
  });

  it('every cell is a face, the root first and then breadth-first, nested by parent and children', () => {
    const pts = cloud(120, 3);
    const tree = quadtree(pts, B, { capacity: 4 });
    const faces = tree.faces;
    const root = faces.at(0);
    expect([root.depth, root.leaf, root.parent]).toEqual([0, false, undefined]);
    expect(root.area).toBeCloseTo(64 * 64, 9);
    expect(root.children.map((c) => c.index)).toEqual([1, 2, 3, 4]);
    // Breadth-first: depth never falls, and a parent comes before its children.
    const depths = faces.map((f) => f.depth);
    for (let k = 1; k < depths.length; k++) expect(depths[k]).toBeGreaterThanOrEqual(depths[k - 1]);
    for (const f of faces) {
      if (f.parent) {
        expect(f.parent.index).toBeLessThan(f.index);
        expect(f.depth).toBe(f.parent.depth + 1);
        expect(f.parent.children.has(f)).toBe(true);
      }
      // A cell that split has four children, a quarter of it each; a leaf none.
      expect(f.leaf).toBe(f.children.length === 0);
      if (!f.leaf) {
        expect(f.children.length).toBe(4);
        for (const c of f.children) expect(c.area).toBeCloseTo(f.area / 4, 9);
        expect(f.children.sum('area')).toBeCloseTo(f.area, 9);
        // A cell's outline is its box: its walls are the walls around its leaves.
        expect(f.contours()).toHaveLength(1);
        expect(f.bounds.w).toBeCloseTo(Math.sqrt(f.area), 9);
        expect(f.centroid[0]).toBeCloseTo(f.bounds.cx, 9);
      }
    }
    // The leaves partition the rectangle: every point of the cloud is in one leaf.
    const leaves = faces.filter((f) => f.leaf);
    expect(leaves.sum('area')).toBeCloseTo(64 * 64, 6);
    for (const p of pts.points) {
      const holding = leaves.filter((f) => inside(f, p.x, p.y) && sourceSelection(pts.points, f).has(p));
      expect(holding.length).toBe(1);
    }
  });

  it('a cell\'s source is the points it holds, as a selection of the input', () => {
    const pts = cloud(80, 5).points.set('tag', (p) => p.index);
    const tree = quadtree(pts, B, { capacity: 6 });
    const root = tree.faces.at(0);
    const held = (f: Face) => sourceSelection(pts.points, f);
    expect(held(root).length).toBe(80);
    expect(held(root).owner).toBe(pts);
    for (const f of tree.faces) {
      // No more than the allowance in a leaf; the parent holds the union of its children.
      if (f.leaf) expect(held(f).length).toBeLessThanOrEqual(6);
      else expect(f.children.sum((c) => held(c).length)).toBe(held(f).length);
      for (const p of held(f)) expect(inside(f, p.x, p.y)).toBe(true);
    }
    // A point selection is the input: its own material's rows, only its members.
    const some = pts.points.filter((p) => p.x < 32);
    const half = quadtree(some, B, { capacity: 6 });
    const halfRoot = sourceSelection(some, half.faces.at(0));
    expect(halfRoot.length).toBe(some.length);
    expect(halfRoot.every((p) => p.x < 32)).toBe(true);
    expect(halfRoot.at(0).tag).toBe(some.at(0).tag);
  });

  it('a move keeps the cells and their nesting; an edge write reads the leaves off the picture', () => {
    const tree = quadtree(cloud(60, 2), B, { capacity: 3 }).faces.set('shade', (f) => f.depth);
    const moved = tree.move([5, 0]);
    expect(moved.faces.length).toBe(tree.faces.length);
    expect(moved.faces.map((f) => f.depth)).toEqual(tree.faces.map((f) => f.depth));
    expect(moved.faces.at(1).parent!.index).toBe(0);
    // Remove one wall: the faces are the walk's now, flat, and a leaf whose
    // walls are unchanged keeps its column by lineage.
    const wall = tree.faces.filter((f) => f.leaf).at(0).boundaryEdges.filter((e) => e.faces.length === 2).at(0);
    const opened = tree.edges.remove(wall);
    expect(opened.faces.every((f) => f.leaf && f.depth === 0 && f.parent === undefined && f.source === undefined)).toBe(true);
    const leaves = tree.faces.filter((f) => f.leaf);
    expect(opened.faces.length).toBe(leaves.length - 1);
    // Every leaf whose walls the removal did not touch keeps its shade: its depth.
    const untouched = leaves.filter((f) => !f.boundaryEdges.has(wall));
    const byCentre = (f: Face) => `${f.centroid[0].toFixed(6)},${f.centroid[1].toFixed(6)}`;
    const shadeAt = new Map(opened.faces.map((f) => [byCentre(f), f.shade] as const));
    for (const f of untouched) expect(shadeAt.get(byCentre(f))).toBe(f.depth);
  });

  it('adjacent: across a wall, neither holding the other', () => {
    const tree = quadtree(cloud(100, 7), B, { capacity: 4 });
    for (const f of tree.faces) {
      for (const g of f.adjacent) {
        // Not an ancestor or a descendant.
        for (let a = g.parent; a; a = a.parent) expect(a.index).not.toBe(f.index);
        for (let a = f.parent; a; a = a.parent) expect(a.index).not.toBe(g.index);
      }
    }
    // Among the leaves, the relation is the partition's: a leaf's leaf neighbours share a wall.
    const leaf = tree.faces.filter((f) => f.leaf).at(0);
    for (const g of leaf.adjacent.filter((c) => c.leaf)) {
      expect(leaf.boundaryEdges.indices.some((e) => g.boundaryEdges.indices.includes(e))).toBe(true);
    }
  });

  it('capacity and depth are the two ways it stops', () => {
    const pts = cloud(200, 9);
    // A capacity no smaller than the cloud never splits: the bare rectangle, one leaf.
    const whole = quadtree(pts, B, { capacity: 200 });
    expect(whole.edgeCount).toBe(4);
    expect(whole.faces.length).toBe(1);
    expect(whole.faces.at(0).leaf).toBe(true);
    // A larger allowance is never a finer lattice.
    const tight = quadtree(pts, B, { capacity: 1 });
    const loose = quadtree(pts, B, { capacity: 8 });
    expect(loose.faces.length).toBeLessThan(tight.faces.length);
    // Coincident points can never be told apart, so depth is what stops it —
    // without that this would not return at all.
    const stacked = material(Array.from({ length: 30 }, () => [20, 20] as [number, number]));
    const deep = quadtree(stacked, B, { capacity: 1, depth: 5 });
    expect(deep.faces.length).toBe(1 + 4 * 5);
    expect(deep.faces.max('depth')).toBe(5);
    expect(quadtree(stacked, B, { capacity: 1, depth: 0 }).edgeCount).toBe(4);
  });

  it('is deterministic, ignores what lies outside, and refuses what it cannot use', () => {
    const pts = cloud(150, 4);
    expect(Array.from(quadtree(pts, B, {}).edgeList)).toEqual(Array.from(quadtree(pts, B, {}).edgeList));
    // Points outside the rectangle take no part in its subdivision.
    const outside = material([[-40, -40], [200, 200], [-5, 32]]);
    expect(quadtree(outside, B, { capacity: 1 }).edgeCount).toBe(4);
    expect(sourceSelection(outside.points, quadtree(outside, B, { capacity: 1 }).faces.at(0)).length).toBe(0);
    expect(quadtree(material([]), B, {}).edgeCount).toBe(4);
    expect(() => quadtree(pts, B, { capacity: 0 })).toThrow(/at least 1/);
    expect(() => quadtree(pts, B, { capacity: 1.5 })).toThrow(/whole number/);
    expect(() => quadtree(pts, B, { depth: -1 })).toThrow(/non-negative/);
    // A rectangle with no extent has no cell to subdivide.
    expect(quadtree(pts, { x: 0, y: 0, w: 0, h: 10 }, {}).n).toBe(0);
  });

  it('within an area: the cells are cut at it, the leaves still partition it, and only its points count', () => {
    const t = toolkit({ aspect: [1, 1] });
    const pts = t.scatter({ spacing: 4 });
    const disc: [number, number][] = Array.from({ length: 64 }, (_, k) => [50 + 30 * Math.cos((2 * Math.PI * k) / 64), 50 + 30 * Math.sin((2 * Math.PI * k) / 64)]);
    const tree = t.quadtree(pts, { capacity: 5, within: [disc] });
    const leaves = tree.faces.filter((f) => f.leaf);
    let discArea = 0;
    for (let k = 0; k < 64; k++) discArea += disc[k][0] * disc[(k + 1) % 64][1] - disc[(k + 1) % 64][0] * disc[k][1];
    expect(leaves.sum('area')).toBeCloseTo(Math.abs(discArea) / 2, 6);
    expect(tree.faces.at(0).area).toBeCloseTo(Math.abs(discArea) / 2, 6);
    for (const p of sourceSelection(pts.points, tree.faces.at(0))) expect(Math.hypot(p.x - 50, p.y - 50)).toBeLessThan(30.01);
    for (const f of leaves) expect(sourceSelection(pts.points, f).length).toBeLessThanOrEqual(5);
  });
});
