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
 * The answer is DATA: the fundamental polygon, and one `Placement` per copy
 * of it — an isometry a sketch can hand to `group`, to `m.transform` or to
 * a station — the identity first. This module is pure and knows nothing of
 * the sheet: `t.tiling` is the door a sketch uses, and it hands in the
 * model door and the map that carries the model chart onto the drawable.
 *
 * The model chart is the one the geometry is written in: the unit Poincaré
 * disk for the hyperbolic case, the unit sphere's stereographic chart for
 * the spherical case — the cell about the pole — and the plane with a cell
 * of circumradius `1/(2·sin(π/p))`, an edge of length 1, about the origin.
 */

import { identity, reflection, type ModelDoor, type Placement } from './placement.js';
import type { SpaceKind } from './space.js';
import { tileGroup, type TileOps } from './tilegroup.js';
import type { Vec, XY } from './vec.js';

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
   * One ISOMETRY per copy of the cell, the identity first: `p.point(v)`
   * moves a point, `m.transform(p)` a whole material, `group(p, …)` a
   * whole drawing, and `p.orientation` says which hand the copy has.
   *
   * A stereographic chart has no point for the place opposite its pole, so
   * the spherical copy that lands there is UNBOUNDED in the chart: it is
   * the outside of the picture, and the point at its very centre comes
   * back non-finite. That is the truth about a stereographic picture of a
   * sphere, and every drawing word already reads a non-finite point as
   * "no place". A `'gnomonic'` or `'orthographic'` sketch drops that whole
   * copy, as it drops everything on the far side.
   */
  placements: Placement[];
}

/** `(p − 2)(q − 2)` against 4 is the whole test. */
export function tilingGeometry(p: number, q: number): TilingGeometry {
  const k = (p - 2) * (q - 2);
  return k < 4 ? 'spherical' : k === 4 ? 'euclidean' : 'hyperbolic';
}

// ---- the isometries -------------------------------------------------------

/**
 * ONE answer to `TileOps` for all three geometries: an isometry is a
 * `Placement` over the tiling's own model door, and a reflection in an edge
 * is the reflection in the geodesic through its two ends. The three private
 * motion types this file used to carry — a Möbius record, a plane motion, a
 * 3×3 turn — were one thing written three times.
 *
 * The seat is the MODEL image of the model origin, which is the third
 * column of the placement's matrix. It names the tile in the geometry's own
 * coordinates rather than in a chart, which is what the sphere needs: the
 * tile opposite the pole has no chart point at all, and in a chart its seat
 * would come back as rounding noise instead of one repeatable place.
 */
export function tileOps(door: ModelDoor): TileOps<Placement> {
  return {
    identity: identity(door),
    compose: (outer, inner) => inner.then(outer),
    apply: (m, p) => m.point(p),
    reflection: (a, b) => reflection(door, a, b),
    seat: (m) => [m.m[2], m.m[5], m.m[8]],
  };
}

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
export function cellOf(geometry: TilingGeometry, p: number, q: number): Vec[] {
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
 * The `{p, q}` tiling, placed through one model door.
 *
 * The symbol picks the geometry and builds the fundamental polygon in that
 * geometry's MODEL CHART; `place.up` carries a chart point to wherever the
 * caller is drawing — the sketch's own coordinates when the sketch draws in
 * this very geometry, a picture fitted to the drawable when it does not —
 * and `place.door` is the door of that landing. The flood then runs in
 * those coordinates, so every placement that comes back is an isometry a
 * sketch can hand straight to `group`, `m.transform` or a station.
 *
 * `depth` is generations of reflection across the cell's edges, 3 by
 * default: depth 1 is the cell and its `p` edge neighbours. A spherical
 * tiling is FINITE — there are only ever 4, 6, 8, 12 or 20 cells — so it
 * is returned whole and `depth` is ignored rather than refused.
 */
export function tiling(
  p: number,
  q: number,
  opts: TilingOpts,
  place: { door: ModelDoor; up: (z: XY) => Vec },
): Tiling {
  if (!Number.isInteger(p) || !Number.isInteger(q) || p < 3 || q < 3) {
    throw new Error(`tiling: p and q are whole numbers of 3 or more (got ${p}, ${q})`);
  }
  const space = tilingGeometry(p, q);
  const cell = cellOf(space, p, q).map(place.up);
  const depth = space === 'spherical'
    ? CLOSURE
    : opts.depth === undefined ? 3 : Math.floor(opts.depth);
  if (!Number.isFinite(depth) || depth < 0) return { space, cell, placements: [] };
  return { space, cell, placements: tileGroup('tiling', tileOps(place.door), cell, depth) };
}
