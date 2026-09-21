/**
 * Hyperbolic SPACE, in the Beltrami–Klein ball: `hyperbolic.space`.
 *
 * The disk words draw the hyperbolic PLANE in the Poincaré model, where a
 * straight line is an arc. Space is a different job, and it wants a
 * different model. In the Beltrami–Klein ball — the unit ball of `[x, y,
 * z]`, whose rim is infinitely far away — a hyperbolic straight line is an
 * ordinary chord and a hyperbolic plane is an ordinary flat plane. So a
 * hyperbolic polyhedron is an ordinary mesh: `t.mesh(points, faces)` takes
 * it, and the exact hidden-line classifier reads it with no word of its
 * own here.
 *
 * The price is the metric. Klein coordinates are not hyperbolic lengths,
 * and a hatch spacing or an isoline step measured in the ball counts Klein
 * units, not hyperbolic ones. `distance` is the only word here that
 * answers in true hyperbolic length.
 *
 * The transforms work on the HYPERBOLOID, `x² + y² + z² − t² = −1`, where
 * every isometry is a 4×4 Lorentz matrix and a composition is a matrix
 * product. A Klein point is that model divided through by `t`, so the same
 * matrix moves a Klein point as a homogeneous `[x, y, z, 1]`. That is why
 * a transform here is DATA — sixteen numbers and a mirror flag — exactly
 * as a disk transform is four complex numbers and a mirror flag.
 *
 * Nothing here reads the seed or the paper. The sketch puts the ball where
 * it wants it.
 */

import { finiteCount } from './guard.js';
import type { Vec3 } from './three/math.js';

/**
 * An isometry of hyperbolic space, as a record.
 *
 * `matrix` is 4×4, row-major, sixteen numbers, acting on the Minkowski
 * 4-vector `[x, y, z, t]`. It preserves `x² + y² + z² − t²` and it keeps
 * the future sheet of the hyperboloid, which is the pair of conditions
 * `lorentz` checks. `mirror` marks the half of the isometries that turn
 * space over — the determinant is then −1. `boost` and `rotation` leave it
 * false; `reflection` sets it; `compose` adds the two.
 */
export interface Lorentz {
  readonly matrix: readonly number[];
  readonly mirror: boolean;
}

/** The regular cell of a honeycomb, in Klein coordinates: what
 * `t.mesh(points, faces)` takes. The faces are wound outward, and each one
 * is a flat polygon, because a hyperbolic plane is flat in this model. */
export interface HyperbolicCell {
  readonly points: readonly Vec3[];
  readonly faces: readonly (readonly number[])[];
}

export interface SpaceGeodesicOpts {
  /** Pieces along the segment; the result has `count + 1` points. */
  count?: number;
}

export interface HoneycombOpts {
  /** Generations of neighbours to reflect out to. Depth 0 is the
   * fundamental cell alone; depth 1 adds its face neighbours. */
  depth?: number;
}

export interface SpaceCameraOpts {
  /** Which way is up, as a direction at `eye` in Klein coordinates.
   * Default `[0, 0, 1]`, the world's own up. */
  up?: Vec3;
}

/** The tolerance every check here uses. */
const TOL = 1e-9;
/** The Minkowski signs: `⟨u, v⟩ = u₀v₀ + u₁v₁ + u₂v₂ − u₃v₃`. */
const SIGN = [1, 1, 1, -1] as const;
const IDENTITY: readonly number[] = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

type Vec4 = readonly [number, number, number, number];

// ---- small arithmetic (module-private) -----------------------------------

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 => { const l = norm(a); return [a[0] / l, a[1] / l, a[2] / l]; };
/** The Minkowski form of two 4-vectors. */
const form = (a: Vec4, b: Vec4): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] - a[3] * b[3];
const finiteTriple = (who: string, p: Vec3): void => {
  if (!Array.isArray(p) || p.length !== 3 || !p.every((v) => Number.isFinite(v))) throw new Error(`${who}: a point of the ball is three finite numbers, and this is ${JSON.stringify(p)}`);
};
const inBall = (who: string, p: Vec3): void => {
  finiteTriple(who, p);
  const q = dot(p, p);
  if (!(q < 1)) throw new Error(`${who}: [${p[0]}, ${p[1]}, ${p[2]}] is not inside the unit ball (its distance from the centre is ${Math.sqrt(q)})`);
};

