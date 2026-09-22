import { describe, expect, it } from 'vitest';
import { complex, mul, type Vec } from '../src/index.js';

const TAU = 2 * Math.PI;

/** The product of applying `complex.mul` n times: the definition `pow`
 * has to agree with. */
const repeated = (z: Vec, n: number): Vec => {
  let acc: Vec = [1, 0];
  for (let k = 0; k < n; k++) acc = complex.mul(acc, z);
  return acc;
};

describe('complex: the identities that pin the pairs down', () => {
  it('conjugation is an involution that commutes with mul and measures abs', () => {
    const z: Vec = [3, -4];
    const w: Vec = [-1.5, 2.25];
    expect(complex.conj(complex.conj(z))).toEqual(z);
    // conj(z·w) = conj(z)·conj(w)
    expect(complex.conj(complex.mul(z, w))).toEqual(complex.mul(complex.conj(z), complex.conj(w)));
    // z·conj(z) = |z|², a pure real
    const [re, im] = complex.mul(z, complex.conj(z));
    expect(re).toBeCloseTo(complex.abs(z) ** 2, 12);
    expect(im).toBeCloseTo(0, 12);
    // conj is also the reflection vec never makes: real part held, sign flipped
    expect(complex.conj(z)).toEqual([3, 4]);
    expect(complex.conj(w)).toEqual([-1.5, -2.25]);
  });

  it('polar and toPolar round-trip in both directions', () => {
    // polar → toPolar: the angle comes back wrapped into (−π, π].
    const [r, t] = complex.toPolar(complex.polar(2, 3.5));
    expect(r).toBeCloseTo(2, 12);
    expect(t).toBeCloseTo(3.5 - TAU, 12);
    // toPolar → polar: the point comes back whole.
    for (const z of [[1.5, -2.25], [-0.5, 0.75], [4, 0], [0, -3]] as Vec[]) {
      const [rr, tt] = complex.toPolar(z);
      const back = complex.polar(rr, tt);
      expect(back[0]).toBeCloseTo(z[0], 12);
      expect(back[1]).toBeCloseTo(z[1], 12);
    }
  });

  it('exp undoes log', () => {
    for (const z of [[1.5, -2.25], [-2, 0], [0.001, 0.002], [-0.5, 0.75]] as Vec[]) {
      const round = complex.exp(complex.log(z));
      expect(round[0]).toBeCloseTo(z[0], 10);
      expect(round[1]).toBeCloseTo(z[1], 10);
    }
  });

  it('sqrt takes the principal branch across the negative real axis', () => {
    // Exactly on the axis: +√|x| i, the positive side of the cut.
    const on = complex.sqrt([-4, 0]);
    expect(on[0]).toBeCloseTo(0, 12);
    expect(on[1]).toBeCloseTo(2, 12);
    // Just above and below: same modulus, opposite sign — the jump IS the cut.
    const above = complex.sqrt([-4, 1e-9]);
    const below = complex.sqrt([-4, -1e-9]);
    expect(above[0]).toBeCloseTo(0, 6);
    expect(above[1]).toBeCloseTo(2, 6);
    expect(below[0]).toBeCloseTo(0, 6);
    expect(below[1]).toBeCloseTo(-2, 6);
    // And squaring any answer returns the operand.
    for (const z of [[-4, 0], [9, 0], [3, 4], [-4, 1e-9], [0, 0]] as Vec[]) {
      const s = complex.sqrt(z);
      const back = complex.mul(s, s);
      expect(back[0]).toBeCloseTo(z[0], 9);
      expect(back[1]).toBeCloseTo(z[1], 9);
    }
  });

  it('pow is repeated mul for whole exponents, and its reciprocal below zero', () => {
    const z: Vec = [1.25, -0.75];
    let acc: Vec = [1, 0];
    for (let n = 0; n <= 6; n++) {
      expect(complex.pow(z, n)).toEqual(repeated(z, n));
      acc = complex.mul(acc, z);
    }
    // Negative integer: the reciprocal of the positive power.
    const down = complex.pow(z, -3);
    const up = complex.pow(z, 3);
    const one = complex.mul(down, up);
    expect(one[0]).toBeCloseTo(1, 10);
    expect(one[1]).toBeCloseTo(0, 10);
    // A non-integer exponent still lives on the principal branch: √4 = 2.
    expect(complex.pow([4, 0], 0.5)[0]).toBeCloseTo(2, 10);
    // The same spelling the namespace itself uses.
    expect(complex.pow(z, [3, 0])).toEqual(repeated(z, 3));
    void mul;
  });
});
