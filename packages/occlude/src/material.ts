/**
 * Material: positions, connections and attributes you can hold, step,
 * connect, resample and reinterpret.
 *
 * A `Material` is a set of vertices — `x`, `y` and any named attribute
 * columns — plus an edge list. A ring, an open chain, a branching tree
 * and an unconnected cloud are all materials; a `Curve` is the chain a material
 * hands back for drawing. Materials are values: every operation returns a
 * new one and leaves its input intact, so an evolution can be kept and
 * any iteration chosen later. Indices are rows of one state, not
 * identities: insertion renumbers later states.
 *
 * Four layers, kept apart:
 *   material   `material()` / `curve()` / `t.sample()`; `connect.*`;
 *              `.attribute()`, `.resample()`
 *   numbers    add sub mul length distance unit limit perp sum sumBy
 *   rules      `.steps(n, (current, next, k) => …)` with collection edits;
 *              forces PREPARED once, EVALUATED at a point to a vector
 *   drawing    `.curves()`, `segmentRuns`, `extent`, `banding`
 *
 * Everything here is pure — no seed, no paper. A rule that wants seeded
 * randomness or noise closes over the toolkit (`t.chance`, `t.noise`);
 * the outline of a shape comes from `t.sample`, which reads the paper.
 */

import type { IsoContour } from './isolines.js';
import type { VectorFieldFn } from './shapes.js';
import { distanceTo } from './distance.js';
import { grad } from './field.js';
import { triangulate as delaunayTriangles } from './points.js';

// ---- points and vectors ---------------------------------------------------------

/** A point or vector in either spelling. A plain `number[]` is accepted
 * too, because a bare `[a, b]` returned from an untyped arrow is inferred
 * as `number[]` and a sketch should not have to annotate its forces. */
export type XY = readonly [number, number] | readonly number[] | { x: number; y: number };

export type Vec = [number, number];

// Array.isArray does not narrow readonly arrays; a guard does.
const isArr = (p: XY): p is readonly number[] => Array.isArray(p);
const vx = (p: XY): number => (isArr(p) ? p[0] : p.x);
const vy = (p: XY): number => (isArr(p) ? p[1] : p.y);
const asXY = (p: XY): [number, number] => [vx(p), vy(p)];

// Vectors are tuples; inputs accept either spelling so a vertex view goes
// straight into `sub(q, p)`; results are ALWAYS fresh tuples — nothing
// mutates an argument or shares scratch storage. `unit` of a zero-length
// vector is the zero vector, so coincident points contribute no direction
// (and no NaN). `mul` is scalar multiplication only.

export function add(a: XY, b: XY): Vec {
  return [vx(a) + vx(b), vy(a) + vy(b)];
}

/** `a - b`: the vector from `b` to `a`. */
export function sub(a: XY, b: XY): Vec {
  return [vx(a) - vx(b), vy(a) - vy(b)];
}

/** Scalar multiplication only: `v` scaled by the number `k`. */
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

/** `v` shortened to `max` if it is longer; unchanged otherwise. */
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

/** `sum(items.map(fn))` without the intermediate array, accumulated in order. */
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

// ---- the material --------------------------------------------------------------------

/** A vertex view: its row `index` in THIS state, position, and every
 * attribute column. A plain snapshot, valid for the material it came from —
 * not a persistent identity. `material` (non-enumerable) names that material, so
 * a force can tell "this vertex of these sources" from a foreign point
 * that happens to share an index. */
export type Vertex = { index: number; x: number; y: number } & Record<string, number>;

export interface Edge {
  /** Vertex views at the edge's ends, in stored order (a → b). */
  a: Vertex;
  b: Vertex;
  length: number;
  /** Row of this edge in the material's edge list. */
  index: number;
}

/** A chain of a material for drawing: stampable as-is (`stroke(curve)`), with
 * the vertex rows it walks. */
export interface Curve extends IsoContour {
  indices: number[];
}

/** One captured state of a `steps()` run. Never touched by later steps. */
export interface Snapshot {
  iteration: number;
  material: Material;
}

/** How a column carries over when `resample` places new vertices:
 * `'interpolate'` linearly between the surrounding source vertices (the
 * default for every column), `'nearest'` copies the nearer one (ties to
 * the start vertex), a number
 * sets a constant, a function decides from both ends and the position. */
export type Transfer =
  | 'interpolate'
  | 'nearest'
  | number
  | ((a: Vertex, b: Vertex, t: number) => number);

const OWNER = Symbol('material');

export class Material {
  readonly n: number;
  readonly x: Float64Array;
  readonly y: Float64Array;
  /** Attribute columns by name, each `n` long. */
  readonly attrs: Readonly<Record<string, Float64Array>>;
  /** Edge list, stored order, `[a0, b0, a1, b1, …]`. Undirected for
   * connectivity; the stored direction is what `edges`, `splitEdges`
   * (`at`) and `segmentRuns` (`a`, `b`) see. */
  readonly edgeList: Uint32Array;
  /** How many `steps()` iterations produced this state (0 for fresh
   * material); `steps()` continues the count. */
  readonly iteration: number;
  /** States captured by the `steps()` call that made this material — empty
   * unless it asked for `{ every }`. Iteration 0 of that call, every
   * `every`-th after it, and the final one, each once, oldest first.
   * Snapshots carry no history of their own. */
  readonly history: readonly Snapshot[];
  private readonly adj: number[][];

