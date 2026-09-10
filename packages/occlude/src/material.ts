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

import { PointSelection, EdgeSelection } from './relation.js';
import { degrees } from './units.js';
// Type-only: a placement returns a tree value (the shape `group()` makes).
// `import type` is erased, so material never depends on api at runtime.
import type { GroupValue, Tree } from './api.js';
import { walkChains } from './chains.js';
import { planarize, faces, type PlanarizeOpts, type Faces, type Face } from './faces.js';
import type { IsoContour } from './isolines.js';
import type { VectorFieldFn } from './shapes.js';
import { distanceTo } from './distance.js';
import { numericLoops, type Boundary } from './boundary.js';
import { grad } from './field.js';
import { Delaunay } from 'd3-delaunay';
import { orient2d } from 'robust-predicates';

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

/** Dot product `a · b`: zero when the two are perpendicular or either is the zero vector. */
export function dot(a: XY, b: XY): number {
  return vx(a) * vx(b) + vy(a) * vy(b);
}

/** Signed 2D cross product `a × b = ax·by − ay·bx`. Positive when `b` lies
 * on the side of `a` that `perp(a)` points to (a quarter turn from +x
 * toward +y, which is clockwise as drawn, since y grows downward), negative
 * on the other side, zero when the two are parallel or either is the zero
 * vector. `Math.sign(cross(heading, toward))` is the side test. */
export function cross(a: XY, b: XY): number {
  return vx(a) * vy(b) - vy(a) * vx(b);
}

/** The unit vector at `angle` radians, `[cos, sin]`: angles here are
 * radians from +x toward +y, the same convention `angleOf` reads. */
export function fromAngle(angle: number): Vec {
  return [Math.cos(angle), Math.sin(angle)];
}

/** The angle of `v` in radians, from +x toward +y (`Math.atan2(y, x)`),
 * in (−π, π]; the zero vector gives 0. */
export function angleOf(v: XY): number {
  return Math.atan2(vy(v), vx(v));
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
  /** This edge's attribute row: `edge.attrs.rest`. */
  attrs: Record<string, number>;
}

/** A chain of a material for drawing: stampable as-is (`stroke(curve)`), with
 * the vertex rows it walks. */
export interface Curve extends IsoContour {
  indices: number[];
}

/**
 * A place on a chain, read off it by arc length (`along`): plain data that
 * belongs to no state. Position, the unit tangent of the polyline segment
 * under it (a station on a vertex takes the bisector of the segments that
 * meet there), the normal (the tangent turned a quarter turn, `perp`), the heading in
 * radians, arc length `s` from the chain's start, its fraction `u`, the
 * chain's whole `length`, and the chain (an index into `curves()`). Point columns arrive in `attrs` by
 * each column's transfer policy, edge columns in `edgeAttrs` by theirs: a
 * `'copy'` column is the edge under the station, a `'distribute'` column
 * the sum over the run of chain nearer this station than its neighbours,
 * so the stations' shares add up to the chain's total.
 */
export interface Station {
  x: number;
  y: number;
  tangent: [number, number];
  normal: [number, number];
  heading: number;
  s: number;
  u: number;
  /** The whole chain's arc length: the same on every station of the chain. */
  length: number;
  chain: number;
  closed: boolean;
  attrs: Record<string, number>;
  edgeAttrs: Record<string, number>;
  /** Put `content` here, turned to the station's tangent: the motif-along-
   * a-spine idiom. The placement frame is
   * `T(position + tangent·ot + normal·on) · R(heading + rotate) · S(scale)`,
   * so `offset` is measured in the station's own frame and is unaffected by
   * the motif's extra rotation. Returns a drawable (a group) and does not
   * mutate the station. */
  place(content: Tree, opts?: PlaceOpts): GroupValue;
}

/** Where a station puts content: `offset` is `[alongTangent, alongNormal]`
 * in the material's units; `rotate` is extra degrees, added to the
 * station's heading; `scale` is local, applied before that rotation, and a
 * negative number mirrors. */
export interface PlaceOpts {
  offset?: [number, number];
  rotate?: number;
  scale?: number | [number, number];
}

/** Stations share one prototype, so `place` costs each station no property
 * of its own and a station stays plain data: every field is own and
 * enumerable (spread, JSON and `structuredClone` work; a copy loses only
 * the method). The fields are the same ones `Station` declares. */
const STATION_PROTO = Object.freeze({
  place(this: Station, content: Tree, opts: PlaceOpts = {}): GroupValue {
    const [alongTangent, alongNormal] = opts.offset ?? [0, 0];
    const sc = opts.scale ?? 1;
    const [sx, sy] = typeof sc === 'number' ? [sc, sc] : sc;
    return {
      __occludeGroup: true,
      opts: {
        translate: [
          this.x + this.tangent[0] * alongTangent + this.normal[0] * alongNormal,
          this.y + this.tangent[1] * alongTangent + this.normal[1] * alongNormal,
        ],
        rotate: degrees(this.heading) + (opts.rotate ?? 0),
        scale: [sx, sy],
      },
      children: [content],
    };
  },
});

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
const KIND = Symbol('view');

/** Which kind of view this is — decided by the material that made it,
 * never by the presence of attribute names (an artist may call a column
 * `a`, `b` or `x`). `undefined` for anything that is not a view. */
export function viewKind(view: unknown): 'vertex' | 'edge' | 'face' | undefined {
  return typeof view === 'object' && view !== null ? (view as Record<symbol, 'vertex' | 'edge' | 'face'>)[KIND] : undefined;
}

/** @internal The prototype every view of one owner and kind shares. The
 * brand lives on it — reachable through the chain by `ownedBy` and
 * `viewKind`, and invisible to `Object.keys`, `for…in`, spread and JSON
 * exactly as a non-enumerable own symbol was, so a spread copy is still
 * unowned. A view then costs no property definition of its own: defining
 * two per view was 47% of a 195-step growth render. */
export function viewProto(owner: object, kind: 'vertex' | 'edge' | 'face'): object {
  const proto = {};
  Object.defineProperty(proto, OWNER, { value: owner, enumerable: false });
  Object.defineProperty(proto, KIND, { value: kind, enumerable: false });
  return Object.freeze(proto);
}

/** Column transfer policies a material remembers for its point columns
 * (`attribute(name, value, { transfer })`), used as the default by `split`
 * and `resample`; a per-operation override wins. */
export type TransferPolicy = 'interpolate' | 'nearest';

/** How an EDGE column carries over when an edge is subdivided (split,
 * planarize) or re-sampled: `'copy'` (the default) treats the value as a
 * category — every child edge carries the parent's value, a resampled
 * edge takes the source edge under its midpoint; `'distribute'` treats it
 * as an extensive quantity — each child carries the parent's value times
 * its share of the parent's length, and a resampled edge sums the shares
 * of every source edge it covers. A rest length distributes; a pen index
 * copies. Per-operation `edges` overrides win over either. */
