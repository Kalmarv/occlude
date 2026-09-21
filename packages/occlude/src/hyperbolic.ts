/**
 * The hyperbolic plane, in the Poincaré disk.
 *
 * Every word here works in MODEL coordinates: the unit disk about the
 * origin, where the rim `|z| = 1` is infinitely far away. Nothing here
 * reads the seed or the paper, so the whole namespace is a module import,
 * the way `sdf` is. A sketch puts the disk on the sheet with the
 * transforms it already has — `group(…, { translate, scale })`, or a map
 * over the material's own points.
 *
 * A point of the disk is a complex number, and every isometry of the disk
 * is `z ↦ (a·z + b)/(c·z + d)` on `z` or on its conjugate. So the transform
 * is DATA: four complex numbers and a mirror flag, which `apply`,
 * `compose` and `inverse` read. The geometry is the noun — `geodesic`,
 * `circle`, `polygon`, `tiling` — and the verbs are generic.
 *
 * The metric does not yet reach the library's spacing words: a hatch or a
 * scatter over mapped material is spaced on the SHEET, not in the disk.
 */

import { finiteCount } from './guard.js';
import { vx, vy, type Vec, type XY } from './vec.js';

/** A complex number as `[re, im]` — which is also how a point of the disk
 * is spelled, because in the disk they are the same thing. */
export type Complex = readonly [number, number];

/**
 * An isometry of the Poincaré disk, as a record.
 *
 * The four coefficients read `z ↦ (a·z + b)/(c·z + d)`, normalised so that
 * `a·d − b·c = 1` and `d = conj(a)`, `c = conj(b)` — the condition that
 * makes the map send the disk to itself. `mirror` marks the half of the
 * isometries that turn the disk over: the map then reads the CONJUGATE of
 * `z` first, `z ↦ (a·z̄ + b)/(c·z̄ + d)`. `reflection` is the maker that
 * sets it; `mobius`, `translation` and `rotation` leave it false.
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

export interface GeodesicOpts {
  /** Pieces along the arc; the result has `count + 1` points. The default
   * 24 holds any geodesic of the disk within about 0.002 model units of
   * the true arc. */
  count?: number;
}

export interface CircleOpts {
  /** Points around the loop. */
  count?: number;
}

