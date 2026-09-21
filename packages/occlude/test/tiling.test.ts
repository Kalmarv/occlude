/**
 * `tiling(p, q)` — one word for the regular tilings of the sphere, the
 * plane and the hyperbolic disk.
 *
 * What is checked: the Schläfli test picks the right geometry; the
 * spherical tilings come back whole, with the face counts of the five
 * Platonic solids; the identity is always first and no two placements put
 * the cell in the same place; the cell really is the `{p, q}` cell (its
 * vertices sit at the circumradius the geometry's own relation gives, and
 * `q` of them meet at a vertex); and the hyperbolic case is the SAME
 * ANSWER `hyperbolic.tiling` gives, to the bit, because both run the one
 * flood.
 */

import { describe, expect, it } from 'vitest';
import { hyperbolic, tiling, tilingGeometry } from '../src/index.js';
import { sphereOfChart } from '../src/space.js';

/** Where a tiling puts the centre of each copy of its cell. */
const seats = (t: ReturnType<typeof tiling>): [number, number][] =>
  t.placements.map((f) => {
    const p = f([0, 0]);
    return [p[0], p[1]];
  });

describe('the symbol picks the geometry', () => {
  it('reads (p − 2)(q − 2) against 4', () => {
    for (const [p, q] of [[3, 3], [3, 4], [4, 3], [3, 5], [5, 3]]) expect(tilingGeometry(p, q)).toBe('spherical');
    for (const [p, q] of [[4, 4], [3, 6], [6, 3]]) expect(tilingGeometry(p, q)).toBe('euclidean');
    for (const [p, q] of [[7, 3], [3, 7], [5, 4], [4, 5], [5, 5]]) expect(tilingGeometry(p, q)).toBe('hyperbolic');
    for (const [p, q] of [[3, 3], [4, 4], [7, 3]]) expect(tiling(p, q).space).toBe(tilingGeometry(p, q));
  });

  it('refuses only p or q below 3, by name', () => {
    expect(() => tiling(2, 9)).toThrow(/whole numbers of 3 or more/);
    expect(() => tiling(9, 1)).toThrow(/whole numbers of 3 or more/);
    expect(() => tiling(3.5, 7)).toThrow(/whole numbers of 3 or more/);
    // Every symbol from 3 up draws something, in one geometry or another.
    for (const [p, q] of [[3, 3], [4, 4], [3, 6], [6, 3], [7, 3], [3, 7]]) {
      expect(tiling(p, q, { depth: 1 }).placements.length).toBeGreaterThan(1);
    }
  });
});

describe('the spherical tilings are the Platonic solids', () => {
  it('returns every face, and `depth` is ignored rather than refused', () => {
    const want: Record<string, number> = { '3,3': 4, '3,4': 8, '4,3': 6, '3,5': 20, '5,3': 12 };
    for (const key of Object.keys(want)) {
      const [p, q] = key.split(',').map(Number);
      expect(tiling(p, q).placements.length).toBe(want[key]);
      expect(tiling(p, q, { depth: 0 }).placements.length).toBe(want[key]);
      expect(tiling(p, q, { depth: 99 }).placements.length).toBe(want[key]);
    }
  });

  it('puts the cell on the sphere at the circumradius `cos R = cot(π/p)·cot(π/q)`', () => {
    for (const [p, q] of [[3, 3], [4, 3], [3, 5]]) {
      const t = tiling(p, q);
      expect(t.cell.length).toBe(p);
      const want = 1 / (Math.tan(Math.PI / p) * Math.tan(Math.PI / q));
      for (const v of t.cell) {
        // The vertex, back on the unit sphere, at angle R from the pole.
        expect(sphereOfChart(v)[2]).toBeCloseTo(want, 12);
      }
      // One vertex on the positive x axis, as in every geometry here.
      expect(t.cell[0][1]).toBeCloseTo(0, 12);
      expect(t.cell[0][0]).toBeGreaterThan(0);
    }
  });

  it('sends the cell to a different place every time, the identity first', () => {
    for (const [p, q] of [[3, 3], [4, 3], [3, 5], [5, 3]]) {
      const t = tiling(p, q);
      expect(t.placements[0]([0.11, 0.07])).toEqual([0.11, 0.07]);
      // One point inside the cell, and its whole orbit, read on the
      // SPHERE. The CENTRE of the cell will not do: one copy of it lands
      // opposite the chart's own pole, where the chart has no point and
      // says so with a NaN — which is the truth about a stereographic
      // picture of a sphere, not a gap in the tiling.
      const probe: [number, number] = [t.cell[0][0] * 0.5, t.cell[0][1] * 0.5];
      const orbit = t.placements.map((f) => sphereOfChart(f(probe)));
      for (let i = 0; i < orbit.length; i++) {
        for (const c of orbit[i]) expect(Number.isFinite(c)).toBe(true);
        for (let j = i + 1; j < orbit.length; j++) {
          const d = Math.hypot(orbit[i][0] - orbit[j][0], orbit[i][1] - orbit[j][1], orbit[i][2] - orbit[j][2]);
          expect(d).toBeGreaterThan(1e-6);
        }
      }
    }
  });
});

