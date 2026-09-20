/**
 * `force.separation({ radius })` when the radius is a function of the
 * vertex: each point carries its own, and the radius of a PAIR is the sum.
 * That is what packs discs of different sizes.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { force, initOcclude, material, mul, type Material, type Vertex } from '../src/index.js';

beforeAll(async () => {
  const wasmPath = fileURLToPath(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url));
  await initOcclude(readFileSync(wasmPath));
});

/** Discs of three sizes on a coarse lattice, all overlapping to start. */
const discs = (): Material => {
  const pts: [number, number][] = [];
  for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) pts.push([20 + i * 7.5, 20 + j * 7.5]);
  return material(pts).attribute('r', (p) => 2 + (p.index % 3) * 1.5);
};

describe('separation with a radius per vertex', () => {
  it('is the fixed rule when every radius is the same half', () => {
    // A pair radius of 5 is 5, however it is spelled: a number of 5, or a
    // function that answers 2.5 at both ends.
    const m = material([[0, 0], [3, 0], [3, 4], [10, 10]]);
    const fixed = force.separation(m, { radius: 5 });
    const each = force.separation(m, { radius: () => 2.5 });
    for (const p of m.points) {
      const [ax, ay] = fixed(p);
      const [bx, by] = each(p);
      expect(bx).toBeCloseTo(ax, 12);
      expect(by).toBeCloseTo(ay, 12);
    }
  });

  it('a big disc pushes harder and further than a small one', () => {
    const m = material([[0, 0], [6, 0]]).attribute('r', (p) => (p.index === 0 ? 5 : 1));
    const push = force.separation(m, { radius: (p: Vertex) => p.r });
    // The pair reaches 6, which is exactly the gap: touching, so no push.
    expect(Math.hypot(...push(m.points.at(0)))).toBeCloseTo(0, 9);
    // Two small ones at the same gap do not even reach each other.
    const small = material([[0, 0], [6, 0]]).attribute('r', () => 1);
    expect(Math.hypot(...force.separation(small, { radius: (p: Vertex) => p.r })(small.points.at(0)))).toBe(0);
  });

  it('packs discs of three sizes until none of them overlap', () => {
    const start = discs();
    const worst = (m: Material) => {
      let over = 0;
      for (const p of m.points) {
        for (const q of m.points) {
          if (q.index <= p.index) continue;
          over = Math.max(over, p.r + q.r - Math.hypot(p.x - q.x, p.y - q.y));
        }
      }
      return over;
    };
    expect(worst(start)).toBeGreaterThan(0.9);
    const packed = start.steps(120, (cur, next) => {
      const push = force.separation(cur, { radius: (p: Vertex) => p.r });
      next.move(cur.points, (p) => mul(push(p), 0.35));
    });
    // Every pair is now at least the sum of its two radii apart.
    expect(worst(packed)).toBeLessThan(1e-6);
    // The run kept its points and its sizes: a packing, not a scattering.
    expect(packed.n).toBe(start.n);
    expect(Array.from(packed.attrs.r)).toEqual(Array.from(start.attrs.r));
  });

  it('reads a radius the function cannot answer as no radius, and refuses anything else', () => {
    const m = material([[0, 0], [2, 0]]).attribute('r', () => 4);
    const sick = force.separation(m, { radius: (p: Vertex) => (p.index === 0 ? NaN : p.r) });
    // The pair is 0 + 4: the two are 2 apart, so they still push.
    expect(Math.hypot(...sick(m.points.at(0)))).toBeGreaterThan(0);
    expect(() => force.separation(m, { radius: 'wide' as never })).toThrow('radius');
  });
});
