/**
 * Exact sign arithmetic over doubles, as dyadic rationals.
 *
 * A double is an exact dyadic rational m·2^e, so a sum, difference or product
 * of input doubles is exact in `{n: bigint, e: number}`. Only signs and
 * magnitudes are needed here: the intersection layer decides existence with
 * an exact sign (a discriminant is negative, zero or positive; two circles
 * are separate, tangent or crossing) and never promotes a negative value to
 * zero. The exact path is reached only when a floating filter is
 * inconclusive, so it stays off the common fast path.
 */

export interface Dy {
  n: bigint;
  e: number;
}

const view = new DataView(new ArrayBuffer(8));

/** The double `x` as an exact dyadic. */
export function dyFrom(x: number): Dy {
  if (x === 0) return { n: 0n, e: 0 };
  view.setFloat64(0, x);
  const bits = view.getBigUint64(0);
  const exp = (bits >> 52n) & 2047n;
  const frac = bits & ((1n << 52n) - 1n);
  const mag = exp === 0n ? frac : frac + (1n << 52n);
  return { n: (bits >> 63n) !== 0n ? -mag : mag, e: exp === 0n ? -1074 : Number(exp) - 1075 };
}

function rescale(a: Dy, b: Dy): [bigint, bigint, number] {
  const e = Math.min(a.e, b.e);
  return [a.n << BigInt(a.e - e), b.n << BigInt(b.e - e), e];
}

export function dyAdd(a: Dy, b: Dy): Dy {
  if (a.n === 0n) return b;
  if (b.n === 0n) return a;
  const [an, bn, e] = rescale(a, b);
  return { n: an + bn, e };
}

export function dySub(a: Dy, b: Dy): Dy {
  return dyAdd(a, { n: -b.n, e: b.e });
}

export function dyMul(a: Dy, b: Dy): Dy {
  if (a.n === 0n || b.n === 0n) return { n: 0n, e: 0 };
  return { n: a.n * b.n, e: a.e + b.e };
}

export function dySign(a: Dy): -1 | 0 | 1 {
  return a.n > 0n ? 1 : a.n < 0n ? -1 : 0;
}

/** `a` rounded to the nearest double (the exact value is usually tight enough
 * that this is the value the float path would have produced). */
export function dyToNumber(a: Dy): number {
  if (a.n === 0n) return 0;
  const neg = a.n < 0n;
  const mag = neg ? -a.n : a.n;
  const bits = mag.toString(2).length;
  const shift = Math.max(0, bits - 53);
  const value = Number(mag >> BigInt(shift)) * 2 ** (a.e + shift);
  return neg ? -value : value;
}