  /** @internal Use `material()`/`curve()`/`t.sample()`; columns are adopted, not
   * copied. The library never writes to a material's columns after
   * construction — every step builds new ones — so a snapshot stays what it
   * was. (Typed arrays cannot be frozen; a sketch that writes `m.x[i] = …`
   * is editing a value it was given, on its own head.) */
  constructor(
    x: Float64Array,
    y: Float64Array,
    attrs: Record<string, Float64Array>,
    edgeList: Uint32Array,
    iteration = 0,
    history: readonly Snapshot[] = [],
  ) {
    if (x.length !== y.length) throw new Error('material: x and y columns differ in length');
    for (const [name, col] of Object.entries(attrs)) {
      if (col.length !== x.length) {
        throw new Error(`material: attribute '${name}' has ${col.length} values for ${x.length} vertices`);
      }
      if (name === 'x' || name === 'y' || name === 'index') {
        throw new Error(`material: '${name}' is a reserved vertex field`);
      }
    }
    if (edgeList.length % 2 !== 0) throw new Error('material: edge list must be pairs');
    this.n = x.length;
    this.x = x;
    this.y = y;
    this.attrs = attrs;
    this.edgeList = edgeList;
    this.iteration = iteration;
    this.history = history;
    const adj: number[][] = Array.from({ length: this.n }, () => []);
    for (let e = 0; e < edgeList.length; e += 2) {
      const a = edgeList[e];
      const b = edgeList[e + 1];
      if (a >= this.n || b >= this.n) throw new Error(`material: edge ${a}–${b} names a vertex beyond ${this.n - 1}`);
      if (a === b) throw new Error(`material: edge ${a}–${b} joins a vertex to itself`);
      adj[a].push(b);
      adj[b].push(a);
    }
    this.adj = adj;
    Object.freeze(this.attrs);
    Object.freeze(this.history);
    Object.freeze(this);
  }

  // ---- access ----

  /** Names of the attribute columns. */
  get attrNames(): string[] {
    return Object.keys(this.attrs);
  }

  /** The vertex at row `i` as a plain view. */
  vertex(i: number): Vertex {
    const v: Record<string, number> = { index: i, x: this.x[i], y: this.y[i] };
    for (const name in this.attrs) v[name] = this.attrs[name][i];
    Object.defineProperty(v, OWNER, { value: this, enumerable: false });
    return v as Vertex;
  }

  /** Every vertex as a view, in row order. */
  get points(): Vertex[] {
    const out: Vertex[] = new Array(this.n);
    for (let i = 0; i < this.n; i++) out[i] = this.vertex(i);
    return out;
  }

  /** Positions as tuples, row order — what `polygon`, `distanceTo` eat. */
  get pts(): [number, number][] {
    const out: [number, number][] = new Array(this.n);
    for (let i = 0; i < this.n; i++) out[i] = [this.x[i], this.y[i]];
    return out;
  }

  /** Number of edges. */
  get edgeCount(): number {
    return this.edgeList.length / 2;
  }

  /** Every edge as views, stored order. */
  get edges(): Edge[] {
    const out: Edge[] = [];
    for (let e = 0; e < this.edgeList.length; e += 2) {
      const a = this.vertex(this.edgeList[e]);
      const b = this.vertex(this.edgeList[e + 1]);
      out.push({ a, b, length: distance(a, b), index: e / 2 });
    }
    return out;
  }

  /** Rows connected to `i`, in edge order. */
  connected(i: number): readonly number[] {
    return this.adj[i];
  }

  degree(i: number): number {
    return this.adj[i].length;
  }

  isConnected(i: number, j: number): boolean {
    return this.adj[i].includes(j);
  }

  /** Chain convenience: the row before `i` along a stored edge into it,
   * -1 at an open end. On a junction, the first such row. */
  prev(i: number): number {
    for (let e = 0; e < this.edgeList.length; e += 2) if (this.edgeList[e + 1] === i) return this.edgeList[e];
    return -1;
  }

  /** Chain convenience: the row after `i` along a stored edge out of it,
   * -1 at an open end. On a junction, the first such row. */
  next(i: number): number {
    for (let e = 0; e < this.edgeList.length; e += 2) if (this.edgeList[e] === i) return this.edgeList[e + 1];
    return -1;
  }

  /** True when the material is one closed chain (a ring). */
  get closed(): boolean {
    const cs = this.curves();
    return cs.length === 1 && cs[0].closed && cs[0].indices.length === this.n;
  }

  /** The material's single chain as a stampable contour — for chain materials;
   * a branched material has several, see `curves()`. */
  get contour(): IsoContour {
    const cs = this.curves();
    if (cs.length === 1) return { pts: cs[0].pts, closed: cs[0].closed };
    if (cs.length === 0) return { pts: this.pts, closed: false };
    throw new Error(`contour: this material has ${cs.length} chains — use curves()`);
  }

  /**
   * The material as chains for drawing: a deterministic, edge-disjoint walk.
   * Chains start at endpoints and junctions (degree ≠ 2), pass through
   * degree-2 vertices, and end at the next endpoint or junction; edges
   * left over belong to pure cycles, which come back closed. Every edge
   * is covered once; a junction vertex appears in each chain that meets
   * it. Isolated vertices are not chains — see `points`.
   */
  curves(): Curve[] {
    const n = this.n;
    const m = this.edgeCount;
    const used = new Uint8Array(m);
    // edge rows by vertex, in edge order
    const rows: number[][] = Array.from({ length: n }, () => []);
    for (let e = 0; e < m; e++) {
      rows[this.edgeList[2 * e]].push(e);
      rows[this.edgeList[2 * e + 1]].push(e);
    }
    const other = (e: number, v: number) => (this.edgeList[2 * e] === v ? this.edgeList[2 * e + 1] : this.edgeList[2 * e]);
    const out: Curve[] = [];
    const walk = (start: number, firstEdge: number, stopAtDegree: boolean): Curve => {
      const indices = [start];
      let v = start;
      let e = firstEdge;
      for (;;) {
        used[e] = 1;
        v = other(e, v);
        indices.push(v);
        if (stopAtDegree && this.adj[v].length !== 2) break;
        if (v === start) break;
        const nextE = rows[v].find((r) => !used[r]);
        if (nextE === undefined) break;
        e = nextE;
      }
      const closed = indices.length > 1 && indices[0] === indices[indices.length - 1];
      if (closed) indices.pop();
      return { indices, closed, pts: indices.map((i) => [this.x[i], this.y[i]] as [number, number]) };
    };
    for (let v = 0; v < n; v++) {
      if (this.adj[v].length === 2) continue;
      for (const e of rows[v]) if (!used[e]) out.push(walk(v, e, true));
    }
    for (let e = 0; e < m; e++) {
      if (!used[e]) out.push(walk(this.edgeList[2 * e], e, false));
    }
    return out;
  }

