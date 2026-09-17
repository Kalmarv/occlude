import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initOcclude, material } from '../src/index.js';
import { quadtree } from '../src/quadtree.js';

beforeAll(async () => {
  await initOcclude(readFileSync(fileURLToPath(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url))));
});

const B = { x: 0, y: 0, w: 64, h: 64 };
const cloud = (n: number, seed = 1) => {
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  return material(Array.from({ length: n }, () => [rnd() * 64, rnd() * 64] as [number, number]));
};

describe('quadtree', () => {
  it('splits where the points are, and the result is planar', () => {
    // All the points in one corner: that corner subdivides and the rest does
    // not, so the lattice is fine there and coarse everywhere else.
    const corner = material(Array.from({ length: 60 }, (_, k) => [1 + (k % 8) * 0.7, 1 + Math.floor(k / 8) * 0.7] as [number, number]));
    const grid = quadtree(corner, B, { capacity: 1 });
    const cells = grid.planarize().faces();
    expect(cells.length).toBeGreaterThan(40);
    const areas = cells.map((f) => f.area).sort((a, b) => a - b);
    expect(areas[areas.length - 1] / areas[0]).toBeGreaterThan(100); // coarse and fine in one lattice
    // The whole rectangle is accounted for, exactly once.
    expect(cells.map((f) => f.area).reduce((a, b) => a + b, 0)).toBeCloseTo(64 * 64, 6);
  });

  it('emits crosses, not four walls per cell, so nothing overlaps', () => {
    // This is the design claim: adjacent cells of different sizes would lay a
    // long edge over two short ones, and planarize refuses collinear overlaps.
    // If that ever regresses, this throws rather than quietly drawing twice.
    for (const seed of [1, 2, 3, 4, 5]) {
      const grid = quadtree(cloud(300, seed), B, { capacity: 1 });
      expect(() => grid.planarize().faces()).not.toThrow();
    }
  });

  it('capacity and depth are the two ways it stops', () => {
    const pts = cloud(200, 9);
    // A capacity no smaller than the cloud never splits: the bare rectangle.
    const whole = quadtree(pts, B, { capacity: 200 });
    expect(whole.edgeCount).toBe(4);
    expect(whole.planarize().faces().length).toBe(1);
    // A larger allowance is never a finer lattice.
    const tight = quadtree(pts, B, { capacity: 1 });
    const loose = quadtree(pts, B, { capacity: 8 });
    expect(loose.edgeCount).toBeLessThan(tight.edgeCount);
    // Coincident points can never be told apart, so depth is what stops it —
    // without that this would not return at all.
    const stacked = material(Array.from({ length: 30 }, () => [20, 20] as [number, number]));
    expect(quadtree(stacked, B, { capacity: 1, depth: 5 }).edgeCount).toBe(4 + 2 * 5);
    expect(quadtree(stacked, B, { capacity: 1, depth: 0 }).edgeCount).toBe(4);
  });

  it('is deterministic, ignores what lies outside, and refuses what it cannot use', () => {
    const pts = cloud(150, 4);
    expect(Array.from(quadtree(pts, B, {}).edgeList)).toEqual(Array.from(quadtree(pts, B, {}).edgeList));
    // Points outside the rectangle take no part in its subdivision.
    const outside = material([[-40, -40], [200, 200], [-5, 32]]);
    expect(quadtree(outside, B, { capacity: 1 }).edgeCount).toBe(4);
    expect(quadtree(material([]), B, {}).edgeCount).toBe(4);
    expect(() => quadtree(pts, B, { capacity: 0 })).toThrow(/at least 1/);
    expect(() => quadtree(pts, B, { capacity: 1.5 })).toThrow(/whole number/);
    expect(() => quadtree(pts, B, { depth: -1 })).toThrow(/non-negative/);
    expect(() => quadtree(pts, { x: 0, y: 0, w: 0, h: 10 }, {})).toThrow(/positive width and height/);
  });
});