export type EdgeTransfer = 'copy' | 'distribute';

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
  /** Edge attribute columns by name, each `edgeCount` long. */
  readonly edgeAttrs: Readonly<Record<string, Float64Array>>;
  /** Declared transfer policy per point column (default interpolate). */
  readonly transfers: Readonly<Record<string, TransferPolicy>>;
  /** Declared transfer policy per edge column (default copy). */
  readonly edgeTransfers: Readonly<Record<string, EdgeTransfer>>;
  /** Adjacency is built the first time it is asked for, then kept: a growth
   * step makes a state per iteration, and most never ask. The box is
   * mutable inside a frozen material. */
  private readonly adjBox: { rows: number[][] | null };
  private readonly facesBox: { faces: Faces | null };
  private readonly vertexProto: object;
  private readonly edgeProto: object;

  /** @internal Use `material()`/`curve()`/`t.sample()`. Columns are
   * adopted by the constructor but no two materials ever share one: every
   * derived material (attribute, connect, steps, resample, append) copies,
   * and the library never writes to a column after construction. So a
   * snapshot or a source cannot change under you. What remains: typed
   * arrays cannot be frozen, so `m.x[i] = …` from a sketch does write —
   * into that one material only. */
  constructor(
    x: Float64Array,
    y: Float64Array,
    attrs: Record<string, Float64Array>,
    edgeList: Uint32Array,
    iteration = 0,
    history: readonly Snapshot[] = [],
    edgeAttrs: Record<string, Float64Array> = {},
    transfers: Record<string, TransferPolicy> = {},
    edgeTransfers: Record<string, EdgeTransfer> = {},
  ) {
    if (x.length !== y.length) throw new Error('material: x and y columns differ in length');
    for (const [name, col] of Object.entries(edgeAttrs)) {
      if (col.length !== edgeList.length / 2) {
        throw new Error(`material: edge attribute '${name}' has ${col.length} values for ${edgeList.length / 2} edges`);
      }
      if (name === 'a' || name === 'b' || name === 'length' || name === 'index') {
        throw new Error(`material: '${name}' is a reserved edge field`);
      }
    }
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
    this.edgeAttrs = edgeAttrs;
    this.transfers = transfers;
    this.edgeTransfers = edgeTransfers;
    for (let e = 0; e < edgeList.length; e += 2) {
      const a = edgeList[e];
      const b = edgeList[e + 1];
      if (a >= this.n || b >= this.n) throw new Error(`material: edge ${a}–${b} names a vertex beyond ${this.n - 1}`);
      if (a === b) throw new Error(`material: edge ${a}–${b} joins a vertex to itself`);
    }
    this.adjBox = { rows: null };
    this.facesBox = { faces: null };
    this.vertexProto = viewProto(this, 'vertex');
    this.edgeProto = viewProto(this, 'edge');
    Object.freeze(this.attrs);
    Object.freeze(this.edgeAttrs);
    Object.freeze(this.transfers);
    Object.freeze(this.edgeTransfers);
    Object.freeze(this.history);
    Object.freeze(this);
  }

  // ---- access ----

  /** Rows adjacent to each row, in edge order — the same lists the
   * constructor used to build eagerly. */
  private get adj(): number[][] {
    const box = this.adjBox;
    if (box.rows !== null) return box.rows;
    const rows: number[][] = Array.from({ length: this.n }, () => []);
    for (let e = 0; e < this.edgeList.length; e += 2) {
      rows[this.edgeList[e]].push(this.edgeList[e + 1]);
      rows[this.edgeList[e + 1]].push(this.edgeList[e]);
    }
    box.rows = rows;
    return rows;
  }

  /** Names of the attribute columns. */
  get attrNames(): string[] {
    return Object.keys(this.attrs);
  }

  /** The vertex at row `i` as a plain view. */
  vertex(i: number): Vertex {
    const v: Record<string, number> = Object.create(this.vertexProto);
    v.index = i;
    v.x = this.x[i];
    v.y = this.y[i];
    for (const name in this.attrs) v[name] = this.attrs[name][i];
    return v as Vertex;
  }

  /** Every vertex, as a geometry collection: iterate, `length`, `at(i)`,
   * `map` (an array), `find`, `filter` (a selection of this state) and
   * `groupBy` (selections by key). Views are made as you read them. */
  get points(): PointSelection {
    return new PointSelection(this, null);
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

  /** Names of the edge attribute columns. */
  get edgeAttrNames(): string[] {
    return Object.keys(this.edgeAttrs);
  }

  /** The edge at row `e` as a view (a → b in stored order, with attrs). */
  edge(e: number): Edge {
    const a = this.vertex(this.edgeList[2 * e]);
    const b = this.vertex(this.edgeList[2 * e + 1]);
    const attrs: Record<string, number> = {};
    for (const name in this.edgeAttrs) attrs[name] = this.edgeAttrs[name][e];
    const view = Object.create(this.edgeProto) as Edge & Record<string, unknown>;
    view.a = a;
    view.b = b;
    view.length = distance(a, b);
    view.index = e;
    view.attrs = attrs;
    return view as Edge;
  }

  /** Every edge, stored order, as a geometry collection (see `points`);
   * `filter` gives an edge selection whose chains and boundary are those
   * of the selected edges alone. */
  get edges(): EdgeSelection {
    return new EdgeSelection(this, null);
  }

  /** Rows connected to `i` (a row or a vertex view of this state), in edge order. */
  connected(i: Vertex | number): readonly number[] {
    return this.adj[this.rowOfVertex(i, 'connected')];
  }

  degree(i: Vertex | number): number {
    return this.adj[this.rowOfVertex(i, 'degree')].length;
  }

  isConnected(i: Vertex | number, j: Vertex | number): boolean {
    return this.adj[this.rowOfVertex(i, 'isConnected')].includes(this.rowOfVertex(j, 'isConnected'));
  }

  /** The vertices connected to `p` by an edge, as views, in adjacency
   * order — an isolated vertex has none. Topology only: no spatial search
   * (see `neighbours` for that). `p` must be a vertex of this state. */
  connectedPoints(p: Vertex | number): Vertex[] {
    const row = this.rowOfVertex(p, 'connectedPoints');
    return this.adj[row].map((j) => this.vertex(j));
  }

  private rowOfVertex(p: Vertex | number, what: string): number {
    if (typeof p === 'number') {
      if (!Number.isInteger(p) || p < 0 || p >= this.n) throw new Error(`${what}: no vertex ${p} in this state (${this.n} rows)`);
      return p;
    }
    if (ownerOf(p) !== this) throw new Error(`${what}: that vertex belongs to another state`);
    return p.index;
  }

  // ---- planar structure (see faces.ts) ----

  /** Independent material in which every crossing and endpoint-on-edge
   * contact of the sampled edges is a shared vertex. Explicit: nothing
   * else planarizes. See `planarize` for the rules and the resolvers. */
  planarize(opts: PlanarizeOpts = {}): Material {
    return planarize(this, opts);
  }

  /** The bounded regions this (already planar) material encloses. */
  /** The bounded faces of this state (see faces.ts). A frozen state has one
   * face collection: repeated calls return the same object, so a face view
   * from any call is accepted by every consumer of this material's faces. */
  faces(): Faces {
    return (this.facesBox.faces ??= faces(this));
  }

  /** For material made by `t.voronoi`: the cell (a face of this material's
   * `faces()`) of a site vertex, or undefined when the site has no cell
   * (clipped away, or a duplicate of an earlier site). */
  cellOf(site: Vertex): Face | undefined {
    const links = voronoiLinks.get(this);
    if (!links) throw new Error('cellOf: this material has no Voronoi correspondence — it was not made by voronoi(), or it has been edited or extracted since; construct the cells again from the current sites');
    if (!ownedBy(site, links.sites)) throw new Error('cellOf: that vertex is not a site of this diagram (it belongs to another state)');
    const f = links.faceOfSite[site.index];
    return f < 0 ? undefined : links.cells.at(f);
  }

  /** For material made by `t.voronoi`: the site vertex whose cell `face`
   * is, or undefined for a face no site owns. Faces from any `faces()` of
   * the same result are accepted. */
  siteOf(face: Face): Vertex | undefined {
    const links = voronoiLinks.get(this);
    if (!links) throw new Error('siteOf: this material has no Voronoi correspondence — it was not made by voronoi(), or it has been edited or extracted since; construct the cells again from the current sites');
    if (viewKind(face) !== 'face') throw new Error('siteOf: expected a face view');
    const owner = ownerOfView(face) as { source?: Material } | undefined;
    if (!owner || owner.source !== this) throw new Error('siteOf: that face belongs to another material\'s cells');
    const s = links.siteOfFace[face.index];
    return s < 0 ? undefined : links.sites.vertex(s);
  }

  /** Chain convenience: the row before `i` along a stored edge into it,
   * -1 at an open end. On a junction, the first such row. */
  prev(v: Vertex | number): number {
    const i = this.rowOfVertex(v, 'prev');
    for (let e = 0; e < this.edgeList.length; e += 2) if (this.edgeList[e + 1] === i) return this.edgeList[e];
    return -1;
  }

  /** Chain convenience: the row after `i` along a stored edge out of it,
   * -1 at an open end. On a junction, the first such row. */
  next(v: Vertex | number): number {
    const i = this.rowOfVertex(v, 'next');
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
  get contour(): Curve {
    const cs = this.curves();
    if (cs.length === 1) return cs[0];
    if (cs.length === 0) return { pts: this.pts, closed: false, indices: Array.from({ length: this.n }, (_, i) => i) };
    throw new Error(`contour: this material has ${cs.length} chains — use curves()`);
  }

  /**
   * The material as chains for drawing: a deterministic, edge-disjoint walk.
   * Chains start at endpoints and junctions (degree ≠ 2), pass through
   * degree-2 vertices, and end at the next endpoint or junction; edges
   * left over belong to pure cycles, which come back closed. Every edge
   * is covered once; a junction vertex appears in each chain that meets
   * it. Chains come in row order of their first vertex, so a material
   * built from contours keeps contour order. Isolated vertices are not
   * chains — see `points`.
   */
  curves(): Curve[] {
    return walkChains({
      vertexCount: this.n,
      edgeRows: this.edgeRowsAll(),
      endpoints: (e) => [this.edgeList[2 * e], this.edgeList[2 * e + 1]],
      x: this.x,
      y: this.y,
    });
  }

  /** Every edge row, once per call site that walks them. */
  private edgeRowsAll(): ArrayLike<number> {
    const m = this.edgeCount;
    const rows = new Uint32Array(m);
    for (let e = 0; e < m; e++) rows[e] = e;
    return rows;
  }

  /** Highest vertex degree: 1 or 2 for chains and rings, more where the
   * material branches. */
  maxDegree(): number {
    let best = 0;
    for (const row of this.adj) if (row.length > best) best = row.length;
    return best;
  }

  // ---- derived material ----

  /** A new material with a column set: a constant, or one value per vertex. */
  attribute(name: string, value: number | ((p: Vertex) => number), opts: { transfer?: TransferPolicy } = {}): Material {
    return this.attributes({ [name]: value }, opts.transfer ? { transfer: { [name]: opts.transfer } } : {});
  }

  /** A new material with several point columns set at once. Every
   * initializer reads THIS state: a callback sees the vertex as it is here,
   * so no column can read another's newly computed value, and the order of
   * the keys does not matter. `transfer` declares policies per column; a
   * value update keeps a column's declared policy, and an explicit
   * `'interpolate'` restores the default. */
  attributes(values: Record<string, number | ((p: Vertex) => number)>, opts: { transfer?: Record<string, TransferPolicy> } = {}): Material {
    const cols: Record<string, Float64Array> = {};
    for (const name of Object.keys(values)) {
      const value = values[name];
      const col = new Float64Array(this.n);
      if (typeof value === 'number') col.fill(value);
      else for (let i = 0; i < this.n; i++) col[i] = value(this.vertex(i));
      cols[name] = col;
    }
    const transfers = { ...this.transfers };
    for (const [name, policy] of Object.entries(opts.transfer ?? {})) {
      if (!(name in values)) throw new Error(`attributes: transfer names '${name}', which is not being set`);
      if (policy === 'interpolate') delete transfers[name];
      else transfers[name] = policy;
    }
    return new Material(
      copy(this.x), copy(this.y), { ...copyAttrs(this.attrs), ...cols }, copyEdges(this.edgeList), this.iteration, [],
      copyAttrs(this.edgeAttrs), transfers, { ...this.edgeTransfers },
    );
  }

  /** A new material with an EDGE column set: a constant, or one value per
   * edge from its view (`e => e.length`). Each edge has its own row — a
   * junction's three edges can carry three different rest lengths.
   * `transfer` declares how the column subdivides (`'copy'` default,
   * `'distribute'` for a length-proportional quantity); a value update
   * keeps the declared policy, an explicit `'copy'` restores the default. */
  edgeAttribute(name: string, value: number | ((e: Edge) => number), opts: { transfer?: EdgeTransfer } = {}): Material {
    return this.edgeAttributes({ [name]: value }, opts.transfer ? { transfer: { [name]: opts.transfer } } : {});
  }

  /** A new material with several edge columns set at once; every
   * initializer reads THIS state's edges, so a decision about a wall can
   * be written in one pass next to another decision about the same wall,
   * and neither sees the other's result. `transfer` is per column, as for
   * `edgeAttribute`. */
  edgeAttributes(values: Record<string, number | ((e: Edge) => number)>, opts: { transfer?: Record<string, EdgeTransfer> } = {}): Material {
    const cols: Record<string, Float64Array> = {};
    for (const name of Object.keys(values)) {
      const value = values[name];
      const col = new Float64Array(this.edgeCount);
      if (typeof value === 'number') col.fill(value);
      else for (let e = 0; e < this.edgeCount; e++) col[e] = value(this.edge(e));
      cols[name] = col;
    }
    const edgeTransfers = { ...this.edgeTransfers };
    for (const [name, policy] of Object.entries(opts.transfer ?? {})) {
      if (!(name in values)) throw new Error(`edgeAttributes: transfer names '${name}', which is not being set`);
      if (policy === 'copy') delete edgeTransfers[name];
      else edgeTransfers[name] = policy;
    }
    return new Material(
      copy(this.x), copy(this.y), copyAttrs(this.attrs), copyEdges(this.edgeList), this.iteration, [],
      { ...copyAttrs(this.edgeAttrs), ...cols }, { ...this.transfers }, edgeTransfers,
    );
  }

  /** A new material with these edges added (undirected; an existing pair
   * is left as it is). When edge columns are declared, `edgeAttributes`
   * must give every column for the new edges. */
  withEdges(pairs: readonly (readonly [number, number])[], edgeAttributes: Record<string, number> = {}): Material {
    const list = Array.from(this.edgeList);
    const seen = new Set<number>();
    for (let e = 0; e < list.length; e += 2) seen.add(pairKey(list[e], list[e + 1]));
    const names = this.edgeAttrNames;
    const cols: Record<string, number[]> = {};
    for (const name of names) cols[name] = Array.from(this.edgeAttrs[name]);
    // Contract: unknown columns and non-finite values are always an error;
    // every declared column must be given as soon as ONE edge would be
    // added (one record serves every new edge); endpoints are validated
    // for every pair; existing pairs are left as they are; a call that
    // adds nothing needs no attributes.
    checkAttrs(edgeAttributes, names, 'a new edge', { complete: false });
    for (const [a, b] of pairs) {
      if (a === b) throw new Error(`connect: edge ${a}–${b} joins a vertex to itself`);
      if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a >= this.n || b >= this.n) throw new Error(`connect: edge ${a}–${b} names a vertex beyond ${this.n - 1}`);
    }
    if (pairs.some(([a, b]) => !seen.has(pairKey(a, b)))) checkAttrs(edgeAttributes, names, 'a new edge');
    let added = 0;
    for (const [a, b] of pairs) {
      const k = pairKey(a, b);
      if (seen.has(k)) continue;
      seen.add(k);
      list.push(a, b);
      for (const name of names) cols[name].push(edgeAttributes[name]);
      added++;
    }
    const edgeAttrs: Record<string, Float64Array> = {};
    for (const name of names) edgeAttrs[name] = Float64Array.from(cols[name]);
    return new Material(copy(this.x), copy(this.y), copyAttrs(this.attrs), Uint32Array.from(list), this.iteration, [], edgeAttrs, { ...this.transfers }, { ...this.edgeTransfers });
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
    checkSampling('resample', opts);
    for (let i = 0; i < this.n; i++) {
      if (this.adj[i].length > 2) throw new Error(`resample: vertex ${i} is a junction — chains only`);
    }
    const names = this.attrNames;
    const transfer: Record<string, Transfer> = { ...this.transfers, ...(opts.transfer ?? {}) };
    const ox: number[] = [];
    const oy: number[] = [];
    const oattrs: Record<string, number[]> = {};
    for (const name of names) oattrs[name] = [];
    const edges: number[] = [];
    const enames = this.edgeAttrNames;
    const eattrs: Record<string, number[]> = {};
    for (const name of enames) eattrs[name] = [];
    const storedRow = new Map<number, number>();
    for (let e = 0; e < this.edgeCount; e++) storedRow.set(pairKey(this.edgeList[2 * e], this.edgeList[2 * e + 1]), e);
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
    // Isolated vertices are not chains: they come through unchanged.
    for (let i = 0; i < this.n; i++) {
      if (this.adj[i].length === 0) {
        ox.push(this.x[i]);
        oy.push(this.y[i]);
        for (const name of names) oattrs[name].push(this.attrs[name][i]);
      }
    }
    for (const c of this.curves()) {
      const idx = c.indices;
      const first = ox.length;
      const samples = alongChain(idx.map((i) => [this.x[i], this.y[i]] as [number, number]), c.closed, opts);
      // A new edge takes the edge attributes of the source edge under its
      // midpoint (by arc length) — a sample that lands exactly on an old
      // vertex belongs to neither of that vertex's edges by itself.
      const cum = chainLengths(idx.map((i) => [this.x[i], this.y[i]] as [number, number]), c.closed);
      const total = cum[cum.length - 1];
      const at = (k: number) => cum[samples[k].seg] + samples[k].t * (cum[samples[k].seg + 1] - cum[samples[k].seg]);
      const rowOfSeg = (s: number) => storedRow.get(pairKey(idx[s], idx[(s + 1) % idx.length]))!;
      // Samples come in increasing arc length, so the segment under a
      // position is found from where the last one was, never from the start.
      let cursor = 0;
      let spread = 0; // the distribute loop's own cursor: d0 never decreases within a chain
      const segUnder = (d: number) => {
        if (cum[cursor] > d) cursor = 0; // a closed chain's seam wraps once
        while (cursor < cum.length - 2 && cum[cursor + 1] <= d) cursor++;
        return cursor;
      };
      // A new edge over [d0, d1]: a 'copy' column takes the source edge under
      // the midpoint; a 'distribute' column sums each covered source edge's
      // value times the share of that edge the new one covers.
      const link = (from: number, to: number, d0: number, d1: number) => {
        edges.push(from, to);
        const mid = rowOfSeg(segUnder((d0 + d1) / 2));
        for (const name of enames) {
          if (this.edgeTransfers[name] !== 'distribute') {
            eattrs[name].push(this.edgeAttrs[name][mid]);
            continue;
          }
          let sum = 0;
          if (cum[spread] > d0) spread = 0; // a closed chain's seam wraps once
          while (spread < cum.length - 2 && cum[spread + 1] <= d0) spread++; // the first segment the range touches
          for (let s = spread; s + 1 < cum.length && cum[s] < d1; s++) {
            const len = cum[s + 1] - cum[s];
            if (len <= 0) continue;
            const overlap = Math.min(d1, cum[s + 1]) - Math.max(d0, cum[s]);
            if (overlap > 0) sum += this.edgeAttrs[name][rowOfSeg(s)] * (overlap / len);
          }
          eattrs[name].push(sum);
        }
      };
      for (let k = 0; k < samples.length; k++) {
        const { seg, t } = samples[k];
        place(idx[seg], idx[(seg + 1) % idx.length], t);
        if (k > 0) link(first + k - 1, first + k, at(k - 1), at(k));
      }
      if (c.closed && samples.length > 1) link(first + samples.length - 1, first, at(samples.length - 1), total);
    }
    const attrs: Record<string, Float64Array> = {};
    for (const name of names) attrs[name] = Float64Array.from(oattrs[name]);
    const edgeAttrs: Record<string, Float64Array> = {};
    for (const name of enames) edgeAttrs[name] = Float64Array.from(eattrs[name]);
    return new Material(Float64Array.from(ox), Float64Array.from(oy), attrs, Uint32Array.from(edges), this.iteration, [], edgeAttrs, { ...this.transfers }, { ...this.edgeTransfers });
  }

  /**
   * Stations along the material's chains, evenly by arc length, without
   * touching the material — Blender's curve-to-points. Where `t.sample`
   * turns a shape into even vertices and `resample` rebuilds a chain
   * evenly, `along` reads even places off it: for stamping shapes along a
   * curve, dashes, labels, or anything placed by position and direction.
   * The same sampling rules as `resample`: one of `count` or `spacing`,
   * or neither for a station at every vertex, in walk order (the chain's
   * own corners, as `t.material` keeps them); open chains include both ends, closed chains start at the
   * seam and never repeat it; every chain is walked on its own, in
   * `curves()` order; isolated vertices give nothing; a junction is an
   * error. Columns come across by their transfer policies (see `Station`),
   * `transfer` overriding point columns per call as in `resample`.
   */
  along(opts: { spacing?: number; count?: number; transfer?: Record<string, Transfer> } = {}): Station[] {
    const atVertices = opts.spacing === undefined && opts.count === undefined;
    if (!atVertices) checkSampling('along', opts);
    for (let i = 0; i < this.n; i++) {
      if (this.adj[i].length > 2) throw new Error(`along: vertex ${i} is a junction — chains only`);
    }
    const names = this.attrNames;
    const transfer: Record<string, Transfer> = { ...this.transfers, ...(opts.transfer ?? {}) };
    const enames = this.edgeAttrNames;
    const storedRow = new Map<number, number>();
    for (let e = 0; e < this.edgeCount; e++) storedRow.set(pairKey(this.edgeList[2 * e], this.edgeList[2 * e + 1]), e);
    const out: Station[] = [];
    this.curves().forEach((c, chain) => {
      const idx = c.indices;
      const pts = idx.map((i) => [this.x[i], this.y[i]] as [number, number]);
      const segs = c.closed ? idx.length : idx.length - 1;
      // No sampling option: the chain's own vertices, in walk order.
      const samples = atVertices
        ? idx.map((_, k) => (k < segs ? { seg: k, t: 0 } : { seg: segs - 1, t: 1 }))
        : alongChain(pts, c.closed, opts);
      const cum = chainLengths(pts, c.closed);
      const total = cum[segs];
      const rowOfSeg = (sg: number) => storedRow.get(pairKey(idx[sg], idx[(sg + 1) % idx.length]))!;
      const at = (k: number) => cum[samples[k].seg] + samples[k].t * (cum[samples[k].seg + 1] - cum[samples[k].seg]);
      const dir = (sg: number): [number, number] => {
        const a = pts[sg];
        const b = pts[(sg + 1) % idx.length];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        return len > 0 ? [(b[0] - a[0]) / len, (b[1] - a[1]) / len] : [1, 0];
      };
      // The tangent at a vertex is the bisector of the segments meeting
      // there (an open chain's end has one); elsewhere the segment's own.
      const tangentAtVertex = (v: number): [number, number] => {
        const hasPrev = c.closed || v > 0;
        const hasNext = c.closed || v < segs;
        const before = hasPrev ? dir((v - 1 + segs) % segs) : null;
        const after = hasNext ? dir(v % segs) : null;
        if (!before) return after!;
        if (!after) return before;
        const sx = before[0] + after[0];
        const sy = before[1] + after[1];
        const len = Math.hypot(sx, sy);
        return len > 1e-9 ? [sx / len, sy / len] : after; // a hairpin: carry on
      };
      const tangentAt = (seg: number, t: number): [number, number] => {
        if (t <= 1e-9) return tangentAtVertex(seg);
        if (t >= 1 - 1e-9) return tangentAtVertex(seg + 1);
        return dir(seg);
      };
      // The share of chain a station owns for 'distribute' columns: from
      // half way to the previous station to half way to the next; the ends
      // of an open chain own their outer half, a closed chain wraps.
      const owned = (k: number): [number, number] => {
        const here = at(k);
        if (c.closed) {
          const prev = k === 0 ? at(samples.length - 1) - total : at(k - 1);
          const next = k === samples.length - 1 ? at(0) + total : at(k + 1);
          return [(prev + here) / 2, (here + next) / 2];
        }
        return [k === 0 ? 0 : (at(k - 1) + here) / 2, k === samples.length - 1 ? total : (here + at(k + 1)) / 2];
      };
      const shareOver = (name: string, d0: number, d1: number): number => {
        let sum = 0;
        const span = (from: number, to: number) => {
          for (let sg = 0; sg < segs; sg++) {
            const len = cum[sg + 1] - cum[sg];
            if (len <= 0) continue;
            const overlap = Math.min(to, cum[sg + 1]) - Math.max(from, cum[sg]);
            if (overlap > 0) sum += this.edgeAttrs[name][rowOfSeg(sg)] * (overlap / len);
          }
        };
        // a wrapped range on a closed chain is two plain ranges
        if (d0 < 0) { span(d0 + total, total); span(0, d1); }
        else if (d1 > total) { span(d0, total); span(0, d1 - total); }
        else span(d0, d1);
        return sum;
      };
      samples.forEach(({ seg, t }, k) => {
        const a = idx[seg];
        const b = idx[(seg + 1) % idx.length];
        const onVertexAhead = t >= 1 - 1e-9 && seg + 1 < segs;
        const tangent = tangentAt(seg, t);
        const attrs: Record<string, number> = {};
        for (const name of names) {
          const rule = transfer[name] ?? 'interpolate';
          const va = this.attrs[name][a];
          const vb = this.attrs[name][b];
          if (rule === 'interpolate') attrs[name] = va + (vb - va) * t;
          else if (rule === 'nearest') attrs[name] = t <= 0.5 ? va : vb;
          else if (typeof rule === 'number') attrs[name] = rule;
          else attrs[name] = rule(this.vertex(a), this.vertex(b), t);
        }
        const edgeAttrs: Record<string, number> = {};
        for (const name of enames) {
          if (this.edgeTransfers[name] === 'distribute') {
            const [d0, d1] = owned(k);
            edgeAttrs[name] = shareOver(name, d0, d1);
          } else {
            edgeAttrs[name] = this.edgeAttrs[name][rowOfSeg(onVertexAhead ? seg + 1 : seg)];
          }
        }
        const sAt = at(k);
        const st: Station = Object.assign(Object.create(STATION_PROTO), {
          x: pts[seg][0] + (pts[(seg + 1) % idx.length][0] - pts[seg][0]) * t,
          y: pts[seg][1] + (pts[(seg + 1) % idx.length][1] - pts[seg][1]) * t,
          tangent,
          normal: perp(tangent) as [number, number],
          heading: Math.atan2(tangent[1], tangent[0]),
          s: sAt,
          u: total > 0 ? sAt / total : 0,
          length: total,
          chain,
          closed: c.closed,
          attrs,
          edgeAttrs,
        });
        out.push(st);
      });
    });
    return out;
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
    const base = new Material(copy(this.x), copy(this.y), copyAttrs(this.attrs), copyEdges(this.edgeList), this.iteration, [], copyAttrs(this.edgeAttrs), { ...this.transfers }, { ...this.edgeTransfers });
    if (every) snaps.push({ iteration: this.iteration, material: base });
    let cur = base;
    for (let k = 0; k < n; k++) {
      cur = stepOnce(cur, k, rule);
      if (every && (k + 1) % every === 0 && k + 1 < n) snaps.push({ iteration: cur.iteration, material: cur });
    }
    if (every && n > 0) snaps.push({ iteration: cur.iteration, material: cur });
    return every
      ? new Material(copy(cur.x), copy(cur.y), copyAttrs(cur.attrs), copyEdges(cur.edgeList), cur.iteration, snaps, copyAttrs(cur.edgeAttrs), { ...cur.transfers }, { ...cur.edgeTransfers })
      : cur;
  }
}

