/**
 * `space: { curvature: K }` — the one number the three geometries are.
 *
 * The sphere, the plane and the disk are one construction here, picked
 * apart only by the SIGN of the curvature. This file checks that: the
 * named forms are sugar that resolve to a curvature, a curvature given
 * directly builds the very same space member for member, zero is the flat
 * plane itself and not an approximation of it, and a curvature small
 * enough to be nothing behaves like nothing.
 *
 * The other knob, the projection's `size`, is paper and not geometry. The
 * last block checks the two are independent: the same curvature drawn at
 * two sizes measures the same and prints scaled.
 */

import { describe, expect, it } from 'vitest';
import { SQ } from './helpers/run.js';
import {
  bindToolkit, space, Execution as Run,
  type Execution, type SketchConfig, type Toolkit,
} from '../src/index.js';
import type { Space } from '../src/space.js';

/** A toolkit on a 100 × 100 drawable, with the config's own space. */
function tk(cfg: SketchConfig = {}): Toolkit & { exec: Execution } {
  const exec = new Run(SQ);
  exec.begin({ aspect: [1, 1], ...cfg });
  return Object.assign(bindToolkit(exec), { exec });
}

const PTS: [number, number][] = [
  [50, 50], [62, 44], [31, 71], [88, 90], [12, 27], [50, 83], [74, 50],
];

/** Every member that answers a number or a point, on the same inputs. */
function agree(a: Space, b: Space, places = 12): void {
  expect(a.kind).toBe(b.kind);
  expect(a.curvature).toBeCloseTo(b.curvature, 15);
  expect(a.radius).toBeCloseTo(b.radius, places);
  expect(a.size).toBeCloseTo(b.size, places);
  for (const p of PTS) {
    expect(a.density(p)).toBeCloseTo(b.density(p), places);
    for (const k of [0, 1] as const) {
      expect(a.toChart(p)[k]).toBeCloseTo(b.toChart(p)[k], places);
      expect(a.fromChart(p)[k]).toBeCloseTo(b.fromChart(p)[k], places);
      expect(a.project(p)[k]).toBeCloseTo(b.project(p)[k], places);
      expect(a.exp(p, [3, -2])[k]).toBeCloseTo(b.exp(p, [3, -2])[k], places);
    }
    for (const q of PTS) {
      expect(a.distance(p, q)).toBeCloseTo(b.distance(p, q), places);
      for (const k of [0, 1] as const) {
        expect(a.log(p, q)[k]).toBeCloseTo(b.log(p, q)[k], places);
        expect(a.geodesic(p, q, 0.37)[k]).toBeCloseTo(b.geodesic(p, q, 0.37)[k], places);
      }
    }
    const one = a.circle(p, 7, 16);
    const two = b.circle(p, 7, 16);
    expect(one.length).toBe(two.length);
    for (let i = 0; i < one.length; i++) {
      expect(one[i][0]).toBeCloseTo(two[i][0], places);
      expect(one[i][1]).toBeCloseTo(two[i][1], places);
    }
  }
}

describe('a curvature is what a named space resolves to', () => {
  it('reads the hyperbolic radius as a curvature, and builds the same space either way', () => {
    const named = tk({ space: space.hyperbolic({ radius: 50 }) }).space;
    expect(named.curvature).toBeCloseTo(-4 / (50 * 50), 15);
    agree(named, tk({ space: { curvature: -4 / (50 * 50) } }).space);
  });

  it('reads the spherical radius as a curvature, and builds the same space either way', () => {
    const named = tk({ space: space.spherical({ radius: 30 }) }).space;
    expect(named.curvature).toBeCloseTo(1 / (30 * 30), 15);
    agree(named, tk({ space: { curvature: 1 / (30 * 30) } }).space);
  });

  it('names itself by the sign of the curvature, and answers the radius that curvature means', () => {
    const below = tk({ space: { curvature: -4 / (40 * 40) } }).space;
    expect(below.kind).toBe('hyperbolic');
    expect(below.radius).toBeCloseTo(40, 12);
    const above = tk({ space: { curvature: 1 / (25 * 25) } }).space;
    expect(above.kind).toBe('spherical');
    expect(above.radius).toBeCloseTo(25, 12);
  });
});

describe('zero curvature is the flat plane itself', () => {
  it('is the Euclidean record, and the frame carries no space at all', () => {
    const t = tk({ space: { curvature: 0 } });
    expect(t.space.kind).toBe('euclidean');
    expect(t.exec.frame.space).toBeUndefined();
    agree(t.space, tk().space);
  });

  it('is what a sketch without the key already had', () => {
    agree(tk({ space: 'euclidean' }).space, tk().space);
  });

  it('is approached by a curvature too small to be anything', () => {
    // At this curvature the geometry's own deviation from the sheet is of
    // order `d³K` — a hundredth of a micron over the whole drawable — so
    // anything bigger than that here is arithmetic, not geometry. The
    // curvature length is `1/√K = 10⁶` drawable units, which is where a
    // naive formula loses its digits, so these are the canaries for it:
    // the round trip through the chart, the identity `|log| = distance`,
    // and the area element at the centre.
    const K = 1e-12;
    const tiny = tk({ space: { curvature: -K } }).space;
    const flat = tk().space;
    expect(tiny.kind).toBe('hyperbolic');
    for (const p of PTS) {
      const there = tiny.fromChart(tiny.toChart(p));
      expect(there[0]).toBeCloseTo(p[0], 9);
      expect(there[1]).toBeCloseTo(p[1], 9);
      expect(Math.abs(tiny.density(p) - 1)).toBeLessThan(1e-6);
      for (const q of PTS) {
        const v = tiny.log(p, q);
        expect(Math.hypot(v[0], v[1])).toBeCloseTo(tiny.distance(p, q), 9);
        // The space and the sheet agree to a millionth of a unit, which is
        // far finer than any pen and far coarser than the 1e-12 the
        // arithmetic would be good for if nothing cancelled.
        expect(Math.abs(tiny.distance(p, q) - flat.distance(p, q))).toBeLessThan(1e-6);
        const back = tiny.exp(p, v);
        expect(back[0]).toBeCloseTo(q[0], 8);
        expect(back[1]).toBeCloseTo(q[1], 8);
      }
    }
  });
});

describe('the projection is paper, and the curvature is geometry', () => {
  it('measures the same at any size, and prints scaled about the centre', () => {
    const one = tk({ space: space.hyperbolic({ radius: 50 }) }).space;
    const half = tk({
      space: space.hyperbolic({ radius: 50 }),
      projection: { kind: 'poincare', size: 25 },
    }).space;
    expect(one.size).toBeCloseTo(50, 12);
    expect(half.size).toBeCloseTo(25, 12);
    expect(half.curvature).toBeCloseTo(one.curvature, 15);
    for (const p of PTS) {
      for (const q of PTS) expect(half.distance(p, q)).toBeCloseTo(one.distance(p, q), 12);
      expect(half.project(p)[0] - 50).toBeCloseTo((one.project(p)[0] - 50) / 2, 9);
      expect(half.project(p)[1] - 50).toBeCloseTo((one.project(p)[1] - 50) / 2, 9);
    }
  });

  it('refuses a chart that belongs to the other sign, by name', () => {
    expect(() => tk({ space: { curvature: -0.01 }, projection: 'stereographic' })).toThrow(/spherical/);
    expect(() => tk({ space: { curvature: 0.01 }, projection: 'klein' })).toThrow(/hyperbolic/);
  });
});
