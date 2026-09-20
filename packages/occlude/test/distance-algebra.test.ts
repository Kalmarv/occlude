import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { circle, distanceTo, sdf, initOcclude, polygon, render, sketch, type SketchDef } from '../src/index.js';
import { isolinesOf } from '../src/isolines.js';
import { __sdfDirect } from '../src/distance.js';

/** The pure contourer, over a fixed 100mm square: isolines needs the paper,
 * so the toolkit owns `t.isolines` and a test states the frame itself. */
const env = { bounds: { x: 0, y: 0, w: 100, h: 100 }, len: (l: number | { value: number }) => (typeof l === 'number' ? l : l.value) };
const contour = (f: (x: number, y: number) => number, step = 0.25) => isolinesOf(env as never, f, 0, { step });

beforeAll(async () => {
  await initOcclude(readFileSync(fileURLToPath(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url))));
});

/** The zero contour of a field, as points. */
const zero = (f: (x: number, y: number) => number) => contour(f);

/** Furthest any contour point sits from an expected radius about a centre. */
const radialError = (cs: { pts: [number, number][] }[], cx: number, cy: number, r: number): number => {
  let worst = 0;
  for (const c of cs) for (const [x, y] of c.pts) worst = Math.max(worst, Math.abs(Math.hypot(x - cx, y - cy) - r));
  return worst;
};

describe('shapes as distance fields', () => {
  it('measures a circle exactly, and its contour is the circle', () => {
    const f = sdf.circle(50, 50, 18);
    expect(f(50, 50)).toBeCloseTo(18, 10);
    expect(f(68, 50)).toBeCloseTo(0, 10);
    expect(f(78, 50)).toBeCloseTo(-10, 10);
    expect(radialError(zero(f), 50, 50, 18)).toBeLessThan(0.05);
  });

  it('agrees with distanceTo over the same circle', () => {
    const exact = sdf.circle(50, 50, 18);
    const lowered = distanceTo(contour(exact));
    for (const [x, y] of [[50, 50], [60, 50], [50, 62], [75, 75], [30, 40]] as [number, number][]) {
      expect(lowered(x, y)).toBeCloseTo(exact(x, y), 1);
    }
  });

  it('measures a box exactly, inside and past a corner', () => {
    const f = sdf.box(50, 50, 40, 20);
    expect(f(50, 50)).toBeCloseTo(10, 10);
    expect(f(70, 50)).toBeCloseTo(0, 10);
    expect(f(74, 50)).toBeCloseTo(-4, 10);
    // Past a corner the distance is the corner's, not an edge's. The
    // corner is at [70, 60], so [73, 64] is a 3-4-5 away from it.
    expect(f(73, 64)).toBeCloseTo(-5, 10);
  });

  it('measures a capsule from its segment', () => {
    const f = sdf.segment(30, 50, 70, 50, 6);
    expect(f(50, 50)).toBeCloseTo(6, 10);
    expect(f(50, 56)).toBeCloseTo(0, 10);
    expect(f(76, 50)).toBeCloseTo(0, 10);
  });

  it('unions by taking the larger value, because inside is positive', () => {
    const a = sdf.circle(40, 50, 14);
    const b = sdf.circle(60, 50, 14);
    const u = sdf.union(a, b);
    expect(u(40, 50)).toBeCloseTo(14, 10);
    expect(u(50, 50)).toBeCloseTo(Math.max(a(50, 50), b(50, 50)), 10);
    // A point inside either one is inside the union.
    expect(u(30, 50)).toBeGreaterThan(0);
    expect(u(70, 50)).toBeGreaterThan(0);
  });

  it('intersects by taking the smaller value', () => {
    const i = sdf.intersect(sdf.circle(40, 50, 14), sdf.circle(60, 50, 14));
    expect(i(50, 50)).toBeGreaterThan(0);
    expect(i(30, 50)).toBeLessThan(0);
    expect(i(70, 50)).toBeLessThan(0);
  });

  it('subtracts a hole, leaving a ring whose contour has two loops', () => {
    const ring = sdf.subtract(sdf.circle(50, 50, 25), sdf.circle(50, 50, 12));
    expect(ring(50, 50)).toBeLessThan(0);
    expect(ring(50, 68)).toBeGreaterThan(0);
    const cs = zero(ring);
    expect(cs.length).toBe(2);
    const radii = cs.map((c) => Math.hypot(c.pts[0][0] - 50, c.pts[0][1] - 50)).sort((x, y) => x - y);
    expect(radii[0]).toBeCloseTo(12, 0);
    expect(radii[1]).toBeCloseTo(25, 0);
  });

  it('blends two shapes into one, where a union leaves two', () => {
    // Two discs with a 2mm gap between their edges.
    const a = sdf.circle(42, 50, 12);
    const b = sdf.circle(68, 50, 12);
    // Just apart: the union is two separate loops.
    expect(zero(sdf.union(a, b)).length).toBe(2);
    // Blended, the fillet joins them into one.
    expect(zero(sdf.blend(a, b, 9)).length).toBe(1);
    // A blend with no radius is exactly a union.
    expect(sdf.blend(a, b, 0)(50, 50)).toBeCloseTo(sdf.union(a, b)(50, 50), 10);
  });

  it('is ordinary geometry once contoured, and draws with occlusion', () => {
    const shape = sdf.blend(sdf.circle(40, 50, 16), sdf.box(62, 50, 26, 14), 8);
    const def: SketchDef = sketch({}, () => [
      polygon(contour(shape, 0.5), { opaque: true }),
      polygon(circle(50, 50, 40)),
    ]);
    const out = render(def, { paper: { w: 100, h: 100 } });
    expect(out.stats.fragments).toBeGreaterThan(0);
    // The opaque blob hides part of the big circle.
    const plain = render(sketch({}, () => polygon(circle(50, 50, 40))), { paper: { w: 100, h: 100 } });
    expect(out.stats.culledContained + out.stats.fragments).not.toBe(plain.stats.fragments);
  });

  it('refuses a field that is not a function, and reads an empty list as the identity', () => {
    expect(() => sdf.union(undefined as never)).toThrow(/expected a distance field/);
    // A computed list that came out empty must not blow up the sketch.
    const disc = sdf.circle(50, 50, 10);
    expect(sdf.subtract(disc)(50, 50)).toBeCloseTo(10, 10);
    expect(sdf.union()(50, 50)).toBe(-Infinity);
    expect(sdf.intersect()(50, 50)).toBe(Infinity);
    expect(zero(sdf.union())).toEqual([]);
  });

  it('blends exactly like a union away from the joint', () => {
    const a = sdf.circle(42, 50, 12);
    const b = sdf.circle(68, 50, 12);
    // The obvious polynomial smooth maximum grows the shape by radius/4
    // everywhere on the locus equidistant from both, out to infinity.
    for (const y of [200, 1000, 100000]) {
      expect(sdf.blend(a, b, 9)(55, y)).toBeCloseTo(sdf.union(a, b)(55, y), 9);
    }
  });

  it('degrades to a union rather than to nothing on a non-finite input', () => {
    const a = sdf.circle(50, 50, 10);
    expect(sdf.blend(a, () => -Infinity, 5)(50, 50)).toBeCloseTo(10, 10);
    expect(sdf.blend(a, a, Infinity)(50, 50)).toBeCloseTo(10, 10);
  });
});