  // ---- derived material ----

  /** A new material with a column set: a constant, or one value per vertex. */
  attribute(name: string, value: number | ((p: Vertex) => number)): Material {
    const col = new Float64Array(this.n);
    if (typeof value === 'number') col.fill(value);
    else for (let i = 0; i < this.n; i++) col[i] = value(this.vertex(i));
    return new Material(this.x, this.y, { ...this.attrs, [name]: col }, this.edgeList, this.iteration);
  }

  /** A new material with these edges added (undirected; duplicates dropped). */
  withEdges(pairs: readonly (readonly [number, number])[]): Material {
    const list = Array.from(this.edgeList);
    const seen = new Set<number>();
    for (let e = 0; e < list.length; e += 2) seen.add(pairKey(list[e], list[e + 1]));
    for (const [a, b] of pairs) {
      if (a === b) throw new Error(`connect: edge ${a}–${b} joins a vertex to itself`);
      if (a >= this.n || b >= this.n) throw new Error(`connect: edge ${a}–${b} names a vertex beyond ${this.n - 1}`);
      const k = pairKey(a, b);
      if (seen.has(k)) continue;
      seen.add(k);
      list.push(a, b);
    }
    return new Material(this.x, this.y, this.attrs, Uint32Array.from(list), this.iteration);
  }

  /**
   * Resample the material's chains evenly by arc length — the explicit,
   * lossy redistribution of sampled material after it has been deformed.
   * Chains only (a junction is an error, for now). Each chain gets
   * `count` vertices, or as many as fit at `spacing` (at least 2 open,
   * 3 closed); open chains keep both endpoints, closed ones keep their
   * seam at their first vertex. Corners are NOT preserved: a new vertex
   * lands on the old polyline, but a corner between two new vertices is
   * cut. Attributes carry over per `transfer` (default: linear
   * interpolation for every column; `'nearest'`, a constant, or a function
   * per column to say otherwise — an `age` is a choice, not a mean).
   */
  resample(opts: { spacing?: number; count?: number; transfer?: Record<string, Transfer> }): Material {
    if ((opts.spacing === undefined) === (opts.count === undefined)) {
      throw new Error('resample: give exactly one of { spacing, count }');
    }
    for (let i = 0; i < this.n; i++) {
      if (this.adj[i].length > 2) throw new Error(`resample: vertex ${i} is a junction — chains only`);
    }
    const names = this.attrNames;
    const transfer = opts.transfer ?? {};
    const ox: number[] = [];
    const oy: number[] = [];
    const oattrs: Record<string, number[]> = {};
    for (const name of names) oattrs[name] = [];
    const edges: number[] = [];
    const place = (a: number, b: number, t: number) => {
      ox.push(this.x[a] + (this.x[b] - this.x[a]) * t);
      oy.push(this.y[a] + (this.y[b] - this.y[a]) * t);
      for (const name of names) {
        const rule = transfer[name] ?? 'interpolate';
        const va = this.attrs[name][a];
        const vb = this.attrs[name][b];
        let v: number;
        if (rule === 'interpolate') v = va + (vb - va) * t;
        else if (rule === 'nearest') v = t <= 0.5 ? va : vb; // ties to the start vertex
        else if (typeof rule === 'number') v = rule;
        else v = rule(this.vertex(a), this.vertex(b), t);
        oattrs[name].push(v);
      }
    };
    for (const c of this.curves()) {
      const idx = c.indices;
      const segs = c.closed ? idx.length : idx.length - 1;
      const cum = [0];
      for (let s = 0; s < segs; s++) {
        const a = idx[s];
        const b = idx[(s + 1) % idx.length];
        cum.push(cum[s] + Math.hypot(this.x[b] - this.x[a], this.y[b] - this.y[a]));
      }
      const total = cum[segs];
      const count = opts.count ?? Math.max(c.closed ? 3 : 2, Math.round(total / opts.spacing!));
      const steps = c.closed ? count : count - 1;
      const first = ox.length;
      let seg = 0;
      for (let k = 0; k < count; k++) {
        const d = steps > 0 ? (total * k) / steps : 0;
        while (seg < segs - 1 && cum[seg + 1] < d) seg++;
        const a = idx[seg];
        const b = idx[(seg + 1) % idx.length];
        const len = cum[seg + 1] - cum[seg];
        place(a, b, len > 0 ? (d - cum[seg]) / len : 0);
        if (k > 0) edges.push(first + k - 1, first + k);
      }
      if (c.closed && count > 1) edges.push(first + count - 1, first);
    }
    const attrs: Record<string, Float64Array> = {};
    for (const name of names) attrs[name] = Float64Array.from(oattrs[name]);
    return new Material(Float64Array.from(ox), Float64Array.from(oy), attrs, Uint32Array.from(edges), this.iteration);
  }

  // ---- the iteration verb ----

  /**
   * THE iteration operation. Run `rule` `n` times and return the final
   * material, ready for further operations. `rule(current, next, k)` reads
   * `current` (frozen) and describes `next`, which starts as a copy; see
   * `Next` for the edits. `k` counts from 0 within this call. Growth,
   * relaxation, deformation and erosion are different rules for this one
   * verb; `.steps(1, rule)` is a single transition.
   *
   * By default only the final state is kept. `{ every: m }` also captures
   * iteration 0, every m-th iteration, and the final one (no duplicates)
   * on the result's `history`, each labelled with its iteration number.
   * Nothing a later step does can disturb an earlier snapshot.
   */
  steps(n: number, rule: (current: Material, next: Next, k: number) => void, opts: { every?: number } = {}): Material {
    const every = opts.every !== undefined ? Math.max(1, Math.floor(opts.every)) : 0;
    const snaps: Snapshot[] = [];
    const base = new Material(this.x, this.y, { ...this.attrs }, this.edgeList, this.iteration);
    if (every) snaps.push({ iteration: this.iteration, material: base });
    let cur = base;
    for (let k = 0; k < n; k++) {
      cur = stepOnce(cur, k, rule);
      if (every && (k + 1) % every === 0 && k + 1 < n) snaps.push({ iteration: cur.iteration, material: cur });
    }
    if (every && n > 0) snaps.push({ iteration: cur.iteration, material: cur });
    return every ? new Material(cur.x, cur.y, { ...cur.attrs }, cur.edgeList, cur.iteration, snaps) : cur;
  }
}

