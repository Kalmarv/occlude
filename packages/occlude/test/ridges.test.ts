import { describe, expect, it } from 'vitest';
import { ridgesOf, type RidgeContour } from '../src/ridges.js';
import type { IsoEnv } from '../src/isolines.js';

/** Bare-units env: 100×100 drawable, lengths taken at face value. */
const env: IsoEnv = {
  bounds: { x: 0, y: 0, w: 100, h: 100 },
  len: (l) => (typeof l === 'number' ? l : l.value),
};

const allPts = (cs: RidgeContour[]): [number, number][] => cs.flatMap((c) => c.pts);
const spanX = (cs: RidgeContour[]): number => {
  const xs = allPts(cs).map((p) => p[0]);
  return Math.max(...xs) - Math.min(...xs);
};

describe('ridges', () => {
  it('finds a straight crest exactly, with the curvature it really has', () => {
    // A parabolic ridge along y = 40: fyy = -2 everywhere, fxx = fxy = 0, so
    // the across direction is y, λ₁ is exactly -2 and the crest is the line.
    const found = ridgesOf(env, (_x, y) => -((y - 40) ** 2), { step: 2 });
    expect(found.length).toBeGreaterThan(0);
    for (const [, y] of allPts(found)) expect(y).toBeCloseTo(40, 6);
    for (const c of found) for (const s of c.strength) expect(s).toBeCloseTo(2, 6);
    // and it runs the width of the drawable rather than arriving in crumbs
    expect(spanX(found)).toBeGreaterThan(90);
    expect(found.length).toBe(1);
  });

  it('follows a crest that is not axis-aligned', () => {
    // The same trough turned 30°: the ridge is the line through the centre.
    const a = (30 * Math.PI) / 180;
    const [nx, ny] = [-Math.sin(a), Math.cos(a)];
    const d = (x: number, y: number) => (x - 50) * nx + (y - 50) * ny;
    const found = ridgesOf(env, (x, y) => -(d(x, y) ** 2), { step: 2 });
    expect(found.length).toBeGreaterThan(0);
    for (const [x, y] of allPts(found)) expect(d(x, y)).toBeCloseTo(0, 5);
  });

  it('a trough is not a ridge, and the ridges of its negation are', () => {
    // No mode flag: +(y - 40)² is a valley, and asking for its ridges gives
    // nothing at all, while negating it gives the crest back.
    const valley = ridgesOf(env, (_x, y) => (y - 40) ** 2, { step: 2 });
    expect(allPts(valley)).toHaveLength(0);
    const crest = ridgesOf(env, (_x, y) => -((y - 40) ** 2), { step: 2 });
    expect(allPts(crest).length).toBeGreaterThan(0);
  });

  it('carries the field value it found, and a strength that is never negative', () => {
    const f = (x: number, y: number) => -((y - 40) ** 2) + x / 10;
    const found = ridgesOf(env, f, { step: 2 });
    expect(found.length).toBeGreaterThan(0);
    for (const c of found) {
      c.pts.forEach(([x, y], k) => {
        expect(c.height[k]).toBeCloseTo(f(x, y), 3);
        expect(c.strength[k]).toBeGreaterThanOrEqual(0);
      });
    }
  });

  it('abstains where the across direction does not exist', () => {
    // A paraboloid of revolution curves the same in every direction, so its
    // Hessian has no distinguished eigenvector anywhere. The honest answer is
    // its apex, which is a point and not a line — so there are no ridge
    // curves, rather than an arbitrary one through the middle.
    const found = ridgesOf(env, (x, y) => -((x - 50) ** 2 + (y - 50) ** 2), { step: 2 });
    expect(allPts(found)).toHaveLength(0);
  });

  it('says nothing where the field is absent', () => {
    // A within() bound arrives as non-finite samples; a node whose stencil
    // touches one has no second derivative and abstains, so the crest stops
    // at the hole instead of guessing across it.
    const whole = ridgesOf(env, (_x, y) => -((y - 40) ** 2), { step: 2 });
    const holed = ridgesOf(
      env,
      (x, y) => (x > 30 && x < 70 ? NaN : -((y - 40) ** 2)),
      { step: 2 },
    );
    for (const [x] of allPts(holed)) expect(x < 32 || x > 68).toBe(true);
    expect(allPts(holed).length).toBeLessThan(allPts(whole).length);
    expect(holed.length).toBe(2);
  });

  it('is a pure function of the field and the step', () => {
    const f = (x: number, y: number) => -((y - 40 - 8 * Math.sin(x / 20)) ** 2);
    const a = ridgesOf(env, f, { step: 2 });
    const b = ridgesOf(env, f, { step: 2 });
    expect(allPts(a)).toEqual(allPts(b));
    // A different step is a different question, not a better answer.
    const coarse = ridgesOf(env, f, { step: 8 });
    expect(allPts(coarse).length).not.toBe(allPts(a).length);
  });

  it('draws nothing on a step it cannot sample on', () => {
    expect(ridgesOf(env, () => 0, { step: 0 })).toEqual([]);
    expect(ridgesOf(env, () => 0, { step: -1 })).toEqual([]);
  });
});
