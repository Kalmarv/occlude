/**
 * Curves with attributes — geometry you can hold, step, and reinterpret.
 *
 * A `Curve` is an ordered chain of vertices (closed by default) whose
 * positions and attributes live in named columns: `x`, `y`, and whatever
 * the sketch declares (`age`, `energy`, …). Connectivity is the order.
 * Curves are values: every operation returns a new one and leaves its
 * input intact, so a whole evolution can be kept and any iteration
 * chosen later.
 *
 * Extracted from the ring-growth study (2026-09-06), where writing the
 * rule directly against raw arrays showed which bookkeeping deserved a
 * home: neighbour search prepared once per state (`neighbours`), the
 * current-state/next-state discipline with attribute-preserving edits
 * (`curve.steps()`), edge splitting that reconnects the ring, and turning a
 * per-vertex attribute into strokes without rewriting the wrap-around
 * (`segmentRuns`). Underneath sits a small numerical vocabulary (`add`,
 * `sub`, `mul`, `length`, `unit`, `limit`, `sum`, `sumBy`, …) so a rule is
 * vector math, not dx/dy bookkeeping; the forces (`tension`,
 * `separation`) are recipes written on it — read them, copy one into a
 * sketch, change it.
 *
 * Everything here is pure — no seed, no paper. A rule that wants seeded
 * randomness or noise closes over the toolkit (`t.chance`, `t.noise`);
 * a rule that wants the initial outline of a shape asks `t.sample`.
 */

import type { IsoContour } from './isolines.js';

export type XY = [number, number] | { x: number; y: number };

/** A vertex view: its row `index` in THIS state, position, and every
 * attribute column. A plain snapshot, valid for the curve it came from —
 * not a persistent identity: insertion renumbers later states. */
export type Vertex = { index: number; x: number; y: number } & Record<string, number>;

export interface Edge {
  /** Vertex views at the edge's ends, in curve order. */
  a: Vertex;
  b: Vertex;
  length: number;
}

const asXY = (p: XY): [number, number] => (Array.isArray(p) ? [p[0], p[1]] : [p.x, p.y]);

/** One captured state of a `steps()` run: which iteration it is, and the
 * curve as it was then. Never touched by later steps. */
export interface Snapshot {
  iteration: number;
  curve: Curve;
}

export class Curve {
  readonly n: number;
  readonly closed: boolean;
  readonly x: Float64Array;
  readonly y: Float64Array;
  /** Attribute columns by name, each `n` long. */
  readonly attrs: Readonly<Record<string, Float64Array>>;
  /** How many `steps()` iterations produced this state (0 for a fresh
   * `curve()`); `steps()` continues the count. */
  readonly iteration: number;
  /** States captured by the `steps()` call that made this curve — empty
   * unless it asked for `{ every }`. Iteration 0 of that call, every
   * `every`-th iteration after it, and the final one, each once, oldest
   * first. Snapshots carry no history of their own. */
  readonly history: readonly Snapshot[];

  /** @internal Use `curve()`; columns are adopted, not copied. The library
   * never writes to a curve's columns after construction — every step
   * builds new ones — so a snapshot stays what it was. (Typed arrays
   * cannot be frozen; a sketch that writes `c.x[i] = …` is editing a
   * value it was given, on its own head.) */
  constructor(
    x: Float64Array,
    y: Float64Array,
    attrs: Record<string, Float64Array>,
    closed: boolean,
    iteration = 0,
    history: readonly Snapshot[] = [],
  ) {
    if (x.length !== y.length) throw new Error('curve: x and y columns differ in length');
    for (const [name, col] of Object.entries(attrs)) {
      if (col.length !== x.length) {
        throw new Error(`curve: attribute '${name}' has ${col.length} values for ${x.length} vertices`);
      }
      if (name === 'x' || name === 'y' || name === 'index') {
        throw new Error(`curve: '${name}' is a reserved vertex field`);
      }
    }
    this.n = x.length;
    this.closed = closed;
    this.x = x;
    this.y = y;
    this.attrs = attrs;
    this.iteration = iteration;
    this.history = history;
    Object.freeze(this.attrs);
    Object.freeze(this.history);
    Object.freeze(this);
  }