/**
 * The algebra skips a branch whose support bound proves it cannot reach the
 * result, and answers a repeated point out of one slot of memory. Both are
 * bookkeeping: the number that comes back has to be the SAME BITS as the
 * plain walk of every closure, or a sketch's ink moves under it. `__sdfDirect`
 * turns both off, which is how the same tree is sampled twice here.
 */
describe('the algebra skips only what cannot change the answer', () => {
  /** The field over a 200×200 grid of the 100mm square, as raw doubles. */
  const grid = (build: () => (x: number, y: number) => number): Float64Array => {
    const out = new Float64Array(200 * 200);
    const f = build();
    for (let j = 0; j < 200; j++) {
      for (let i = 0; i < 200; i++) out[j * 200 + i] = f((i * 100) / 199, (j * 100) / 199);
    }
    return out;
  };

  /** Both samplings of the same tree, bit for bit. A Float64Array compares
   * by value, so NaN and ±0 are read through a byte view instead. */
  const sameBits = (build: () => (x: number, y: number) => number): void => {
    __sdfDirect(true);
    const plain = grid(build);
    __sdfDirect(false);
    const fast = grid(build);
    expect(new Uint8Array(fast.buffer)).toEqual(new Uint8Array(plain.buffer));
    // and the sampling is of something, not of -Infinity everywhere
    expect(plain.some((v) => Number.isFinite(v) && v > 0)).toBe(true);
  };

  afterEach(() => __sdfDirect(false));

  /** 50 discs on a lattice with a wander, so boxes overlap in places. */
  const fifty = (): ReturnType<typeof sdf.circle>[] => {
    const cs = [];
    for (let i = 0; i < 50; i++) {
      const a = i * 2.399963;
      cs.push(sdf.circle(50 + 38 * Math.cos(a) * (i / 50), 50 + 38 * Math.sin(a) * (i / 50), 3 + (i % 7)));
    }
    return cs;
  };

  it('gives a union of 50 discs the same bits with the bounds and without', () => {
    sameBits(() => sdf.union(...fifty()));
  });

  it('gives a blended chain, a box, a capsule and an intersection the same bits', () => {
    sameBits(() => fifty().reduce((acc, f) => sdf.blend(acc, f, 4)));
    sameBits(() => sdf.blend(sdf.box(46, 52, 30, 18), sdf.segment(20, 20, 80, 74, 6), 7));
    // Two specks in opposite corners: nearly every sample is under the
    // fillet on BOTH sides, which is the branch the box test cannot settle.
    sameBits(() => sdf.blend(sdf.circle(10, 10, 2), sdf.circle(90, 90, 2), 3));
    sameBits(() => sdf.intersect(sdf.union(...fifty()), sdf.box(50, 50, 60, 40)));
    sameBits(() => sdf.subtract(sdf.box(50, 50, 70, 70), ...fifty()));
  });

  it('gives the lichen shape — colonies cut back by what settled first — the same bits', () => {
    sameBits(() => {
      let taken: ((x: number, y: number) => number) | null = null;
      let out: (x: number, y: number) => number = () => -Infinity;
      for (let i = 0; i < 8; i++) {
        const a = i * 2.399963;
        const cx = 50 + 30 * Math.cos(a);
        const cy = 50 + 30 * Math.sin(a);
        const blob = [0, 1, 2].map((j) => sdf.circle(cx + 4 * j, cy - 3 * j, 9 + j))
          .reduce((acc, f) => sdf.blend(acc, f, 4));
        // the sketch's own shape: a lambda in the middle, and the running
        // union used twice — once as the hole, once as the other branch
        const crinkled = (x: number, y: number): number => blob(x, y) + 0.4 * Math.sin(x / 3) * Math.cos(y / 3);
        const room: ((x: number, y: number) => number) | null = taken;
        const body: (x: number, y: number) => number = room ? sdf.subtract(crinkled, (x, y) => room(x, y) + 1.2) : crinkled;
        taken = room ? sdf.union(room, body) : body;
        out = body;
      }
      return out;
    });
  });

  it('answers a repeated point out of one slot, and a moved point afresh', () => {
    let calls = 0;
    const base = (x: number, y: number): number => {
      calls++;
      return 10 - Math.hypot(x - 50, y - 50);
    };
    const f = sdf.union(base, sdf.circle(20, 20, 5));
    expect(f(50, 50)).toBe(10);
    expect(f(50, 50)).toBe(10);
    expect(calls).toBe(1);
    f(51, 50);
    expect(calls).toBe(2);
    // ±0 is a different point from +0, not a hit on the slot
    const g = sdf.union(base, sdf.circle(20, 20, 5));
    const zeroCalls = calls;
    g(0, 0);
    g(-0, 0);
    expect(calls).toBe(zeroCalls + 2);
  });

  it('keeps a NaN and a -Infinity branch as the plain walk reads them', () => {
    const disc = sdf.circle(50, 50, 10);
    const gone = (): number => NaN;
    expect(sdf.union(disc, gone)(50, 50)).toBeNaN();
    expect(sdf.union(gone, disc)(50, 50)).toBeNaN();
    expect(sdf.subtract(disc, gone)(50, 50)).toBeNaN();
    expect(sdf.blend(disc, gone, 4)(50, 50)).toBeNaN();
    expect(sdf.blend(disc, () => -Infinity, 4)(50, 50)).toBe(10);
    // far outside every box, where the bounds are at their loosest
    expect(sdf.union(disc, sdf.circle(20, 20, 5))(1e9, 1e9)).toBe(sdf.circle(50, 50, 10)(1e9, 1e9));
    expect(Number.isFinite(sdf.blend(disc, sdf.circle(20, 20, 5), 4)(1e6, -1e6))).toBe(true);
  });
});
