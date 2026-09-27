/**
 * Material: positions, connections and columns you can hold, write,
 * connect, resample and reinterpret.
 *
 * A `Material` is a set of vertices — `x`, `y` and any named attribute
 * columns — plus an edge list. A ring, an open chain, a branching tree
 * and an unconnected cloud are all materials; its `curves` are the chains
 * its edges walk, in order (curves.ts). Materials are values: every operation returns a
 * new one and leaves its input intact, so a run can be kept and any step
 * of it chosen later. Indices are rows of one state, not
 * identities: insertion renumbers later states.
 *
 * Four layers, kept apart:
 *   material   `material()` / `curve()` / `t.sample()`; `connect.*`;
 *              the writes `points.set`, `edges.set`, `faces.set`; `.resample()`
 *   numbers    add sub mul length distance unit limit perp sum sumBy
 *   passes     `(g) => g2` over the writes and recipes, run by `t.steps`;
 *              forces PREPARED once, EVALUATED at a point to a vector
 *   drawing    `.curves`, `.along()`, `extent`
 *
 * Everything here is pure — no seed, no paper. A rule that wants seeded
 * randomness or noise closes over the toolkit (`t.chance`, `t.noise`);
 * the outline of a shape comes from `t.sample`, which reads the paper.
 */

import { pointsOf, edgesOf, isPointSelection, isEdgeSelection, whereRows, type Where, type PointTypes, type EdgeTypes } from './relation.js';
import { ROW_TYPES, selectionIn, type Selection } from './selection.js';
import { euclideanSpace, type Space } from './space.js';
import { framePlacement, isPlacement, spaceOfDoor, type Placement } from './placement.js';
import { chordMiddle, chordNamer, metricGap } from './chord.js';
import { radians } from './units.js';
import { chainsOf, curvesOf, chainTangents, chainLengths, type Curve } from './curves.js';
import { planarize, FaceTable, faceTableOf, boxGrid, faceLocator, faceCentroids, statedFor, type PlanarizeOpts, type Face, type StatedFaces } from './faces.js';
import type { IsoContour } from './isolines.js';
import { contourMoment } from './measure.js';
import type { Origin } from './shapes.js';
import { distanceField } from './distance.js';
import { numericLoops, type AreaInput } from './boundary.js';
import { Delaunay } from 'd3-delaunay';
import { orient2d } from 'robust-predicates';
import { trails as makeTrails, type TrailsOpts } from './trails.js';
// Same-world transforms: a material in, a material out. They are methods on
// Material and the kernels stay in their own files. The import cycle is
// safe because every use is at call time.
import { thicken as thickenKernel, type ThickenOpts } from './thicken.js';
import { warp as warpKernel, type WarpOpts } from './warp.js';
import { oscillate as oscillateKernel, type OscillateOpts } from './oscillate.js';
import { envelope as envelopeKernel } from './envelope.js';
import { interlace as interlaceKernel, type InterlaceOpts } from './interlace.js';
import { merge as mergeKernel, type MergeOpts } from './merge.js';
import { distance, perp, isArr, vx, vy, type XY, type Vec } from './vec.js';
import { ownerOf, ownedBy, ownerOfView, pairKey, viewKind, RowView, rowViewKind } from './views.js';
import type { EdgeQuery } from './query.js';
import { Column, at64, atU32, columnOf, type ColumnLike } from './column.js';
import { carryLinks, derivation, linkRows, record, rowParam, rowSource, type RowSource } from './derivation.js';
import { memoMethod } from './memo.js';
// The table writes and the recipes over them live in tables.ts; the
// methods here are their doors. Every use is at call time, so the cycle
// is safe, as it is for the kernels above.
import { extrude as extrudeRecipe, split as splitRecipe, move as moveRecipe, replace as replaceRecipe, restamp, setPoints, setEdges, addEdgeRows, type Displacement, type EdgeEnd, type PointEnd, type ReplaceOpts } from './tables.js';

// The vocabulary this module was one file with, re-exported so its
// importers keep one door: vectors (vec.ts), view identity (views.ts) and
// the column sharing of a split (tables.ts). Forces live in forces.ts and
// depend on this module, so they are not re-exported here.
export {
  add, sub, mul, length, distance, unit, perp, dot, cross, fromAngle, angleOf, sum, sumBy,
} from './vec.js';
export type { XY, Vec } from './vec.js';
export { viewKind, viewProto, ownedBy, ownerOfView } from './views.js';
export { inheritEdge } from './tables.js';
import { IDENTITY, apply as applyMat, mul as mulMat, rotate as rotateMat, scale as scaleMat, translate as translateMat } from './matrix.js';
import type { TransformOp } from './execution.js';

// ---- the material --------------------------------------------------------------------

/** A vertex view: its row `index` in THIS state, position, and every
 * attribute column. A frozen snapshot of the state it came from, one per
 * row of that state, so two reads of a row are the same object — the row is
 * not a persistent identity, but `id` is. `material` (non-enumerable) names
 * that material, so a force can tell "this vertex of these sources" from a
 * foreign point that happens to share an index. */
export type Vertex = {
  readonly index: number;
  readonly x: number;
  readonly y: number;
  /** This vertex, for as long as it exists. Opaque and never reused: store
   * it in a column and `cur.point(id)` finds the row it became. */
  readonly id: PointId;
  /** The vertices an edge joins this one to, in adjacency order. Topology
   * only: no spatial search — `cur.points.near(p, { radius })` is that. An
   * isolated vertex has none. */
  readonly adjacent: Selection<Vertex>;
  /** The edges that meet this vertex, in edge order. `p.edges.length` is
   * the degree; an isolated vertex has none. */
  readonly edges: Selection<Edge>;
  /** The unit direction of `heading`, for a point that has one — a point
   * of `m.along()` or of a curve (`c.points`); undefined otherwise. */
  readonly tangent: Vec;
  /** `perp(tangent)`: the tangent turned a quarter turn toward `+y`. On a
   * ring drawn counter-clockwise on the sheet it points out. Undefined
   * where there is no heading. */
  readonly normal: Vec;
  /** The frame at this point, as a placement: here, facing `heading`. A
   * call, because it makes a new value; a point with no heading refuses
   * by name. `group(p.placement(), motif)` stands a motif here. */
  placement(): Placement;
  /** Where this row of a derived value came from: the input row under it
   * (a `t.sample` point: the edge it lies on; a `t.settle` point: the
   * point it descends from), or a selection when it came from many.
   * Undefined for a row no derivation made. */
  readonly source: RowSource;
  readonly [ROW_TYPES]?: PointTypes;
} & Readonly<Record<string, number>>;

/** An edge view. Its columns read as properties of the row (`e.level`), as
 * a vertex's do and as 3D rows' do. */
export type Edge = {
  /** Vertex views at the edge's ends, in stored order (a → b). */
  readonly a: Vertex;
  readonly b: Vertex;
  /** The edge's length in the material's space: `space.distance(a, b)`. */
  readonly length: number;
  /** Row of this edge in the material's edge list. */
  readonly index: number;
  /** This edge, for as long as it exists. A split retires it and gives its
   * children ids of their own. */
  readonly id: EdgeId;
  /**
   * The oldest edge this one descends from — the WALL it is part of.
   *
   * A split retires the parent and mints two children, so `id` tells you
   * this edge and `root` tells you which wall it belongs to. That is the
   * difference between "the edge I marked" and "the wall I marked", and it
   * is the one that survives a subdivision: mark the long walls, split
   * everything, and the pieces still answer with the root they came from.
   * An edge that has never been split is its own root.
   */
  readonly root: EdgeId;
  /**
   * The middle of the edge, as a fresh pair. A Vertex answers `x` and `y`
   * and a Face answers `centroid`; this is the wall's own place, which is
   * where a motif gets stamped and how one wall says how far it is from
   * another. Not a centroid — a segment has no area to weight.
   *
   * `center`, not `mid`, because 3D's `EdgeMeasure3` already spells it that way
   * and one thing gets one name in both worlds.
   */
  readonly center: Vec;
  /** The edges that share a vertex with this one, this edge excluded —
   * what `p.adjacent` is for a vertex, in the edge's own world. */
  readonly adjacent: Selection<Edge>;
  /** The faces on this edge's two sides, from the material's `faces`, as
   * a selection: the face on its left, then the one on its right — two for
   * a wall between cells, one for an outer wall or a spur inside a face,
   * none for an edge no face touches. Where faces nest, the leaves. Reading
   * it on a material that is not planar throws the same error as `faces`. */
  readonly faces: Selection<Face>;
  readonly [ROW_TYPES]?: EdgeTypes;
} & Readonly<Record<string, number>>;

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
 * (`points.set(name, value, { transfer })`), used as the default by
 * `split`, `replace` and `resample`; a per-operation override wins. */
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

/**
 * How a FACE column carries over when the boundary changes.
 *
 * A face is not a row: it appears and disappears as walls are built and
 * cut, and interpolating between two faces means nothing. So the policies
 * are `'nearest'` (the default) — the new face takes the value of the old
 * face it shares the most walls with — and `'drop'`, which lets a column
 * stop at a boundary change rather than follow it.
 */
export type FaceTransfer = 'nearest' | 'drop';

/** A face column: its values by face key, its policy, and the value a face
 * that shares no wall with any old face starts from. */
export interface FaceColumn {
  values: ReadonlyMap<string, number>;
  transfer: FaceTransfer;
  fallback?: number;
  /**
   * The keys of every face of the state this column was written against.
   *
   * It is what tells a NEW face from one that was simply never given a
   * value. A face in `seen` with no value has none — it was there and the
   * write passed it by. A face that is not in `seen` appeared after the
   * write, and that is the only face `'nearest'` inherits for.
   */
  seen: ReadonlySet<string>;
}

/**
 * The names a face view already owns. A face column reads flat —
 * `face.height`, like a vertex's `p.height` and an edge's `e.rest` — so a
 * column may not be called one of these.
 */
export const RESERVED_FACE_FIELDS: readonly string[] = [
  'index', 'id', 'area', 'perimeter', 'bounds', 'centroid',
  'edges', 'points', 'boundaryEdges', 'adjacent', 'contours', 'extract',
  'parent', 'children', 'depth', 'leaf', 'source',
];

/** The names an edge view already owns, for the same reason: its columns
 * read flat beside them (`e.rest`). */
export const RESERVED_EDGE_FIELDS: readonly string[] = [
  'a', 'b', 'length', 'index', 'id', 'root', 'center', 'adjacent', 'attrs', 'faces', 'source',
];

/**
 * The identity of one vertex or one edge, for as long as it exists.
 *
 * An id is opaque: the type refuses arithmetic on it, it is equal only to
 * itself, and it is never reused. It is a NUMBER underneath, not a string,
 * for one reason — a sketch stores an id in an ordinary column and looks it
 * up in a later step (`cur.point(id)`), and a column holds numbers.
 *
 * THE RULE, in three words: mint, keep, retire.
 *
 * - **Mint.** New geometry gets new ids. Every material built from nothing
 *   — `material()`, `resample`, `thicken`, `envelope`, `voronoi`, `settle` —
 *   mints, because it *is* new geometry. The constructor mints when it is
 *   given none, so a rebuild that has not been taught about identity is
 *   honest rather than wrong.
 * - **Keep.** A rebuild that carries a row forward carries its id: every
 *   column copy, every survivor of a step, every extracted selection.
 * - **Retire.** A split ends the parent and both children are new. After
 *   `g.split(edges)`, `g.edgeOf(parentId)` finds nothing, which is the same
 *   rule as "rows that are gone are skipped". The alternative — the first
 *   child inherits — is equally defensible and would silently change what
 *   `has` answers after a growth step, so it is written here rather than
 *   discovered later.
 *
 * The counter is per run, not per process: a module-global counter would
 * make the same sketch show different ids in a warm studio worker than in
 * a cold render. No ink moves either way, but "same program, same seed,
 * same ink" is a promise about what the artist sees.
 */
export type PointId = number & { readonly __pointId: unique symbol };
export type EdgeId = number & { readonly __edgeId: unique symbol };

/** The run's id counter. Reset at the start of every execution. */
let nextId = 1;

/** @internal Start a run's identities over. Called once per execution. */
export function resetIds(): void {
  nextId = 1;
}

/** @internal A fresh block of `count` ids, contiguous and never reused. */
export function mintIds(count: number): Float64Array {
  const out = new Float64Array(count);
  for (let i = 0; i < count; i++) out[i] = nextId++;
  return out;
}

/** How far, in sketch units, a moved edge's middle may stand from the
 * chord its moved ends draw before `m.transform` samples it, when the
 * placement's door carries no metric `bow` — a space built with no
 * paper. */
/**
 * @internal A material's columns, as persistent columns (column.ts). Every
 * state of a run shares the leaves it did not write.
 */
export interface MaterialStore {
  readonly x: Column;
  readonly y: Column;
  /** The point columns by name, each `n` long. */
  readonly attrs: Readonly<Record<string, Column>>;
  /** Their names and the columns, in the record's order: what a row view
   * reads. */
  readonly attrNames: readonly string[];
  readonly attrList: readonly Column[];
  /** One id per vertex row. Outside `attrs` on purpose: a column would be
   * interpolated at every split (a mean of two ids is a forged id), would
   * be demanded of every `points.add` caller, and would appear as a plain
   * number on a vertex view — the opposite of opaque. */
  readonly pointIds: Column;
  /** The edge list, two values a row: `[a0, b0, a1, b1, …]`. */
  readonly edgeList: Column<Uint32Array>;
  /** The edge columns by name, each one value a row. */
  readonly edgeAttrs: Readonly<Record<string, Column>>;
  readonly edgeAttrNames: readonly string[];
  readonly edgeAttrList: readonly Column[];
  /** The edge rows' ids, as `pointIds` is for points. */
  readonly edgeIds: Column;
  /**
   * The oldest ancestor of each edge — its LINEAGE.
   *
   * A split retires the parent and mints two children, which keeps ids
   * unique and `edgeOf(id)` unambiguous. But a face whose wall was merely
   * subdivided is still the same face, and by id alone it would share
   * nothing with its predecessor. The root is what says "this is still
   * that wall": a child takes its parent's root, and an edge born from
   * nothing is its own root.
   */
  readonly edgeRoots: Column;
}

/** @internal A new, unfrozen view of row `i` of `m`: what `m.vertex(i)`
 * freezes and keeps, and what a reading that adds columns of its own starts
 * from (a curve's points carry `s`, `u`, `heading`). */
export function vertexView(m: Material, i: number): Vertex {
  const store = m.store;
  const v = new VertexView(m) as unknown as Record<string, number>;
  v.index = i;
  v.x = at64(store.x, i);
  v.y = at64(store.y, i);
  const names = store.attrNames;
  const cols = store.attrList;
  for (let k = 0; k < names.length; k++) v[names[k]] = at64(cols[k], i);
  return v as unknown as Vertex;
}

/** @internal The vertex a write or a kernel hands to a callback for row `i`
 * of `m`: the state's one view of that row, as `m.vertex(i)`. A callback's
 * argument is a view like any other, so `===` holds between it and every
 * other read of the row — `f.source === p` inside a `move`. */
export function readVertex(m: Material, i: number): Vertex {
  return m.vertex(i);
}

/** @internal The edge a write or a kernel hands to a callback: the state's
 * one view of that row, as `m.edge(e)`. */
export function readEdge(m: Material, e: number): Edge {
  return m.edge(e);
}

/** @internal `readVertex` for a pass over `count` rows of `m`: the same
 * kept views, read from the state's array of every row, which a pass over
 * many rows makes once when it starts. */
export function vertexReader(m: Material, count: number): (i: number) => Vertex {
  if (count <= FEW_VIEWS) return (i) => m.vertex(i);
  const rows = pointViews(m).every();
  return (i) => rows[i] ?? (rows[i] = Object.freeze(vertexView(m, i)));
}

/** @internal `readEdge` for a pass over `count` rows, as `vertexReader`. */
export function edgeReader(m: Material, count: number): (e: number) => Edge {
  if (count <= FEW_VIEWS) return (e) => m.edge(e);
  const rows = edgeViews(m).every();
  return (e) => rows[e] ?? (rows[e] = edgeView(m, e));
}

/** Kept views past which a state's view cache is an array by row. */
const FEW_VIEWS = 32;

/**
 * @internal The kept views of one domain of a state, by row: a map while
 * few rows have been read, and an array of every row once many have. A
 * state of a run is read at a few rows — the edge a step picked and its
 * ends — and a run's history keeps such states: an array of every row for
 * each was 3.5 MB of a 2000-step history of 201 states, all of it holes.
 */
export class RowViews<V> {
  private few: Map<number, V> | null = new Map();
  private all: (V | undefined)[] | null = null;
  constructor(private readonly size: number) {}

  get(i: number): V | undefined {
    const all = this.all;
    return all !== null ? all[i] : this.few!.get(i);
  }

  /** Keep `v` as row `i`'s view, and hand it back. */
  set(i: number, v: V): V {
    const all = this.all;
    if (all !== null) {
      all[i] = v;
      return v;
    }
    const few = this.few!;
    few.set(i, v);
    if (few.size > FEW_VIEWS) this.every();
    return v;
  }

  /** The views by row, as an array of every row: what a pass over many
   * rows reads and fills directly, made once when the pass starts rather
   * than grown through the map. */
  every(): (V | undefined)[] {
    let all = this.all;
    if (all === null) {
      all = new Array<V | undefined>(this.size);
      for (const [r, view] of this.few!) all[r] = view;
      this.all = all;
      this.few = null;
    }
    return all;
  }
}

/** The kept vertex views of `m`, and its kept edge views. */
const pointViews = (m: Material): RowViews<Vertex> => (m.viewBox.points ??= new RowViews<Vertex>(m.n));
const edgeViews = (m: Material): RowViews<Edge> => (m.viewBox.edges ??= new RowViews<Edge>(m.edgeCount));

/** A new frozen view of edge `e` of `m`, its ends the kept vertex views of
 * `m`: what `m.edge` keeps. */
function edgeView(m: Material, e: number): Edge {
  const store = m.store;
  const a = m.vertex(atU32(store.edgeList, 2 * e));
  const b = m.vertex(atU32(store.edgeList, 2 * e + 1));
  const v = new EdgeView(m) as unknown as Record<string, unknown>;
  // A column is a property of the row: the reserved names keep a column
  // from ever shadowing one of the view's own words.
  const names = store.edgeAttrNames;
  const cols = store.edgeAttrList;
  for (let k = 0; k < names.length; k++) v[names[k]] = at64(cols[k], e);
  v.a = a;
  v.b = b;
  // A length of the material's space; the flat plane keeps the old expression.
  v.length = m.space !== undefined && m.space.kind !== 'euclidean' ? m.space.distance(a, b) : distance(a, b);
  v.index = e;
  return Object.freeze(v) as unknown as Edge;
}

/** A frozen record of flat columns by name, each joined the first time
 * its name is read: the kernels' view of a column record. */
function flatRecord(cols: Readonly<Record<string, Column>>): Readonly<Record<string, Float64Array>> {
  const out: Record<string, Float64Array> = {};
  for (const name in cols) {
    const col = cols[name];
    Object.defineProperty(out, name, { get: () => col.flat(), enumerable: true });
  }
  return Object.freeze(out);
}

/** id → row over an id column, the later row winning a repeat. */
function idMap(ids: Column): Map<number, number> {
  const map = new Map<number, number>();
  let i = 0;
  for (const leaf of ids.leaves()) for (let k = 0; k < leaf.length; k++, i++) map.set(leaf[k], i);
  return map;
}

const TRANSFORM_TOL = 0.05;
/** Halvings of one edge before `m.transform` stops asking. */
const TRANSFORM_DEPTH = 12;

/** The owner of a vertex or edge view: the state it is a row of. */
const stateOf = (view: object): Material => ownerOf(view) as Material;

/**
 * What every vertex view answers beyond its columns, the same for every
 * state: each word reads the view's state off its brand (views.ts). Lazy
 * and non-enumerable, so a view costs nothing until a word is asked for,
 * and a vertex still spreads and serialises as its columns.
 */