/** Sampling options shared by `t.sample` and `resample`: exactly one of
 * `count` or `spacing`, both positive. */
export function checkSampling(who: string, opts: { count?: number; spacing?: number }): void {
  if ((opts.spacing === undefined) === (opts.count === undefined)) {
    throw new Error(`${who}: give exactly one of { count, spacing }`);
  }
  if (opts.spacing !== undefined && !(opts.spacing > 0)) throw new Error(`${who}: spacing must be positive`);
  if (opts.count !== undefined && (!Number.isInteger(opts.count) || opts.count < 2)) {
    throw new Error(`${who}: count must be an integer of at least 2 (open) or 3 (closed)`);
  }
}

/**
 * Even samples along a polyline by arc length: for each sample, the
 * segment it lies on and the fraction along it. An open chain gets
 * `count` samples including both ends (`count - 1` gaps); a closed one
 * `count` samples with no duplicate seam (`count` gaps). With `spacing`,
 * the count is the number of gaps that best fits, at least 2 (open) or 3
 * (closed) samples. A zero-length chain yields its first point.
 */
export function alongChain(
  pts: readonly (readonly [number, number])[],
  closed: boolean,
  opts: { count?: number; spacing?: number },
): { seg: number; t: number }[] {
  const n = pts.length;
  const segs = closed ? n : n - 1;
  if (n === 0) return [];
  const cum = chainLengths(pts, closed);
  const total = cum[segs];
  if (!(total > 0)) return [{ seg: 0, t: 0 }];
  let count: number;
  if (opts.count !== undefined) count = Math.max(closed ? 3 : 2, opts.count);
  else {
    const gaps = Math.max(closed ? 3 : 1, Math.round(total / opts.spacing!));
    count = closed ? gaps : gaps + 1;
  }
  const gaps = closed ? count : count - 1;
  const out: { seg: number; t: number }[] = [];
  let seg = 0;
  for (let k = 0; k < count; k++) {
    const d = (total * k) / gaps;
    while (seg < segs - 1 && cum[seg + 1] < d) seg++;
    const len = cum[seg + 1] - cum[seg];
    out.push({ seg, t: len > 0 ? Math.min(1, (d - cum[seg]) / len) : 0 });
  }
  return out;
}

