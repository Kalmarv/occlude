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
import { distanceTo } from './distance.js';
import { numericLoops, type Boundary } from './boundary.js';
import { Delaunay } from 'd3-delaunay';
import { orient2d } from 'robust-predicates';
import { trails as makeTrails } from './trails.js';
import { distance, perp, isArr, vx, vy, type XY } from './vec.js';
import { ownerOf, ownedBy, ownerOfView, pairKey, viewKind, viewProto } from './views.js';
import { checkAttrs, stepOnce, isStepShorthand, stepRuleOf, type StepKit, type StepRule, type StepShorthand, type StepsOptions } from './steps.js';

// The vocabulary this module was one file with, re-exported so its
// importers keep one door: vectors (vec.ts), view identity (views.ts) and
// the edit contract (steps.ts). Forces live in forces.ts and depend on
// this module, so they are not re-exported here.
export {
  add, sub, mul, length, distance, unit, limit, perp, dot, cross, fromAngle, angleOf, sum, sumBy,
} from './vec.js';
export type { XY, Vec } from './vec.js';
export { viewKind, viewProto, ownedBy, ownerOfView } from './views.js';
export { inheritEdge } from './steps.js';
export type {
  Handle, Ref, ChildSpec, ChildInterval, SplitOpts, EdgeRef, StepRule, StepShorthand, StepsOptions, Next, StepKit,
} from './steps.js';

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
  /** The faces on this edge's two sides, from the material's `faces()`:
   * two for a wall between cells, one for an outer wall or a spur inside a
   * face, none for an edge no face touches. Reading it on a material that
   * is not planar throws the same error as `faces()`. */
  readonly faces: Face[];
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
  /** Source point-column policies, retained by stationsMaterial. Sampling
   * overrides affect this read only, just as for Material.resample. */
  transfers?: Readonly<Record<string, TransferPolicy>>;
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
  scale?: number | readonly [number, number];
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
    // An edge knows the faces on its two sides once the material's faces
    // have been read (cached on the state): the reverse of `face.edges`.
    const owner = this;
    const edgeProto = Object.create(viewProto(this, 'edge')) as object;
    Object.defineProperty(edgeProto, 'faces', { get(this: Edge) { return owner.faces().facesOf(this); }, enumerable: false });
    this.edgeProto = Object.freeze(edgeProto);
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

  /** The material's single chain as a stampable contour. A material with
   * several chains has no single one, so this is the longest of them by arc
   * length (ties: the first in `curves()` order) — the outline of a grown or
   * cut material, with the crumbs left out. For all of them, see `curves()`. */
  get contour(): Curve {
    const cs = this.curves();
    if (cs.length === 1) return cs[0];
    if (cs.length === 0) return { pts: this.pts, closed: false, indices: Array.from({ length: this.n }, (_, i) => i) };
    let best = cs[0];
    let bestLength = -1;
    for (const c of cs) {
      let length = 0;
      for (let k = 1; k < c.pts.length; k++) length += Math.hypot(c.pts[k][0] - c.pts[k - 1][0], c.pts[k][1] - c.pts[k - 1][1]);
      if (c.closed && c.pts.length > 2) length += Math.hypot(c.pts[0][0] - c.pts[c.pts.length - 1][0], c.pts[0][1] - c.pts[c.pts.length - 1][1]);
      if (length > bestLength) {
        bestLength = length;
        best = c;
      }
    }
    return best;
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
      if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a >= this.n || b >= this.n) throw new Error(`connect: edge ${a}–${b} names a vertex beyond ${this.n - 1}`);
    }
    // A pair whose ends are the same vertex is no edge; it is dropped, the
    // way an existing pair is left as it is.
    if (pairs.some(([a, b]) => a !== b && !seen.has(pairKey(a, b)))) checkAttrs(edgeAttributes, names, 'a new edge');
    let added = 0;
    for (const [a, b] of pairs) {
      if (a === b) continue;
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
    // Too small to place samples (a mid-edit zero spacing): nothing to build.
    if (!checkSampling('resample', opts)) return material([]);
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
    if (!atVertices && !checkSampling('along', opts)) return [];
    for (let i = 0; i < this.n; i++) {
      if (this.adj[i].length > 2) throw new Error(`along: vertex ${i} is a junction — chains only`);
    }
    const names = this.attrNames;
    const stationTransfers = Object.freeze({ ...this.transfers });
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
          transfers: stationTransfers,
        });
        out.push(st);
      });
    });
    return out;
  }

  // ---- the iteration verb ----

  /**
   * THE iteration operation. Run one or more passes per iteration and return the final
   * material, ready for further operations. `rule(current, next, k)` reads
   * `current` (frozen) and describes `next`, which starts as a copy; see
   * `Next` for the edits. `k` counts from 0 within this call. Growth,
   * relaxation, deformation and erosion are different rules for this one
   * verb; `.steps(1, rule)` is a single transition. Additional callbacks run
   * in order within each iteration: each receives the completed output of
   * the previous pass. All passes share k. Selections and handles belong to
   * one pass; select again from the following pass's input. Optional history
   * settings are the final argument, and capture only completed iterations.
   *
   * By default only the final state is kept. `{ every: m }` also captures
   * iteration 0, every m-th iteration, and the final one (no duplicates)
   * on the result's `history`, each labelled with its iteration number.
   * Nothing a later step does can disturb an earlier snapshot.
   *
   * The everyday step is shorter: `.steps(n, { move: p => [dx, dy] })` moves
   * every point by a field and `set` writes attributes in the same pass.
   */
  steps(n: number, rule: StepRule | StepShorthand, ...passesAndOptions: StepRule[] | [...StepRule[], StepsOptions]): Material {
    if (isStepShorthand(rule)) rule = stepRuleOf(rule);
    const last = passesAndOptions[passesAndOptions.length - 1];
    const opts: StepsOptions = typeof last === 'object' ? last : {};
    const passes: StepRule[] = [rule, ...(passesAndOptions as (StepRule | StepsOptions)[]).filter((pass): pass is StepRule => typeof pass === 'function')];
    const every = opts.every !== undefined ? Math.max(1, Math.floor(opts.every)) : 0;
    const snaps: Snapshot[] = [];
    const base = new Material(copy(this.x), copy(this.y), copyAttrs(this.attrs), copyEdges(this.edgeList), this.iteration, [], copyAttrs(this.edgeAttrs), { ...this.transfers }, { ...this.edgeTransfers });
    if (every) snaps.push({ iteration: this.iteration, material: base });
    let cur = base;
    for (let k = 0; k < n; k++) {
      for (const pass of passes) cur = stepOnce(cur, k, pass, this.iteration + k + 1, KIT);
      if (every && (k + 1) % every === 0 && k + 1 < n) snaps.push({ iteration: cur.iteration, material: cur });
    }
    if (every && n > 0) snaps.push({ iteration: cur.iteration, material: cur });
    return every
      ? new Material(copy(cur.x), copy(cur.y), copyAttrs(cur.attrs), copyEdges(cur.edgeList), cur.iteration, snaps, copyAttrs(cur.edgeAttrs), { ...cur.transfers }, { ...cur.edgeTransfers })
      : cur;
  }
}

