/**
 * A tiling is GEOMETRY: a material whose corners and walls are shared.
 *
 * The three symbols stand for the three geometries — `{4, 4}` on the
 * flat sheet, `{7, 3}` in the sketch's own disk, `{3, 5}` on the sketch's
 * own sphere — and each is asked the same questions. Is it a material with
 * no duplicate wall? Is every corner where the placement puts it? Does
 * every sample sit on the geodesic its wall stands for? Do the faces come
 * out as the cells, with the generation and the hand of their placement?
 *
 * The sphere is the case the ordinary half-edge walk cannot answer: Fermi
 * coordinates wrap, and a closed surface has no outside. So the counts
 * there are checked hardest — 12 corners, 30 walls, 20 faces, Euler 2, and
 * not one half-edge left outside.
 */

import { describe, expect, it } from 'vitest';
import { toolkit } from './helpers/run.js';
import { space, strokes, Material, Tiling } from '../src/index.js';

/** The three cases, built once each. */
const flat = () => toolkit({ aspect: [1, 1] });
const disk = () => toolkit({ aspect: [1, 1], space: space.hyperbolic({ radius: 50 }) });
const ball = () => toolkit({ aspect: [1, 1], space: space.spherical({ radius: 30 }) });

const square = (): Tiling => flat().tiling(4, 4, { depth: 2 });
const heptagons = (): Tiling => disk().tiling(7, 3, { depth: 3 });
const icosahedron = (): Tiling => ball().tiling(3, 5);

/** Rows of the corners (the vertices a cell has an angle at) and of the
 * samples (the interior points of a wall). */
const cornerRows = (m: Tiling): number[] => [...m.attrs.corner].flatMap((v, i) => (v === 1 ? [i] : []));
const sampleCount = (m: Tiling): number => m.n - cornerRows(m).length;

/**
 * The walls: each one from corner to corner, through its own samples.
 * A sample has degree 2 and belongs to one wall, so the walk is forced.
 */
function walls(m: Tiling): { a: number; b: number; through: number[] }[] {
  const corner = m.attrs.corner;
  const at: number[][] = Array.from({ length: m.n }, () => []);
  for (let e = 0; e < m.edgeCount; e++) {
    at[m.edgeList[2 * e]].push(e);
    at[m.edgeList[2 * e + 1]].push(e);
  }
  const other = (e: number, v: number): number => (m.edgeList[2 * e] === v ? m.edgeList[2 * e + 1] : m.edgeList[2 * e]);
  const walked = new Set<number>();
  const out: { a: number; b: number; through: number[] }[] = [];
  for (const start of cornerRows(m)) {
    for (const first of at[start]) {
      if (walked.has(first)) continue;
      walked.add(first);
      const through: number[] = [];
      let edge = first;
      let v = other(first, start);
      while (corner[v] === 0) {
        through.push(v);
        const step = at[v].find((e) => e !== edge)!;
        walked.add(step);
        edge = step;
        v = other(step, v);
      }
      out.push({ a: start, b: v, through });
    }
  }
  return out;
}

