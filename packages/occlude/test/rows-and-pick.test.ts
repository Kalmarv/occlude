import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { curve, distance, material } from '../src/material.js';
import { sketch } from '../src/index.js';
import { initOcclude, render } from '../src/host.js';

beforeAll(async () => {
  const wasmPath = fileURLToPath(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url));
  await initOcclude(readFileSync(wasmPath));
});

// Six points on a circle of radius 10, plus the centre.
const wheel = () => {
  const pts: [number, number][] = [[50, 50]];
  for (let k = 0; k < 6; k++) pts.push([50 + Math.cos((k / 6) * Math.PI * 2) * 10, 50 + Math.sin((k / 6) * Math.PI * 2) * 10]);
  return material(pts);
};

describe('rows', () => {
  it('holds the SOURCE rows it is given, never positions within a selection', () => {
    const m = wheel();
    const outer = m.points.filter((p) => p.index > 0);
    expect(outer.rows([0, 3]).indices).toEqual([0, 3]); // row 0 is the centre, which `outer` does not hold
    expect(m.points.rows([]).length).toBe(0);
    expect(() => m.points.rows([7])).toThrow(/no vertex 7/);
    expect(() => m.points.rows([1.5])).toThrow(/no vertex 1.5/);
  });

  it('edges.rows says the same thing about edge rows', () => {
    const c = curve([[0, 0], [10, 0], [20, 0]], { closed: false });
    expect(c.edges.rows([1]).indices).toEqual([1]);
    expect(() => c.edges.rows([2])).toThrow(/no edge 2/);
  });
});

describe('t.pick', () => {
  it('takes anything with length and at: an array, a selection, a list of pairs', () => {
    render(sketch({}, (t) => {
      const m = wheel();
      const one = t.pick(m.points);
      expect(typeof one.x).toBe('number');
      expect(one.index).toBeGreaterThanOrEqual(0);
      const some = [...m.points].flatMap((a) => [...m.points.near(a, { radius: 10.5 })].filter((b) => b.index > a.index).map((b) => [a, b] as const));
      const [a, b] = t.pick(some);
      expect(distance(a, b)).toBeLessThan(10.5);
      expect(t.pick([7, 7, 7])).toBe(7);
      // Nothing to pick from gives no member, whichever spelling (spec 71:
      // a write given `undefined` writes nothing, so an empty pick is data,
      // not a mistake).
      expect(t.pick([])).toBeUndefined();
      expect(t.pick(m.points.filter(() => false))).toBeUndefined();
      return [];
    }), { paper: 'Square20' });
  });
});