/** The classes `stepOnce` must recognise and construct (see steps.ts). */
const KIT: StepKit = { Material, PointSelection, EdgeSelection };

/** Sampling options shared by `t.sample`, `resample` and `along`: exactly
 * one of `count` or `spacing`, and a count in whole samples — a missing,
 * doubled or fractional option is a mistake and says so. A size with nothing
 * to place — a spacing at or below zero, fewer than two samples — is not a
 * mistake but a degenerate one, and comes back `false`: no samples, and the
 * rest of the sketch still draws. */
export function checkSampling(who: string, opts: { count?: number; spacing?: number }): boolean {
  if ((opts.spacing === undefined) === (opts.count === undefined)) {
    throw new Error(`${who}: give exactly one of { count, spacing }`);
  }
  if (opts.count !== undefined && !Number.isInteger(opts.count)) {
    throw new Error(`${who}: count must be an integer of at least 2 (open) or 3 (closed)`);
  }
  if (opts.spacing !== undefined && !(opts.spacing > 0)) return false;
  return opts.count === undefined || opts.count >= 2;
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
  at(i: number, j: number): number[];
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
  /** The rows bucketed into one cell, empty outside the grid. */
  const at = (i: number, j: number): number[] => (i < 0 || j < 0 || i >= cols || j >= rows ? [] : buckets[j * cols + i]);
  return { cell, cols, rows, maxRing: Math.max(cols, rows), col, row, ring, at };
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

const copy = (col: Float64Array) => Float64Array.from(col);
const copyEdges = (list: Uint32Array) => Uint32Array.from(list);
const copyAttrs = (attrs: Readonly<Record<string, Float64Array>>): Record<string, Float64Array> => {
  const out: Record<string, Float64Array> = {};
  for (const k in attrs) out[k] = Float64Array.from(attrs[k]);
  return out;
};

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
 * way). Point/edge name collisions and conflicting point policies are
 * errors: rename the source column before flattening the domains. Point
 * transfer policies survive; promoted edge samples become ordinary vertex
 * values, not conserved edge quantities. Nothing connects back to the source material.
 */