const mulM = (a: readonly number[], b: readonly number[]): number[] => {
  const c = new Array<number>(16).fill(0);
  for (let i = 0; i < 4; i++) {
    for (let k = 0; k < 4; k++) {
      const v = a[i * 4 + k];
      if (v === 0) continue;
      for (let j = 0; j < 4; j++) c[i * 4 + j] += v * b[k * 4 + j];
    }
  }
  return c;
};

/** A 4-vector through a matrix. */
const mulV = (m: readonly number[], v: Vec4): Vec4 => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2] + m[3] * v[3],
  m[4] * v[0] + m[5] * v[1] + m[6] * v[2] + m[7] * v[3],
  m[8] * v[0] + m[9] * v[1] + m[10] * v[2] + m[11] * v[3],
  m[12] * v[0] + m[13] * v[1] + m[14] * v[2] + m[15] * v[3],
];

function det4(m: readonly number[]): number {
  const minor = (r: number, c: number): number => {
    const rows = [0, 1, 2, 3].filter((i) => i !== r);
    const cols = [0, 1, 2, 3].filter((j) => j !== c);
    const g = (i: number, j: number): number => m[rows[i] * 4 + cols[j]];
    return g(0, 0) * (g(1, 1) * g(2, 2) - g(1, 2) * g(2, 1))
      - g(0, 1) * (g(1, 0) * g(2, 2) - g(1, 2) * g(2, 0))
      + g(0, 2) * (g(1, 0) * g(2, 1) - g(1, 1) * g(2, 0));
  };
  let d = 0;
  for (let j = 0; j < 4; j++) d += (j % 2 ? -1 : 1) * m[j] * minor(0, j);
  return d;
}

/** A record from a matrix already known to be a Lorentz matrix. */
const record = (matrix: readonly number[], mirror: boolean): Lorentz => ({ matrix: Object.freeze([...matrix]), mirror });

// ---- the transform as data -----------------------------------------------

/**
 * An isometry of hyperbolic space from a 4×4 matrix, sixteen numbers,
 * row-major, acting on `[x, y, z, t]`.
 *
 * The matrix must preserve the Minkowski form — `Mᵀ J M = J`, with
 * `J = diag(1, 1, 1, −1)` — and it must keep the future sheet, so that a
 * point of space goes to a point of space. Anything else is a mistake and
 * refuses by name. `boost`, `rotation` and `reflection` are the makers you
 * normally want; this one is for a matrix worked out somewhere else.
 *
 * `mirror` is read from the determinant: −1 turns space over.
 */
export function lorentz(matrix: readonly number[]): Lorentz {
  if (!Array.isArray(matrix) || matrix.length !== 16 || !matrix.every((v) => Number.isFinite(v))) {
    throw new Error(`lorentz: a transform is sixteen finite numbers, row-major, and this is ${Array.isArray(matrix) ? `${matrix.length} numbers` : typeof matrix}`);
  }
  let scale = 1;
  for (const v of matrix) scale = Math.max(scale, Math.abs(v));
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      // (Mᵀ J M)ᵢⱼ against Jᵢⱼ.
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += SIGN[k] * matrix[k * 4 + i] * matrix[k * 4 + j];
      const want = i === j ? SIGN[i] : 0;
      if (Math.abs(sum - want) > TOL * scale * scale) {
        throw new Error('lorentz: the matrix does not preserve x² + y² + z² − t², so it is not an isometry of hyperbolic space');
      }
    }
  }
  if (!(matrix[15] > 0)) throw new Error('lorentz: the matrix turns the future sheet of the hyperboloid over, so it sends points of space outside it');
  return record(matrix, det4(matrix) < 0);
}

/**
 * The hyperbolic translation that carries the centre of the ball to
 * `[dx, dy, dz]`.
 *
 * It slides the whole of space along the straight line through the centre
 * and that point — a boost, in the Minkowski words the matrix is written
 * in. A point outside the ball is not somewhere space can go, and refuses
 * by name.
 */
