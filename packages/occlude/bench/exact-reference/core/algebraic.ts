/** Filtered exact real arithmetic for constructions using +, −, ×, ÷ and √.
 *
 * The exact fallback is a tower of real quadratic extensions. A level stores
 * a + b√r, where r and both coefficients belong to lower levels. Sign reduces
 * to signs at lower levels (compare a² with b²r). This also handles dependent
 * radicals: a zero norm is tested exactly before rationalizing a quotient.
 * No precision limit is ever interpreted as equality. Doubles are filters and
 * export coordinates only; input doubles enter as their exact dyadic values.
 */
import { dyFrom } from '../../../src/dyadic.js';

type Q = { n: bigint; d: bigint; level: 0 };
type F = Q | { level: number; a: F; b: F; r: F };
const Z: Q = { n: 0n, d: 1n, level: 0 };
const O: Q = { n: 1n, d: 1n, level: 0 };
function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) {
    const c = a % b;
    a = b;
    b = c;
  }
  return a;
}
function q(n: bigint, d = 1n): Q {
  if (!d) throw new Error('algebraic: division by zero');
  if (!n) return Z;
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const g = gcd(n, d);
  return { level: 0, n: n / g, d: d / g };
}
function ext(level: number, a: F, b: F, r: F): F {
  return b === Z ? a : { level, a, b, r };
}
function neg(a: F): F {
  return a.level === 0
    ? q(-(a as Q).n, (a as Q).d)
    : ext(a.level, neg((a as Ex).a), neg((a as Ex).b), (a as Ex).r);
}
type Ex = Exclude<F, Q>;
function add(a: F, b: F): F {
  if (a === Z) return b;
  if (b === Z) return a;
  if (!a.level && !b.level) {
    const x = a as Q,
      y = b as Q;
    return q(x.n * y.d + y.n * x.d, x.d * y.d);
  }
  if (a.level < b.level) return add(b, a);
  const x = a as Ex;
  if (a.level > b.level) return ext(x.level, add(x.a, b), x.b, x.r);
  const y = b as Ex;
  return ext(x.level, add(x.a, y.a), add(x.b, y.b), x.r);
}
function mul(a: F, b: F): F {
  if (a === Z || b === Z) return Z;
  if (a === O) return b;
  if (b === O) return a;
  if (!a.level && !b.level) {
    const x = a as Q,
      y = b as Q;
    return q(x.n * y.n, x.d * y.d);
  }
  if (a.level < b.level) return mul(b, a);
  const x = a as Ex;
  if (a.level > b.level) return ext(x.level, mul(x.a, b), mul(x.b, b), x.r);
  const y = b as Ex;
  return ext(
    x.level,
    add(mul(x.a, y.a), mul(mul(x.b, y.b), x.r)),
    add(mul(x.a, y.b), mul(x.b, y.a)),
    x.r,
  );
}
const signs = new WeakMap<object, number>();
function sign(a: F): number {
  if (!a.level) return (a as Q).n > 0n ? 1 : (a as Q).n < 0n ? -1 : 0;
  const cached = signs.get(a);
  if (cached !== undefined) return cached;
  const x = a as Ex,
    sa = sign(x.a),
    sb = sign(x.b);
  const s =
    sa === 0
      ? sb
      : sb === 0 || sa === sb
        ? sa
        : sa * sign(add(mul(x.a, x.a), neg(mul(mul(x.b, x.b), x.r))));
  signs.set(a, s || 0);
  return s || 0;
}
function inv(a: F): F {
  if (!a.level) {
    const x = a as Q;
    return q(x.d, x.n);
  }
  const x = a as Ex;
  const norm = add(mul(x.a, x.a), neg(mul(mul(x.b, x.b), x.r)));
  if (sign(norm) === 0) {
    if (sign(a) === 0) throw new Error('algebraic: division by zero');
    return inv(add(x.a, x.a));
  }
  const d = inv(norm);
  return ext(x.level, mul(x.a, d), neg(mul(x.b, d)), x.r);
}
function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}
const bits = new DataView(new ArrayBuffer(8));
export function nextUp(x: number): number {
  if (x === Infinity || Number.isNaN(x)) return x;
  if (x === 0) return Number.MIN_VALUE;
  bits.setFloat64(0, x);
  bits.setBigUint64(0, bits.getBigUint64(0) + (x > 0 ? 1n : -1n));
  return bits.getFloat64(0);
}
export const nextDown = (x: number): number => -nextUp(-x);