const VERTEX_WORDS: PropertyDescriptorMap = {
  // A row of a derived value names where it came from (derivation.ts): the
  // input row under it, a selection when it came from many, and the
  // parameter there. Every write that keeps the row keeps both.
  source: {
    get(this: Vertex) { return rowSource(stateOf(this), 'points', this.index); },
  },
  // A column of the row's own called `u` wins: it is an own property of
  // the view, and the setter is how a view is given one.
  u: {
    get(this: Vertex) { return rowParam(stateOf(this), 'points', this.index, 'u'); },
    set(this: Vertex, v: number) { Object.defineProperty(this, 'u', { value: v, writable: true, enumerable: true, configurable: true }); },
  },
  // A vertex knows the vertices an edge joins it to.
  adjacent: {
    get(this: Vertex) { const m = stateOf(this); return pointsOf(m, m.adjacentRows(this.index)); },
  },
  // Identity hangs off the view, never on it: `p.id` is there when it is
  // asked for.
  id: {
    get(this: Vertex) { return at64(stateOf(this).store.pointIds, this.index) as PointId; },
  },
  // A vertex knows the edges that meet it, in edge order — the row
  // property that pays for `m.isConnected` and `m.maxDegree`: degree is
  // `p.edges.length`, and `p.adjacent.has(q)` is the join test.
  edges: {
    get(this: Vertex) { const m = stateOf(this); return edgesOf(m, m.incidentEdgeRows(this.index), undefined, true); },
  },
  // A point with a heading — a point of `along`, a point of a curve —
  // has a frame: the unit tangent, the normal (`perp` of it), and the
  // placement there. Derived from the heading on every read.
  tangent: {
    get(this: Vertex) { const h = (this as Record<string, number>).heading; return typeof h === 'number' ? [Math.cos(h), Math.sin(h)] as Vec : undefined; },
  },
  normal: {
    get(this: Vertex) { const h = (this as Record<string, number>).heading; return typeof h === 'number' ? [-Math.sin(h), Math.cos(h)] as Vec : undefined; },
  },
  placement: {
    value(this: Vertex): Placement {
      const h = (this as Record<string, number>).heading;
      if (typeof h !== 'number') throw new Error('p.placement: this point has no heading — the points of m.along() and of a curve (c.points) have one');
      return framePlacement((stateOf(this).space ?? euclideanSpace()).model, { x: this.x, y: this.y, heading: h });
    },
  },
};

/** What every edge view answers beyond its columns, as `VERTEX_WORDS`. */
const EDGE_WORDS: PropertyDescriptorMap = {
  // Where a derived edge came from, as for a vertex (derivation.ts).
  source: { get(this: Edge) { return rowSource(stateOf(this), 'edges', this.index); } },
  // An edge knows the faces on its two sides once the material's faces
  // have been read (cached on the state): the reverse of `face.edges`. The
  // faces of a material with an area of its own are that area's: the edge
  // is found there by id.
  faces: {
    get(this: Edge) {
      const owner = stateOf(this);
      const cells = faceTableOf(owner.faces);
      return cells.facesOf(cells.source === owner ? this : cells.source.edgeOf(this.id)!);
    },
  },
  id: { get(this: Edge) { return at64(stateOf(this).store.edgeIds, this.index) as EdgeId; } },
  root: { get(this: Edge) { return at64(stateOf(this).store.edgeRoots, this.index) as EdgeId; } },
  center: { get(this: Edge) { return [(this.a.x + this.b.x) / 2, (this.a.y + this.b.y) / 2] as Vec; } },
  adjacent: {
    get(this: Edge) {
      // Every edge at either end, minus this one. A ring of two would
      // otherwise name its partner twice, so the rows go through a set.
      const owner = stateOf(this);
      const rows = new Set<number>();
      for (const e of owner.incidentEdgeRows(this.a.index)) rows.add(e);
      for (const e of owner.incidentEdgeRows(this.b.index)) rows.add(e);
      rows.delete(this.index);
      return edgesOf(owner, [...rows], undefined, true);
    },
  },
};

/**
 * Every vertex view is a `VertexView` and every edge view an `EdgeView`,
 * whatever state it is a row of (views.ts): one class, so one hidden class
 * for every state with the same columns — a callback over the rows of a
 * hundred states reads its fields the same way each time — and nothing
 * the engine keeps for long points at a state or at its views.
 */
class VertexView extends RowView {}
rowViewKind(VertexView, 'vertex', VERTEX_WORDS);
class EdgeView extends RowView {}
rowViewKind(EdgeView, 'edge', EDGE_WORDS);

export class Material {
  /** @internal The row count. A sketch reads `m.points.length`. */
  readonly n: number;
  /** @internal Every column this state holds, as persistent columns
   * (column.ts): a write shares every leaf it does not touch, so a state
   * kept in a history costs what changed. The per-row paths — the views,
   * the selections, the table writes — read and write these; the flat
   * names below are the kernels' door. */
  readonly store: MaterialStore;
  /** @internal How many steps of `t.steps` produced this state (0 for
   * fresh material); a run continues the count. It is what `force.drift`
   * turns with, and nothing a sketch names. */
  readonly iteration: number;
  /** States kept by the `t.steps` run that made this material — empty
   * unless it asked for `{ every }`: the start, every `every`-th state
   * after it, and the last one, each once, oldest first. Each entry is a
   * material of its own and carries no history of its own; nothing a later
   * step does touches it. */
  readonly history: readonly Material[];
  /** @internal Declared transfer policy per point column (default interpolate). */
  readonly transfers: Readonly<Record<string, TransferPolicy>>;
  /** @internal Declared transfer policy per edge column (default copy). */
  readonly edgeTransfers: Readonly<Record<string, EdgeTransfer>>;
  /** @internal Adjacency is built the first time it is asked for, then kept: a growth
   * step makes a state per iteration, and most never ask. The box is
   * mutable inside a frozen material. */
  private readonly adjBox: { rows: number[][] | null; edges: number[][] | null };
  /** @internal Spatial indexes for `points.near`, one per radius. The
   * state is frozen, so the cache lives in a box like the adjacency does. */
  readonly nearBox: { byRadius: Map<number, (p: XY) => number[]> } = { byRadius: new Map() };
  /** @internal The edge grid `edges.near` walks, built once per state. One
   * grid for every radius: unlike the point index, which is keyed by radius,
   * this one judges true segment distance per call. */
  readonly edgeQueryBox: { query: EdgeQuery | null } = { query: null };
  /** @internal The face collection of this state, built the first time it
   * is asked for. A box like the others, because the state is frozen. */
  readonly facesBox: { faces: FaceTable | null };
  /** @internal The faces the word that made this material stated (a tiling,
   * a grid, Voronoi cells, a quadtree), kept while the edges are the ones
   * they were stated over; undefined when the faces are read off the
   * picture. Non-enumerable, like `space`. */
  declare readonly stated: StatedFaces | undefined;
  /** @internal The point and edge domains of this state (relation.ts),
   * made the first time a selection of them is: every selection of this
   * state shares them. A box, like the others. */
  readonly domainBox: { points: unknown; edges: unknown } = { points: null, edges: null };
  /** @internal The curves of this state (curves.ts): the walk and its
   * selection, made the first time `curves` is read. A box, like the others. */
  readonly curvesBox: { table: unknown; all: unknown } = { table: null, all: null };
  /** @internal The area of a material whose area is worked out when it is
   * asked for (a level set: its lines are the rows, and the closed regions
   * are a material of their own). `make` builds it the first time
   * `areaMaterial(m)` is called, and `material` keeps it. Both null: the
   * material's area is its own closed chains. A box, like the others. */
  readonly areaBox: { make: (() => Material) | null; material: Material | null };
  /** @internal Face columns, by name. A face is not a row, so these are keyed by
   * what a face IS — the walls it is made of — and not by an index. */
  readonly faceAttrs: Readonly<Record<string, FaceColumn>>;
  /**
   * The space these coordinates belong to: the sketch's own `Space`,
   * stamped by the toolkit word that made the material, and carried by
   * every verb that rebuilds it. `move` walks in it and the forces
   * measure with it. Absent on the pure `material(points)`, whose
   * coordinates are flat numbers and walk flat.
   *
   * Non-enumerable, as `Frame.space` is: a space is a record of closures,
   * and a material compared or copied as data is compared by its rows.
   */
  declare readonly space: Space | undefined;
  /** @internal id → row, built the first time an id is looked up. A box, like the
   * adjacency, because the state is frozen. */
  private readonly idBox: { points: Map<number, number> | null; edges: Map<number, number> | null };
  /** @internal The row views of this state, one object per row, made the
   * first time the row is read and kept: `===` names a row within a state.
   * A box, like the others, because the state is frozen. */
  readonly viewBox: { points: RowViews<Vertex> | null; edges: RowViews<Edge> | null } = { points: null, edges: null };
  /** @internal The flat attribute records, made on first read. */
  private readonly flatBox: { attrs: Readonly<Record<string, Float64Array>> | null; edgeAttrs: Readonly<Record<string, Float64Array>> | null } = { attrs: null, edgeAttrs: null };

  /** @internal Use `material()`/`curve()`/`t.sample()`. A column is
   * adopted by the constructor — a typed array as it is, or a persistent
   * column (column.ts) — and the library never writes to one after, so
   * two materials may share a column, and a write shares every leaf it
   * does not touch: a snapshot or a source cannot change under you. What
   * remains: typed arrays cannot be frozen, so `m.x[i] = …` from a sketch
   * does write, into every state that shares that column. */
  constructor(
    x: ColumnLike<Float64Array>,
    y: ColumnLike<Float64Array>,
    attrs: Readonly<Record<string, ColumnLike<Float64Array>>>,
    edgeList: ColumnLike<Uint32Array>,
    /**
     * Everything a rebuild carries over, by name.
     *
     * The positional four are the geometry itself and are always given.
     * The rest used to be five positional parameters, and every new one
     * made the next call site one transposition away from a silent
     * wrong-column bug — the kind that shows up as columns quietly
     * vanishing after a `thicken` or a `warp`, with nothing to see. Named,
     * a mistake is a type error.
     */
    carry: {
      iteration?: number;
      history?: readonly Material[];
      edgeAttrs?: Readonly<Record<string, ColumnLike<Float64Array>>>;
      transfers?: Record<string, TransferPolicy>;
      edgeTransfers?: Record<string, EdgeTransfer>;
      /** The identity of each row, carried from wherever these rows came
       * from. Absent means this is new geometry, and the constructor
       * mints. `edgeRoots` says which older edge each edge descends from;
       * absent means each edge is its own root. */
      ids?: { points?: ColumnLike<Float64Array>; edges?: ColumnLike<Float64Array>; edgeRoots?: ColumnLike<Float64Array> };
      /** Face columns, carried from the state these rows came from. */
      faceAttrs?: Record<string, FaceColumn>;
      /** The space the coordinates belong to (see `Material.space`). */
      space?: Space;
      /** The value these rows were made from: the space is taken from it
       * when `space` is not given, so a derived material is in the space
       * of its source without a word to say so. */
      from?: { readonly space?: Space | undefined };
      /** The material's area, when it is not its own closed chains: built
       * the first time an area consumer asks (see `areaMaterial`). */
      area?: () => Material;
      /** Faces a word states outright; kept only when these edges are the
       * ones they were stated over (`statedFor`). */
      faces?: StatedFaces;
    } = {},
  ) {
    const {
      iteration = 0,
      history = [],
      transfers = {},
      edgeTransfers = {},
      ids,
      faceAttrs = {},
    } = carry;
    const xs = columnOf(x);
    const ys = columnOf(y);
    const list = columnOf(edgeList);
    if (xs.length !== ys.length) throw new Error('material: x and y columns differ in length');
    if (list.length % 2 !== 0) throw new Error('material: edge list must be pairs');
    const n = xs.length;
    const edgeCount = list.length / 2;
    const edgeCols: Record<string, Column> = {};
    for (const name in carry.edgeAttrs ?? {}) {
      const col = columnOf(carry.edgeAttrs![name]);
      if (col.length !== edgeCount) {
        throw new Error(`material: edge attribute '${name}' has ${col.length} values for ${edgeCount} edges`);
      }
      if (RESERVED_EDGE_FIELDS.includes(name)) {
        throw new Error(`material: '${name}' is a reserved edge field`);
      }
      edgeCols[name] = col;
    }
    const pointCols: Record<string, Column> = {};
    for (const name in attrs) {
      const col = columnOf(attrs[name]);
      if (col.length !== n) {
        throw new Error(`material: attribute '${name}' has ${col.length} values for ${n} vertices`);
      }
      if (name === 'x' || name === 'y' || name === 'index' || name === 'adjacent' || name === 'edges' || name === 'id' || name === 'source') {
        throw new Error(`material: '${name}' is a reserved vertex field`);
      }
      pointCols[name] = col;
    }
    this.n = n;
    this.iteration = iteration;
    this.history = history;
    this.transfers = transfers;
    this.edgeTransfers = edgeTransfers;
    // Leaf by leaf: the check reads every pair and needs no flat list.
    for (const leaf of list.leaves()) {
      for (let k = 0; k < leaf.length; k += 2) {
        const a = leaf[k];
        const b = leaf[k + 1];
        if (a >= n || b >= n) throw new Error(`material: edge ${a}–${b} names a vertex beyond ${n - 1}`);
        if (a === b) throw new Error(`material: edge ${a}–${b} joins a vertex to itself`);
      }
    }
    this.adjBox = { rows: null, edges: null };
    this.facesBox = { faces: null };
    this.areaBox = { make: carry.area ?? null, material: null };
    const givenPoints = ids?.points === undefined ? undefined : columnOf(ids.points);
    const givenEdges = ids?.edges === undefined ? undefined : columnOf(ids.edges);
    const givenRoots = ids?.edgeRoots === undefined ? undefined : columnOf(ids.edgeRoots);
    if (givenPoints !== undefined && givenPoints.length !== n) {
      throw new Error(`material: ${givenPoints.length} point ids for ${n} vertices`);
    }
    if (givenEdges !== undefined && givenEdges.length !== edgeCount) {
      throw new Error(`material: ${givenEdges.length} edge ids for ${edgeCount} edges`);
    }
    const pointIds = givenPoints ?? Column.of(mintIds(n));
    const edgeIds = givenEdges ?? Column.of(mintIds(edgeCount));
    if (givenRoots !== undefined && givenRoots.length !== edgeCount) {
      throw new Error(`material: ${givenRoots.length} edge roots for ${edgeCount} edges`);
    }
    // An edge born from nothing is its own root: the same numbers as its
    // id, so the same column.
    const edgeRoots = givenRoots ?? edgeIds;
    this.store = Object.freeze({
      x: xs, y: ys, attrs: Object.freeze(pointCols), attrNames: Object.freeze(Object.keys(pointCols)), attrList: Object.freeze(Object.values(pointCols)), pointIds,
      edgeList: list, edgeAttrs: Object.freeze(edgeCols), edgeAttrNames: Object.freeze(Object.keys(edgeCols)), edgeAttrList: Object.freeze(Object.values(edgeCols)), edgeIds, edgeRoots,
    });
    for (const name of Object.keys(faceAttrs)) {
      if (RESERVED_FACE_FIELDS.includes(name)) throw new Error(`material: '${name}' is a reserved face field`);
    }
    this.faceAttrs = faceAttrs;
    Object.defineProperty(this, 'space', { value: carry.space ?? carry.from?.space, enumerable: false });
    Object.defineProperty(this, 'stated', { value: statedFor(carry.faces, list, edgeIds), enumerable: false });
    this.idBox = { points: null, edges: null };
    Object.freeze(this.faceAttrs);
    Object.freeze(this.transfers);
    Object.freeze(this.edgeTransfers);
    Object.freeze(this.history);
    // A subclass — a `Tiling` — has its own members to set, so it freezes
    // itself. Every material a sketch holds is frozen either way.
    if (new.target === Material) Object.freeze(this);
  }

  // ---- the flat columns: the kernels' door ----

  /** @internal The x column, `n` long, as one array (read it, never write
   * it). A sketch reads `p.x` on a row. */
  get x(): Float64Array { return this.store.x.flat(); }
  /** @internal The y column, `n` long. A sketch reads `p.y` on a row. */
  get y(): Float64Array { return this.store.y.flat(); }
  /** @internal Attribute columns by name, each `n` long. A sketch reads a
   * column on a row: `p.age`. Each column is joined into one array the
   * first time its name is read here. */
  get attrs(): Readonly<Record<string, Float64Array>> {
    return (this.flatBox.attrs ??= flatRecord(this.store.attrs));
  }
  /** @internal Edge list, stored order, `[a0, b0, a1, b1, …]`. Undirected for
   * connectivity; the stored direction is what `edges`, `split` (`at`)
   * and the order of `curves` see. */
  get edgeList(): Uint32Array { return this.store.edgeList.flat(); }
  /** @internal Edge attribute columns by name, each `edgeCount` long. A
   * sketch reads a column on an edge row: `e.rest`. */
  get edgeAttrs(): Readonly<Record<string, Float64Array>> {
    return (this.flatBox.edgeAttrs ??= flatRecord(this.store.edgeAttrs));
  }
  /** @internal The point rows' ids (see `MaterialStore.pointIds`). */
  get pointIds(): Float64Array { return this.store.pointIds.flat(); }
  /** @internal The edge rows' ids. */
  get edgeIds(): Float64Array { return this.store.edgeIds.flat(); }
  /** @internal Each edge's lineage root (see `MaterialStore.edgeRoots`). */
  get edgeRoots(): Float64Array { return this.store.edgeRoots.flat(); }

  // ---- access ----

  /** Rows adjacent to each row, in edge order — the same lists the
   * constructor used to build eagerly. */
  private get adj(): number[][] {
    const box = this.adjBox;
    if (box.rows !== null) return box.rows;
    const rows: number[][] = Array.from({ length: this.n }, () => []);
    for (const leaf of this.store.edgeList.leaves()) {
      for (let k = 0; k < leaf.length; k += 2) {
        rows[leaf[k]].push(leaf[k + 1]);
        rows[leaf[k + 1]].push(leaf[k]);
      }
    }
    box.rows = rows;
    return rows;
  }

  /** Edge rows meeting each row, in edge order. Lazy, like `adj`. */
  private get edgeAdj(): number[][] {
    const box = this.adjBox;
    if (box.edges !== null) return box.edges;
    const rows: number[][] = Array.from({ length: this.n }, () => []);
    let e = 0;
    for (const leaf of this.store.edgeList.leaves()) {
      for (let k = 0; k < leaf.length; k += 2, e++) {
        const a = leaf[k];
        const b = leaf[k + 1];
        rows[a].push(e);
        if (b !== a) rows[b].push(e);
      }
    }
    box.edges = rows;
    return rows;
  }

  /** @internal Names of the attribute columns. */
  get attrNames(): string[] {
    return Object.keys(this.store.attrs);
  }

  /**
   * @internal The row an id is at in THIS state, or -1 when it is gone.
   *
   * This is how a later step finds what an earlier one marked: store
   * `p.id` in a column, and `m.rowOfPoint(id)` says where it went. The map
   * is built the first time it is asked for, like the adjacency.
   */
  rowOfPoint(id: PointId): number {
    let map = this.idBox.points;
    if (!map) {
      map = idMap(this.store.pointIds);
      this.idBox.points = map;
    }
    return map.get(id) ?? -1;
  }

  /** @internal The edge row an id is at in this state, or -1 when it is gone (a
   * split retires the parent, so its id resolves to nothing). */
  rowOfEdge(id: EdgeId): number {
    let map = this.idBox.edges;
    if (!map) {
      map = idMap(this.store.edgeIds);
      this.idBox.edges = map;
    }
    return map.get(id) ?? -1;
  }

  /**
   * The vertex an id names in this state, or undefined when it is gone.
   *
   * Named apart from `vertex(row)` on purpose: an id and a row are both
   * numbers, so one word taking either would have to guess which you meant,
   * and guessing wrong is silent. `pointOf` asks by identity, `vertex` by
   * position in this state.
   */
  pointOf(id: PointId): Vertex | undefined {
    const row = this.rowOfPoint(id);
    return row < 0 ? undefined : this.vertex(row);
  }