describe('a tiling is a material of shared corners and shared walls', () => {
  it('is a Material, and no two edges join the same pair', () => {
    for (const tiles of [square(), heptagons(), icosahedron()]) {
      expect(tiles).toBeInstanceOf(Material);
      const seen = new Set<string>();
      for (let e = 0; e < tiles.edgeCount; e++) {
        const a = tiles.edgeList[2 * e];
        const b = tiles.edgeList[2 * e + 1];
        const key = a < b ? `${a},${b}` : `${b},${a}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
      // A material verb answers a plain material: a warped tiling is no
      // longer a tiling.
      const moved = tiles.map((p) => [p.x + 1, p.y]);
      expect(moved).toBeInstanceOf(Material);
      expect(moved).not.toBeInstanceOf(Tiling);
    }
  });

  it('puts every corner where the placement puts it', () => {
    for (const tiles of [square(), heptagons(), icosahedron()]) {
      // Every corner row is the image of some cell corner, and every image
      // of a cell corner is a corner row.
      const rows = new Set(cornerRows(tiles));
      let hits = 0;
      for (const place of tiles.placements) {
        for (const v of tiles.cell) {
          const want = place.point(v);
          let best = Infinity;
          for (const row of rows) best = Math.min(best, Math.hypot(tiles.x[row] - want[0], tiles.y[row] - want[1]));
          expect(best).toBeLessThan(1e-9);
          hits++;
        }
      }
      expect(hits).toBe(tiles.placements.length * tiles.cell.length);
    }
  });

  it('samples a curved wall along its own geodesic, and leaves a straight one alone', () => {
    // The flat picture: a geodesic of the sheet is straight, so a wall is
    // one edge and there is nothing to sample.
    expect(sampleCount(square())).toBe(0);
    for (const [t, tiles] of [[disk(), heptagons()], [ball(), icosahedron()]] as const) {
      expect(sampleCount(tiles)).toBeGreaterThan(0);
      for (const wall of walls(tiles)) {
        const a: [number, number] = [tiles.x[wall.a], tiles.y[wall.a]];
        const b: [number, number] = [tiles.x[wall.b], tiles.y[wall.b]];
        const pieces = wall.through.length + 1;
        wall.through.forEach((row, k) => {
          const want = t.space.geodesic(a, b, (k + 1) / pieces);
          expect(Math.hypot(tiles.x[row] - want[0], tiles.y[row] - want[1])).toBeLessThan(1e-9);
        });
      }
    }
  });
});

describe('the faces are the cells', () => {
  it('counts the icosahedron: 12 corners, 30 walls, 20 faces, and no outside', () => {
    const tiles = icosahedron();
    const cells = tiles.faces();
    expect(cornerRows(tiles).length).toBe(12);
    expect(walls(tiles).length).toBe(30);
    expect(cells.length).toBe(20);
    // Euler on the corners and the walls, not on the sampled rows.
    expect(cornerRows(tiles).length - walls(tiles).length + cells.length).toBe(2);
    // A closed surface has no outside: every half-edge belongs to a face.
    expect([...cells.faceOf].filter((f) => f < 0).length).toBe(0);
  });

  it('gives the plane and the disk one face per copy, with a rim', () => {
    for (const tiles of [square(), heptagons()]) {
      const cells = tiles.faces();
      expect(cells.length).toBe(tiles.placements.length);
      expect([...cells.faceOf].filter((f) => f < 0).length).toBeGreaterThan(0);
      // Euler for a patch of the plane: one face short of the closed count.
      expect(cornerRows(tiles).length - walls(tiles).length + cells.length).toBe(1);
    }
  });

  it('carries the generation, the hand and the placement of every copy', () => {
    for (const tiles of [square(), heptagons(), icosahedron()]) {
      const cells = tiles.faces();
      expect(tiles.seed).toBe(cells.faces[0]);
      expect(tiles.seed.placementIndex).toBe(0);
      expect(tiles.seed.generation).toBe(0);
      const seen = new Set<number>();
      for (const f of cells) {
        const i = f.placementIndex!;
        expect(seen.has(i)).toBe(false);
        seen.add(i);
        // The hand comes from the placement, never from a signed area.
        expect(f.mirrored).toBe(tiles.placements[i].orientation < 0 ? 1 : 0);
      }
      // A generation is a flood generation: the seed alone is 0, and every
      // copy after it shares a wall with one of the generation before.
      expect(cells.faces.filter((f) => f.generation === 0).length).toBe(1);
      for (const f of cells) {
        if (f.generation === 0) continue;
        expect(f.adjacent.some((g) => g.generation === f.generation! - 1)).toBe(true);
      }
    }
  });
});

describe('the drawing words read it', () => {
  it('draws every wall once', () => {
    for (const tiles of [square(), heptagons(), icosahedron()]) {
      const chains = tiles.curves();
      // Every edge in exactly one chain, exactly once: no wall retraced.
      let segments = 0;
      const rows = new Set<number>();
      for (const c of chains) {
        segments += c.closed ? c.indices.length : c.indices.length - 1;
        for (const i of c.indices) rows.add(i);
      }
      expect(segments).toBe(tiles.edgeCount);
      expect(strokes(tiles).length).toBe(chains.length);
    }
    // Where no corner has only two walls, a chain IS a wall.
    const ball35 = icosahedron();
    expect(strokes(ball35).length).toBe(walls(ball35).length);
  });

  it('moves through a placement and keeps every identity', () => {
    const tiles = heptagons();
    const place = tiles.placements[2];
    const moved = tiles.transform(place);
    expect([...moved.pointIds]).toEqual([...tiles.pointIds]);
    expect([...moved.edgeIds]).toEqual([...tiles.edgeIds]);
    for (const row of cornerRows(tiles)) {
      const want = place.point([tiles.x[row], tiles.y[row]]);
      expect(moved.x[row]).toBeCloseTo(want[0], 9);
      expect(moved.y[row]).toBeCloseTo(want[1], 9);
    }
  });
});

describe('side is the plane\'s own setting', () => {
  it('sets the wall length of a Euclidean tiling', () => {
    const tiles = flat().tiling(4, 4, { depth: 1, side: 10 });
    expect(sampleCount(tiles)).toBe(0);
    for (const wall of walls(tiles)) {
      const d = Math.hypot(tiles.x[wall.a] - tiles.x[wall.b], tiles.y[wall.a] - tiles.y[wall.b]);
      expect(d).toBeCloseTo(10, 9);
    }
  });

  it('refuses a curved symbol by name, and says what the side comes to', () => {
    expect(() => disk().tiling(7, 3, { side: 10 })).toThrow(/\{7, 3\} has the side its curvature fixes, \d+\.\d\d here/);
    expect(() => ball().tiling(3, 5, { side: 4 })).toThrow(/has the side its curvature fixes/);
    // The number it names is the metric side of the cell.
    const t = disk();
    const cell = t.tiling(7, 3, { depth: 0 }).cell;
    const want = t.space.distance(cell[0], cell[1]);
    expect(() => t.tiling(7, 3, { side: 10 })).toThrow(new RegExp(`fixes, ${want.toFixed(2)} here`));
  });
});

describe('each symbol answers through cell and placements in its own space', () => {
  it('keeps the plane on a flat sheet and the sphere in a spherical sketch', () => {
    for (const [t, p, q, n] of [[flat(), 4, 4, 13], [ball(), 3, 5, 20]] as const) {
      const tiles = t.tiling(p, q, { depth: 2 });
      expect(tiles.placements.length).toBe(n);
      expect(tiles.cell.length).toBe(p);
      for (const v of tiles.cell) expect(Number.isFinite(v[0]) && Number.isFinite(v[1])).toBe(true);
    }
  });
});
