/**
 * `t.distanceTo` under a `space`: the distance field of an area measured
 * by the METRIC the frame names, not by the sheet.
 *
 * The area is the one the ink door draws, and its edges are read as
 * GEODESICS: the value is the distance to the nearest of them, positive
 * inside. There is no word for a circle — a circle is a boundary like any
 * other, and the field is zero on the loop it draws. The proofs are the
 * ones a distance field owes: zero on the boundary, the right sign either
 * side of it, the stated value at a known point, and invariance under the
 * space's own isometries, which `t.tiling` hands over as data.
 *
 * A flat sketch is the old pure `distanceTo`, to the bit.
 */

import { describe, expect, it } from 'vitest';
import { toolkit } from './helpers/run.js';
import { circle, distanceTo, line, space } from '../src/index.js';

const hyp = () => toolkit({ aspect: [1, 1], space: space.hyperbolic({ radius: 45 }) });
const sph = () => toolkit({ aspect: [1, 1], space: space.spherical({ radius: 30 }) });

describe('a circle is a boundary like any other', () => {
  it('is zero on the loop it draws, and positive inside it', () => {
    for (const t of [hyp(), sph()]) {
      const c: [number, number] = [56, 44];
      const r = 9;
      const f = t.distanceTo(circle(c[0], c[1], r));
      // The loop the sketch draws is the sin/cos circle of the
      // coordinates, and the field is zero along it to the tolerance the
      // boundary was sampled at.
      for (const p of t.material(circle(c[0], c[1], r)).pts) expect(Math.abs(f(p[0], p[1]))).toBeLessThan(0.02);
      // Inside is positive and the deepest reading is at the middle;
      // outside is negative.
      expect(f(c[0], c[1])).toBeGreaterThan(0);
      for (const p of t.material(circle(c[0], c[1], r * 0.5)).pts) expect(f(p[0], p[1])).toBeGreaterThan(0);
      for (const p of t.material(circle(c[0], c[1], r * 1.5)).pts) expect(f(p[0], p[1])).toBeLessThan(0);
    }
  });

  it('falls off at the rate of the metric, not of the sheet', () => {
    for (const t of [hyp(), sph()]) {
      const f = t.distanceTo(circle(50, 50, 12));
      // The deepest reading is about the radius: the loop is the
      // coordinate circle, which is within a hair of the circle of the
      // space about the centre of the drawable.
      const deep = f(50, 50);
      expect(deep).toBeGreaterThan(11.4);
      expect(deep).toBeLessThan(12.1);
      // A step of 4 OF THE SPACE, in any direction, reads 4 less — the
      // fall-off is the metric's, and the sheet has nothing to say.
      for (const p of t.space.circle([50, 50], 4, 8)) expect(f(p[0], p[1])).toBeCloseTo(deep - 4, 0);
    }
  });

  it('is a number everywhere: every coordinate is a place', () => {
    const t = hyp();
    const f = t.distanceTo(circle(50, 50, 8));
    // There is no horizon to fall off: a coordinate far outside the
    // drawable still reads its own distance, and it grows with the step.
    for (const p of [[50, 50], [95, 50], [50 + 300, 50], [50, -250]] as [number, number][]) {
      expect(Number.isFinite(f(p[0], p[1]))).toBe(true);
    }
    expect(f(350, 50)).toBeLessThan(f(95, 50));
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
