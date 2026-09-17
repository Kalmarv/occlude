import { describe, expect, it } from 'vitest';
import { connect, material, mm, snap } from '../src/index.js';

const at = (m: { x: ArrayLike<number>; y: ArrayLike<number> }, i: number) => [m.x[i], m.y[i]] as [number, number];

describe('snap', () => {
  it('moves each point to the best place within reach, and no further', () => {
    // One peak at (50, 50). Points inside the radius reach it; the one
    // outside moves toward it by exactly the radius it was allowed.
    const peak = (x: number, y: number) => -Math.hypot(x - 50, y - 50);
    const pts = material([[54, 50], [50, 47], [70, 50]]);
    const moved = snap(pts, peak, { radius: 6, samples: 512 });
    expect(at(moved, 0)[0]).toBeCloseTo(50, 0);
    expect(at(moved, 0)[1]).toBeCloseTo(50, 0);
    expect(at(moved, 1)[1]).toBeCloseTo(50, 0);
    // The far point cannot arrive, but gets as close as the radius allows.
    expect(Math.hypot(...at(moved, 2)) === 0).toBe(false);
    expect(Math.hypot(at(moved, 2)[0] - 50, at(moved, 2)[1] - 50)).toBeCloseTo(20 - 6, 0);
    // Nothing moves further than it was allowed to.
    for (let i = 0; i < pts.n; i++) expect(Math.hypot(at(moved, i)[0] - pts.x[i], at(moved, i)[1] - pts.y[i])).toBeLessThanOrEqual(6 + 1e-9);
    // A point already at the best place it can see stays exactly put.
    const settled = snap(material([[50, 50]]), peak, { radius: 6 });
    expect(at(settled, 0)).toEqual([50, 50]);
  });

  it('seeks the greatest, and a negated field is how you seek the least', () => {
    const well = (x: number) => Math.abs(x - 30); // smallest at x = 30
    const pts = material([[36, 10]]);
    // Toward the greatest: away from 30, to the edge of the disc.
    expect(at(snap(pts, well, { radius: 5, samples: 512 }), 0)[0]).toBeGreaterThan(40);
    // Negate it and the same verb goes the other way. No second mode needed.
    expect(at(snap(pts, (x, y) => -well(x), { radius: 8, samples: 512 }), 0)[0]).toBeCloseTo(30, 0);
  });

  it('keeps the structure: only the positions move', () => {
    const ring = connect.ring(material([[10, 10], [30, 10], [30, 30], [10, 30]], { weight: 2 }));
    const moved = snap(ring, (x, y) => x + y, { radius: 3 });
    expect(moved.n).toBe(ring.n);
    expect(Array.from(moved.edgeList)).toEqual(Array.from(ring.edgeList));
    expect(Array.from(moved.attrs.weight)).toEqual(Array.from(ring.attrs.weight));
    // The source is untouched.
    expect(Array.from(ring.x)).toEqual([10, 30, 30, 10]);
    // Every point walked up the field it was given.
    for (let i = 0; i < ring.n; i++) expect(moved.x[i] + moved.y[i]).toBeGreaterThan(ring.x[i] + ring.y[i]);
  });

  it('is deterministic, absent samples are absent, and it refuses what it cannot use', () => {
    const f = (x: number, y: number) => Math.sin(x / 7) + Math.cos(y / 5);
    const pts = material(Array.from({ length: 40 }, (_, k) => [8 + (k % 8) * 12, 8 + Math.floor(k / 8) * 14] as [number, number]));
    expect(Array.from(snap(pts, f, { radius: 5 }).x)).toEqual(Array.from(snap(pts, f, { radius: 5 }).x));
    // A field that declines to answer somewhere never moves a point there.
    const walled = snap(material([[20, 20]]), (x, y) => (x > 22 ? NaN : x), { radius: 10, samples: 512 });
    expect(at(walled, 0)[0]).toBeLessThanOrEqual(22);
    // A field that is absent everywhere leaves everything where it was.
    expect(Array.from(snap(pts, () => NaN, { radius: 9 }).x)).toEqual(Array.from(pts.x));
    // Radius 0 is a legal no-op; the rest are refused.
    expect(Array.from(snap(pts, f, { radius: 0 }).x)).toEqual(Array.from(pts.x));
    expect(() => snap(pts, f, { radius: -1 })).toThrow(/non-negative length/);
    expect(() => snap(pts, f, { radius: mm(2) as never })).toThrow(/non-negative length/);
    expect(() => snap(pts, f, { radius: 5, samples: 0 })).toThrow(/at least 1/);
    expect(() => snap(pts, 3 as never, { radius: 5 })).toThrow(/expected a field/);
  });
});