  /** The edge an id names in this state, or undefined when it is gone; a
   * split retires the parent, so its id resolves to nothing. `edge(row)`
   * is the same question asked by position. */
  edgeOf(id: EdgeId): Edge | undefined {
    const row = this.rowOfEdge(id);
    return row < 0 ? undefined : this.edge(row);
  }

  /**
   * @internal The vertex at row `i` as a view: ONE frozen object per row of
   * this state, made the first time the row is read — through a selection,
   * a relation, an id — and kept, so two reads of a row are `===`. The
   * engine's own door, like `adjacentRows`: a sketch says `m.points.at(i)`.
   */
  vertex(i: number): Vertex {
    const views = pointViews(this);
    return views.get(i) ?? views.set(i, Object.freeze(vertexView(this, i)));
  }

  /** Every vertex, as a geometry collection: iterate, `length`, `at(i)`,
   * `map` (an array), `find`, `filter` (a selection of this state) and
   * `groupBy` (selections by key). Views are made as you read them. */
  get points(): Selection<Vertex> {
    return pointsOf(this);
  }

  /** @internal Number of edges. A sketch reads `m.edges.length`. */
  get edgeCount(): number {
    return this.store.edgeList.length / 2;
  }

  /** @internal Names of the edge attribute columns. */
  get edgeAttrNames(): string[] {
    return Object.keys(this.store.edgeAttrs);
  }

  /** @internal The edge at row `e` as a view (a → b in stored order, with
   * attrs): one frozen object per row of this state, as `vertex` is, and
   * its ends are the vertex views of this state. A sketch says
   * `m.edges.at(e)`. */
  edge(e: number): Edge {
    const views = edgeViews(this);
    return views.get(e) ?? views.set(e, edgeView(this, e));
  }

  /** Every edge, stored order, as a geometry collection (see `points`);
   * `filter` gives an edge selection whose chains and boundary are those
   * of the selected edges alone. */
  get edges(): Selection<Edge> {
    return edgesOf(this);
  }

  /** @internal Rows adjacent to `i`, in edge order. The engine's own door;
   * a sketch says `p.adjacent`, which is a selection and composes. */
  adjacentRows(i: Vertex | number): readonly number[] {
    return this.adj[this.rowOfVertex(i, 'adjacentRows')];
  }

  /** @internal Edge rows meeting `i`, in edge order. A sketch says
   * `p.edges`, which is a selection and composes. */
  incidentEdgeRows(i: Vertex | number): readonly number[] {
    return this.edgeAdj[this.rowOfVertex(i, 'incidentEdgeRows')];
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
    // Pure: a value from a memoised call answers from the memo (memo.ts);
    // a resolver among the options leaves the call unkeyed.
    return memoMethod(this, 'planarize', [opts], () => planarize(this, opts));
  }

  /** Independent material in which coincident ink is one piece of ink:
   * vertices within `tolerance` are one vertex, a duplicate edge is one
   * edge, and collinear edges that overlap become the spans they cover,
   * each kept once. The word that resolves what `planarize` refuses. */
  merge(opts: MergeOpts = {}): Material {
    return mergeKernel(this, opts);
  }

  /**
   * The faces of this state, as a selection of face rows: a property,
   * worked out the first time it is read and kept on the state, so every
   * read answers the same collection.
   *
   * A material a word made with faces it knows — `t.tiling`, `t.grid`,
   * `t.voronoi`, `t.quadtree` — has those faces, in the order the word made
   * them, nested where it nests and each with its `source`. A write that
   * changes the edges drops them, and so does any material a sketch built
   * itself: its faces are read off the drawn picture by the planar walk
   * (faces.ts), and their columns carried by wall lineage.
   */
  get faces(): Selection<Face> {
    const area = areaMaterial(this);
    if (area !== this) return area.faces;
    return (this.facesBox.faces ??= new FaceTable(this, this.stated)).all;
  }

  /**
   * The material's areas: its CLOSED chains, as contour records with their
   * winding. This is what an area consumer reads — `polygon(m)` fills these
   * and `t.within(x, m)` bounds by them. A material whose chains are all
   * open has no area, and the consumer says so rather than drawing nothing.
   * For every chain, open or closed, see `curves`. A level set's area is
   * its regions, closed along the drawable, a bound and every hole: worked
   * out on this first ask, not by `t.isolines`.
   */
  contours(): IsoContour[] {
    const area = areaMaterial(this);
    if (area !== this) return area.contours();
    const out: IsoContour[] = [];
    for (const c of chainsOf(this)) {
      if (!c.closed) continue;
      const pts = c.pts.map((p) => [p[0], p[1]] as [number, number]);
      out.push(c.geodesic ? { pts, closed: true, geodesic: c.geodesic } : { pts, closed: true });
    }
    return out;
  }

  /**
   * The curves: the chains the edges walk, as a selection of curve rows
   * (curves.ts). Read on first ask and kept. A chain starts at an endpoint
   * or a junction (a point with other than two edges), the first by row, and
   * runs through the points two edges meet; a ring starts at the start of
   * its first edge row and runs that edge's way. Every edge is in one curve; a
   * junction is in each curve that meets it; isolated points are in none.
   * Curves come in row order of their first point, so a material built from
   * outlines keeps their order, and every write keeps it.
   */
  get curves(): Selection<Curve> {
    return curvesOf(this);
  }

  // ---- derived material ----

  /**
   * Replace a column by the mean of itself and its neighbours, `steps`
   * times. The 2D half of `mesh.smooth`, with the same name, the same
   * option and the same rule.
   *
   * A tone column read off an image is speckled, and speckle in a density
   * column is banding on paper. `force.relax` smooths POSITIONS; this
   * smooths a value, and moves nothing.
   *
   * It finds the domain from the name: a point column averages over the
   * points an edge joins to it, an edge column over the edges that share a
   * vertex with it. A row with no neighbours is the mean of itself, so it
   * keeps what it had — a loose vertex does not become NaN.
   *
   * Every pass reads the state the last pass finished, so the result does
   * not depend on row order.
   */
  smooth(name: string, opts: { steps?: number } = {}): Material {
    const steps = opts.steps ?? 1;
    if (!Number.isInteger(steps) || steps < 0) throw new Error(`smooth: { steps } must be a whole number of passes, at least 0 (got ${String(opts.steps)})`);
    const onPoints = Object.hasOwn(this.attrs, name);
    const onEdges = Object.hasOwn(this.edgeAttrs, name);
    if (!onPoints && !onEdges) throw new Error(`smooth: no point or edge column '${name}' to smooth`);
    if (steps === 0) return material(this);
    const src = material(this);
    let cur = Float64Array.from(onPoints ? src.attrs[name] : src.edgeAttrs[name]);
    // The neighbourhood, once: a point's joined points, or an edge's
    // edges through either end.
    const rows = cur.length;
    const nb: readonly number[][] = onPoints
      ? Array.from({ length: rows }, (_, i) => [...src.adjacentRows(i)])
      : Array.from({ length: rows }, (_, e) => {
          const out = new Set<number>();
          for (const end of [src.edgeList[2 * e], src.edgeList[2 * e + 1]]) for (const f of src.incidentEdgeRows(end)) out.add(f);
          out.delete(e);
          return [...out];
        });
    for (let k = 0; k < steps; k++) {
      const next = new Float64Array(rows);
      for (let i = 0; i < rows; i++) {
        let sum = cur[i];
        for (const j of nb[i]) sum += cur[j];
        next[i] = sum / (nb[i].length + 1);
      }
      cur = next;
    }
    return onPoints ? setPoints(src, null, [name, (p: Vertex) => cur[p.index]]) : setEdges(src, null, [name, (e: Edge) => cur[e.index]]);
  }

  /** @internal The face columns this material declares. */
  get faceAttrNames(): string[] {
    return Object.keys(this.faceAttrs);
  }

  /**
   * Resample the material's chains evenly by arc length — the explicit,
   * lossy redistribution of sampled material after it has been deformed.
   * It walks `curves`: each chain gets `count` vertices, or as many as
   * fit at `spacing` (at least 2 open, 3 closed); open chains keep both
   * endpoints, closed ones keep their seam at their first vertex. On a
   * network — a hex field, a tiling, a voronoi — a chain runs from one
   * junction to the next, and every junction and loose end stays where it
   * is and who it is: one vertex, the same id, every chain still meeting
   * there. Corners are NOT preserved: a new vertex
   * lands on the old polyline, but a corner between two new vertices is
   * cut. Attributes carry over per `transfer` (default: linear
   * interpolation for every column; `'nearest'`, a constant, or a function
   * per column to say otherwise — an `age` is a choice, not a mean).
   *
   * `where` redistributes part of the material and leaves the rest alone.
   * The eligible region is a set of EDGES: a point selection means the
   * edges with both ends selected, which is what `sel.edges` already says.
   * Consecutive eligible edges make a RUN, and a run is what gets
   * redistributed — as an open piece, so it keeps the two vertices at its
   * ends. `count` is then per run, not per chain. Everything outside a run
   * comes through untouched and KEEPS ITS IDENTITY: the same point ids, the
   * same edge ids and roots. A new vertex inside a run is minted, and a new
   * edge takes the lineage root of the source edge under its middle, the
   * way a split's children take their parent's — so a face column survives
   * a partial resample.
   */
  resample(opts: { spacing?: number; count?: number; transfer?: Record<string, Transfer>; where?: Where }): Material {
    return resampleMaterial(this, opts, null);
  }

  /**
   * A curve THROUGH this material's vertices: a Catmull-Rom spline,
   * sampled into ordinary Material.
   *
   * The `smooth` modifier rounds a corner off — the drawn line passes
   * INSIDE it. This one keeps every corner vertex and bends the line
   * between them, so a chain of picked positions stays a chain through
   * those positions. Closure is read from the chain: a ring's seam is a
   * segment like any other, so the curve comes back on itself with no
   * corner.
   *
   * `tension` scales the tangent at each vertex: 0 is the polyline it
   * started from, 0.5 (the default) is the ordinary Catmull-Rom curve, and
   * 1 swings wide and overshoots. `steps` is the samples per source
   * segment (default 8) — the source segment becomes that many edges. An
   * open chain takes its end tangents from its end segments. A chain of
   * fewer than three vertices has no curve to describe and comes through
   * as it is. On a network each chain of `curves` bends on its own,
   * junction to junction: a junction is a vertex like any other, kept, and
   * each chain leaves it along its own end segment.
   *
   * The source vertices are the same vertices: same ids, same positions,
   * same columns. Each new vertex between them is minted, with its columns
   * read by the transfer policies. Every source edge is retired and its
   * children keep its lineage root, as a split's children do, so a face
   * column still finds its cells. An edge column that is `'distribute'` is
   * shared out over the children by their share of the new arc length.
   */
  spline(opts: { tension?: number; steps?: number } = {}): Material {
    const tension = opts.tension ?? 0.5;
    if (!Number.isFinite(tension) || tension < 0 || tension > 1) {
      throw new Error(`spline: { tension } must be a number from 0 to 1 (got ${String(opts.tension)})`);
    }
    const steps = opts.steps ?? 8;
    if (!Number.isInteger(steps) || steps < 1) {
      throw new Error(`spline: { steps } must be a whole number of samples per segment, at least 1 (got ${String(opts.steps)})`);
    }
    const names = this.attrNames;
    const enames = this.edgeAttrNames;
    const transfer: Record<string, Transfer> = { ...this.transfers };
    const ox: number[] = [];
    const oy: number[] = [];
    const oattrs: Record<string, number[]> = {};
    for (const name of names) oattrs[name] = [];
    const edges: number[] = [];
    const eattrs: Record<string, number[]> = {};
    for (const name of enames) eattrs[name] = [];
    // Where each output row came from: a source row, or -1 for a row this
    // call made. The same bookkeeping `resample` keeps under `where`.
    const osrc: number[] = [];
    const esrc: number[] = [];
    const eroot: number[] = [];
    const storedRow = new Map<number, number>();
    for (let e = 0; e < this.edgeCount; e++) storedRow.set(pairKey(this.edgeList[2 * e], this.edgeList[2 * e + 1]), e);
    const rowOf = new Map<number, number>();
    // A source vertex, verbatim — not through `transfer`, which says what a
    // value does at a NEW vertex. A vertex two segments share is one row.
    const rowFor = (v: number): number => {
      const had = rowOf.get(v);
      if (had !== undefined) return had;
      ox.push(this.x[v]);
      oy.push(this.y[v]);
      osrc.push(v);
      for (const name of names) oattrs[name].push(this.attrs[name][v]);
      rowOf.set(v, ox.length - 1);
      return ox.length - 1;
    };
    /** A new vertex at (x, y), its columns read between a and b at t. */
    const place = (x: number, y: number, a: number, b: number, t: number): number => {
      ox.push(x);
      oy.push(y);
      osrc.push(-1);
      for (const name of names) {
        const rule = transfer[name] ?? 'interpolate';
        const va = this.attrs[name][a];
        const vb = this.attrs[name][b];
        let v: number;
        if (rule === 'interpolate') v = va + (vb - va) * t;
        else if (rule === 'nearest') v = t <= 0.5 ? va : vb; // ties to the start vertex
        else if (typeof rule === 'number') v = rule;
        else v = rule(readVertex(this, a), readVertex(this, b), t);
        oattrs[name].push(v);
      }
      return ox.length - 1;
    };
    /** One source edge through as it is: same row, same lineage. */
    const keep = (a: number, b: number, row: number) => {
      edges.push(rowFor(a), rowFor(b));
      esrc.push(row);
      eroot.push(row);
      for (const name of enames) eattrs[name].push(this.edgeAttrs[name][row]);
    };
    // Isolated vertices are not chains: they come through unchanged.
    for (let i = 0; i < this.n; i++) if (this.adj[i].length === 0) rowFor(i);
    for (const c of chainsOf(this)) {
      // A loop that leaves a junction and comes back to it ends there twice,
      // like any chain that ends at a junction: it is walked open.
      const pinned = c.closed && this.adj[c.indices[0]].length > 2;
      const idx = pinned ? [...c.indices, c.indices[0]] : c.indices;
      const closed = c.closed && !pinned;
      const k = idx.length;
      const segs = closed ? k : k - 1;
      const rowOfSeg = (s: number) => storedRow.get(pairKey(idx[s % k], idx[(s + 1) % k]))!;
      // Two vertices describe a straight line and nothing else: no curve to
      // draw, so the chain is the chain it was.
      if (k < 3) {
        for (let s = 0; s < segs; s++) keep(idx[s % k], idx[(s + 1) % k], rowOfSeg(s));
        continue;
      }
      // The vertex before the segment and the one after it set the tangents.
      // An open chain has none at its ends, so the end segment is its own
      // neighbour and the curve leaves along it.
      const at = (j: number): number => (closed ? idx[((j % k) + k) % k] : idx[Math.max(0, Math.min(k - 1, j))]);
      for (let s = 0; s < segs; s++) {
        const row = rowOfSeg(s);
        const p0 = at(s - 1);
        const p1 = at(s);
        const p2 = at(s + 1);
        const p3 = at(s + 2);
        const m0x = tension * (this.x[p2] - this.x[p0]);
        const m0y = tension * (this.y[p2] - this.y[p0]);
        const m1x = tension * (this.x[p3] - this.x[p1]);
        const m1y = tension * (this.y[p3] - this.y[p1]);
        const rows: number[] = [rowFor(p1)];
        for (let i = 1; i < steps; i++) {
          const u = i / steps;
          const u2 = u * u;
          const u3 = u2 * u;
          const h00 = 2 * u3 - 3 * u2 + 1;
          const h10 = u3 - 2 * u2 + u;
          const h01 = -2 * u3 + 3 * u2;
          const h11 = u3 - u2;
          rows.push(place(
            h00 * this.x[p1] + h10 * m0x + h01 * this.x[p2] + h11 * m1x,
            h00 * this.y[p1] + h10 * m0y + h01 * this.y[p2] + h11 * m1y,
            p1, p2, u,
          ));
        }
        rows.push(rowFor(p2));
        // A 'distribute' column is shared over the children by their share
        // of the arc the segment now takes, so the quantity the source edge
        // carried is still what its children carry between them.
        const spans: number[] = [];
        let total = 0;
        for (let i = 1; i < rows.length; i++) {
          const d = Math.hypot(ox[rows[i]] - ox[rows[i - 1]], oy[rows[i]] - oy[rows[i - 1]]);
          spans.push(d);
          total += d;
        }
        for (let i = 1; i < rows.length; i++) {
          edges.push(rows[i - 1], rows[i]);
          esrc.push(-1);
          eroot.push(row);
          for (const name of enames) {
            const value = this.edgeAttrs[name][row];
            eattrs[name].push(this.edgeTransfers[name] === 'distribute' ? (total > 0 ? value * (spans[i - 1] / total) : value / spans.length) : value);
          }
        }
      }
    }
    const attrs: Record<string, Float64Array> = {};
    for (const name of names) attrs[name] = Float64Array.from(oattrs[name]);
    const edgeAttrs: Record<string, Float64Array> = {};
    for (const name of enames) edgeAttrs[name] = Float64Array.from(eattrs[name]);
    const freshPoints = mintIds(osrc.reduce((n, v) => n + (v < 0 ? 1 : 0), 0));
    const freshEdges = mintIds(esrc.reduce((n, v) => n + (v < 0 ? 1 : 0), 0));
    let fp = 0;
    let fe = 0;
    const pointIds = Float64Array.from(osrc, (v) => (v < 0 ? freshPoints[fp++] : this.pointIds[v]));
    const edgeIds = Float64Array.from(esrc, (v) => (v < 0 ? freshEdges[fe++] : this.edgeIds[v]));
    const edgeRoots = Float64Array.from(esrc, (v, i) => (v >= 0 ? this.edgeRoots[v] : this.edgeRoots[eroot[i]]));
    return carryLinks(this, new Material(Float64Array.from(ox), Float64Array.from(oy), attrs, Uint32Array.from(edges), {
      iteration: this.iteration, history: [], edgeAttrs: edgeAttrs, transfers: { ...this.transfers }, edgeTransfers: { ...this.edgeTransfers },
      ids: { points: pointIds, edges: edgeIds, edgeRoots }, faceAttrs: this.faceAttrs, from: this, faces: this.stated,
    }));
  }