/** A uniform grid over points for ring searches: `ring(cx, cy, r)` lists
 * the rows in the cells at Chebyshev distance r from (cx, cy); a ring's
 * cells are at least (r − 1)·cell away from the centre cell's point, so a
 * search may stop once its best candidate is nearer than the next ring. */
export function pointGrid(x: Float64Array, y: Float64Array, cellsAcross: number): {
  cell: number; cols: number; rows: number; maxRing: number;
  col(px: number): number; row(py: number): number; ring(cx: number, cy: number, r: number): number[];
} {
  let minx = Infinity; let miny = Infinity; let maxx = -Infinity; let maxy = -Infinity;
  for (let i = 0; i < x.length; i++) {
    if (x[i] < minx) minx = x[i]; if (x[i] > maxx) maxx = x[i];
    if (y[i] < miny) miny = y[i]; if (y[i] > maxy) maxy = y[i];
  }
  if (!Number.isFinite(minx)) { minx = miny = 0; maxx = maxy = 1; }
  const cell = Math.max((Math.max(maxx - minx, maxy - miny) || 1) / cellsAcross, 1e-9);
  const cols = Math.floor((maxx - minx) / cell) + 1;
  const rows = Math.floor((maxy - miny) / cell) + 1;
  const buckets: number[][] = Array.from({ length: cols * rows }, () => []);
  const col = (px: number) => Math.min(cols - 1, Math.max(0, Math.floor((px - minx) / cell)));
  const row = (py: number) => Math.min(rows - 1, Math.max(0, Math.floor((py - miny) / cell)));
  for (let i = 0; i < x.length; i++) buckets[row(y[i]) * cols + col(x[i])].push(i);
  const ring = (cx: number, cy: number, r: number): number[] => {
    const out: number[] = [];
    for (let gy = cy - r; gy <= cy + r; gy++) {
      if (gy < 0 || gy >= rows) continue;
      const edge = gy === cy - r || gy === cy + r;
      for (let gx = cx - r; gx <= cx + r; gx += edge || r === 0 ? 1 : 2 * r) {
        if (gx < 0 || gx >= cols) continue;
        for (const j of buckets[gy * cols + gx]) out.push(j);
      }
    }
    return out;
  };
  return { cell, cols, rows, maxRing: Math.max(cols, rows), col, row, ring };
}

/** A child edge's inherited columns: a `'copy'` column carries the parent's
 * value, a `'distribute'` column the parent's value times the child's
 * share of the parent. */
export function inheritEdge(m: Material, parent: Record<string, number>, fraction: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name in parent) out[name] = m.edgeTransfers[name] === 'distribute' ? parent[name] * fraction : parent[name];
  return out;
}

/** Cumulative arc length along a chain: `cum[s]` is the distance to the
 * start of segment `s`, the last entry the total (closed chains include
 * the seam segment). */