const pairKey = (a: number, b: number) => (a < b ? a * 4294967296 + b : b * 4294967296 + a);

const ownerOf = (p: Vertex): Material | undefined => (p as unknown as Record<symbol, Material>)[OWNER];

// ---- constructors ----------------------------------------------------------------

/** Points a material can be made from: tuples, `{x, y}` objects (extra numeric
 * fields such as a scatter point's `w` become columns), or a material. */
export type PointsLike = readonly XY[] | Material;

/**
 * Material from positions. Unconnected unless `edges` are given; extra
 * numeric fields on object points (`w` from `t.scatter`) become columns;
 * named options become constant columns. Use `connect.*` for topology.
 */
export function material(
  points: PointsLike,
  opts: { edges?: readonly (readonly [number, number])[] } & Record<string, number | ArrayLike<number> | readonly (readonly [number, number])[] | undefined> = {},
): Material {
  if (points instanceof Material) return points;
  const n = points.length;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const attrs: Record<string, Float64Array> = {};
  const extra = new Set<string>();
  for (let i = 0; i < n; i++) {
    const p = points[i];
    x[i] = vx(p);
    y[i] = vy(p);
    if (!isArr(p)) {
      for (const [k, v] of Object.entries(p)) if (k !== 'x' && k !== 'y' && typeof v === 'number') extra.add(k);
    }
  }
  for (const k of extra) {
    const col = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const p = points[i];
      const v = isArr(p) ? undefined : (p as Record<string, unknown>)[k];
      if (typeof v !== 'number') throw new Error(`material: point ${i} has no numeric '${k}' — every point needs every column`);
      col[i] = v;
    }
    attrs[k] = col;
  }
  let edges: Uint32Array = new Uint32Array(0);
  for (const [name, value] of Object.entries(opts)) {
    if (name === 'edges') {
      const flat: number[] = [];
      for (const [a, b] of value as readonly (readonly [number, number])[]) flat.push(a, b);
      edges = Uint32Array.from(flat);
      continue;
    }
    if (value === undefined) continue;
    if (typeof value === 'number') attrs[name] = new Float64Array(n).fill(value);
    else attrs[name] = Float64Array.from(value as ArrayLike<number>);
  }
  return new Material(x, y, attrs, edges);
}

/**
 * A chain from positions — closed (a ring) unless `closed: false` — with
 * optional attribute columns as one constant per vertex or a full column.
 * Sugar for `connect.ring(material(pts))` / `connect.chain(...)`.
 */
export function curve(
  pts: readonly XY[],
  opts: { closed?: boolean } & Record<string, number | ArrayLike<number> | boolean | undefined> = {},
): Material {
  const { closed = true, ...rest } = opts;
  const cols: Record<string, number | ArrayLike<number>> = {};
  for (const [k, v] of Object.entries(rest)) {
    if (v === undefined) continue;
    if (typeof v === 'boolean') throw new Error(`curve: attribute '${k}' must be numeric`);
    cols[k] = v;
  }
  const m = material(pts, cols);
  return closed ? connect.ring(m) : connect.chain(m);
}

// ---- connections ----------------------------------------------------------------

function chainEdges(n: number, closed: boolean): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < n; i++) out.push([i, i + 1]);
  if (closed && n > 2) out.push([n - 1, 0]);
  else if (closed && n === 2) out.push([1, 0]);
  return out;
}

/** Common connection patterns; each returns a new material. None infers a
 * route: chain and ring use the supplied row order. */
export const connect = {
  /** Consecutive rows joined, open. */
  chain(m: PointsLike): Material {
    const mm = material(m);
    return mm.withEdges(chainEdges(mm.n, false));
  },
  /** Consecutive rows joined and the last joined back to the first. */
  ring(m: PointsLike): Material {
    const mm = material(m);
    return mm.withEdges(chainEdges(mm.n, true));
  },
  /** Each vertex joined to its `count` nearest others (undirected, no
   * duplicates, self excluded; ties broken by lower row). */
  nearest(m: PointsLike, opts: { count: number }): Material {
    const mm = material(m);
    const pairs: [number, number][] = [];
    for (let i = 0; i < mm.n; i++) {
      const cand: [number, number][] = [];
      for (let j = 0; j < mm.n; j++) {
        if (j === i) continue;
        const dx = mm.x[j] - mm.x[i];
        const dy = mm.y[j] - mm.y[i];
        cand.push([dx * dx + dy * dy, j]);
      }
      cand.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
      for (const [, j] of cand.slice(0, opts.count)) pairs.push([i, j]);
    }
    return mm.withEdges(pairs);
  },
  /** Row i of `a` joined to row i of `b`, in one material (a's rows first).
   * Lengths must match; coincident points stay distinct. */
  pairs(a: PointsLike, b: PointsLike): Material {
    const ma = material(a);
    const mb = material(b);
    if (ma.n !== mb.n) throw new Error(`connect.pairs: ${ma.n} and ${mb.n} points — lengths must match`);
    const joined = append(ma, mb);
    const pairs: [number, number][] = [];
    for (let i = 0; i < ma.n; i++) pairs.push([i, ma.n + i]);
    return joined.withEdges(pairs);
  },
  /** Delaunay triangulation edges over the vertices. */
  triangulate(m: PointsLike): Material {
    const mm = material(m);
    const tris = delaunayTriangles(mm.pts);
    // triangulate() returns coordinate triples; map back to rows by position
    const rowOf = new Map<string, number>();
    for (let i = 0; i < mm.n; i++) rowOf.set(`${mm.x[i]},${mm.y[i]}`, i);
    const pairs: [number, number][] = [];
    for (const tri of tris) {
      const r = tri.map(([x, y]) => rowOf.get(`${x},${y}`)!);
      pairs.push([r[0], r[1]], [r[1], r[2]], [r[2], r[0]]);
    }
    return mm.withEdges(pairs);
  },
};