  /**
   * Cut a length off each open chain's two ends, by arc length.
   *
   * Gaps where strokes meet, a taper that starts short of the corner, a
   * chain that grows out from its middle: all of them are this, and all of
   * them were written by hand. Lengths are the material's own coordinates,
   * as `oscillate` and `thicken` take them — an unresolved `mm(1)` is
   * refused rather than read against global paper.
   *
   * A CLOSED chain has no ends and comes through whole. That is not a
   * silence: `trim` is about ends, and a ring has none. Open it first if
   * you want a gap in it.
   *
   * A chain with nothing left after the cut draws nothing, the way every
   * degenerate input here does. So does an isolated vertex, which is not a
   * chain. On a network the chains are those of `curves`, junction to
   * junction, and a junction is not an end: it stays, with every chain that
   * meets it, and only a loose end is cut — the tips of a crack, not its
   * forks. `start` is cut from a chain's first vertex, `end` from its last,
   * in the order `curves` walks it.
   *
   * The vertices between the two cuts are the SAME vertices: same ids,
   * same positions, same columns. Each new end is a fresh vertex, with its
   * columns read by the transfer policies, and the edge it sits on is a
   * child of the edge it was cut from — same lineage root, as a split's
   * children are.
   */
  trim(opts: { start?: number; end?: number }): Material {
    const head = opts?.start ?? 0;
    const tail = opts?.end ?? 0;
    // Lengths in the material's own space, as `resample` measures them.
    const space = this.space;
    const curved = space !== undefined && space.kind !== 'euclidean' ? space : null;
    for (const [name, v] of [['start', head], ['end', tail]] as const) {
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`trim: { ${name} } must be a finite length in the material's own coordinates (mm(1) and the other lengths need the sketch frame, as for thicken)`);
      if (v < 0) throw new Error(`trim: { ${name} } must not be negative — a cut removes length, it does not add any`);
    }
    if (head === 0 && tail === 0) return material(this);
    const names = this.attrNames;
    const enames = this.edgeAttrNames;
    const transfer: Record<string, Transfer> = { ...this.transfers };
    const ox: number[] = [];
    const oy: number[] = [];
    const oattrs: Record<string, number[]> = {};
    for (const name of names) oattrs[name] = [];
    const eattrs: Record<string, number[]> = {};
    for (const name of enames) eattrs[name] = [];
    const edges: number[] = [];
    const osrc: number[] = [];
    const esrc: number[] = [];
    // The source edge each new edge is a piece of, whose LINEAGE it keeps
    // even when its own id is retired. An edge that survives whole names
    // itself here, so one expression gives both.
    const eroot: number[] = [];
    const storedRow = new Map<number, number>();
    for (let e = 0; e < this.edgeCount; e++) storedRow.set(pairKey(this.edgeList[2 * e], this.edgeList[2 * e + 1]), e);
    // A vertex this call does not touch, verbatim, and once: a junction the
    // chains share is one row. A cut end, blended.
    const rowOf = new Map<number, number>();
    const keep = (v: number): number => {
      const had = rowOf.get(v);
      if (had !== undefined) return had;
      ox.push(this.x[v]);
      oy.push(this.y[v]);
      osrc.push(v);
      for (const name of names) oattrs[name].push(this.attrs[name][v]);
      rowOf.set(v, ox.length - 1);
      return ox.length - 1;
    };
    const cut = (a: number, b: number, t: number): number => {
      if (curved) {
        const g = curved.geodesic([this.x[a], this.y[a]], [this.x[b], this.y[b]], t);
        ox.push(g[0]);
        oy.push(g[1]);
      } else {
        ox.push(this.x[a] + (this.x[b] - this.x[a]) * t);
        oy.push(this.y[a] + (this.y[b] - this.y[a]) * t);
      }
      osrc.push(-1);
      for (const name of names) {
        const rule = transfer[name] ?? 'interpolate';
        const va = this.attrs[name][a];
        const vb = this.attrs[name][b];
        if (rule === 'interpolate') oattrs[name].push(va + (vb - va) * t);
        else if (rule === 'nearest') oattrs[name].push(t <= 0.5 ? va : vb);
        else if (typeof rule === 'number') oattrs[name].push(rule);
        else oattrs[name].push(rule(readVertex(this, a), readVertex(this, b), t));
      }
      return ox.length - 1;
    };
    const join = (from: number, to: number, sourceEdge: number, whole: boolean) => {
      edges.push(from, to);
      esrc.push(whole ? sourceEdge : -1);
      eroot.push(sourceEdge);
      for (const name of enames) eattrs[name].push(this.edgeAttrs[name][sourceEdge]);
    };
    for (const c of chainsOf(this)) {
      const idx = c.indices;
      // A ring has no ends: it comes through as it is.
      if (c.closed) {
        const rows = idx.map(keep);
        for (let s = 0; s < idx.length; s++) {
          join(rows[s], rows[(s + 1) % idx.length], storedRow.get(pairKey(idx[s], idx[(s + 1) % idx.length]))!, true);
        }
        continue;
      }
      const pts = idx.map((i) => [this.x[i], this.y[i]] as [number, number]);
      const cum = chainLengths(pts, false, space);
      const total = cum[cum.length - 1];
      // A junction is not an end: nothing is cut there.
      const from = this.adj[idx[0]].length > 2 ? 0 : head;
      const to = this.adj[idx[idx.length - 1]].length > 2 ? total : total - tail;
      // Nothing survives the cut: this chain draws nothing.
      if (!(to > from)) continue;
      // The segment a distance falls on, and how far along it.
      const at = (d: number): [number, number] => {
        let s = 0;
        while (s < cum.length - 2 && cum[s + 1] <= d) s++;
        const span = cum[s + 1] - cum[s];
        return [s, span > 0 ? (d - cum[s]) / span : 0];
      };
      // What survives, as stops along the chain in order: the head cut, every
      // source vertex the cut did not remove, and the tail cut. A source
      // vertex that the cut lands exactly on IS the end, and is not doubled.
      const stops: { d: number; row: number }[] = [];
      for (let v = 0; v < idx.length; v++) if (cum[v] >= from && cum[v] <= to) stops.push({ d: cum[v], row: v });
      if (stops.length === 0 || stops[0].d > from) stops.unshift({ d: from, row: -1 });
      if (stops[stops.length - 1].d < to) stops.push({ d: to, row: -1 });
      const rows = stops.map((stop) => {
        if (stop.row >= 0) return keep(idx[stop.row]);
        const [seg, t] = at(stop.d);
        return cut(idx[seg], idx[seg + 1], t);
      });
      // Consecutive stops always lie within ONE source segment, because
      // every source vertex between the cuts is a stop. The segment under
      // the middle is therefore the segment they are both on.
      for (let k = 0; k + 1 < stops.length; k++) {
        const [seg] = at((stops[k].d + stops[k + 1].d) / 2);
        // The edge survives whole, and keeps its id, only when both ends are
        // the source vertices it already joined.
        const whole = stops[k].row >= 0 && stops[k + 1].row === stops[k].row + 1;
        join(rows[k], rows[k + 1], storedRow.get(pairKey(idx[seg], idx[seg + 1]))!, whole);
      }
    }
    const attrs: Record<string, Float64Array> = {};
    for (const name of names) attrs[name] = Float64Array.from(oattrs[name]);
    const edgeAttrs: Record<string, Float64Array> = {};
    for (const name of enames) edgeAttrs[name] = Float64Array.from(eattrs[name]);
    const freshPoints = mintIds(osrc.reduce((k, v) => k + (v < 0 ? 1 : 0), 0));
    const freshEdges = mintIds(esrc.reduce((k, v) => k + (v < 0 ? 1 : 0), 0));
    let fp = 0;
    let fe = 0;
    const pointIds = Float64Array.from(osrc, (v) => (v < 0 ? freshPoints[fp++] : this.pointIds[v]));
    const edgeIds = Float64Array.from(esrc, (v) => (v < 0 ? freshEdges[fe++] : this.edgeIds[v]));
    return carryLinks(this, new Material(Float64Array.from(ox), Float64Array.from(oy), attrs, Uint32Array.from(edges), { iteration: this.iteration, history: [], edgeAttrs, transfers: { ...this.transfers }, edgeTransfers: { ...this.edgeTransfers }, ids: { points: pointIds, edges: edgeIds, edgeRoots: Float64Array.from(eroot, (e) => this.edgeRoots[e]) }, faceAttrs: this.faceAttrs, from: this, faces: this.stated }));
  }

  /**
   * Points along the material's chains, evenly by arc length, without
   * touching the material — Blender's curve-to-points. Where `t.sample`
   * turns a shape into even vertices and `resample` rebuilds a chain
   * evenly, `along` reads even places off it: for stamping shapes along a
   * curve, dashes, labels, or anything placed by position and direction.
   *
   * The answer is a material of points and no edges. Each point has the
   * columns `s` (arc length from its chain's start), `u` (the fraction of
   * the chain's length) and `heading` (radians), and so the derived
   * `tangent`, `normal` and `placement()`; and the chain's own columns: a
   * point column by its transfer policy (`transfer` overrides one per call,
   * as in `resample`), an edge column by its policy — `'copy'` is the edge
   * under the point, `'distribute'` the sum over the run of chain nearer
   * this point than its neighbours, so the shares add up to the chain's
   * total. A point column and an edge column of one name are refused.
   *
   * The same sampling rules as `resample`: one of `count` or `spacing`, or
   * neither for a point at every vertex, in walk order (the chain's own
   * corners, as `t.material` keeps them); open chains include both ends,
   * closed chains start at the seam and never repeat it; every chain is
   * walked on its own, in `curves` order; isolated vertices give nothing.
   * On a network a chain runs from junction to junction, so a junction
   * ends every chain that meets it and gives one point for each, facing
   * along that chain. In a curved space (`space`) a point sits on the
   * geodesic between two vertices, and its heading is the direction the
   * space's `log` gives toward the next vertex — the frame a placement's
   * `step` walks in.
   */
  along(opts: { spacing?: number; count?: number; transfer?: Record<string, Transfer> } = {}): Material {
    return alongMaterial(this, opts, null);
  }

  // ---- same-world transforms ----
  //
  // A method stays in its world: each of these takes this material and
  // gives back a material. They were free functions for no reason but
  // history, and the kernel of each still lives in its own file.

  /**
   * This material through an ISOMETRY of the space: the same curves, moved.
   * A transform record — `{ translate, rotate, scale, origin }`, one of
   * `t.symmetry(…)` — moves it with exactly `group`'s meaning instead (see
   * `transformByRecord`); the rest of this is about a placement.
   *
   * An edge is the image of the flat edge between its two coordinates, and
   * an isometry carries a geodesic onto a geodesic but NOT a coordinate
   * segment onto a coordinate segment: in a curved space the moved chord
   * between two moved vertices is not the moved edge. So the image of an
   * edge is the image of its SOURCE curve, sampled where it lands: each
   * edge is halved in its own parameter while the moved chord bows more
   * than the door's `bow` — the space distance between the chord's middle
   * and the moved source curve's middle, in the metric no placement can
   * change — down to `TRANSFORM_DEPTH` halvings. A door with no bow (a
   * space built with no paper) judges instead how far the moved middle
   * strays from the chord in sketch units, to `TRANSFORM_TOL`. The chord is
   * read as the ink reads it — a sphere's x the short way round, a pole
   * point on its neighbour's meridian. The flat plane's isometries carry segments onto
   * segments, so a flat placement moves the vertices and nothing more.
   *
   * IDENTITY. Every source vertex keeps its row and its id. An edge that
   * needs no sample keeps its row, id and root. An edge that does is
   * RETIRED: its children replace it in place, each a new id with the
   * parent's lineage root, and the samples between them are new vertices
   * after the source rows. A point column is read at a sample by its
   * transfer policy, an edge column is copied to each child — a
   * `'distribute'` one shared by the child's share of the parameter — and
   * face columns, keyed by lineage, carry. So a selection of the source names every
   * vertex and every unsplit edge, and a face keeps its columns.
   */
  transform(op: Placement | TransformRecord): Material {
    if (!isPlacement(op)) {
      if (typeof op !== 'object' || op === null) {
        throw new Error('m.transform: expected a placement — t.placement(…), p.placement(), one of a tiling\'s placements, or reflection(space.model, a, b) — or a transform record such as one of t.symmetry(…)');
      }
      return transformByRecord(this, op);
    }
    const placement = op;
    const door = placement.door;
    if (door.sign === 0) return mapPositions(this, (p) => placement.point([p.x, p.y]), 'm.transform');
    const move = (x: number, y: number): Vec => placement.point([x, y]);
    // A sphere's coordinates name a point more than once, so the chord is
    // named the way the ink names it: the far end the short way round, a
    // pole end on the other end's meridian.
    const chord = chordNamer(door);
    const bow = door.bow;
    /** Does the moved curve, through `m`, stand off the chord `a → b`? */
    let bends: (a: Vec, b: Vec, m: Vec) => boolean;
    if (bow !== undefined) {
      // In the metric: the space distance between the chord's middle and
      // the curve's, in sketch units.
      const middle = chordMiddle(door);
      const gap = metricGap(door);
      bends = (a, b, m) => gap(middle(a, b), m) > bow;
    } else {
      // In sketch units: how far `m`, named from the chord's start, stands
      // from the chord itself.
      bends = (a, b, m) => {
        const [u, v] = chord(a, b);
        const w = chord(u, m)[1];
        const dx = v[0] - u[0];
        const dy = v[1] - u[1];
        const len2 = dx * dx + dy * dy;
        const s = len2 > 0 ? Math.max(0, Math.min(1, ((w[0] - u[0]) * dx + (w[1] - u[1]) * dy) / len2)) : 0;
        return Math.hypot(w[0] - (u[0] + dx * s), w[1] - (u[1] + dy * s)) > TRANSFORM_TOL;
      };
    }
    /** An edge's SOURCE curve, as the ink reads it. */
    const source = (e: number): [Vec, Vec] => {
      const a = this.edgeList[2 * e];
      const b = this.edgeList[2 * e + 1];
      return chord([this.x[a], this.y[a]], [this.x[b], this.y[b]]);
    };
    const nx: number[] = [];
    const ny: number[] = [];
    for (let i = 0; i < this.n; i++) {
      const q = move(this.x[i], this.y[i]);
      if (!Number.isFinite(q[0]) || !Number.isFinite(q[1])) throw new Error(`m.transform: vertex ${i} moves to [${q[0]}, ${q[1]}], which is not a point`);
      nx.push(q[0]);
      ny.push(q[1]);
    }
    // The parameters inside each edge where the moved curve needs a sample.
    const cuts: number[][] = [];
    let split = false;
    // An isometry carries a geodesic onto a geodesic: a geodesic edge is its
    // two moved ends, and nothing is sampled.
    const geodesic = geodesicEdges(this);
    for (let e = 0; e < this.edgeCount; e++) {
      if (geodesic?.(e)) {
        cuts.push([]);
        continue;
      }
      const [p0, p1] = source(e);
      const at = (t: number): Vec => move(p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t);
      const ts: number[] = [];
      const halve = (t0: number, t1: number, p0: Vec, p1: Vec, depth: number): void => {
        const tm = (t0 + t1) / 2;
        const pm = at(tm);
        if (depth >= TRANSFORM_DEPTH || !Number.isFinite(pm[0]) || !Number.isFinite(pm[1]) || !bends(p0, p1, pm)) return;
        halve(t0, tm, p0, pm, depth + 1);
        ts.push(tm);
        halve(tm, t1, pm, p1, depth + 1);
      };
      halve(0, 1, at(0), at(1), 0);
      cuts.push(ts);
      if (ts.length > 0) split = true;
    }
    if (!split) {
      const s = this.store;
      return carryLinks(this, new Material(Float64Array.from(nx), Float64Array.from(ny), s.attrs, s.edgeList, { iteration: this.iteration, history: [], edgeAttrs: s.edgeAttrs, transfers: { ...this.transfers }, edgeTransfers: { ...this.edgeTransfers }, ids: { points: s.pointIds, edges: s.edgeIds, edgeRoots: s.edgeRoots }, faceAttrs: this.faceAttrs, from: this, faces: this.stated }));
    }
    const names = this.attrNames;
    const enames = this.edgeAttrNames;
    const oattrs: Record<string, number[]> = {};
    for (const name of names) oattrs[name] = Array.from(this.attrs[name]);
    const eattrs: Record<string, number[]> = {};
    for (const name of enames) eattrs[name] = [];
    const pointIds = Array.from(this.pointIds);
    const edges: number[] = [];
    const edgeIds: number[] = [];
    const edgeRoots: number[] = [];
    const freshPoints = mintIds(cuts.reduce((k, ts) => k + ts.length, 0));
    const freshEdges = mintIds(cuts.reduce((k, ts) => k + (ts.length > 0 ? ts.length + 1 : 0), 0));
    let fp = 0;
    let fe = 0;
    const columnValue = (name: string, i: number, j: number, t: number): number => {
      const va = this.attrs[name][i];
      const vb = this.attrs[name][j];
      return this.transfers[name] === 'nearest' ? (t <= 0.5 ? va : vb) : va + (vb - va) * t;
    };
    for (let e = 0; e < this.edgeCount; e++) {
      const a = this.edgeList[2 * e];
      const b = this.edgeList[2 * e + 1];
      const ts = cuts[e];
      if (ts.length === 0) {
        edges.push(a, b);
        edgeIds.push(this.edgeIds[e]);
        edgeRoots.push(this.edgeRoots[e]);
        for (const name of enames) eattrs[name].push(this.edgeAttrs[name][e]);
        continue;
      }
      const [p0, p1] = source(e);
      const rows = [a];
      for (const t of ts) {
        const q = move(p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t);
        rows.push(nx.length);
        nx.push(q[0]);
        ny.push(q[1]);
        pointIds.push(freshPoints[fp++]);
        for (const name of names) oattrs[name].push(columnValue(name, a, b, t));
      }
      rows.push(b);
      const params = [0, ...ts, 1];
      for (let k = 0; k + 1 < rows.length; k++) {
        edges.push(rows[k], rows[k + 1]);
        edgeIds.push(freshEdges[fe++]);
        edgeRoots.push(this.edgeRoots[e]);
        const share = params[k + 1] - params[k];
        for (const name of enames) {
          const v = this.edgeAttrs[name][e];
          eattrs[name].push(this.edgeTransfers[name] === 'distribute' ? v * share : v);
        }
      }
    }
    const attrs: Record<string, Float64Array> = {};
    for (const name of names) attrs[name] = Float64Array.from(oattrs[name]);
    const edgeAttrs: Record<string, Float64Array> = {};
    for (const name of enames) edgeAttrs[name] = Float64Array.from(eattrs[name]);
    return carryLinks(this, new Material(Float64Array.from(nx), Float64Array.from(ny), attrs, Uint32Array.from(edges), {
      iteration: this.iteration, history: [], edgeAttrs, transfers: { ...this.transfers }, edgeTransfers: { ...this.edgeTransfers },
      ids: { points: Float64Array.from(pointIds), edges: Float64Array.from(edgeIds), edgeRoots: Float64Array.from(edgeRoots) },
      faceAttrs: this.faceAttrs,
      faces: this.stated,
      from: this,
    }));
  }

  /**
   * Every vertex scaled about `origin`: `m.scale(0.5, { origin: 'center' })`.
   *
   * `k` is one factor or `[kx, ky]`. The pivot is `origin` — a pair or an
   * `{x, y}` record in this material's own coordinates — and the user
   * origin `[0, 0]` when it is unset, as `group` reads it. `'center'` is
   * the centre of this material's own bounds: a material has no frame, so
   * it cannot mean the drawable's middle. `'centroid'` is the area centroid
   * of its closed contours — area-weighted, a contour inside an odd number
   * of others a hole, as `polygon` fills them — and the mean of its points
   * when it has no area. A zero factor puts every vertex
   * on the pivot. The same words as `group({ scale, rotate, translate })`,
   * and like them a deformation of the coordinates, not a placement:
   * `transform` is the word for an isometry. It is `map` underneath, so
   * every id and every column carries.
   */
  scale(k: number | readonly [number, number], opts: { origin?: Origin } = {}): Material {
    const [kx, ky] = typeof k === 'number' ? [k, k] : [k[0], k[1]];
    if (!Number.isFinite(kx) || !Number.isFinite(ky)) throw new Error(`m.scale: [${kx}, ${ky}] is not a scale factor`);
    const [ox, oy] = this.pivot('m.scale', opts.origin);
    return mapPositions(this, (p) => [ox + (p.x - ox) * kx, oy + (p.y - oy) * ky], 'm.scale');
  }

  /**
   * Every vertex rotated about `origin` by `degrees`, counter-clockwise, as
   * `turn` and a group's `rotate` read them. The pivot is the one `scale`
   * reads. It is `map` underneath, so every id and every column carries.
   */
  rotate(degrees: number, opts: { origin?: Origin } = {}): Material {
    if (!Number.isFinite(degrees)) throw new Error(`m.rotate: ${degrees} is not an angle`);
    const [ox, oy] = this.pivot('m.rotate', opts.origin);
    const a = radians(degrees);
    const c = Math.cos(a);
    const s = Math.sin(a);
    return mapPositions(this, (p) => {
      const dx = p.x - ox;
      const dy = p.y - oy;
      return [ox + c * dx - s * dy, oy + s * dx + c * dy];
    }, 'm.rotate');
  }

  /** Every vertex moved by `by`. It is `map` underneath, so every id and
   * every column carries. */
  translate(by: XY): Material {
    const dx = vx(by);
    const dy = vy(by);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new Error(`m.translate: [${dx}, ${dy}] is not an offset`);
    return mapPositions(this, (p) => [p.x + dx, p.y + dy], 'm.translate');
  }

  /** @internal The pivot `scale` and `rotate` read: the user origin when
   * unset, `'center'` this material's bounds centre, `'centroid'` its area
   * centroid (see `scale`). An empty material pivots on the origin. */
  pivot(verb: string, origin: Origin | undefined): Vec {
    if (origin === undefined) return [0, 0];
    if (origin === 'center' || origin === 'centroid') {
      if (this.n === 0) return [0, 0];
      if (origin === 'centroid') {
        const c = areaCentroid(this.contours());
        if (c) return c;
        let mx = 0, my = 0;
        for (let i = 0; i < this.n; i++) { mx += this.x[i]; my += this.y[i]; }
        return [mx / this.n, my / this.n];
      }
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < this.n; i++) {
        x0 = Math.min(x0, this.x[i]); x1 = Math.max(x1, this.x[i]);
        y0 = Math.min(y0, this.y[i]); y1 = Math.max(y1, this.y[i]);
      }
      return [(x0 + x1) / 2, (y0 + y1) / 2];
    }
    if (typeof origin === 'string') throw new Error(`${verb}: origin is a point ([x, y] or { x, y }), 'center' or 'centroid' — got '${origin}'`);
    const x = vx(origin);
    const y = vy(origin);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`${verb}: origin [${x}, ${y}] is not a point`);
    return [x, y];
  }

  /** Thickness around this material's chains: an outline at the radius each
   * vertex asks for. See `ThickenOpts`. */
  thicken(opts: ThickenOpts): Material {
    // Pure, as `planarize` is: a radius or a `point` callback leaves the
    // call unkeyed.
    return memoMethod(this, 'thicken', [opts], () => thickenKernel(this, opts));
  }

  /** This material through a moved cage: corner for corner, the space in
   * between follows. See `WarpOpts`. */
  warp(opts: WarpOpts): Material {
    return warpKernel(this, opts);
  }

  /** Swing this material's chains, at a wavelength and amplitude read in its
   * own units. See `OscillateOpts`. */
  oscillate(opts: OscillateOpts): Material {
    return oscillateKernel(this, opts);
  }

  /** The outline this material's chains sweep: their envelope. */
  envelope(): Material {
    return envelopeKernel(this);
  }

  /** Over and under at every crossing: the chains are cut where they pass
   * beneath, by `{ gap }` in this material's own coordinates. */
  interlace(opts: InterlaceOpts): Material {
    return interlaceKernel(this, opts);
  }

  /** One pen-down per pass: a junction is split into one degree-2 vertex per
   * passing pair, so the chain walk sails through and no edge is drawn
   * twice. The ink is exactly where it was; the result is a drawing, and
   * `faces` will rightly refuse it. */
  trails(opts: TrailsOpts = {}): Material {
    return makeTrails(this, opts);
  }

  // ---- recipes over the table writes (see tables.ts) ----

  /**
   * A new point at `from` plus `offset`, joined to `from` by a new edge:
   * add a point row, add an edge row. The offset is a step from the point,
   * so in a curved space it walks the geodesic. `cols` are the new point's
   * columns — every declared one. `from` is a point value or a view. Given
   * nothing (an empty pick) or a point that is gone, it returns this
   * material. To name the new point later, write the two writes with a
   * point value: `g.points.add(q).edges.add([from, q])`.
   */
  extrude(from: PointEnd | undefined, offset: XY, cols?: Record<string, number>): Material {
    return extrudeRecipe(this, from, offset, cols);
  }

  /**
   * Each edge cut at `at` of the way along it (a → b as stored), default
   * the middle: add the point, remove the edge, add the two edges through
   * the point. Point columns cross by their transfer policy; the two new
   * edges keep the parent's lineage root and take its columns, a
   * `'distribute'` one by each part's share. `at` may be a function of the
   * edge; one that is not finite skips that edge, and one outside 0…1 is
   * read as the nearer end, where a cut makes nothing. `edges` is a
   * selection, an edge value or an edge view.
   */
  split(edges: Selection<Edge> | EdgeEnd | undefined, at?: number | ((e: Edge) => number)): Material {
    return splitRecipe(this, edges, at);
  }

  /**
   * Every point moved by the SUM of the displacements, in one instant:
   * each is read on this state. A displacement is a vector, a function of
   * the point `(p) => [dx, dy]`, or a force made without its state —
   * `force.tension({ rest })` — which the move prepares from this material
   * once. A last argument that is a point selection, a point value or a
   * vertex says which points move. A move that is not finite leaves that
   * point where it is; in a curved space a point walks the geodesic. To
   * put a point at a position rather than move it by a step, set its `x`
   * and `y`: `g.points.set({ x: …, y: … })`.
   */
  move(...args: [...Displacement[]] | [...Displacement[], Selection<Vertex> | PointEnd | undefined]): Material {
    return moveRecipe(this, args);
  }

  /**
   * Every edge of `edges` swapped for a motif: the edge goes, and the
   * motif's one open chain takes its place between the same two points,
   * scaled and turned to the edge. Point columns cross by their transfer
   * policy and edge columns are shared as a split's children share them. A
   * motif point that lands on a point already there — a corner, or the tip
   * another edge's motif put in the same place — IS that point, so motifs
   * that meet share a vertex. `flip` mirrors the motif across the edge, for
   * every edge or for those a test of the edge picks. A Koch curve is one
   * motif and four steps: `t.steps(4, tri, (g) => g.replace(g.edges, motif))`.
   */
  replace(edges: Selection<Edge> | EdgeEnd | undefined, motif: Material, opts?: ReplaceOpts): Material {
    return replaceRecipe(this, edges, motif, opts);
  }

  /** @internal This material with the states a `t.steps` run kept: what
   * the run returns when it is asked for `{ every }`. */
  withHistory(states: readonly Material[]): Material {
    return restamp(this, this.iteration, states);
  }
}