function chainLengths(pts: readonly (readonly [number, number])[], closed: boolean): number[] {
  const n = pts.length;
  const segs = closed ? n : n - 1;
  const cum = [0];
  for (let s = 0; s < segs; s++) {
    const a = pts[s];
    const b = pts[(s + 1) % n];
    cum.push(cum[s] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  return cum;
}

const pairKey = (a: number, b: number) => (a < b ? a * 4294967296 + b : b * 4294967296 + a);
const copy = (col: Float64Array) => Float64Array.from(col);
const copyEdges = (list: Uint32Array) => Uint32Array.from(list);
const copyAttrs = (attrs: Readonly<Record<string, Float64Array>>): Record<string, Float64Array> => {
  const out: Record<string, Float64Array> = {};
  for (const k in attrs) out[k] = Float64Array.from(attrs[k]);
  return out;
};

const ownerOf = (p: Vertex): Material | undefined => (p as unknown as Record<symbol, Material>)[OWNER];

/** @internal The owner recorded on any view (a material or a face collection). */
export function ownerOfView(view: object): object | undefined {
  return (view as Record<symbol, object>)[OWNER];
}

/** What a Voronoi construction knows about its sites, kept beside the
 * result (not inside it): the frozen result and its selections answer
 * `cellOf`/`siteOf`; any edited or extracted material does not. */
export interface VoronoiLinks {
  sites: Material;
  siteOfFace: Int32Array;
  faceOfSite: Int32Array;
  cells: Faces;
}
const voronoiLinks = new WeakMap<Material, VoronoiLinks>();

/** @internal */
export function attachVoronoi(m: Material, links: VoronoiLinks): void {
  voronoiLinks.set(m, links);
}

/** True when `view` (a vertex or edge view) came from `m` — this state,
 * not merely a material with the same shape. */
export function ownedBy(view: object, m: object): boolean {
  return (view as unknown as Record<symbol, object>)[OWNER] === m;
}

/** Where the straight segment (ax, ay)→(bx, by) crosses one of `loops`,
 * ascending by the segment parameter `t`, each with the point ON the
 * boundary. That point is taken from the boundary edge's own
 * parametrisation, so for an axis-aligned edge the coordinate that does not
 * change along it survives exactly (60, never 60.000000000000014) — which is
 * what a frame's edge needs. A crossing exactly at either end of the segment
 * is not reported (the vertex is already there), and a collinear overlap
 * reports nothing: the caller decides those by asking whether the middle is
 * inside. Pure; the cost is the segment against every loop segment. */
export function loopCrossings(
  loops: readonly (readonly (readonly [number, number])[])[],
  ax: number,
  ay: number,
  bx: number,
  by: number,
): { t: number; x: number; y: number }[] {
  const dx = bx - ax;
  const dy = by - ay;
  const out: { t: number; x: number; y: number }[] = [];
  for (const loop of loops) {
    for (let k = 0; k < loop.length; k++) {
      const p = loop[k];
      const q = loop[(k + 1) % loop.length];
      const ex = q[0] - p[0];
      const ey = q[1] - p[1];
      const denom = dx * ey - dy * ex;
      if (denom === 0) continue; // parallel or collinear
      const ox = p[0] - ax;
      const oy = p[1] - ay;
      const t = (ox * ey - oy * ex) / denom;
      if (!(t > 0 && t < 1)) continue;
      const u = (ox * dy - oy * dx) / denom;
      if (u >= 0 && u < 1) out.push({ t, x: p[0] + ex * u, y: p[1] + ey * u });
    }
  }
  return out.sort((m, n) => m.t - n.t);
}

/**
 * What lies inside `area` — the same edges, cut where they cross the
 * boundary, everything outside dropped. The point of the verb: a chord built
 * long enough to be sure of crossing a frame ends ON the frame, instead of
 * running on and enclosing slivers outside it.
 *
 * A cut vertex is interpolated by its column's declared policy (`transfer`
 * overrides per call, as in `resample`), an edge column is copied or, when
 * declared `'distribute'`, given its share of the source edge's value. Rows
 * are renumbered, `iteration` is kept and history is dropped — this is an
 * area edit, not an evolution step. On the boundary counts as OUTSIDE, the
 * same rule the engine's clip uses, so a run lying exactly along the edge
 * does not survive. An unconnected vertex is kept when it is inside.
 */
export function withinMaterial(
  m: Material,
  area: Boundary,
  opts: {
    transfer?: Record<string, Transfer>;
    inside?: (x: number, y: number) => number;
    crossings?: (ax: number, ay: number, bx: number, by: number) => { t: number; x: number; y: number }[];
  } = {},
): Material {
  const loops = numericLoops(area, 'within');
  // The caller may bring its own insideness and its own crossing set — `within`
  // does, for an area whose real boundary is not its loops (an interior contour
  // under a nonzero rule is not a boundary at all; see area.ts). Same
  // conventions either way: positive inside, zero on the boundary (which counts
  // as OUTSIDE here, the rule the engine's clip uses), negative outside.
  const inside = opts.inside ?? distanceTo(loops);
  const crossings = opts.crossings
    ?? ((ax: number, ay: number, bx: number, by: number) => loopCrossings(loops, ax, ay, bx, by));
  const names = m.attrNames;
  const transfer: Record<string, Transfer> = { ...m.transfers, ...(opts.transfer ?? {}) };
  const enames = m.edgeAttrNames;
  const ox: number[] = [];
  const oy: number[] = [];
  const oattrs: Record<string, number[]> = {};
  for (const name of names) oattrs[name] = [];
  const edges: number[] = [];
  const eattrs: Record<string, number[]> = {};
  for (const name of enames) eattrs[name] = [];
  const sourceRow = new Map<number, number>();
  // Two edges crossing the boundary at the same point must end at ONE
  // vertex, or the trimmed material is quietly disconnected there. Cut
  // points are matched on their coordinates, quantised well below the
  // 0.005 mm input grid and well above float noise (first edge's columns win).
  const cutRow = new Map<string, number>();

  const columnValue = (name: string, i: number, j: number, t: number): number => {
    const rule = transfer[name] ?? 'interpolate';
    const va = m.attrs[name][i];
    const vb = m.attrs[name][j];
    if (rule === 'interpolate') return va + (vb - va) * t;
    if (rule === 'nearest') return t <= 0.5 ? va : vb;
    if (typeof rule === 'number') return rule;
    return rule(m.vertex(i), m.vertex(j), t);
  };
  const copyVertex = (i: number): number => {
    const seen = sourceRow.get(i);
    if (seen !== undefined) return seen;
    const row = ox.length;
    ox.push(m.x[i]);
    oy.push(m.y[i]);
    for (const name of names) oattrs[name].push(m.attrs[name][i]);
    sourceRow.set(i, row);
    return row;
  };
  const splitAt = (i: number, j: number, t: number, x: number, y: number): number => {
    const key = `${x.toFixed(6)},${y.toFixed(6)}`;
    const seen = cutRow.get(key);
    if (seen !== undefined) return seen;
    const row = ox.length;
    ox.push(x);
    oy.push(y);
    for (const name of names) oattrs[name].push(columnValue(name, i, j, t));
    cutRow.set(key, row);
    return row;
  };

  for (let e = 0; e < m.edgeCount; e++) {
    const a = m.edgeList[2 * e];
    const b = m.edgeList[2 * e + 1];
    const cuts = crossings(m.x[a], m.y[a], m.x[b], m.y[b]);
    const marks: { t: number; x: number; y: number }[] = [
      { t: 0, x: m.x[a], y: m.y[a] },
      ...cuts,
      { t: 1, x: m.x[b], y: m.y[b] },
    ];
    for (let k = 0; k + 1 < marks.length; k++) {
      const from0 = marks[k];
      const to1 = marks[k + 1];
      const mid = (from0.t + to1.t) / 2;
      if (!(inside(m.x[a] + (m.x[b] - m.x[a]) * mid, m.y[a] + (m.y[b] - m.y[a]) * mid) > 0)) continue;
      const from = from0.t === 0 ? copyVertex(a) : splitAt(a, b, from0.t, from0.x, from0.y);
      const to = to1.t === 1 ? copyVertex(b) : splitAt(a, b, to1.t, to1.x, to1.y);
      edges.push(from, to);
      const share = to1.t - from0.t;
      for (const name of enames) {
        const v = m.edgeAttrs[name][e];
        eattrs[name].push(m.edgeTransfers[name] === 'distribute' ? v * share : v);
      }
    }
  }
  // A vertex with no edges is not part of the trim's topology: it is a point,
  // and it survives when it is inside.
  const degree = new Uint32Array(m.n);
  for (let k = 0; k < m.edgeList.length; k++) degree[m.edgeList[k]]++;
  for (let i = 0; i < m.n; i++) {
    if (degree[i] === 0 && inside(m.x[i], m.y[i]) > 0) copyVertex(i);
  }
  const attrs: Record<string, Float64Array> = {};
  for (const name of names) attrs[name] = Float64Array.from(oattrs[name]);
  const edgeAttrs: Record<string, Float64Array> = {};
  for (const name of enames) edgeAttrs[name] = Float64Array.from(eattrs[name]);
  return new Material(
    Float64Array.from(ox),
    Float64Array.from(oy),
    attrs,
    Uint32Array.from(edges),
    m.iteration,
    [],
    edgeAttrs,
    { ...m.transfers },
    { ...m.edgeTransfers },
  );
}

// ---- constructors ----------------------------------------------------------------

/** Points a material can be made from: tuples, `{x, y}` objects (extra numeric
 * fields such as a scatter point's `w` become columns), or a material. */
/** Is this an array of stations, as `along` returns? Empty arrays are not. */
export function isStations(v: unknown): v is readonly Station[] {
  if (!Array.isArray(v) || v.length === 0) return false;
  const q = v[0] as Record<string, unknown>;
  return typeof q === 'object' && q !== null && Array.isArray(q.tangent) && typeof q.heading === 'number'
    && typeof q.s === 'number' && typeof q.chain === 'number' && typeof q.attrs === 'object';
}

/**
 * Stations as a material, for drawing them or for the inspector: a vertex
 * per station in walk order, edges along each chain's walk (wrapping when
 * the chain is closed), and columns `heading`, `s`, `u`, `chain` plus the
 * station's transferred point and edge columns under their own names (a
 * transferred column keeps its name; an intrinsic of the same name gives
 * way). Nothing connects back to the source material.
 */
export function stationsMaterial(stations: readonly Station[]): Material {
  const cols: Record<string, number[]> = {};
  const put = (name: string, k: number, v: number) => {
    (cols[name] ??= new Array(stations.length).fill(NaN))[k] = v;
  };
  const edges: [number, number][] = [];
  let runStart = 0;
  stations.forEach((q, k) => {
    for (const name of Object.keys(q.attrs)) put(name, k, q.attrs[name]);
    for (const name of Object.keys(q.edgeAttrs)) put(name, k, q.edgeAttrs[name]);
    if (k > 0 && stations[k - 1].chain === q.chain) edges.push([k - 1, k]);
    const last = k === stations.length - 1 || stations[k + 1].chain !== q.chain;
    if (k > 0 && stations[k - 1].chain !== q.chain) runStart = k;
    if (last && q.closed && k > runStart + 1) edges.push([k, runStart]);
  });
  for (const name of ['heading', 's', 'u', 'length', 'chain'] as const) {
    if (name in cols) continue;
    cols[name] = stations.map((q) => q[name]);
  }
  return material(stations.map((q) => [q.x, q.y] as [number, number]), { edges, ...cols });
}

/**
 * A point with numeric columns beyond `x` and `y` — `{ x, y, w }` from
 * `t.scatter`, or any extra field a sketch carries: every numeric field
 * becomes a column of the material. This is the shape the constructor has
 * always accepted; the type says so.
 */
export interface PointRecord extends Record<string, number> {
  x: number;
  y: number;
}

export type PointsLike = readonly (XY | PointRecord)[] | Iterable<XY | PointRecord> | Material;

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
  // A point collection (m.points, a selection) is a fine source of points.
  const list: readonly XY[] = Array.isArray(points) ? (points as readonly XY[]) : Array.from(points as Iterable<XY>);
  const n = list.length;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const attrs: Record<string, Float64Array> = {};
  const extra = new Set<string>();
  for (let i = 0; i < n; i++) {
    const p = list[i];
    x[i] = vx(p);
    y[i] = vy(p);
    if (!isArr(p)) {
      for (const [k, v] of Object.entries(p)) if (k !== 'x' && k !== 'y' && k !== 'index' && typeof v === 'number') extra.add(k);
    }
  }
  for (const k of extra) {
    const col = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const p = list[i];
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
  chain(m: PointsLike, edgeAttributes?: Record<string, number>): Material {
    const mm = material(m);
    return mm.withEdges(chainEdges(mm.n, false), edgeAttributes);
  },
  /** Consecutive rows joined and the last joined back to the first. */
  ring(m: PointsLike, edgeAttributes?: Record<string, number>): Material {
    const mm = material(m);
    return mm.withEdges(chainEdges(mm.n, true), edgeAttributes);
  },
  /** Each vertex joined to its `count` nearest others (undirected, no
   * duplicates, self excluded; ties broken by lower row). */
  nearest(m: PointsLike, opts: { count: number; edgeAttributes?: Record<string, number> }): Material {
    const mm = material(m);
    const pairs: [number, number][] = [];
    // Grid search: rings of cells outward until the ring can hold nothing
    // nearer than the k-th candidate found. Ties by (distance, row) exactly
    // as the full scan ordered them.
    const k = opts.count;
    if (!Number.isInteger(k) || k < 0) throw new Error(`connect.nearest: count must be a non-negative integer, got ${k}`);
    if (k === 0 || mm.n < 2) return mm.withEdges([], opts.edgeAttributes);
    const grid = pointGrid(mm.x, mm.y, Math.max(2, Math.ceil(Math.sqrt(mm.n / 2))));
    for (let i = 0; i < mm.n; i++) {
      const cand: [number, number][] = [];
      const cx = grid.col(mm.x[i]);
      const cy = grid.row(mm.y[i]);
      for (let r = 0; ; r++) {
        for (const j of grid.ring(cx, cy, r)) {
          if (j === i) continue;
          const dx = mm.x[j] - mm.x[i];
          const dy = mm.y[j] - mm.y[i];
          cand.push([dx * dx + dy * dy, j]);
        }
        cand.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
        // everything in rings beyond r is at least r·cell away
        const reach = r * grid.cell;
        if ((cand.length >= k && cand[k - 1][0] <= reach * reach) || r > grid.maxRing) break;
      }
      for (const [, j] of cand.slice(0, k)) pairs.push([i, j]);
    }
    return mm.withEdges(pairs, opts.edgeAttributes);
  },
  /** Row i of `a` joined to row i of `b`, in one material (a's rows first).
   * Lengths must match; coincident points stay distinct. */
  pairs(a: PointsLike, b: PointsLike, edgeAttributes?: Record<string, number>): Material {
    const ma = material(a);
    const mb = material(b);
    if (ma.n !== mb.n) throw new Error(`connect.pairs: ${ma.n} and ${mb.n} points — lengths must match`);
    const joined = append(ma, mb);
    const pairs: [number, number][] = [];
    for (let i = 0; i < ma.n; i++) pairs.push([i, ma.n + i]);
    return joined.withEdges(pairs, edgeAttributes);
  },
  /** Delaunay triangulation edges over the vertices. */
  /** Delaunay edges over the rows, by index. Coincident rows: the FIRST
   * row at a position takes part in the triangulation and its edges; later
   * rows at the same position stay isolated (they are still rows). Fewer
   * than three distinct positions, or all collinear, give no edges. */
  triangulate(m: PointsLike, edgeAttributes?: Record<string, number>): Material {
    const mm = material(m);
    const firstAt = new Map<string, number>();
    const unique: number[] = [];
    for (let i = 0; i < mm.n; i++) {
      const k = `${mm.x[i]},${mm.y[i]}`;
      if (firstAt.has(k)) continue;
      firstAt.set(k, i);
      unique.push(i);
    }
    if (unique.length < 3) return mm.withEdges([], edgeAttributes);
    // All collinear: no triangle exists (d3 would perturb the points into a
    // sliver); decided exactly.
    const [u0, u1] = unique;
    if (unique.every((row) => orient2d(mm.x[u0], mm.y[u0], mm.x[u1], mm.y[u1], mm.x[row], mm.y[row]) === 0)) return mm.withEdges([], edgeAttributes);
    const tri = Delaunay.from(unique.map((row) => [mm.x[row], mm.y[row]] as [number, number])).triangles;
    const pairs: [number, number][] = [];
    for (let k = 0; k + 2 < tri.length; k += 3) {
      const a = unique[tri[k]];
      const b = unique[tri[k + 1]];
      const c = unique[tri[k + 2]];
      pairs.push([a, b], [b, c], [c, a]);
    }
    return mm.withEdges(pairs, edgeAttributes);
  },
};

/** Two materials as one: b's rows after a's, b's edges re-based. Both must
 * have the same columns, or `fill` must give the value a column takes on
 * the side that lacks it — nothing is dropped silently. */
/**
 * One material from two: `b`'s rows after `a`'s, edges renumbered. Both
 * sides must have the same point and edge columns, or the caller says what
 * a side that lacks a column gets: `fill: { active: 0 }` writes 0 into
 * `active` on the side that has no `active`, and only there; values a side
 * already has are never touched, and a missing column with no fill is an
 * error naming it, never a silent zero. A column both sides declare must
 * agree on its transfer policy (a column nobody declared interpolates); a
 * column only one side declares keeps that side's policy, filled rows
 * included. `edgeFill` does the same for edge columns, whose default
 * policy is `'copy'`.
 */
export function append(
  a: Material,
  b: Material,
  opts: { fill?: Record<string, number>; edgeFill?: Record<string, number> } = {},
): Material {
  const fill = opts.fill ?? {};
  const edgeFill = opts.edgeFill ?? {};
  const names = Array.from(new Set([...a.attrNames, ...b.attrNames]));
  for (const k of names) {
    if (!(k in a.attrs) || !(k in b.attrs)) {
      if (!(k in fill)) {
        const side = k in a.attrs ? 'second' : 'first';
        throw new Error(`append: the ${side} material has no '${k}' — give fill: { ${k}: … } or match the columns`);
      }
    }
  }
  const enames = Array.from(new Set([...a.edgeAttrNames, ...b.edgeAttrNames]));
  for (const k of enames) {
    if (!(k in a.edgeAttrs) || !(k in b.edgeAttrs)) {
      if (!(k in edgeFill)) {
        const side = k in a.edgeAttrs ? 'second' : 'first';
        throw new Error(`append: the ${side} material has no edge column '${k}' — give edgeFill: { ${k}: … } or match the columns`);
      }
    }
  }
  // Policies are compared as they take effect — an undeclared column
  // interpolates — so joining sides cannot silently change how a column
  // splits afterwards.
  const effective = (m: Material, k: string): TransferPolicy => m.transfers[k] ?? 'interpolate';
  for (const k of names) {
    if (k in a.attrs && k in b.attrs && effective(a, k) !== effective(b, k)) {
      throw new Error(`append: '${k}' has transfer '${effective(a, k)}' on one side and '${effective(b, k)}' on the other`);
    }
  }
  const effectiveEdge = (m: Material, k: string): EdgeTransfer => m.edgeTransfers[k] ?? 'copy';
  for (const k of enames) {
    if (k in a.edgeAttrs && k in b.edgeAttrs && effectiveEdge(a, k) !== effectiveEdge(b, k)) {
      throw new Error(`append: edge column '${k}' has transfer '${effectiveEdge(a, k)}' on one side and '${effectiveEdge(b, k)}' on the other`);
    }
  }
  const x = new Float64Array(a.n + b.n);
  const y = new Float64Array(a.n + b.n);
  x.set(a.x);
  x.set(b.x, a.n);
  y.set(a.y);
  y.set(b.y, a.n);
  const attrs: Record<string, Float64Array> = {};
  for (const k of names) {
    const col = new Float64Array(a.n + b.n);
    if (k in a.attrs) col.set(a.attrs[k]);
    else col.fill(fill[k], 0, a.n);
    if (k in b.attrs) col.set(b.attrs[k], a.n);
    else col.fill(fill[k], a.n);
    attrs[k] = col;
  }
  const edges = new Uint32Array(a.edgeList.length + b.edgeList.length);
  edges.set(a.edgeList);
  for (let e = 0; e < b.edgeList.length; e++) edges[a.edgeList.length + e] = b.edgeList[e] + a.n;
  const edgeAttrs: Record<string, Float64Array> = {};
  for (const k of enames) {
    const col = new Float64Array(a.edgeCount + b.edgeCount);
    if (k in a.edgeAttrs) col.set(a.edgeAttrs[k]);
    else col.fill(edgeFill[k], 0, a.edgeCount);
    if (k in b.edgeAttrs) col.set(b.edgeAttrs[k], a.edgeCount);
    else col.fill(edgeFill[k], a.edgeCount);
    edgeAttrs[k] = col;
  }
  return new Material(x, y, attrs, edges, 0, [], edgeAttrs, { ...b.transfers, ...a.transfers }, { ...b.edgeTransfers, ...a.edgeTransfers });
}

// ---- one step ---------------------------------------------------------------------

/** A vertex added or split in this edit batch, usable before the batch
 * resolves — and only there: a handle carries its batch and is refused by
 * any other. Opaque: no coordinates to read. */
export interface Handle {
  readonly __handle: number;
  readonly __batch: object;
}

/** A point reference an edit accepts: a row of the current state, a
 * vertex view of the current state, or a handle from this batch. A bare
 * number always means a row. */
export type Ref = number | Vertex | Handle;

const isHandle = (r: unknown): r is Handle => typeof r === 'object' && r !== null && '__handle' in r;
const isVertexView = (r: unknown): r is Vertex => viewKind(r) === 'vertex';

/** One child of `extend`: a new point (`position` + `attributes`) or an
 * existing target (`to`); either way an edge from the parent, carrying
 * `edgeAttributes` when edge columns are declared. A new point must name
 * every declared column, unless `extend` runs with `inherit: true`, in
 * which case it starts from its parent's values and `attributes` are the
 * overrides. */
export type ChildSpec =
  | { position: XY; attributes?: Record<string, number>; edgeAttributes?: Record<string, number>; to?: undefined }
  | { to: Ref; edgeAttributes?: Record<string, number>; position?: undefined };

/** The interval of a split child edge in the ORIGINAL edge's parameter
 * space: `from` → `to`, and its share `fraction = to - from`. */
export interface ChildInterval {
  from: number;
  to: number;
  fraction: number;
}

export interface SplitOpts {
  /** Fraction along the edge (stored a → b), default 0.5; 0 or 1 return
   * the existing endpoint and create nothing. */
  at?: number;
  /** Point attributes for the inserted vertex, merged over the inherited
   * ones (declared transfer policies, interpolate by default): a partial
   * record, or a callback of the moved parent edge and `at`. */
  point?: Record<string, number> | ((e: Edge, at: number) => Record<string, number>);
  /** Edge attributes for each child edge, merged over the parent's
   * (updated) values: a partial record, or a callback of the moved parent
   * edge and the child's interval. */
  edges?: Record<string, number> | ((e: Edge, child: ChildInterval) => Record<string, number>);
  /** Migration: the pre-edge-column spelling of `point` (a full or partial
   * record, or a callback of the edge). */
  attributes?: Record<string, number> | ((e: Edge) => Record<string, number>);
  /** Migration: rewrite the START vertex's point attributes on split. Only
   * meaningful for the old "edge attribute on its start vertex" idiom;
   * real edge columns use `edges`. */
  parent?: (e: Edge) => Record<string, number>;
}

/**
 * The next state under construction. Every vertex and edge starts as a
 * copy of the current one, so a rule only states what changes. All
 * callbacks and selectors see the FROZEN current state; no edit changes
 * what a later callback reads. Order of resolution: moves and attribute
 * writes first (moves add up, the last write of a field wins), then bulk
 * `splitEdges` predicates on the MOVED edges, then structural requests —
 * removals, disconnections, splits (sorted along each original edge),
 * added points, connections — then one compaction. A conflicting batch
 * (see the table in the docs) throws and publishes nothing.
 */
/** A row of the current state's edge list, or an edge view of it. */
export type EdgeRef = number | Edge;
/** A predicate over the current state's views, or a selection OF THE
 * CURRENT STATE (membership by row, decided when the selection was made —
 * before any move in this step). */
export type PointWhere = ((p: Vertex) => boolean) | PointSelection;
export type EdgeWhere = ((e: Edge) => boolean) | EdgeSelection;

export interface Next {
  /** Displace one vertex, or every vertex `where` says (all by default). */
  move(index: Ref, by: XY): void;
  move(by: (p: Vertex) => XY, opts?: { where?: PointWhere }): void;
  /** Write point attributes on one vertex, or on every vertex `where`
   * says. Unknown names are an error: columns are declared, not invented. */
  set(index: Ref, attrs: Record<string, number>): void;
  set(attrs: (p: Vertex) => Record<string, number>, opts?: { where?: PointWhere }): void;
  /** Write edge attributes on one edge of the current state. */
  setEdge(edge: EdgeRef, attrs: Record<string, number>): void;
  /** Write edge attributes on every edge `where` says (all by default). */
  setEdges(attrs: (e: Edge) => Record<string, number>, opts?: { where?: EdgeWhere }): void;
  /** A new vertex; the handle names it within this batch. Every declared
   * point column must be given. */
  addPoint(position: XY, attributes: Record<string, number>): Handle;
  /** One undirected connection. An existing pair is left as it is (use
   * `setEdge` to change its attributes); a self-connection is an error.
   * Every declared edge column must be given. */
  connect(a: Ref, b: Ref, edgeAttributes?: Record<string, number>): void;
  /** Remove an edge; both points stay. Repeating it is a no-op. A
   * predicate removes every current edge it accepts. */
  disconnect(edge: EdgeRef): void;
  disconnect(where: EdgeWhere): void;
  /** Delete a point and its incident edges; the neighbours are never
   * joined. Repeating it is a no-op. A predicate removes every current
   * vertex it accepts. */
  remove(point: Ref): void;
  remove(where: PointWhere): void;
  /** Replace an edge of the current state with two child edges through a
   * new vertex at `at` (default 0.5), returning its handle — or, at 0 or
   * 1, the existing endpoint row. Several splits of one edge form one
   * chain in parameter order; equal parameters share a vertex. */
  split(edge: EdgeRef, opts?: SplitOpts): Ref;
  /** Bulk split on the MOVED edges — same machinery and defaults as
   * `split`; `where` sees each edge as it will be after the moves. */
  splitEdges(where: EdgeWhere, opts?: SplitOpts): void;
  /** For every current vertex `where` says: add the child (or children)
   * `spec` describes — a new point, or a connection to an existing target
   * (`{ to }`) — and connect each to its parent. `[]` means none. */
  /** With `inherit: true`, every new child starts from its parent's point
   * attributes and the spec's `attributes` override them; a child that
   * connects to an existing vertex (`to`) never changes that vertex. */
  extend(spec: (p: Vertex) => ChildSpec | ChildSpec[], opts?: { where?: PointWhere; inherit?: boolean }): void;
}

function checkAttrs(attrs: Record<string, number>, names: string[], what: string, opts: { complete?: boolean } = {}): void {
  if (opts.complete !== false) {
    for (const name of names) {
      if (!(name in attrs)) throw new Error(`steps: must give '${name}' for ${what} (every attribute is a choice)`);
    }
  }
  for (const name in attrs) {
    if (!names.includes(name)) throw new Error(`steps: no attribute '${name}' — declare it first`);
  }
  for (const name in attrs) {
    if (!Number.isFinite(attrs[name])) throw new Error(`steps: '${name}' for ${what} is not a finite number`);
  }
}

function finiteXY(v: XY, what: string): [number, number] {
  const x = vx(v);
  const y = vy(v);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`steps: ${what} is not finite`);
  return [x, y];
}

interface SplitRequest {
  at: number;
  point?: SplitOpts['point'];
  edges?: SplitOpts['edges'];
  attributes?: SplitOpts['attributes'];
  parent?: SplitOpts['parent'];
  /** Handle allotted to the inserted vertex (bulk splits get none). */
  handle?: number;
}

function stepOnce(cur: Material, k: number, rule: (c: Material, n: Next, k: number) => void): Material {
  const n = cur.n;
  const m = cur.edgeCount;
  const names = cur.attrNames;
  const enames = cur.edgeAttrNames;
  const batch = {};

  // ---- what the rule records ----
  const nx = Float64Array.from(cur.x);
  const ny = Float64Array.from(cur.y);
  const nattrs: Record<string, Float64Array> = {};
  for (const name of names) nattrs[name] = Float64Array.from(cur.attrs[name]);
  const neattrs: Record<string, Float64Array> = {};
  for (const name of enames) neattrs[name] = Float64Array.from(cur.edgeAttrs[name]);
  const touchedPoint = new Set<number>(); // rows an explicit move/set named
  const touchedEdge = new Set<number>(); // edge rows setEdge/setEdges named
  const removed = new Set<number>();
  const disconnected = new Set<number>();
  const splits = new Map<number, SplitRequest[]>(); // by ORIGINAL edge row
  const bulkSplits: { where: (e: Edge) => boolean; req: SplitRequest }[] = [];
  const added: { x: number; y: number; attrs: Record<string, number> }[] = [];
  const links: { a: Ref; b: Ref; attrs: Record<string, number> }[] = [];
  const points = cur.points; // frozen views for the collection forms
  let edgeViews: Edge[] | null = null;
  const currentEdges = () => (edgeViews ??= Array.from(cur.edges));

  const rowOf = (r: Ref, what: string): number => {
    if (isHandle(r)) throw new Error(`steps: ${what} cannot be a handle here`);
    if (isVertexView(r)) {
      if (ownerOf(r) !== cur) throw new Error(`steps: ${what} is a vertex of another material`);
      return r.index;
    }
    if (!Number.isInteger(r) || r < 0 || r >= n) throw new Error(`steps: ${what}: no vertex ${String(r)} in this state (${n} rows)`);
    return r;
  };
  const edgeRow = (e: EdgeRef, what: string): number => {
    if (typeof e === 'number') {
      if (!Number.isInteger(e) || e < 0 || e >= m) throw new Error(`steps: ${what}: no edge ${e} in this state (${m} edges)`);
      return e;
    }
    if (viewKind(e) !== 'edge') throw new Error(`steps: ${what} must be an edge row or view`);
    if (ownerOf(e as unknown as Vertex) !== cur) throw new Error(`steps: ${what} is an edge of another material (or another state)`);
    return e.index;
  };
  // A selection as `where`: it must be OF this state; membership is by row,
  // decided when the selection was made, so it also serves bulk splits,
  // whose predicate form sees the moved views.
  const pointTest = (w: PointWhere | undefined, what: string): ((p: Vertex) => boolean) | undefined => {
    if (w === undefined || typeof w === 'function') return w;
    if (!(w instanceof PointSelection)) throw new Error(`steps: ${what}: where must be a predicate or a point selection`);
    if (w.source !== cur) throw new Error(`steps: ${what}: that selection is of another state — select from \`current\` inside the rule`);
    const rows = new Set(w.indices);
    return (p) => rows.has(p.index);
  };
  const edgeTest = (w: EdgeWhere | undefined, what: string): ((e: Edge) => boolean) | undefined => {
    if (w === undefined || typeof w === 'function') return w;
    if (!(w instanceof EdgeSelection)) throw new Error(`steps: ${what}: where must be a predicate or an edge selection`);
    if (w.source !== cur) throw new Error(`steps: ${what}: that selection is of another state — select from \`current\` inside the rule`);
    const rows = new Set(w.indices);
    return (e) => rows.has(e.index);
  };
  const writePoint = (index: number, attrs: Record<string, number>) => {
    for (const [name, v] of Object.entries(attrs)) {
      const col = nattrs[name];
      if (!col) throw new Error(`steps: no attribute '${name}' — declare it first`);
      if (!Number.isFinite(v)) throw new Error(`steps: '${name}' is not a finite number`);
      col[index] = v;
    }
  };
  const writeEdge = (row: number, attrs: Record<string, number>) => {
    for (const [name, v] of Object.entries(attrs)) {
      const col = neattrs[name];
      if (!col) throw new Error(`steps: no edge attribute '${name}' — declare it with edgeAttribute()`);
      if (!Number.isFinite(v)) throw new Error(`steps: '${name}' is not a finite number`);
      col[row] = v;
    }
  };
  // Options are recorded as they are at the call: a plain record is
  // copied, a callback stays a function (it runs on the moved state).
  const byValue = <T,>(v: T): T => (v !== null && typeof v === 'object' ? ({ ...(v as object) } as T) : v);
  const splitRequest = (opts: SplitOpts, at: number): SplitRequest => ({
    at, point: byValue(opts.point), edges: byValue(opts.edges), attributes: byValue(opts.attributes), parent: opts.parent,
  });
  const recordSplit = (row: number, req: SplitRequest) => {
    const list = splits.get(row) ?? [];
    list.push(req);
    splits.set(row, list);
  };

  const next: Next = {
    move(a: Ref | ((p: Vertex) => XY), b?: XY | { where?: PointWhere }) {
      if (typeof a === 'function') {
        const where = pointTest((b as { where?: PointWhere } | undefined)?.where, 'move');
        for (const p of points) {
          if (where && !where(p)) continue;
          const [dx, dy] = finiteXY(a(p), 'a move');
          nx[p.index] += dx;
          ny[p.index] += dy;
          touchedPoint.add(p.index);
        }
        return;
      }
      const row = rowOf(a, 'move');
      const [dx, dy] = finiteXY(b as XY, 'a move');
      nx[row] += dx;
      ny[row] += dy;
      touchedPoint.add(row);
    },
    set(a: Ref | ((p: Vertex) => Record<string, number>), b?: Record<string, number> | { where?: PointWhere }) {
      if (typeof a === 'function') {
        const where = pointTest((b as { where?: PointWhere } | undefined)?.where, 'set');
        for (const p of points) {
          if (where && !where(p)) continue;
          writePoint(p.index, a(p));
          touchedPoint.add(p.index);
        }
        return;
      }
      const row = rowOf(a, 'set');
      writePoint(row, b as Record<string, number>);
      touchedPoint.add(row);
    },
    setEdge(edge, attrs) {
      const row = edgeRow(edge, 'setEdge');
      writeEdge(row, attrs);
      touchedEdge.add(row);
    },
    setEdges(attrs, opts) {
      const where = edgeTest(opts?.where, 'setEdges');
      for (const e of currentEdges()) {
        if (where && !where(e)) continue;
        writeEdge(e.index, attrs(e));
        touchedEdge.add(e.index);
      }
    },
    addPoint(position, attributes) {
      checkAttrs(attributes, names, 'a new vertex');
      const [x, y] = finiteXY(position, 'a new vertex');
      added.push({ x, y, attrs: { ...attributes } });
      return { __handle: added.length - 1, __batch: batch };
    },
    connect(a, b, edgeAttributes = {}) {
      // unknown names fail now; completeness is judged once we know the
      // pair is new (an existing pair is left as it is and needs nothing)
      checkAttrs(edgeAttributes, enames, 'a new edge', { complete: false });
      links.push({ a, b, attrs: { ...edgeAttributes } });
    },
    disconnect(edge: EdgeRef | EdgeWhere) {
      // a row or an edge view names one edge; anything else is a predicate or a selection
      if (typeof edge === 'number' || viewKind(edge) === 'edge') {
        disconnected.add(edgeRow(edge as EdgeRef, 'disconnect'));
        return;
      }
      const where = edgeTest(edge as EdgeWhere, 'disconnect')!;
      for (const e of currentEdges()) if (where(e)) disconnected.add(e.index);
    },
    remove(point: Ref | PointWhere) {
      if (typeof point === 'number' || isHandle(point) || viewKind(point) === 'vertex') {
        removed.add(rowOf(point as Ref, 'remove'));
        return;
      }
      const where = pointTest(point as PointWhere, 'remove')!;
      for (const p of points) if (where(p)) removed.add(p.index);
    },
    split(edge, opts = {}) {
      const row = edgeRow(edge, 'split');
      const at = opts.at ?? 0.5;
      if (!Number.isFinite(at) || at < 0 || at > 1) throw new Error(`steps: split at ${at} — must be within [0, 1]`);
      if (at === 0 || at === 1) {
        // Nothing is created, so the overrides, which describe what a
        // created point or child edge would carry, have nothing to apply
        // to: the existing endpoint is returned as it is. A `firstHit` that
        // touches a vertex lands here, and a join rule should not have to
        // special-case it.
        return at === 0 ? cur.edgeList[2 * row] : cur.edgeList[2 * row + 1];
      }
      const handle = added.length;
      added.push({ x: NaN, y: NaN, attrs: {} }); // placeholder: resolved by the split
      recordSplit(row, { ...splitRequest(opts, at), handle });
      return { __handle: handle, __batch: batch };
    },
    splitEdges(where, opts = {}) {
      const at = opts.at ?? 0.5;
      if (!Number.isFinite(at) || at < 0 || at > 1) throw new Error(`steps: splitEdges at ${at} — must be within [0, 1]`);
      // The same rule as split: an endpoint parameter creates nothing (a
      // single split returns the existing endpoint; here there is nothing
      // to return), and overrides that would rewrite existing data refuse.
      if (at === 0 || at === 1) {
        if (opts.point || opts.edges || opts.attributes || opts.parent) throw new Error('steps: a split at an endpoint creates nothing — point/edge overrides would modify existing data');
        return;
      }
      bulkSplits.push({ where: edgeTest(where, 'splitEdges')!, req: splitRequest(opts, at) });
    },
    extend(spec, opts) {
      const where = pointTest(opts?.where, 'extend');
      const inherit = opts?.inherit === true;
      const inherited = (p: Vertex): Record<string, number> => {
        const out: Record<string, number> = {};
        for (const name of names) out[name] = cur.attrs[name][p.index];
        return out;
      };
      for (const p of points) {
        if (where && !where(p)) continue;
        const specs = spec(p);
        for (const sp of Array.isArray(specs) ? specs : [specs]) {
          const hasPos = sp.position !== undefined;
          const hasTo = sp.to !== undefined;
          if (hasPos === hasTo) throw new Error('steps: extend needs exactly one of { position } (a new child) or { to } (an existing target)');
          const own = (sp as { attributes?: Record<string, number> }).attributes ?? {};
          const target: Ref = hasPos ? next.addPoint(sp.position!, inherit ? { ...inherited(p), ...own } : own) : sp.to!;
          next.connect(p.index, target, sp.edgeAttributes ?? {});
        }
      }
    },
  };
  rule(cur, next, k);

  // ---- the moved state: bulk split predicates and transfer callbacks read it ----
  const moved = new Material(nx, ny, nattrs, cur.edgeList, cur.iteration + 1, [], neattrs, { ...cur.transfers }, { ...cur.edgeTransfers });
  const movedEdges = moved.edges;
  for (const { where, req } of bulkSplits) {
    for (const e of movedEdges) if (where(e)) recordSplit(e.index, req);
  }

  // ---- conflicts ----
  const incident = (row: number) => removed.has(cur.edgeList[2 * row]) || removed.has(cur.edgeList[2 * row + 1]);
  for (const row of removed) {
    if (touchedPoint.has(row)) throw new Error(`steps: vertex ${row} is removed and also moved or set in this step — use a selector that excludes it`);
  }
  for (const [row] of splits) {
    if (disconnected.has(row)) throw new Error(`steps: edge ${row} is split and disconnected in the same step`);
    if (incident(row)) throw new Error(`steps: edge ${row} is split but one of its vertices is removed in this step`);
  }
  for (const row of touchedEdge) {
    if (disconnected.has(row)) throw new Error(`steps: edge ${row} has attributes set and is disconnected in the same step`);
  }

  // ---- resolve splits per original edge: sorted, deduplicated, one definition each ----
  interface Cut { at: number; row: number; point: Record<string, number>; explicit: Record<string, number> }
  const cutsByEdge = new Map<number, Cut[]>();
  const childEdgeOverride = new Map<number, SplitOpts['edges']>();
  const sameDef = (a: unknown, b: unknown) => a === b || (typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b));
  // Legacy `parent` rewrites land on the moved columns, but every split
  // inherits from the state as it stood BEFORE any of them: the frozen
  // moved state is what all callbacks read, so a rewrite on one edge can
  // never change what a split on another edge inherits.
  const inheritFrom: Record<string, Float64Array> = {};
  const anyParent = Array.from(splits.values()).some((reqs) => reqs.some((r) => r.parent));
  for (const name of names) inheritFrom[name] = anyParent ? Float64Array.from(nattrs[name]) : nattrs[name];
  for (const [row, reqs] of splits) {
    const parentEdge = movedEdges.at(row);
    // legacy `parent`: rewrite the start vertex's point attributes
    for (const r of reqs) {
      if (r.parent) {
        const upd = r.parent(parentEdge);
        writePoint(parentEdge.a.index, upd);
      }
    }
    // one child-edge definition per parent per batch
    let edgesDef: SplitOpts['edges'] = undefined;
    let haveDef = false;
    for (const r of reqs) {
      if (r.edges === undefined) continue;
      if (!haveDef) { edgesDef = r.edges; haveDef = true; }
      else if (!sameDef(edgesDef, r.edges)) throw new Error(`steps: edge ${row} is split with two different child-edge definitions in one step`);
    }
    childEdgeOverride.set(row, edgesDef);
    // inherited point attributes at each parameter, then explicit overrides
    const byAt = new Map<number, Cut>();
    const pa = parentEdge.a;
    const pb = parentEdge.b;
    const inherit = (at: number): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const name of names) {
        const va = inheritFrom[name][pa.index];
        const vb = inheritFrom[name][pb.index];
        out[name] = cur.transfers[name] === 'nearest' ? (at <= 0.5 ? va : vb) : va + (vb - va) * at;
      }
      return out;
    };
    for (const r of reqs) {
      const explicit: Record<string, number> = {};
      const legacy = typeof r.attributes === 'function' ? r.attributes(parentEdge) : r.attributes;
      if (legacy) Object.assign(explicit, legacy);
      const pt = typeof r.point === 'function' ? r.point(parentEdge, r.at) : r.point;
      if (pt) Object.assign(explicit, pt);
      for (const name in explicit) {
        if (!names.includes(name)) throw new Error(`steps: no attribute '${name}' — declare it first`);
        if (!Number.isFinite(explicit[name])) throw new Error(`steps: '${name}' for a split vertex is not a finite number`);
      }
      const existing = byAt.get(r.at);
      if (existing) {
        // the same parameter twice: explicit overrides may agree or add, never disagree
        for (const name in explicit) {
          if (name in existing.explicit && existing.explicit[name] !== explicit[name]) {
            throw new Error(`steps: edge ${row} split at ${r.at} twice with conflicting '${name}' (${existing.explicit[name]} vs ${explicit[name]})`);
          }
          existing.explicit[name] = explicit[name];
          existing.point[name] = explicit[name];
        }
        continue;
      }
      byAt.set(r.at, { at: r.at, row: -1, point: { ...inherit(r.at), ...explicit }, explicit });
    }
    const cuts = Array.from(byAt.values()).sort((p, q) => p.at - q.at);
    cutsByEdge.set(row, cuts);
    // handles for split vertices resolve to the cut at their parameter
    for (const r of reqs) if (r.handle !== undefined) (added[r.handle] as { cutOf?: [number, number] }).cutOf = [row, r.at];
  }

  // ---- compact rows: survivors in order, split vertices after their edge's start row, new points last ----
  const rowMap = new Int32Array(n).fill(-1);
  const ox: number[] = [];
  const oy: number[] = [];
  const oattrs: Record<string, number[]> = {};
  for (const name of names) oattrs[name] = [];
  const cutRow = new Map<string, number>(); // `${edge}@${at}` → row
  const insertAfter = new Map<number, [number, Cut][]>();
  for (const [row, cuts] of cutsByEdge) {
    const a = cur.edgeList[2 * row];
    const list = insertAfter.get(a) ?? [];
    for (const c of cuts) list.push([row, c]);
    insertAfter.set(a, list);
  }
  for (let i = 0; i < n; i++) {
    if (removed.has(i)) continue;
    rowMap[i] = ox.length;
    ox.push(nx[i]);
    oy.push(ny[i]);
    for (const name of names) oattrs[name].push(nattrs[name][i]);
    for (const [row, c] of insertAfter.get(i) ?? []) {
      const e = movedEdges.at(row);
      cutRow.set(`${row}@${c.at}`, ox.length);
      ox.push(e.a.x + (e.b.x - e.a.x) * c.at);
      oy.push(e.a.y + (e.b.y - e.a.y) * c.at);
      for (const name of names) oattrs[name].push(c.point[name]);
    }
  }
  const handleRow = new Int32Array(added.length).fill(-1);
  for (let h = 0; h < added.length; h++) {
    const cutOf = (added[h] as { cutOf?: [number, number] }).cutOf;
    if (cutOf) {
      handleRow[h] = cutRow.get(`${cutOf[0]}@${cutOf[1]}`)!;
      continue;
    }
    handleRow[h] = ox.length;
    ox.push(added[h].x);
    oy.push(added[h].y);
    for (const name of names) oattrs[name].push(added[h].attrs[name]);
  }

  // ---- edges: survivors (split into chains), then new connections ----
  const edges: number[] = [];
  const eattrs: Record<string, number[]> = {};
  for (const name of enames) eattrs[name] = [];
  const pushEdge = (a: number, b: number, attrs: Record<string, number>) => {
    edges.push(a, b);
    for (const name of enames) eattrs[name].push(attrs[name]);
  };
  for (let e = 0; e < m; e++) {
    if (disconnected.has(e) || incident(e)) continue;
    const a = rowMap[cur.edgeList[2 * e]];
    const b = rowMap[cur.edgeList[2 * e + 1]];
    const parentAttrs: Record<string, number> = {};
    for (const name of enames) parentAttrs[name] = neattrs[name][e];
    const cuts = cutsByEdge.get(e);
    if (!cuts) {
      pushEdge(a, b, parentAttrs);
      continue;
    }
    const override = childEdgeOverride.get(e);
    const stops = [0, ...cuts.map((c) => c.at), 1];
    const rows = [a, ...cuts.map((c) => cutRow.get(`${e}@${c.at}`)!), b];
    for (let i = 0; i + 1 < stops.length; i++) {
      const child: ChildInterval = { from: stops[i], to: stops[i + 1], fraction: stops[i + 1] - stops[i] };
      const extra = typeof override === 'function' ? override(movedEdges.at(e), child) : override ?? {};
      for (const name in extra) {
        if (!enames.includes(name)) throw new Error(`steps: no edge attribute '${name}' — declare it with edgeAttribute()`);
        if (!Number.isFinite(extra[name])) throw new Error(`steps: '${name}' for a child edge is not a finite number`);
      }
      pushEdge(rows[i], rows[i + 1], { ...inheritEdge(cur, parentAttrs, child.fraction), ...extra });
    }
  }
  const resolve = (r: Ref, what: string): number => {
    if (isHandle(r)) {
      if (r.__batch !== batch) throw new Error(`steps: ${what}: that handle belongs to another edit batch (another step)`);
      if (r.__handle < 0 || r.__handle >= added.length) throw new Error(`steps: ${what}: unknown handle`);
      return handleRow[r.__handle];
    }
    const row = rowOf(r, what);
    if (removed.has(row)) throw new Error(`steps: ${what}: vertex ${row} is removed in this step`);
    return rowMap[row];
  };
  const have = new Set<number>();
  for (let e = 0; e < edges.length; e += 2) have.add(pairKey(edges[e], edges[e + 1]));
  for (const l of links) {
    const ra = resolve(l.a, 'connect');
    const rb = resolve(l.b, 'connect');
    if (ra === rb) throw new Error(`steps: connect: edge ${ra}–${rb} joins a vertex to itself`);
    const key = pairKey(ra, rb);
    if (have.has(key)) continue; // an existing pair is left as it is
    checkAttrs(l.attrs, enames, 'a new edge');
    have.add(key);
    pushEdge(ra, rb, l.attrs);
  }

  const attrs: Record<string, Float64Array> = {};
  for (const name of names) attrs[name] = Float64Array.from(oattrs[name]);
  const edgeAttrs: Record<string, Float64Array> = {};
  for (const name of enames) edgeAttrs[name] = Float64Array.from(eattrs[name]);
  return new Material(Float64Array.from(ox), Float64Array.from(oy), attrs, Uint32Array.from(edges), cur.iteration + 1, [], edgeAttrs, { ...cur.transfers }, { ...cur.edgeTransfers });
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
  // Cells are indexed row-major over the material's own extent — no packed
  // key, so no two cells can share an index whatever the coordinates.
  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;
  for (let i = 0; i < m.n; i++) {
    if (m.x[i] < minx) minx = m.x[i];
    if (m.x[i] > maxx) maxx = m.x[i];
    if (m.y[i] < miny) miny = m.y[i];
    if (m.y[i] > maxy) maxy = m.y[i];
  }
  const gx0 = Number.isFinite(minx) ? Math.floor(minx / cell) : 0;
  const gy0 = Number.isFinite(miny) ? Math.floor(miny / cell) : 0;
  const cols = Number.isFinite(maxx) ? Math.floor(maxx / cell) - gx0 + 1 : 1;
  const rows = Number.isFinite(maxy) ? Math.floor(maxy / cell) - gy0 + 1 : 1;
  const grid = new Map<number, number[]>();
  const key = (gx: number, gy: number) => (gx - gx0 < 0 || gx - gx0 >= cols || gy - gy0 < 0 || gy - gy0 >= rows ? -1 : (gy - gy0) * cols + (gx - gx0));
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
        const k = key(gx, gy);
        if (k < 0) continue;
        const bucket = grid.get(k);
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
  return radial(material(sources), radius, excludeConnected, radius, -1);
}

