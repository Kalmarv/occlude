/**
 * The regular tiling `{p, q}` — `p`-gons meeting `q` at a vertex — in
 * whichever geometry that symbol belongs to.
 *
 * The symbol picks the geometry and there is nothing to set: `(p − 2)(q −
 * 2)` below 4 is the sphere, exactly 4 the plane, above 4 the hyperbolic
 * disk. So `{3, 5}` is the icosahedron, `{4, 4}` is squared paper and
 * `{7, 3}` is the heptagonal tiling of the disk, and one word draws all
 * three. Only `p` or `q` below 3 is a mistake.
 *
 * The answer is DATA: the fundamental polygon as points in that geometry's
 * MODEL chart, and one point map per copy of it, the identity first. This
 * module is pure and knows nothing of the sheet; `t.tiling` is the door a
 * sketch uses, and it carries the model chart onto the drawable.
 *
 * The model chart is the one the geometry is written in: the unit Poincaré
 * disk for the hyperbolic case, the unit sphere's stereographic chart for
 * the spherical case — the cell about the pole — and the plane with a cell
 * of circumradius `1/(2·sin(π/p))`, an edge of length 1, about the origin.
 */

import { apply as diskApply, compose as diskCompose, reflection as diskReflection, rotation as diskRotation, type Mobius } from './hyperbolic.js';
import { chartOfSphere, sphereOfChart, type Sphere, type SpaceKind } from './space.js';
import { tileGroup, type TileOps } from './tilegroup.js';
import { vx, vy, type Vec, type XY } from './vec.js';

export interface TilingOpts {
  /** Generations of neighbours to reflect out to. Depth 0 is the
   * fundamental polygon alone; depth 1 adds its `p` edge neighbours. */
  depth?: number;
}

/** Which geometry a Schläfli symbol demands — the same three words the
 * sketch's own `space` is named by, so `t.tiling(p, q).space` and
 * `t.space.kind` are comparable. */
export type TilingGeometry = SpaceKind;

/** One regular tiling: its geometry, its cell, and where the copies go. */
export interface Tiling {
  /** The geometry the symbol belongs to, and the chart `cell` is written
   * in. */
  space: TilingGeometry;
  /** The fundamental polygon, `p` vertices in order, one of them on the
   * positive x axis. Its edges are GEODESICS of that geometry; joined up
   * straight they are the chords, which is a different picture. */
  cell: Vec[];
  /**
   * One point map per copy of the cell, the identity first.
   *
   * A stereographic chart has no point for the place opposite its pole, so
   * the spherical copy that lands there is UNBOUNDED in the chart: it is
   * the outside of the picture, and the point at its very centre comes
   * back non-finite. That is the truth about a stereographic picture of a
   * sphere, and every drawing word already reads a non-finite point as
   * "no place". A `'gnomonic'` or `'orthographic'` sketch drops that whole
   * copy, as it drops everything on the far side.
   */
  placements: ((p: XY) => Vec)[];
}

/** `(p − 2)(q − 2)` against 4 is the whole test. */
export function tilingGeometry(p: number, q: number): TilingGeometry {
  const k = (p - 2) * (q - 2);
  return k < 4 ? 'spherical' : k === 4 ? 'euclidean' : 'hyperbolic';
}

// ---- the disk -------------------------------------------------------------

/** The disk's answer to `TileOps`: an isometry is a Möbius record, and a
 * reflection in an edge is the reflection in the geodesic through its two
 * ends. The whole plane is inside the disk, so where a copy puts the
 * origin names it outright. */
const DISK: TileOps<Mobius> = {
  identity: diskRotation(0),
  compose: diskCompose,
  apply: diskApply,
  reflection: diskReflection,
  seat: (m) => diskApply(m, [0, 0]),
};

// ---- the plane ------------------------------------------------------------

/** A plane isometry: `p ↦ M·p + t`, `M` a rotation or a reflection. */
interface Motion {
  readonly m: readonly [number, number, number, number];
  readonly t: readonly [number, number];
}

const PLANE: TileOps<Motion> = {
  identity: { m: [1, 0, 0, 1], t: [0, 0] },
  compose: (o, i) => ({
    m: [
      o.m[0] * i.m[0] + o.m[1] * i.m[2], o.m[0] * i.m[1] + o.m[1] * i.m[3],
      o.m[2] * i.m[0] + o.m[3] * i.m[2], o.m[2] * i.m[1] + o.m[3] * i.m[3],
    ],
    t: [
      o.m[0] * i.t[0] + o.m[1] * i.t[1] + o.t[0],
      o.m[2] * i.t[0] + o.m[3] * i.t[1] + o.t[1],
    ],
  }),
  apply: (mm, p) => [
    mm.m[0] * vx(p) + mm.m[1] * vy(p) + mm.t[0],
    mm.m[2] * vx(p) + mm.m[3] * vy(p) + mm.t[1],
  ],
  reflection: (a, b) => {
    const dx = vx(b) - vx(a);
    const dy = vy(b) - vy(a);
    const len = Math.hypot(dx, dy);
    if (!(len > 0)) throw new Error('tiling: an edge of the cell has no length — a line needs two distinct points');
    const ux = dx / len;
    const uy = dy / len;
    const m: [number, number, number, number] = [ux * ux - uy * uy, 2 * ux * uy, 2 * ux * uy, uy * uy - ux * ux];
    // The line passes through `a`, so the fixed point fixes the shift.
    return { m, t: [vx(a) - (m[0] * vx(a) + m[1] * vy(a)), vy(a) - (m[2] * vx(a) + m[3] * vy(a))] };
  },
  // The plane is its own chart, so the shift IS the seat.
  seat: (m) => m.t,
};

