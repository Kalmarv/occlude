/**
 * quadtree: detail where the points are.
 *
 * A cell holding more points than it is allowed splits into four, and its
 * children do the same, until every cell is within its allowance or the
 * subdivision has gone as deep as it may. Where the cloud is dense the cells
 * come out small, where it is sparse they stay large — so a scatter driven by
 * a picture gives a lattice that is fine on the picture's detail and coarse
 * on its flats, without anyone deciding where the detail is.
 *
 * What comes back is the subdivision as ordinary Material: the outer rectangle
 * plus, for every cell that split, the cross that split it. Not four walls per
 * cell — adjacent cells of different sizes would then lay a long edge over two
 * short ones, and a collinear overlap is the one thing `planarize` cannot
 * resolve. Crosses meet their neighbours end-on or at a T, which planarize
 * makes a shared vertex, so `planarize().faces()` gives the cells and
 * `strokes()` draws the lattice.
 *
 * `capacity` is the allowance (1 by default) and `depth` the floor on cell
 * size expressed as splits (12). Both are termination rules: coincident points
 * can never be separated, so without a depth the split would not stop.
 */

import { Material, material as makeMaterial } from './material.js';
import type { Bounds } from './points.js';

export interface QuadtreeOpts {
  /** Points a cell may hold before it splits (default 1). */
  capacity?: number;
  /** How many times a cell may split (default 12). */
  depth?: number;
  /** The rectangle to subdivide (default: the drawable). */
  bounds?: Bounds;
}

export function quadtree(points: Material | Parameters<typeof makeMaterial>[0], bounds: Bounds, opts: QuadtreeOpts = {}): Material {
  const m = makeMaterial(points);
  const capacity = opts.capacity ?? 1;
  if (!Number.isInteger(capacity) || capacity < 1) throw new Error(`quadtree: { capacity } must be a whole number of points, at least 1 (got ${String(opts.capacity)})`);
  const depth = opts.depth ?? 12;
  if (!Number.isInteger(depth) || depth < 0) throw new Error(`quadtree: { depth } must be a non-negative whole number of splits (got ${String(opts.depth)})`);
  // A rectangle with no width or height has no cell to subdivide.
  if (!(bounds.w > 0) || !(bounds.h > 0)) return makeMaterial([]);

  const pts: number[] = [];
  for (let i = 0; i < m.n; i++) {
    if (m.x[i] >= bounds.x && m.x[i] <= bounds.x + bounds.w && m.y[i] >= bounds.y && m.y[i] <= bounds.y + bounds.h) pts.push(i);
  }
  const segments: [[number, number], [number, number]][] = [];
  const wall = (ax: number, ay: number, bx: number, by: number): void => { segments.push([[ax, ay], [bx, by]]); };
  // The outer rectangle, as four walls that meet only at their corners.
  const x1 = bounds.x + bounds.w;
  const y1 = bounds.y + bounds.h;
  wall(bounds.x, bounds.y, x1, bounds.y);
  wall(x1, bounds.y, x1, y1);
  wall(x1, y1, bounds.x, y1);
  wall(bounds.x, y1, bounds.x, bounds.y);

  const split = (x: number, y: number, w: number, h: number, rows: number[], level: number): void => {
    if (rows.length <= capacity || level >= depth) return;
    const cx = x + w / 2;
    const cy = y + h / 2;
    wall(cx, y, cx, y + h);
    wall(x, cy, x + w, cy);
    const q: number[][] = [[], [], [], []];
    for (const i of rows) q[(m.x[i] < cx ? 0 : 1) + (m.y[i] < cy ? 0 : 2)].push(i);
    split(x, y, w / 2, h / 2, q[0], level + 1);
    split(cx, y, w / 2, h / 2, q[1], level + 1);
    split(x, cy, w / 2, h / 2, q[2], level + 1);
    split(cx, cy, w / 2, h / 2, q[3], level + 1);
  };
  split(bounds.x, bounds.y, bounds.w, bounds.h, pts, 0);

  // One row per distinct corner, so walls that meet share a vertex.
  const index = new Map<string, number>();
  const xs: number[] = [];
  const ys: number[] = [];
  const row = (p: [number, number]): number => {
    const key = `${p[0]},${p[1]}`;
    let i = index.get(key);
    if (i === undefined) {
      i = xs.length;
      index.set(key, i);
      xs.push(p[0]);
      ys.push(p[1]);
    }
    return i;
  };
  const edges: [number, number][] = segments.map(([a, b]) => [row(a), row(b)]);
  return new Material(Float64Array.from(xs), Float64Array.from(ys), {}, Uint32Array.from(edges.flat()));
}
