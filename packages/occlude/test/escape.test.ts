import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  compileSketchAsync, complex, escape, evalPrim, initOcclude, render, sketch, strokes,
} from '../src/index.js';
import type { Vec } from '../src/index.js';

beforeAll(async () => {
  await initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url)));
});

/** The two-line recipe the docs show: the quadratic map. */
const quad = (z: Vec, c: Vec): Vec => complex.add(complex.mul(z, z), c);

const mandel = (iterations = 30) =>
  escape(quad, { input: 'c', iterations, bailout: 4 });

/** The raw count beside the smooth one: how many iterations actually ran. */
const rawCount = (x: number, cap = 30): number => {
  let z: Vec = [0, 0];
  let n = 0;
  while (n < cap && z[0] * z[0] + z[1] * z[1] <= 16) {
    z = quad(z, [x, 0]);
    n++;
  }
  return n;
};

describe('escape: the smooth count', () => {
  it('is continuous across an iteration boundary — no whole-unit jump', () => {
    const field = mandel();
    // Walk the real axis: raw counts step down by exactly one at each
    // boundary, and the two points either side are 1e-4 apart.
    const dx = 1e-4;
    let boundaries = 0;
    for (let x = 0.3; x < 1.9; x += dx) {
      const [n, m] = [rawCount(x), rawCount(x + dx)];
      if (n === m) continue;
      expect(n - m).toBe(1); // the raw count IS a whole unit apart
      // The smooth count across the same boundary: the log-log
      // normalisation eats the unit, leaving a sliver.
      expect(Math.abs(field(x, 0) - field(x + dx, 0))).toBeLessThan(0.25);
      boundaries++;
    }
    expect(boundaries).toBeGreaterThan(5);
  });

  it('is deterministic: two builds, same point, same double', () => {
    const [a, b] = [mandel(40), mandel(40)];
    for (const [x, y] of [[1, 1], [74, 50], [-2.2, 0], [40, 63], [99, 99], [0.5, 0.5]]) {
      expect(a(x, y)).toBe(b(x, y));
      expect(a.potential(x, y)).toBe(b.potential(x, y));
    }
    // And one field agrees with itself across repeat calls.
    expect(a(40, 63)).toBe(a(40, 63));
  });

  it('never escapes → NaN in both accessors: not a place, consistently', () => {
    const field = mandel(40);
    for (const c of [[0, 0], [-1, 0], [0.1, 0]] as Vec[]) {
      expect(field(c[0], c[1])).toBeNaN();
      expect(field.potential(c[0], c[1])).toBeNaN();
    }
    // Escaping points are finite numbers on both readings.
    expect(Number.isFinite(field(-2.5, 0))).toBe(true);
    expect(Number.isFinite(field.potential(-2.5, 0))).toBe(true);
    expect(field.potential(-2.5, 0)).toBeGreaterThan(0);
  });

  it("input 'z' reads the point as z against the fixed c", () => {
    // c = 0: the basin of the origin inside |z| = 1, everything past the
    // bailout out at once.
    const julia = escape(quad, { input: 'z', c: [0, 0], iterations: 20, bailout: 4 });
    expect(julia(0.5, 0)).toBeNaN(); // drifts to the fixed point at 0
    expect(julia.potential(0.5, 0)).toBeNaN();
    expect(Number.isFinite(julia(60, 50))).toBe(true); // out at n = 0
  });

  it('contours an escape field end to end, all ink inside the drawable', async () => {
    const def = sketch({ aspect: [1, 1], seed: 42 }, (t) => {
      const field = escape(quad, { input: 'c', iterations: 40, bailout: 4 });
      const inSheet = (x: number, y: number) => field((x - 74) / 34, (y - 50) / 34);
      return strokes(t.isolines(inSheet, { spacing: 2 }));
    });
    const out = render(await compileSketchAsync(def), { paper: 'Square20' });
    expect(out.stats.fragments).toBeGreaterThan(0);
    // The drawable rect, as the docs checker measures it: no fragment may
    // leave it (half a unit of grazing tolerance, endpoints and middle).
    const x0 = out.frame.offsetX;
    const y0 = out.frame.offsetY;
    const x1 = x0 + out.frame.inner.innerW;
    const y1 = y0 + out.frame.inner.innerH;
    const off = out.frags.filter((frag) =>
      [0, 0.5, 1].some((s) => {
        const [ax, ay] = evalPrim(frag.geom, s);
        return ax < x0 - 0.5 || ax > x1 + 0.5 || ay < y0 - 0.5 || ay > y1 + 0.5;
      }),
    );
    expect(off).toHaveLength(0);
  });
});