// ---- the sphere -----------------------------------------------------------

/** A spherical isometry: a 3×3 orthogonal matrix on the unit sphere, read
 * through the stereographic chart at both ends. Rows first. */
type Turn = readonly [Sphere, Sphere, Sphere];

const cross = (u: Sphere, v: Sphere): Sphere => [
  u[1] * v[2] - u[2] * v[1],
  u[2] * v[0] - u[0] * v[2],
  u[0] * v[1] - u[1] * v[0],
];

const SPHERE: TileOps<Turn> = {
  identity: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  compose: (o, i) => {
    const row = (r: 0 | 1 | 2): Sphere => [
      o[r][0] * i[0][0] + o[r][1] * i[1][0] + o[r][2] * i[2][0],
      o[r][0] * i[0][1] + o[r][1] * i[1][1] + o[r][2] * i[2][1],
      o[r][0] * i[0][2] + o[r][1] * i[1][2] + o[r][2] * i[2][2],
    ];
    return [row(0), row(1), row(2)];
  },
  apply: (mm, p) => {
    const n = sphereOfChart(p);
    return chartOfSphere([
      mm[0][0] * n[0] + mm[0][1] * n[1] + mm[0][2] * n[2],
      mm[1][0] * n[0] + mm[1][1] * n[1] + mm[1][2] * n[2],
      mm[2][0] * n[0] + mm[2][1] * n[1] + mm[2][2] * n[2],
    ]);
  },
  /** The reflection in the great circle through two chart points: the
   * plane those two and the centre span, mirrored in. */
  reflection: (a, b) => {
    const w = cross(sphereOfChart(a), sphereOfChart(b));
    const len = Math.hypot(w[0], w[1], w[2]);
    if (!(len > 0)) throw new Error('tiling: an edge of the cell has no length — a great circle needs two distinct points');
    const nx = w[0] / len;
    const ny = w[1] / len;
    const nz = w[2] / len;
    return [
      [1 - 2 * nx * nx, -2 * nx * ny, -2 * nx * nz],
      [-2 * ny * nx, 1 - 2 * ny * ny, -2 * ny * nz],
      [-2 * nz * nx, -2 * nz * ny, 1 - 2 * nz * nz],
    ];
  },
  // The pole's image, which is the matrix's third column. Read on the
  // SPHERE: the tile opposite the pole has no chart point, and in the
  // chart its seat would come back as rounding noise instead of one
  // repeatable place.
  seat: (m) => [m[0][2], m[1][2], m[2][2]],
};

// ---- the cells ------------------------------------------------------------

/**
 * The fundamental polygon in each geometry, as the chart radius its
 * vertices sit at.
 *
 * Half the polygon is `2p` right triangles with angles `π/p`, `π/q`,
 * `π/2`, and the one relation `cos R = cot(π/p)·cot(π/q)` — `cosh` in the
 * hyperbolic case — gives the circumradius. Turned into the chart radius
 * that is `tan(R/2)` on the sphere and `tanh(R/2)` in the disk, and both
 * come out as the same square root, `√(∓cos(u + v)/cos(u − v))`, with the
 * sign the geometry itself supplies. The Euclidean case has no such
 * radius — its cells come in every size — so it takes an edge of 1.
 */
function cellOf(geometry: TilingGeometry, p: number, q: number): Vec[] {
  const u = Math.PI / p;
  const v = Math.PI / q;
  const r = geometry === 'euclidean'
    ? 1 / (2 * Math.sin(u))
    : Math.sqrt(Math.abs(Math.cos(u + v)) / Math.cos(u - v));
  return Array.from({ length: p }, (_, k) => {
    const th = (2 * Math.PI * k) / p;
    return [r * Math.cos(th), r * Math.sin(th)] as Vec;
  });
}

// ---- the word -------------------------------------------------------------

/** How far a finite tiling is allowed to flood before it is a mistake: the
 * biggest of them, `{5, 3}`, closes in three generations. */
const CLOSURE = 16;

/**
 * The `{p, q}` tiling in its own geometry, in that geometry's model chart.
 *
 * `depth` is generations of reflection across the cell's edges, 3 by
 * default: depth 1 is the cell and its `p` edge neighbours. A spherical
 * tiling is FINITE — there are only ever 4, 6, 8, 12 or 20 cells — so it
 * is returned whole and `depth` is ignored rather than refused.
 */
export function tiling(p: number, q: number, opts: TilingOpts = {}): Tiling {
  if (!Number.isInteger(p) || !Number.isInteger(q) || p < 3 || q < 3) {
    throw new Error(`tiling: p and q are whole numbers of 3 or more (got ${p}, ${q})`);
  }
  const space = tilingGeometry(p, q);
  const cell = cellOf(space, p, q);
  const depth = space === 'spherical'
    ? CLOSURE
    : opts.depth === undefined ? 3 : Math.floor(opts.depth);
  if (!Number.isFinite(depth) || depth < 0) return { space, cell, placements: [] };
  const placements = space === 'spherical'
    ? tileGroup('tiling', SPHERE, cell, depth).map((m) => (pt: XY) => SPHERE.apply(m, pt))
    : space === 'euclidean'
      ? tileGroup('tiling', PLANE, cell, depth).map((m) => (pt: XY) => PLANE.apply(m, pt))
      : tileGroup('tiling', DISK, cell, depth).map((m) => (pt: XY) => DISK.apply(m, pt));
  return { space, cell, placements };
}
