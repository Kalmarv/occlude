import { expect, it } from 'vitest';
import { Algebraic, nextUp } from '../bench/exact-reference/core/algebraic.js';

it('certifies dependent and nested radicals, including a reducible extension inverse', () => {
  const k = new Algebraic(),
    n = (x: number) => k.number(x);
  const s2 = k.sqrt(n(2)),
    s8 = k.sqrt(n(8));
  expect(k.cmp(s8, k.mul(n(2), s2))).toBe(0);
  const sum = k.add(s8, k.mul(n(2), s2));
  expect(k.cmp(k.mul(sum, k.div(k.one, sum)), k.one)).toBe(0);
  const nested = k.sqrt(k.add(n(3), k.mul(n(2), s2)));
  expect(k.cmp(nested, k.add(k.one, s2))).toBe(0);
  expect(k.cmp(k.sqrt(k.sub(n(3), k.mul(n(2), s2))), k.sub(s2, k.one))).toBe(0);
});
it('keeps distinct roots even when their approximate doubles agree', () => {
  const k = new Algebraic();
  const a = k.sqrt(k.number(2));
  const b = k.sqrt(k.number(nextUp(2)));
  expect(k.cmp(a, b)).toBe(-1);
  expect(k.sign(k.sub(b, a))).toBe(1);
  expect(k.numberOf(a)).toBeCloseTo(Math.sqrt(2), 15);
});
it('preserves exact input subtraction and subnormal signs', () => {
  const k = new Algebraic();
  expect(
    k.cmp(k.sub(k.number(0.9999999999999999), k.number(-1)), k.number(2)),
  ).toBe(-1);
  expect(
    k.sign(k.mul(k.number(Number.MIN_VALUE), k.number(Number.MIN_VALUE))),
  ).toBe(1);
});
it('certifies expressions spanning multiple independent quadratic extensions', () => {
  const k = new Algebraic(),
    n = (v: number) => k.number(v),
    a = k.sqrt(n(2)),
    b = k.sqrt(n(3)),
    c = k.sqrt(n(5));
  const x = k.add(a, k.add(b, c));
  expect(k.cmp(k.mul(x, k.div(k.one, x)), k.one)).toBe(0);
  expect(k.sign(k.sub(k.add(x, n(1e-200)), x))).toBe(1);
  expect(k.cmp(k.sqrt(k.square(k.sub(a, b))), k.sub(b, a))).toBe(0);
});

it('encloses subnormal quotients without underflowing the scale factor first', () => {
  const k = new Algebraic(),
    a = k.number(1e-305),
    b = k.number(1e-300);
  const result = k.div(k.mul(k.square(a), a), k.square(b));
  expect(result.lo).toBeLessThanOrEqual(result.hi);
  expect(k.sign(result)).toBe(1);
  const value = k.numberOf(result);
  expect(value).toBeGreaterThan(0);
  expect(Math.abs(value / 1e-315 - 1)).toBeLessThan(1e-7);
});