type Interval = readonly [bigint, bigint];
const floorDiv = (a: bigint, b: bigint): bigint => {
  if (b < 0n) {
    a = -a;
    b = -b;
  }
  const q = a / b;
  return a < 0n && a % b !== 0n ? q - 1n : q;
};
const ceilDiv = (a: bigint, b: bigint): bigint => -floorDiv(-a, b);
export class Real {
  private exactValue?: F;
  private intervals?: Map<number, Interval | undefined>;
  constructor(
    readonly id: number,
    public lo: number,
    public hi: number,
    readonly approx: number,
    private readonly construct: () => F,
    private readonly refine: (bits: number) => Interval | undefined,
  ) {}
  interval(bits: number): Interval | undefined {
    const cache = (this.intervals ??= new Map());
    if (!cache.has(bits)) cache.set(bits, this.refine(bits));
    return cache.get(bits);
  }
  exact(): F {
    return (this.exactValue ??= this.construct());
  }
}

/** One construction arena: root levels and expression caches never leak
 * between renders. Resource limits fail explicitly, never alter geometry. */
export class Algebraic {
  private serial = 0;
  private rootLevel = 0;
  private readonly numbers = new Map<number, Real>();
  private readonly expressions = new Map<string, Real>();
  private readonly roots = new Map<string, Real>();
  readonly zero = this.number(0);
  readonly one = this.number(1);
  number(n: number): Real {
    if (!Number.isFinite(n)) throw new Error('algebraic: non-finite input');
    const old = this.numbers.get(n);
    if (old) return old;
    const a = new Real(
      this.serial++,
      n,
      n,
      n,
      () => {
        const d = dyFrom(n);
        return d.e >= 0 ? q(d.n << BigInt(d.e)) : q(d.n, 1n << BigInt(-d.e));
      },
      (bits) => {
        const d = dyFrom(n),
          shift = d.e + bits;
        return shift >= 0
          ? [d.n << BigInt(shift), d.n << BigInt(shift)]
          : [d.n >> BigInt(-shift), -(-d.n >> BigInt(-shift))];
      },
    );
    this.numbers.set(n, a);
    return a;
  }
  private node(
    key: string,
    lo: number,
    hi: number,
    value: number,
    exact: () => F,
    refine: (bits: number) => Interval | undefined,
  ): Real {
    const old = this.expressions.get(key);
    if (old) return old;
    if (this.serial > 20_000_000)
      throw new Error('thicken: exact construction budget exceeded');
    if (this.expressions.size >= 100_000) this.expressions.clear();
    const a = new Real(
      this.serial++,
      Number.isNaN(lo) ? -Infinity : lo,
      Number.isNaN(hi) ? Infinity : hi,
      value,
      exact,
      refine,
    );
    this.expressions.set(key, a);
    return a;
  }
  add(a: Real, b: Real): Real {
    if (a === this.zero) return b;
    if (b === this.zero) return a;
    if (a.id > b.id) [a, b] = [b, a];
    return this.node(
      `+${a.id},${b.id}`,
      nextDown(a.lo + b.lo),
      nextUp(a.hi + b.hi),
      a.approx + b.approx,
      () => add(a.exact(), b.exact()),
      (bits) => {
        const x = a.interval(bits),
          y = b.interval(bits);
        return x && y ? [x[0] + y[0], x[1] + y[1]] : undefined;
      },
    );
  }
  neg(a: Real): Real {
    if (a === this.zero) return a;
    return this.node(
      `-${a.id}`,
      -a.hi,
      -a.lo,
      -a.approx,
      () => neg(a.exact()),
      (bits) => {
        const x = a.interval(bits);
        return x ? [-x[1], -x[0]] : undefined;
      },
    );
  }
  sub(a: Real, b: Real): Real {
    return a === b ? this.zero : this.add(a, this.neg(b));
  }
  mul(a: Real, b: Real): Real {
    if (a === this.zero || b === this.zero) return this.zero;
    if (a === this.one) return b;
    if (b === this.one) return a;
    if (a.id > b.id) [a, b] = [b, a];
    const ps = [a.lo * b.lo, a.lo * b.hi, a.hi * b.lo, a.hi * b.hi];
    return this.node(
      `*${a.id},${b.id}`,
      nextDown(Math.min(...ps)),
      nextUp(Math.max(...ps)),
      a.approx * b.approx,
      () => mul(a.exact(), b.exact()),
      (bits) => {
        const x = a.interval(bits),
          y = b.interval(bits);
        if (!x || !y) return;
        const v = [x[0] * y[0], x[0] * y[1], x[1] * y[0], x[1] * y[1]],
          lo = v.reduce((a, b) => (a < b ? a : b)),
          hi = v.reduce((a, b) => (a > b ? a : b)),
          shift = BigInt(bits);
        return [lo >> shift, -(-hi >> shift)];
      },
    );
  }
  square(a: Real): Real {
    return this.mul(a, a);
  }
  div(a: Real, b: Real): Real {
    if (b === this.one) return a;
    if (this.sign(b) === 0) throw new Error('algebraic: division by zero');
    if (a === this.zero) return a;
    if (a === b) return this.one;
    const ps =
      b.lo <= 0 && b.hi >= 0
        ? [-Infinity, Infinity]
        : [a.lo / b.lo, a.lo / b.hi, a.hi / b.lo, a.hi / b.hi];
    const result = this.node(
      `/${a.id},${b.id}`,
      nextDown(Math.min(...ps)),
      nextUp(Math.max(...ps)),
      a.approx / b.approx,
      () => mul(a.exact(), inv(b.exact())),
      (bits) => {
        const x = a.interval(bits),
          y = b.interval(bits);
        if (!x || !y || (y[0] <= 0n && y[1] >= 0n)) return;
        const v = x.flatMap((a) =>
          y.map((b) => [
            floorDiv(a << BigInt(bits), b),
            ceilDiv(a << BigInt(bits), b),
          ]),
        );
        return [
          v.reduce((a, b) => (a < b[0] ? a : b[0]), v[0][0]),
          v.reduce((a, b) => (a > b[1] ? a : b[1]), v[0][1]),
        ];
      },
    );
    if (!Number.isFinite(result.lo) || !Number.isFinite(result.hi))
      this.tighten(result);
    return result;
  }
  sqrt(a: Real): Real {
    const s = this.sign(a);
    if (s < 0) throw new Error('algebraic: negative radicand');
    if (s === 0) return this.zero;
    const key = `s${a.id}`;
    const old = this.roots.get(key);
    if (old) return old;
    const level = ++this.rootLevel;
    const result = this.node(
      key,
      Math.max(0, nextDown(Math.sqrt(Math.max(0, a.lo)))),
      nextUp(Math.sqrt(a.hi)),
      Math.sqrt(Math.max(0, a.approx)),
      () => {
        const r = a.exact();
        if (!r.level) {
          const v = r as Q,
            n = isqrt(v.n),
            d = isqrt(v.d);
          if (n * n === v.n && d * d === v.d) return q(n, d);
        }
        return ext(level, Z, O, r);
      },
      (bits) => {
        const x = a.interval(bits);
        if (!x) return;
        const shift = BigInt(bits),
          lo = isqrt((x[0] > 0n ? x[0] : 0n) << shift),
          h = (x[1] > 0n ? x[1] : 0n) << shift,
          hi = isqrt(h);
        return [lo, hi * hi === h ? hi : hi + 1n];
      },
    );
    this.roots.set(key, result);
    return result;
  }
  tighten(a: Real): void {
    for (const bits of [96, 192, 384, 768, 1536, 3072]) {
      const v = a.interval(bits);
      if (!v) continue;
      const convert = (x: bigint) => {
        const shift = Math.max(0, (x < 0n ? -x : x).toString(2).length - 53);
        const significand = Number(x >> BigInt(shift));
        const exponent = shift - bits;
        // Do not underflow the power of two before the significand has
        // contributed its exponent. The first scaling is exact and normal;
        // only the final multiplication may round to a subnormal.
        return exponent < -1022
          ? significand * 2 ** -1022 * 2 ** (exponent + 1022)
          : significand * 2 ** exponent;
      };
      const lo = nextDown(convert(v[0])),
        hi = nextUp(convert(v[1]));
      a.lo = Math.max(a.lo, lo);
      a.hi = Math.min(a.hi, hi);
      if (Number.isFinite(a.lo) && Number.isFinite(a.hi)) return;
    }
  }
  sign(a: Real): number {
    if (a.lo > 0) return 1;
    if (a.hi < 0) return -1;
    for (const bits of [96, 192]) {
      const v = a.interval(bits);
      if (v) {
        if (v[0] > 0n) return 1;
        if (v[1] < 0n) return -1;
        if (v[0] === 0n && v[1] === 0n) return 0;
      }
    }
    return sign(a.exact());
  }
  cmp(a: Real, b: Real): number {
    return a === b
      ? 0
      : a.lo > b.hi
        ? 1
        : a.hi < b.lo
          ? -1
          : this.sign(this.sub(a, b));
  }
  /** Refine the certified enclosure to adjacent doubles. This is export,
   * never event identity. The chosen coordinate has at most one ULP error. */
  numberOf(a: Real): number {
    if (a.lo === a.hi) return a.lo;
    let lo = a.lo,
      hi = a.hi;
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      lo = -Number.MAX_VALUE;
      hi = Number.MAX_VALUE;
      if (this.cmp(a, this.number(lo)) < 0 || this.cmp(a, this.number(hi)) > 0)
        throw new Error('thicken: boundary coordinate exceeds binary64 range');
    }
    for (let i = 0; i < 2200; i++) {
      if (nextUp(lo) >= hi) return lo + (hi - lo) / 2;
      const m = lo / 2 + hi / 2;
      if (m === lo || m === hi) return m;
      const c = this.cmp(a, this.number(m));
      if (!c) return m;
      if (c < 0) hi = m;
      else lo = m;
    }
    throw new Error('thicken: coordinate export refinement budget exceeded');
  }
}