/** Two materials as one: b's rows after a's, b's edges re-based; only the
 * columns both have carry over. */
export function append(a: Material, b: Material): Material {
  const names = a.attrNames.filter((k) => b.attrNames.includes(k));
  const x = new Float64Array(a.n + b.n);
  const y = new Float64Array(a.n + b.n);
  x.set(a.x);
  x.set(b.x, a.n);
  y.set(a.y);
  y.set(b.y, a.n);
  const attrs: Record<string, Float64Array> = {};
  for (const k of names) {
    const col = new Float64Array(a.n + b.n);
    col.set(a.attrs[k]);
    col.set(b.attrs[k], a.n);
    attrs[k] = col;
  }
  const edges = new Uint32Array(a.edgeList.length + b.edgeList.length);
  edges.set(a.edgeList);
  for (let e = 0; e < b.edgeList.length; e++) edges[a.edgeList.length + e] = b.edgeList[e] + a.n;
  return new Material(x, y, attrs, edges);
}

// ---- one step ---------------------------------------------------------------------

/** A vertex added in this edit batch, usable before the batch resolves. */
export interface Handle {
  readonly __handle: number;
}

export type Ref = number | Handle;

const isHandle = (r: Ref): r is Handle => typeof r === 'object' && r !== null && '__handle' in r;

/** One child of `extend`: where it goes and what it carries (every
 * column, explicitly). */
export interface ChildSpec {
  position: XY;
  attributes: Record<string, number>;
}

/**
 * The next state under construction. Every vertex starts as a copy of
 * the current one — position, attributes, connections — so a rule only
 * states what changes. All callbacks see the FROZEN current state; no
 * edit changes what a later callback reads. Order of application:
 * moves and sets first (moves add up, the last set of a key wins), then
 * `splitEdges` on the MOVED edges, then `addPoint`/`extend`/`connect`.
 */
export interface Next {
  /** Displace one vertex, or every vertex `where` says (all by default). */
  move(index: number, by: XY): void;
  move(by: (p: Vertex) => XY, opts?: { where?: (p: Vertex) => boolean }): void;
  /** Write attributes on one vertex, or on every vertex `where` says.
   * Unknown names are an error: columns are declared, not invented mid-rule. */
  set(index: number, attrs: Record<string, number>): void;
  set(attrs: (p: Vertex) => Record<string, number>, opts?: { where?: (p: Vertex) => boolean }): void;
  /**
   * Split edges of the MOVED state, inserting a vertex at fraction `at`
   * (default 0.5) along each edge `where` accepts. The new vertex gets
   * `attributes`, a constant or a function of the split edge — every
   * column, explicitly. `parent` rewrites the start vertex (an EDGE
   * attribute kept there, divided between the children). Each edge splits
   * at most once per step; requests evaluate in edge order.
   */
  splitEdges(
    where: (e: Edge) => boolean,
    opts: {
      at?: number;
      attributes: Record<string, number> | ((e: Edge) => Record<string, number>);
      parent?: (e: Edge) => Record<string, number>;
    },
  ): void;
  /** A new vertex; the handle names it within this batch. */
  addPoint(position: XY, attributes: Record<string, number>): Handle;
  /** An edge between existing rows and/or new handles. */
  connect(a: Ref, b: Ref): void;
  /** For every current vertex `where` says: add the child (or children)
   * `spec` describes and connect each to its parent. */
  extend(spec: (p: Vertex) => ChildSpec | ChildSpec[], opts?: { where?: (p: Vertex) => boolean }): void;
}

function checkAttrs(attrs: Record<string, number>, names: string[], what: string): void {
  for (const name of names) {
    if (!(name in attrs)) throw new Error(`steps: must give '${name}' for ${what} (every attribute is a choice)`);
  }
  for (const name in attrs) {
    if (!names.includes(name)) throw new Error(`steps: no attribute '${name}' — declare it in material()/curve()`);
  }
}

