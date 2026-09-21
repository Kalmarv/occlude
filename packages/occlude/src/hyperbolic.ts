/**
 * The isometries of the Poincaré disk — an INTERNAL module.
 *
 * Nothing here is part of the public surface. The sketch draws in a
 * geometry by naming it on the frame (`space: 'hyperbolic'`), and every
 * word it then writes — `line`, `circle`, `t.tiling`, `t.distanceTo`,
 * `t.scatter` — reads that frame. This file is what those words are made
 * of: the disk's transform as DATA, and the disk's circle.
 *
 * Every word here works in MODEL coordinates: the unit disk about the
 * origin, where the rim `|z| = 1` is infinitely far away. `space.ts`
 * scales that disk onto the drawable, and `tiling.ts` floods it.
 *
 * A point of the disk is a complex number, and every isometry of the disk
 * is `z ↦ (a·z + b)/(c·z + d)` on `z` or on its conjugate. So the
 * transform is four complex numbers and a mirror flag, which `apply`,
 * `compose` and `inverse` read.
 */

import { vx, vy, type Vec, type XY } from './vec.js';

/** A complex number as `[re, im]` — which is also how a point of the disk
 * is spelled, because in the disk they are the same thing. */
export type Complex = readonly [number, number];

export interface CircleOpts {
  /** Points around the loop. */
  count?: number;
}

/**
 * An isometry of the Poincaré disk, as a record.
 *
 * The four coefficients read `z ↦ (a·z + b)/(c·z + d)`, normalised so that
 * `a·d − b·c = 1` and `d = conj(a)`, `c = conj(b)` — the condition that
 * makes the map send the disk to itself. `mirror` marks the half of the
 * isometries that turn the disk over: the map then reads the CONJUGATE of
 * `z` first, `z ↦ (a·z̄ + b)/(c·z̄ + d)`. `reflection` is the maker that
 * sets it; `translation` and `rotation` leave it false.
 */
export interface Mobius {
  readonly a: Complex;
  readonly b: Complex;
  readonly c: Complex;
  readonly d: Complex;
  /** True where the map reads `z̄` for `z`: a reflection, or any odd
   * number of them composed. */
  readonly mirror: boolean;
}

// ---- complex arithmetic (module-private) ---------------------------------

const cAdd = (u: Complex, v: Complex): Complex => [u[0] + v[0], u[1] + v[1]];
const cSub = (u: Complex, v: Complex): Complex => [u[0] - v[0], u[1] - v[1]];
const cMul = (u: Complex, v: Complex): Complex => [u[0] * v[0] - u[1] * v[1], u[0] * v[1] + u[1] * v[0]];
const cScale = (u: Complex, k: number): Complex => [u[0] * k, u[1] * k];
const cConj = (u: Complex): Complex => [u[0], -u[1]];
const cAbs2 = (u: Complex): number => u[0] * u[0] + u[1] * u[1];
const cAbs = (u: Complex): number => Math.hypot(u[0], u[1]);
const cDiv = (u: Complex, v: Complex): Complex => {
  const q = cAbs2(v);
  return [(u[0] * v[0] + u[1] * v[1]) / q, (u[1] * v[0] - u[0] * v[1]) / q];
};
const cExp = (theta: number): Complex => [Math.cos(theta), Math.sin(theta)];
const ZERO: Complex = [0, 0];
const ONE: Complex = [1, 0];

/** A record from coefficients already known to be normalised. */
const make = (a: Complex, b: Complex, c: Complex, d: Complex, mirror: boolean): Mobius => ({ a, b, c, d, mirror });

const asComplex = (p: XY): Complex => [vx(p), vy(p)];

// ---- the transform as data -----------------------------------------------

/** One point through one transform. `[x, y]` or `{x, y}` in, a fresh pair
 * out — the point atom rule, the same as the rest of the library. */
export function apply(m: Mobius, p: XY): Vec {
  const z = m.mirror ? cConj(asComplex(p)) : asComplex(p);
  const out = cDiv(cAdd(cMul(m.a, z), m.b), cAdd(cMul(m.c, z), m.d));
  return [out[0], out[1]];
}

