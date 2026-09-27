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
 * What comes back is the subdivision as ordinary Material whose FACES ARE
 * THE CELLS, every one of them from the root to the leaves, breadth-first:
 * the root is `faces.at(0)`, a cell's `children` are its four quadrants,
 * `parent`, `depth` and `leaf` say where it sits, and the leaves are the
 * partition, `faces.filter((f) => f.leaf)`. A cell's `source` is the points
 * it holds, as a selection of the input. The walls are the outer rectangle
 * and, for every cell that split, the cross that split it, with a shared
 * vertex wherever a cross meets a wall end-on or at a T, so `strokes()`
 * draws the lattice and each wall once.
 *
 * `capacity` is the allowance (1 by default) and `depth` the floor on cell
 * size expressed as splits (12). Both are termination rules: coincident points
 * can never be separated, so without a depth the split would not stop.
 */

import { Material, material as makeMaterial, withFaces, withinMaterial, type Vertex } from './material.js';
import { withinRegion, type Bounds } from './points.js';
import { planarize, walkRuns } from './faces.js';
import { isPointSelection, pointsOf } from './relation.js';
import type { Selection } from './selection.js';
import type { AreaInput } from './boundary.js';

export interface QuadtreeOpts {
  /** Points a cell may hold before it splits (default 1). */
  capacity?: number;
  /** How many times a cell may split (default 12). */
  depth?: number;
  /** The area to subdivide (default: the drawable). The subdivision runs
   * over the area's box and counts the points inside the area; any other
   * area than a rectangle then cuts the lattice at its boundary, and the
   * cut cells close along it. */
  within?: AreaInput;
}

/** One cell of the subdivision: its rectangle, the input rows it holds,
 * and its four quadrants when it split. */
interface Cell {
  x: number;
  y: number;
  w: number;
  h: number;
  rows: number[];
  children: Cell[] | null;
  /** The walk's regions that fall in this cell, when it is a leaf. */
  runs: number[][];
}