function stepOnce(cur: Material, k: number, rule: (c: Material, n: Next, k: number) => void): Material {
  const n = cur.n;
  const names = cur.attrNames;
  const nx = Float64Array.from(cur.x);
  const ny = Float64Array.from(cur.y);
  const nattrs: Record<string, Float64Array> = {};
  for (const name of names) nattrs[name] = Float64Array.from(cur.attrs[name]);
  const splits: {
    where: (e: Edge) => boolean;
    at: number;
    attributes: Record<string, number> | ((e: Edge) => Record<string, number>);
    parent?: (e: Edge) => Record<string, number>;
  }[] = [];
  const added: { x: number; y: number; attrs: Record<string, number> }[] = [];
  const links: [Ref, Ref][] = [];
  const points = cur.points; // frozen views, built once for the collection forms

  const next: Next = {
    move(a: number | ((p: Vertex) => XY), b?: XY | { where?: (p: Vertex) => boolean }) {
      if (typeof a === 'number') {
        const by = b as XY;
        nx[a] += vx(by);
        ny[a] += vy(by);
        return;
      }
      const where = (b as { where?: (p: Vertex) => boolean } | undefined)?.where;
      for (const p of points) {
        if (where && !where(p)) continue;
        const by = a(p);
        nx[p.index] += vx(by);
        ny[p.index] += vy(by);
      }
    },
    set(a: number | ((p: Vertex) => Record<string, number>), b?: Record<string, number> | { where?: (p: Vertex) => boolean }) {
      const write = (index: number, attrs: Record<string, number>) => {
        for (const [name, v] of Object.entries(attrs)) {
          const col = nattrs[name];
          if (!col) throw new Error(`steps: no attribute '${name}' — declare it in material()/curve()`);
          col[index] = v;
        }
      };
      if (typeof a === 'number') {
        write(a, b as Record<string, number>);
        return;
      }
      const where = (b as { where?: (p: Vertex) => boolean } | undefined)?.where;
      for (const p of points) {
        if (where && !where(p)) continue;
        write(p.index, a(p));
      }
    },
    splitEdges(where, opts) {
      if (typeof opts.attributes !== 'function') checkAttrs(opts.attributes, names, 'the new vertex');
      splits.push({ where, at: opts.at ?? 0.5, attributes: opts.attributes, parent: opts.parent });
    },
    addPoint(position, attributes) {
      checkAttrs(attributes, names, 'a new vertex');
      added.push({ x: vx(position), y: vy(position), attrs: attributes });
      return { __handle: added.length - 1 };
    },
    connect(a, b) {
      links.push([a, b]);
    },
    extend(spec, opts) {
      for (const p of points) {
        if (opts?.where && !opts.where(p)) continue;
        const specs = spec(p);
        for (const s of Array.isArray(specs) ? specs : [specs]) {
          const h = next.addPoint(s.position, s.attributes);
          links.push([p.index, h]);
        }
      }
    },
  };
  rule(cur, next, k);

  // Splits read the moved state; a split vertex is inserted right after
  // its edge's start row (keeps row order along a chain, hence the same
  // neighbour-grid order as before) and the edge becomes two.
  const moved = new Material(nx, ny, nattrs, cur.edgeList, cur.iteration + 1);
  const rowMap = new Int32Array(n); // old row → new row
  const ox: number[] = [];
  const oy: number[] = [];
  const oattrs: Record<string, number[]> = {};
  for (const name of names) oattrs[name] = [];
  const insertAfter = new Map<number, { x: number; y: number; attrs: Record<string, number>; edge: number; at: number }[]>();
  const parentWrites = new Map<number, Record<string, number>>();
  if (splits.length > 0) {
    const edges = moved.edges;
    for (const e of edges) {
      for (const s of splits) {
        if (!s.where(e)) continue;
        const born = typeof s.attributes === 'function' ? s.attributes(e) : s.attributes;
        if (typeof s.attributes === 'function') checkAttrs(born, names, 'the new vertex');
        if (s.parent) {
          const upd = s.parent(e);
          for (const name in upd) if (!names.includes(name)) throw new Error(`steps: no attribute '${name}' — declare it in material()/curve()`);
          parentWrites.set(e.a.index, { ...(parentWrites.get(e.a.index) ?? {}), ...upd });
        }
        const list = insertAfter.get(e.a.index) ?? [];
        list.push({ x: e.a.x + (e.b.x - e.a.x) * s.at, y: e.a.y + (e.b.y - e.a.y) * s.at, attrs: born, edge: e.index, at: s.at });
        insertAfter.set(e.a.index, list);
        break;
      }
    }
  }
  const splitRow = new Map<number, number>(); // edge row → new vertex row
  for (let i = 0; i < n; i++) {
    rowMap[i] = ox.length;
    ox.push(nx[i]);
    oy.push(ny[i]);
    const pw = parentWrites.get(i);
    for (const name of names) oattrs[name].push(pw && name in pw ? pw[name] : nattrs[name][i]);
    for (const ins of insertAfter.get(i) ?? []) {
      splitRow.set(ins.edge, ox.length);
      ox.push(ins.x);
      oy.push(ins.y);
      for (const name of names) oattrs[name].push(ins.attrs[name]);
    }
  }
  const handleRow = new Int32Array(added.length);
  for (let a = 0; a < added.length; a++) {
    handleRow[a] = ox.length;
    ox.push(added[a].x);
    oy.push(added[a].y);
    for (const name of names) oattrs[name].push(added[a].attrs[name]);
  }
  const edges: number[] = [];
  for (let e = 0; e < cur.edgeCount; e++) {
    const a = rowMap[cur.edgeList[2 * e]];
    const b = rowMap[cur.edgeList[2 * e + 1]];
    const mid = splitRow.get(e);
    if (mid === undefined) edges.push(a, b);
    else edges.push(a, mid, mid, b);
  }
  const resolve = (r: Ref): number => {
    if (isHandle(r)) {
      if (r.__handle < 0 || r.__handle >= added.length) throw new Error('connect: unknown handle');
      return handleRow[r.__handle];
    }
    if (!Number.isInteger(r) || r < 0 || r >= n) throw new Error(`connect: no vertex ${r} in this state (${n} rows)`);
    return rowMap[r];
  };
  for (const [a, b] of links) edges.push(resolve(a), resolve(b));
  const attrs: Record<string, Float64Array> = {};
  for (const name of names) attrs[name] = Float64Array.from(oattrs[name]);
  return new Material(Float64Array.from(ox), Float64Array.from(oy), attrs, Uint32Array.from(edges), cur.iteration + 1);
}

// ---- spatial neighbours -----------------------------------------------------------

export interface NeighbourStats {
  queries: number;
  /** Vertices examined from the grid cells around the query point. */
  candidates: number;
  /** Of those, within the radius. */
  hits: number;
}

/**
 * Spatial neighbours of a material's vertices, prepared ONCE for the state as
 * it is now: a uniform grid over the positions. The query gives the rows
 * within `radius` of `p` (a vertex of THIS material is excluded from its own
 * query; a foreign point is not), in grid order — the sketch decides what
 * to do with them. Connectivity is a different concept and is NOT
 * excluded here (see `force.adjacent`). Rows are valid for this state.
 */
export function neighbours(m: Material, opts: { radius: number; stats?: NeighbourStats }): (p: XY) => number[] {
  const radius = opts.radius;
  const cell = radius;
  const stats = opts.stats;
  const grid = new Map<number, number[]>();
  const key = (gx: number, gy: number) => gx * 65536 + gy;
  for (let i = 0; i < m.n; i++) {
    const k = key(Math.floor(m.x[i] / cell), Math.floor(m.y[i] / cell));
    const bucket = grid.get(k);
    if (bucket) bucket.push(i);
    else grid.set(k, [i]);
  }
  return (p: XY): number[] => {
    const px = vx(p);
    const py = vy(p);
    const self = ownerOf(p as Vertex) === m ? (p as Vertex).index : -1;
    const out: number[] = [];
    const cx = Math.floor(px / cell);
    const cy = Math.floor(py / cell);
    if (stats) stats.queries++;
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        const bucket = grid.get(key(gx, gy));
        if (!bucket) continue;
        if (stats) stats.candidates += bucket.length;
        for (const j of bucket) {
          if (j === self) continue;
          const dx = px - m.x[j];
          const dy = py - m.y[j];
          if (dx * dx + dy * dy < radius * radius) out.push(j);
        }
      }
    }
    if (stats) stats.hits += out.length;
    return out;
  };
}