/** A derivation's input as the sketch passed it: the value a source row is
 * a row of, and the row there of each edge of the material worked on
 * (null: the same rows). A selection's `resample` and `along` work on its
 * rows pulled out, and answer rows of the selection's own material. */
export interface InputRows {
  readonly of: Material;
  readonly edges: ArrayLike<number> | null;
}

/** @internal `m.resample(opts)`; see the method. Every point it places on a
 * chain answers `u`, its arc-length fraction along the chain, and
 * `source`, the input edge under it; a new edge's `source` is the input
 * edge under its middle. */
export function resampleMaterial(self: Material, opts: { spacing?: number; count?: number; transfer?: Record<string, Transfer>; where?: Where }, origin: InputRows | null): Material {
  // Too small to place samples (a mid-edit zero spacing): nothing to build.
  if (!checkSampling('resample', opts)) return new Material(new Float64Array(0), new Float64Array(0), {}, new Uint32Array(0), { from: self });
  // Lengths are the material's own space's: a material the toolkit made
  // carries the sketch's, and a pure `material(points)` is flat numbers.
  const space = self.space;
  const curved = space !== undefined && space.kind !== 'euclidean' ? space : null;
  const sampling = { count: opts.count, spacing: opts.spacing, space };
  // A network pins its chains' ends: a junction is one vertex that several
  // chains share, so each chain is redistributed between its two ends as a
  // `where` run is, and the ends keep their rows and their ids.
  const network = hasJunction(self);
  // The eligible region is a set of EDGES: a redistribution is about the
  // stretch between two vertices, not about the vertices.
  const eligible = whereRows(self, opts.where, 'edges', 'resample');
  const names = self.attrNames;
  const transfer: Record<string, Transfer> = { ...self.transfers, ...(opts.transfer ?? {}) };
  const ox: number[] = [];
  const oy: number[] = [];
  const oattrs: Record<string, number[]> = {};
  for (const name of names) oattrs[name] = [];
  const edges: number[] = [];
  const enames = self.edgeAttrNames;
  const eattrs: Record<string, number[]> = {};
  for (const name of enames) eattrs[name] = [];
  // Where each output row came from, for identity: a source row, or -1 for
  // something this call made. Only `where` reads them — a whole resample
  // rebuilds the material and mints as it always has.
  const osrc: number[] = [];
  const esrc: number[] = [];
  const eroot: number[] = [];
  const storedRow = new Map<number, number>();
  for (let e = 0; e < self.edgeCount; e++) storedRow.set(pairKey(self.edgeList[2 * e], self.edgeList[2 * e + 1]), e);
  // What each output row answers (derivation.ts): the input edge under it
  // (-1: none) and its fraction along its chain, one entry a row, set once,
  // by the first chain that places the row. A row no chain placed says
  // nothing.
  const underRow: number[] = [];
  const uRow: number[] = [];
  const note = (row: number, edge: number, u: number) => {
    if (underRow[row] >= 0) return;
    underRow[row] = edge;
    uRow[row] = u;
  };
  const place = (a: number, b: number, t: number, src = -1) => {
    if (curved) {
      const g = curved.geodesic([self.x[a], self.y[a]], [self.x[b], self.y[b]], t);
      ox.push(g[0]);
      oy.push(g[1]);
    } else {
      ox.push(self.x[a] + (self.x[b] - self.x[a]) * t);
      oy.push(self.y[a] + (self.y[b] - self.y[a]) * t);
    }
    osrc.push(src);
    underRow.push(-1);
    uRow.push(NaN);
    for (const name of names) {
      const rule = transfer[name] ?? 'interpolate';
      const va = self.attrs[name][a];
      const vb = self.attrs[name][b];
      let v: number;
      if (rule === 'interpolate') v = va + (vb - va) * t;
      else if (rule === 'nearest') v = t <= 0.5 ? va : vb; // ties to the start vertex
      else if (typeof rule === 'number') v = rule;
      else v = rule(readVertex(self, a), readVertex(self, b), t);
      oattrs[name].push(v);
    }
  };
  // One piece of a chain, as its own little walk: `rows` are the material
  // rows it runs through, in order. A whole chain is one piece; with
  // `where`, a run of eligible edges is one.
  const piece = (rows: readonly number[], closed: boolean) => {
    const pts = rows.map((i) => [self.x[i], self.y[i]] as [number, number]);
    const cum = chainLengths(pts, closed, space);
    const total = cum[cum.length - 1];
    const rowOfSeg = (s: number) => storedRow.get(pairKey(rows[s], rows[(s + 1) % rows.length]))!;
    // Samples come in increasing arc length, so the segment under a
    // position is found from where the last one was, never from the start.
    let cursor = 0;
    let spread = 0; // the distribute loop's own cursor: d0 never decreases within a piece
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
      esrc.push(-1);
      eroot.push(mid);
      for (const name of enames) {
        if (self.edgeTransfers[name] !== 'distribute') {
          eattrs[name].push(self.edgeAttrs[name][mid]);
          continue;
        }
        let sum = 0;
        if (cum[spread] > d0) spread = 0; // a closed chain's seam wraps once
        while (spread < cum.length - 2 && cum[spread + 1] <= d0) spread++; // the first segment the range touches
        for (let s = spread; s + 1 < cum.length && cum[s] < d1; s++) {
          const len = cum[s + 1] - cum[s];
          if (len <= 0) continue;
          const overlap = Math.min(d1, cum[s + 1]) - Math.max(d0, cum[s]);
          if (overlap > 0) sum += self.edgeAttrs[name][rowOfSeg(s)] * (overlap / len);
        }
        eattrs[name].push(sum);
      }
    };
    const at = (samples: { seg: number; t: number }[], k: number) =>
      cum[samples[k].seg] + samples[k].t * (cum[samples[k].seg + 1] - cum[samples[k].seg]);
    return { pts, total, link, at, rowOfSeg };
  };
  // A vertex this call does not touch: verbatim, not through `transfer`.
  // A transfer rule says what a value does at a NEW vertex, and this is
  // not one.
  const keepsIds = eligible !== null || network;
  const copy = (v: number) => {
    ox.push(self.x[v]);
    oy.push(self.y[v]);
    osrc.push(keepsIds ? v : -1);
    underRow.push(-1);
    uRow.push(NaN);
    for (const name of names) oattrs[name].push(self.attrs[name][v]);
  };
  // Isolated vertices are not chains: they come through unchanged.
  for (let i = 0; i < self.n; i++) if (self.adjacentRows(i).length === 0) copy(i);
  // A whole piece, redistributed: the path a resample without `where` takes
  // for every chain, and the one a fully eligible ring takes too.
  const whole = (rows: readonly number[], closed: boolean) => {
    const first = ox.length;
    const p = piece(rows, closed);
    const samples = alongChain(p.pts, closed, sampling);
    // `alongChain` places sample k at arc length total·k/gaps: its
    // fraction of the chain is k/gaps exactly, as `t.sample` counts it.
    const gaps = closed ? samples.length : samples.length - 1;
    for (let k = 0; k < samples.length; k++) {
      place(rows[samples[k].seg], rows[(samples[k].seg + 1) % rows.length], samples[k].t);
      note(first + k, p.rowOfSeg(samples[k].seg), gaps > 0 ? k / gaps : 0);
      if (k > 0) p.link(first + k - 1, first + k, p.at(samples, k - 1), p.at(samples, k));
    }
    if (closed && samples.length > 1) p.link(first + samples.length - 1, first, p.at(samples, samples.length - 1), p.total);
  };
  // An output row per source vertex, made the first time the walk needs
  // it, so a vertex two pieces share is one row and the ring closes — and
  // a junction several chains share is one row too.
  const rowOf = new Map<number, number>();
  for (const c of chainsOf(self)) {
    // A chain on a network ends at its junctions and keeps them: it is
    // walked as an open piece, a loop back to its own junction included.
    const pinned = network && (!c.closed || self.adjacentRows(c.indices[0]).length > 2);
    const idx = pinned && c.closed ? [...c.indices, c.indices[0]] : c.indices;
    const closed = c.closed && !pinned;
    const m = idx.length;
    const rowOfSeg = (s: number) => storedRow.get(pairKey(idx[s], idx[(s + 1) % m]))!;
    if (eligible === null && !pinned) {
      whole(idx, closed);
      continue;
    }
    const segs = closed ? m : m - 1;
    const on = (s: number) => eligible === null || eligible.has(rowOfSeg(s));
    // A run's samples measured along the whole chain, for `u`: the chain's
    // own lengths, walked the first time a run asks.
    let chainCum: number[] | null = null;
    const fraction = (s0: number, d: number): number => {
      chainCum ??= chainLengths(idx.map((i) => [self.x[i], self.y[i]] as [number, number]), closed, space);
      const total = chainCum[segs];
      if (!(total > 0)) return 0;
      const pos = chainCum[s0 % segs] + d;
      return (pos > total ? pos - total : pos) / total;
    };
    let count = 0;
    for (let s = 0; s < segs; s++) if (on(s)) count++;
    if (count === segs && !pinned) {
      whole(idx, closed);
      continue;
    }
    const rowFor = (v: number) => {
      const had = rowOf.get(v);
      if (had !== undefined) return had;
      copy(v);
      rowOf.set(v, ox.length - 1);
      return ox.length - 1;
    };
    const keep = (s: number) => {
      const a = rowFor(idx[s]);
      const b = rowFor(idx[(s + 1) % m]);
      const row = rowOfSeg(s);
      edges.push(a, b);
      esrc.push(row);
      eroot.push(row);
      for (const name of enames) eattrs[name].push(self.edgeAttrs[name][row]);
    };
    // A run of eligible edges, redistributed as an OPEN piece: the two
    // vertices at its ends are the run's own first and last samples, so
    // they stay exactly where they are and keep who they are.
    const run = (s0: number, s1: number) => {
      const rows: number[] = [];
      for (let s = s0; s <= s1; s++) rows.push(idx[s % m]);
      rows.push(idx[(s1 + 1) % m]);
      const p = piece(rows, false);
      const samples = alongChain(p.pts, false, sampling);
      // No length to share out, so there is nothing to redistribute: the
      // run comes through as the edges it already was.
      if (samples.length < 2) {
        for (let s = s0; s <= s1; s++) keep(s % m);
        return;
      }
      const last = samples.length - 1;
      const out: number[] = [];
      for (let k = 0; k <= last; k++) {
        if (k === 0) out.push(rowFor(rows[0]));
        else if (k === last) out.push(rowFor(rows[rows.length - 1]));
        else {
          place(rows[samples[k].seg], rows[samples[k].seg + 1], samples[k].t);
          out.push(ox.length - 1);
        }
        note(out[k], p.rowOfSeg(samples[k].seg), fraction(s0, p.at(samples, k)));
        if (k > 0) p.link(out[k - 1], out[k], p.at(samples, k - 1), p.at(samples, k));
      }
    };
    // A closed chain is walked from a boundary between two pieces, so the
    // ring closes on a vertex both of them own. An open one starts at its
    // own first vertex.
    let start = 0;
    if (closed) {
      for (let s = 0; s < segs; s++) {
        if (on(s) !== on((s + segs - 1) % segs)) {
          start = s;
          break;
        }
      }
    }
    let s = 0;
    while (s < segs) {
      const kind = on((start + s) % segs);
      let len = 1;
      while (s + len < segs && on((start + s + len) % segs) === kind) len++;
      if (kind) run(start + s, start + s + len - 1);
      else for (let k = 0; k < len; k++) keep((start + s + k) % segs);
      s += len;
    }
  }
  const attrs: Record<string, Float64Array> = {};
  for (const name of names) attrs[name] = Float64Array.from(oattrs[name]);
  const edgeAttrs: Record<string, Float64Array> = {};
  for (const name of enames) edgeAttrs[name] = Float64Array.from(eattrs[name]);
  const base = { iteration: self.iteration, history: [], edgeAttrs: edgeAttrs, transfers: { ...self.transfers }, edgeTransfers: { ...self.edgeTransfers }, from: self };
  // The links, in the rows of the value the sketch passed: a point to the
  // edge under it, a new edge to the edge under its middle (a kept edge is
  // the edge it was, and says nothing new).
  const of = origin?.of ?? self;
  const map = origin?.edges ?? null;
  // The row lists are adopted as they are (linkRows copies nothing).
  const pointRows = map === null ? underRow : underRow.map((e) => (e < 0 ? -1 : map[e]));
  const pointU = uRow;
  const edgeRows = new Int32Array(esrc.length);
  for (let k = 0; k < esrc.length; k++) {
    const e = eroot[k];
    edgeRows[k] = esrc[k] >= 0 || e < 0 ? -1 : map === null ? e : map[e];
  }
  const linked = (out: Material): Material => record(linkRows(out, {
    points: { source: { of, domain: 'edges', rows: pointRows }, params: { u: pointU } },
    edges: { source: { of, domain: 'edges', rows: edgeRows } },
  }), derivation('resample', [of], { ...opts }));
  // Every row new: nothing the input's rows answered is this value's.
  if (!keepsIds) return linked(new Material(Float64Array.from(ox), Float64Array.from(oy), attrs, Uint32Array.from(edges), base));
  // A row that came through untouched keeps what it had. A new vertex is
  // minted, and a new edge takes the lineage root of the source edge under
  // its middle — the way a split's children take their parent's, so the
  // face columns keyed on those roots still find their cells.
  const freshPoints = mintIds(osrc.reduce((k, v) => k + (v < 0 ? 1 : 0), 0));
  const freshEdges = mintIds(esrc.reduce((k, v) => k + (v < 0 ? 1 : 0), 0));
  let fp = 0;
  let fe = 0;
  const pointIds = Float64Array.from(osrc, (v) => (v < 0 ? freshPoints[fp++] : self.pointIds[v]));
  const edgeIds = Float64Array.from(esrc, (v) => (v < 0 ? freshEdges[fe++] : self.edgeIds[v]));
  const edgeRoots = Float64Array.from(esrc, (v, k) => (v >= 0 ? self.edgeRoots[v] : eroot[k] >= 0 ? self.edgeRoots[eroot[k]] : edgeIds[k]));
  return linked(carryLinks(self, new Material(Float64Array.from(ox), Float64Array.from(oy), attrs, Uint32Array.from(edges), { ...base, ids: { points: pointIds, edges: edgeIds, edgeRoots }, faceAttrs: self.faceAttrs, faces: self.stated })));
}

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
 * @internal A place on a chain, read off it by arc length: the kernel record
 * `along` reads its points from, and the chain verbs (`oscillate`) walk.
 * Position, the unit tangent of the polyline under it (on a vertex, the
 * bisector of the segments that meet there), the normal (`perp`), the
 * heading, arc length `s` from the chain's start, its fraction `u`, the
 * chain's whole `length`, the chain (a row of `curves`), and the columns
 * by their policies: point columns in `attrs`, edge columns in `edgeAttrs`.
 */
