import { describe, expect, it } from 'vitest';
import { circle, material } from '../src/index.js';
import { toolkit } from './helpers/run.js';

/** A Square20 toolkit: a 100 × 100 drawable in bare units. */
const tk = () => toolkit();

/** A rectangular obstacle as a speed field: zero inside, one outside. */
const barrier = (x0: number, y0: number, x1: number, y1: number) =>
  (x: number, y: number): number => (x >= x0 && x <= x1 && y >= y0 && y <= y1 ? 0 : 1);

describe('travelTime: arrival times over the drawable', () => {
  it('is Euclidean distance from one seed on open ground at speed 1', () => {
    const t = tk();
    const T = t.travelTime([[50, 50]]);
    expect(T(50, 50)).toBeCloseTo(0, 9);
    // A first-order scheme overshoots most on the diagonal; the grid is
    // about half a unit, so the relative error falls with the radius.
    for (const r of [10, 20, 30, 40]) {
      for (const deg of [0, 30, 45, 90, 135, 200, 315]) {
        const a = (deg * Math.PI) / 180;
        const got = T(50 + r * Math.cos(a), 50 + r * Math.sin(a));
        expect(Math.abs(got - r) / r).toBeLessThan(0.05);
      }
    }
  });

  it('walks around a wall instead of through it', () => {
    const t = tk();
    // A bar from the bottom edge up to y = 70, with the seed to its left.
    const T = t.travelTime([[20, 50]], { speed: barrier(45, 0, 55, 70), spacing: 0.4 });
    // Around the top: to the near corner, across the cap, down to the probe.
    const detour = Math.hypot(25, 20) + 10 + Math.hypot(25, 20);
    const got = T(80, 50);
    expect(got).toBeGreaterThan(70); // nothing like the straight line, 60
    expect(Math.abs(got - detour) / detour).toBeLessThan(0.05);
    // Inside the bar there is no ground at all.
    expect(T(50, 30)).toBe(Infinity);
  });

  it('takes twice as long over ground at half the speed', () => {
    const t = tk();
    const T = t.travelTime([[5, 50]], { speed: (x: number) => (x < 50 ? 1 : 0.5) });
    expect(T(45, 50)).toBeCloseTo(40, 6); // 40 units at speed 1
    // 45 more units at speed 1, then 45 at speed 0.5: 45 + 90.
    expect(Math.abs(T(95, 50) - 135) / 135).toBeLessThan(0.02);
  });

  it('is +Infinity where walls seal the ground off, and draws nothing there', () => {
    const t = tk();
    // A closed square wall four units thick, with the seed outside it.
    const room = (x: number, y: number): number => {
      const outer = x > 30 && x < 70 && y > 30 && y < 70;
      const inner = x > 34 && x < 66 && y > 34 && y < 66;
      return outer && !inner ? 0 : 1;
    };
    const T = t.travelTime([[5, 5]], { speed: room });
    expect(T(50, 50)).toBe(Infinity);
    expect(Number.isFinite(T(10, 10))).toBe(true);
    // A level nothing reaches is not an error: it is no contours.
    expect(t.isolines(T, 1e9).curves()).toHaveLength(0);
    expect(t.isolines(T, 20).curves().length).toBeGreaterThan(0);
  });

  it('starts at zero over a seed area and grows outward from it', () => {
    const t = tk();
    const square: [number, number][] = [[30, 30], [70, 30], [70, 70], [30, 70]];
    const T = t.travelTime([square]);
    expect(T(30, 50)).toBeCloseTo(0, 6); // on the loop
    expect(T(50, 50)).toBeCloseTo(0, 6); // inside it: already arrived
    expect(T(20, 50)).toBeCloseTo(10, 2); // ten units out from the wall
    expect(T(85, 50)).toBeCloseTo(15, 2);
    expect(T(20, 50)).toBeLessThan(T(10, 50));
  });

  it('bends around a doorway: through the gap beats through the wall', () => {
    const t = tk();
    // A vertical wall with a gap at the top, the seed on the left.
    const speed = (x: number, y: number): number => (x >= 48 && x <= 52 && y <= 60 ? 0 : 1);
    const T = t.travelTime([[25, 20]], { speed, spacing: 0.4 });
    const straight = T(75, 20);
    // Every route to the far side goes through the gap above y = 60.
    expect(straight).toBeGreaterThan(Math.hypot(25, 40) + Math.hypot(25, 40) - 5);
    // A point beside the seed, no wall between: the straight line.
    expect(T(35, 20)).toBeCloseTo(10, 1);
  });

  it('gives identical numbers for identical inputs', () => {
    const t = tk();
    const speed = (x: number, y: number): number => 0.5 + 0.5 * Math.sin(x / 9) * Math.cos(y / 11);
    const sample = () => {
      const T = t.travelTime([[20, 20]], { speed, spacing: 0.8 });
      const out: number[] = [];
      for (let x = 2; x < 100; x += 7) for (let y = 3; y < 100; y += 9) out.push(T(x, y));
      return out;
    };
    expect(sample()).toEqual(sample());
  });

  it('lowers a shape and agrees with distanceTo on open ground', () => {
    const t = tk();
    const disc = circle(50, 50, 5);
    const T = t.travelTime(disc);
    const d = t.distanceTo(disc);
    for (const [x, y] of [[50, 20], [80, 50], [75, 75], [22, 66], [50, 95]]) {
      expect(Math.abs(T(x, y) - Math.abs(d(x, y)))).toBeLessThan(0.5);
    }
    expect(T(50, 50)).toBeCloseTo(0, 6); // inside the disc
  });

  it('takes points as seeds, and a within() bound as the only ground', () => {
    const t = tk();
    const pts = material([{ x: 20, y: 20 }, { x: 80, y: 80 }]);
    const T = t.travelTime(pts.points);
    expect(T(20, 20)).toBeCloseTo(0, 6);
    expect(T(80, 80)).toBeCloseTo(0, 6);
    // Halfway: the nearer of the two, on the diagonal where a first-order
    // march overshoots by a percent or so.
    expect(Math.abs(T(50, 50) - Math.hypot(30, 30)) / Math.hypot(30, 30)).toBeLessThan(0.03);

    const box: [number, number][] = [[10, 10], [60, 10], [60, 60], [10, 60]];
    const bounded = t.travelTime([[20, 20]], { within: [box] });
    expect(Number.isFinite(bounded(50, 50))).toBe(true);
    expect(bounded(90, 90)).toBe(Infinity);
  });

  it('reads { x, y } records as separate seeds and [x, y] pairs as a loop', () => {
    const t = tk();
    const seeds = t.travelTime([{ x: 10, y: 10 }, { x: 90, y: 90 }]);
    expect(seeds(10, 10)).toBeCloseTo(0, 6);
    expect(seeds(90, 90)).toBeCloseTo(0, 6);
    // Halfway along the line between them: the distance to the nearer one.
    // A degenerate two-point AREA would put the midpoint on the boundary,
    // at time zero.
    const half = Math.hypot(40, 40);
    expect(Math.abs(seeds(50, 50) - half) / half).toBeLessThan(0.03);

    // The same two positions as pairs are one loop, so the chord between
    // them is the source and the midpoint sits on it.
    const loop = t.travelTime([[10, 10], [90, 90]]);
    expect(loop(50, 50)).toBeCloseTo(0, 6);
    expect(() => t.travelTime([{ x: 10, y: 10 }, [90, 90]] as never)).toThrow(/entry 1 is not a point/);
  });

  it('refuses a value that is neither an area nor points, by name', () => {
    const t = tk();
    expect(() => t.travelTime(42 as never)).toThrow(/travelTime: expected an area or points, got number/);
    expect(() => t.travelTime([[50, 50]], { speed: 'fast' as never })).toThrow(/travelTime: \{ speed \}/);
  });

  it('is +Infinity everywhere with no seeds, or with no speed at all', () => {
    const t = tk();
    expect(t.travelTime([])(50, 50)).toBe(Infinity);
    expect(t.travelTime([[50, 50]], { speed: 0 })(20, 20)).toBe(Infinity);
    expect(t.travelTime([[50, 50]], { speed: () => NaN })(20, 20)).toBe(Infinity);
    // Seeds outside the ground reach nothing inside it.
    const far = t.travelTime([[-40, -40]], { within: [[[10, 10], [60, 10], [60, 60], [10, 60]] as [number, number][]] });
    expect(far(30, 30)).toBe(Infinity);
  });
});
