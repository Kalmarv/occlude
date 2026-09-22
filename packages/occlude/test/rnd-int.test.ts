import { describe, expect, it } from 'vitest';
import { toolkit } from './helpers/run.js';

describe('t.rndInt', () => {
  it('rndInt(n) is one of the n values 0 … n−1, and each shows up', () => {
    const t = toolkit({ seed: 7 });
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const v = t.rndInt(6);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(5);
      seen.add(v);
    }
    expect([...seen].sort()).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('rndInt(a, b) includes both ends', () => {
    const t = toolkit({ seed: 7 });
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const v = t.rndInt(1, 6);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(6);
      seen.add(v);
    }
    expect([...seen].sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(seen.has(0)).toBe(false);
  });

  it('is one draw from the stream, so the values after it are what rnd() would have seen', () => {
    const a = toolkit({ seed: 11 });
    const b = toolkit({ seed: 11 });
    a.rndInt(1, 6);
    b.rnd();
    expect(a.rnd()).toBe(b.rnd());
  });

  it('is deterministic per seed, and a named stream has it too', () => {
    const a = toolkit({ seed: 3 });
    const b = toolkit({ seed: 3 });
    const xs = Array.from({ length: 10 }, () => a.rndInt(-3, 3));
    const ys = Array.from({ length: 10 }, () => b.rndInt(-3, 3));
    expect(xs).toEqual(ys);
    expect(xs.every((v) => v >= -3 && v <= 3 && Number.isInteger(v))).toBe(true);
    const s = toolkit({ seed: 3 }).stream('dice');
    const v = s.rndInt(1, 6);
    expect(Number.isInteger(v) && v >= 1 && v <= 6).toBe(true);
  });

  it('is best effort on degenerate asks: non-whole bounds tighten inward, an empty range is its lower end', () => {
    const t = toolkit({ seed: 5 });
    for (let i = 0; i < 200; i++) {
      const v = t.rndInt(1.5, 3.5);
      expect(v === 2 || v === 3).toBe(true);
    }
    expect(t.rndInt(4, 2)).toBeGreaterThanOrEqual(2);
    expect(t.rndInt(2.2, 2.8)).toBe(3);
    expect(t.rndInt(0)).toBe(0);
    expect(t.rndInt(-4)).toBe(0);
  });
});