/** `m1` after `m2`: the transform that does `m2` first, as `f(g(z))` reads
 * and as the matrix product multiplies. */
export function compose(m1: Mobius, m2: Mobius): Mobius {
  // A mirror in front of `m2` conjugates its coefficients:
  // `conj(M(w)) = M̄(conj(w))`, which is how the two flags add up.
  const [a2, b2, c2, d2] = m1.mirror
    ? [cConj(m2.a), cConj(m2.b), cConj(m2.c), cConj(m2.d)]
    : [m2.a, m2.b, m2.c, m2.d];
  return make(
    cAdd(cMul(m1.a, a2), cMul(m1.b, c2)),
    cAdd(cMul(m1.a, b2), cMul(m1.b, d2)),
    cAdd(cMul(m1.c, a2), cMul(m1.d, c2)),
    cAdd(cMul(m1.c, b2), cMul(m1.d, d2)),
    m1.mirror !== m2.mirror,
  );
}

/** The transform that undoes this one. */
export function inverse(m: Mobius): Mobius {
  // The determinant is 1, so the inverse matrix is (d, −b; −c, a). A
  // mirror is its own inverse, and it comes out in front, which conjugates
  // what is left.
  const [a, b, c, d] = [m.d, cScale(m.b, -1), cScale(m.c, -1), m.a];
  return m.mirror ? make(cConj(a), cConj(b), cConj(c), cConj(d), true) : make(a, b, c, d, false);
}

/**
 * The hyperbolic translation that carries the origin to `[dx, dy]`.
 *
 * It slides the whole disk along the geodesic through the origin and that
 * point. A point outside the disk is not somewhere the disk can go, and
 * refuses by name.
 */
export function translation(dx: number, dy: number): Mobius {
  const w: Complex = [dx, dy];
  const q = cAbs2(w);
  if (!(q < 1)) throw new Error(`translation: [${dx}, ${dy}] is not inside the unit disk (its distance from the origin is ${Math.sqrt(q)})`);
  const k = 1 / Math.sqrt(1 - q);
  return make([k, 0], cScale(w, k), cScale(cConj(w), k), [k, 0], false);
}

/** The turn about the origin, in degrees, counter-clockwise. In the disk a
 * turn about the origin is also the Euclidean turn about the origin. */
export function rotation(degrees: number): Mobius {
  const half = (degrees * Math.PI) / 360;
  return make(cExp(half), ZERO, ZERO, cExp(-half), false);
}

/**
 * The reflection in the geodesic through two points.
 *
 * It turns the disk over, so the record it answers with has `mirror` set.
 * Two distinct points are needed; the same point twice names no line and
 * refuses by name.
 */
export function reflection(a: XY, b: XY): Mobius {
  const A = asComplex(a);
  const B = asComplex(b);
  if (cAbs(cSub(A, B)) < 1e-15) throw new Error('reflection: the two points are the same — a geodesic needs two distinct points');
  const centre = orthogonalCentre(A, B);
  if (!centre) {
    // The geodesic is a diameter: the reflection is the Euclidean one,
    // `z ↦ e^{2iφ}·z̄`, in the line through the origin at angle φ.
    const phi = Math.atan2(B[1] - A[1], B[0] - A[0]);
    return make(cExp(phi), ZERO, ZERO, cExp(-phi), true);
  }
  // Inversion in the circle `(centre, r)` is `z ↦ (C·z̄ − 1)/(z̄ − conj(C))`,
  // using `|C|² = r² + 1` — the orthogonality condition — to clear the
  // constant. Divided by `i·r` it is in the normalised disk form.
  const r = Math.sqrt(cAbs2(centre) - 1);
  const ir: Complex = [0, r];
  return make(cDiv(centre, ir), cDiv([-1, 0], ir), cDiv(ONE, ir), cDiv(cScale(cConj(centre), -1), ir), true);
}

// ---- the geometry --------------------------------------------------------

