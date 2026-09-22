/**
 * One tiling algorithm for three geometries.
 *
 * A regular tiling is built the same way on the sphere, on the plane and
 * in the hyperbolic disk: take the fundamental polygon, reflect it across
 * its own edges, reflect the results across theirs, and keep going. What
 * differs is only what an isometry IS, and what a reflection in an edge is.
 * That is the whole of `TileOps`, and the flood below is written once
 * against it.
 *
 * Today one type answers it — `Placement`, over the geometry's own model
 * door — so `TileOps` has one implementation and not three. It stays
 * generic because the flood is about reflecting and de-duplicating and
 * nothing else, and because that is what makes the one implementation
 * readable as one.
 *
 * Nothing here knows a Schläfli symbol; `tiling.ts` picks the geometry and
 * builds the cell.
 */

import { finiteCount } from './guard.js';
import type { Vec, XY } from './vec.js';

/** What a geometry has to answer for its tiling to be built. */
export interface TileOps<T> {
  /** The transform that stays put. */
  readonly identity: T;
  /** `outer` after `inner`, as one transform. */
  compose(outer: T, inner: T): T;
  /** The transform as a point map on the geometry's model chart. */
  apply(m: T, p: XY): Vec;
  /** The reflection in the geodesic through two chart points. */
  reflection(a: XY, b: XY): T;
  /**
   * Where the transform puts the cell — the point that NAMES the tile, as
   * coordinates of the geometry itself rather than of the chart.
   *
   * A chart will not do. A sphere's chart has no room for the place
   * opposite the pole, and the tile that lands there would come back as
   * rounding noise instead of one repeatable place. The model has room for
   * every tile, so the seat is read there.
   */
  seat(m: T): readonly number[];
}

/** Tiles are bucketed on the first two coordinates of their seat: coarse
 * enough that two tiles never share a bucket and fine enough to stay
 * cheap. */
const BUCKET = 1e-6;
const bucketKey = (x: number, y: number): string => `${Math.round(x / BUCKET)},${Math.round(y / BUCKET)}`;
/** Two seats this close are the same tile. */
const TOL = 1e-9;

/** The flood's answer: one transform per copy of the cell, and the
 * generation each copy was first reached in — 0 for the cell itself. The
 * two arrays are the same length and the same order. */
export interface TileFlood<T> {
  tiles: T[];
  /** The flood generation of each tile, by the same index. */
  generation: number[];
}

/**
 * The tiling as PLACEMENTS: one transform per copy of `cell`, the identity
 * first, with the generation each was first reached in.
 *
 * The copies are found by reflecting the cell across its own edges, then
 * reflecting the results across theirs, out to `depth` generations — so
 * `depth` is a stated count of generations, not a cap. Depth 1 is the cell
 * and its edge neighbours. The copies at ODD generations turn the plane
 * over, because a reflection does; a motif with a hand to it comes out
 * left-handed in those.
 *
 * A finite geometry closes on itself: the flood then runs out of new tiles
 * on its own and stops early, whatever `depth` says. Two transforms that
 * put the cell in the same place are one transform.
 */
export function tileGroup<T>(who: string, ops: TileOps<T>, cell: readonly Vec[], depth: number): TileFlood<T> {
  const n = cell.length;
  if (n < 3) return { tiles: [], generation: [] };
  const mirrors = cell.map((v, i) => ops.reflection(v, cell[(i + 1) % n]));
  const out: T[] = [ops.identity];
  const generation: number[] = [0];
  // Where each accepted transform puts the cell, bucketed: that seat names
  // the tile, and one tile takes one placement.
  const seen = new Map<string, (readonly number[])[]>();
  const place = (m: T): boolean => {
    const o = ops.seat(m);
    for (const c of o) if (!Number.isFinite(c)) return false;
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const near = seen.get(bucketKey(o[0] + i * BUCKET, o[1] + j * BUCKET));
        if (near && near.some((c) => Math.hypot(...c.map((v, k) => v - o[k])) < TOL)) return false;
      }
    }
    const key = bucketKey(o[0], o[1]);
    const cellSeen = seen.get(key);
    if (cellSeen) cellSeen.push(o);
    else seen.set(key, [o]);
    return true;
  };
  place(out[0]);
  let frontier = out.slice();
  for (let g = 0; g < depth; g++) {
    const next: T[] = [];
    for (const m of frontier) {
      for (const r of mirrors) {
        const candidate = ops.compose(m, r);
        if (!place(candidate)) continue;
        next.push(candidate);
        out.push(candidate);
        generation.push(g + 1);
        // A depth nobody meant to ask for stops here, by name.
        finiteCount(who, out.length);
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }
  return { tiles: out, generation };
}
