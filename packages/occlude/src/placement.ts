/**
 * ONE isometry value, for every door that used to keep its own.
 *
 * A drawing tree carried affine `TransformOp`s, the disk carried Möbius
 * records, a tiling carried three private motion types, and a station
 * carried a point and a heading. None of the four could meet: a tiling's
 * placement could not be inverted, a station's frame could not be pushed
 * onto a drawing, and a curved motif could not be placed at all. A
 * `Placement` is the one value all of them speak — and a walk is one,
 * stepped and turned.
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
 *
 * ONE VALUE IN TWO DIMENSIONS. A placement of 3D space is the same value
 * one dimension up: `Placement<Vec3>`. Its model is the hyperboloid in
 * `R⁴` under the Minkowski product, read through the Beltrami–Klein ball,
 * so its matrix is a 4×4 Lorentz matrix (sixteen numbers, `m`) where the
 * plane's is a 3×3; `point`, `then`, `inverse` and `orientation` mean
 * exactly what they mean on the plane (`then` is the matrix product,
 * `orientation` the sign of the determinant). What stays 2D-only is what
 * makes a plane placement a FRAME: `x`, `y`, `heading`, the walk verbs
 * `step`, `turn` and `toward`, the `door` of the sketch's space, and
 * `group(placement, …)` — a drawing is on the sheet, and a turn in space
 * has no one heading. So the two dimensions stay two kinds of value, told
 * apart by the point they move, and neither follows the other.
 */

import { apply as applyLorentz, compose as composeLorentz, inverse as inverseLorentz, type Lorentz } from './hyperbolicSpace.js';
import type { Space, SpaceKind } from './space.js';
import type { Vec3 } from './three/math.js';
import { radians } from './units.js';
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
 * @internal A frame: a place and the direction it faces, in radians from
 * `+x` toward `+y`. What a placement carries the origin frame — sketch
 * `(0, 0)` facing `+x` — to.
 */
export interface Frame {
  readonly x: number;
  readonly y: number;
  readonly heading: number;
}

/**
 * An isometry of one geometry, as a value: apply it to a point, or to a
 * whole drawing through `group(placement, …)`; compose it with `then`;
 * turn it round with `inverse`; walk it with `step`, `turn` and `toward`.
 *
 * A placement is also a FRAME: the place it carries the origin to (`x`,
 * `y`) and the direction it turns `+x` to there (`heading`, radians). So
 * it stands in for a point (`circle(pl, 3)`, `line(pl, pl.step(8))`), and
 * a walk is a placement stepped and turned: `t.placement(at, heading)`
 * starts one, and `p.placement()` is the frame at a point that has a
 * heading (a point of `m.along()` or of a curve).
 *
 * `orientation` is −1 when the isometry turns the plane over — an odd
 * number of reflections — and +1 when it does not. A motif with a hand to
 * it comes out left-handed in the first case.
 */
export type Placement<P extends XY | Vec3 = XY> = [P] extends [Vec3] ? SpacePlacement : PlanePlacement;

/** A placement of the sketch's plane (see `Placement`). */
export interface PlanePlacement {
  readonly door: ModelDoor;
  readonly orientation: 1 | -1;
  /** The 3×3 on model vectors, row-major. Internal: the value a sketch
   * holds is the verbs, not these nine numbers. */
  readonly m: readonly number[];
  /** Where this placement puts the origin. */
  readonly x: number;
  readonly y: number;
  /** The direction it turns `+x` to at `(x, y)`, in radians from `+x`
   * toward `+y`. */
  readonly heading: number;
  /** Where this isometry sends a sketch point. */
  point(p: XY): Vec;
  /** Apply this, then `next`. */
  then(next: Placement): Placement;
  /** The isometry that undoes this one. */
  inverse(): Placement;
  /** A NEW placement `distance` along this one's heading: one step of a
   * walk. The flat plane adds `distance · (cos heading, sin heading)` and
   * keeps the heading. A curved space walks the geodesic, and the
   * geodesic's direction on arrival is the new heading. */
  step(distance: number): Placement;
  /** A NEW placement with the heading turned by `degrees` (degrees, as
   * `rotate`, positive from `+x` toward `+y`). The place stays. */
  turn(degrees: number): Placement;
  /** A NEW placement at the same place, facing `q`: the direction of the
   * geodesic that runs from here to there. A `q` in this very place keeps
   * the heading; on the sphere a `q` exactly opposite has no one
   * direction and is refused by name. */
  toward(q: XY): Placement;
}

/** The space a door belongs to, for the walk verbs: a curved space binds
 * its own door when it is built. The flat door walks flat. */
const spaces = new WeakMap<ModelDoor, Space>();