describe('the Euclidean tilings are the three of the plane', () => {
  it('grows one generation of edge neighbours at a time', () => {
    // Depth 0 is the cell alone; depth 1 adds its `p` edge neighbours.
    expect(tiling(4, 4, { depth: 0 }).placements.length).toBe(1);
    expect(tiling(4, 4, { depth: 1 }).placements.length).toBe(5);
    expect(tiling(3, 6, { depth: 1 }).placements.length).toBe(4);
    expect(tiling(6, 3, { depth: 1 }).placements.length).toBe(7);
    // and each generation reaches further.
    for (const [p, q] of [[4, 4], [3, 6], [6, 3]]) {
      let last = 0;
      for (const depth of [1, 2, 3]) {
        const n = tiling(p, q, { depth }).placements.length;
        expect(n).toBeGreaterThan(last);
        last = n;
      }
    }
  });

  it('gives the cell an edge of length 1, one vertex on the positive x axis', () => {
    for (const [p, q] of [[4, 4], [3, 6], [6, 3]]) {
      const t = tiling(p, q);
      expect(t.cell.length).toBe(p);
      for (let i = 0; i < p; i++) {
        const a = t.cell[i];
        const b = t.cell[(i + 1) % p];
        expect(Math.hypot(b[0] - a[0], b[1] - a[1])).toBeCloseTo(1, 12);
      }
      expect(t.cell[0][1]).toBeCloseTo(0, 12);
      expect(t.cell[0][0]).toBeGreaterThan(0);
    }
  });

  it('tiles without gap or overlap: every copy keeps the cell rigid', () => {
    const t = tiling(4, 4, { depth: 2 });
    const centres = seats(t);
    expect(centres[0]).toEqual([0, 0]);
    for (const f of t.placements) {
      // A placement is an ISOMETRY: it keeps every length in the cell.
      for (let i = 0; i < t.cell.length; i++) {
        const a = t.cell[i];
        const b = t.cell[(i + 1) % t.cell.length];
        const fa = f(a);
        const fb = f(b);
        expect(Math.hypot(fb[0] - fa[0], fb[1] - fa[1])).toBeCloseTo(1, 12);
      }
    }
    // No two squares land on top of each other: a unit square's centres
    // are a unit apart at the closest.
    for (let i = 0; i < centres.length; i++) {
      for (let j = i + 1; j < centres.length; j++) {
        expect(Math.hypot(centres[i][0] - centres[j][0], centres[i][1] - centres[j][1])).toBeGreaterThan(1 - 1e-9);
      }
    }
  });
});

describe('the hyperbolic case is `hyperbolic.tiling`', () => {
  it('answers the same placements, point for point', () => {
    for (const [p, q, depth] of [[7, 3, 3], [5, 4, 2], [3, 7, 3]]) {
      const generic = tiling(p, q, { depth });
      const disk = hyperbolic.tiling(p, q, { depth });
      expect(generic.space).toBe('hyperbolic');
      expect(generic.placements.length).toBe(disk.length);
      expect(generic.cell).toEqual(hyperbolic.polygon(p, q));
      for (const probe of [[0, 0], [0.11, 0.07], [-0.4, 0.33]] as [number, number][]) {
        for (let i = 0; i < disk.length; i++) {
          expect(generic.placements[i](probe)).toEqual(hyperbolic.apply(disk[i], probe));
        }
      }
    }
  });

  it('keeps the counts the disk has always answered with', () => {
    expect(hyperbolic.tiling(7, 3, { depth: 3 }).length).toBe(85);
    expect(hyperbolic.tiling(7, 3, { depth: 2 }).length).toBe(29);
    expect(hyperbolic.tiling(5, 4, { depth: 3 }).length).toBe(61);
    expect(tiling(7, 3, { depth: 3 }).placements.length).toBe(85);
  });

  it('keeps the disk words the disk\'s own, and names the generic one', () => {
    // `hyperbolic.polygon` and `hyperbolic.tiling` answer in the disk's
    // coordinates and with the disk's isometries, which a Euclidean or a
    // spherical symbol has none of.
    expect(() => hyperbolic.polygon(4, 4)).toThrow(/not a hyperbolic tiling/);
    expect(() => hyperbolic.polygon(4, 4)).toThrow(/tiling\(4, 4\)/);
    expect(() => hyperbolic.tiling(3, 4, { depth: 1 })).toThrow(/the sphere/);
    expect(() => hyperbolic.tiling(4, 4, { depth: 1 })).toThrow(/the Euclidean plane/);
  });
});