export function stationsMaterial(stations: readonly Station[]): Material {
  const pointNames = new Set(stations.flatMap(q => Object.keys(q.attrs)));
  const policies = new Map<string, TransferPolicy>();
  for (const q of stations) {
    for (const name of Object.keys(q.edgeAttrs)) {
      if (pointNames.has(name)) throw new Error(`stationsMaterial: '${name}' occurs in both point and edge columns — rename one before conversion`);
    }
    for (const name of Object.keys(q.attrs)) {
      const policy = q.transfers?.[name] ?? 'interpolate';
      if (policies.has(name) && policies.get(name) !== policy) {
        throw new Error(`stationsMaterial: conflicting transfer policies for '${name}'`);
      }
      policies.set(name, policy);
    }
  }
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
  const attrs = Object.fromEntries(Object.entries(cols).map(([name, values]) => [name, Float64Array.from(values)]));
  const transfers = Object.fromEntries([...policies].filter(([, policy]) => policy !== 'interpolate'));
  return new Material(
    Float64Array.from(stations, q => q.x), Float64Array.from(stations, q => q.y),
    attrs, Uint32Array.from(edges.flat()), 0, [], {}, transfers,
  );
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
 * named options become constant columns. An existing Material is returned
 * unchanged only without options; use its edit methods to change it.
 * Use `connect.*` for topology.
 */
export function material(
  points: PointsLike,
  opts: { edges?: readonly (readonly [number, number])[] } & Record<string, number | ArrayLike<number> | readonly (readonly [number, number])[] | undefined> = {},
): Material {
  if (points instanceof Material) {
    if (Object.keys(opts).length > 0) {
      throw new Error('material: options on an existing Material are not supported; use attributes() or withEdges()');
    }
    return points;
  }
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
  /**
   * One route through every row, visiting each once: a chain, or a ring with
   * `closed`. The rows are not reordered — the route is in the edges, so
   * every column stays where it was.
   *
   * `cost(a, b)` is what the route tries to spend less of, read from two
   * vertex views, and it is the whole point: the default is the distance
   * between them, and anything else makes a different drawing out of the
   * same points. `cost: (a, b) => 1 - img.lum((a.x + b.x) / 2, (a.y + b.y) / 2)`
   * prefers to travel over the dark parts of a picture, so the joining line
   * is itself drawing rather than just getting there.
   *
   * The starting route is nearest-neighbour by plain distance — a start, not
   * an answer — and `cost` then drives the improvement: 2-opt, first
   * improvement, repeated until no exchange helps. Exchanges are tried
   * between each row and its `candidates` nearest neighbours rather than
   * every pair, which is what keeps it linear in the neighbourhood rather
   * than quadratic in the cloud. Those neighbours are chosen by DISTANCE,
   * whatever `cost` says — right for a cost that is mostly about travel, and
   * a real limit on one that is not: a cost over a column alone is improved
   * only among geometric neighbours, so it sorts partly rather than wholly.
   * Reversing a run leaves an undirected cost alone, so `cost` is taken to be
   * symmetric; an asymmetric one still runs, it just is not what is being
   * minimised.
   *
   * Because those candidates are chosen by distance, two edges can cross while
   * their endpoints are nowhere near each other's lists — which a cost
   * unrelated to distance encourages, by making long reaches worth taking. So
   * crossings are looked for directly afterwards and undone wherever the
   * exchange pays for itself. Under the default cost that leaves no
   * self-crossing at all, the familiar property of a 2-opt tour; under a cost
   * that rewards travelling over something, a crossing that is genuinely the
   * cheaper route is kept, because it is.
   *
   * Deterministic: the same rows and the same cost give the same route.
   */
  tour(m: PointsLike, opts: { cost?: (a: Vertex, b: Vertex) => number; closed?: boolean; candidates?: number; edgeAttributes?: Record<string, number> } = {}): Material {
    const mm = material(m);
    const n = mm.n;
    const asked = opts.candidates ?? 12;
    if (!Number.isInteger(asked)) throw new Error(`connect.tour: candidates must be a whole number of neighbours, at least 2 (got ${String(opts.candidates)})`);
    // A choice needs two to choose between: fewer is read as two.
    const k = Math.max(2, asked);
    if (opts.cost !== undefined && typeof opts.cost !== 'function') throw new Error('connect.tour: cost must be a function of two vertex views');
    if (n < 2) return mm.withEdges([], opts.edgeAttributes);
    const views = Array.from({ length: n }, (_, i) => mm.vertex(i));
    const raw = opts.cost;
    const cache = new Map<number, number>();
    const cost = (i: number, j: number): number => {
      if (!raw) return Math.hypot(mm.x[i] - mm.x[j], mm.y[i] - mm.y[j]);
      const key = i < j ? i * n + j : j * n + i;
      let v = cache.get(key);
      if (v === undefined) {
        const answer = raw(views[i], views[j]);
        if (typeof answer !== 'number') throw new Error(`connect.tour: cost(${i}, ${j}) is ${String(answer)} — it must be a number`);
        // A cost the function cannot put a number on is a pair not worth
        // travelling: infinitely expensive, so every other route wins.
        v = Number.isNaN(answer) ? Infinity : answer;
        cache.set(key, v);
      }
      return v;
    };
    // Nearest-neighbour start, by distance, from row 0.
    const grid = pointGrid(mm.x, mm.y, Math.max(2, Math.ceil(Math.sqrt(n / 2))));
    const used = new Uint8Array(n);
    const order: number[] = [0];
    used[0] = 1;
    for (let step = 1; step < n; step++) {
      const from = order[order.length - 1];
      const cx = grid.col(mm.x[from]);
      const cy = grid.row(mm.y[from]);
      let best = -1;
      let bestD = Infinity;
      for (let r = 0; ; r++) {
        for (const j of grid.ring(cx, cy, r)) {
          if (used[j]) continue;
          const d = Math.hypot(mm.x[j] - mm.x[from], mm.y[j] - mm.y[from]);
          if (d < bestD || (d === bestD && j < best)) {
            bestD = d;
            best = j;
          }
        }
        const reach = r * grid.cell;
        if ((best >= 0 && bestD <= reach) || r > grid.maxRing) break;
      }
      order.push(best);
      used[best] = 1;
    }
    // Candidate neighbours, by distance, for the exchange search.
    const near: number[][] = Array.from({ length: n }, (_, i) => {
      const cand: [number, number][] = [];
      const cx = grid.col(mm.x[i]);
      const cy = grid.row(mm.y[i]);
      for (let r = 0; ; r++) {
        for (const j of grid.ring(cx, cy, r)) {
          if (j !== i) cand.push([Math.hypot(mm.x[j] - mm.x[i], mm.y[j] - mm.y[i]), j]);
        }
        cand.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
        const reach = r * grid.cell;
        if ((cand.length >= k && cand[k - 1][0] <= reach) || r > grid.maxRing) break;
      }
      return cand.slice(0, k).map(([, j]) => j);
    });
    // 2-opt to a local optimum. A closed route may exchange anywhere; an open
    // one keeps its two ends, so the cuts stop short of them.
    const pos = new Int32Array(n);
    const closed = opts.closed ?? false;
    for (let i = 0; i < n; i++) pos[order[i]] = i;
    const last = closed ? n - 1 : n - 2;
    // A pass scans every position and takes the first improvement it finds at
    // each, then moves on; it does not start again from the beginning. A cost
    // unrelated to distance can want very many exchanges, and restarting the
    // scan after each one turns that into quadratic work over an already
    // quadratic search. Only the reversed run is reindexed, for the same
    // reason. Each exchange strictly lowers the total, so the passes end.
    for (let improved = true; improved;) {
      improved = false;
      for (let i = 0; i <= last; i++) {
        const a = order[i];
        const b = order[(i + 1) % n];
        const ab = cost(a, b);
        for (const c of near[a]) {
          const j = pos[c];
          // The two edges must be distinct and NOT adjacent. With j === i + 1
          // they share the vertex c === b, the four terms cancel in exact
          // arithmetic, and the reversal of a single element changes nothing —
          // but evaluated left to right the cancellation leaves a rounding
          // residue that reads as a positive gain, and the same non-move is
          // accepted forever. Excluding the degenerate exchange is the honest
          // fix; an epsilon on the gain would only hide it.
          if (j <= i + 1 || j > last) continue;
          const d = order[(j + 1) % n];
          if (d === a) continue;
          const gain = ab + cost(c, d) - cost(a, c) - cost(b, d);
          if (gain > 0) {
            for (let p = i + 1, q = j; p < q; p++, q--) {
              const t = order[p];
              order[p] = order[q];
              order[q] = t;
            }
            for (let p = i + 1; p <= j; p++) pos[order[p]] = p;
            improved = true;
            break;
          }
        }
      }
    }
    // Candidate neighbours are chosen by distance, so two edges can cross while
    // their endpoints are nowhere near each other's candidate lists — which a
    // cost unrelated to distance positively encourages, because it makes long
    // reaches worth taking. Those crossings are never examined above. So look
    // for them directly: a crossing whose exchange pays for itself is undone,
    // and one that does not is left alone, because under a cost that rewards
    // travelling over something a crossing can genuinely be the cheaper route.
    // Segments are bucketed by their boxes, so this is near linear rather than
    // every pair against every other.
    const segAt = (i: number): [number, number, number, number] => {
      const a = order[i];
      const b = order[(i + 1) % n];
      return [mm.x[a], mm.y[a], mm.x[b], mm.y[b]];
    };
    const properCross = (i: number, j: number): boolean => {
      const [ax, ay, bx, by] = segAt(i);
      const [cx, cy, dx, dy] = segAt(j);
      const s1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      const s2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
      const s3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
      const s4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
      return s1 > 0 !== s2 > 0 && s3 > 0 !== s4 > 0;
    };
    for (let searching = true; searching;) {
      searching = false;
      const cellSize = Math.max(grid.cell, 1e-9);
      const buckets = new Map<string, number[]>();
      // A segment whose box covers more cells than it is worth enumerating is
      // held aside and compared against everything instead. Bucketing it by
      // its two ends would be cheaper and WRONG: anything crossing its middle
      // would never be compared with it, which is precisely the crossing a
      // long reach leaves behind.
      const sprawling: number[] = [];
      for (let i = 0; i <= last; i++) {
        const [ax, ay, bx, by] = segAt(i);
        const c0 = Math.floor(Math.min(ax, bx) / cellSize);
        const c1 = Math.floor(Math.max(ax, bx) / cellSize);
        const r0 = Math.floor(Math.min(ay, by) / cellSize);
        const r1 = Math.floor(Math.max(ay, by) / cellSize);
        if ((c1 - c0 + 1) * (r1 - r0 + 1) > 64) {
          sprawling.push(i);
          continue;
        }
        for (let c = c0; c <= c1; c++) {
          for (let r = r0; r <= r1; r++) {
            const k = `${c},${r}`;
            const at = buckets.get(k);
            if (at) at.push(i);
            else buckets.set(k, [i]);
          }
        }
      }
      for (const i of sprawling) buckets.set(`sprawl:${i}`, [i, ...Array.from({ length: last + 1 }, (_, j) => j).filter((j) => j !== i)]);
      for (const list of buckets.values()) {
        for (let p = 0; p < list.length && !searching; p++) {
          for (let q = p + 1; q < list.length && !searching; q++) {
            const i = Math.min(list[p], list[q]);
            const j = Math.max(list[p], list[q]);
            if (j <= i + 1 || j > last) continue;
            const a = order[i];
            const b = order[i + 1];
            const c = order[j];
            const d = order[(j + 1) % n];
            if (d === a) continue;
            if (!properCross(i, j)) continue;
            if (cost(a, b) + cost(c, d) - cost(a, c) - cost(b, d) <= 0) continue;
            for (let u = i + 1, v = j; u < v; u++, v--) {
              const t2 = order[u];
              order[u] = order[v];
              order[v] = t2;
            }
            for (let u = i + 1; u <= j; u++) pos[order[u]] = u;
            searching = true;
          }
        }
        if (searching) break;
      }
    }
    const pairs: [number, number][] = [];
    for (let i = 0; i + 1 < n; i++) pairs.push([order[i], order[i + 1]]);
    if (closed && n > 2) pairs.push([order[n - 1], order[0]]);
    return mm.withEdges(pairs, opts.edgeAttributes);
  },

  /**
   * The cheapest tree that reaches every row: no cycles, no choices, one path
   * between any two points. Where `tour` visits everything in a line, this
   * branches — which is what a root, a river, a nervous system and a lightning
   * strike all look like, because all of them are cheapest-connection problems.
   *
   * `cost(a, b)` is the same idea as `tour`'s and defaults to the distance
   * between the two rows. The candidate edges are the Delaunay ones, which is
   * exactly right for distance — the Euclidean minimum spanning tree is a
   * subgraph of the Delaunay triangulation, so nothing is lost — and a
   * restriction for any other cost, which is then minimised over those
   * candidates rather than over every pair. Rows at the same position take
   * part: Delaunay keeps only the first at a position, so the rest are joined
   * to it, and the tree still reaches every row.
   *
   * Rows are not reordered and the result is a chain-free tree: `strokes`
   * walks each arm, `faces()` finds nothing because a tree encloses nothing,
   * and `m.degree(p)` tells a tip from a fork.
   */
  tree(m: PointsLike, opts: { cost?: (a: Vertex, b: Vertex) => number; edgeAttributes?: Record<string, number> } = {}): Material {
    const mm = material(m);
    const n = mm.n;
    if (opts.cost !== undefined && typeof opts.cost !== 'function') throw new Error('connect.tree: cost must be a function of two vertex views');
    if (n < 2) return mm.withEdges([], opts.edgeAttributes);
    const views = Array.from({ length: n }, (_, i) => mm.vertex(i));
    const raw = opts.cost;
    const cost = (i: number, j: number): number => {
      if (!raw) return Math.hypot(mm.x[i] - mm.x[j], mm.y[i] - mm.y[j]);
      const v = raw(views[i], views[j]);
      if (typeof v !== 'number') throw new Error(`connect.tree: cost(${i}, ${j}) is ${String(v)} — it must be a number`);
      // A cost with no number on it is an infinitely expensive link: the
      // tree grows through its neighbours instead.
      return Number.isNaN(v) ? Infinity : v;
    };
    // Candidates: the Delaunay edges, plus a zero-length link from every row
    // sharing a position to the first row there, which Delaunay left out.
    const candidates: [number, number][] = [];
    const delaunay = connect.triangulate(mm).edgeList;
    for (let e = 0; e < delaunay.length; e += 2) candidates.push([delaunay[e], delaunay[e + 1]]);
    const firstAt = new Map<string, number>();
    for (let i = 0; i < n; i++) {
      const key = `${mm.x[i]},${mm.y[i]}`;
      const first = firstAt.get(key);
      if (first === undefined) firstAt.set(key, i);
      else candidates.push([first, i]);
    }
    // Fewer than three distinct positions, or all of them collinear, and
    // there is no triangulation to draw candidates from: every pair is one.
    if (delaunay.length === 0) {
      candidates.length = 0;
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) candidates.push([i, j]);
    }
    // Kruskal: cheapest candidate first, taken when it joins two components.
    const weighted = candidates.map(([a, b], k) => [cost(a, b), k, a, b] as [number, number, number, number]);
    weighted.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    const parent = new Int32Array(n);
    for (let i = 0; i < n; i++) parent[i] = i;
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const pairs: [number, number][] = [];
    for (const [, , a, b] of weighted) {
      const ra = find(a);
      const rb = find(b);
      if (ra === rb) continue;
      parent[Math.max(ra, rb)] = Math.min(ra, rb);
      pairs.push([a, b]);
      if (pairs.length === n - 1) break;
    }
    return mm.withEdges(pairs, opts.edgeAttributes);
  },

  /**
   * The same drawing, re-wired so the pen lifts as few times as it can.
   *
   * `strokes` breaks a chain at every junction, so a grid comes off the
   * plotter as one stroke per edge pair even though a pen could run straight
   * through. A *trail* uses no edge twice, and the fewest trails covering a
   * connected network is `max(1, odd / 2)` — every trail has two ends, and
   * only an odd-degree vertex can be one. This reaches that minimum.
   *
   * It is a re-wiring, not a drawing mode: a junction is split into one
   * degree-2 vertex per passing pair, which leaves the ink exactly where it
   * was and lets the ordinary chain walk sail through. No edge is drawn twice.
   *
   * The split vertices sit on top of one another, which is what they are — one
   * place the pen passes through twice — so the result is a DRAWING and
   * `faces()` will rightly refuse it. Keep the original to ask questions of.
   */
  trails(m: PointsLike, opts: { edgeAttributes?: Record<string, number> } = {}): Material {
    return makeTrails(material(m), opts);
  },

  /**
   * Join two rows when the way between them is unimpeded — when the space
   * between them is empty enough that nothing else has a better claim.
   *
   * `room` says how much empty space a pair needs. The region tested is the
   * intersection of two discs of radius `room × d / 2`, pushed apart along the
   * pair, where `d` is the distance between them; the edge survives when no
   * other row lies inside it. At `room` 1 that region is the disc having the
   * pair as its diameter, and at 2 it is the intersection of the two discs of
   * radius `d` centred on each — the two classical answers — but it is one
   * continuous knob, not two named graphs, and the interesting values are the
   * ones between. More room is a sparser, more organic lattice.
   *
   * `room` may also be a field, read at the middle of each pair — the one
   * place both rows agree on — so one lattice can be a dense mesh where it
   * matters and a sparse filigree elsewhere.
   *
   * Up to `room` 2 the result still contains every edge of `connect.tree`, so
   * it is connected whenever the cloud is. Past 2 that guarantee goes: the
   * lune grows large enough to veto edges the spanning tree needed, and the
   * lattice starts falling into pieces. Measured on 167 relaxed points —
   * Delaunay 486 edges, room 1: 421, room 2: 254, tree: 166, room 3.5: 118,
   * which is already fewer edges than a spanning tree can have.
   *
   * Candidates are the Delaunay edges, which loses nothing: every edge of this
   * family is one, for any `room` at 1 or above.
   */
  unimpeded(m: PointsLike, opts: { room?: number | ((x: number, y: number) => number); edgeAttributes?: Record<string, number> } = {}): Material {
    const mm = material(m);
    const asked = opts.room ?? 1;
    if (typeof asked !== 'number' && typeof asked !== 'function') throw new Error('connect.unimpeded: { room } must be a number, or a field of them read at the middle of each pair');
    // Below 1 the region between two rows is not a lune and the family is
    // not defined, so a smaller (or unanswerable) room is read as 1 — the
    // Gabriel graph — rather than stopping the drawing.
    const roomAt = (x: number, y: number): number => {
      const v = typeof asked === 'function' ? asked(x, y) : asked;
      return typeof v === 'number' && v > 1 ? v : 1;
    };
    if (mm.n < 2) return mm.withEdges([], opts.edgeAttributes);
    const grid = pointGrid(mm.x, mm.y, Math.max(2, Math.ceil(Math.sqrt(mm.n / 2))));
    const delaunay = connect.triangulate(mm).edgeList;
    // Fewer than three distinct positions, or all of them collinear, and there
    // is no triangulation to draw candidates from — but two rows with nothing
    // between them are still neighbours, so every pair is a candidate instead.
    const candidates: [number, number][] = [];
    if (delaunay.length) {
      for (let e = 0; e < delaunay.length; e += 2) candidates.push([delaunay[e], delaunay[e + 1]]);
    } else {
      for (let i = 0; i < mm.n; i++) for (let j = i + 1; j < mm.n; j++) candidates.push([i, j]);
    }
    const pairs: [number, number][] = [];
    for (const [a, b] of candidates) {
      const ax = mm.x[a];
      const ay = mm.y[a];
      const bx = mm.x[b];
      const by = mm.y[b];
      const d = Math.hypot(bx - ax, by - ay);
      if (!(d > 0)) continue;
      // The two disc centres, pushed apart from the midpoint by the room asked
      // for, and their shared radius. A fielded `room` is read at the middle of
      // the pair, which is the one place both rows agree on.
      const r = (roomAt((ax + bx) / 2, (ay + by) / 2) * d) / 2;
      const ux = (bx - ax) / d;
      const uy = (by - ay) / d;
      const c1x = ax + ux * r;
      const c1y = ay + uy * r;
      const c2x = bx - ux * r;
      const c2y = by - uy * r;
      // Anything inside BOTH discs is in the lune, so only the cells the
      // smaller of the two boxes covers need looking at.
      let blocked = false;
      const x0 = Math.min(c1x, c2x) - r;
      const x1 = Math.max(c1x, c2x) + r;
      const y0 = Math.min(c1y, c2y) - r;
      const y1 = Math.max(c1y, c2y) + r;
      const ci0 = grid.col(x0);
      const ci1 = grid.col(x1);
      const rj0 = grid.row(y0);
      const rj1 = grid.row(y1);
      for (let ci = ci0; ci <= ci1 && !blocked; ci++) {
        for (let rj = rj0; rj <= rj1 && !blocked; rj++) {
          for (const k of grid.at(ci, rj)) {
            if (k === a || k === b) continue;
            if (Math.hypot(mm.x[k] - c1x, mm.y[k] - c1y) >= r) continue;
            if (Math.hypot(mm.x[k] - c2x, mm.y[k] - c2y) >= r) continue;
            blocked = true;
            break;
          }
        }
      }
      if (!blocked) pairs.push([a, b]);
    }
    return mm.withEdges(pairs, opts.edgeAttributes);
  },

  /** Row i of `a` joined to row i of `b`, in one material (a's rows first).
   * Lengths must match; coincident points stay distinct. */
  pairs(a: PointsLike, b: PointsLike, edgeAttributes?: Record<string, number>): Material {
    const ma = material(a);
    const mb = material(b);
    const joined = append(ma, mb);
    const pairs: [number, number][] = [];
    // Rows with no partner are carried through as points: a row of five and
    // a row of four join four times, and still draw.
    for (let i = 0; i < Math.min(ma.n, mb.n); i++) pairs.push([i, ma.n + i]);
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
 * One material from several: each one's rows after the last, edges
 * renumbered, in the order given. Every side must have the same point and
 * edge columns, or the trailing options say what a side that lacks a column
 * gets: `fill: { active: 0 }` writes 0 into `active` on the sides that have
 * no `active`, and only there; values a side already has are never touched,
 * and a missing column with no fill is an error naming it, never a silent
 * zero. A column two sides declare must agree on its transfer policy (a
 * column nobody declared interpolates); a column only one side declares
 * keeps that side's policy, filled rows included. `edgeFill` does the same
 * for edge columns, whose default policy is `'copy'`. The options are the
 * last argument when it is a plain object; a material there is one more
 * side. `append(pile, ...children.map((c) => t.material(c)))` piles a list.
 */
export interface AppendOpts {
  fill?: Record<string, number>;
  edgeFill?: Record<string, number>;
}
export function append(...materials: Material[]): Material;
export function append(...args: [...Material[], AppendOpts]): Material;
export function append(...args: (Material | AppendOpts)[]): Material {
  const last: unknown = args[args.length - 1];
  const trailingOpts = last !== null && typeof last === 'object' && Object.getPrototypeOf(last) === Object.prototype;
  const opts: AppendOpts = trailingOpts ? (last as AppendOpts) : {};
  const sides = (trailingOpts ? args.slice(0, -1) : args) as Material[];
  // Nothing to append (a spread of an empty list) is the empty material.
  if (sides.length === 0) return material([]);
  for (const m of sides) if (!(m instanceof Material)) throw new Error('append: every side must be a material — convert a shape with t.material(shape) first');
  return sides.reduce((acc, m) => appendTwo(acc, m, opts));
}

function appendTwo(a: Material, b: Material, opts: AppendOpts): Material {
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
 * `min` and below is band 0, `max` and above the last; a constant range, or
 * a count with no bands in it, puts everything in band 0. `count` is a whole
 * number of bands.
 */
export function banding(opts: { min: number; max: number; count: number }): (v: number) => number {
  const { min, max, count } = opts;
  if (!Number.isInteger(count)) throw new Error(`banding: count must be a positive integer, got ${count}`);
  const span = max - min;
  return (v) => {
    // No bands to sort into, or no range to sort by: everything is band 0.
    if (!(count >= 1) || !(span > 0)) return 0;
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
