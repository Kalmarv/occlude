/**
 * ONE isometry value, for every door that used to keep its own.
 *
 * A drawing tree carried affine `TransformOp`s, the disk carried Möbius
 * records, a tiling carried three private motion types, and a station
 * carried a point and a heading. None of the four could meet: a tiling's
 * placement could not be inverted, a station's frame could not be pushed
 * onto a drawing, and a curved motif could not be placed at all. A
 * `Placement` is the one value all of them speak.
 *
 * THE MODEL IS THE WHOLE TRICK. Each geometry has a model in `R³` where an
 * isometry is a plain 3×3 matrix: the hyperboloid below zero curvature, the
 * unit sphere above it, and homogeneous coordinates `[x, y, 1]` on the flat
 * plane. The model carries its own product,
 *
 *     form(u, v) = u0·v0 + u1·v1 + sign·u2·v2,
 *
 * with `sign` −1 (Minkowski), +1 (the ordinary dot) or 0 (the plane, whose
 * third coordinate is not a length at all). A `ModelDoor` is how a sketch
 * point becomes a model vector and back, plus the orthonormal tangent frame
 * at a point; `space.ts` builds one per space.
 *
 * Everything else is then arithmetic that does not know which geometry it
 * is in: `point` is `down(M·up(p))`, composition is the matrix product,
 * `inverse` is the matrix inverse, a reflection is a Householder in the
 * model's own product, and the isometry carrying one frame to another is
 * one product of two frame matrices.
 *
 * Pure: no paper, no seed, no shape lowering. The toolkit hands it a door.
 */

import type { SpaceKind } from './space.js';
import { walked, type Station } from './material.js';
import { vx, vy, type Vec, type XY } from './vec.js';

/**
 * A point of the model a geometry is cheapest in, `[x, y, w]` with the
 * third coordinate last: the hyperboloid `x² + y² − w² = −1` below zero
 * curvature, the unit sphere `x² + y² + w² = 1` above it, and `[x, y, 1]`
 * on the flat plane.
 */
export type Model = readonly [number, number, number];

/**
 * The model door of a space: how a sketch point becomes a model vector and
 * back, the model's own product (through `sign`), and the local frame.
 */
export interface ModelDoor {
  readonly kind: SpaceKind;
  /** The metric signature of the model's third coordinate: −1 below zero
   * (Minkowski), +1 on the sphere, 0 on the plane (homogeneous). */
  readonly sign: -1 | 0 | 1;
  /**
   * What makes two doors THE SAME door when they are not the same object:
   * the kind, the signature, and the numbers that place the model — the
   * centre and the curvature length of a space's own door. Compared as a
   * string, because that is the whole of the comparison and a record of
   * closures cannot be compared any other way.
   */
  readonly id: string;
  /** Sketch coordinates → the model. */
  up(p: XY): Model;
  /** The model → sketch coordinates. */
  down(n: Model): Vec;
  /** The orthonormal tangent frame at a sketch point, in the model. */
  frameAt(p: XY): [Model, Model];
  /**
   * The bow, in the space's metric and in sketch units, a stored chord of
   * a geodesic may keep in this door's sketch (`geodesicBowOf`). A
   * placement keeps every metric distance, so a moved chord judged to it
   * stays within the ink's tolerance wherever it lands. The toolkit
   * computes it when it resolves the sketch's space, with the paper in
   * hand. Absent on the plane, whose moves are exact, and on a space
   * built with no paper (`spaceOf`).
   */
  readonly bow?: number;
}

/**
 * An isometry of one geometry, as a value: apply it to a point, to a
 * station, or to a whole drawing through `group(placement, …)`; compose it
 * with `then`; turn it round with `inverse`.
 *
 * `orientation` is −1 when the isometry turns the plane over — an odd
 * number of reflections — and +1 when it does not. A motif with a hand to
 * it comes out left-handed in the first case.
 */
export interface Placement {
  readonly door: ModelDoor;
  readonly orientation: 1 | -1;
  /** The 3×3 on model vectors, row-major. Internal: the value a sketch
   * holds is the four verbs, not these nine numbers. */
  readonly m: readonly number[];
  /** Where this isometry sends a sketch point. */
  point(p: XY): Vec;
  /** Where it sends a station: the point, and the heading carried to it. */
  station(s: Station): Station;
  /** Apply this, then `next`. */
  then(next: Placement): Placement;
  /** The isometry that undoes this one. */
  inverse(): Placement;
}

// ---- the 3×3, row-major ----------------------------------------------------