  /**
   * THE iteration operation. Run `rule` `n` times and return the final
   * curve, ready for further operations. `rule(current, next, k)` reads
   * `current` (frozen) and describes `next`, which starts as a copy:
   * `next.move(index, [dx, dy])` displaces, `next.set(index, { age })`
   * writes attributes, `next.splitEdges(where, { at?, attributes })`
   * inserts vertices on the MOVED edges — moves apply first, then `where`
   * sees each edge as it will be — and every attribute of an inserted
   * vertex must be given. `k` counts from 0 within this call. Growth,
   * relaxation and erosion are different rules for this one verb;
   * `.steps(1, rule)` is a single transition.
   *
   * By default only the final state is kept. `{ every: m }` also captures
   * iteration 0, every m-th iteration, and the final one (no duplicates)
   * on the result's `history`, each labelled with its iteration number.
   * Nothing a later step does can disturb an earlier snapshot.
   */
  steps(
    n: number,
    rule: (current: Curve, next: Next, k: number) => void,
    opts: { every?: number } = {},
  ): Curve {
    const every = opts.every !== undefined ? Math.max(1, Math.floor(opts.every)) : 0;
    const snaps: Snapshot[] = [];
    const base = new Curve(this.x, this.y, { ...this.attrs }, this.closed, this.iteration);
    if (every) snaps.push({ iteration: this.iteration, curve: base });
    let cur = base;
    for (let k = 0; k < n; k++) {
      cur = stepOnce(cur, k, rule);
      if (every && (k + 1) % every === 0 && k + 1 < n) snaps.push({ iteration: cur.iteration, curve: cur });
    }
    if (every && n > 0) snaps.push({ iteration: cur.iteration, curve: cur });
    return every ? new Curve(cur.x, cur.y, { ...cur.attrs }, cur.closed, cur.iteration, snaps) : cur;
  }

  /** Names of the attribute columns. */
  get attrNames(): string[] {
    return Object.keys(this.attrs);
  }

  /** The vertex at index `i` as a plain view. */
  vertex(i: number): Vertex {
    const v: Record<string, number> = { index: i, x: this.x[i], y: this.y[i] };
    for (const name in this.attrs) v[name] = this.attrs[name][i];
    return v as Vertex;
  }

  /** Every vertex as a view, in order. */
  get points(): Vertex[] {
    const out: Vertex[] = new Array(this.n);
    for (let i = 0; i < this.n; i++) out[i] = this.vertex(i);
    return out;
  }

  /** Positions as tuples — what `stroke`, `polygon`, `distanceTo` eat. */
  get pts(): [number, number][] {
    const out: [number, number][] = new Array(this.n);
    for (let i = 0; i < this.n; i++) out[i] = [this.x[i], this.y[i]];
    return out;
  }

  /** The curve as a stampable contour: `stroke(curve.contour)`. */
  get contour(): IsoContour {
    return { pts: this.pts, closed: this.closed };
  }

  /** Index of the vertex before `i` in curve order; -1 at the start of an
   * open curve. */
  prev(i: number): number {
    return i > 0 ? i - 1 : this.closed ? this.n - 1 : -1;
  }

  /** Index of the vertex after `i`; -1 at the end of an open curve. */
  next(i: number): number {
    return i < this.n - 1 ? i + 1 : this.closed ? 0 : -1;
  }

  /** Every edge (a → b) in curve order; a closed curve's last edge wraps. */
  get edges(): Edge[] {
    const out: Edge[] = [];
    const m = this.closed ? this.n : this.n - 1;
    for (let i = 0; i < m; i++) {
      const j = this.next(i);
      const a = this.vertex(i);
      const b = this.vertex(j);
      out.push({ a, b, length: Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2) });
    }
    return out;
  }
}

/**
 * A curve from positions, with optional attribute columns given as one
 * constant per vertex (`{ age: 0 }`) or a full column (`{ age: [...] }`).
 * Closed unless `closed: false`.
 */