/** The fixed-law radial recipes (`separation`, `attract`) on the raw
 * columns: the same neighbours in the same order and the same arithmetic
 * as the generic `nearby` form — so the doubles, and the drawing, are
 * identical — without a vertex view and two tuples per neighbour. Measured
 * 20× on a 5 000-point ring (see the reference). `sign` −1 pushes away
 * from the source, +1 pulls toward it; `strength` is the value when
 * touching, fading linearly to zero at the radius. */
function radial(m: Material, radius: number, excludeConnected: boolean, strength: number, sign: number): (p: Vertex) => Vec {
  const near = neighbours(m, { radius });
  const mx = m.x;
  const my = m.y;
  return (p) => {
    const own = ownerOf(p) === m ? p.index : -1;
    const adj = excludeConnected && own >= 0 ? m.connected(own) : null;
    const px = p.x;
    const py = p.y;
    let x = 0;
    let y = 0;
    for (const j of near(p)) {
      if (adj && adj.includes(j)) continue;
      // sub(p, q) → unit → mul, spelled out in the same operations
      const dx = (px - mx[j]) * sign * -1;
      const dy = (py - my[j]) * sign * -1;
      const d = Math.sqrt(dx * dx + dy * dy); // `length` spells it so; hypot can differ in the last bit
      if (d > 0) {
        const s = (1 - d / radius) * strength;
        x += (dx / d) * s;
        y += (dy / d) * s;
      }
    }
    return [x, y];
  };
}

