/**
 * `t.distanceTo` under a `space`: the distance field of an area measured
 * by the METRIC the frame names, not by the sheet.
 *
 * A `circle` shape is the space's own circle, so the field is the signed
 * distance to it. Everything else is read as an area whose edges are
 * geodesics, and the value is the distance to the nearest of them,
 * positive inside. The proofs are the ones a distance field owes: zero on
 * the boundary, the right sign either side of it, the stated value at a
 * known point, invariance under the space's own isometries — which
 * `t.tiling` hands over as data — and NaN where the space has no place.
 *
 * A flat sketch is the old pure `distanceTo`, to the bit.
 */

import { describe, expect, it } from 'vitest';
import { toolkit } from './helpers/run.js';
import { circle, distanceTo, line, space } from '../src/index.js';

const hyp = () => toolkit({ aspect: [1, 1], space: space.hyperbolic({ radius: 45 }) });
const sph = () => toolkit({ aspect: [1, 1], space: space.spherical({ radius: 30 }) });

describe('a circle shape is the space\'s circle', () => {
  it('is zero on the loop it draws, and the radius at the centre', () => {
    for (const t of [hyp(), sph()]) {
      const c: [number, number] = [56, 44];
      const r = 9;
      const f = t.distanceTo(circle(c[0], c[1], r));
      expect(f(c[0], c[1])).toBeCloseTo(r, 9);
      for (const p of t.space.circle(c, r, 16)) expect(f(p[0], p[1])).toBeCloseTo(0, 9);
      // Positive inside, negative out, and the fall-off is the metric's.
      const half = t.space.exp(c, [r / 2, 0]);
      expect(f(half[0], half[1])).toBeCloseTo(r / 2, 9);
      const out = t.space.exp(c, [0, -2 * r]);
      expect(f(out[0], out[1])).toBeCloseTo(-r, 9);
    }
  });

  it('moves with the circle under an isometry of the space', () => {
    for (const t of [hyp(), sph()]) {
      const c: [number, number] = [50, 50];
      const r = 7;
      const f = t.distanceTo(circle(c[0], c[1], r));
      // Every placement of a tiling of the sketch's own geometry is an
      // isometry of it, so the field of the moved circle at the moved
      // point reads what the field read before.
      const moves = t.space.kind === 'hyperbolic' ? t.tiling(7, 3, { depth: 1 }).placements : t.tiling(3, 5).placements;
      for (const move of moves.slice(1, 5)) {
        const g = t.distanceTo(circle(move(c)[0], move(c)[1], r));
        for (const p of [[50, 50], [58, 47], [44, 61]] as [number, number][]) {
          const q = move(p);
          expect(g(q[0], q[1])).toBeCloseTo(f(p[0], p[1]), 6);
        }
      }
    }
  });

  it('is NaN past the hyperbolic horizon, and everywhere on the sphere it is a number', () => {
    const t = hyp();
    const f = t.distanceTo(circle(50, 50, 8));
    // The horizon is 45 drawable units from the centre of the drawable.
    expect(Number.isNaN(f(50 + 45, 50))).toBe(true);
    expect(Number.isNaN(f(50 + 60, 50))).toBe(true);
    expect(Number.isFinite(f(50 + 44, 50))).toBe(true);
    const s = sph();
    const g = s.distanceTo(circle(50, 50, 8));
    for (const p of [[50, 50], [120, 120], [-90, 10]] as [number, number][]) expect(Number.isFinite(g(p[0], p[1]))).toBe(true);
  });
});

describe('an area is read as geodesics', () => {
  it('is zero on every edge of a tiling cell and positive inside it', () => {
    for (const t of [hyp(), sph()]) {
      const { cell } = t.space.kind === 'hyperbolic' ? t.tiling(7, 3) : t.tiling(3, 5);
      const f = t.distanceTo(cell);
      for (let i = 0; i < cell.length; i++) {
        const mid = t.space.geodesic(cell[i], cell[(i + 1) % cell.length], 0.5);
        expect(f(mid[0], mid[1])).toBeCloseTo(0, 6);
        // A corner is on two edges at once, so it is zero too.
        expect(f(cell[i][0], cell[i][1])).toBeCloseTo(0, 6);
      }
      // The centre of the cell is its INRADIUS in from the boundary, and
      // that is the deepest the cell goes.
      const centre = t.space.center;
      const inradius = f(centre[0], centre[1]);
      expect(inradius).toBeGreaterThan(0);
      for (let i = 0; i < cell.length; i++) {
        const mid = t.space.geodesic(cell[i], cell[(i + 1) % cell.length], 0.5);
        expect(t.space.distance(centre, mid)).toBeCloseTo(inradius, 6);
      }
    }
  });

  it('is negative outside, and the sign follows the winding', () => {
    const t = hyp();
    const { cell, placements } = t.tiling(7, 3, { depth: 1 });
    const f = t.distanceTo(cell);
    // The seat of a neighbouring copy is outside the cell.
    for (const place of placements.slice(1)) {
      const seat = place(t.space.center);
      expect(f(seat[0], seat[1])).toBeLessThan(0);
    }
    // The same loop the other way round is the same boundary, so the
    // field is the same: the widest loop decides which side is inside.
    const g = t.distanceTo([...cell].reverse());
    expect(g(t.space.center[0], t.space.center[1])).toBeCloseTo(f(t.space.center[0], t.space.center[1]), 9);
  });

  it('measures to the geodesic of a line, signed, because a line has no inside', () => {
    const t = hyp();
    const a: [number, number] = [30, 40];
    const b: [number, number] = [70, 62];
    const f = t.distanceTo(line(a[0], a[1], b[0], b[1]));
    for (let k = 0; k <= 6; k++) {
      const p = t.space.geodesic(a, b, k / 6);
      expect(f(p[0], p[1])).toBeCloseTo(0, 7);
    }
    // A step of 3 to one side reads 3, and to the other reads −3.
    const mid = t.space.geodesic(a, b, 0.5);
    const dir = t.space.log(mid, b);
    const n = Math.hypot(dir[0], dir[1]);
    const left = t.space.exp(mid, [(-dir[1] / n) * 3, (dir[0] / n) * 3]);
    const right = t.space.exp(mid, [(dir[1] / n) * 3, (-dir[0] / n) * 3]);
    expect(f(left[0], left[1])).toBeCloseTo(3, 6);
    expect(f(right[0], right[1])).toBeCloseTo(-3, 6);
  });
});

describe('a flat sketch is the field it always was', () => {
  it('answers the pure distanceTo, to the bit', () => {
    const t = toolkit({ aspect: [1, 1] });
    const loop: [number, number][] = [[20, 20], [70, 25], [66, 80], [24, 72]];
    const mine = t.distanceTo(loop);
    const pure = distanceTo(loop);
    for (let x = 5; x < 100; x += 11) {
      for (let y = 5; y < 100; y += 13) expect(mine(x, y)).toBe(pure(x, y));
    }
    const shape = t.distanceTo(circle(50, 50, 30));
    expect(shape(50, 50)).toBeGreaterThan(29);
    expect(shape(50, 90)).toBeLessThan(0);
  });
});