export function curve(
  pts: readonly XY[],
  opts: { closed?: boolean } & Record<string, number | ArrayLike<number> | boolean | undefined> = {},
): Curve {
  const n = pts.length;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const [px, py] = asXY(pts[i]);
    x[i] = px;
    y[i] = py;
  }
  const attrs: Record<string, Float64Array> = {};
  let closed = true;
  for (const [name, value] of Object.entries(opts)) {
    if (name === 'closed') {
      closed = value !== false;
      continue;
    }
    if (value === undefined) continue;
    if (typeof value === 'number') {
      attrs[name] = new Float64Array(n).fill(value);
    } else if (typeof value === 'boolean') {
      throw new Error(`curve: attribute '${name}' must be numeric`);
    } else {
      attrs[name] = Float64Array.from(value as ArrayLike<number>);
    }
  }
  return new Curve(x, y, attrs, closed);
}

// ---- numerical vocabulary ---------------------------------------------------
//
// Small, 2D, and ignorant of pens, growth, and occlusion. Vectors are
// tuples `[x, y]`; inputs accept either spelling (`[x, y]` or `{x, y}`)
// so a vertex view can go straight into `sub(q, p)`; results are ALWAYS
// fresh tuples — nothing here mutates an argument or shares scratch
// storage. `unit` of a zero-length vector is the zero vector, so
// coincident points contribute no direction (and no NaN).

export type Vec = [number, number];

const vx = (p: XY): number => (Array.isArray(p) ? p[0] : p.x);
const vy = (p: XY): number => (Array.isArray(p) ? p[1] : p.y);

export function add(a: XY, b: XY): Vec {
  return [vx(a) + vx(b), vy(a) + vy(b)];
}

/** `a - b`: the vector from `b` to `a`. */
export function sub(a: XY, b: XY): Vec {
  return [vx(a) - vx(b), vy(a) - vy(b)];
}

export function mul(v: XY, k: number): Vec {
  return [vx(v) * k, vy(v) * k];
}

export function length(v: XY): number {
  const x = vx(v);
  const y = vy(v);
  return Math.sqrt(x * x + y * y);
}

export function distance(a: XY, b: XY): number {
  return length(sub(a, b));
}

/** `v / |v|`, or `[0, 0]` when `|v|` is zero. */
export function unit(v: XY): Vec {
  const d = length(v);
  return d > 0 ? [vx(v) / d, vy(v) / d] : [0, 0];
}

/** `v` shortened to `max` if it is longer; unchanged otherwise. The usual
 * guard on a per-step displacement — a rule that can sum many strong
 * pushes stays stable when no step may exceed, say, half the split length. */
export function limit(v: XY, max: number): Vec {
  const d = length(v);
  return d > max && d > 0 ? [(vx(v) / d) * max, (vy(v) / d) * max] : [vx(v), vy(v)];
}

/** `v` turned a quarter turn counter-clockwise (y down: visually clockwise). */
export function perp(v: XY): Vec {
  return [-vy(v), vx(v)];
}

/** Component-wise sum of any number of vectors, left to right. */
export function sum(...vs: readonly XY[]): Vec {
  let x = 0;
  let y = 0;
  for (const v of vs) {
    x += vx(v);
    y += vy(v);
  }
  return [x, y];
}

/** `sum(items.map(fn))` without the intermediate array: the vector total
 * of a user function over a collection, accumulated in order. */
export function sumBy<T>(items: Iterable<T>, fn: (item: T, index: number) => XY): Vec {
  let x = 0;
  let y = 0;
  let i = 0;
  for (const item of items) {
    const v = fn(item, i++);
    x += vx(v);
    y += vy(v);
  }
  return [x, y];
}

// ---- spatial neighbours -------------------------------------------------------

/**
 * Spatial neighbours of the curve's vertices, prepared ONCE for the state
 * as it is now: a uniform grid over the current positions. The returned
 * query gives the indices of every vertex within `radius` of `p`, self
 * excluded, in grid order — the sketch decides what to do with them
 * (topological neighbours, `c.prev(i)`/`c.next(i)`, are a different
 * concept and are NOT excluded here). Indices are valid for this state.
 */
export interface NeighbourStats {
  queries: number;
  /** Vertices examined from the grid cells around the query point. */
  candidates: number;
  /** Of those, within the radius. */
  hits: number;
}

