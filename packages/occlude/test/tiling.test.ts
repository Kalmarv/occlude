/**
 * `t.tiling(p, q)` — one word for the regular tilings of the sphere, the
 * plane and the hyperbolic disk, on the drawable.
 *
 * Two layers are checked. The kernel (`src/tiling.ts`, internal) answers
 * in each geometry's own MODEL chart: the Schläfli test picks the
 * geometry, the spherical tilings come back whole with the face counts of
 * the five Platonic solids, the identity is always first, no two
 * placements put the cell in the same place, and the cell really is the
 * `{p, q}` cell. The toolkit word puts that chart on the drawable: when
 * the sketch's `space` IS the tiling's geometry the placements are
 * isometries of that space, and when it is not the model chart is fitted
 * to the drawable and drawn as a picture.
 */

import { describe, expect, it } from 'vitest';
import { toolkit } from './helpers/run.js';
import { space } from '../src/index.js';
import { tiling, tilingGeometry, type Tiling } from '../src/tiling.js';
import { sphereOfChart } from '../src/space.js';

/** Where a tiling puts the centre of each copy of its cell. */
const seats = (t: Tiling): [number, number][] =>
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
    const t = toolkit({ aspect: [1, 1] });
    expect(() => t.tiling(2, 5)).toThrow(/whole numbers of 3 or more/);
    expect(() => t.tiling(9, 1)).toThrow(/whole numbers of 3 or more/);
    expect(() => t.tiling(3.5, 7)).toThrow(/whole numbers of 3 or more/);
    // Every symbol from 3 up draws something, in one geometry or another.
    for (const [p, q] of [[3, 3], [4, 4], [3, 6], [6, 3], [7, 3], [3, 7]]) {
      expect(t.tiling(p, q, { depth: 1 }).placements.length).toBeGreaterThan(1);
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

  it('gives the model cell an edge of length 1, one vertex on the positive x axis', () => {
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

describe('the hyperbolic tilings are the disk\'s', () => {
  it('keeps the counts the disk has always answered with', () => {
    expect(tiling(7, 3, { depth: 3 }).placements.length).toBe(85);
    expect(tiling(7, 3, { depth: 2 }).placements.length).toBe(29);
    expect(tiling(7, 3, { depth: 1 }).placements.length).toBe(8);
    expect(tiling(7, 3, { depth: 4 }).placements.length).toBe(232);
    expect(tiling(5, 4, { depth: 3 }).placements.length).toBe(61);
  });

  it('is regular, and its corners carry the {p, q} angle', () => {
    const t = tiling(7, 3);
    expect(t.cell.length).toBe(7);
    const R = Math.hypot(t.cell[0][0], t.cell[0][1]);
    for (const v of t.cell) expect(Math.hypot(v[0], v[1])).toBeCloseTo(R, 12);
    // `cosh R_h = cot(π/p)·cot(π/q)`, and `tanh(R_h/2)` is the chart radius.
    const want = Math.tanh(Math.acosh(1 / (Math.tan(Math.PI / 7) * Math.tan(Math.PI / 3))) / 2);
    expect(R).toBeCloseTo(want, 12);
    // Every copy stays inside the disk, which is the whole plane.
    for (const [x, y] of seats(tiling(7, 3, { depth: 3 }))) expect(Math.hypot(x, y)).toBeLessThan(1);
  });
});

describe('t.tiling puts the chart on the drawable', () => {
  /** The largest circle the 100 × 100 drawable holds. */
  const FIT = 50;

  it('fits the model chart to the drawable when the geometry is not the sketch\'s', () => {
    const t = toolkit({ aspect: [1, 1] });
    const flat = t.tiling(7, 3, { depth: 2 });
    expect(flat.space).toBe('hyperbolic');
    const model = tiling(7, 3, { depth: 2 });
    for (let i = 0; i < model.cell.length; i++) {
      expect(flat.cell[i][0]).toBeCloseTo(50 + FIT * model.cell[i][0], 9);
      expect(flat.cell[i][1]).toBeCloseTo(50 + FIT * model.cell[i][1], 9);
    }
    // The identity is still first, and it is the identity on the drawable.
    expect(flat.placements[0]([37, 61])[0]).toBeCloseTo(37, 9);
    expect(flat.placements[0]([37, 61])[1]).toBeCloseTo(61, 9);
    // The whole picture lands inside the drawable's inscribed circle: the
    // model's rim is that circle.
    for (const f of flat.placements) {
      for (const v of model.cell) {
        const p = f([50 + FIT * v[0], 50 + FIT * v[1]]);
        expect(Math.hypot(p[0] - 50, p[1] - 50)).toBeLessThan(FIT + 1e-9);
      }
    }
  });

  it('is the sketch\'s own disk when the sketch is hyperbolic', () => {
    const t = toolkit({ aspect: [1, 1], space: space.hyperbolic({ radius: 40 }) });
    const tl = t.tiling(7, 3, { depth: 2 });
    // The cell comes back in the sketch's own coordinates, so the chart
    // is where its model radius is read: the space's own disk, not the
    // fitted one.
    const model = tiling(7, 3);
    const z = t.space.toChart(tl.cell[0]);
    expect(Math.hypot(z[0] - 50, z[1] - 50)).toBeCloseTo(40 * Math.hypot(model.cell[0][0], model.cell[0][1]), 9);
    // Every placement is an ISOMETRY of the space the sketch draws in.
    const probe: [number, number][] = [[50, 50], [62, 47], [41, 58], [55, 63]];
    for (const f of tl.placements) {
      for (let i = 0; i + 1 < probe.length; i++) {
        expect(t.space.distance(f(probe[i]), f(probe[i + 1]))).toBeCloseTo(t.space.distance(probe[i], probe[i + 1]), 7);
      }
    }
  });

  it('is the sketch\'s own sphere when the sketch is spherical', () => {
    const t = toolkit({ aspect: [1, 1], space: space.spherical({ radius: 30 }) });
    const tl = t.tiling(3, 5);
    expect(tl.space).toBe('spherical');
    expect(tl.placements.length).toBe(20);
    // The equator sits at twice the radius from the centre, and that is
    // where the model chart's unit circle lands.
    const model = tiling(3, 5);
    const z = t.space.toChart(tl.cell[0]);
    expect(Math.hypot(z[0] - 50, z[1] - 50)).toBeCloseTo(60 * Math.hypot(model.cell[0][0], model.cell[0][1]), 9);
    const probe: [number, number][] = [[50, 50], [62, 47], [41, 58]];
    // ONE copy of the cell lands opposite the point the chart is taken
    // from. In the CHART that place is the outside of the picture, with no
    // point of its own, so the copy comes back as a place — half a
    // circumference out, where a coordinate is a number like any other —
    // but with almost no precision left, because a placement is read
    // through the chart at both ends. Every other copy is an isometry of
    // the sketch's own sphere, exactly.
    const out = tl.placements.map((f) => t.space.distance([50, 50], f(probe[0])));
    expect(Math.max(...out)).toBeLessThanOrEqual(Math.PI * t.space.radius + 1e-9);
    for (let k = 0; k < tl.placements.length; k++) {
      const f = tl.placements[k];
      for (const v of probe) expect(Number.isFinite(f(v)[0])).toBe(true);
      if (out[k] > 0.9 * Math.PI * t.space.radius) continue;
      for (let i = 0; i + 1 < probe.length; i++) {
        expect(t.space.distance(f(probe[i]), f(probe[i + 1]))).toBeCloseTo(t.space.distance(probe[i], probe[i + 1]), 6);
      }
    }
  });

  it('keeps a Euclidean symbol an isometry of the sheet, whatever the fit', () => {
    for (const cfg of [{}, { space: space.hyperbolic({ radius: 60 }) }]) {
      const t = toolkit({ aspect: [1, 1], ...cfg });
      const tl = t.tiling(4, 4, { depth: 1 });
      expect(tl.space).toBe('euclidean');
      // A scaled plane tiling is a plane tiling: every copy is rigid on
      // the sheet, whether the sketch's space is flat or not.
      for (const f of tl.placements) {
        for (let i = 0; i < tl.cell.length; i++) {
          const a = tl.cell[i];
          const b = tl.cell[(i + 1) % tl.cell.length];
          expect(Math.hypot(...f(b).map((v, k) => v - f(a)[k]))).toBeCloseTo(Math.hypot(b[0] - a[0], b[1] - a[1]), 9);
        }
      }
      // The model's unit length is half the short side of the drawable.
      expect(Math.hypot(tl.cell[1][0] - tl.cell[0][0], tl.cell[1][1] - tl.cell[0][1])).toBeCloseTo(FIT, 9);
    }
  });
});