export function boost(dx: number, dy: number, dz: number): Lorentz {
  const k: Vec3 = [dx, dy, dz];
  inBall('boost', k);
  const b = norm(k);
  if (b === 0) return record(IDENTITY, false);
  const u = unit(k);
  // The boost of rapidity `θ` along `u`, with `tanh θ = |k|`: it grows the
  // spatial part along `u` by `γ` and mixes in the time part, so the centre
  // `(0, 0, 0, 1)` lands on `γ(k, 1)`, which is the Klein point `k`.
  const g = 1 / Math.sqrt(1 - b * b);
  const m = [...IDENTITY];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) m[i * 4 + j] = (i === j ? 1 : 0) + (g - 1) * u[i] * u[j];
    m[i * 4 + 3] = g * b * u[i];
    m[12 + i] = g * b * u[i];
  }
  m[15] = g;
  return record(m, false);
}

/**
 * The turn about the centre of the ball, in degrees, counter-clockwise
 * seen from the far end of `axis`.
 *
 * At the centre of the Klein ball the model is true to angle, so a turn
 * about the centre is also the Euclidean turn about the centre. `axis` is
 * `'x'`, `'y'`, `'z'` or any direction.
 */
export function rotation(axis: Vec3 | 'x' | 'y' | 'z', degrees: number): Lorentz {
  const raw: Vec3 = axis === 'x' ? [1, 0, 0] : axis === 'y' ? [0, 1, 0] : axis === 'z' ? [0, 0, 1] : axis;
  finiteTriple('rotation', raw);
  if (!Number.isFinite(degrees)) throw new Error(`rotation: the angle is a finite number of degrees, and it is ${degrees}`);
  if (norm(raw) === 0) throw new Error('rotation: the axis has no direction');
  const u = unit(raw);
  const a = (degrees * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const m = [...IDENTITY];
  // Rodrigues, written out in the spatial block; time is left alone.
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const d = i === j ? 1 : 0;
      const e = (i + 1) % 3 === j ? u[(i + 2) % 3] : (j + 1) % 3 === i ? -u[(j + 2) % 3] : 0;
      m[i * 4 + j] = d * c + u[i] * u[j] * (1 - c) - e * s;
    }
  }
  return record(m, false);
}

/**
 * The plane through three points of the ball, as a unit spacelike normal
 * `n` with `⟨n, n⟩ = 1`. The plane is `⟨X, n⟩ = 0`. Which side `n` points
 * to follows the winding of the three points, and the caller flips it when
 * it cares — a reflection does not.
 *
 * A hyperbolic plane in this model is a flat Euclidean plane `a·v = c`
 * cut off by the rim. Writing a Klein point as `X = (v, 1)·s`, that plane
 * reads `⟨X, n⟩ = 0` with `n = (a, c)` exactly, because the Minkowski form
 * subtracts the time part. `|a| > |c|` is the condition that the plane
 * meets the ball at all, and it is also what lets `n` be scaled to one.
 */
function planeNormal(who: string, a: Vec3, b: Vec3, c: Vec3): Vec4 {
  for (const p of [a, b, c]) finiteTriple(who, p);
  const n = cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
  const l = norm(n);
  if (!(l > 0)) throw new Error(`${who}: the three points are in one line, so they name no plane`);
  const u = unit(n);
  const offset = dot(u, a);
  const w = 1 - offset * offset;
  if (!(w > 0)) throw new Error(`${who}: that plane does not cut the unit ball, so it is not a hyperbolic plane`);
  const s = 1 / Math.sqrt(w);
  return [u[0] * s, u[1] * s, u[2] * s, offset * s];
}

/** The reflection in the plane whose unit spacelike normal is `n`:
 * `X ↦ X − 2⟨X, n⟩ n`, written out as a matrix. */
function reflect(n: Vec4): Lorentz {
  const m = new Array<number>(16);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) m[i * 4 + j] = (i === j ? 1 : 0) - 2 * n[i] * SIGN[j] * n[j];
  return record(m, true);
}

/**
 * The reflection in the hyperbolic plane through three points of the ball.
 *
 * Three points, not a normal: a normal here is a Minkowski 4-vector, which
 * is the model's private word, while three points of the plane are data a
 * sketch already holds — a face of a cell, a wall of a room. The three must
 * not be in one line, and their plane must cut the ball. The record has
 * `mirror` set, because a reflection turns space over.
 */
