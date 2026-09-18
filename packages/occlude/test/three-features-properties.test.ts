import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  circle, sdf, initOcclude, material, mm, polygon, primLength, rect, render, rule, shader, sketch,
  type SketchDef, type StrokeInk,
} from '../src/index.js';
import { decodePlanBuffer } from '../src/plan.js';
import { planBuffer } from '../src/render.js';
import { isolinesOf } from '../src/isolines.js';

beforeAll(async () => {
  await initOcclude(readFileSync(fileURLToPath(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url))));
});

/** A small deterministic generator, so a failure is reproducible. */
const rng = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

const scene: SketchDef = sketch({}, () => [
  polygon(circle(50, 50, 30)),
  polygon(rect(20, 20, 25, 25)),
  polygon(circle(50, 50, 12), { pen: 'pigma-05-black' }),
]);

const inkOf = (chains: { prims: { t: string }[] }[]): number =>
  chains.reduce((sum, c) => sum + c.prims.reduce((s, p) => s + primLength(p as never), 0), 0);

describe('shader invariants, over many random programs', () => {
  it('never adds ink beyond what passes ask for, and never crashes', () => {
    const result = render(scene, { paper: { w: 100, h: 100 } });
    const plain = decodePlanBuffer(planBuffer(result, {}).buffer);
    const plainInk = inkOf(plain);
    const next = rng(20260918);

    for (let trial = 0; trial < 60; trial++) {
      const passes = 1 + Math.floor(next() * 4);
      const on = 0.4 + next() * 4;
      const off = 0.4 + next() * 4;
      const cut = next();
      const program = (s: number, p: [number, number]): StrokeInk => {
        const ink: StrokeInk = {};
        if (next() < 0.3) ink.passes = passes;
        if (next() < 0.3) ink.dash = [mm(on), mm(off)];
        if (next() < 0.2) ink.keep = p[0] / 100 > cut;
        if (next() < 0.2) ink.pen = next() < 0.5 ? 'pigma-005-black' : 'pigma-05-black';
        return ink;
      };
      const chains = decodePlanBuffer(planBuffer(result, { shader: shader(program) }).buffer);
      const ink = inkOf(chains);
      // A shader removes ink or repeats it. It never invents new path.
      expect(ink).toBeLessThanOrEqual(plainInk * passes + 1e-6);
      expect(Number.isFinite(ink)).toBe(true);
      for (const c of chains) {
        expect(c.prims.length).toBeGreaterThan(0);
        expect(c.pen).toBeGreaterThanOrEqual(0);
        expect(c.pen).toBeLessThan(result.pens.length);
        for (const p of c.prims) {
          for (const v of Object.values(p)) {
            if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true);
          }
        }
      }
    }
  });
});

describe('field algebra invariants, over many random shapes', () => {
  const env = { bounds: { x: 0, y: 0, w: 100, h: 100 }, len: (l: unknown) => (typeof l === 'number' ? l : (l as { value: number }).value) };
  const zero = (f: (x: number, y: number) => number) => isolinesOf(env as never, f, 0, { step: 0.5 });

  it('holds union, intersect and subtract at every sample', () => {
    const next = rng(4242);
    for (let trial = 0; trial < 40; trial++) {
      const a = sdf.circle(20 + next() * 60, 20 + next() * 60, 5 + next() * 20);
      const b = next() < 0.5
        ? sdf.box(20 + next() * 60, 20 + next() * 60, 8 + next() * 30, 8 + next() * 30)
        : sdf.segment(10 + next() * 40, 10 + next() * 40, 50 + next() * 40, 50 + next() * 40, 3 + next() * 10);
      const u = sdf.union(a, b);
      const i = sdf.intersect(a, b);
      const d = sdf.subtract(a, b);
      for (let k = 0; k < 40; k++) {
        const x = next() * 100;
        const y = next() * 100;
        const av = a(x, y);
        const bv = b(x, y);
        expect(u(x, y)).toBeCloseTo(Math.max(av, bv), 9);
        expect(i(x, y)).toBeCloseTo(Math.min(av, bv), 9);
        expect(d(x, y)).toBeCloseTo(Math.min(av, -bv), 9);
        // Inside the union wherever inside either — the sign is the shape.
        expect(u(x, y) > 0).toBe(av > 0 || bv > 0);
        expect(i(x, y) > 0).toBe(av > 0 && bv > 0);
      }
      // A blend never erodes the union: it only ever adds material.
      const blended = sdf.blend(a, b, 4);
      for (let k = 0; k < 20; k++) {
        const x = next() * 100;
        const y = next() * 100;
        expect(blended(x, y)).toBeGreaterThanOrEqual(u(x, y) - 1e-9);
      }
      // Whatever the shapes, contouring at zero yields drawable loops.
      for (const c of zero(u)) expect(c.pts.length).toBeGreaterThan(1);
    }
  });
});