/**
 * Drift: a direction read from a noise function, `amount` long, turning
 * slowly with the iteration. Pure — pass the toolkit's seeded `t.noise`
 * in: `drift(t.noise, { amount })`, then `wander(p, k)`. `frequency`
 * scales position into the noise (default 0.08), `rate` the iteration
 * into its third axis (default 0.0004): angle = noise(x·f, y·f, k·rate) · 2π.
 * The default rate is small because the toolkit's noise folds z onto
 * shifted 2D slices about thirty times steeper than x and y: at 0.01 per
 * iteration the direction re-rolls every step and a trail is a random
 * walk; at 0.0004 it turns.
 */
export function drift(
  noise: (x: number, y: number, z: number) => number,
  opts: { amount: number; frequency?: number; rate?: number },
): (p: XY, k: number) => Vec {
  const { amount, frequency = 0.08, rate = 0.0004 } = opts;
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
  return radial(material(sources), radius, excludeConnected, strength, +1);
}

/**
 * Boundary: keep inside an area. `keep(p)` is zero deeper than `radius`
 * inside the boundary loops, grows linearly to `strength` at the edge, and
 * keeps pushing inward outside — direction from the signed distance field
 * (`distanceTo`: positive inside, holes respected; contours chord-closed).
 * Loops are any boundary: `t.material(rect(...))`, a chain material's curves,
 * pts, isolines' pts. Sampled obstacles are `separation`; this is the
 * continuous boundary.
 */