/** The centre of the circle through `A` and `B` that meets the unit circle
 * at right angles, or null when the three are in a line and the geodesic is
 * a diameter. `|centre|² = r² + 1` is the orthogonality condition, and
 * `2·centre·P = |P|² + 1` puts a point `P` on the circle. */
function orthogonalCentre(A: Complex, B: Complex): Complex | null {
  const det = 2 * (A[0] * B[1] - A[1] * B[0]);
  if (Math.abs(det) < 1e-12) return null;
  const ka = cAbs2(A) + 1;
  const kb = cAbs2(B) + 1;
  const centre: Complex = [(ka * B[1] - kb * A[1]) / det, (kb * A[0] - ka * B[0]) / det];
  if (!Number.isFinite(centre[0]) || !Number.isFinite(centre[1]) || cAbs2(centre) <= 1) return null;
  return centre;
}

/**
 * The hyperbolic circle of hyperbolic radius `r` about `center`, as a
 * closed loop of `count` points.
 *
 * It is a Euclidean circle too — but not about `center`. The hyperbolic
 * centre sits nearer the rim than the Euclidean one, and the further out
 * it is, the further the two drift apart. A radius at or below zero is a
 * point, and draws nothing.
 */
export function circle(center: XY, r: number, opts: CircleOpts = {}): Vec[] {
  if (!Number.isFinite(r) || r <= 0) return [];
  const n = opts.count === undefined ? 64 : Math.floor(opts.count);
  if (!(n >= 3)) return [];
  const frame = translation(vx(center), vy(center));
  const rho = Math.tanh(r / 2);
  const out: Vec[] = [];
  for (let k = 0; k < n; k++) {
    const th = (2 * Math.PI * k) / n;
    out.push(apply(frame, [rho * Math.cos(th), rho * Math.sin(th)]));
  }
  return out;
}

/**
 * The signed hyperbolic distance to the geodesic through `a` and `b`,
 * positive on the LEFT of `a → b`, in the unit disk's own metric
 * (`ds = 2|dz|/(1 − |z|²)`). `space.ts` scales it onto the drawable.
 *
 * The formula. Carry the geodesic onto the real diameter with the frame
 * `alongFrame` builds. There the distance from `w` to the diameter is
 * `asinh(2·Im w / (1 − |w|²))`: the nearest point of the diameter to
 * `w = i·h` is the origin, whose distance is `2·artanh(h)`, and with
 * `t = artanh h` the double-angle rule gives
 * `sinh(2t) = 2·sinh(t)·cosh(t) = 2h/(1 − h²)`, which is the formula at
 * `Re w = 0`. Every other point of the disk reaches that position under a
 * slide along the diameter, and a slide changes neither side of the
 * equality. The sign follows `Im w`, and `+y` is the left of `+x`.
 *
 * The frame is a slide and a turn, never a fold, so the eight coefficients
 * are all a sample needs; they are read out once, because the field is
 * read once per raster cell per edge.
 */
export function halfplane(a: XY, b: XY): (x: number, y: number) => number {
  const A = asComplex(a);
  const B = asComplex(b);
  if (cAbs(cSub(A, B)) < 1e-15) throw new Error('halfplane: the two points are the same — a geodesic needs two distinct points');
  const home = inverse(translation(A[0], A[1]));
  const aim = apply(home, B);
  const m = compose(rotation((-Math.atan2(aim[1], aim[0]) * 180) / Math.PI), home);
  const [a0, a1] = m.a;
  const [b0, b1] = m.b;
  const [c0, c1] = m.c;
  const [d0, d1] = m.d;
  return (x, y) => {
    const nr = a0 * x - a1 * y + b0;
    const ni = a0 * y + a1 * x + b1;
    const dr = c0 * x - c1 * y + d0;
    const di = c0 * y + c1 * x + d1;
    const q = dr * dr + di * di;
    const wx = (nr * dr + ni * di) / q;
    const wy = (ni * dr - nr * di) / q;
    return Math.asinh((2 * wy) / (1 - wx * wx - wy * wy));
  };
}