export function reflection(plane: readonly Vec3[]): Lorentz {
  if (!Array.isArray(plane) || plane.length < 3) throw new Error(`reflection: a hyperbolic plane is named by three points of the ball, and ${Array.isArray(plane) ? plane.length : 'a non-list'} were given`);
  return reflect(planeNormal('reflection', plane[0], plane[1], plane[2]));
}

/**
 * One point of the ball through one transform. A fresh triple out.
 *
 * The matrix acts on the hyperboloid, but a Klein point is the hyperboloid
 * divided through by its time part, so `[x, y, z, 1]` through the matrix
 * and divided through again is the same answer with no square root.
 */
export function apply(m: Lorentz, p: Vec3): Vec3 {
  finiteTriple('apply', p);
  const w = mulV(m.matrix, [p[0], p[1], p[2], 1]);
  return [w[0] / w[3], w[1] / w[3], w[2] / w[3]];
}

/** One transform as a point map, ready for any consumer of a
 * `(p: Vec3) => Vec3` — `mesh.displace` wants the DELTA, so a sketch that
 * moves a built mesh subtracts the row's own position. A cell that is not
 * built yet is cheaper: map its points before `t.mesh` sees them. */
export function map(m: Lorentz): (p: Vec3) => Vec3 {
  return (p) => apply(m, p);
}

/** `a` after `b`: the transform that does `b` first, as the matrix product
 * multiplies. */
export function compose(a: Lorentz, b: Lorentz): Lorentz {
  return record(mulM(a.matrix, b.matrix), a.mirror !== b.mirror);
}

/** The transform that undoes this one: `J Mᵀ J`, which is what
 * `Mᵀ J M = J` rearranges to. No inversion is computed. */
export function inverse(m: Lorentz): Lorentz {
  const out = new Array<number>(16);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) out[i * 4 + j] = SIGN[i] * SIGN[j] * m.matrix[j * 4 + i];
  return record(out, m.mirror);
}

/** A Klein point lifted to the unit hyperboloid. */
function lift(who: string, p: Vec3): Vec4 {
  inBall(who, p);
  const s = 1 / Math.sqrt(1 - dot(p, p));
  return [p[0] * s, p[1] * s, p[2] * s, s];
}

/**
 * The hyperbolic distance between two points of the ball: `acosh(−⟨A, B⟩)`
 * on the hyperboloid.
 *
 * This is the one word here that answers in TRUE hyperbolic length.
 * Everything else — a chord, a face, a spacing — is in Klein coordinates,
 * which grow shorter and shorter as they near the rim.
 */
export function distance(a: Vec3, b: Vec3): number {
  const A = lift('distance', a);
  const B = lift('distance', b);
  return Math.acosh(Math.max(1, -form(A, B)));
}

/**
 * The straight segment from `a` to `b`, as points.
 *
 * In this model a hyperbolic straight line IS the chord, so two points
 * would draw it. The samples are here for a reason of their own: they are
 * evenly spaced in HYPERBOLIC arc length, not along the chord. Near the
 * centre the two agree; toward the rim the hyperbolic spacing crowds the
 * Euclidean samples into the last little piece of the chord, because that
 * piece is most of the length. Ask for samples when something is measured
 * or carried along the segment; two points are enough to draw it.
 *
 * The first point is exactly `a` and the last is exactly `b`.
 */
export function geodesic(a: Vec3, b: Vec3, opts: SpaceGeodesicOpts = {}): Vec3[] {
  const A = lift('geodesic', a);
  const B = lift('geodesic', b);
  const n = opts.count === undefined ? 16 : finiteCount('geodesic', opts.count);
  if (n < 1) return [];
  const L = Math.acosh(Math.max(1, -form(A, B)));
  const end: Vec3[] = [[a[0], a[1], a[2]], [b[0], b[1], b[2]]];
  if (!(L > TOL)) return end;
  // The unit tangent at `A` toward `B`: the part of `B` across `A`, which
  // has Minkowski length `sinh L`, because `⟨A, A⟩ = −1`.
  const ch = Math.cosh(L);
  const sh = Math.sinh(L);
  const U: Vec4 = [(B[0] - ch * A[0]) / sh, (B[1] - ch * A[1]) / sh, (B[2] - ch * A[2]) / sh, (B[3] - ch * A[3]) / sh];
  const out: Vec3[] = [];
  for (let k = 0; k <= n; k++) {
    const s = (L * k) / n;
    const c = Math.cosh(s);
    const d = Math.sinh(s);
    const t = c * A[3] + d * U[3];
    out.push([(c * A[0] + d * U[0]) / t, (c * A[1] + d * U[1]) / t, (c * A[2] + d * U[2]) / t]);
  }
  out[0] = end[0];
  out[n] = end[1];
  return out;
}