export interface ChainSample {
  x: number;
  y: number;
  tangent: [number, number];
  normal: [number, number];
  heading: number;
  s: number;
  u: number;
  length: number;
  chain: number;
  closed: boolean;
  /** The edge row the sample lies on: the segment it was placed on. */
  edge: number;
  attrs: Record<string, number>;
  edgeAttrs: Record<string, number>;
  /** The source's point-column policies. */
  transfers?: Readonly<Record<string, TransferPolicy>>;
  /** The space the chain was walked in; absent is the flat plane. */
  space?: Space;
}

export function alongSamples(m: Material, opts: { spacing?: number; count?: number; transfer?: Record<string, Transfer> } = {}): ChainSample[] {
  const atVertices = opts.spacing === undefined && opts.count === undefined;
  // A curved material is walked in its own geometry.
  const space = m.space;
  const curved = space !== undefined && space.kind !== 'euclidean' ? space : null;
  if (!atVertices && !checkSampling('along', opts)) return [];
  const names = m.attrNames;
  const sampleTransfers = Object.freeze({ ...m.transfers });
  const transfer: Record<string, Transfer> = { ...m.transfers, ...(opts.transfer ?? {}) };
  const enames = m.edgeAttrNames;
  const storedRow = new Map<number, number>();
  for (let e = 0; e < m.edgeCount; e++) storedRow.set(pairKey(m.edgeList[2 * e], m.edgeList[2 * e + 1]), e);
  const out: ChainSample[] = [];
  chainsOf(m).forEach((c, chain) => {
    const idx = c.indices;
    const pts = idx.map((i) => [m.x[i], m.y[i]] as [number, number]);
    const segs = c.closed ? idx.length : idx.length - 1;
    // No sampling option: the chain's own vertices, in walk order.
    const samples = atVertices
      ? idx.map((_, k) => (k < segs ? { seg: k, t: 0 } : { seg: segs - 1, t: 1 }))
      : alongChain(pts, c.closed, { count: opts.count, spacing: opts.spacing, space });
    const cum = chainLengths(pts, c.closed, space);
    const total = cum[segs];
    const rowOfSeg = (sg: number) => storedRow.get(pairKey(idx[sg], idx[(sg + 1) % idx.length]))!;
    const at = (k: number) => cum[samples[k].seg] + samples[k].t * (cum[samples[k].seg + 1] - cum[samples[k].seg]);
    // The tangent at a vertex is the bisector of the segments meeting
    // there (an open chain's end has one); elsewhere the segment's own. In
    // a curved space it is the direction `log` answers at the place.
    const frames = chainTangents(pts, c.closed, space);
    // The share of chain a sample owns for 'distribute' columns: from
    // half way to the previous sample to half way to the next; the ends
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
          if (overlap > 0) sum += m.edgeAttrs[name][rowOfSeg(sg)] * (overlap / len);
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
      const at2 = curved ? curved.geodesic(pts[seg], pts[(seg + 1) % idx.length], t) : null;
      const tangent = frames.at(seg, t, at2 ? [at2[0], at2[1]] : null);
      const attrs: Record<string, number> = {};
      for (const name of names) {
        const rule = transfer[name] ?? 'interpolate';
        const va = m.attrs[name][a];
        const vb = m.attrs[name][b];
        if (rule === 'interpolate') attrs[name] = va + (vb - va) * t;
        else if (rule === 'nearest') attrs[name] = t <= 0.5 ? va : vb;
        else if (typeof rule === 'number') attrs[name] = rule;
        else attrs[name] = rule(readVertex(m, a), readVertex(m, b), t);
      }
      const edgeAttrs: Record<string, number> = {};
      for (const name of enames) {
        if (m.edgeTransfers[name] === 'distribute') {
          const [d0, d1] = owned(k);
          edgeAttrs[name] = shareOver(name, d0, d1);
        } else {
          edgeAttrs[name] = m.edgeAttrs[name][rowOfSeg(onVertexAhead ? seg + 1 : seg)];
        }
      }
      const sAt = at(k);
      const st: ChainSample = {
        x: at2 ? at2[0] : pts[seg][0] + (pts[(seg + 1) % idx.length][0] - pts[seg][0]) * t,
        y: at2 ? at2[1] : pts[seg][1] + (pts[(seg + 1) % idx.length][1] - pts[seg][1]) * t,
        tangent,
        normal: perp(tangent) as [number, number],
        heading: Math.atan2(tangent[1], tangent[0]),
        s: sAt,
        u: total > 0 ? sAt / total : 0,
        length: total,
        chain,
        closed: c.closed,
        edge: rowOfSeg(seg),
        attrs,
        edgeAttrs,
        transfers: sampleTransfers,
        space,
      };
      out.push(st);
    });
  });
  return out;
}

/** @internal `m.along(opts)`; see the method. Every point answers
 * `source`, the input edge it lies on, in the rows of `origin` (a
 * selection's material) or of `m`. */
export function alongMaterial(m: Material, opts: { spacing?: number; count?: number; transfer?: Record<string, Transfer> }, origin: InputRows | null): Material {
  const samples = alongSamples(m, opts);
  const out = samplesMaterial(samples, m);
  const of = origin?.of ?? m;
  const rows = Int32Array.from(samples, (q) => (origin?.edges ? origin.edges[q.edge] : q.edge));
  return record(linkRows(out, { points: { source: { of, domain: 'edges', rows } } }), derivation('along', [of], { ...opts }));
}

/** The points `along` answers: a row per sample, the columns `s`, `u` and
 * `heading`, and the transferred point and edge columns. No edges. */