export function boundary(loops: Boundary, opts: { radius: number; strength?: number }): (p: XY) => Vec {
  const { radius, strength = 1 } = opts;
  const inside = distanceTo(numericLoops(loops, 'force.boundary'));
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
/** Prepared forces summed into one: `(p, k) => vector`. Every force gets
 * `p` and the iteration `k` (those that do not turn ignore it), so a
 * rule reads `next.move((p) => mul(push(p, k), speed))` with the speed
 * still the author's number. Prepare the members against `cur` each
 * step as before — nothing here binds a state. */
export function sumForces(...forces: readonly ((p: Vertex, k: number) => XY)[]): (p: Vertex, k?: number) => Vec {
  return (p, k = 0) => {
    let x = 0;
    let y = 0;
    for (const f of forces) {
      const v = f(p, k);
      x += vx(v);
      y += vy(v);
    }
    return [x, y];
  };
}

export const force = {
  sum: sumForces, nearby, adjacent, tension, separation, drift, attract, boundary, vortex, field, relax };

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

/** A classifier fitted to a column's own extent: `banding.over(m.attrs.age,
 * { count: 3 })` is `banding({ min, max, count })` with `extent` inside.
 * Two columns that must share a range still use `extent` and `banding`. */
banding.over = (values: ArrayLike<number>, opts: { count: number }): ((v: number) => number) => {
  const [min, max] = extent(values);
  return banding({ min, max, count: opts.count });
};

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
  // The classifier sees each edge in its STORED orientation (a → b as it
  // was connected), whatever direction the drawing walk happens to take.
  const stored = new Map<number, [number, number]>();
  for (let e = 0; e < m.edgeList.length; e += 2) {
    const a = m.edgeList[e];
    const b = m.edgeList[e + 1];
    if (!stored.has(pairKey(a, b))) stored.set(pairKey(a, b), [a, b]);
  }
  for (const c of m.curves()) {
    const idx = c.indices;
    const segs = c.closed ? idx.length : idx.length - 1;
    if (segs <= 0) continue;
    const keys: K[] = [];
    for (let s = 0; s < segs; s++) {
      const [a, b] = stored.get(pairKey(idx[s], idx[(s + 1) % idx.length]))!;
      keys.push(key(m.vertex(a), m.vertex(b)));
    }
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