export function neighbours(
  c: Curve,
  opts: { radius: number; stats?: NeighbourStats },
): (p: Vertex) => number[] {
  const radius = opts.radius;
  const stats = opts.stats;
  const cell = radius;
  const grid = new Map<number, number[]>();
  const key = (gx: number, gy: number) => gx * 65536 + gy;
  for (let i = 0; i < c.n; i++) {
    const k = key(Math.floor(c.x[i] / cell), Math.floor(c.y[i] / cell));
    const bucket = grid.get(k);
    if (bucket) bucket.push(i);
    else grid.set(k, [i]);
  }
  return (p: Vertex): number[] => {
    const out: number[] = [];
    const cx = Math.floor(p.x / cell);
    const cy = Math.floor(p.y / cell);
    if (stats) stats.queries++;
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        const bucket = grid.get(key(gx, gy));
        if (!bucket) continue;
        if (stats) stats.candidates += bucket.length;
        for (const j of bucket) {
          if (j === p.index) continue;
          const dx = p.x - c.x[j];
          const dy = p.y - c.y[j];
          if (dx * dx + dy * dy < radius * radius) out.push(j);
        }
      }
    }
    if (stats) stats.hits += out.length;
    return out;
  };
}

// ---- force recipes ----------------------------------------------------------
//
// Ordinary functions on the vocabulary above. Copy one into a sketch and
// change the falloff, the direction, the weighting; nothing registers them.

/**
 * Chain tension: pull `p` toward each curve neighbour by the part of the
 * gap beyond `rest` — a slack chain, not a rubber band.
 */
export function tension(c: Curve, p: Vertex, opts: { rest: number }): Vec {
  return sumBy([c.prev(p.index), c.next(p.index)], (j) => {
    if (j < 0) return [0, 0];
    const delta = sub(c.vertex(j), p);
    return mul(unit(delta), Math.max(0, length(delta) - opts.rest));
  });
}

/**
 * Separation: push `p` away from every spatial neighbour within
 * `radius` (from a `neighbours()` query prepared for this state), falling
 * off linearly to zero at the radius. Curve neighbours are skipped —
 * tension owns that spacing.
 */
export function separation(
  c: Curve,
  p: Vertex,
  near: (p: Vertex) => number[],
  opts: { radius: number },
): Vec {
  const prev = c.prev(p.index);
  const next = c.next(p.index);
  return sumBy(near(p), (j) => {
    if (j === prev || j === next) return [0, 0];
    const delta = sub(p, c.vertex(j));
    const d = length(delta);
    return mul(unit(delta), (1 - d / opts.radius) * opts.radius);
  });
}

// ---- one step ------------------------------------------------------------------

/** The next state under construction. Every vertex starts as a copy of
 * the current one — position and all attributes — so a rule only states
 * what changes. */
export interface Next {
  /** Displace the vertex at `index` by `by`; several moves add up. */
  move(index: number, by: Vec): void;
  /** Set attributes on the vertex at `index`. Unknown names are an error:
   * columns are declared at `curve()`, not invented mid-rule. */
  set(index: number, attrs: Record<string, number>): void;
  /**
   * Split edges of the MOVED state — moves and sets apply first, then
   * `where` sees each edge as it will be — inserting a vertex at fraction
   * `at` (default 0.5) along it. The new vertex gets `attributes`; every
   * column must be given explicitly (`{ age: 0 }`), because inheriting,
   * interpolating, or resetting is a choice the rule owns. Splits
   * evaluate in edge order and read the state before any split.
   */
  splitEdges(where: (e: Edge) => boolean, opts: { at?: number; attributes: Record<string, number> }): void;
}

