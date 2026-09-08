import { describe, expect, test } from 'vitest';

import { cool, mutate, type Candidate } from './evolve.js';

const draws = { addrs: ['a:0', 'a:1', 'b:0', 'b:1', 'c:0'], f: Float64Array.of(0.1, 0.2, 0.3, 0.4, 0.5) };
const seq = (values: number[]) => { let i = 0; return () => values[i++ % values.length]; };

describe('evolve: mutation and cooling', () => {
  test('a variation keeps the seed, moves about T² of the draws, and stays in the unit range', () => {
    const centre: Candidate = { seed: '7', overrides: { 'c:0': 0.9 } };
    const heat = new Map<string, number>();
    const rng = seq([0.3, 0.7, 0.1, 0.9, 0.5, 0.2, 0.8, 0.6, 0.4]);
    const hot = mutate(centre, draws, heat, 1, rng);
    expect(hot.seed).toBe('7');
    expect(Object.keys(hot.overrides)).toHaveLength(5); // T = 1: every draw
    for (const v of Object.values(hot.overrides)) expect(v >= 0 && v < 1).toBe(true);
    const cold = mutate(centre, draws, heat, 0.2, seq([0.5]));
    const changed = Object.keys(cold.overrides).filter((k) => cold.overrides[k] !== centre.overrides[k]);
    expect(changed.length).toBeGreaterThanOrEqual(1);
    expect(changed.length).toBeLessThanOrEqual(2); // round(5 · 0.04) → at least one
    expect(cold.overrides['c:0'] === 0.9 || changed.includes('c:0')).toBe(true); // untouched overrides carry over
  });

  test('a sketch with no draws of its own yields the centre unchanged', () => {
    const centre: Candidate = { seed: '7', overrides: {} };
    expect(mutate(centre, { addrs: [], f: new Float64Array(0) }, new Map(), 0.8, seq([0.5]))).toEqual(centre);
  });

  test('cooling keeps the draws a pick changed hot and cools the rest', () => {
    const heat = new Map<string, number>(draws.addrs.map((a) => [a, 1]));
    const from: Candidate = { seed: '7', overrides: { 'a:0': 0.5 } };
    const picked: Candidate = { seed: '7', overrides: { 'a:0': 0.5, 'b:1': 0.25 } };
    cool(heat, draws, from, picked);
    expect(heat.get('b:1')).toBe(1);
    expect(heat.get('a:0')).toBeCloseTo(0.7); // unchanged between the two: cooled
    expect(heat.get('c:0')).toBeCloseTo(0.7);
    for (let i = 0; i < 20; i++) cool(heat, draws, picked, picked);
    expect(heat.get('c:0')).toBe(0.05); // the floor
  });
});