export interface TilingOpts {
  /** Generations of neighbours to reflect out to. Depth 0 is the
   * fundamental polygon alone; depth 1 adds its `p` edge neighbours. */
  depth?: number;
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
/** The square root with non-negative real part; on the negative real axis,
 * the one with positive imaginary part. Either root would do — a Möbius
 * record and its negation are the same map — but one of them has to be
 * chosen, and choosing it by a rule keeps the answer reproducible. */
const cSqrt = (u: Complex): Complex => {
  const r = cAbs(u);
  if (r === 0) return [0, 0];
  const re = Math.sqrt((r + u[0]) / 2);
  const im = Math.sqrt((r - u[0]) / 2) * (u[1] < 0 ? -1 : 1);
  return re > 0 ? [re, im] : [0, Math.abs(im)];
};
const cExp = (theta: number): Complex => [Math.cos(theta), Math.sin(theta)];
const ZERO: Complex = [0, 0];
const ONE: Complex = [1, 0];

/** The disk condition, to the tolerance every check here uses. */
const TOL = 1e-9;

/** A record from coefficients already known to be normalised. */
const make = (a: Complex, b: Complex, c: Complex, d: Complex, mirror: boolean): Mobius => ({ a, b, c, d, mirror });

const asComplex = (p: XY): Complex => [vx(p), vy(p)];

// ---- the transform as data -----------------------------------------------

/**
 * A Möbius transform of the disk from four complex coefficients,
 * `z ↦ (a·z + b)/(c·z + d)`, each written `[re, im]`.
 *
 * The four are normalised: they are divided by a square root of
 * `a·d − b·c`, which leaves the map alone and puts the record in one
 * spelling. A quadruple that does not send the disk to itself is a
 * mistake, and refuses by name — a disk transform reads
 * `(a, b, conj(b), conj(a))` up to a common factor. `translation`,
 * `rotation` and `reflection` are the makers you normally want; this one
 * is for a transform worked out somewhere else.
 */
export function mobius(a: Complex, b: Complex, c: Complex, d: Complex): Mobius {
  const det = cSub(cMul(a, d), cMul(b, c));
  if (!(cAbs(det) > 0) || !Number.isFinite(cAbs(det))) {
    throw new Error(`mobius: (a, b, c, d) is degenerate — a·d − b·c is ${cAbs(det)}, so the transform has no inverse`);
  }
  const s = cSqrt(det);
  let A = cDiv(a, s);
  let B = cDiv(b, s);
  let C = cDiv(c, s);
  let D = cDiv(d, s);
  const scale = Math.max(1, cAbs(A), cAbs(B));
  const fits = (): boolean => cAbs(cSub(D, cConj(A))) <= TOL * scale && cAbs(cSub(C, cConj(B))) <= TOL * scale;
  if (!fits()) {
    // `M` and `−M` are the same map, and only one of the two is in the
    // form that shows the disk condition.
    [A, B, C, D] = [cScale(A, -1), cScale(B, -1), cScale(C, -1), cScale(D, -1)];
    if (!fits()) {
      throw new Error('mobius: (a, b, c, d) does not send the unit disk to itself — a disk transform is (a, b, conj(b), conj(a)) up to a common factor');
    }
  }
  return make(A, B, C, D, false);
}

/** One point through one transform. `[x, y]` or `{x, y}` in, a fresh pair
 * out — the point atom rule, the same as the rest of the library. */
export function apply(m: Mobius, p: XY): Vec {
  const z = m.mirror ? cConj(asComplex(p)) : asComplex(p);
  const out = cDiv(cAdd(cMul(m.a, z), m.b), cAdd(cMul(m.c, z), m.d));
  return [out[0], out[1]];
}

/**
 * One transform as a point map, ready for `m.map` or any other consumer of
 * a `(XY) => Vec`.
 *
 * A map moves VERTICES. A straight edge between two mapped vertices stays
 * straight, and in the disk a straight edge is wrong everywhere but at its
 * ends — so a motif that must bend is resampled first
 * (`m.resample({ spacing })`), or built out of `geodesic` arcs.
 */
export function map(m: Mobius): (p: XY) => Vec {
  return (p) => apply(m, p);
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

// ---- measurement ---------------------------------------------------------

/**
 * The hyperbolic distance between two points of the disk.
 *
 * `2·artanh|(a − b) / (1 − conj(a)·b)|`. It grows without bound towards the
 * rim: two points a hair apart near `|z| = 1` are a long way apart in the
 * plane the disk is a picture of.
 */
export function distance(a: XY, b: XY): number {
  const A = asComplex(a);
  const B = asComplex(b);
  const t = cAbs(cDiv(cSub(A, B), cSub(ONE, cMul(cConj(A), B))));
  return 2 * Math.atanh(t);
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
 * The geodesic segment from `a` to `b`, as points.
 *
 * A straight line of the hyperbolic plane is an arc of the circle that
 * meets the rim at right angles, or a diameter where the two points and the
 * origin are in one line. The result is `count + 1` points along it, the
 * first exactly `a` and the last exactly `b`, ready for `connect.chain` or
 * `stroke`.
 */
export function geodesic(a: XY, b: XY, opts: GeodesicOpts = {}): Vec[] {
  const A = asComplex(a);
  const B = asComplex(b);
  const n = opts.count === undefined ? 24 : finiteCount('geodesic', opts.count);
  if (n < 1) return [];
  if (cAbs(cSub(A, B)) < 1e-15) return [[A[0], A[1]], [B[0], B[1]]];
  const out: Vec[] = [];
  const centre = orthogonalCentre(A, B);
  if (!centre) {
    for (let k = 0; k <= n; k++) {
      const u = k / n;
      out.push([A[0] + (B[0] - A[0]) * u, A[1] + (B[1] - A[1]) * u]);
    }
  } else {
    const r = Math.sqrt(cAbs2(centre) - 1);
    const t0 = Math.atan2(A[1] - centre[1], A[0] - centre[0]);
    const t1 = Math.atan2(B[1] - centre[1], B[0] - centre[0]);
    // The short way round: the arc inside the disk is the one under a half
    // turn, because both ends are inside and the circle cuts the rim.
    let span = t1 - t0;
    while (span > Math.PI) span -= 2 * Math.PI;
    while (span <= -Math.PI) span += 2 * Math.PI;
    for (let k = 0; k <= n; k++) {
      const th = t0 + (span * k) / n;
      out.push([centre[0] + r * Math.cos(th), centre[1] + r * Math.sin(th)]);
    }
  }
  // The ends are the points asked for, not the ends of a sampling.
  out[0] = [A[0], A[1]];
  out[n] = [B[0], B[1]];
  return out;
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
  const n = opts.count === undefined ? 64 : finiteCount('circle', opts.count);
  if (n < 3) return [];
  const frame = translation(vx(center), vy(center));
  const rho = Math.tanh(r / 2);
  const out: Vec[] = [];
  for (let k = 0; k < n; k++) {
    const th = (2 * Math.PI * k) / n;
    out.push(apply(frame, [rho * Math.cos(th), rho * Math.sin(th)]));
  }
  return out;
}

/** `(p − 2)(q − 2) > 4` is what makes `{p, q}` hyperbolic: at 4 it is the
 * Euclidean plane, below it the sphere. */
function checkPQ(who: string, p: number, q: number): void {
  if (!Number.isInteger(p) || !Number.isInteger(q) || p < 3 || q < 3) {
    throw new Error(`${who}: p and q are whole numbers of 3 or more (got ${p}, ${q})`);
  }
  if ((p - 2) * (q - 2) <= 4) {
    throw new Error(`${who}: {${p}, ${q}} is not a hyperbolic tiling — (p − 2)(q − 2) must be more than 4, and it is ${(p - 2) * (q - 2)}`);
  }
}

/**
 * The fundamental polygon of the `{p, q}` tiling: `p` sides, `q` of them
 * meeting at every vertex, centred on the origin with one vertex on the
 * positive x axis.
 *
 * The result is the `p` vertices, in order. Its edges are GEODESICS, so a
 * sketch that wants them drawn as they really run takes each pair to
 * `geodesic`; joined up straight they are the chords, which is a different
 * picture. `(p − 2)(q − 2)` must be more than 4, and a Euclidean or
 * spherical pair refuses by name.
 */
export function polygon(p: number, q: number): Vec[] {
  checkPQ('polygon', p, q);
  // Half the polygon is `2p` right triangles with angles π/p, π/q, π/2;
  // `cosh R = cot(π/p)·cot(π/q)` is the circumradius, and `tanh(R/2)` is
  // where that lands in the disk. Written as one square root, that is
  // `√(cos(π/p + π/q) / cos(π/p − π/q))`.
  const u = Math.PI / p;
  const v = Math.PI / q;
  const R = Math.sqrt(Math.cos(u + v) / Math.cos(u - v));
  return Array.from({ length: p }, (_, k) => {
    const th = (2 * Math.PI * k) / p;
    return [R * Math.cos(th), R * Math.sin(th)] as Vec;
  });
}

/** A tile is named by where it sends the origin; the grid is coarse enough
 * that two tiles never share a bucket and fine enough to stay cheap. */
const BUCKET = 1e-6;
const bucketKey = (x: number, y: number): string => `${Math.round(x / BUCKET)},${Math.round(y / BUCKET)}`;

/**
 * The `{p, q}` tiling as PLACEMENTS: one transform per copy of the
 * fundamental polygon, the identity first.
 *
 * The copies are found by reflecting the fundamental polygon across its own
 * edges, then reflecting the results across theirs, out to `depth`
 * generations — so `depth` is a stated count of generations, not a cap.
 * Depth 1 is the polygon and its `p` edge neighbours. The copies at ODD
 * generations turn the disk over, because a reflection does; a motif with
 * a hand to it comes out left-handed in those.
 *
 * The sketch draws the motif ONCE, inside `polygon(p, q)`, and hands every
 * record to `map`. Two records that put the polygon in the same place are
 * one record.
 */
export function tiling(p: number, q: number, opts: TilingOpts = {}): Mobius[] {
  checkPQ('tiling', p, q);
  const depth = opts.depth === undefined ? 3 : Math.floor(opts.depth);
  if (!Number.isFinite(depth) || depth < 0) return [];
  const verts = polygon(p, q);
  const mirrors = verts.map((v, i) => reflection(v, verts[(i + 1) % p]));
  // The identity: `rotation(0)`, which is the transform that stays put.
  const out: Mobius[] = [rotation(0)];
  // Where each accepted transform puts the origin, bucketed: that point
  // names the tile, and one tile takes one placement.
  const seen = new Map<string, Vec[]>();
  const place = (m: Mobius): boolean => {
    const o = apply(m, [0, 0]);
    if (!Number.isFinite(o[0]) || !Number.isFinite(o[1])) return false;
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const near = seen.get(bucketKey(o[0] + i * BUCKET, o[1] + j * BUCKET));
        if (near && near.some((c) => Math.hypot(c[0] - o[0], c[1] - o[1]) < TOL)) return false;
      }
    }
    const key = bucketKey(o[0], o[1]);
    const cell = seen.get(key);
    if (cell) cell.push(o);
    else seen.set(key, [o]);
    return true;
  };
  place(out[0]);
  let frontier = out.slice();
  for (let g = 0; g < depth; g++) {
    const next: Mobius[] = [];
    for (const m of frontier) {
      for (const r of mirrors) {
        const candidate = compose(m, r);
        if (!place(candidate)) continue;
        next.push(candidate);
        out.push(candidate);
        // A depth nobody meant to ask for stops here, by name.
        finiteCount('tiling', out.length);
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }
  return out;
}

/**
 * The hyperbolic plane in the Poincaré disk: its transforms as data, its
 * lines, its circles and its tilings. Pure — no seed and no paper — so it
 * is a module import, as `sdf` is.
 *
 * Everything is in model coordinates, the unit disk about the origin. The
 * sketch puts the disk where it wants it.
 */
export const hyperbolic = {
  mobius,
  translation,
  rotation,
  reflection,
  apply,
  map,
  compose,
  inverse,
  distance,
  geodesic,
  circle,
  polygon,
  tiling,
};