function stepOnce(cur: Curve, k: number, rule: (c: Curve, n: Next, k: number) => void): Curve {
  const n = cur.n;
  const names = cur.attrNames;
  const nx = Float64Array.from(cur.x);
  const ny = Float64Array.from(cur.y);
  const nattrs: Record<string, Float64Array> = {};
  for (const name of names) nattrs[name] = Float64Array.from(cur.attrs[name]);
  const splits: { where: (e: Edge) => boolean; at: number; attributes: Record<string, number> }[] = [];

  const next: Next = {
    move(index, by) {
      nx[index] += by[0];
      ny[index] += by[1];
    },
    set(index, attrs) {
      for (const [name, v] of Object.entries(attrs)) {
        const col = nattrs[name];
        if (!col) throw new Error(`steps: no attribute '${name}' — declare it in curve()`);
        col[index] = v;
      }
    },
    splitEdges(where, opts) {
      for (const name of names) {
        if (!(name in opts.attributes)) {
          throw new Error(`steps: splitEdges must give '${name}' for the new vertex (every attribute is a choice)`);
        }
      }
      for (const name in opts.attributes) {
        if (!names.includes(name)) throw new Error(`steps: no attribute '${name}' — declare it in curve()`);
      }
      splits.push({ where, at: opts.at ?? 0.5, attributes: opts.attributes });
    },
  };
  rule(cur, next, k);

  if (splits.length === 0) return new Curve(nx, ny, nattrs, cur.closed, cur.iteration + 1);

  // Splits read the moved state; each edge may be split at most once per
  // step (the first request that wants it wins).
  const moved = new Curve(nx, ny, nattrs, cur.closed);
  const edges = moved.edges;
  const ox: number[] = [];
  const oy: number[] = [];
  const oattrs: Record<string, number[]> = {};
  for (const name of names) oattrs[name] = [];
  for (let i = 0; i < n; i++) {
    ox.push(nx[i]);
    oy.push(ny[i]);
    for (const name of names) oattrs[name].push(nattrs[name][i]);
    const e = edges[i];
    if (!e) continue; // the open end
    for (const s of splits) {
      if (!s.where(e)) continue;
      ox.push(e.a.x + (e.b.x - e.a.x) * s.at);
      oy.push(e.a.y + (e.b.y - e.a.y) * s.at);
      for (const name of names) oattrs[name].push(s.attributes[name]);
      break;
    }
  }
  const attrs: Record<string, Float64Array> = {};
  for (const name of names) attrs[name] = Float64Array.from(oattrs[name]);
  return new Curve(Float64Array.from(ox), Float64Array.from(oy), attrs, cur.closed, cur.iteration + 1);
}

// ---- interpretation -----------------------------------------------------------

/** A maximal run of consecutive edges sharing one key, as a stampable
 * contour (`stroke(run)`), with the key and the vertex index range. */
export interface SegmentRun extends IsoContour {
  key: number | string;
  /** Index of the run's first vertex; `to` is its last (inclusive). */
  from: number;
  to: number;
}

/**
 * Classify every edge with `key(a, b)` and gather consecutive edges of
 * equal key into runs. Runs meet end to end (each includes the vertex
 * where the next begins), so together they redraw the whole curve; a
 * closed curve whose edges all share one key comes back as one closed
 * run. The classification is the artist's: a vertex attribute needs an
 * interpretation before it can own an edge — the start vertex's, the
 * end's, both, either, or their mean are all different drawings.
 */
export function segmentRuns(c: Curve, key: (a: Vertex, b: Vertex) => number | string): SegmentRun[] {
  const edges = c.edges;
  const m = edges.length;
  if (m === 0) return [];
  const keys = edges.map((e) => key(e.a, e.b));
  // Start at a key change so a closed curve's wrap-around never splits a
  // run in two; if there is none, the whole curve is one run.
  let start = 0;
  if (c.closed) {
    // Begin where the first edge's run ends, so that run is drawn whole
    // from the seam side rather than in two pieces.
    const change = keys.findIndex((k) => k !== keys[0]);
    if (change < 0) return [{ key: keys[0], pts: c.pts, closed: true, from: 0, to: c.n - 1 }];
    start = change;
  }
  const runs: SegmentRun[] = [];
  let cur: SegmentRun | null = null;
  for (let s = 0; s < m; s++) {
    const i = (start + s) % m;
    const e = edges[i];
    if (!cur || cur.key !== keys[i]) {
      if (cur) runs.push(cur);
      cur = { key: keys[i], pts: [[e.a.x, e.a.y]], closed: false, from: e.a.index, to: e.a.index };
    }
    cur.pts.push([e.b.x, e.b.y]);
    cur.to = e.b.index;
  }
  if (cur) runs.push(cur);
  return runs;
}