// ---- forces -----------------------------------------------------------------------
//
// One shape: PREPARE with the source geometry once per state, then EVALUATE
// at a point to get a vector. Nothing here moves anything — the rule sums
// the vectors and decides. Two callback shapes cover the field:
//
//   p => vector        wind, drift, a vector field — works in `sum` as is
//   (p, q) => vector   interaction with another point — `nearby` finds the
//                      q's within a radius and adds your contributions up
//
// The named recipes are ordinary functions on this mechanism and the
// vocabulary. Copy one into a sketch and change it; a custom force that
// earns reuse can become a recipe.

/** Points a force can be prepared from: a material (its vertices, with `index`
 * and attributes on `q`) or any list of points. */
export type Sources = PointsLike;

/**
 * A neighbourhood interaction: the sum, over every source point `q` within
 * `radius` of `p`, of `contribution(p, q)`. The spatial index over
 * `sources` is built ONCE, here, for that frozen state; the returned
 * function evaluates at any point. `q` is a vertex view of the sources.
 *
 * Identity: a vertex of the source material never interacts with itself —
 * decided by membership in that state, not by coordinates or by an index
 * from an unrelated collection. Nothing else is skipped unless `skip(p, q)`
 * says so; connected neighbours are NOT excluded by default (see
 * `adjacent`). Contributions accumulate in a fixed grid order.
 */
export function nearby(
  sources: Sources,
  opts: { radius: number; skip?: (p: Vertex, q: Vertex) => boolean; stats?: NeighbourStats },
  contribution: (p: Vertex, q: Vertex) => XY,
): (p: Vertex) => Vec {
  const m = material(sources);
  const near = neighbours(m, { radius: opts.radius, stats: opts.stats });
  const skip = opts.skip;
  return (p) =>
    sumBy(near(p), (j) => {
      const q = m.vertex(j);
      return skip && skip(p, q) ? [0, 0] : contribution(p, q);
    });
}

/** The explicit "skip what I'm connected to" rule for `nearby`: true when
 * `p` and `q` share an edge of `m` (both must be vertices of `m`). */
export function adjacent(m: Material): (p: Vertex, q: Vertex) => boolean {
  return (p, q) => ownerOf(p) === m && m.isConnected(p.index, q.index);
}

/**
 * Slack tension, prepared for `m`: `pull(p)` is the vector toward each of
 * p's CONNECTED neighbours (edge order) by the part of the gap beyond
 * `rest`. Zero when every neighbour is within `rest`: a slack chain, not
 * a spring. Needs connectivity; on a junction it pulls toward every
 * branch.
 */
export function tension(m: Material, opts: { rest: number }): (p: Vertex) => Vec {
  const { rest } = opts;
  return (p) =>
    sumBy(m.connected(p.index), (j) => {
      const delta = sub(m.vertex(j), p);
      return mul(unit(delta), Math.max(0, length(delta) - rest));
    });
}

/**
 * Separation: `repel(p)` is the vector away from every source within
 * `radius`, falling off linearly to zero at the radius and peaking at
 * `radius` when touching (strength is the radius, as in the reference
 * rule). Sources may be the material being moved or something else — obstacle
 * samples, another material. `excludeConnected: true` skips p's connected
 * neighbours when the sources are p's own material (tension owns that
 * spacing); off by default, so say it.
 */
export function separation(sources: Sources, opts: { radius: number; excludeConnected?: boolean }): (p: Vertex) => Vec {
  const { radius, excludeConnected = false } = opts;
  const m = material(sources);
  return nearby(m, { radius, skip: excludeConnected ? adjacent(m) : undefined }, (p, q) => {
    const delta = sub(p, q);
    return mul(unit(delta), (1 - length(delta) / radius) * radius);
  });
}

/**
 * Drift: a direction read from a noise function, `amount` long, turning
 * slowly with the iteration. Pure — pass the toolkit's seeded `t.noise`
 * in: `drift(t.noise, { amount })`, then `wander(p, k)`. `frequency`
 * scales position into the noise (default 0.08), `rate` the iteration
 * (default 0.01): angle = noise(x·f, y·f, k·rate) · 2π.
 */
export function drift(
  noise: (x: number, y: number, z: number) => number,
  opts: { amount: number; frequency?: number; rate?: number },
): (p: XY, k: number) => Vec {
  const { amount, frequency = 0.08, rate = 0.01 } = opts;
  return (p, k) => {
    const a = noise(vx(p) * frequency, vy(p) * frequency, k * rate) * Math.PI * 2;
    return [Math.cos(a) * amount, Math.sin(a) * amount];
  };
}

/**
 * Attraction: `pull(p)` is the vector toward every source within `radius`,
 * `strength` when touching, fading linearly to zero at the radius —
 * separation's mirror. Sources may be the material itself (`excludeConnected`
 * as for separation) or anchor points.
 */
export function attract(
  sources: Sources,
  opts: { radius: number; strength?: number; excludeConnected?: boolean },
): (p: Vertex) => Vec {
  const { radius, strength = 1, excludeConnected = false } = opts;
  const m = material(sources);
  return nearby(m, { radius, skip: excludeConnected ? adjacent(m) : undefined }, (p, q) => {
    const delta = sub(q, p);
    return mul(unit(delta), (1 - length(delta) / radius) * strength);
  });
}

