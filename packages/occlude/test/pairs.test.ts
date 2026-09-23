import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { curve, distance, material } from '../src/material.js';
import { initOcclude, render, sketch } from '../src/index.js';

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

describe('pairs', () => {
  it('without a radius is the full product, and says so', () => {
    const m = material([[0, 0], [1, 0], [2, 0]]);
    const all = m.points.pairs(m.points, () => true);
    // Unordered and unique: three points give three pairs, not six.
    expect(all.map(([a, b]) => [a.index, b.index])).toEqual([[0, 1], [0, 2], [1, 2]]);
    // Two different selections are an ordered product, minus self-pairs.
    const first = m.points.filter((p) => p.index === 0);
    expect(m.points.pairs(first, () => true).map(([a, b]) => [a.index, b.index])).toEqual([[1, 0], [2, 0]]);
  });

  it('with a radius equals the brute-force product filtered by distance', () => {
    const m = wheel();
    const near = (r: number) => m.points.pairs(m.points, () => true, { radius: r }).map(([a, b]) => [a.index, b.index]);
    const brute = (r: number) => {
      const out: number[][] = [];
      for (let i = 0; i < m.n; i++) {
        for (let j = i + 1; j < m.n; j++) if (distance(m.points.at(i), m.points.at(j)) < r) out.push([i, j]);
      }
      return out;
    };
    for (const r of [4, 10.5, 14, 30]) expect(near(r)).toEqual(brute(r));
  });

  it('the predicate decides, and sees the two views', () => {
    const m = wheel();
    const spokes = m.points.filter((p) => p.index === 0).pairs(
      m.points.filter((p) => p.index > 0),
      (a, b) => distance(a, b) < 10.5,
    );
    expect(spokes).toHaveLength(6);
    expect(spokes.every(([a]) => a.index === 0)).toBe(true);
  });

  it('refuses the other domain by name', () => {
    const m = curve([[0, 0], [1, 0], [2, 0]], { closed: false });
    expect(() => (m.edges as never as { pairs(o: unknown, p: unknown): unknown }).pairs(m.points, () => true))
      .toThrow(/an edge selection pairs only with an edge selection/);
    expect(() => (m.points as never as { pairs(o: unknown, p: unknown): unknown }).pairs(m.edges, () => true))
      .toThrow(/a point selection pairs only with a point selection/);
  });

  it('refuses two selections of unrelated materials', () => {
    const a = material([[0, 0]]);
    const b = material([[0, 0]]);
    expect(() => a.points.pairs(b.points, () => true)).toThrow(/unrelated materials/);
  });

  it('edges pair by their middles', () => {
    const c = curve([[0, 0], [4, 0], [8, 0], [40, 0]], { closed: false });
    // Middles at 2, 6 and 24: the first two are 4 apart, the third is far.
    const close = c.edges.pairs(c.edges, () => true, { radius: 5 });
    expect(close.map(([a, b]) => [a.index, b.index])).toEqual([[0, 1]]);
    const all = c.edges.pairs(c.edges, () => true);
    expect(all).toHaveLength(3);
  });
});

describe('t.pick', () => {
  it('takes anything with length and at: an array, a selection, a list of pairs', () => {
    render(sketch({}, (t) => {
      const m = wheel();
      const one = t.pick(m.points);
      expect(typeof one.x).toBe('number');
      expect(one.index).toBeGreaterThanOrEqual(0);
      const some = m.points.pairs(m.points, () => true, { radius: 10.5 });
      const [a, b] = t.pick(some);
      expect(distance(a, b)).toBeLessThan(10.5);
      expect(t.pick([7, 7, 7])).toBe(7);
      // Nothing to pick from is nothing to pick from, whichever spelling:
      // an array would quietly answer undefined and a selection's own `at`
      // would refuse with a different word.
      expect(() => t.pick([])).toThrow(/nothing to pick from/);
      expect(() => t.pick(m.points.filter(() => false))).toThrow(/nothing to pick from/);
      return [];
    }), { paper: 'Square20' });
  });
});