function samplesMaterial(samples: readonly ChainSample[], source: Material): Material {
  const pointNames = source.attrNames;
  for (const name of source.edgeAttrNames) {
    if (pointNames.includes(name)) throw new Error(`m.along: '${name}' is both a point column and an edge column, and a point of along() has one column of that name — rename one first`);
  }
  const n = samples.length;
  const cols: Record<string, Float64Array> = {};
  // The chain's own columns first; the place on the chain is along's own
  // and wins over a column of the same name.
  for (const name of pointNames) cols[name] = Float64Array.from(samples, (q) => q.attrs[name]);
  for (const name of source.edgeAttrNames) cols[name] = Float64Array.from(samples, (q) => q.edgeAttrs[name]);
  cols.s = Float64Array.from(samples, (q) => q.s);
  cols.u = Float64Array.from(samples, (q) => q.u);
  cols.heading = Float64Array.from(samples, (q) => q.heading);
  const transfers: Record<string, TransferPolicy> = {};
  for (const name of pointNames) if (source.transfers[name] && name !== 's' && name !== 'u' && name !== 'heading') transfers[name] = source.transfers[name];
  return new Material(Float64Array.from(samples, (q) => q.x), Float64Array.from(samples, (q) => q.y), cols, new Uint32Array(0), { transfers, from: source });
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
  opts: { count?: number; spacing?: number; space?: Space },
): { seg: number; t: number }[] {
  const n = pts.length;
  const segs = closed ? n : n - 1;
  if (n === 0) return [];
  const cum = chainLengths(pts, closed, opts.space);
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

/** True when some vertex joins three or more edges: the material is a
 * network, and a chain verb keeps its junctions where they are. */
function hasJunction(m: Material): boolean {
  for (let i = 0; i < m.n; i++) if (m.adjacentRows(i).length > 2) return true;
  return false;
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
 * @internal The same rows, with the faces a word states: every column, id
 * and policy of `m` adopted as it is (`m` is the word's own work in
 * progress, never a value a sketch holds), and `faces` over exactly its
 * edges.
 */
export function withFaces(m: Material, faces: Omit<StatedFaces, 'edgeList' | 'edgeIds'>): Material {
  const s = m.store;
  return carryLinks(m, new Material(s.x, s.y, s.attrs, s.edgeList, {
    iteration: m.iteration, history: m.history, edgeAttrs: s.edgeAttrs, transfers: { ...m.transfers }, edgeTransfers: { ...m.edgeTransfers },
    ids: { points: s.pointIds, edges: s.edgeIds, edgeRoots: s.edgeRoots },
    faceAttrs: m.faceAttrs as Record<string, FaceColumn>, from: m,
    faces: { ...faces, edgeList: s.edgeList, edgeIds: s.edgeIds },
  }));
}

/**
 * @internal The same rows, in `space`: what the toolkit hands back from
 * every word that answers a material, so a material made in a sketch knows
 * the space its coordinates belong to. Every column, id and face column is
 * carried — shared, since no material writes a column it holds — and
 * nothing moves.
 */
export function inSpace(m: Material, space: Space): Material {
  if (m.space === space) return m;
  // The rows are the same rows, so an area of their own is the same area,
  // in the same space.
  const own = m.areaBox.make !== null || m.areaBox.material !== null;
  const s = m.store;
  return carryLinks(m, new Material(s.x, s.y, s.attrs, s.edgeList, {
    iteration: m.iteration, history: m.history, edgeAttrs: s.edgeAttrs, transfers: { ...m.transfers }, edgeTransfers: { ...m.edgeTransfers },
    ids: { points: s.pointIds, edges: s.edgeIds, edgeRoots: s.edgeRoots },
    faceAttrs: m.faceAttrs, space, faces: m.stated,
    ...(own ? { area: () => inSpace(areaMaterial(m), space) } : {}),
  }));
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
 *
 * The material's own closure decides what the cut leaves. An open chain ends
 * at the boundary. A face is an area, and the part of it inside `area` is
 * closed along the cut: each piece of the boundary with one of the source's
 * `faces` just inside it becomes an edge — a piece through a cell, or a
 * piece along a wall the cut dropped — so a rim cell comes back as a face.
 * The closing edges are data: the edge column `cut` is 1 on them and 0 on
 * every other edge (an existing `cut` column is replaced; its policy is
 * copy). Only a material with faces gets the column — an open chain or a
 * point cloud keeps the columns it had, so a later `steps` or `append` is
 * not asked for a column the sketch never wanted. A closing edge ends at
 * the vertex the cut wall ends at; a boundary corner inside a face is a new
 * vertex whose point columns are the previous vertex's along the boundary,
 * and a closing edge copies the edge columns of the previous source wall (a
 * distributed column is 0: it holds no share of any source edge; `geodesic` is
 * 0: the closing edge is a piece of the boundary polyline, a coordinate
 * segment). A material whose faces
 * cannot be read — no cycle, or edges that cross — closes nothing.
 */
export function withinMaterial(
  m: Material,
  area: AreaInput,
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
  const inside = opts.inside ?? distanceField(loops);
  const crossings = opts.crossings
    ?? ((ax: number, ay: number, bx: number, by: number) => loopCrossings(loops, ax, ay, bx, by));
  const names = m.attrNames;
  const transfer: Record<string, Transfer> = { ...m.transfers, ...(opts.transfer ?? {}) };
  // `cut` is this function's answer when the source has faces: it is then
  // written fresh. Otherwise it is an ordinary column and travels as one.
  const enames = m.edgeAttrNames;
  const ox: number[] = [];
  const oy: number[] = [];
  const oattrs: Record<string, number[]> = {};
  for (const name of names) oattrs[name] = [];
  const edges: number[] = [];
  const eattrs: Record<string, number[]> = {};
  for (const name of enames) eattrs[name] = [];
  const sourceRow = new Map<number, number>();
  // A vertex the trim kept is the vertex it was, and an edge the trim did
  // not cut is the edge it was: the trim is a subtraction, not a rebuild.
  // A cut mints a new point and a new edge, and the piece keeps the edge's
  // lineage root, so a face whose wall was merely shortened keeps its
  // columns.
  const oids: number[] = [];
  const eids: number[] = [];
  const eroots: number[] = [];
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
    return rule(readVertex(m, i), readVertex(m, j), t);
  };
  const copyVertex = (i: number): number => {
    const seen = sourceRow.get(i);
    if (seen !== undefined) return seen;
    const row = ox.length;
    ox.push(m.x[i]);
    oy.push(m.y[i]);
    oids.push(m.pointIds[i]);
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
    oids.push(mintIds(1)[0]);
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
      // Whole edge: the same edge. A cut piece is a new edge of the same
      // lineage, exactly as a split's children are.
      const whole = from0.t === 0 && to1.t === 1;
      eids.push(whole ? m.edgeIds[e] : mintIds(1)[0]);
      eroots.push(m.edgeRoots[e]);
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
  const cutFlags: number[] = new Array(edges.length / 2).fill(0);

  // Closing along the boundary: the part of a face inside the area is an
  // area, so the boundary pieces that run through a face become its walls.
  const cells = readableFaces(m);
  if (cells) {
    const incident = new Int32Array(m.n).fill(-1);
    for (let e = 0; e < m.edgeCount; e++) {
      for (const v of [m.edgeList[2 * e], m.edgeList[2 * e + 1]]) if (incident[v] < 0) incident[v] = e;
    }
    const faceAt = faceLocator(cells);
    const edgeBoxes = new Float64Array(4 * m.edgeCount);
    for (let e = 0; e < m.edgeCount; e++) {
      const a = m.edgeList[2 * e];
      const b = m.edgeList[2 * e + 1];
      edgeBoxes.set([Math.min(m.x[a], m.x[b]), Math.min(m.y[a], m.y[b]), Math.max(m.x[a], m.x[b]), Math.max(m.y[a], m.y[b])], 4 * e);
    }
    const walls = boxGrid(edgeBoxes);
    const kept = new Set<number>();
    for (let k = 0; k < edges.length; k += 2) kept.add(pairKey(edges[k], edges[k + 1]));
    let magnitude = 1;
    for (const loop of loops) for (const [x, y] of loop) magnitude = Math.max(magnitude, Math.abs(x), Math.abs(y));
    // A roundoff tolerance for "on the boundary" and a side offset for "which
    // side is filled" — both far below the 0.005 mm input grid.
    const onTol = 1e-9 * magnitude;
    const side = 1e-7 * magnitude;
    for (const loop of loops) {
      const marks = boundaryMarks(m, loop, walls, incident, onTol);
      const M = marks.length;
      if (M < 2) continue;
      // Each piece runs from mark i to mark i + 1 (cyclic). It closes the
      // face that lies just inside it: the piece must be a REAL boundary
      // (filled on one side only — an interior contour under a nonzero rule
      // is no boundary), and the point a hair to its filled side must be
      // strictly inside a source face. A piece through a cell closes that
      // cell; a piece along a source wall closes the face on the inside of
      // it, because the cut dropped that wall (on the boundary is outside).
      const pieceFace = new Int32Array(M).fill(-1);
      let any = false;
      for (let i = 0; i < M; i++) {
        const a = marks[i];
        const b = marks[(i + 1) % M];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy);
        if (len === 0) continue;
        const mx = a.x + dx / 2;
        const my = a.y + dy / 2;
        const nx = (-dy / len) * side;
        const ny = (dx / len) * side;
        const left = inside(mx + nx, my + ny) > 0;
        if (left === (inside(mx - nx, my - ny) > 0)) continue;
        pieceFace[i] = left ? faceAt(mx + nx, my + ny) : faceAt(mx - nx, my - ny);
        if (pieceFace[i] >= 0) any = true;
      }
      if (!any) continue;
      // Rows, walked from a mark the source already has (a crossing or a
      // vertex) so a corner always has a previous vertex to copy.
      const start = Math.max(0, marks.findIndex((mk) => mk.kind !== 'corner'));
      const firstFace = pieceFace.find((f) => f >= 0)!;
      const fallback = cells.faces[firstFace];
      let lastValues: number[] = names.map((name) => m.attrs[name][fallback.points.indices[0]]);
      let lastEdge = fallback.boundaryEdges.indices[0];
      const rowOf = new Int32Array(M).fill(-1);
      const edgeFrom = new Int32Array(M);
      for (let s = 0; s < M; s++) {
        const i = (start + s) % M;
        const mk = marks[i];
        const used = pieceFace[i] >= 0 || pieceFace[(i + M - 1) % M] >= 0;
        if (mk.kind === 'crossing') {
          lastValues = names.map((name) => columnValue(name, mk.a, mk.b, mk.t));
          lastEdge = mk.edge;
          if (used) rowOf[i] = splitAt(mk.a, mk.b, mk.t, mk.x, mk.y);
        } else if (mk.kind === 'vertex') {
          lastValues = names.map((name) => m.attrs[name][mk.a]);
          lastEdge = mk.edge;
          if (used) rowOf[i] = copyVertex(mk.a);
        } else if (used) {
          rowOf[i] = ox.length;
          ox.push(mk.x);
          oy.push(mk.y);
          oids.push(mintIds(1)[0]);
          names.forEach((name, k) => oattrs[name].push(lastValues[k]));
        }
        edgeFrom[i] = lastEdge;
      }
      for (let i = 0; i < M; i++) {
        if (pieceFace[i] < 0 || rowOf[i] === rowOf[(i + 1) % M]) continue;
        // A wall the cut KEPT along the boundary already closes the face.
        const pair = pairKey(rowOf[i], rowOf[(i + 1) % M]);
        if (kept.has(pair)) continue;
        kept.add(pair);
        edges.push(rowOf[i], rowOf[(i + 1) % M]);
        const id = mintIds(1)[0];
        eids.push(id);
        eroots.push(id);
        for (const name of enames) {
          // The closing edge is a piece of the lowered boundary polyline: a
          // coordinate segment, whatever the wall before it was.
          if (name === 'geodesic') eattrs[name].push(0);
          else eattrs[name].push(m.edgeTransfers[name] === 'distribute' ? 0 : m.edgeAttrs[name][edgeFrom[i]]);
        }
        cutFlags.push(1);
      }
    }
  }

  const attrs: Record<string, Float64Array> = {};
  for (const name of names) attrs[name] = Float64Array.from(oattrs[name]);
  const edgeAttrs: Record<string, Float64Array> = {};
  for (const name of enames) edgeAttrs[name] = Float64Array.from(eattrs[name]);
  // The column belongs to a cut that can close: a material with faces. An
  // open chain or a point cloud keeps the columns it had — a `cut` column it
  // never asked for would be one more column every later edge must give.
  const edgeTransfers = { ...m.edgeTransfers };
  if (cells) {
    // A source that already carries `cut` (a level set closed along the
    // drawable) keeps its marks: the two are OR-ed, never replaced.
    const priorCut = edgeAttrs.cut;
    edgeAttrs.cut = Float64Array.from(cutFlags, (f, i) => (f || (priorCut !== undefined && priorCut[i] !== 0) ? 1 : 0));
    delete edgeTransfers.cut;
  }
  return carryLinks(m, new Material(Float64Array.from(ox), Float64Array.from(oy), attrs, Uint32Array.from(edges), { iteration: m.iteration, history: [], edgeAttrs: edgeAttrs, transfers: { ...m.transfers }, edgeTransfers, ids: { points: Float64Array.from(oids), edges: Float64Array.from(eids), edgeRoots: Float64Array.from(eroots) }, faceAttrs: m.faceAttrs, from: m, faces: m.stated }));
}

/** The faces a cut can close, or null: a material with no cycle encloses
 * nothing (and is not asked), and one whose edges cross has no faces to
 * read — `within` still cuts it, best-effort, and closes nothing. */
function readableFaces(m: Material): FaceTable | null {
  // A cycle exists exactly when some edge joins two vertices already joined.
  const parent = Int32Array.from({ length: m.n }, (_, i) => i);
  const root = (v: number): number => {
    while (parent[v] !== v) v = parent[v] = parent[parent[v]];
    return v;
  };
  let cyclic = false;
  for (let e = 0; e < m.edgeCount && !cyclic; e++) {
    const a = root(m.edgeList[2 * e]);
    const b = root(m.edgeList[2 * e + 1]);
    if (a === b) cyclic = true;
    else parent[a] = b;
  }
  if (!cyclic) return null;
  let cells: FaceTable;
  try {
    cells = faceTableOf(m.faces);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('faces:')) return null;
    throw err;
  }
  return cells.faces.length > 0 ? cells : null;
}

type BoundaryMark =
  | { kind: 'corner'; x: number; y: number }
  | { kind: 'vertex'; x: number; y: number; a: number; edge: number }
  | { kind: 'crossing'; x: number; y: number; a: number; b: number; t: number; edge: number };

/** Where one boundary loop of a `within` area is marked, in walk order: its
 * corners, every crossing with a source edge — the SAME point the cut minted,
 * by the same arithmetic as `loopCrossings` — and every source vertex lying
 * on it. Marks at one quantised position are one mark, the source's own
 * (a crossing or a vertex) winning over a corner. */
function boundaryMarks(
  m: Material,
  loop: readonly (readonly [number, number])[],
  walls: ReturnType<typeof boxGrid>,
  incident: Int32Array,
  onTol: number,
): BoundaryMark[] {
  const out: BoundaryMark[] = [];
  const L = loop.length;
  for (let k = 0; k < L; k++) {
    const p = loop[k];
    const q = loop[(k + 1) % L];
    const ex = q[0] - p[0];
    const ey = q[1] - p[1];
    const len2 = ex * ex + ey * ey;
    if (len2 === 0) continue;
    const lo = [Math.min(p[0], q[0]) - onTol, Math.min(p[1], q[1]) - onTol];
    const hi = [Math.max(p[0], q[0]) + onTol, Math.max(p[1], q[1]) + onTol];
    const along: { u: number; mark: BoundaryMark }[] = [{ u: 0, mark: { kind: 'corner', x: p[0], y: p[1] } }];
    const len = Math.sqrt(len2);
    // A vertex on the segment is reported once, by its first wall.
    const onSeg = new Set<number>();
    for (const e of walls.near(lo[0], lo[1], hi[0], hi[1]).sort((i, j) => i - j)) {
      const a = m.edgeList[2 * e];
      const b = m.edgeList[2 * e + 1];
      const ax = m.x[a];
      const ay = m.y[a];
      const bx = m.x[b];
      const by = m.y[b];
      if (Math.max(ax, bx) < lo[0] || Math.min(ax, bx) > hi[0] || Math.max(ay, by) < lo[1] || Math.min(ay, by) > hi[1]) continue;
      for (const v of [a, b]) {
        if (onSeg.has(v)) continue;
        const vx = m.x[v];
        const vy = m.y[v];
        if (vx < lo[0] || vx > hi[0] || vy < lo[1] || vy > hi[1]) continue;
        if (Math.abs(ex * (vy - p[1]) - ey * (vx - p[0])) / len > onTol) continue;
        // A vertex a rounding past a corner is still on the loop: both
        // segments may report it, and the merge below keeps one.
        const u = (ex * (vx - p[0]) + ey * (vy - p[1])) / len2;
        if (u * len >= -onTol && (u - 1) * len <= onTol) {
          onSeg.add(v);
          along.push({ u, mark: { kind: 'vertex', x: vx, y: vy, a: v, edge: incident[v] } });
        }
      }
      // loopCrossings, term for term, so the point's bits match the cut's.
      const dx = bx - ax;
      const dy = by - ay;
      const denom = dx * ey - dy * ex;
      if (denom === 0) continue;
      const ox = p[0] - ax;
      const oy = p[1] - ay;
      const t = (ox * ey - oy * ex) / denom;
      if (!(t > 0 && t < 1)) continue;
      const u = (ox * dy - oy * dx) / denom;
      if (u >= 0 && u < 1) along.push({ u, mark: { kind: 'crossing', x: p[0] + ex * u, y: p[1] + ey * u, a, b, t, edge: e } });
    }
    along.sort((s, r) => s.u - r.u);
    for (const { mark } of along) out.push(mark);
  }
  // One mark per position: the cut's own row wins over a corner.
  const key = (mk: BoundaryMark) => `${mk.x.toFixed(6)},${mk.y.toFixed(6)}`;
  const rank = (mk: BoundaryMark) => (mk.kind === 'corner' ? 0 : mk.kind === 'vertex' ? 1 : 2);
  const merged: BoundaryMark[] = [];
  for (const mk of out) {
    const last = merged[merged.length - 1];
    if (last && key(last) === key(mk)) {
      if (rank(mk) > rank(last)) merged[merged.length - 1] = mk;
      continue;
    }
    merged.push(mk);
  }
  while (merged.length > 1 && key(merged[0]) === key(merged[merged.length - 1])) {
    const last = merged.pop()!;
    if (rank(last) > rank(merged[0])) merged[0] = last;
  }
  return merged;
}

// ---- constructors ----------------------------------------------------------------

/** Points a material can be made from: tuples, `{x, y}` objects (extra numeric
 * fields such as a scatter point's `w` become columns), or a material. */
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

/** Anything a point consumer takes. A face collection or selection reads
 * as its faces' centroids (see `faceCentroids`); `faces.points` is the word
 * for the corners. */
export type PointsLike = readonly (XY | PointRecord)[] | Iterable<XY | PointRecord> | Material | Selection<Face>;

/**
 * Material from positions. Unconnected unless `edges` are given; extra
 * numeric fields on object points (`w` from `t.scatter`) become columns
 * when every point carries them (a pair carries none);
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
      throw new Error('material: options on an existing Material are not supported; write its columns with points.set() or edges.set(), and its edges with edges.add()');
    }
    return points;
  }
  // A point selection is those points: the rows, their columns and their
  // ids, so a builder handed one (`curve(sel)`) keeps who each
  // member is, and a selection of the source names them again.
  if (isPointSelection(points) && Object.keys(opts).length === 0) return points.extract();
  // A face collection is points at its faces' centroids.
  const centres = faceCentroids(points);
  // A point collection (m.points, a selection) is a fine source of points.
  const list: readonly XY[] = centres ?? (Array.isArray(points) ? (points as readonly XY[]) : Array.from(points as Iterable<XY>));
  const n = list.length;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const attrs: Record<string, Float64Array> = {};
  // The columns are the ones EVERY point carries. A pair carries none, so a
  // pair beside a scatter vertex keeps positions alone, and a column only
  // some records hold is dropped rather than half filled.
  let shared: string[] | null = null;
  for (let i = 0; i < n; i++) {
    const p = list[i];
    x[i] = vx(p);
    y[i] = vy(p);
    if (shared !== null && shared.length === 0) continue;
    const own = new Set<string>();
    if (!isArr(p)) {
      for (const [k, v] of Object.entries(p)) if (k !== 'x' && k !== 'y' && k !== 'index' && typeof v === 'number') own.add(k);
    }
    shared = shared === null ? [...own] : shared.filter((k) => own.has(k));
  }
  for (const k of shared ?? []) {
    const col = new Float64Array(n);
    for (let i = 0; i < n; i++) col[i] = (list[i] as Record<string, number>)[k];
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
 * A chain through points in their order — open unless `closed: true`
 * joins the last back to the first. The points are positions (pairs or
 * `{x, y}` records), a point selection, a material or a face collection,
 * read as `material()` reads them: a selection keeps its members' ids,
 * rows and columns, so the chain is those points. Positions may take
 * point columns, one constant per vertex or a full column; points that
 * already are rows bring their own. It uses the supplied order and infers
 * no route.
 */
export function curve(
  points: PointsLike,
  opts: { closed?: boolean } & Record<string, number | ArrayLike<number> | boolean | undefined> = {},
): Material {
  const { closed = false, ...rest } = opts;
  if (typeof closed !== 'boolean') throw new Error(`curve: closed is true or false, got ${String(closed)}`);
  const cols: Record<string, number | ArrayLike<number>> = {};
  for (const [k, v] of Object.entries(rest)) {
    if (v === undefined) continue;
    if (typeof v === 'boolean') throw new Error(`curve: attribute '${k}' must be numeric`);
    cols[k] = v;
  }
  const given = material(points, cols);
  // A curve is the points and the chain through them, in the order given:
  // edges the points had where they came from (a selection keeps them on
  // extract) are not part of it, nor are those edges' columns.
  const m = given.edgeCount === 0 && given.edgeAttrNames.length === 0 ? given : carryLinks(given, new Material(given.x, given.y, given.attrs, new Uint32Array(0), {
    iteration: given.iteration,
    transfers: { ...given.transfers },
    ids: { points: given.pointIds },
    from: given,
  }));
  return addEdges(m, chainEdges(m.n, closed));
}

/**
 * `m.transform` of a transform record — `{ translate, rotate, scale, origin }`, as
 * `t.symmetry` answers and `group` takes — with exactly `group`'s
 * meaning: scale, then rotate, both about `origin` (the user origin when
 * it is unset), then translate. A mirror is a negative scale. It moves
 * the coordinates, as `m.rotate` does, so it is `mapPositions`
 * underneath and every id and column carries. A material has no frame, so every length
 * is a number in its own units, and `origin` is the one `Origin` of every
 * pivot: a point, or `'center'`/`'centroid'` of the material itself.
 */
/** A `group`-style record for a material: the same words, and `origin` the
 * one `Origin` of every pivot. */
export type TransformRecord = Omit<TransformOp, 'origin'> & { origin?: Origin | TransformOp['origin'] };

function transformByRecord(m: Material, op: TransformRecord): Material {
  const who = 'm.transform';
  if (op.placement !== undefined) {
    const affine = op.translate !== undefined || op.rotate !== undefined || op.scale !== undefined || op.origin !== undefined;
    if (affine) throw new Error(`${who}: a record holds a placement or translate/rotate/scale/origin, not both — they name two frames; transform twice instead`);
    return m.transform(op.placement);
  }
  const num = (v: unknown, what: string): number => {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${who}: ${what} is ${String(v)} — a material moves in its own units, so give a finite number`);
    return v;
  };
  const pivot: [number, number] | null = op.origin === undefined
    ? null
    : Array.isArray(op.origin)
      ? [num(op.origin[0], 'origin[0]'), num(op.origin[1], 'origin[1]')]
      : (m.pivot(who, op.origin as Origin) as [number, number]);
  let mat = IDENTITY;
  if (op.translate !== undefined) mat = mulMat(mat, translateMat(num(op.translate[0], 'translate[0]'), num(op.translate[1], 'translate[1]')));
  if (pivot) mat = mulMat(mat, translateMat(pivot[0], pivot[1]));
  if (op.rotate !== undefined && num(op.rotate, 'rotate') !== 0) mat = mulMat(mat, rotateMat(radians(op.rotate)));
  if (op.scale !== undefined) {
    const [sx, sy] = typeof op.scale === 'number' ? [op.scale, op.scale] : op.scale;
    mat = mulMat(mat, scaleMat(num(sx, 'scale'), num(sy, 'scale')));
  }
  if (pivot) mat = mulMat(mat, translateMat(-pivot[0], -pivot[1]));
  return mapPositions(m, (p) => applyMat(mat, p.x, p.y), who);
}

/**
 * @internal Every vertex through a point map: the position each vertex
 * goes to, not a step from where it is. Nothing else changes: the same
 * rows in the same order, the same ids, the same point, edge and face
 * columns. The engine's door for the affine and projective maps; a sketch
 * sets `x` and `y` with `g.points.set`.
 */
export function mapPositions(m: Material, fn: (p: Vertex) => XY, who: string): Material {
  const nx = new Float64Array(m.n);
  const ny = new Float64Array(m.n);
  for (let i = 0; i < m.n; i++) {
    const q = fn(readVertex(m, i));
    const x = vx(q);
    const y = vy(q);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`${who}: vertex ${i} maps to [${x}, ${y}], which is not a point`);
    nx[i] = x;
    ny[i] = y;
  }
  const s = m.store;
  return carryLinks(m, new Material(nx, ny, s.attrs, s.edgeList, { iteration: m.iteration, history: [], edgeAttrs: s.edgeAttrs, transfers: { ...m.transfers }, edgeTransfers: { ...m.edgeTransfers }, ids: { points: s.pointIds, edges: s.edgeIds, edgeRoots: s.edgeRoots }, faceAttrs: m.faceAttrs, from: m, faces: m.stated }));
}

// ---- connections ----------------------------------------------------------------

/** A new material with these edges added to the ones it has — what every
 * `connect` pattern does: the table write `edges.add` over rows, one
 * record of columns for every new edge. An existing pair is left as it is,
 * and a pair of one vertex is no edge. */
function addEdges(m: Material, pairs: readonly (readonly [number, number])[], given: Record<string, number> = {}): Material {
  return addEdgeRows(m, pairs, pairs.map(() => given), null, 'connect');
}

function chainEdges(n: number, closed: boolean): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < n; i++) out.push([i, i + 1]);
  if (closed && n > 2) out.push([n - 1, 0]);
  else if (closed && n === 2) out.push([1, 0]);
  return out;
}

// ---- turns ----------------------------------------------------------------------
//
// Dubins' theorem: the shortest path between two headed places, for
// something that cannot turn tighter than `radius` and never reverses, is
// always one of six words — LSL, RSR, LSR, RSL, RLR, LRL, where L and R are
// arcs at the radius and S is a straight. So the shortest path is found by
// writing all six down and taking the shortest that exists. The classical
// closed forms below are Shkel & Lumelsky's, in the normalised frame where
// the two places are `d = distance / radius` apart along +x: `alpha` and
// `beta` are the two headings measured from that line, and a word's three
// lengths come back in radians of turn (the straight in radii).
//
// L turns the heading UP (increasing angle, +x toward +y), R turns it down.
// With y growing downward that reads clockwise on paper — the letters are
// the theorem's, not the drawing's.

const TAU = 2 * Math.PI;
const mod2pi = (a: number): number => ((a % TAU) + TAU) % TAU;

type Turn = 'L' | 'S' | 'R';
interface DubinsWord {
  word: readonly [Turn, Turn, Turn];
  /** Segment lengths: radians for an arc, radii for the straight. */
  parts: readonly [number, number, number];
}

/** Every one of the six words that exists for this pair, unordered. */
function dubinsWords(alpha: number, beta: number, d: number): DubinsWord[] {
  const sa = Math.sin(alpha);
  const ca = Math.cos(alpha);
  const sb = Math.sin(beta);
  const cb = Math.cos(beta);
  const cab = Math.cos(alpha - beta);
  const out: DubinsWord[] = [];
  const add = (word: readonly [Turn, Turn, Turn], t: number, p: number, q: number): void => {
    if (Number.isFinite(t) && Number.isFinite(p) && Number.isFinite(q)) out.push({ word, parts: [t, p, q] });
  };
  const lsl = 2 + d * d - 2 * cab + 2 * d * (sa - sb);
  if (lsl >= 0) {
    const tmp = Math.atan2(cb - ca, d + sa - sb);
    add(['L', 'S', 'L'], mod2pi(-alpha + tmp), Math.sqrt(lsl), mod2pi(beta - tmp));
  }
  const rsr = 2 + d * d - 2 * cab + 2 * d * (sb - sa);
  if (rsr >= 0) {
    const tmp = Math.atan2(ca - cb, d - sa + sb);
    add(['R', 'S', 'R'], mod2pi(alpha - tmp), Math.sqrt(rsr), mod2pi(-beta + tmp));
  }
  const lsr = -2 + d * d + 2 * cab + 2 * d * (sa + sb);
  if (lsr >= 0) {
    const p = Math.sqrt(lsr);
    const tmp = Math.atan2(-ca - cb, d + sa + sb) - Math.atan2(-2, p);
    add(['L', 'S', 'R'], mod2pi(-alpha + tmp), p, mod2pi(-mod2pi(beta) + tmp));
  }
  const rsl = d * d - 2 + 2 * cab - 2 * d * (sa + sb);
  if (rsl >= 0) {
    const p = Math.sqrt(rsl);
    const tmp = Math.atan2(ca + cb, d - sa - sb) - Math.atan2(2, p);
    add(['R', 'S', 'L'], mod2pi(alpha - tmp), p, mod2pi(beta - tmp));
  }
  const rlr = (6 - d * d + 2 * cab + 2 * d * (sa - sb)) / 8;
  if (Math.abs(rlr) <= 1) {
    const p = mod2pi(TAU - Math.acos(rlr));
    const t = mod2pi(alpha - Math.atan2(ca - cb, d - sa + sb) + mod2pi(p / 2));
    add(['R', 'L', 'R'], t, p, mod2pi(alpha - beta - t + mod2pi(p)));
  }
  const lrl = (6 - d * d + 2 * cab + 2 * d * (sb - sa)) / 8;
  if (Math.abs(lrl) <= 1) {
    const p = mod2pi(TAU - Math.acos(lrl));
    const t = mod2pi(-alpha - Math.atan2(ca - cb, d + sa - sb) + p / 2);
    add(['L', 'R', 'L'], t, p, mod2pi(mod2pi(beta) - alpha - t + mod2pi(p)));
  }
  return out;
}

/** One segment walked from a state, exactly (no integration drift). */
function walkTurn(x: number, y: number, th: number, letter: Turn, len: number, r: number): [number, number, number] {
  if (letter === 'S') return [x + len * Math.cos(th), y + len * Math.sin(th), th];
  const side = letter === 'L' ? 1 : -1;
  const cx = x - side * r * Math.sin(th);
  const cy = y + side * r * Math.cos(th);
  const th2 = th + (side * len) / r;
  return [cx + side * r * Math.sin(th2), cy - side * r * Math.cos(th2), th2];
}

/**
 * The shortest Dubins path from one headed place to another, as points
 * INCLUDING both ends, or null when no word of the six exists.
 *
 * An arc is cut so no step turns more than an eighth of a radian — a
 * sagitta of two thousandths of the radius, under any nib — and a straight
 * is two points, because a straight needs no more.
 */
function turnPoints(
  from: readonly [number, number, number],
  to: readonly [number, number, number],
  r: number,
): [number, number][] | null {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const d = Math.hypot(dx, dy) / r;
  const th = Math.atan2(dy, dx);
  const alpha = mod2pi(from[2] - th);
  const beta = mod2pi(to[2] - th);
  let best: DubinsWord | null = null;
  let bestLen = Infinity;
  for (const w of dubinsWords(alpha, beta, d)) {
    const total = w.parts[0] + w.parts[1] + w.parts[2];
    if (total < bestLen) {
      bestLen = total;
      best = w;
    }
  }
  if (!best) return null;
  const pts: [number, number][] = [[from[0], from[1]]];
  let state: [number, number, number] = [from[0], from[1], from[2]];
  for (let k = 0; k < 3; k++) {
    const letter = best.word[k];
    // Arc lengths come back in radians of turn, the straight in radii.
    const len = best.parts[k] * r;
    if (!(len > 0)) continue;
    const steps = letter === 'S' ? 1 : Math.max(1, Math.ceil(8 * best.parts[k]));
    for (let i = 1; i <= steps; i++) {
      const at = walkTurn(state[0], state[1], state[2], letter, (len * i) / steps, r);
      pts.push([at[0], at[1]]);
      if (i === steps) state = at;
    }
  }
  return pts;
}

/** Headed places, or a refusal that names what is missing: the points of
 * `m.along()` (a material or a point selection whose rows have a
 * `heading`), or a list of placements or `{ x, y, heading }` records. The
 * space is the one the places belong to. */
function headedPlaces(given: unknown, who: string): { list: { x: number; y: number; heading: number }[]; space: Space | undefined } {
  const noHeading = `${who}: these points have no heading to turn from — take headed points off a chain with m.along({ spacing }) and pass those`;
  if (given instanceof Material) {
    if (given.n > 0 && given.attrs.heading === undefined) throw new Error(noHeading);
    const h = given.attrs.heading;
    return { list: Array.from({ length: given.n }, (_, i) => ({ x: given.x[i], y: given.y[i], heading: h[i] })), space: given.space };
  }
  if (isPointSelection(given)) {
    const src = given.source as Material;
    const list = given.map((p) => {
      if (typeof p.heading !== 'number') throw new Error(noHeading);
      return { x: p.x, y: p.y, heading: p.heading };
    });
    return { list, space: src.space };
  }
  if (typeof given !== 'object' || given === null || typeof (given as Iterable<unknown>)[Symbol.iterator] !== 'function') {
    throw new Error(`${who}: expected headed places — the points m.along() answers, or placements — got ${given === null ? 'null' : typeof given}`);
  }
  let space: Space | undefined;
  const list = Array.from(given as Iterable<unknown>, (q, i) => {
    const s = q as { x?: unknown; y?: unknown; heading?: unknown };
    if (typeof s?.x !== 'number' || typeof s?.y !== 'number' || typeof s?.heading !== 'number') {
      throw new Error(`${who}: entry ${i} is a plain point with no heading to turn from — take headed points off a chain with m.along({ spacing }), or give placements`);
    }
    if (space === undefined && isPlacement(q)) space = spaceOfDoor(q.door);
    return { x: s.x, y: s.y, heading: s.heading };
  });
  return { list, space };
}

/** Common connection patterns; each returns a new material. A chain in
 * the supplied order is `curve(points, { closed })`. */
export const connect = {
  /** Each vertex joined to its `count` nearest others (undirected, no
   * duplicates, self excluded; ties broken by lower row). */
  nearest(m: PointsLike, opts: { count: number; edgeColumns?: Record<string, number> }): Material {
    const mm = material(m);
    const pairs: [number, number][] = [];
    // Grid search: rings of cells outward until the ring can hold nothing
    // nearer than the k-th candidate found. Ties by (distance, row) exactly
    // as the full scan ordered them.
    const k = opts.count;
    if (!Number.isInteger(k) || k < 0) throw new Error(`connect.nearest: count must be a non-negative integer, got ${k}`);
    if (k === 0 || mm.n < 2) return addEdges(mm, [], opts.edgeColumns);
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
    return addEdges(mm, pairs, opts.edgeColumns);
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
  tour(m: PointsLike, opts: { cost?: (a: Vertex, b: Vertex) => number; closed?: boolean; candidates?: number; edgeColumns?: Record<string, number> } = {}): Material {
    const mm = material(m);
    const n = mm.n;
    const asked = opts.candidates ?? 12;
    if (!Number.isInteger(asked)) throw new Error(`connect.tour: candidates must be a whole number of neighbours, at least 2 (got ${String(opts.candidates)})`);
    // A choice needs two to choose between: fewer is read as two.
    const k = Math.max(2, asked);
    if (opts.cost !== undefined && typeof opts.cost !== 'function') throw new Error('connect.tour: cost must be a function of two vertex views');
    if (n < 2) return addEdges(mm, [], opts.edgeColumns);
    const views = Array.from({ length: n }, (_, i) => readVertex(mm, i));
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
    return addEdges(mm, pairs, opts.edgeColumns);
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
   * walks each arm, `faces` finds nothing because a tree encloses nothing,
   * and `p.adjacent.length` tells a tip from a fork.
   */
  tree(m: PointsLike, opts: { cost?: (a: Vertex, b: Vertex) => number; edgeColumns?: Record<string, number> } = {}): Material {
    const mm = material(m);
    const n = mm.n;
    if (opts.cost !== undefined && typeof opts.cost !== 'function') throw new Error('connect.tree: cost must be a function of two vertex views');
    if (n < 2) return addEdges(mm, [], opts.edgeColumns);
    const views = Array.from({ length: n }, (_, i) => readVertex(mm, i));
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
    return addEdges(mm, pairs, opts.edgeColumns);
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
   * radius `d` centred on each — the two classical answers, the Gabriel graph
   * and the relative neighbourhood graph — but it is one continuous knob, not
   * two named graphs, and the interesting values are the ones between. More
   * room is a sparser, more organic lattice. Coincident rows are read as
   * `triangulate` reads them: the first at a place takes part, the later ones
   * stay isolated. Points on one line join each to the next along it.
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
  unimpeded(m: PointsLike, opts: { room?: number | ((x: number, y: number) => number); edgeColumns?: Record<string, number> } = {}): Material {
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
    if (mm.n < 2) return addEdges(mm, [], opts.edgeColumns);
    const grid = pointGrid(mm.x, mm.y, Math.max(2, Math.ceil(Math.sqrt(mm.n / 2))));
    const delaunay = connect.triangulate(mm).edgeList;
    // Fewer than three distinct positions, or all of them collinear, and there
    // is no triangulation to draw candidates from — but two rows with nothing
    // between them are still neighbours, so every pair is a candidate instead.
    const candidates: [number, number][] = [];
    if (delaunay.length) {
      for (let e = 0; e < delaunay.length; e += 2) candidates.push([delaunay[e], delaunay[e + 1]]);
    } else {
      // The first row at each place, as `triangulate` reads them.
      const seen = new Set<string>();
      const first: number[] = [];
      for (let i = 0; i < mm.n; i++) {
        const k = `${mm.x[i]},${mm.y[i]}`;
        if (seen.has(k)) continue;
        seen.add(k);
        first.push(i);
      }
      for (let i = 0; i < first.length; i++) for (let j = i + 1; j < first.length; j++) candidates.push([first[i], first[j]]);
    }
    const pairs: [number, number][] = [];
    for (const [a, b] of candidates) {
      const ax = mm.x[a];
      const ay = mm.y[a];
      const bx = mm.x[b];
      const by = mm.y[b];
      const d2 = (bx - ax) ** 2 + (by - ay) ** 2;
      if (!(d2 > 0)) continue;
      // The two disc centres, pushed apart from the midpoint by the room asked
      // for, and their shared radius: at room `2k` each disc is `k` of the
      // way from one row to the other, radius `k·d`. Written as a blend of
      // the two rows, so the classical rooms land exactly — at 1 both
      // centres are the midpoint, at 2 each centre IS the other row — and
      // the test is on squared lengths, with no root to round. A fielded
      // `room` is read at the middle of the pair, which is the one place
      // both rows agree on.
      const k = roomAt((ax + bx) / 2, (ay + by) / 2) / 2;
      const c1x = (1 - k) * ax + k * bx;
      const c1y = (1 - k) * ay + k * by;
      const c2x = k * ax + (1 - k) * bx;
      const c2y = k * ay + (1 - k) * by;
      const r2 = k * k * d2;
      const r = Math.sqrt(r2);
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
          for (const q of grid.at(ci, rj)) {
            if (q === a || q === b) continue;
            const qx = mm.x[q];
            const qy = mm.y[q];
            // A row at an end's very place is that end read twice, as
            // `triangulate` reads it, and stands in nobody's way.
            if ((qx === ax && qy === ay) || (qx === bx && qy === by)) continue;
            if ((qx - c1x) ** 2 + (qy - c1y) ** 2 >= r2) continue;
            if ((qx - c2x) ** 2 + (qy - c2y) ** 2 >= r2) continue;
            blocked = true;
            break;
          }
        }
      }
      if (!blocked) pairs.push([a, b]);
    }
    return addEdges(mm, pairs, opts.edgeColumns);
  },

  /** Row i of `a` joined to row i of `b`, in one material (a's rows first).
   * Lengths must match; coincident points stay distinct. */
  pairs(a: PointsLike, b: PointsLike, edgeColumns?: Record<string, number>): Material {
    const ma = material(a);
    const mb = material(b);
    const joined = append(ma, mb);
    const pairs: [number, number][] = [];
    // Rows with no partner are carried through as points: a row of five and
    // a row of four join four times, and still draw.
    for (let i = 0; i < Math.min(ma.n, mb.n); i++) pairs.push([i, ma.n + i]);
    return addEdges(joined, pairs, edgeColumns);
  },
  /**
   * One run through headed places, turning no tighter than `radius`.
   *
   * Each consecutive pair is joined by its shortest Dubins path — the
   * shortest route for something that holds a minimum turning radius and
   * never reverses — so the run leaves each place along its heading and
   * arrives at the next one along ITS heading. That is what makes it
   * different from `connect.tour`, which joins places; this joins
   * DIRECTIONS, and is how loose fragments of a flow become one continuous
   * line the pen can draw without lifting.
   *
   * The input is headed places: the points `m.along()` answers (each has a
   * `heading`), or placements. A plain point has no heading and is refused
   * by name. The result is a chain material sampled at its own resolution —
   * arcs cut fine enough that the turn reads as a curve, straights left as
   * straights — so `strokes(m)` draws it and `m.resample` re-spaces it.
   *
   * `closed` joins the last place back to the first. A pair with no
   * admissible path at that radius (too tight a turn into too near a
   * place) gets no edge at all: the run breaks there into two chains,
   * rather than cutting a corner it could not drive.
   */
  turns(places: Material | Selection<Vertex> | Iterable<Placement | { x: number; y: number; heading: number }>, opts: { radius: number; closed?: boolean }): Material {
    const r = opts?.radius;
    if (!(typeof r === 'number' && r > 0 && Number.isFinite(r))) {
      throw new Error(`connect.turns: { radius } must be a positive turning radius, got ${String(r)}`);
    }
    const { list, space } = headedPlaces(places, 'connect.turns');
    const closed = opts.closed === true;
    const xs: number[] = [];
    const ys: number[] = [];
    const edges: [number, number][] = [];
    const place = (p: readonly [number, number]): number => {
      xs.push(p[0]);
      ys.push(p[1]);
      return xs.length - 1;
    };
    const at = (q: { x: number; y: number; heading: number }): [number, number, number] => [q.x, q.y, q.heading];
    const last = closed ? list.length : list.length - 1;
    let prevRow = -1;
    let firstRow = -1;
    for (let k = 0; k < last; k++) {
      const a = list[k];
      const b = list[(k + 1) % list.length];
      const pts = turnPoints(at(a), at(b), r);
      if (!pts) {
        prevRow = -1;
        continue;
      }
      // The pair's first point IS this place: it is a new row only when
      // the previous pair did not already leave one there.
      let from = prevRow;
      if (from < 0) from = place(pts[0]);
      if (k === 0) firstRow = from;
      const wraps = closed && k === last - 1 && firstRow >= 0;
      for (let i = 1; i < pts.length; i++) {
        const to = wraps && i === pts.length - 1 ? firstRow : place(pts[i]);
        edges.push([from, to]);
        from = to;
      }
      prevRow = from;
    }
    // One place and nothing to turn toward is still that place.
    if (xs.length === 0) for (const q of list) place([q.x, q.y]);
    // Whatever space the places were walked in, the path is in it too.
    return new Material(Float64Array.from(xs), Float64Array.from(ys), {}, Uint32Array.from(edges.flat()), { space });
  },

  /** Delaunay triangulation edges over the vertices. */
  /** Delaunay edges over the rows, by index. Coincident rows: the FIRST
   * row at a position takes part in the triangulation and its edges; later
   * rows at the same position stay isolated (they are still rows). Fewer
   * than three distinct positions, or all collinear, give no edges. */
  triangulate(m: PointsLike, edgeColumns?: Record<string, number>): Material {
    const mm = material(m);
    const firstAt = new Map<string, number>();
    const unique: number[] = [];
    for (let i = 0; i < mm.n; i++) {
      const k = `${mm.x[i]},${mm.y[i]}`;
      if (firstAt.has(k)) continue;
      firstAt.set(k, i);
      unique.push(i);
    }
    if (unique.length < 3) return addEdges(mm, [], edgeColumns);
    // All collinear: no triangle exists (d3 would perturb the points into a
    // sliver); decided exactly.
    const [u0, u1] = unique;
    if (unique.every((row) => orient2d(mm.x[u0], mm.y[u0], mm.x[u1], mm.y[u1], mm.x[row], mm.y[row]) === 0)) return addEdges(mm, [], edgeColumns);
    const tri = Delaunay.from(unique.map((row) => [mm.x[row], mm.y[row]] as [number, number])).triangles;
    const pairs: [number, number][] = [];
    for (let k = 0; k + 2 < tri.length; k += 3) {
      const a = unique[tri[k]];
      const b = unique[tri[k + 1]];
      const c = unique[tri[k + 2]];
      pairs.push([a, b], [b, c], [c, a]);
    }
    return addEdges(mm, pairs, edgeColumns);
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
  // A column whose absence means something fills the side that lacks it.
  const edgeFill = { ...EDGE_ABSENT, ...(opts.edgeFill ?? {}) };
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
  // Appending changes no row: every point and edge of both sides is the one
  // it was, so it keeps the id it had. Minting fresh ones here would retire
  // identities nothing retired, and a selection held across the append —
  // which is the reason to hold one — would find nothing.
  const pointIds = new Float64Array(a.n + b.n);
  pointIds.set(a.pointIds);
  pointIds.set(b.pointIds, a.n);
  const edgeIds = new Float64Array(a.edgeCount + b.edgeCount);
  edgeIds.set(a.edgeIds);
  edgeIds.set(b.edgeIds, a.edgeCount);
  const edgeRoots = new Float64Array(a.edgeCount + b.edgeCount);
  edgeRoots.set(a.edgeRoots);
  edgeRoots.set(b.edgeRoots, a.edgeCount);
  // Two materials of the same evolution share ids; two unrelated ones may
  // collide by chance. A collision would make `cur.point(id)` ambiguous, so
  // the second side is re-minted whole rather than half — and the first side,
  // which the artist is usually appending TO, keeps what it had.
  const seen = new Set<number>(a.pointIds);
  if ([...b.pointIds].some((id) => seen.has(id))) pointIds.set(mintIds(b.n), a.n);
  const seenEdges = new Set<number>(a.edgeIds);
  if ([...b.edgeIds].some((id) => seenEdges.has(id))) {
    const fresh = mintIds(b.edgeCount);
    edgeIds.set(fresh, a.edgeCount);
    edgeRoots.set(fresh, a.edgeCount);
  }
  // Face columns are keyed by wall lineage, and appending changes no wall.
  // A name on both sides with different values cannot be reconciled, so it
  // is refused rather than silently taking one.
  for (const k of Object.keys(a.faceAttrs)) {
    if (k in b.faceAttrs) throw new Error(`append: both materials carry the face column '${k}' — rename one before joining them`);
  }
  // The joined rows are in the space of whichever side knows one. Two
  // sides in two different geometries have no one space to be in; inside
  // one sketch that cannot happen, so it is a mistake and says so.
  if (a.space !== undefined && b.space !== undefined && a.space.model.id !== b.space.model.id) {
    throw new Error(`append: the two materials are in different spaces (${a.space.kind} and ${b.space.kind}) — their coordinates name different places`);
  }
  return new Material(x, y, attrs, edges, { iteration: 0, history: [], edgeAttrs: edgeAttrs, transfers: { ...b.transfers, ...a.transfers }, edgeTransfers: { ...b.edgeTransfers, ...a.edgeTransfers }, ids: { points: pointIds, edges: edgeIds, edgeRoots }, faceAttrs: { ...b.faceAttrs, ...a.faceAttrs }, space: a.space ?? b.space });
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
 * The area centroid of closed contours, as `polygon` fills them: each
 * contour's shoelace moment (`contourMoment`, the one a face's `centroid`
 * sums), weighted by its unsigned area and subtracted when the contour
 * lies inside an odd number of the others. A chain walk says nothing
 * reliable about winding, so nesting, not orientation, names a hole.
 * `undefined` when the contours enclose no area.
 */
export function areaCentroid(contours: readonly IsoContour[]): Vec | undefined {
  let ma = 0, mx = 0, my = 0;
  contours.forEach((c, k) => {
    const mo = contourMoment(c);
    if (mo.a === 0) return;
    const [px, py] = c.pts[0];
    let depth = 0;
    contours.forEach((o, j) => {
      if (j === k) return;
      let inside = false;
      const pts = o.pts;
      for (let i = 0, h = pts.length - 1; i < pts.length; h = i++) {
        const [xi, yi] = pts[i];
        const [xh, yh] = pts[h];
        if ((yi > py) !== (yh > py) && px < ((xh - xi) * (py - yi)) / (yh - yi) + xi) inside = !inside;
      }
      if (inside) depth++;
    });
    const a = Math.abs(mo.a) * (depth % 2 === 0 ? 1 : -1);
    ma += a;
    mx += mo.cx * a;
    my += mo.cy * a;
  });
  return ma !== 0 ? [mx / ma, my / ma] : undefined;
}

/**
 * Edge columns whose ABSENCE has a meaning, and the value it means. A
 * material without the column reads every edge as this value, so a verb
 * that joins or adds edges fills it in and never asks the sketch for it.
 *
 * `geodesic` (1/0): the edge is the geodesic of the material's space
 * between its ends, not the image of the coordinate segment. `t.material`
 * writes it in a curved space — 1 on the edges of a `line`, a circle, an
 * ellipse and an ngon, 0 on a rect's, a path's and a polygon's — and the
 * ink door and `m.transform` read it. A material with no column is flat
 * coordinate edges, as it always was.
 */
export const EDGE_ABSENT: Readonly<Record<string, number>> = Object.freeze({ geodesic: 0 });

/** A new edge's record with every column that has an absent meaning, and
 * that the material declares, filled in where the record is silent. */
export function withAbsentEdge(attrs: Record<string, number>, names: readonly string[]): Record<string, number> {
  let out = attrs;
  for (const name of names) {
    if (name in EDGE_ABSENT && !(name in attrs)) {
      if (out === attrs) out = { ...attrs };
      out[name] = EDGE_ABSENT[name];
    }
  }
  return out;
}

/** The `geodesic` column as a predicate on edge rows, or undefined when
 * the material has no geodesic edge — which every flat material is. */
export function geodesicEdges(m: Material): ((e: number) => boolean) | undefined {
  const col = m.edgeAttrs.geodesic;
  if (col === undefined || !col.some((v) => v !== 0)) return undefined;
  return (e) => col[e] !== 0;
}

/** @internal The material an area consumer reads: `m` itself, or — for a
 * material whose area is worked out on demand (a level set) — that area,
 * built on the first ask and kept. */
export function areaMaterial(m: Material): Material {
  const box = m.areaBox;
  if (box.material === null && box.make !== null) {
    box.material = box.make();
    box.make = null;
  }
  return box.material ?? m;
}

/**
 * @internal What an area consumer reads of `input`. A material whose area
 * is worked out on demand (a level set) is read as that area. An edge
 * selection of one is read as the matching selection of the area: its
 * edges, found there by id, and every closing run whose two ends are ends
 * of those edges — so `polygon(m.edges.filter((e) => e.level === 3))`
 * fills the regions of level 3. A selection of every edge is the whole
 * area, rings with no level line in them included. Anything else is read
 * as it is.
 */
export function areaView<T>(input: T): T | Material | Selection<Edge> {
  if (input instanceof Material) return areaMaterial(input);
  if (!isEdgeSelection(input)) return input;
  const source = input.source;
  const area = areaMaterial(source);
  if (area === source) return input;
  if (input.length === source.edgeCount) return area.edges;
  const lines = selectionIn(input, area);
  const cut = area.edgeAttrs.cut;
  if (cut === undefined) return lines;
  const ends = new Set<number>();
  for (const e of lines.indices) {
    ends.add(area.edgeList[2 * e]);
    ends.add(area.edgeList[2 * e + 1]);
  }
  // The closing runs: the components of the cut edges, each a path from one
  // line end to another (or a ring with no ends, which no line names).
  const parent = new Int32Array(area.n).map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const rimDegree = new Uint32Array(area.n);
  for (let e = 0; e < area.edgeCount; e++) {
    if (cut[e] === 0) continue;
    const a = area.edgeList[2 * e];
    const b = area.edgeList[2 * e + 1];
    rimDegree[a]++;
    rimDegree[b]++;
    parent[find(a)] = find(b);
  }
  // A run is kept when it has ends and every one of them is an end of the
  // selected lines.
  const keep = new Map<number, boolean>();
  for (let v = 0; v < area.n; v++) {
    if (rimDegree[v] !== 1) continue;
    const run = find(v);
    keep.set(run, (keep.get(run) ?? true) && ends.has(v));
  }
  const rows = [...lines.indices];
  for (let e = 0; e < area.edgeCount; e++) {
    if (cut[e] !== 0 && keep.get(find(area.edgeList[2 * e])) === true) rows.push(e);
  }
  return edgesOf(area, rows);
}