// ---- the regular cell ----------------------------------------------------

const PHI = (1 + Math.sqrt(5)) / 2;
/** The three regular solids the compact honeycombs are built from, at unit
 * circumradius. A regular polyhedron centred on the centre of the Klein
 * ball keeps its Euclidean symmetry exactly, because the isometries that
 * fix the centre are the orthogonal maps — so `{p, q}` here is the
 * ordinary Platonic solid, and only its SIZE is hyperbolic. */
function platonic(p: number, q: number): Vec3[] {
  const key = `${p},${q}`;
  const points: Vec3[] = [];
  if (key === '4,3' || key === '5,3') for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) points.push([x, y, z]);
  if (key === '5,3') for (const s of [-1, 1]) for (const u of [-1, 1]) points.push([0, s / PHI, u * PHI], [s / PHI, u * PHI, 0], [u * PHI, 0, s / PHI]);
  if (key === '3,5') for (const s of [-1, 1]) for (const u of [-1, 1]) points.push([0, s, u * PHI], [s, u * PHI, 0], [u * PHI, 0, s]);
  if (points.length === 0) throw new Error(`polyhedron: {${p}, ${q}} is not one of the three regular solids the compact honeycombs use — {4, 3}, {5, 3} and {3, 5}`);
  return points.map(unit);
}

/**
 * The faces of a convex solid whose vertices all sit on one sphere, wound
 * counter-clockwise seen from OUTSIDE, so the face normal points out.
 *
 * The edges are the closest pairs — a regular solid's shortest distance is
 * its edge, and the next distance up is far away. Around a vertex the
 * outward normal is the vertex itself, so its neighbours sort by angle in
 * its own tangent plane, and the neighbour after the one you came from is
 * the next corner of the face you are walking. That walk visits every
 * directed edge once, so it finds every face once, and it needs no dual
 * and no plane fitting.
 */
function solidFaces(points: readonly Vec3[]): number[][] {
  const n = points.length;
  const at = (i: number, j: number): number => Math.hypot(points[i][0] - points[j][0], points[i][1] - points[j][1], points[i][2] - points[j][2]);
  let edge = Infinity;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) edge = Math.min(edge, at(i, j));
  const ring: number[][] = points.map((p, i) => {
    const u = unit(Math.abs(p[0]) < 0.9 ? cross(p, [1, 0, 0]) : cross(p, [0, 1, 0]));
    const v = cross(p, u);
    const angle = (j: number): number => {
      const w: Vec3 = [points[j][0] - p[0], points[j][1] - p[1], points[j][2] - p[2]];
      return Math.atan2(dot(w, v), dot(w, u));
    };
    const near: number[] = [];
    for (let j = 0; j < n; j++) if (j !== i && at(i, j) < edge * (1 + 1e-6)) near.push(j);
    return near.sort((x, y) => angle(x) - angle(y));
  });
  const used = new Set<string>();
  const faces: number[][] = [];
  for (let a = 0; a < n; a++) {
    for (const first of ring[a]) {
      if (used.has(`${a}:${first}`)) continue;
      const face: number[] = [];
      let from = a;
      let here = first;
      while (!used.has(`${from}:${here}`)) {
        used.add(`${from}:${here}`);
        face.push(from);
        const around = ring[here];
        const next = around[(around.indexOf(from) + 1) % around.length];
        from = here;
        here = next;
      }
      // Counter-clockwise from outside: the right-hand normal of the ring
      // must point away from the centre, which the solid surrounds.
      const [i0, i1, i2] = face;
      const e1: Vec3 = [points[i1][0] - points[i0][0], points[i1][1] - points[i0][1], points[i1][2] - points[i0][2]];
      const e2: Vec3 = [points[i2][0] - points[i0][0], points[i2][1] - points[i0][1], points[i2][2] - points[i0][2]];
      faces.push(dot(cross(e1, e2), points[i0]) > 0 ? face : face.slice().reverse());
    }
  }
  return faces;
}