/** The subdivision of `drawable`, or of `opts.within` when given. */
export function quadtree(points: Material | Selection<Vertex> | Parameters<typeof makeMaterial>[0], drawable: Bounds, opts: QuadtreeOpts = {}): Material {
  if ('bounds' in opts) throw new Error('quadtree: bounds is now within — a rect is an area: { within: rect(…) } or { within: t.bounds() }');
  const capacity = opts.capacity ?? 1;
  if (!Number.isInteger(capacity) || capacity < 1) throw new Error(`quadtree: { capacity } must be a whole number of points, at least 1 (got ${String(opts.capacity)})`);
  const depth = opts.depth ?? 12;
  if (!Number.isInteger(depth) || depth < 0) throw new Error(`quadtree: { depth } must be a non-negative whole number of splits (got ${String(opts.depth)})`);
  const region = opts.within === undefined ? null : withinRegion(opts.within, 'quadtree');
  const bounds = region?.bounds ?? drawable;
  // A rectangle with no width or height has no cell to subdivide.
  if (!(bounds.w > 0) || !(bounds.h > 0)) return makeMaterial([]);
  // The points a cell holds are rows of the INPUT: a point selection's own
  // material, in the selection's order, or the material itself.
  const base: Material = isPointSelection(points) ? points.owner : makeMaterial(points as Parameters<typeof makeMaterial>[0]);
  const candidates: readonly number[] = isPointSelection(points) ? points.indices : Array.from({ length: base.n }, (_, i) => i);
  const loops = region?.loops ?? null;
  const x1 = bounds.x + bounds.w;
  const y1 = bounds.y + bounds.h;
  const held: number[] = [];
  for (const i of candidates) {
    const x = base.x[i];
    const y = base.y[i];
    if (!(x >= bounds.x && x <= x1 && y >= bounds.y && y <= y1)) continue;
    if (loops && !insideLoops(loops, x, y)) continue;
    held.push(i);
  }

  const segments: [[number, number], [number, number]][] = [];
  const wall = (ax: number, ay: number, bx: number, by: number): void => { segments.push([[ax, ay], [bx, by]]); };
  // The outer rectangle, as four walls that meet only at their corners.
  wall(bounds.x, bounds.y, x1, bounds.y);
  wall(x1, bounds.y, x1, y1);
  wall(x1, y1, bounds.x, y1);
  wall(bounds.x, y1, bounds.x, bounds.y);

  const split = (cell: Cell, level: number): void => {
    if (cell.rows.length <= capacity || level >= depth) return;
    const { x, y, w, h } = cell;
    const cx = x + w / 2;
    const cy = y + h / 2;
    wall(cx, y, cx, y + h);
    wall(x, cy, x + w, cy);
    const q: number[][] = [[], [], [], []];
    for (const i of cell.rows) q[(base.x[i] < cx ? 0 : 1) + (base.y[i] < cy ? 0 : 2)].push(i);
    cell.children = [
      { x, y, w: w / 2, h: h / 2, rows: q[0], children: null, runs: [] },
      { x: cx, y, w: w / 2, h: h / 2, rows: q[1], children: null, runs: [] },
      { x, y: cy, w: w / 2, h: h / 2, rows: q[2], children: null, runs: [] },
      { x: cx, y: cy, w: w / 2, h: h / 2, rows: q[3], children: null, runs: [] },
    ];
    for (const c of cell.children) split(c, level + 1);
  };
  const root: Cell = { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h, rows: held, children: null, runs: [] };
  split(root, 0);

  // One row per distinct corner, so walls that meet share a vertex; a
  // cross that ends on a longer wall shares a vertex with it after the
  // planarize.
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
  const walls = planarize(new Material(Float64Array.from(xs), Float64Array.from(ys), {}, Uint32Array.from(edges.flat())));
  const m = loops ? withinMaterial(walls, loops) : walls;
  if (m.edgeCount === 0) return m;

  // The regions the walls enclose, read off the picture once, each handed
  // to the leaf it lies in: the cells are rectangles, so a point inside a
  // region names its leaf by descending the tree.
  for (const runs of walkRuns(m)) {
    const at = interiorPoint(runs.map((run) => run.map((v) => [m.x[v], m.y[v]] as [number, number])));
    if (!at) continue;
    let cell = root;
    while (cell.children) {
      const cx = cell.x + cell.w / 2;
      const cy = cell.y + cell.h / 2;
      cell = cell.children[(at[0] < cx ? 0 : 1) + (at[1] < cy ? 0 : 2)];
    }
    cell.runs.push(...runs);
  }
  // A cell is a face when some region lies in it. Breadth-first from the
  // root, so every parent comes before its children.
  const kept = (c: Cell): boolean => (c.children ? c.children.some(kept) : c.runs.length > 0);
  const cycles: number[][][] = [];
  const parent: number[] = [];
  const sources: number[][] = [];
  const queue: { cell: Cell; parent: number }[] = kept(root) ? [{ cell: root, parent: -1 }] : [];
  for (let k = 0; k < queue.length; k++) {
    const { cell, parent: p } = queue[k];
    cycles.push(cell.children ? [] : cell.runs);
    parent.push(p);
    sources.push(cell.rows);
    if (cell.children) for (const c of cell.children) if (kept(c)) queue.push({ cell: c, parent: k });
  }
  return withFaces(m, { cycles, parent: Int32Array.from(parent), source: (f) => pointsOf(base, sources[f], undefined, true) });
}

/** Even-odd containment in a set of loops. */
function insideLoops(loops: readonly (readonly (readonly [number, number])[])[], x: number, y: number): boolean {
  let odd = false;
  for (const pts of loops) {
    for (let k = 0, j = pts.length - 1; k < pts.length; j = k++) {
      const [xi, yi] = pts[k];
      const [xj, yj] = pts[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) odd = !odd;
    }
  }
  return odd;
}

/** A point strictly inside a region given as loops (the outer first):
 * the outer loop's centroid when that is inside, else the first of a fine
 * grid over its box that is. */
function interiorPoint(loops: readonly (readonly (readonly [number, number])[])[]): [number, number] | null {
  const outer = loops[0];
  let a2 = 0;
  let cx = 0;
  let cy = 0;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let k = 0; k < outer.length; k++) {
    const [ax, ay] = outer[k];
    const [bx, by] = outer[(k + 1) % outer.length];
    const cross = ax * by - bx * ay;
    a2 += cross;
    cx += (ax + bx) * cross;
    cy += (ay + by) * cross;
    x0 = Math.min(x0, ax);
    y0 = Math.min(y0, ay);
    x1 = Math.max(x1, ax);
    y1 = Math.max(y1, ay);
  }
  if (a2 !== 0 && insideLoops(loops, cx / (3 * a2), cy / (3 * a2))) return [cx / (3 * a2), cy / (3 * a2)];
  const n = 16;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = x0 + ((i + 0.5) / n) * (x1 - x0);
      const y = y0 + ((j + 0.5) / n) * (y1 - y0);
      if (insideLoops(loops, x, y)) return [x, y];
    }
  }
  return null;
}
