import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { initOcclude, render, sketch } from '../src/index.js';
import { isolinesOf, type IsoContour, type IsoEnv } from '../src/isolines.js';
import type { IsoContour as PublicIsoContour, RenderOptions, SketchDef } from '../src/index.js';

beforeAll(async () => {
  const wasmPath = fileURLToPath(
    new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url),
  );
  await initOcclude(readFileSync(wasmPath));
});

const sq = (def: SketchDef, opts: RenderOptions = {}) =>
  render(def, { paper: 'Square20', ...opts });

/** Bare-units env: 100×100 drawable, lengths taken at face value. */
const env: IsoEnv = {
  bounds: { x: 0, y: 0, w: 100, h: 100 },
  len: (l) => (typeof l === 'number' ? l : l.value),
};

const perimeter = (c: IsoContour): number => {
  let sum = 0;
  const n = c.pts.length;
  const m = c.closed ? n : n - 1;
  for (let k = 0; k < m; k++) {
    const [ax, ay] = c.pts[k];
    const [bx, by] = c.pts[(k + 1) % n];
    sum += Math.hypot(bx - ax, by - ay);
  }
  return sum;
};

const shoelace = (c: IsoContour): number => {
  let a = 0;
  const n = c.pts.length;
  for (let k = 0; k < n; k++) {
    const [ax, ay] = c.pts[k];
    const [bx, by] = c.pts[(k + 1) % n];
    a += ax * by - bx * ay;
  }
  return Math.abs(a) / 2;
};

describe('isolines: marching squares core', () => {
  it('recovers a circle from a radial field (analytic oracle)', () => {
    const field = (x: number, y: number): number => 30 - Math.hypot(x - 50, y - 50);
    const out = isolinesOf(env, field, 0, { step: 0.5 });
    expect(out).toHaveLength(1);
    const c = out[0];
    expect(c.closed).toBe(true);
    for (const [x, y] of c.pts) {
      expect(Math.hypot(x - 50, y - 50)).toBeCloseTo(30, 1);
    }
    // Edge-interpolated crossings: perimeter within 1% of 2πr.
    expect(perimeter(c)).toBeGreaterThan(2 * Math.PI * 30 * 0.99);
    expect(perimeter(c)).toBeLessThan(2 * Math.PI * 30 * 1.01);
  });

  it('a boundary-crossing region is open by default, closed with close:true', () => {
    const field = (x: number): number => x - 50;
    const open = isolinesOf(env, field, 0, { step: 1 });
    expect(open).toHaveLength(1);
    expect(open[0].closed).toBe(false);
    // A vertical line at x=50 spanning the full drawable, colinear-merged.
    expect(open[0].pts).toHaveLength(2);
    const ys = open[0].pts.map(([, y]) => y).sort((a, b) => a - b);
    expect(ys[0]).toBeCloseTo(0, 6);
    expect(ys[1]).toBeCloseTo(100, 6);
    expect(open[0].pts.every(([x]) => Math.abs(x - 50) < 1e-6)).toBe(true);

    const closed = isolinesOf(env, field, 0, { step: 1, close: true });
    expect(closed).toHaveLength(1);
    expect(closed[0].closed).toBe(true);
    // The right half-plane clipped to the drawable: a 50×100 rectangle.
    expect(shoelace(closed[0])).toBeCloseTo(5000, 0);
    expect(closed[0].pts.length).toBeLessThan(8); // border runs collapse to corners
  });

  it('an annulus band yields two nested closed contours', () => {
    const field = (x: number, y: number): number =>
      20 - Math.abs(Math.hypot(x - 50, y - 50) - 25);
    const out = isolinesOf(env, field, 10, { step: 0.5 });
    expect(out).toHaveLength(2);
    const radii = out
      .map((c) => Math.hypot(c.pts[0][0] - 50, c.pts[0][1] - 50))
      .sort((a, b) => a - b);
    expect(radii[0]).toBeCloseTo(15, 1);
    expect(radii[1]).toBeCloseTo(35, 1);
    expect(out.every((c) => c.closed)).toBe(true);
  });

  it('multi-level overload matches per-level calls over one sampling', () => {
    const field = (x: number, y: number): number => 40 - Math.hypot(x - 50, y - 50);
    const multi = isolinesOf(env, field, [0, 15, 25], { step: 1 });
    expect(multi).toHaveLength(3);
    for (const [k, lvl] of [0, 15, 25].entries()) {
      const single = isolinesOf(env, field, lvl, { step: 1 });
      expect(multi[k]).toEqual(single);
    }
  });

  it('guards: zero step and grids past the cap fail loudly', () => {
    const field = (): number => 1;
    expect(() => isolinesOf(env, field, 0, { step: 0 })).toThrow(/positive length/);
    expect(() => isolinesOf(env, field, 0, { step: 0.01 })).toThrow(/cap/);
    expect(() => isolinesOf(env, field, Number.NaN)).toThrow(/level/);
  });

  it('non-finite field samples count as outside', () => {
    const field = (x: number): number => (x > 60 ? Number.NaN : 50 - x);
    const out = isolinesOf(env, field, 0, { step: 1 });
    expect(out).toHaveLength(1);
    expect(out[0].pts.every(([x]) => Math.abs(x - 50) < 1e-6)).toBe(true);
  });
});

describe('isolines: toolkit + engine integration', () => {
  it('is deterministic through the toolkit', () => {
    const capture: PublicIsoContour[][] = [];
    const def = sketch({ seed: 7 }, (t) => {
      capture.push(
        t.isolines((x, y) => t.noise(x / 20, y / 20), 0.1, { close: true }),
      );
      return capture[capture.length - 1].map((c) => t.polygon(c.pts));
    });
    sq(def);
    sq(def);
    expect(capture).toHaveLength(2);
    expect(JSON.stringify(capture[0])).toBe(JSON.stringify(capture[1]));
    expect(capture[0].length).toBeGreaterThan(0);
  });

  it('region() lifts annulus loops into one evenodd shape whose hole stays empty', () => {
    const def = sketch({ seed: 1 }, (t) => {
      const band = t.isolines(
        (x, y) => 20 - Math.abs(Math.hypot(x - 50, y - 50) - 25),
        10,
      );
      return [t.region(band.map((c) => c.pts), { fill: t.hatch(0, t.mm(1.5)) })];
    });
    const out = sq(def);
    // Paper 200×200mm, user units ×2: band radii 30–70mm around (100,100).
    const mids = out.frags
      .filter((f) => !f.dot && f.geom.t === 'line')
      .map((f) => {
        const g = f.geom as { x0: number; y0: number; x1: number; y1: number };
        return Math.hypot((g.x0 + g.x1) / 2 - 100, (g.y0 + g.y1) / 2 - 100);
      });
    expect(mids.length).toBeGreaterThan(20);
    expect(mids.filter((d) => d < 28)).toHaveLength(0); // the hole
    expect(mids.filter((d) => d > 32 && d < 68).length).toBeGreaterThan(10); // the band inked
  });
});