/** `cos(π/p)`, and the three of them, which every formula below is written
 * in. */
const cosines = (p: number, q: number, r: number): [number, number, number] => [Math.cos(Math.PI / p), Math.cos(Math.PI / q), Math.cos(Math.PI / r)];

/** The Gram determinant of the `{p, q, r}` Coxeter simplex, whose four
 * mirrors meet at `π/p`, `π/q`, `π/r` and three right angles:
 *
 *     G = [[1, −cp, 0, 0], [−cp, 1, −cq, 0], [0, −cq, 1, −cr], [0, 0, −cr, 1]]
 *     det G = 1 − cp² − cq² − cr² + cp²cr²
 *
 * Its SIGN is the geometry: positive is the sphere, zero the Euclidean
 * space, negative hyperbolic space. */
const gramDet = (p: number, q: number, r: number): number => {
  const [cp, cq, cr] = cosines(p, q, r);
  return 1 - cp * cp - cq * cq - cr * cr + cp * cp * cr * cr;
};

/** The four `{p, q, r}` whose cell is a compact hyperbolic polyhedron. */
const COMPACT = ['4,3,5', '5,3,4', '3,5,3', '5,3,5'];

function checkPQR(who: string, p: number, q: number, r: number): void {
  for (const [name, v] of [['p', p], ['q', q], ['r', r]] as const) {
    if (!Number.isInteger(v) || v < 3) throw new Error(`${who}: ${name} is a whole number of 3 or more (got ${v})`);
  }
  if (COMPACT.includes(`${p},${q},${r}`)) return;
  const det = gramDet(p, q, r);
  const named = `{${p}, ${q}, ${r}}`;
  if (det > TOL) throw new Error(`${who}: ${named} is a SPHERICAL honeycomb — it is the regular 4-polytope ${named} on the 3-sphere, not a honeycomb of hyperbolic space. The compact hyperbolic cases are {4, 3, 5}, {5, 3, 4}, {3, 5, 3} and {5, 3, 5}`);
  if (det > -TOL) throw new Error(`${who}: ${named} is a EUCLIDEAN honeycomb — it fills flat space, where its cell is an ordinary Platonic solid. The compact hyperbolic cases are {4, 3, 5}, {5, 3, 4}, {3, 5, 3} and {5, 3, 5}`);
  throw new Error(`${who}: ${named} is hyperbolic but NOT compact — its cell or its vertex figure runs out to the rim, which is infinitely far away, so it has no finite cell. The compact hyperbolic cases are {4, 3, 5}, {5, 3, 4}, {3, 5, 3} and {5, 3, 5}`);
}

/**
 * The regular cell of the `{p, q, r}` honeycomb, centred on the centre of
 * the ball: the regular polyhedron `{p, q}` whose dihedral angle is `2π/r`,
 * so that `r` cells meet around every edge.
 *
 * The answer is `{ points, faces }` in Klein coordinates, ready for
 * `t.mesh(points, faces)`. Only four `{p, q, r}` have a compact cell in
 * hyperbolic space — {4, 3, 5}, {5, 3, 4}, {3, 5, 3}, {5, 3, 5} — and
 * anything else refuses by name, saying which geometry it belongs to.
 *
 * The size. The cell keeps the Euclidean symmetry of `{p, q}` about the
 * centre, so the only unknown is the circumradius `R`. Take the Coxeter
 * simplex of `{p, q, r}`, whose four mirrors have unit spacelike normals
 * `n₀…n₃` and the Gram matrix
 *
 *     Gᵢⱼ = ⟨nᵢ, nⱼ⟩ = −cos(π/mᵢⱼ),  m₀₁ = p, m₁₂ = q, m₂₃ = r, the rest 2.
 *
 * Its dual basis `Vᵢ`, with `⟨Vᵢ, nⱼ⟩ = δᵢⱼ`, is the simplex's own corners:
 * `V₃` is the cell centre (it lies on the three mirrors of `{p, q}`) and
 * `V₀` is a vertex of the honeycomb. Dual bases give `⟨Vᵢ, Vⱼ⟩ = (G⁻¹)ᵢⱼ`,
 * so
 *
 *     cosh R = −(G⁻¹)₀₃ / √((G⁻¹)₀₀ · (G⁻¹)₃₃)
 *            = cp·cq·cr / √((1 − cq² − cr²)(1 − cp² − cq²))
 *
 * after the cofactors of the tridiagonal `G` are written out and the
 * determinant cancels. The Klein radius is `tanh R`, because a point at
 * hyperbolic distance `R` from the centre sits at Klein radius `tanh R`.
 * The dihedral angle of the result is `2π/r` to the last few digits, and
 * the test suite checks it on the built cell rather than trusting this.
 */
