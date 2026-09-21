/**
 * Hyperbolic SPACE for the 3D words — the interim home.
 *
 * In 2D the geometry a sketch draws in is a frame setting: `space:
 * 'hyperbolic'` and every word reads it. `view` does not take a space yet,
 * so the three words a hyperbolic scene needs live here, spelled bare like
 * every other 3D word. When the 3D frame lands they fold into it, exactly
 * as the disk words folded into `space` and `t.tiling`.
 *
 * Everything is in BELTRAMI–KLEIN coordinates: the unit ball of `[x, y,
 * z]`, whose rim is infinitely far away. In that model a hyperbolic
 * straight line is an ordinary chord and a hyperbolic plane is an ordinary
 * flat plane, so a hyperbolic polyhedron is an ordinary mesh — `mesh(cell.
 * points, cell.faces)` takes one, and the exact hidden-line classifier
 * reads it with no word of its own here.
 *
 * The price is length. Klein coordinates are not hyperbolic lengths, and
 * they shrink toward the rim: a point at hyperbolic distance `R` from the
 * centre of the ball sits at Klein radius `tanh R`. `geodesic3` is the one
 * word here that counts in hyperbolic length.
 *
 * The isometries themselves — 4×4 Lorentz matrices on `[x, y, z, t]` —
 * stay internal. A sketch holds POINT MAPS, which is what `mesh.map`,
 * `polyline` and every other consumer already take, and composes them the
 * way it composes any other function.
 */

import {
  camera as cameraRecord,
  geodesic as geodesicPoints,
  honeycomb as honeycombRecords,
  map as pointMap,
  polyhedron,
  type HyperbolicCell,
} from '../../hyperbolicSpace.js';

export type { HyperbolicCell };
import type { Vec3 } from '../math.js';

export interface HoneycombOptions {
  /** Generations of neighbours to reflect out to. Depth 0 is the
   * fundamental cell alone; depth 1 adds its face neighbours. */
  depth?: number;
}

export interface Geodesic3Options {
  /** Pieces along the segment; the result has `count + 1` points. */
  count?: number;
}

export interface ObserverOptions {
  /** Which way is up, as a direction at `eye` in Klein coordinates.
   * Default `[0, 0, 1]`, the world's own up. */
  up?: Vec3;
}

/** One regular honeycomb: its cell, and where the copies of it go. */
export interface Honeycomb {
  /** The regular cell, in Klein coordinates: what `mesh(points, faces)`
   * takes. The faces are wound outward, and each one is a flat polygon,
   * because a hyperbolic plane is flat in this model. */
  cell: HyperbolicCell;
  /** One point map per copy of the cell, the identity first. */
  placements: ((p: Vec3) => Vec3)[];
}

/**
 * The `{p, q, r}` honeycomb: the regular cell with `r` of them around
 * every edge, and one placement for each copy of it, the identity first.
 *
 * Four symbols have a compact cell in hyperbolic space — `{4, 3, 5}`,
 * `{5, 3, 4}`, `{3, 5, 3}` and `{5, 3, 5}` — and every other one refuses
 * by name, naming the geometry it belongs to instead: `{4, 3, 4}` is
 * Euclidean and `{3, 3, 5}` is spherical.
 *
 * The copies are found by reflecting the cell in its own walls, then
 * reflecting those in theirs, out to `depth` generations: depth 1 is the
 * cell and its face neighbours. The sketch builds the cell ONCE and maps
 * its points through each placement. The copies at odd generations turn
 * space over, because a reflection does.
 */
export function honeycomb(p: number, q: number, r: number, options: HoneycombOptions = {}): Honeycomb {
  return {
    cell: polyhedron(p, q, r),
    placements: honeycombRecords(p, q, r, options).map(pointMap),
  };
}

/**
 * The observer: the point map that moves `eye` to the centre of the ball
 * and points `target` along `+Y`, with `up` along `+Z`.
 *
 * A hyperbolic observer's view is an ordinary perspective picture taken at
 * the CENTRE of the Klein ball. The model is true to angle there, so the
 * angles the observer sees are the angles hyperbolic space really has.
 * Everywhere else in the ball the angles are the model's, not space's,
 * which is why the scene is moved to the observer and not the other way
 * round.
 *
 * The sketch maps the whole scene through it and then takes a plain camera
 * at the centre:
 *
 *     const eye = observer([0.05, -0.08, 0.1], [0.8, 0, 0]);
 *     view(cells, { camera: perspective({ eye: [0, 0, 0], target: [0, 1, 0], fovDegrees: 100 }) })
 *
 * with every point of every cell already through `eye`. A placement is a
 * point map too, so `(v) => eye(place(v))` does both in one pass.
 *
 * `up` is a direction at `eye`, not a point; it defaults to the world's
 * `[0, 0, 1]`. An `up` along the line of sight names no frame and refuses
 * by name.
 */
export function observer(eye: Vec3, target: Vec3, options: ObserverOptions = {}): (p: Vec3) => Vec3 {
  return pointMap(cameraRecord(eye, target, options));
}

/**
 * The straight segment from `a` to `b`, as points.
 *
 * In this model a hyperbolic straight line IS the chord, so two points
 * would draw it. The samples are here for a reason of their own: they are
 * evenly spaced in HYPERBOLIC arc length, not along the chord. Near the
 * centre the two agree; toward the rim the hyperbolic spacing crowds the
 * Euclidean samples into the last little piece of the chord, because that
 * piece is most of the length.
 *
 * The first point is exactly `a` and the last is exactly `b`.
 */
export function geodesic3(a: Vec3, b: Vec3, options: Geodesic3Options = {}): Vec3[] {
  return geodesicPoints(a, b, options);
}
