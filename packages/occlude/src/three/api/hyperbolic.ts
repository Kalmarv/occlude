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
 * flat plane, so a hyperbolic polyhedron is an ordinary mesh and a
 * hyperbolic segment is a two-point wire. An isometry moves the ball
 * projectively, so a chord stays a chord after `transform`.
 *
 * The price is length. Klein coordinates are not hyperbolic lengths, and
 * they shrink toward the rim: a point at hyperbolic distance `R` from the
 * centre of the ball sits at Klein radius `tanh R`. `geodesic3` is the one
 * word here that counts in hyperbolic length.
 *
 * The isometries are `Placement3` values (placement3.ts); the 4×4 Lorentz
 * matrices under them stay internal.
 */

import {
  camera as cameraRecord,
  geodesic as geodesicPoints,
  honeycombComplex,
} from '../../hyperbolicSpace.js';
import {surface3,type Surface3} from '../geometry/surface.js';
import {mesh,CurveGeometry,type Mesh} from './mesh.js';
import {placement3,type Placement3} from './placement3.js';
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

/** One shared vertex of a honeycomb, in Klein coordinates. `id` is the id
 * the same point has in `wires`. */
export interface HoneycombPoint {
  readonly id: string;
  readonly index: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** The columns every edge of a honeycomb carries, in `wires`. */
export type HoneycombEdgeColumns = {
  /** The index of the lowest copy that has this edge. */
  cell: number;
  /** The flood generation of that copy: the lowest among its walls. */
  generation: number;
};

/** One wall of a honeycomb, once, however many copies share it. */
export interface HoneycombFace {
  readonly id: string;
  readonly index: number;
  /** The wall as a loop of `points` indices, wound as its owner winds it. */
  readonly vertices: readonly number[];
  /** The index of the copy that first owns the wall: the lowest generation. */
  readonly cell: number;
  /** The flood generation of that copy. */
  readonly generation: number;
  /** That copy turns space over: its placement's `orientation` is −1. */
  readonly mirrored: boolean;
}

/**
 * A regular honeycomb, as a CELL COMPLEX: shared vertices, each wall once,
 * each edge once.
 *
 * It is not a `Mesh`. A mesh is a surface, where an edge has one wall on
 * each side; inside a honeycomb `r` walls meet at every edge. So the
 * complex answers what it holds: its `points` and its `faces` as rows, its
 * edges as `wires`, and the `cell` and `placements` it was made from.
 */
export interface Honeycomb {
  /** The regular cell, centred on the centre of the ball, as a closed
   * mesh. Its faces are wound outward. */
  readonly cell: Mesh;
  /** One placement per copy of the cell, the identity first, in flood
   * order. */
  readonly placements: readonly Placement3[];
  /** Every vertex of the complex, once. */
  readonly points: readonly HoneycombPoint[];
  /** Every wall of the complex, once. */
  readonly faces: readonly HoneycombFace[];
  /** Every edge of the complex, once, as a two-point wire with the edge
   * columns `cell` and `generation`. A Klein chord IS the geodesic, so the
   * two ends draw it. The points are `points`, id for id. */
  readonly wires: CurveGeometry<{}, HoneycombEdgeColumns>;
}

/**
 * The `{p, q, r}` honeycomb: the regular cell with `r` of them around
 * every edge, reflected out to `depth` generations, as one complex.
 *
 * Four symbols have a compact cell in hyperbolic space — `{4, 3, 5}`,
 * `{5, 3, 4}`, `{3, 5, 3}` and `{5, 3, 5}` — and every other one refuses
 * by name, naming the geometry it belongs to instead: `{4, 3, 4}` is
 * Euclidean and `{3, 3, 5}` is spherical.
 *
 * The copies are found by reflecting the cell in its own walls, then
 * reflecting those in theirs, out to `depth` generations: depth 1 is the
 * cell and its face neighbours. Two corners are one vertex when their
 * images agree on the hyperboloid; a wall two copies share is one face,
 * with the copy and the generation that reached it first. The copies at
 * odd generations turn space over, because a reflection does, and their
 * walls say so in `mirrored`.
 */
export function honeycomb(p: number, q: number, r: number, options: HoneycombOptions = {}): Honeycomb {
  const complex = honeycombComplex(p, q, r, options);
  const id = (i: number): string => `p${i}`;
  const edges = complex.edges.map(({ vertices: [a, b], cell, generation }) => ({ id: `e:${id(a)}:${id(b)}`, vertices: [a, b] as [number, number], faces: [], attributes: { cell, generation } }));
  const wires: Surface3 = { ...surface3(complex.points, []), edges };
  return Object.freeze({
    cell: mesh(complex.cell.points, complex.cell.faces),
    placements: Object.freeze(complex.copies.map((c) => placement3(c.transform))),
    points: Object.freeze(complex.points.map(([x, y, z], index) => Object.freeze({ id: id(index), index, x, y, z }))),
    faces: Object.freeze(complex.faces.map((f, index) => Object.freeze({ id: `f${index}`, index, vertices: f.vertices, cell: f.cell, generation: f.generation, mirrored: f.mirrored }))),
    wires: new CurveGeometry<{}, HoneycombEdgeColumns>(wires, edges.map((_, i) => i)),
  });
}

/**
 * The observer: the placement that moves `eye` to the centre of the ball
 * and points `target` along `+Y`, with `up` along `+Z`.
 *
 * A hyperbolic observer's view is an ordinary perspective picture taken at
 * the CENTRE of the Klein ball. The model is true to angle there, so the
 * angles the observer sees are the angles hyperbolic space really has.
 * Everywhere else in the ball the angles are the model's, not space's,
 * which is why the scene is moved to the observer and not the other way
 * round.
 *
 * The sketch moves the whole scene through it and then takes a plain camera
 * at the centre:
 *
 *     const seen = observer([0.05, -0.08, 0.1], [0.8, 0, 0]);
 *     view(h.wires.transform(seen), { camera: perspective({ eye: [0, 0, 0], target: [0, 1, 0], fovDegrees: 100 }) })
 *
 * A copy's placement is a placement too, so `place.then(seen)` does both.
 *
 * `up` is a direction at `eye`, not a point; it defaults to the world's
 * `[0, 0, 1]`. An `up` along the line of sight names no frame and refuses
 * by name.
 */
export function observer(eye: Vec3, target: Vec3, options: ObserverOptions = {}): Placement3 {
  return placement3(cameraRecord(eye, target, options));
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