/** @internal Bind a door to the space it was built for. */
export function bindSpace(door: ModelDoor, space: Space): void {
  spaces.set(door, space);
}

/** @internal The space a door was built for; undefined for the flat door. */
export function spaceOfDoor(door: ModelDoor): Space | undefined {
  return spaces.get(door);
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
function make(door: ModelDoor, m: readonly number[], at?: Frame): Placement {
  const frozen = Object.freeze(m.slice());
  const orientation: 1 | -1 = det9(frozen) < 0 ? -1 : 1;
  // The frame is the one a walk made, kept exactly; otherwise it is read
  // off the matrix the first time it is asked for.
  let frame: Frame | undefined = at;
  const own = (): Frame => (frame ??= carry(door, frozen, ORIGIN));
  const value: Placement = {
    door,
    orientation,
    m: frozen,
    get x() { return own().x; },
    get y() { return own().y; },
    get heading() { return own().heading; },
    point(p: XY): Vec {
      return door.down(act(frozen, door.up(p)));
    },
    then(next: Placement): Placement {
      agree('then', door, (next as Partial<Placement>).door);
      // `next` after this: the matrices multiply the other way round.
      return make(door, mul9(next.m, frozen));
    },
    inverse(): Placement {
      return make(door, inv9(frozen));
    },
    step(distance: number): Placement {
      return framePlacement(door, stepFrame(spaces.get(door), own(), distance));
    },
    turn(degrees: number): Placement {
      const f = own();
      return framePlacement(door, { x: f.x, y: f.y, heading: f.heading + radians(degrees) });
    },
    toward(q: XY): Placement {
      return framePlacement(door, towardFrame(spaces.get(door), own(), q));
    },
  };
  return Object.freeze(value);
}

/** The origin frame: sketch `(0, 0)` facing `+x`. */
const ORIGIN: Frame = Object.freeze({ x: 0, y: 0, heading: 0 });

/**
 * @internal The placement that carries the origin frame to `f`, keeping
 * `f` as its frame exactly: what a walk and `p.placement()` answer.
 */
export function framePlacement(door: ModelDoor, f: Frame): Placement {
  return make(door, mul9(basis(door, f, false), inv9(basis(door, ORIGIN, false))), f);
}

/** One step of a walk: the flat plane adds the heading's vector; a curved
 * space walks the geodesic, and its direction on arrival is the heading. */
function stepFrame(sp: Space | undefined, f: Frame, distance: number): Frame {
  const dx = distance * Math.cos(f.heading);
  const dy = distance * Math.sin(f.heading);
  if (!sp || sp.kind === 'euclidean') return { x: f.x + dx, y: f.y + dy, heading: f.heading };
  const p: Vec = [f.x, f.y];
  const q = sp.exp(p, [dx, dy]);
  // The new heading is the geodesic's direction on arrival: the tangent
  // at `q` pointing away from the start `p`, which is `log(q, p)`
  // negated. A zero step arrives where it began and keeps its heading.
  const back = sp.log(q, p);
  const h = back[0] === 0 && back[1] === 0 ? f.heading : Math.atan2(-back[1], -back[0]);
  return { x: q[0], y: q[1], heading: h };
}

/** The same place, facing `q` along the geodesic from here. */
function towardFrame(sp: Space | undefined, f: Frame, q: XY): Frame {
  const here: Vec = [f.x, f.y];
  const there: Vec = [vx(q), vy(q)];
  if (sp && sp.kind === 'spherical') {
    // Half a turn away every direction is as good as another, and the
    // placement is asked for the one that is not there.
    const half = Math.PI * sp.radius;
    if (Math.abs(sp.distance(here, there) - half) < 1e-9 * half) {
      throw new Error(`placement.toward: [${there[0]}, ${there[1]}] is opposite this place and has no one direction — turn to a heading instead`);
    }
  }
  const v = sp && sp.kind !== 'euclidean' ? sp.log(here, there) : [there[0] - f.x, there[1] - f.y];
  // The same place names no direction, so the placement keeps the one it has.
  if (!(Math.hypot(v[0], v[1]) > 0)) return { x: f.x, y: f.y, heading: f.heading };
  return { x: f.x, y: f.y, heading: Math.atan2(v[1], v[0]) };
}

/** Two doors are the same door, or the two placements name two geometries
 * and cannot meet. */
function agree(who: string, a: ModelDoor, b: ModelDoor | undefined): void {
  if (!b) throw new Error(`placement.${who}: a placement of 3D space cannot follow one of the plane`);
  if (a === b || a.id === b.id) return;
  throw new Error(`placement.${who}: a placement of ${b.kind} space cannot follow one of ${a.kind} space`);
}

/**
 * A frame through an isometry: the point is the point, and the heading is
 * the direction the frame's own tangent lands in, read in the frame at the
 * arrival.
 */
function carry(door: ModelDoor, m: readonly number[], s: Frame): Frame {
  const at: XY = [s.x, s.y];
  const q = door.down(act(m, door.up(at)));
  const [E1, E2] = door.frameAt(at);
  const ch = Math.cos(s.heading);
  const sh = Math.sin(s.heading);
  const t: Model = [E1[0] * ch + E2[0] * sh, E1[1] * ch + E2[1] * sh, E1[2] * ch + E2[2] * sh];
  const mt = act(m, t);
  const [f1, f2] = door.frameAt(q);
  return { x: vx(q), y: vy(q), heading: Math.atan2(form(door.sign, mt, f2), form(door.sign, mt, f1)) };
}

/** @internal The isometry that moves nothing. */
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

/** A frame as a 3×3 whose columns are `e1`, `e2` and the frame's own
 * model point. Its determinant is +1 (−1 mirrored), because
 * `[e1 | e2 | P]` is `[P | e1 | e2]` cyclically permuted. */
function basis(door: ModelDoor, s: Frame, mirror: boolean): number[] {
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
 * @internal The one isometry carrying frame `from` onto frame `to`:
 * `B(to)·B(from)⁻¹`. It carries `from` to `to`, point and heading.
 *
 * With `mirror` the source frame's second column is turned over first, so
 * the answer reverses handedness and still lands the point.
 */
export function between(door: ModelDoor, from: Frame, to: Frame, opts: { mirror?: boolean } = {}): Placement {
  return make(door, mul9(basis(door, to, false), inv9(basis(door, from, opts.mirror === true))));
}

/** @internal Is this a placement? Structural, like every other accessor protocol
 * here: a placement is what answers `point`, `step`, `then`, `inverse`
 * and a `door`. It is NOT a function, so `typeof p === 'function'` is
 * false and `group(p, …)` can never be confused with a callback. */
export function isPlacement(v: unknown): v is Placement {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Partial<Placement>;
  return (
    typeof p.point === 'function'
    && typeof p.step === 'function'
    && typeof p.then === 'function'
    && typeof p.inverse === 'function'
    && typeof p.door === 'object' && p.door !== null
    && (p.orientation === 1 || p.orientation === -1)
  );
}

// ---- one dimension up: a placement of 3D hyperbolic space ------------------

/** A placement of 3D hyperbolic space (see `Placement`): the verbs of a
 * plane placement that have a meaning in space. */
export interface SpacePlacement {
  /** −1 when the isometry turns space over — an odd number of
   * reflections — and +1 when it does not. */
  readonly orientation: 1 | -1;
  /** The 4×4 Lorentz matrix on the hyperboloid, row-major. Internal, as
   * the plane's nine numbers are. */
  readonly m: readonly number[];
  /** Where this isometry sends a point of the Klein ball. A fresh triple
   * out. A straight Klein chord stays a straight chord, so moving the two
   * ends of a wire moves the whole wire exactly. */
  point(p: Vec3): Vec3;
  /** Apply this, then `next`. */
  then(next: SpacePlacement): SpacePlacement;
  /** The isometry that undoes this one. */
  inverse(): SpacePlacement;
}

const lorentzOf = new WeakMap<SpacePlacement, Lorentz>();

/** @internal The placement over one engine record: what `honeycomb` and
 * `observer` answer. The record stays private; `then` and `inverse` are the
 * engine's `compose` and `inverse`, so a chain is one matrix, not a chain of
 * closures. */
export function spacePlacement(record: Lorentz): SpacePlacement {
  const value: SpacePlacement = Object.freeze({
    orientation: record.mirror ? -1 as const : 1 as const,
    m: record.matrix,
    point: (p: Vec3): Vec3 => applyLorentz(record, p),
    // `next` after this: the matrices multiply the other way round.
    then: (next: SpacePlacement): SpacePlacement => {
      const other = lorentzOf.get(next);
      if (!other) throw new Error('placement.then: a placement of the plane cannot follow one of 3D space');
      return spacePlacement(composeLorentz(other, record));
    },
    inverse: (): SpacePlacement => spacePlacement(inverseLorentz(record)),
  });
  lorentzOf.set(value, record);
  return value;
}

/** @internal Is this a placement of 3D space? Only the engine makes one, so
 * the test is the record under it. */
export function isSpacePlacement(v: unknown): v is SpacePlacement {
  return typeof v === 'object' && v !== null && lorentzOf.has(v as SpacePlacement);
}