/**
 * Boundary: keep inside an area. `keep(p)` is zero deeper than `radius`
 * inside the boundary loops, grows linearly to `strength` at the edge, and
 * keeps pushing inward outside — direction from the signed distance field
 * (`distanceTo`: positive inside, holes respected; contours chord-closed).
 * Loops are plain points: `t.polylines(rect(...))`, a material's `curves()`
 * pts, isolines' pts. Sampled obstacles are `separation`; this is the
 * continuous boundary.
 */
export function boundary(loops: readonly (readonly XY[])[], opts: { radius: number; strength?: number }): (p: XY) => Vec {
  const { radius, strength = 1 } = opts;
  const inside = distanceTo(loops.map((l) => l.map((q) => asXY(q))));
  const inward = grad(inside);
  return (p) => {
    const d = inside(vx(p), vy(p));
    if (d >= radius) return [0, 0];
    return mul(unit(inward(vx(p), vy(p))), (1 - Math.max(d, 0) / radius) * strength);
  };
}

/**
 * Vortex: turn around `centre`. `swirl(p)` is tangential (counter-clockwise
 * for positive `strength`; y is down, so clockwise on the page), `strength`
 * near the centre and falling off as `1 / (1 + distance / falloff)`; zero
 * exactly at the centre.
 */
export function vortex(centre: XY, opts: { strength: number; falloff?: number }): (p: XY) => Vec {
  const { strength, falloff = 10 } = opts;
  return (p) => {
    const radial = sub(p, centre);
    return mul(perp(unit(radial)), strength / (1 + length(radial) / falloff));
  };
}

/** A vector field as a force: `field(curl(f))(p)` is the field at `p`,
 * times `strength` — the adapter that lets `grad`/`curl` fields sit in
 * `sum` beside the others. */
export function field(vf: VectorFieldFn, opts: { strength?: number } = {}): (p: XY) => Vec {
  const { strength = 1 } = opts;
  return (p) => mul(vf(vx(p), vy(p)), strength);
}

/**
 * Relax, prepared for `m`: `smooth(p)` is the vector from `p` toward the
 * mean of its connected neighbours, scaled by `amount` — Laplacian
 * smoothing as a force, the growth-free counterpart of tension. A vertex
 * with fewer than two neighbours (an open end, an isolated point) stays.
 */
export function relax(m: Material, opts: { amount?: number } = {}): (p: Vertex) => Vec {
  const { amount = 1 } = opts;
  return (p) => {
    const nb = m.connected(p.index);
    if (nb.length < 2) return [0, 0];
    let mx = 0;
    let my = 0;
    for (const j of nb) {
      mx += m.x[j];
      my += m.y[j];
    }
    return mul(sub([mx / nb.length, my / nb.length], p), amount);
  };
}

/** The forces as one namespace: `force.nearby(...)`, `force.tension(...)`. */
export const force = { nearby, adjacent, tension, separation, drift, attract, boundary, vortex, field, relax };

// ---- interpretation ---------------------------------------------------------------

/** Smallest and largest value of a column (`extent(m.attrs.age)`); `[0, 0]` for an empty one. */
export function extent(values: ArrayLike<number>): [number, number] {
  if (values.length === 0) return [0, 0];
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return [lo, hi];
}

/**
 * A classifier from a numeric range into `count` equal bands, 0 … count-1:
 * `min` and below is band 0, `max` and above the last; a constant range
 * puts everything in band 0. `count` must be a positive integer.
 */
export function banding(opts: { min: number; max: number; count: number }): (v: number) => number {
  const { min, max, count } = opts;
  if (!Number.isInteger(count) || count < 1) throw new Error(`banding: count must be a positive integer, got ${count}`);
  const span = max - min;
  return (v) => {
    if (!(span > 0)) return 0;
    const b = Math.floor(((v - min) / span) * count);
    return b < 0 ? 0 : b >= count ? count - 1 : b;
  };
}

/** A maximal run of consecutive edges of one chain sharing one key, as a
 * stampable contour (`stroke(run)`), with the key and the vertex rows. */
export interface SegmentRun<K = number | string> extends IsoContour {
  key: K;
  /** Row of the run's first vertex; `to` is its last (inclusive). */
  from: number;
  to: number;
}

/**
 * Classify every edge with `key(a, b)` (a → b in stored order) and gather
 * consecutive edges of equal key into runs, chain by chain (`curves()`):
 * runs end at endpoints and junctions and never split across a closed
 * chain's seam; runs meet end to end, so together they redraw every edge
 * once; a uniform closed chain is one closed run. The classification is
 * the artist's: a vertex attribute needs an interpretation before it can
 * own an edge — the start vertex's, the end's, both, or their mean are
 * different drawings.
 */
export function segmentRuns<K extends number | string>(m: Material, key: (a: Vertex, b: Vertex) => K): SegmentRun<K>[] {
  const runs: SegmentRun<K>[] = [];
  for (const c of m.curves()) {
    const idx = c.indices;
    const segs = c.closed ? idx.length : idx.length - 1;
    if (segs <= 0) continue;
    const keys: K[] = [];
    for (let s = 0; s < segs; s++) keys.push(key(m.vertex(idx[s]), m.vertex(idx[(s + 1) % idx.length])));
    let start = 0;
    if (c.closed) {
      // Begin where the first edge's run ends, so that run is drawn whole
      // from the seam side rather than in two pieces.
      const change = keys.findIndex((k) => k !== keys[0]);
      if (change < 0) {
        runs.push({ key: keys[0], pts: c.pts, closed: true, from: idx[0], to: idx[idx.length - 1] });
        continue;
      }
      start = change;
    }
    let cur: SegmentRun<K> | null = null;
    for (let s = 0; s < segs; s++) {
      const i = (start + s) % segs;
      const a = idx[i];
      const b = idx[(i + 1) % idx.length];
      if (!cur || cur.key !== keys[i]) {
        if (cur) runs.push(cur);
        cur = { key: keys[i], pts: [[m.x[a], m.y[a]]], closed: false, from: a, to: a };
      }
      cur.pts.push([m.x[b], m.y[b]]);
      cur.to = b;
    }
    if (cur) runs.push(cur);
  }
  return runs;
}