export function polyhedron(p: number, q: number, r: number): HyperbolicCell {
  checkPQR('polyhedron', p, q, r);
  const [cp, cq, cr] = cosines(p, q, r);
  const cosh = (cp * cq * cr) / Math.sqrt((1 - cq * cq - cr * cr) * (1 - cp * cp - cq * cq));
  const radius = Math.sqrt(cosh * cosh - 1) / cosh;
  const solid = platonic(p, q);
  return {
    points: solid.map((v) => [v[0] * radius, v[1] * radius, v[2] * radius] as Vec3),
    faces: solidFaces(solid),
  };
}

/** The outward unit spacelike normal of each face of a cell. */
function faceNormals(cell: HyperbolicCell): Vec4[] {
  return cell.faces.map((f) => {
    const n = planeNormal('honeycomb', cell.points[f[0]], cell.points[f[1]], cell.points[f[2]]);
    // Outward: the centre of the ball is the inside, and there
    // `⟨(0,0,0,1), n⟩ = −n₃`, which must be negative.
    return n[3] > 0 ? n : [-n[0], -n[1], -n[2], -n[3]] as Vec4;
  });
}

/** A cell is named by where its placement sends the centre of the ball. */
const BUCKET = 1e-6;
const bucketKey = (p: Vec3, dx: number, dy: number, dz: number): string => `${Math.round(p[0] / BUCKET) + dx},${Math.round(p[1] / BUCKET) + dy},${Math.round(p[2] / BUCKET) + dz}`;

/**
 * The `{p, q, r}` honeycomb as PLACEMENTS: one transform per copy of the
 * fundamental cell, the identity first.
 *
 * The copies are found by reflecting the cell in its own face planes, then
 * reflecting the results in theirs, out to `depth` generations. Depth 1 is
 * the cell and its face neighbours. Two placements that put the cell in the
 * same place are one placement.
 *
 * The sketch builds the cell ONCE with `polyhedron`, maps its points
 * through each placement, and hands each set to `t.mesh`. The copies at odd
 * generations turn space over, because a reflection does.
 */
