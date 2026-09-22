/**
 * Complex arithmetic over the `[x, y]` pair spelling — the anonymous
 * vertices read as numbers of the plane. Pure: no seed, no paper, nothing
 * but `Math`. Where an operation IS a `vec` word it IS the `vec` word:
 * `add`, `sub`, `abs` and `arg` are the very functions, not a second
 * spelling of them.
 */

import { add, sub, length as abs, angleOf as arg, vx, vy, asXY, type XY, type Vec } from './vec.js';

/** Complex multiplication: `(xa + ya i)(xb + yb i)` — a scale AND a turn,
 * which `vec.mul` (a scalar times a vector) never does. */
export function mul(a: XY, b: XY): Vec {
  const xa = vx(a);
  const ya = vy(a);
  const xb = vx(b);
  const yb = vy(b);
  return [xa * xb - ya * yb, xa * yb + ya * xb];
}

/** `a · b̄ / |b|²` split into its four products: `b = 0` answers with the
 * IEEE result (NaN or ±Infinity) and draws nothing, as degenerate input
 * does everywhere. */
export function div(a: XY, b: XY): Vec {
  const xa = vx(a);
  const ya = vy(a);
  const xb = vx(b);
  const yb = vy(b);
  const d = xb * xb + yb * yb;
  return [(xa * xb + ya * yb) / d, (ya * xb - xa * yb) / d];
}

/** `e^x (cos y + i sin y)`. */
export function exp(z: XY): Vec {
  const r = Math.exp(vx(z));
  const t = vy(z);
  return [r * Math.cos(t), r * Math.sin(t)];
}

/** The principal square root: non-negative real part, and across the
 * negative real axis it jumps from `+√|x| i` (from above) to
 * `−√|x| i` (from below) — that jump is the branch cut. Each half of the
 * plane takes the formula that keeps its own denominator away from zero,
 * so the axis itself answers exactly. */
export function sqrt(z: XY): Vec {
  const x = vx(z);
  const y = vy(z);
  if (x === 0 && y === 0) return [0, 0];
  if (x >= 0) {
    const t = Math.sqrt((abs(z) + x) / 2);
    return [t, y / (2 * t)];
  }
  // Left half: |Im| is the well-conditioned root, the real part comes
  // back through y = 2ab (kept non-negative — principal), and the sign
  // of the answer rides on y alone.
  const v = Math.sqrt((abs(z) - x) / 2);
  return [Math.abs(y) / (2 * v), y < 0 ? -v : v];
}

/** Integer powers are repeated `mul`, done by squaring (so `pow(z, 0)` is
 * `[1, 0]` even at the origin, and `pow(z, −n)` is the reciprocal of the
 * positive power). */
function powInt(z: Vec, n: number): Vec {
  let e = Math.abs(n);
  let base: Vec = z;
  let acc: Vec = [1, 0];
  while (e > 0) {
    if (e % 2 === 1) acc = mul(acc, base);
    base = mul(base, base);
    e = Math.floor(e / 2);
  }
  return n < 0 ? div([1, 0], acc) : acc;
}

/** `z^w`: an integer `w` is repeated `mul`; anything else is
 * `e^{w log z}` on the principal branch — `w` times `[log|z|, arg z]`,
 * a real `w` spelled `[w, 0]`. */
export function pow(z: XY, w: number | XY): Vec {
  const v: Vec = typeof w === 'number' ? [w, 0] : asXY(w);
  if (v[1] === 0 && Number.isInteger(v[0])) return powInt(asXY(z), v[0]);
  const l: Vec = [Math.log(abs(z)), arg(z)];
  return exp(mul(v, l));
}

/**
 * Complex arithmetic as one namespace over `[x, y]` pairs: `mul`, `div`,
 * `exp`, `pow`, `sqrt` — plus `add`, `sub`, `abs` and `arg`, which are
 * `vec`'s own functions under complex names, because the operation is the
 * same one. Every answer is a fresh pair. Pure.
 */
export const complex = {
  add,
  sub,
  mul,
  div,
  /** `x − yi`: the reflection in the real axis. */
  conj: (z: XY): Vec => [vx(z), -vy(z)],
  abs,
  arg,
  exp,
  /** `log|z| + i arg z` — the principal branch, `arg` in (−π, π]. */
  log: (z: XY): Vec => [Math.log(abs(z)), arg(z)],
  pow,
  sqrt,
  /** `r e^{iθ}`: the radius and angle become the pair. */
  polar: (r: number, theta: number): Vec => [r * Math.cos(theta), r * Math.sin(theta)],
  /** The pair as `[|z|, arg z]`, the inverse of `polar` (the angle comes
   * back wrapped into (−π, π]). */
  toPolar: (z: XY): Vec => [abs(z), arg(z)],
};