const ID9: readonly number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function mul9(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return out;
}

function act(m: readonly number[], v: Model): Model {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

function det9(m: readonly number[]): number {
  return (
    m[0] * (m[4] * m[8] - m[5] * m[7])
    - m[1] * (m[3] * m[8] - m[5] * m[6])
    + m[2] * (m[3] * m[7] - m[4] * m[6])
  );
}

function inv9(m: readonly number[]): number[] {
  const d = det9(m);
  // A singular 3×3 is not an isometry of anything; the caller built it, so
  // it is a mistake and it says so.
  if (!(Math.abs(d) > 0)) throw new Error('placement.inverse: this placement is degenerate and has no inverse');
  const c = [
    m[4] * m[8] - m[5] * m[7], m[2] * m[7] - m[1] * m[8], m[1] * m[5] - m[2] * m[4],
    m[5] * m[6] - m[3] * m[8], m[0] * m[8] - m[2] * m[6], m[2] * m[3] - m[0] * m[5],
    m[3] * m[7] - m[4] * m[6], m[1] * m[6] - m[0] * m[7], m[0] * m[4] - m[1] * m[3],
  ];
  return c.map((v) => v / d);
}

/** The model's own product, `u0·v0 + u1·v1 + sign·u2·v2`. On the plane the
 * third coordinate weighs nothing, which is exactly the plain dot of two
 * tangent vectors there. */
function form(sign: -1 | 0 | 1, u: Model, v: Model): number {
  return u[0] * v[0] + u[1] * v[1] + sign * u[2] * v[2];
}

const cross = (u: Model, v: Model): Model => [
  u[1] * v[2] - u[2] * v[1],
  u[2] * v[0] - u[0] * v[2],
  u[0] * v[1] - u[1] * v[0],
];

// ---- the value -------------------------------------------------------------

const here = (p: XY): string => `[${vx(p)}, ${vy(p)}]`;

/**
 * WHY `orientation` IS THE SIGN OF THE DETERMINANT, in every model.
 *
 * Write the frame field as the 3×3 `B(p) = [up(p) | e1 | e2]`. In all four
 * doors that triple is RIGHT-HANDED — check it at the model origin, where
 * it is `[[0,0,1] | [1,0,0] | [0,1,0]]`, whose determinant is +1, and a
 * frame field is smooth and never degenerate, so the sign cannot change.
 * An isometry `M` carries `up(p)` to `up(M p)` and the tangent frame to the
 * tangent frame there, so `M·B(p) = B(Mp)·diag(1, A)` with `A` the 2×2
 * TANGENT action. Taking determinants, `det M · det B(p) = det B(Mp) · det
 * A`, and both determinants are +1, so `det A = det M`. The handedness of
 * the isometry is the sign of the determinant of the 3×3 and nothing else.
 */
function make(door: ModelDoor, m: readonly number[]): Placement {
  const frozen = Object.freeze(m.slice());
  const orientation: 1 | -1 = det9(frozen) < 0 ? -1 : 1;
  const value: Placement = {
    door,
    orientation,
    m: frozen,
    point(p: XY): Vec {
      return door.down(act(frozen, door.up(p)));
    },
    station(s: Station): Station {
      return transport(door, frozen, s);
    },
    then(next: Placement): Placement {
      agree('then', door, next.door);
      // `next` after this: the matrices multiply the other way round.
      return make(door, mul9(next.m, frozen));
    },
    inverse(): Placement {
      return make(door, inv9(frozen));
    },
  };
  return Object.freeze(value);
}

/** Two doors are the same door, or the two placements name two geometries
 * and cannot meet. */
function agree(who: string, a: ModelDoor, b: ModelDoor): void {
  if (a === b || a.id === b.id) return;
  throw new Error(`placement.${who}: a placement of ${b.kind} space cannot follow one of ${a.kind} space`);
}

/** A station says which space it walks in, or says nothing; when it says,
 * the door has to be that space's own. */
function agreeStation(door: ModelDoor, s: Station, who: string): void {
  const home = s.space?.model;
  if (!home || home === door || home.id === door.id) return;
  throw new Error(`placement.${who}: a station of ${home.kind} space cannot be placed by an isometry of ${door.kind} space`);
}

/**
 * A station through an isometry: the point is the point, and the heading is
 * the direction the station's own tangent lands in, read in the frame at
 * the arrival. Every chain field is carried unchanged, and so is `space`.
 *
 * A reflected placement still answers a station whose `normal` is
 * `perp(tangent)`. A station has no handedness of its own, and this is not
 * the place to give it one.
 */
function transport(door: ModelDoor, m: readonly number[], s: Station): Station {
  agreeStation(door, s, 'station');
  const at: XY = [s.x, s.y];
  const q = door.down(act(m, door.up(at)));
  const [E1, E2] = door.frameAt(at);
  const ch = Math.cos(s.heading);
  const sh = Math.sin(s.heading);
  const t: Model = [E1[0] * ch + E2[0] * sh, E1[1] * ch + E2[1] * sh, E1[2] * ch + E2[2] * sh];
  const mt = act(m, t);
  const [f1, f2] = door.frameAt(q);
  return walked(s, vx(q), vy(q), Math.atan2(form(door.sign, mt, f2), form(door.sign, mt, f1)));
}

/** The isometry that moves nothing. */
export function identity(door: ModelDoor): Placement {
  return make(door, ID9);
}

/**
 * The reflection in the geodesic through `a` and `b`.
 *
 * `n = up(a) × up(b)` is the covector of the plane through the origin that
 * carries the geodesic — in all three models, because in all three a
 * geodesic IS the model's intersection with such a plane. Raising its index
 * with the model's own product gives `n♯ = [n0, n1, sign·n2]`, and the
 * mirror is the Householder reflection `v ↦ v − 2·(n·v)/(n·n♯)·n♯`.
 */
export function reflection(door: ModelDoor, a: XY, b: XY): Placement {
  const A = door.up(a);
  const B = door.up(b);
  const n = cross(A, B);
  const sharp: Model = [n[0], n[1], door.sign * n[2]];
  const d = n[0] * sharp[0] + n[1] * sharp[1] + n[2] * sharp[2];
  if (!(Math.hypot(n[0], n[1], n[2]) > 1e-12)) {
    throw new Error(`reflection: ${here(a)} and ${here(b)} are the same place — a mirror needs two distinct points`);
  }
  if (!(Math.abs(d) > 0)) {
    throw new Error(`reflection: ${here(a)} and ${here(b)} name no geodesic of ${door.kind} space`);
  }
  const m = new Array<number>(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) m[r * 3 + c] = (r === c ? 1 : 0) - (2 * sharp[r] * n[c]) / d;
  }
  return make(door, m);
}