describe('rule invariants, over many random patterns', () => {
  const chain = (n: number) => material(
    Array.from({ length: n }, (_, i) => [i * 3, 0] as [number, number]),
    { edges: Array.from({ length: n - 1 }, (_, i) => [i, i + 1] as [number, number]) },
  );

  it('splits and moves without losing the material', () => {
    const next = rng(77);
    for (let trial = 0; trial < 40; trial++) {
      const m = chain(4 + Math.floor(next() * 6));
      const before = m.points.length;
      const grown = m.steps(1 + Math.floor(next() * 3), [
        rule.point().move([next() * 2 - 1, next() * 2 - 1]),
        rule.edge((e) => e.length > next() * 4).split(),
      ]);
      // Points are only ever added by a split, never lost.
      expect(grown.points.length).toBeGreaterThanOrEqual(before);
      for (const p of grown.points) {
        expect(Number.isFinite(p.x)).toBe(true);
        expect(Number.isFinite(p.y)).toBe(true);
      }
      // Every edge still joins two points of the state.
      for (const e of grown.edges) {
        expect(e.a.index).toBeGreaterThanOrEqual(0);
        expect(e.b.index).toBeLessThan(grown.points.length);
      }
    }
  });
});

describe('degenerate input draws nothing, and the sketch keeps rendering', () => {
  const env = { bounds: { x: 0, y: 0, w: 100, h: 100 }, len: (l: unknown) => (typeof l === 'number' ? l : (l as { value: number }).value) };
  const zero = (f: (x: number, y: number) => number) => isolinesOf(env as never, f, 0, { step: 0.5 });

  it('takes a field with no size, and one made of non-numbers', () => {
    // Law: a degenerate input draws nothing for that piece or clamps.
    expect(zero(sdf.circle(50, 50, 0))).toEqual([]);
    expect(zero(sdf.box(50, 50, 0, 0))).toEqual([]);
    expect(zero(sdf.circle(50, 50, -5))).toEqual([]);
    expect(zero(sdf.segment(50, 50, 50, 50, 0))).toEqual([]);
    // A zero-length segment with a radius is a disc, and it draws.
    expect(zero(sdf.segment(50, 50, 50, 50, 10)).length).toBeGreaterThan(0);
    // Non-finite coordinates produce no contour rather than an exception.
    expect(() => zero(sdf.circle(NaN, 50, 10))).not.toThrow();
    expect(() => zero(sdf.circle(Infinity, 50, 10))).not.toThrow();
    expect(() => zero(sdf.union(sdf.circle(NaN, NaN, NaN), sdf.circle(50, 50, 10)))).not.toThrow();
  });

  it('takes a shader program that returns rubbish', () => {
    const result = render(scene, { paper: { w: 100, h: 100 } });
    const plan = (ink: unknown) => decodePlanBuffer(planBuffer(result, { shader: shader(() => ink as StrokeInk) }).buffer);
    // An empty-ish answer is no answer: draw it as it was.
    expect(plan({}).length).toBeGreaterThan(0);
    expect(plan({ dash: undefined, pen: undefined, passes: undefined }).length).toBeGreaterThan(0);
    // A dash of nonsense is a solid line, not a stopped sketch.
    expect(() => plan({ dash: [NaN, NaN] })).not.toThrow();
    expect(() => plan({ dash: [-1, -1] })).not.toThrow();
    expect(() => plan({ dash: [0, 0] })).not.toThrow();
    expect(plan({ dash: [NaN, NaN] }).length).toBe(plan({}).length);
    // These two are mistakes, not degenerate art, and say so.
    expect(() => plan({ passes: Infinity })).toThrow(/finite/);
    expect(() => plan({ pen: 99 })).toThrow(/no pen 99/);
  });

  it('takes a rule over a material with nothing in it', () => {
    const empty = material([] as [number, number][]);
    expect(() => empty.steps(3, rule.point().move([1, 1]))).not.toThrow();
    expect(empty.steps(3, rule.point().move([1, 1])).points.length).toBe(0);
    expect(() => empty.steps(2, rule.edge().split())).not.toThrow();
    // One lonely point has no edges to match, and that is not an error.
    const lonely = material([[5, 5]] as [number, number][]);
    expect(lonely.steps(2, [rule.point().move([1, 0]), rule.edge().split()]).points.length).toBe(1);
  });
})