export function honeycomb(p: number, q: number, r: number, opts: HoneycombOpts = {}): Lorentz[] {
  checkPQR('honeycomb', p, q, r);
  const depth = opts.depth === undefined ? 2 : Math.floor(opts.depth);
  if (!Number.isFinite(depth) || depth < 0) return [];
  const mirrors = faceNormals(polyhedron(p, q, r)).map(reflect);
  const out: Lorentz[] = [record(IDENTITY, false)];
  const seen = new Map<string, Vec3[]>();
  const place = (m: Lorentz): boolean => {
    const o = apply(m, [0, 0, 0]);
    if (!o.every((v) => Number.isFinite(v))) return false;
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        for (let k = -1; k <= 1; k++) {
          const near = seen.get(bucketKey(o, i, j, k));
          if (near && near.some((c) => Math.hypot(c[0] - o[0], c[1] - o[1], c[2] - o[2]) < TOL)) return false;
        }
      }
    }
    const key = bucketKey(o, 0, 0, 0);
    const cell = seen.get(key);
    if (cell) cell.push(o);
    else seen.set(key, [o]);
    return true;
  };
  place(out[0]);
  let frontier = out.slice();
  for (let g = 0; g < depth; g++) {
    const next: Lorentz[] = [];
    for (const m of frontier) {
      for (const mirror of mirrors) {
        const candidate = compose(m, mirror);
        if (!place(candidate)) continue;
        next.push(candidate);
        out.push(candidate);
        // A depth nobody meant to ask for stops here, by name.
        finiteCount('honeycomb', out.length);
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }
  return out;
}

/**
 * The observer: the transform that moves `eye` to the centre of the ball
 * and points `target` along the +Y axis, with `up` along +Z.
 *
 * A hyperbolic observer's view is an ordinary perspective picture taken at
 * the CENTRE of the Klein ball. The model is true to angle there, so the
 * angles the observer sees are the angles hyperbolic space really has.
 * Everywhere else in the ball the angles are the model's, not space's,
 * which is why the scene is moved to the observer and not the other way
 * round.
 *
 * The sketch maps the whole scene through the record and then takes a
 * plain camera at the centre:
 *
 *     const cam = hyperbolic.space.camera(eye, target);
 *     view(cells, { camera: perspective({ eye: [0, 0, 0], target: [0, 1, 0], fovDegrees: 100 }) })
 *
 * with every point of every cell already through `space.map(cam)`. A
 * placement is a transform too, so `compose(cam, placement)` is the one
 * matrix that does both, and no mesh has to be moved after it is built.
 *
 * `up` is a direction at `eye`, not a point; it defaults to the world's
 * `[0, 0, 1]`. An `up` along the line of sight names no frame and refuses
 * by name.
 */
export function camera(eye: Vec3, target: Vec3, opts: SpaceCameraOpts = {}): Lorentz {
  inBall('camera', eye);
  inBall('camera', target);
  const home = inverse(boost(eye[0], eye[1], eye[2]));
  const aim = apply(home, target);
  if (!(norm(aim) > TOL)) throw new Error('camera: the eye and the target are the same point, so there is no direction of view');
  const forward = unit(aim);
  const raw = opts.up === undefined ? [0, 0, 1] as Vec3 : opts.up;
  finiteTriple('camera', raw);
  if (!(norm(raw) > 0)) throw new Error('camera: up has no direction');
  // A direction at the eye moves by the matrix's own spatial part once the
  // eye is at the centre: the derivative of the projective map there is the
  // spatial part of `M·(u, 0)`, up to a positive factor.
  const moved = mulV(home.matrix, [raw[0], raw[1], raw[2], 0]);
  const up: Vec3 = [moved[0], moved[1], moved[2]];
  if (!(norm(up) > TOL)) throw new Error('camera: up has no direction at the eye');
  const back: Vec3 = [-forward[0], -forward[1], -forward[2]];
  const side = cross(unit(up), back);
  if (!(norm(side) > 1e-7)) throw new Error('camera: up runs along the line of sight, so it names no frame');
  const right = unit(side);
  const over = cross(back, right);
  // Rows: right ↦ +X, forward ↦ +Y, over ↦ +Z. That is the frame the 3D
  // `perspective({ eye: [0,0,0], target: [0,1,0] })` camera reads, with Z up.
  const turn = [
    right[0], right[1], right[2], 0,
    forward[0], forward[1], forward[2], 0,
    over[0], over[1], over[2], 0,
    0, 0, 0, 1,
  ];
  return compose(record(turn, false), home);
}

/**
 * Hyperbolic space in the Beltrami–Klein ball: isometries as 4×4 data,
 * straight segments, the regular cells of the four compact honeycombs,
 * their placements, and the observer's own transform.
 *
 * A straight line is a chord here and a plane is flat, so a hyperbolic
 * polyhedron is an ordinary mesh and the 3D words draw it with no special
 * case. Lengths are the exception: Klein coordinates are not hyperbolic
 * lengths, so a spacing measured in the ball is a Klein spacing, and
 * `distance` is the only word here that answers in hyperbolic length.
 */
export const space = {
  lorentz,
  boost,
  rotation,
  reflection,
  apply,
  map,
  compose,
  inverse,
  distance,
  geodesic,
  polyhedron,
  honeycomb,
  camera,
};
