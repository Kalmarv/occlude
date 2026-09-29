/** `bin(v, lo, hi, n)`: which of n equal slices holds a value. */

import { describe, expect, it } from 'vitest';
import { bin } from '../src/index.js';

describe('bin', () => {
  it('slices lo…hi into n and clamps to the end slices', () => {
    expect([0, 19.9, 20, 50, 99.9, 100].map((v) => bin(v, 0, 100, 5))).toEqual([0, 0, 1, 2, 4, 4]);
    expect(bin(-10, 0, 100, 5)).toBe(0);
    expect(bin(500, 0, 100, 5)).toBe(4);
    expect(bin(10, 100, 0, 5)).toBe(4); // a reversed range counts from lo
  });

  it('gives 0 for NaN and an empty range; a bad n is an error', () => {
    expect(bin(NaN, 0, 1, 3)).toBe(0);
    expect(bin(5, 5, 5, 3)).toBe(0);
    expect(() => bin(1, 0, 1, 0)).toThrow(/whole number/);
    expect(() => bin(1, 0, 1, 2.5)).toThrow(/whole number/);
  });
});
