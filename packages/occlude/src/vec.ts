/**
 * Points and vectors: the arithmetic the material vocabulary is written in.
 * `XY` in (either spelling), `Vec` out (a fresh tuple). Pure; no other
 * module of the package is needed here, so anything may import it.
 */

// ---- points and vectors ---------------------------------------------------------

/** A point or vector in either spelling. A plain `number[]` is accepted
 * too, because a bare `[a, b]` returned from an untyped arrow is inferred
 * as `number[]` and a sketch should not have to annotate its forces. */
export type XY = readonly [number, number] | readonly number[] | { x: number; y: number };

export type Vec = [number, number];

// Array.isArray does not narrow readonly arrays; a guard does.
/** @internal */
export const isArr = (p: XY): p is readonly number[] => Array.isArray(p);
/** @internal */
export const vx = (p: XY): number => (isArr(p) ? p[0] : p.x);
/** @internal */
export const vy = (p: XY): number => (isArr(p) ? p[1] : p.y);
/** @internal */
export const asXY = (p: XY): [number, number] => [vx(p), vy(p)];

// Vectors are tuples; inputs accept either spelling so a vertex view goes
// straight into `sub(q, p)`; results are ALWAYS fresh tuples — nothing
// mutates an argument or shares scratch storage. `unit` of a zero-length
// vector is the zero vector, so coincident points contribute no direction
// (and no NaN). `mul` is scalar multiplication only.

export function add(a: XY, b: XY): Vec {
  return [vx(a) + vx(b), vy(a) + vy(b)];
}

/** `a - b`: the vector from `b` to `a`. */
export function sub(a: XY, b: XY): Vec {
  return [vx(a) - vx(b), vy(a) - vy(b)];
}

/** Scalar multiplication only: `v` scaled by the number `k`. */
export function mul(v: XY, k: number): Vec {
  return [vx(v) * k, vy(v) * k];
}

export function length(v: XY): number {
  const x = vx(v);
  const y = vy(v);
  return Math.sqrt(x * x + y * y);
}

export function distance(a: XY, b: XY): number {
  return length(sub(a, b));
}

/** `v / |v|`, or `[0, 0]` when `|v|` is zero. */
export function unit(v: XY): Vec {
  const d = length(v);
  return d > 0 ? [vx(v) / d, vy(v) / d] : [0, 0];
}

/** `v` shortened to `max` if it is longer; unchanged otherwise. */
export function limit(v: XY, max: number): Vec {
  const d = length(v);
  return d > max && d > 0 ? [(vx(v) / d) * max, (vy(v) / d) * max] : [vx(v), vy(v)];
}

/** `v` turned a quarter turn counter-clockwise (y down: visually clockwise). */
export function perp(v: XY): Vec {
  return [-vy(v), vx(v)];
}

/** Dot product `a · b`: zero when the two are perpendicular or either is the zero vector. */
export function dot(a: XY, b: XY): number {
  return vx(a) * vx(b) + vy(a) * vy(b);
}

/** Signed 2D cross product `a × b = ax·by − ay·bx`. Positive when `b` lies
 * on the side of `a` that `perp(a)` points to (a quarter turn from +x
 * toward +y, which is clockwise as drawn, since y grows downward), negative
 * on the other side, zero when the two are parallel or either is the zero
 * vector. `Math.sign(cross(heading, toward))` is the side test. */
export function cross(a: XY, b: XY): number {
  return vx(a) * vy(b) - vy(a) * vx(b);
}

/** The unit vector at `angle` radians, `[cos, sin]`: angles here are
 * radians from +x toward +y, the same convention `angleOf` reads. */
export function fromAngle(angle: number): Vec {
  return [Math.cos(angle), Math.sin(angle)];
}

/** The angle of `v` in radians, from +x toward +y (`Math.atan2(y, x)`),
 * in (−π, π]; the zero vector gives 0. */
export function angleOf(v: XY): number {
  return Math.atan2(vy(v), vx(v));
}

/** Component-wise sum of any number of vectors, left to right. */
export function sum(...vs: readonly XY[]): Vec {
  let x = 0;
  let y = 0;
  for (const v of vs) {
    x += vx(v);
    y += vy(v);
  }
  return [x, y];
}

/** `sum(items.map(fn))` without the intermediate array, accumulated in order. */
export function sumBy<T>(items: Iterable<T>, fn: (item: T, index: number) => XY): Vec {
  let x = 0;
  let y = 0;
  let i = 0;
  for (const item of items) {
    const v = fn(item, i++);
    x += vx(v);
    y += vy(v);
  }
  return [x, y];
}