/** The frame of a station as a 3×3 whose columns are `e1`, `e2` and the
 * station's own model point. Its determinant is +1 (−1 mirrored), because
 * `[e1 | e2 | P]` is `[P | e1 | e2]` cyclically permuted. */
function basis(door: ModelDoor, s: Station, mirror: boolean): number[] {
  const at: XY = [s.x, s.y];
  const [E1, E2] = door.frameAt(at);
  const ch = Math.cos(s.heading);
  const sh = Math.sin(s.heading);
  const k = mirror ? -1 : 1;
  const e1: Model = [E1[0] * ch + E2[0] * sh, E1[1] * ch + E2[1] * sh, E1[2] * ch + E2[2] * sh];
  const e2: Model = [k * (-E1[0] * sh + E2[0] * ch), k * (-E1[1] * sh + E2[1] * ch), k * (-E1[2] * sh + E2[2] * ch)];
  const P = door.up(at);
  return [
    e1[0], e2[0], P[0],
    e1[1], e2[1], P[1],
    e1[2], e2[2], P[2],
  ];
}

/**
 * The one isometry carrying the frame of `from` onto the frame of `to`:
 * `B(to)·B(from)⁻¹`. `station(from)` of it is `to`, point and heading.
 *
 * With `mirror` the source frame's second column is turned over first, so
 * the answer reverses handedness and still lands the point.
 */
export function between(door: ModelDoor, from: Station, to: Station, opts: { mirror?: boolean } = {}): Placement {
  agreeStation(door, from, 'between');
  agreeStation(door, to, 'between');
  return make(door, mul9(basis(door, to, false), inv9(basis(door, from, opts.mirror === true))));
}

/** Is this a placement? Structural, like every other accessor protocol
 * here: a placement is what answers `point`, `station`, `then`, `inverse`
 * and a `door`. It is NOT a function, so `typeof p === 'function'` is
 * false and `group(p, …)` can never be confused with a callback. */
export function isPlacement(v: unknown): v is Placement {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Partial<Placement>;
  return (
    typeof p.point === 'function'
    && typeof p.station === 'function'
    && typeof p.then === 'function'
    && typeof p.inverse === 'function'
    && typeof p.door === 'object' && p.door !== null
    && (p.orientation === 1 || p.orientation === -1)
  );
}
