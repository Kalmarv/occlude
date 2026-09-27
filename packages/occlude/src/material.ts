/**
 * Material: positions, connections and columns you can hold, write,
 * connect, resample and reinterpret.
 *
 * A `Material` is a set of vertices — `x`, `y` and any named columns —
 * plus an edge list. A ring, an open chain, a branching tree
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

import { pointsOf, edgesOf, edgeDomain, isPointSelection, isEdgeSelection, eligibleRows, type Where, type PointTypes, type EdgeTypes } from './relation.js';
import { ROW_TYPES, selectionIn, type Selection } from './selection.js';
import { euclideanSpace, type Space } from './space.js';
import { framePlacement, isPlacement, isSpacePlacement, spaceOfDoor, type Placement } from './placement.js';
import { chordMiddle, chordNamer, metricGap } from './chord.js';
import { radians } from './units.js';
import { chainsOf, curvesOf, chainTangents, chainLengths, type Curve } from './curves.js';
import { planarize, FaceTable, faceTableOf, boxGrid, faceLocator, faceCentroids, statedFor, statedFaceIds, isFaceSelection, type PlanarizeOpts, type Face, type StatedFaces } from './faces.js';
import type { IsoContour } from './isolines.js';
import { contourMoment } from './measure.js';
import type { Origin } from './shapes.js';
import { distanceField } from './distance.js';
import { numericLoops, refuseShape, type AreaInput } from './boundary.js';
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
import { ownerOf, ownedBy, pairKey, viewKind, RowView, rowViewKind } from './views.js';
import { Column, at64, atU32, columnOf, isTypedColumn, kinds, kindOf, kindWords, joinColumns, type AnyColumn, type AnyKind, type ColumnLike, type StringColumn } from './column.js';
import { carryLinks, derivation, linkRows, record, rowParam, rowSource, type Derivation, type DomainSpec, type Links, type RowSource } from './derivation.js';
import { cornersOf, cornerIndex, cornersAtPoint, facesAtPoint, type Corner } from './corners.js';
// The table writes and the recipes over them live in tables.ts; the
// methods here are their doors. Every use is at call time, so the cycle
// is safe, as it is for the kernels above.
import { extrude as extrudeRecipe, split as splitRecipe, move as moveRecipe, replace as replaceRecipe, restamp, rebuild, PointRows, EdgeRows, EdgeCells, addEdgeRows, storedValueOf, checkColumnName, checkNewColumnName, type CellValue, type Displacement, type EdgeEnd, type PointEnd, type ReplaceOpts } from './tables.js';

import { IDENTITY, apply as applyMat, mul as mulMat, rotate as rotateMat, scale as scaleMat, translate as translateMat } from './matrix.js';
import type { TransformOp } from './execution.js';
// The 3D words, called where the core declares them. The import cycle is
// the same kind as the kernels' above: every read is at call time.
import { translate3, rotate3, scale3, transform3, extrude3, smooth3, subdivide3, boolean3, dual3, displace3, along3, resample3, rebind3 } from './three/api/words.js';
import { realize as realize3, type RealizeOptions } from './three/api/instances.js';

// ---- the material --------------------------------------------------------------------

/** A vertex view: its row `index` in THIS state, its position, and every
 * column by name. A frozen snapshot of the state it came from, one per row
 * of that state, so two reads of a row are the same object. `index` is a
 * place in this state only; the view itself is the name of its row, and a
 * later state finds it (`later.points.rows(p)`, `has`). A view knows the
 * state that owns it (a private field, views.ts), so a force can tell
 * "this vertex of these sources" from a foreign point that happens to
 * share an index. */
export type Vertex = {
  readonly index: number;
  readonly x: number;
  readonly y: number;
  /** The third coordinate, for a point of a value in space (one whose
   * points have a `z` column); undefined for a point in the plane. */
  readonly z: number;
  /** @internal This vertex, for as long as it exists: the minted id, opaque
   * and never reused. The engine's own name for the row (ids are internal);
   * a sketch holds the view, which is the name. */
  readonly id: PointId;
  /** The vertices an edge joins this one to, in adjacency order. Topology
   * only: no spatial search — `cur.points.near(p, { radius })` is that. An
   * isolated vertex has none. */
  readonly adjacent: Selection<Vertex>;
  /** The edges that meet this vertex, in edge order. `p.edges.length` is
   * the degree; an isolated vertex has none. */
  readonly edges: Selection<Edge>;
  /** The faces that meet this point, in row order: a stated face whose
   * loop passes it, or a face read off the picture on either side of an
   * edge that meets it. */
  readonly faces: Selection<Face>;
  /** The corners at this point, in row order: one per stated face whose
   * loop passes it (corners.ts); none where the faces are read off the
   * picture. */
  readonly corners: Selection<Corner>;
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
  /** The point columns, read flat — `p.age` — of whatever kind each holds
   * (a number, a boolean, a string, a vector, the row a reference names, a
   * placement). */
} & { readonly [column: string]: any };

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
  /** @internal This edge, for as long as it exists: the minted id. A split
   * retires it and gives its children ids of their own. The engine's own
   * name for the row; a sketch holds the view. */
  readonly id: EdgeId;
  /**
   * @internal The oldest edge this one descends from — the WALL it is part
   * of. Lineage is identity, and identity is internal: a sketch asks a
   * split piece for its `source` (the edge it was cut from).
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
  /** The edge columns, read flat, as a vertex's are. */
} & { readonly [column: string]: any };

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
export type PointTransfer = 'interpolate' | 'nearest';

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
 * that shares no wall with any old face starts from. `kind` is the kind of
 * its values (column.ts), absent for numbers; a reference is kept as the
 * row's id, a vector as a frozen array. */
export interface FaceColumn {
  values: ReadonlyMap<string, unknown>;
  transfer: FaceTransfer;
  fallback?: unknown;
  kind?: AnyKind;
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
 * The identity of one vertex or one edge, for as long as it exists.
 *
 * An id is opaque: the type refuses arithmetic on it, it is equal only to
 * itself, and it is never reused. It is a NUMBER underneath, not a string,
 * because the ids are persistent numeric columns like any other (column.ts),
 * shared leaf by leaf between states. Ids are internal: a sketch never
 * names one — the view it holds is the name, and the library resolves the
 * view to its row by its id.
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
 *   `g.split(edges)`, a view of the parent edge names nothing in the new
 *   state, which is the same rule as "rows that are gone are skipped". The alternative — the first
 *   child inherits — is equally defensible and would silently change what
 *   `has` answers after a growth step, so it is written here rather than
 *   discovered later.
 *
 * Two counters, which never meet. A run mints from `RUN_BASE` up, and
 * starts there again every run, so the same sketch shows the same ids in a
 * warm studio worker as in a cold render. What is minted outside any run —
 * a value at module scope, made before the run or between two — counts up
 * from 1 and never starts over, so a module-scope value and a value the
 * run built never share an id by chance: the one is the other's lineage
 * only when one was made from the other. Each value is stamped with the
 * run whose ids it holds (`Material.epoch`; 0: none), and a value of one
 * run is no row of another (relation.ts `sameLineage`).
 */
export type PointId = number & { readonly __pointId: unique symbol };
export type EdgeId = number & { readonly __edgeId: unique symbol };

/** Where a run's ids start: far above anything minted outside a run, and
 * far below where a float stops counting whole numbers. */
const RUN_BASE = 2 ** 40;
/** The counter outside any run. Never reset. */
let outsideNext = 1;
/** The run's counter. Reset at the start of every run. */
let runNext = RUN_BASE + 1;
/** The run minting now (1, 2, …), or 0 outside any run. */
let epoch = 0;
/** How many runs have begun: the next run's number. */
let runs = 0;

/** @internal A run begins: its identities start over, and values made from
 * now on belong to it. Returns the run's number. Called once per execution. */
export function beginIds(): number {
  runs++;
  epoch = runs;
  runNext = RUN_BASE + 1;
  return epoch;
}

/** @internal A run ends: what is made after it is made outside any run. A
 * run that ended after another began changes nothing. */
export function endIds(run: number): void {
  if (epoch === run) epoch = 0;
}

/** @internal A fresh block of `count` ids, contiguous and never reused. */
export function mintIds(count: number): Float64Array {
  const out = new Float64Array(count);
  if (epoch === 0) for (let i = 0; i < count; i++) out[i] = outsideNext++;
  else for (let i = 0; i < count; i++) out[i] = runNext++;
  return out;
}

/**
 * @internal A material's columns, as persistent columns (column.ts). Every
 * state of a run shares the leaves it did not write.
 */
export interface MaterialStore {
  readonly x: Column;
  readonly y: Column;
  /** The point columns by name, each `n` long, of any kind (column.ts):
   * the numeric ones are `Column<Float64Array>`s, which is all a kernel
   * reads (`m.attrs`); a boolean, string, vector, reference or placement
   * column sits beside them in the same record, so the table writes keep,
   * append and gather every kind the one way. `z`, when the points have
   * one, is a numeric column like any other. */
  readonly attrs: Readonly<Record<string, AnyColumn>>;
  /** Their names and the columns, in the record's order: what a row view
   * reads. */
  readonly attrNames: readonly string[];
  readonly attrList: readonly AnyColumn[];
  /** One id per vertex row. Outside `attrs` on purpose: a column would be
   * interpolated at every split (a mean of two ids is a forged id), would
   * be demanded of every `points.add` caller, and would appear as a plain
   * number on a vertex view — the opposite of opaque. */
  readonly pointIds: Column;
  /** The edge list, two values a row: `[a0, b0, a1, b1, …]`. */
  readonly edgeList: Column<Uint32Array>;
  /** The edge columns by name, each one value a row, of any kind (as
   * `attrs`). */
  readonly edgeAttrs: Readonly<Record<string, AnyColumn>>;
  readonly edgeAttrNames: readonly string[];
  readonly edgeAttrList: readonly AnyColumn[];
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
  /**
   * The kernel's own name for each point row, and for each edge row: a
   * string the 3D layer's kernels order by and seed from (a structural
   * name such as `v3` or `f2:v1`), carried beside the ids by every write
   * that keeps the row, `''` for a row a write made. Null for a value no
   * 3D word made. Never a column, never public: the id is the identity,
   * and this is the name a kernel knows the row by.
   */
  readonly pointKeys: StringColumn | null;
  readonly edgeKeys: StringColumn | null;
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
  for (let k = 0; k < names.length; k++) {
    const col = cols[k];
    if (col instanceof Column) v[names[k]] = at64(col, i);
    else typedCell(m, v, names[k], col, i);
  }
  return v as unknown as Vertex;
}

/**
 * @internal Row `i` of a column that is not numbers, onto the view `v`
 * of `m`: a boolean, a string or a placement as it is, a vector as a
 * frozen array, and a reference as the row it names in `m` — read when it
 * is asked for, so a view never makes the view it points at — or null
 * when it names none, or a row that is gone.
 */
export function typedCell(m: Material, v: Record<string, unknown>, name: string, col: Exclude<AnyColumn, Column>, i: number): void {
  const kind = col.kind;
  if (kind.name === 'reference') {
    const id = (col as { get(i: number): number | null }).get(i);
    Object.defineProperty(v, name, { get: () => referenced(m, id), enumerable: true });
  } else if (kind.name === 'vector') {
    v[name] = Object.freeze((col as { get(i: number): number[] }).get(i));
  } else {
    v[name] = (col as { get(i: number): unknown }).get(i);
  }
}

/** @internal The row an id names in `m` — a vertex, else an edge (one id
 * counter serves both) — or null for none. */
export function referenced(m: Material, id: number | null): Vertex | Edge | null {
  if (id === null) return null;
  const p = m.rowOfPoint(id as PointId);
  if (p >= 0) return m.vertex(p);
  const e = m.rowOfEdge(id as EdgeId);
  return e >= 0 ? m.edge(e) : null;
}

/** @internal The vertex a write or a kernel hands to a callback for each
 * of `count` rows of `m`: the state's one view of that row, as
 * `m.vertex(i)` — a callback's argument is a view like any other, so
 * `===` holds between it and every other read of the row (`f.source === p`
 * inside a `move`) — read from the state's array of every row, which a
 * pass over many rows makes once when it starts. */
export function vertexReader(m: Material, count: number): (i: number) => Vertex {
  if (count <= FEW_VIEWS) return (i) => m.vertex(i);
  const rows = pointViews(m).every();
  return (i) => rows[i] ?? (rows[i] = Object.freeze(vertexView(m, i)));
}

/** @internal The edge a write or a kernel hands to a callback, for a pass
 * over `count` rows, as `vertexReader`. */
export function edgeReader(m: Material, count: number): (e: number) => Edge {
  if (count <= FEW_VIEWS) return (e) => m.edge(e);
  const rows = edgeViews(m).every();
  return (e) => rows[e] ?? (rows[e] = edgeView(m, e));
}

/** Kept views past which a state's view cache is an array by row. */
const FEW_VIEWS = 32;

/**
 * @internal What a state works out the first time it is asked, and keeps:
 * ONE record per value (`m.cache`), made with it — a material is frozen,
 * so this is its one mutable part — and filled on first ask, so a state
 * that is never asked costs one empty object. A module that keeps
 * something on a state declares its entry here by declaration merging,
 *
 *   declare module './material.js' { interface StateCache { bow?: number } }
 *
 * and reads it with `cached(m, 'bow', () => …)` (or `m.cache.bow ??= …`).
 * On the value, never in a weak map keyed by it: an entry of a weak map is
 * only let go by a full collection, so a run of short-lived states would
 * stay alive through the minor ones (derivation.ts).
 */
export interface StateCache {
  /** Rows adjacent to each row, and edge rows meeting each row, in edge order. */
  adjRows?: number[][];
  adjEdges?: number[][];
  /** id → row, per domain. */
  pointRows?: Map<number, number>;
  edgeRows?: Map<number, number>;
  /** The row views: one frozen object per row, so `===` names a row. */
  pointViews?: RowViews<Vertex>;
  edgeViews?: RowViews<Edge>;
  /** The face collection. */
  faces?: FaceTable;
  /** The flat attribute records the kernels read. */
  attrs?: Readonly<Record<string, Float64Array>>;
  edgeAttrs?: Readonly<Record<string, Float64Array>>;
  /** A level set's area: how to make it, and it once made (`areaMaterial`). */
  areaMake?: () => Material;
  area?: Material;
  /** What a derivation keeps on the value it made (derivation.ts): its node,
   * and the links that answer each row's `source` and `u`. */
  links?: Links;
  node?: Derivation;
}

/** @internal The entry `key` of `m`'s cache, made by `make` the first time. */
export function cached<K extends keyof StateCache>(m: Material, key: K, make: () => NonNullable<StateCache[K]>): NonNullable<StateCache[K]> {
  return (m.cache[key] ??= make()) as NonNullable<StateCache[K]>;
}

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
const pointViews = (m: Material): RowViews<Vertex> => (m.cache.pointViews ??= new RowViews<Vertex>(m.n));
const edgeViews = (m: Material): RowViews<Edge> => (m.cache.edgeViews ??= new RowViews<Edge>(m.edgeCount));

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
  for (let k = 0; k < names.length; k++) {
    const col = cols[k];
    if (col instanceof Column) v[names[k]] = at64(col, e);
    else typedCell(m, v, names[k], col, e);
  }
  v.a = a;
  v.b = b;
  // A length of the material's space; the flat plane keeps the old
  // expression, and a value whose points have a `z` measures in 3D.
  const z = store.attrs.z;
  v.length = m.space !== undefined && m.space.kind !== 'euclidean'
    ? m.space.distance(a, b)
    : z instanceof Column ? Math.hypot(b.x - a.x, b.y - a.y, at64(z, b.index) - at64(z, a.index)) : distance(a, b);
  v.index = e;
  return Object.freeze(v) as unknown as Edge;
}

/** A frozen record of the NUMERIC flat columns by name, each joined the
 * first time its name is read: the kernels' view of a column record. A
 * column of another kind is not in it — kernels and the engine read
 * numbers — and rides beside it in the store. */
function flatRecord(cols: Readonly<Record<string, AnyColumn>>): Readonly<Record<string, Float64Array>> {
  const out: Record<string, Float64Array> = {};
  for (const name in cols) {
    const col = cols[name];
    if (!(col instanceof Column)) continue;
    Object.defineProperty(out, name, { get: () => col.flat(), enumerable: true });
  }
  return Object.freeze(out);
}

/** The column of a column record's entry: a column of any kind as it is,
 * a typed array adopted as a numeric column. */
function anyColumnOf(v: ColumnLike<Float64Array> | AnyColumn): AnyColumn {
  return isTypedColumn(v) ? v : columnOf(v as ColumnLike<Float64Array>);
}

/** id → row over an id column, the later row winning a repeat. */
function idMap(ids: Column): Map<number, number> {
  const map = new Map<number, number>();
  let i = 0;
  for (const leaf of ids.leaves()) for (let k = 0; k < leaf.length; k++, i++) map.set(leaf[k], i);
  return map;
}

/** How far, in sketch units, a moved edge's middle may stand from the
 * chord its moved ends draw before `m.transform` samples it, when the
 * placement's door carries no metric `bow` — a space built with no
 * paper. */
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
  // The faces that meet this point, and its corners (corners.ts).
  faces: { get(this: Vertex) { return facesAtPoint(stateOf(this), this.index); } },
  corners: { get(this: Vertex) { return cornersAtPoint(stateOf(this), this.index); } },
  // A point with a heading — a point of `along`, a point of a curve —
  // has a frame: the unit tangent, the normal (`perp` of it), and the
  // placement there. Derived from the heading on every read.
  // A column of the row's own with one of these names wins, as `u` does: a
  // point of a curve in space carries its `tangent` (there is no heading
  // in space), and the setter is how a view is given one.
  tangent: {
    get(this: Vertex) { const h = (this as Record<string, number>).heading; return typeof h === 'number' ? [Math.cos(h), Math.sin(h)] as Vec : undefined; },
    set(this: Vertex, v: unknown) { Object.defineProperty(this, 'tangent', { value: v, writable: true, enumerable: true, configurable: true }); },
  },
  normal: {
    get(this: Vertex) { const h = (this as Record<string, number>).heading; return typeof h === 'number' ? [-Math.sin(h), Math.cos(h)] as Vec : undefined; },
    set(this: Vertex, v: unknown) { Object.defineProperty(this, 'normal', { value: v, writable: true, enumerable: true, configurable: true }); },
  },
  placement: {
    set(this: Vertex, v: unknown) { Object.defineProperty(this, 'placement', { value: v, writable: true, enumerable: true, configurable: true }); },
    get(this: Vertex) { return placementOf; },
  },
};

/** `p.placement()`: the frame at a point with a heading. */
function placementOf(this: Vertex): Placement {
  const h = (this as Record<string, number>).heading;
  if (typeof h !== 'number') throw new Error('p.placement: this point has no heading — the points of m.along() and of a curve (c.points) have one');
  return framePlacement((stateOf(this).space ?? euclideanSpace()).model, { x: this.x, y: this.y, heading: h });
}

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
  // In space, the middle in space.
  center: {
    get(this: Edge) {
      const z = stateOf(this).store.attrs.z;
      if (!(z instanceof Column)) return [(this.a.x + this.b.x) / 2, (this.a.y + this.b.y) / 2] as Vec;
      return [(this.a.x + this.b.x) / 2, (this.a.y + this.b.y) / 2, (at64(z, this.a.index) + at64(z, this.b.index)) / 2];
    },
  },
  // Every edge at either end, minus this one, each once (relation.ts).
  adjacent: { get(this: Edge) { const owner = stateOf(this); return edgesOf(owner, edgeDomain(owner).neighbours(this.index), undefined, true); } },
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
  readonly transfers: Readonly<Record<string, PointTransfer>>;
  /** @internal Declared transfer policy per edge column (default copy). */
  readonly edgeTransfers: Readonly<Record<string, EdgeTransfer>>;
  /** @internal What this state works out on first ask and keeps
   * (`StateCache`): one record, made with the state and filled lazily —
   * the one mutable part of a frozen material. */
  readonly cache: StateCache;
  /** @internal The run whose ids this value holds (0: none; see `mintIds`):
   * a value made from another carries that one's. Non-enumerable. */
  declare readonly epoch: number;
  /** @internal The faces the word that made this material stated (a tiling,
   * a grid, Voronoi cells, a quadtree), kept while the edges are the ones
   * they were stated over; undefined when the faces are read off the
   * picture. Non-enumerable, like `space`. */
  declare readonly stated: StatedFaces | undefined;
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
  /**
   * The value's own name, when a word gave it one: a 3D object's `key`,
   * which names the random stream a scatter on it draws from and the
   * object in a view. Carried as the space is — by every write, every verb
   * that rebuilds the value and every step of `t.steps` — and absent on a
   * value nothing named. Non-enumerable, as `space` is.
   */
  declare readonly key: string | undefined;
  /**
   * The prototype a value of instances places at its points (occlude/3d's
   * `instanceOnPoints` and `instanceOnFaces`), or undefined for a value that
   * places nothing. Carried as the key is, so every write and every verb
   * that keeps the points keeps what they place. Non-enumerable.
   */
  declare readonly prototype: Material | undefined;

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
    attrs: Readonly<Record<string, ColumnLike<Float64Array> | AnyColumn>>,
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
      edgeAttrs?: Readonly<Record<string, ColumnLike<Float64Array> | AnyColumn>>;
      transfers?: Record<string, PointTransfer>;
      edgeTransfers?: Record<string, EdgeTransfer>;
      /** The identity of each row, carried from wherever these rows came
       * from. Absent means this is new geometry, and the constructor
       * mints. `edgeRoots` says which older edge each edge descends from;
       * absent means each edge is its own root. */
      ids?: { points?: ColumnLike<Float64Array>; edges?: ColumnLike<Float64Array>; edgeRoots?: ColumnLike<Float64Array> };
      /** The kernel's name of each row (see `MaterialStore.pointKeys`). */
      keys?: { points?: StringColumn | null; edges?: StringColumn | null };
      /** Face columns, carried from the state these rows came from. */
      faceAttrs?: Record<string, FaceColumn>;
      /** The space the coordinates belong to (see `Material.space`). */
      space?: Space;
      /** The value's key (see `Material.key`). */
      key?: string;
      /** The prototype the value's points place (see `Material.prototype`). */
      prototype?: Material;
      /** The value these rows were made from: the space, the key and the
       * prototype are taken from it when not given, so a derived material is
       * in the space of its source, and keeps its name, without a word to
       * say so. */
      from?: { readonly space?: Space | undefined; readonly key?: string | undefined; readonly prototype?: Material | undefined; readonly epoch?: number };
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
    const edgeCols: Record<string, AnyColumn> = {};
    for (const name in carry.edgeAttrs ?? {}) {
      const col = anyColumnOf(carry.edgeAttrs![name]);
      if (col.length !== edgeCount) {
        throw new Error(`material: edge attribute '${name}' has ${col.length} values for ${edgeCount} edges`);
      }
      checkColumnName('edge', name, 'material');
      edgeCols[name] = col;
    }
    const pointCols: Record<string, AnyColumn> = {};
    for (const name in attrs) {
      const col = anyColumnOf(attrs[name]);
      if (col.length !== n) {
        throw new Error(`material: attribute '${name}' has ${col.length} values for ${n} vertices`);
      }
      checkNewColumnName('point', name, 'material');
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
    this.cache = carry.area === undefined ? {} : { areaMake: carry.area };
    Object.defineProperty(this, 'epoch', { value: carry.from?.epoch ?? epoch, enumerable: false });
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
    const pointKeys = carry.keys?.points ?? null;
    const edgeKeys = carry.keys?.edges ?? null;
    if (pointKeys !== null && pointKeys.length !== n) throw new Error(`material: ${pointKeys.length} point keys for ${n} vertices`);
    if (edgeKeys !== null && edgeKeys.length !== edgeCount) throw new Error(`material: ${edgeKeys.length} edge keys for ${edgeCount} edges`);
    this.store = Object.freeze({
      x: xs, y: ys, attrs: Object.freeze(pointCols), attrNames: Object.freeze(Object.keys(pointCols)), attrList: Object.freeze(Object.values(pointCols)), pointIds,
      edgeList: list, edgeAttrs: Object.freeze(edgeCols), edgeAttrNames: Object.freeze(Object.keys(edgeCols)), edgeAttrList: Object.freeze(Object.values(edgeCols)), edgeIds, edgeRoots,
      pointKeys, edgeKeys,
    });
    for (const name of Object.keys(faceAttrs)) {
      checkColumnName('face', name, 'material');
    }
    this.faceAttrs = faceAttrs;
    Object.defineProperty(this, 'space', { value: carry.space ?? carry.from?.space, enumerable: false });
    const key = carry.key ?? carry.from?.key;
    if (key !== undefined && typeof key !== 'string') throw new Error(`material: a key is a string — got ${typeof key}`);
    Object.defineProperty(this, 'key', { value: key, enumerable: false });
    Object.defineProperty(this, 'prototype', { value: carry.prototype ?? carry.from?.prototype, enumerable: false });
    Object.defineProperty(this, 'stated', { value: statedFor(carry.faces, list, edgeIds), enumerable: false });
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
    return (this.cache.attrs ??= flatRecord(this.store.attrs));
  }
  /** @internal Edge list, stored order, `[a0, b0, a1, b1, …]`. Undirected for
   * connectivity; the stored direction is what `edges`, `split` (`at`)
   * and the order of `curves` see. */
  get edgeList(): Uint32Array { return this.store.edgeList.flat(); }
  /** @internal Edge attribute columns by name, each `edgeCount` long. A
   * sketch reads a column on an edge row: `e.rest`. */
  get edgeAttrs(): Readonly<Record<string, Float64Array>> {
    return (this.cache.edgeAttrs ??= flatRecord(this.store.edgeAttrs));
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
    const box = this.cache;
    if (box.adjRows !== undefined) return box.adjRows;
    const rows: number[][] = Array.from({ length: this.n }, () => []);
    for (const leaf of this.store.edgeList.leaves()) {
      for (let k = 0; k < leaf.length; k += 2) {
        rows[leaf[k]].push(leaf[k + 1]);
        rows[leaf[k + 1]].push(leaf[k]);
      }
    }
    box.adjRows = rows;
    return rows;
  }

  /** Edge rows meeting each row, in edge order. Lazy, like `adj`. */
  private get edgeAdj(): number[][] {
    const box = this.cache;
    if (box.adjEdges !== undefined) return box.adjEdges;
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
    box.adjEdges = rows;
    return rows;
  }

  /**
   * @internal The row an id is at in THIS state, or -1 when it is gone.
   *
   * This is how a later step finds what an earlier one marked: store
   * `p.id` in a column, and `m.rowOfPoint(id)` says where it went. The map
   * is built the first time it is asked for, like the adjacency.
   */
  rowOfPoint(id: PointId): number {
    const map = (this.cache.pointRows ??= idMap(this.store.pointIds));
    return map.get(id) ?? -1;
  }

  /** @internal The edge row an id is at in this state, or -1 when it is gone (a
   * split retires the parent, so its id resolves to nothing). */
  rowOfEdge(id: EdgeId): number {
    const map = (this.cache.edgeRows ??= idMap(this.store.edgeIds));
    return map.get(id) ?? -1;
  }

  /**
   * @internal The vertex an id names in this state, or undefined when it
   * is gone. The engine's door: ids are internal, and a sketch finds a row
   * of another state through the view it holds (`sel.has(p)`,
   * `g.points.without(held)`, a write's `where`).
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

  /** @internal The edge an id names in this state, or undefined when it is
   * gone; a split retires the parent, so its id resolves to nothing.
   * `edge(row)` is the same question asked by position. */
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
    return planarize(this, opts);
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
    return (this.cache.faces ??= new FaceTable(this, this.stated)).all;
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
   * The corners: one row per place a stated face's loop passes a point —
   * a face-vertex pair — face by face, round each face (corners.ts). A
   * corner answers its `point` and its `face`, and holds columns of any
   * kind (`corners.set`). They are the stated faces' own: kept by every
   * write that keeps the edges, gone with the faces when one changes them.
   * A geometry whose faces are read off the picture, or that has none, has
   * no corners — an empty selection.
   */
  get corners(): Selection<Corner> {
    return cornersOf(this);
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
    // A face or corner column is smoothed over the faces (3D).
    const onFaces = Object.hasOwn(this.faceAttrs, name);
    if (!onPoints && !onEdges && (onFaces || Object.hasOwn(this.stated?.corners ?? {}, name))) return smooth3(this, onFaces ? 'faces' : 'corners', name, opts);
    if (!onPoints && !onEdges) throw new Error(`smooth: no ${inSpace3(this) ? 'point, edge, face or corner' : 'point or edge'} column '${name}' to smooth`);
    if (steps === 0) return material(this);
    const src = material(this);
    let cur = Float64Array.from(onPoints ? src.attrs[name] : src.edgeAttrs[name]);
    // The neighbourhood, once: a point's joined points, or an edge's
    // edges through either end.
    const rows = cur.length;
    const nb: readonly (readonly number[])[] = onPoints
      ? Array.from({ length: rows }, (_, i) => [...src.adjacentRows(i)])
      : Array.from({ length: rows }, (_, e) => edgeDomain(src).neighbours(e));
    for (let k = 0; k < steps; k++) {
      const next = new Float64Array(rows);
      for (let i = 0; i < rows; i++) {
        let sum = cur[i];
        for (const j of nb[i]) sum += cur[j];
        next[i] = sum / (nb[i].length + 1);
      }
      cur = next;
    }
    return onPoints ? src.points.set(name, (p: Vertex) => cur[p.index]) : src.edges.set(name, (e: Edge) => cur[e.index]);
  }

  /**
   * Resample the material's chains evenly by arc length — the explicit,
   * lossy redistribution of sampled material after it has been deformed.
   * It walks `curves`: each chain gets `count` vertices, or as many as
   * fit at `spacing` (at least 2 open, 3 closed); open chains keep both
   * endpoints, closed ones keep their seam at their first vertex — the same
   * rows, ids and all, so a held end or seam still names its row; only the
   * samples between are new. On a
   * network — a hex field, a tiling, a voronoi — a chain runs from one
   * junction to the next, and every junction and loose end stays where it
   * is and who it is: one vertex, the same row, every chain still meeting
   * there. Corners are NOT preserved: a new vertex
   * lands on the old polyline, but a corner between two new vertices is
   * cut. Columns carry over per `transfer` (default: linear
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
    if (inSpace3(this)) return resample3(this, opts);
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
   * column still finds its faces. An edge column that is `'distribute'` is
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
    const X = this.x;
    const Y = this.y;
    const L = this.edgeList;
    const points = new PointRows(this, 'spline');
    const edges = new EdgeRows(this);
    const storedRow = new Map<number, number>();
    for (let e = 0; e < this.edgeCount; e++) storedRow.set(pairKey(L[2 * e], L[2 * e + 1]), e);
    const rowOf = new Map<number, number>();
    // A source vertex, verbatim — not through the transfer policy, which
    // says what a value does at a NEW vertex. A vertex two segments share is
    // one row.
    const rowFor = (v: number): number => {
      const had = rowOf.get(v);
      if (had !== undefined) return had;
      const row = points.keep(v);
      rowOf.set(v, row);
      return row;
    };
    /** One source edge through as it is: same row, same lineage. */
    const keep = (a: number, b: number, row: number) => edges.keep(row, rowFor(a), rowFor(b));
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
        const m0x = tension * (X[p2] - X[p0]);
        const m0y = tension * (Y[p2] - Y[p0]);
        const m1x = tension * (X[p3] - X[p1]);
        const m1y = tension * (Y[p3] - Y[p1]);
        const rows: number[] = [rowFor(p1)];
        for (let i = 1; i < steps; i++) {
          const u = i / steps;
          const u2 = u * u;
          const u3 = u2 * u;
          const h00 = 2 * u3 - 3 * u2 + 1;
          const h10 = u3 - 2 * u2 + u;
          const h01 = -2 * u3 + 3 * u2;
          const h11 = u3 - u2;
          // A new vertex, its columns read between p1 and p2 at u.
          rows.push(points.between(
            p1, p2, u,
            h00 * X[p1] + h10 * m0x + h01 * X[p2] + h11 * m1x,
            h00 * Y[p1] + h10 * m0y + h01 * Y[p2] + h11 * m1y,
          ));
        }
        rows.push(rowFor(p2));
        // A 'distribute' column is shared over the children by their share
        // of the arc the segment now takes, so the quantity the source edge
        // carried is still what its children carry between them.
        const spans: number[] = [];
        let total = 0;
        for (let i = 1; i < rows.length; i++) {
          const d = Math.hypot(points.x[rows[i]] - points.x[rows[i - 1]], points.y[rows[i]] - points.y[rows[i - 1]]);
          spans.push(d);
          total += d;
        }
        for (let i = 1; i < rows.length; i++) edges.from(row, rows[i - 1], rows[i], total > 0 ? spans[i - 1] / total : 1 / spans.length);
      }
    }
    return rebuild(this, { ...points.done(), ...edges.done() });
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
    const X = this.x;
    const Y = this.y;
    const L = this.edgeList;
    const points = new PointRows(this, 'trim');
    const edges = new EdgeRows(this);
    const storedRow = new Map<number, number>();
    for (let e = 0; e < this.edgeCount; e++) storedRow.set(pairKey(L[2 * e], L[2 * e + 1]), e);
    // A vertex this call does not touch, verbatim, and once: a junction the
    // chains share is one row. A cut end, blended.
    const rowOf = new Map<number, number>();
    const keep = (v: number): number => {
      const had = rowOf.get(v);
      if (had !== undefined) return had;
      const row = points.keep(v);
      rowOf.set(v, row);
      return row;
    };
    const cut = (a: number, b: number, t: number): number => {
      if (curved) {
        const g = curved.geodesic([X[a], Y[a]], [X[b], Y[b]], t);
        return points.between(a, b, t, g[0], g[1]);
      }
      return points.between(a, b, t, X[a] + (X[b] - X[a]) * t, Y[a] + (Y[b] - Y[a]) * t);
    };
    // A piece keeps the LINEAGE of the source edge it is a piece of even
    // when its own id is retired; an edge that survives whole is that edge.
    // Either way it takes the edge's columns as they are.
    const join = (from: number, to: number, sourceEdge: number, whole: boolean) => {
      if (whole) edges.keep(sourceEdge, from, to);
      else edges.from(sourceEdge, from, to);
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
      const pts = idx.map((i) => [X[i], Y[i]] as [number, number]);
      const cum = chainLengths(pts, false, space);
      const total = cum[cum.length - 1];
      // A junction is not an end: nothing is cut there.
      const from = this.adj[idx[0]].length > 2 ? 0 : head;
      const to = this.adj[idx[idx.length - 1]].length > 2 ? total : total - tail;
      // Nothing survives the cut: this chain draws nothing.
      if (!(to > from)) continue;
      // The segment a distance falls on, and how far along it. Distances
      // are asked for in increasing order, so the walk goes on from the
      // last answer, and starts over only for a shorter one.
      let s = 0;
      let last = -Infinity;
      const at = (d: number): [number, number] => {
        if (d < last) s = 0;
        last = d;
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
    return rebuild(this, { ...points.done(), ...edges.done() });
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
    // A value in space is walked in space.
    if (inSpace3(this)) return along3(this, opts);
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
  transform(op: Placement | Placement<Vec3> | TransformRecord): Material {
    if (isSpacePlacement(op)) return transform3(this, op);
    // A placement or a record of the plane moves sketch points: on a value
    // in space it would move x and y and leave z, which is no motion of
    // space at all.
    if (inSpace3(this) && typeof op === 'object' && op !== null) {
      throw new Error('m.transform: transform takes a placement of 3D space — an observer, or one of a honeycomb\'s placements; a placement of the plane moves sketch points');
    }
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
    const X = this.x;
    const Y = this.y;
    const L = this.edgeList;
    /** An edge's SOURCE curve, as the ink reads it. */
    const source = (e: number): [Vec, Vec] => {
      const a = L[2 * e];
      const b = L[2 * e + 1];
      return chord([X[a], Y[a]], [X[b], Y[b]]);
    };
    const nx: number[] = [];
    const ny: number[] = [];
    for (let i = 0; i < this.n; i++) {
      const q = move(X[i], Y[i]);
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
    if (!split) return rebuild(this, { x: Column.of(Float64Array.from(nx)), y: Column.of(Float64Array.from(ny)) });
    // Every vertex keeps its row and its id, moved; the samples come after.
    const points = new PointRows(this, 'm.transform');
    for (let i = 0; i < this.n; i++) points.keep(i, nx[i], ny[i]);
    const edges = new EdgeRows(this);
    for (let e = 0; e < this.edgeCount; e++) {
      const a = L[2 * e];
      const b = L[2 * e + 1];
      const ts = cuts[e];
      if (ts.length === 0) {
        edges.keep(e, a, b);
        continue;
      }
      const [p0, p1] = source(e);
      const rows = [a];
      for (const t of ts) {
        const q = move(p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t);
        rows.push(points.between(a, b, t, q[0], q[1]));
      }
      rows.push(b);
      const params = [0, ...ts, 1];
      for (let k = 0; k + 1 < rows.length; k++) edges.from(e, rows[k], rows[k + 1], params[k + 1] - params[k]);
    }
    return rebuild(this, { ...points.done(), ...edges.done() });
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
  scale(k: number | readonly [number, number] | Vec3, opts: { origin?: Origin | Vec3 } = {}): Material {
    // Three factors scale in space, and so does one on a value in space:
    // `scale(k)` there is `scale([k, k, k])`.
    if ((Array.isArray(k) && k.length === 3) || (typeof k === 'number' && inSpace3(this))) return scale3(this, k, opts);
    const [kx, ky] = typeof k === 'number' ? [k, k] : [k[0], k[1]];
    // A factor or a pivot that is not finite scales nothing, as `move` moves
    // nothing by it.
    const pivot = this.pivot('m.scale', opts.origin);
    if (!Number.isFinite(kx) || !Number.isFinite(ky) || pivot === undefined) return this;
    const [ox, oy] = pivot;
    return mapPositions(this, (p) => [ox + (p.x - ox) * kx, oy + (p.y - oy) * ky], 'm.scale');
  }

  /**
   * Every vertex rotated about `origin` by `degrees`, counter-clockwise, as
   * `turn` and a group's `rotate` read them. The pivot is the one `scale`
   * reads. It is `map` underneath, so every id and every column carries.
   */
  rotate(degrees: number, opts?: { origin?: Origin }): Material;
  /** In space: by angles about the axes (degrees), or a rotation, about a
   * pivot. */
  rotate(angles: Vec3 | object, pivot?: Vec3 | object): Material;
  /** In space: about an axis — `'x'`, `'y'`, `'z'` or a direction — by
   * `degrees`. */
  rotate(axis: 'x' | 'y' | 'z' | Vec3, degrees: number, options?: object): Material;
  rotate(degrees: unknown, opts: unknown = {}, more?: unknown): Material {
    // In space a number of degrees turns about z: `rotate(n)` is
    // `rotate('z', n)`.
    if (typeof degrees !== 'number') return rotate3(this, degrees, opts, more);
    if (inSpace3(this)) return rotate3(this, 'z', degrees, opts);
    const o = (opts ?? {}) as { origin?: Origin };
    // An angle or a pivot that is not finite turns nothing, as `move` moves
    // nothing by it.
    const pivot = this.pivot('m.rotate', o.origin);
    if (!Number.isFinite(degrees) || pivot === undefined) return this;
    const [ox, oy] = pivot;
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
  translate(by: XY | Vec3): Material {
    if (isVec3(by)) return translate3(this, by);
    const dx = vx(by);
    const dy = vy(by);
    // An offset that is not finite moves nothing, as `move` moves nothing by it.
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return this;
    return mapPositions(this, (p) => [p.x + dx, p.y + dy], 'm.translate');
  }

  /** @internal The pivot `scale` and `rotate` read: the user origin when
   * unset, `'center'` this material's bounds centre, `'centroid'` its area
   * centroid (see `scale`). An empty material pivots on the origin; a point
   * that is not finite is no pivot (undefined). */
  pivot(verb: string, origin: Origin | undefined): Vec | undefined {
    if (origin === undefined) return [0, 0];
    if (origin === 'center' || origin === 'centroid') {
      if (this.n === 0) return [0, 0];
      const X = this.x;
      const Y = this.y;
      if (origin === 'centroid') {
        const c = areaCentroid(this.contours());
        if (c) return c;
        let mx = 0, my = 0;
        for (let i = 0; i < this.n; i++) { mx += X[i]; my += Y[i]; }
        return [mx / this.n, my / this.n];
      }
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < this.n; i++) {
        x0 = Math.min(x0, X[i]); x1 = Math.max(x1, X[i]);
        y0 = Math.min(y0, Y[i]); y1 = Math.max(y1, Y[i]);
      }
      return [(x0 + x1) / 2, (y0 + y1) / 2];
    }
    if (typeof origin === 'string') throw new Error(`${verb}: origin is a point ([x, y] or { x, y }), 'center' or 'centroid' — got '${origin}'`);
    const x = vx(origin);
    const y = vy(origin);
    return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : undefined;
  }

  /** Thickness around this material's chains: an outline at the radius each
   * vertex asks for. See `ThickenOpts`. */
  thicken(opts: ThickenOpts): Material {
    return thickenKernel(this, opts);
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
  extrude(from: PointEnd | undefined, offset: XY | Vec3, cols?: Record<string, CellValue>): Material;
  /** In space: the faces pushed out by `offset` — a distance along each
   * face's normal, a 3-vector, a function of the extruded region, or
   * `{ distance }` — with walls round each region (3D). */
  extrude(faces: Selection<Face>, offset: number | Vec3 | ((region: any) => Vec3) | { readonly distance: unknown }, options?: object): Material;
  extrude(from: PointEnd | Selection<Face> | undefined, offset: unknown, cols?: unknown): Material {
    // Faces extrude in 3D (the words a 2D and a 3D value share are told
    // apart by what they take): see three/api/words.ts.
    if (isFaceSelection(from)) return extrude3(this, from, offset, cols);
    return extrudeRecipe(this, from, offset as XY | Vec3, cols as Record<string, CellValue> | undefined);
  }

  /**
   * Each edge cut at `at` of the way along it (a → b as stored), default
   * the middle: add the point, remove the edge, add the two edges through
   * the point. Point columns cross by their transfer policy; the two new
   * edges keep the parent's lineage root and take its columns, a
   * `'distribute'` one by each part's share. `at` may be a function of the
   * edge; one that is not finite skips that edge, and one outside 0…1 is
   * read as the nearer end, where a cut makes nothing. `edges` is a
   * selection, an edge value or an edge view, or a list of them. A cut
   * whose new point or pieces would hold a value that is not finite leaves
   * that edge as it is.
   */
  split(edges: Selection<Edge> | EdgeEnd | readonly EdgeEnd[] | undefined, at?: number | ((e: Edge) => number)): Material {
    return splitRecipe(this, edges, at);
  }

  /**
   * Every point moved by the SUM of the displacements, in one instant:
   * each is read on this state. A displacement is a vector, a function of
   * the point `(p) => [dx, dy]`, or a force made without its state —
   * `force.tension({ rest })` — which the move prepares from this material
   * once. A last argument that is a point selection, a point value, a
   * vertex or a list of them says which points move. A step with a third
   * number moves in space, and gives a value that had none a `z`. A move
   * that is not finite leaves that
   * point where it is; in a curved space a point walks the geodesic. To
   * put a point at a position rather than move it by a step, set its `x`
   * and `y`: `g.points.set({ x: …, y: … })`.
   */
  move(...args: [...Displacement[]] | [...Displacement[], Selection<Vertex> | PointEnd | readonly PointEnd[] | undefined]): Material {
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
  replace(edges: Selection<Edge> | EdgeEnd | readonly EdgeEnd[] | undefined, motif: Material, opts?: ReplaceOpts): Material {
    return replaceRecipe(this, edges, motif, opts);
  }

  /** @internal This material with the states a `t.steps` run kept: what
   * the run returns when it is asked for `{ every }`. */
  withHistory(states: readonly Material[]): Material {
    return restamp(this, this.iteration, states);
  }

  // ---- the 3D words (three/api/words.ts) ----

  /** Every face cut into smaller faces, `levels` times, the surface
   * smoothed as it goes (3D). */
  subdivide(levels?: number, options?: object): Material {
    return subdivide3(this, levels, options as never);
  }

  /** The solid this geometry and `other` fill together (3D). */
  union(other: Material): Material {
    return boolean3('union')(this, other);
  }

  /** The solid this geometry fills and `other` does not (3D). */
  subtract(other: Material): Material {
    return boolean3('subtract')(this, other);
  }

  /** The solid both fill (3D). */
  intersect(other: Material): Material {
    return boolean3('intersect')(this, other);
  }

  /** Re-attach what was made on a surface — scattered samples, points
   * sampled on surface curves, the surface curves themselves — to an
   * edited revision of that surface, or of each surface (3D). */
  rebind(target: Material | readonly Material[]): Material {
    return rebind3(this, target);
  }

  /** One ordinary value from every copy instances place: the prototype's
   * faces, edges and points once for each copy, where it stands (3D).
   * Each row's `source` is the prototype row and the instance. */
  realize(options?: RealizeOptions): Material {
    return realize3(this, options);
  }

  /**
   * The length of every edge, summed: a curve's length. Measured in the
   * value's space, and in space for a value whose points have a `z`.
   */
  get length(): number {
    const { x, y, edgeList } = this.store;
    const z = this.store.attrs.z;
    const sp = this.space !== undefined && this.space.kind !== 'euclidean' ? this.space : null;
    let sum = 0;
    for (let e = 0; e < this.edgeCount; e++) {
      const a = atU32(edgeList, 2 * e);
      const b = atU32(edgeList, 2 * e + 1);
      const ax = at64(x, a);
      const ay = at64(y, a);
      const bx = at64(x, b);
      const by = at64(y, b);
      if (z instanceof Column) sum += Math.hypot(bx - ax, by - ay, at64(z, b) - at64(z, a));
      else if (sp !== null) sum += sp.distance([ax, ay], [bx, by]);
      else sum += Math.hypot(bx - ax, by - ay);
    }
    return sum;
  }

  /** The dual: a point per face, a face per point (3D). */
  dual(options?: object): Material {
    return dual3(this, options as never);
  }

  /** Every point moved by a field: a vector, or a distance along its
   * normal (3D). */
  displace(field: unknown, options?: object): Material {
    return displace3(this, field as never, options as never);
  }

  /** @internal The derived views the 3D layer builds from the columns on
   * first need and keeps here — its working surface (`surfaceOf(m)`),
   * never a public word. A box, like the others, because the state is
   * frozen. */
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
  const eligible = eligibleRows(self, opts.where, 'edges', 'resample');
  const X = self.x;
  const Y = self.y;
  const L = self.edgeList;
  // A vertex this call does not place keeps its row and its id: the ends
  // of an open chain, the seam of a ring, a junction, an isolated point
  // and everything outside `where`. Only the samples between are new.
  const points = new PointRows(self, 'resample', opts.transfer);
  const edges = new EdgeRows(self);
  const storedRow = new Map<number, number>();
  for (let e = 0; e < self.edgeCount; e++) storedRow.set(pairKey(L[2 * e], L[2 * e + 1]), e);
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
  const place = (a: number, b: number, t: number) => {
    if (curved) {
      const g = curved.geodesic([X[a], Y[a]], [X[b], Y[b]], t);
      points.between(a, b, t, g[0], g[1]);
    } else {
      points.between(a, b, t, X[a] + (X[b] - X[a]) * t, Y[a] + (Y[b] - Y[a]) * t);
    }
    underRow.push(-1);
    uRow.push(NaN);
  };
  // One piece of a chain, as its own little walk: `rows` are the material
  // rows it runs through, in order. A whole chain is one piece; with
  // `where`, a run of eligible edges is one.
  const piece = (rows: readonly number[], closed: boolean) => {
    const pts = rows.map((i) => [X[i], Y[i]] as [number, number]);
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
      const mid = rowOfSeg(segUnder((d0 + d1) / 2));
      const parts: number[] = edges.distributes ? [] : NO_PARTS;
      if (edges.distributes) {
        if (cum[spread] > d0) spread = 0; // a closed chain's seam wraps once
        while (spread < cum.length - 2 && cum[spread + 1] <= d0) spread++; // the first segment the range touches
        for (let s = spread; s + 1 < cum.length && cum[s] < d1; s++) {
          const len = cum[s + 1] - cum[s];
          if (len <= 0) continue;
          const overlap = Math.min(d1, cum[s + 1]) - Math.max(d0, cum[s]);
          if (overlap > 0) parts.push(rowOfSeg(s), overlap / len);
        }
      }
      // A new edge takes the lineage root of the source edge under its
      // middle, the way a split's children take their parent's — so the
      // face columns keyed on those roots still find their cells.
      edges.cover(mid, from, to, parts, 'lineage');
    };
    const at = (samples: { seg: number; t: number }[], k: number) =>
      cum[samples[k].seg] + samples[k].t * (cum[samples[k].seg + 1] - cum[samples[k].seg]);
    return { pts, total, link, at, rowOfSeg };
  };
  // A vertex this call does not touch: verbatim, not through `transfer`.
  // A transfer rule says what a value does at a NEW vertex, and this is
  // not one.
  const copy = (v: number) => {
    points.keep(v);
    underRow.push(-1);
    uRow.push(NaN);
  };
  // Isolated vertices are not chains: they come through unchanged.
  for (let i = 0; i < self.n; i++) if (self.adjacentRows(i).length === 0) copy(i);
  // A whole piece, redistributed: the path a resample without `where` takes
  // for every chain, and the one a fully eligible ring takes too.
  const whole = (rows: readonly number[], closed: boolean) => {
    const first = points.length;
    const p = piece(rows, closed);
    const samples = alongChain(p.pts, closed, sampling);
    // `alongChain` places sample k at arc length total·k/gaps: its
    // fraction of the chain is k/gaps exactly, as `t.sample` counts it.
    const gaps = closed ? samples.length : samples.length - 1;
    const last = samples.length - 1;
    for (let k = 0; k < samples.length; k++) {
      // The first sample is the chain's start (a ring's seam) and the last
      // of an open chain its end: those rows stay who they are.
      if (k === 0) copy(rows[0]);
      else if (k === last && !closed) copy(rows[rows.length - 1]);
      else place(rows[samples[k].seg], rows[(samples[k].seg + 1) % rows.length], samples[k].t);
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
      chainCum ??= chainLengths(idx.map((i) => [X[i], Y[i]] as [number, number]), closed, space);
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
      rowOf.set(v, points.length - 1);
      return points.length - 1;
    };
    const keep = (s: number) => {
      const a = rowFor(idx[s]);
      const b = rowFor(idx[(s + 1) % m]);
      edges.keep(rowOfSeg(s), a, b);
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
          out.push(points.length - 1);
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
  // The links, in the rows of the value the sketch passed: a point to the
  // edge under it, a new edge to the edge under its middle (a kept edge is
  // the edge it was, and says nothing new).
  const of = origin?.of ?? self;
  const map = origin?.edges ?? null;
  // The row lists are adopted as they are (linkRows copies nothing).
  const pointRows = map === null ? underRow : underRow.map((e) => (e < 0 ? -1 : map[e]));
  const edgeRows = new Int32Array(edges.length);
  for (let k = 0; k < edgeRows.length; k++) {
    const e = edges.madeFrom(k);
    edgeRows[k] = e < 0 ? -1 : map === null ? e : map[e];
  }
  // A row that came through untouched keeps what it had, and a new wall
  // keeps the lineage of the wall under it, so a face column still finds
  // its face.
  const out = rebuild(self, { ...points.done(), ...edges.done() });
  return record(linkRows(out, {
    points: { source: { of, domain: 'edges', rows: pointRows }, params: { u: uRow } },
    edges: { source: { of, domain: 'edges', rows: edgeRows } },
  }), derivation('resample', [of], { ...opts }));
}

/** The share list of an edge when no column distributes. */
const NO_PARTS: number[] = [];

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
 * chain's whole `length`, the chain (a row of `curves`), and where its
 * columns come from: its point columns `t` of the way from source row `a`
 * to row `b` (`PointRows.between`), its edge columns those of edge `copy`
 * and, for a `'distribute'` one, the sum of `shares` (`EdgeCells.over`).
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
  a: number;
  b: number;
  t: number;
  copy: number;
  /** Null when no edge column distributes. */
  shares: readonly number[] | null;
}

export function alongSamples(m: Material, opts: { spacing?: number; count?: number } = {}): ChainSample[] {
  const atVertices = opts.spacing === undefined && opts.count === undefined;
  // A curved material is walked in its own geometry.
  const space = m.space;
  const curved = space !== undefined && space.kind !== 'euclidean' ? space : null;
  if (!atVertices && !checkSampling('along', opts)) return [];
  const X = m.x;
  const Y = m.y;
  const L = m.edgeList;
  const distributes = new EdgeCells(m).distributes;
  const storedRow = new Map<number, number>();
  for (let e = 0; e < m.edgeCount; e++) storedRow.set(pairKey(L[2 * e], L[2 * e + 1]), e);
  const out: ChainSample[] = [];
  chainsOf(m).forEach((c, chain) => {
    const idx = c.indices;
    const pts = idx.map((i) => [X[i], Y[i]] as [number, number]);
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
    const shareOver = (d0: number, d1: number): number[] => {
      const parts: number[] = [];
      const span = (from: number, to: number) => {
        for (let sg = 0; sg < segs; sg++) {
          const len = cum[sg + 1] - cum[sg];
          if (len <= 0) continue;
          const overlap = Math.min(to, cum[sg + 1]) - Math.max(from, cum[sg]);
          if (overlap > 0) parts.push(rowOfSeg(sg), overlap / len);
        }
      };
      // a wrapped range on a closed chain is two plain ranges
      if (d0 < 0) { span(d0 + total, total); span(0, d1); }
      else if (d1 > total) { span(d0, total); span(0, d1 - total); }
      else span(d0, d1);
      return parts;
    };
    samples.forEach(({ seg, t }, k) => {
      const a = idx[seg];
      const b = idx[(seg + 1) % idx.length];
      const onVertexAhead = t >= 1 - 1e-9 && seg + 1 < segs;
      const at2 = curved ? curved.geodesic(pts[seg], pts[(seg + 1) % idx.length], t) : null;
      const tangent = frames.at(seg, t, at2 ? [at2[0], at2[1]] : null);
      const sAt = at(k);
      out.push({
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
        a,
        b,
        t,
        copy: rowOfSeg(onVertexAhead ? seg + 1 : seg),
        shares: distributes ? shareOver(...owned(k)) : null,
      });
    });
  });
  return out;
}

/** @internal `m.along(opts)`; see the method. Every point answers
 * `source`, the input edge it lies on, in the rows of `origin` (a
 * selection's material) or of `m`. */
export function alongMaterial(m: Material, opts: { spacing?: number; count?: number; transfer?: Record<string, Transfer> }, origin: InputRows | null): Material {
  const samples = alongSamples(m, opts);
  const out = samplesMaterial(samples, m, opts.transfer);
  const of = origin?.of ?? m;
  const rows = Int32Array.from(samples, (q) => (origin?.edges ? origin.edges[q.edge] : q.edge));
  return record(linkRows(out, { points: { source: { of, domain: 'edges', rows } } }), derivation('along', [of], { ...opts }));
}

/** The points `along` answers: a row per sample with every point column
 * by its transfer policy (`transfer` overrides one per call) and every edge
 * column by its own, of every kind, and the columns `s`, `u` and
 * `heading`. No edges. */
function samplesMaterial(samples: readonly ChainSample[], source: Material, transfer: Readonly<Record<string, Transfer>> | undefined): Material {
  const s = source.store;
  for (const name of s.edgeAttrNames) {
    if (name in s.attrs) throw new Error(`m.along: '${name}' is both a point column and an edge column, and a point of along() has one column of that name — rename one first`);
  }
  const points = new PointRows(source, 'm.along', transfer);
  const cells = new EdgeCells(source);
  for (const q of samples) {
    points.between(q.a, q.b, q.t, q.x, q.y);
    if (q.shares === null) cells.copyOf(q.copy);
    else cells.over(q.copy, q.shares);
  }
  const rows = points.done();
  // The chain's own columns first; the place on the chain is along's own
  // and wins over a column of the same name.
  const cols: Record<string, AnyColumn> = { ...rows.attrs, ...cells.columns() };
  cols.s = Column.of(Float64Array.from(samples, (q) => q.s));
  cols.u = Column.of(Float64Array.from(samples, (q) => q.u));
  cols.heading = Column.of(Float64Array.from(samples, (q) => q.heading));
  const transfers: Record<string, PointTransfer> = {};
  for (const name of s.attrNames) if (source.transfers[name] && name !== 's' && name !== 'u' && name !== 'heading') transfers[name] = source.transfers[name];
  return new Material(rows.x, rows.y, cols, new Uint32Array(0), { transfers, ids: { points: rows.pointIds }, keys: { points: rows.pointKeys }, from: source });
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
  return rebuild(m, {}, { history: m.history, faces: { ...faces, edgeList: s.edgeList, edgeIds: s.edgeIds } });
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
  const own = m.cache.areaMake !== undefined || m.cache.area !== undefined;
  return rebuild(m, {}, { history: m.history, space, ...(own ? { area: () => inSpace(areaMaterial(m), space) } : {}) });
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
  const X = m.x;
  const Y = m.y;
  const L = m.edgeList;
  // A vertex the trim kept is the vertex it was, and an edge the trim did
  // not cut is the edge it was: the trim is a subtraction, not a rebuild.
  // A cut mints a new point and a new edge, and the piece keeps the edge's
  // lineage root, so a face whose wall was merely shortened keeps its
  // columns. A cut vertex is read by its column's policy (`transfer`
  // overrides one per call), an edge column copied or, when `'distribute'`,
  // shared.
  const points = new PointRows(m, 'within', opts.transfer);
  const edges = new EdgeRows(m);
  const sourceRow = new Map<number, number>();
  // Two edges crossing the boundary at the same point must end at ONE
  // vertex, or the trimmed material is quietly disconnected there. Cut
  // points are matched on their coordinates, quantised well below the
  // 0.005 mm input grid and well above float noise (first edge's columns win).
  const cutRow = new Map<string, number>();
  const copyVertex = (i: number): number => {
    const seen = sourceRow.get(i);
    if (seen !== undefined) return seen;
    const row = points.keep(i);
    sourceRow.set(i, row);
    return row;
  };
  const splitAt = (i: number, j: number, t: number, x: number, y: number): number => {
    const key = `${x.toFixed(6)},${y.toFixed(6)}`;
    const seen = cutRow.get(key);
    if (seen !== undefined) return seen;
    const row = points.between(i, j, t, x, y, mintIds(1)[0]);
    cutRow.set(key, row);
    return row;
  };

  for (let e = 0; e < m.edgeCount; e++) {
    const a = L[2 * e];
    const b = L[2 * e + 1];
    const cuts = crossings(X[a], Y[a], X[b], Y[b]);
    const marks: { t: number; x: number; y: number }[] = [
      { t: 0, x: X[a], y: Y[a] },
      ...cuts,
      { t: 1, x: X[b], y: Y[b] },
    ];
    for (let k = 0; k + 1 < marks.length; k++) {
      const from0 = marks[k];
      const to1 = marks[k + 1];
      const mid = (from0.t + to1.t) / 2;
      if (!(inside(X[a] + (X[b] - X[a]) * mid, Y[a] + (Y[b] - Y[a]) * mid) > 0)) continue;
      const from = from0.t === 0 ? copyVertex(a) : splitAt(a, b, from0.t, from0.x, from0.y);
      const to = to1.t === 1 ? copyVertex(b) : splitAt(a, b, to1.t, to1.x, to1.y);
      // Whole edge: the same edge. A cut piece is a new edge of the same
      // lineage, exactly as a split's children are.
      if (from0.t === 0 && to1.t === 1) edges.keep(e, from, to);
      else edges.from(e, from, to, to1.t - from0.t, mintIds(1)[0]);
    }
  }
  // A vertex with no edges is not part of the trim's topology: it is a point,
  // and it survives when it is inside.
  const degree = new Uint32Array(m.n);
  for (let k = 0; k < L.length; k++) degree[L[k]]++;
  for (let i = 0; i < m.n; i++) {
    if (degree[i] === 0 && inside(X[i], Y[i]) > 0) copyVertex(i);
  }
  // The rows of the closing edges.
  const closing: number[] = [];

  // Closing along the boundary: the part of a face inside the area is an
  // area, so the boundary pieces that run through a face become its walls.
  const cells = readableFaces(m);
  if (cells) {
    const incident = new Int32Array(m.n).fill(-1);
    for (let e = 0; e < m.edgeCount; e++) {
      for (const v of [L[2 * e], L[2 * e + 1]]) if (incident[v] < 0) incident[v] = e;
    }
    const faceAt = faceLocator(cells);
    const edgeBoxes = new Float64Array(4 * m.edgeCount);
    for (let e = 0; e < m.edgeCount; e++) {
      const a = L[2 * e];
      const b = L[2 * e + 1];
      edgeBoxes.set([Math.min(X[a], X[b]), Math.min(Y[a], Y[b]), Math.max(X[a], X[b]), Math.max(Y[a], Y[b])], 4 * e);
    }
    const walls = boxGrid(edgeBoxes);
    const kept = new Set<number>();
    for (let k = 0; k < edges.length; k++) kept.add(pairKey(edges.endA(k), edges.endB(k)));
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
      // vertex) so a corner always has a previous vertex to copy: a corner
      // is a new vertex whose columns are those of the mark before it.
      const start = Math.max(0, marks.findIndex((mk) => mk.kind !== 'corner'));
      const firstFace = pieceFace.find((f) => f >= 0)!;
      const fallback = cells.faces[firstFace];
      let lastFrom: { a: number; b: number; t: number } = { a: fallback.points.indices[0], b: -1, t: 0 };
      let lastEdge = fallback.boundaryEdges.indices[0];
      const rowOf = new Int32Array(M).fill(-1);
      const edgeFrom = new Int32Array(M);
      for (let s = 0; s < M; s++) {
        const i = (start + s) % M;
        const mk = marks[i];
        const used = pieceFace[i] >= 0 || pieceFace[(i + M - 1) % M] >= 0;
        if (mk.kind === 'crossing') {
          lastFrom = { a: mk.a, b: mk.b, t: mk.t };
          lastEdge = mk.edge;
          if (used) rowOf[i] = splitAt(mk.a, mk.b, mk.t, mk.x, mk.y);
        } else if (mk.kind === 'vertex') {
          lastFrom = { a: mk.a, b: -1, t: 0 };
          lastEdge = mk.edge;
          if (used) rowOf[i] = copyVertex(mk.a);
        } else if (used) {
          rowOf[i] = lastFrom.b < 0
            ? points.copy(lastFrom.a, mk.x, mk.y, mintIds(1)[0])
            : points.between(lastFrom.a, lastFrom.b, lastFrom.t, mk.x, mk.y, mintIds(1)[0]);
        }
        edgeFrom[i] = lastEdge;
      }
      for (let i = 0; i < M; i++) {
        if (pieceFace[i] < 0 || rowOf[i] === rowOf[(i + 1) % M]) continue;
        // A wall the cut KEPT along the boundary already closes the face.
        const pair = pairKey(rowOf[i], rowOf[(i + 1) % M]);
        if (kept.has(pair)) continue;
        kept.add(pair);
        // The closing edge is a new wall of its own, with the columns of the
        // source wall before it and no share of that wall.
        closing.push(edges.length);
        edges.cover(edgeFrom[i], rowOf[i], rowOf[(i + 1) % M], [], 'own', mintIds(1)[0]);
      }
    }
  }

  const made = { ...points.done(), ...edges.done() };
  const edgeAttrs = { ...made.edgeAttrs };
  // The closing edge is a piece of the lowered boundary polyline: a
  // coordinate segment, whatever the wall before it was.
  const geodesic = edgeAttrs.geodesic;
  if (geodesic instanceof Column && closing.length > 0) {
    const flat = geodesic.copy();
    for (const k of closing) flat[k] = 0;
    edgeAttrs.geodesic = Column.of(flat);
  }
  // The column belongs to a cut that can close: a material with faces. An
  // open chain or a point cloud keeps the columns it had — a `cut` column it
  // never asked for would be one more column every later edge must give.
  const edgeTransfers = { ...m.edgeTransfers };
  if (cells) {
    // A source that already carries `cut` (a level set closed along the
    // drawable) keeps its marks: the two are OR-ed, never replaced.
    const prior = edgeAttrs.cut instanceof Column ? edgeAttrs.cut.flat() : undefined;
    const flags = new Float64Array(edges.length);
    for (const k of closing) flags[k] = 1;
    if (prior !== undefined) for (let k = 0; k < flags.length; k++) if (prior[k] !== 0) flags[k] = 1;
    edgeAttrs.cut = Column.of(flags);
    delete edgeTransfers.cut;
  }
  return rebuild(m, { ...made, edgeAttrs }, { edgeTransfers });
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
  const L = m.edgeList;
  for (let e = 0; e < m.edgeCount && !cyclic; e++) {
    const a = root(L[2 * e]);
    const b = root(L[2 * e + 1]);
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
  const X = m.x;
  const Y = m.y;
  const list = m.edgeList;
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
      const a = list[2 * e];
      const b = list[2 * e + 1];
      const ax = X[a];
      const ay = Y[a];
      const bx = X[b];
      const by = Y[b];
      if (Math.max(ax, bx) < lo[0] || Math.min(ax, bx) > hi[0] || Math.max(ay, by) < lo[1] || Math.min(ay, by) > hi[1]) continue;
      for (const v of [a, b]) {
        if (onSeg.has(v)) continue;
        const vx = X[v];
        const vy = Y[v];
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
  // A shape is not points until the toolkit lowers it (t.material, t.sample).
  refuseShape(points, 'material');
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
    } else if ((p as readonly number[]).length > 2 && typeof (p as readonly number[])[2] === 'number') {
      // A place with a third number, [x, y, z], is a point in space.
      own.add('z');
    }
    shared = shared === null ? [...own] : shared.filter((k) => own.has(k));
  }
  for (const k of shared ?? []) {
    const col = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const p = list[i];
      col[i] = isArr(p) ? (p as readonly number[])[2] : (p as Record<string, number>)[k];
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
  if (typeof points === 'function') throw new Error('curve: takes points — a function of t is parametricCurve(t => [x, y, z]) from occlude/3d');
  refuseShape(points, 'curve');
  const { closed = false, ...rest } = opts;
  if (typeof closed !== 'boolean') throw new Error(`curve: closed is true or false, got ${String(closed)}`);
  const cols: Record<string, number | ArrayLike<number>> = {};
  for (const [k, v] of Object.entries(rest)) {
    if (v === undefined) continue;
    if (typeof v === 'boolean') throw new Error(`curve: attribute '${k}' must be numeric`);
    if (typeof v === 'string') throw new Error(`curve: the column '${k}' is a number or a list of numbers, one a point — got '${v}'${k === 'pen' || k === 'stroke' ? '; a pen is how a drawing draws the value: strokes(m, { pen }), or [m, { pen }] in a view' : ''}`);
    cols[k] = v;
  }
  const given = material(points, cols);
  // A curve is the points and the chain through them, in the order given:
  // edges the points had where they came from (a selection keeps them on
  // extract) are not part of it, nor are those edges' columns.
  const none = new Float64Array(0);
  const m = given.edgeCount === 0 && given.store.edgeAttrNames.length === 0 ? given : rebuild(given, {
    edgeList: Column.of(new Uint32Array(0)), edgeAttrs: {}, edgeIds: Column.of(none), edgeRoots: Column.of(none), edgeKeys: null,
  }, { edgeTransfers: {}, faceAttrs: {} });
  return addEdges(m, chainEdges(m.n, closed));
}

/** A `group`-style record for a material: the same words, and `origin` the
 * one `Origin` of every pivot. */
export type TransformRecord = Omit<TransformOp, 'origin'> & { origin?: Origin | TransformOp['origin'] };

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
      : (m.pivot(who, op.origin as Origin) as [number, number] | undefined) ?? (() => { throw new Error(`${who}: origin is not a point — a material moves in its own units, so give finite numbers`); })();
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
    const q = fn(m.vertex(i));
    const x = vx(q);
    const y = vy(q);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`${who}: vertex ${i} maps to [${x}, ${y}], which is not a point`);
    nx[i] = x;
    ny[i] = y;
  }
  return rebuild(m, { x: Column.of(nx), y: Column.of(ny) });
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
    const X = given.x;
    const Y = given.y;
    return { list: Array.from({ length: given.n }, (_, i) => ({ x: X[i], y: Y[i], heading: h[i] })), space: given.space };
  }
  if (isPointSelection(given)) {
    const src = given.owner as Material;
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
    const X = mm.x;
    const Y = mm.y;
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
      const cx = grid.col(X[i]);
      const cy = grid.row(Y[i]);
      for (let r = 0; ; r++) {
        for (const j of grid.ring(cx, cy, r)) {
          if (j === i) continue;
          const dx = X[j] - X[i];
          const dy = Y[j] - Y[i];
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
    const X = mm.x;
    const Y = mm.y;
    const n = mm.n;
    const asked = opts.candidates ?? 12;
    if (!Number.isInteger(asked)) throw new Error(`connect.tour: candidates must be a whole number of neighbours, at least 2 (got ${String(opts.candidates)})`);
    // A choice needs two to choose between: fewer is read as two.
    const k = Math.max(2, asked);
    if (opts.cost !== undefined && typeof opts.cost !== 'function') throw new Error('connect.tour: cost must be a function of two vertex views');
    if (n < 2) return addEdges(mm, [], opts.edgeColumns);
    const views = Array.from({ length: n }, (_, i) => mm.vertex(i));
    const raw = opts.cost;
    const cache = new Map<number, number>();
    const cost = (i: number, j: number): number => {
      if (!raw) return Math.hypot(X[i] - X[j], Y[i] - Y[j]);
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
      const cx = grid.col(X[from]);
      const cy = grid.row(Y[from]);
      let best = -1;
      let bestD = Infinity;
      for (let r = 0; ; r++) {
        for (const j of grid.ring(cx, cy, r)) {
          if (used[j]) continue;
          const d = Math.hypot(X[j] - X[from], Y[j] - Y[from]);
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
      const cx = grid.col(X[i]);
      const cy = grid.row(Y[i]);
      for (let r = 0; ; r++) {
        for (const j of grid.ring(cx, cy, r)) {
          if (j !== i) cand.push([Math.hypot(X[j] - X[i], Y[j] - Y[i]), j]);
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
      return [X[a], Y[a], X[b], Y[b]];
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
    const X = mm.x;
    const Y = mm.y;
    const n = mm.n;
    if (opts.cost !== undefined && typeof opts.cost !== 'function') throw new Error('connect.tree: cost must be a function of two vertex views');
    if (n < 2) return addEdges(mm, [], opts.edgeColumns);
    const views = Array.from({ length: n }, (_, i) => mm.vertex(i));
    const raw = opts.cost;
    const cost = (i: number, j: number): number => {
      if (!raw) return Math.hypot(X[i] - X[j], Y[i] - Y[j]);
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
      const key = `${X[i]},${Y[i]}`;
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
    const X = mm.x;
    const Y = mm.y;
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
        const k = `${X[i]},${Y[i]}`;
        if (seen.has(k)) continue;
        seen.add(k);
        first.push(i);
      }
      for (let i = 0; i < first.length; i++) for (let j = i + 1; j < first.length; j++) candidates.push([first[i], first[j]]);
    }
    const pairs: [number, number][] = [];
    for (const [a, b] of candidates) {
      const ax = X[a];
      const ay = Y[a];
      const bx = X[b];
      const by = Y[b];
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
            const qx = X[q];
            const qy = Y[q];
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

  /** Delaunay edges over the rows, by index. Coincident rows: the FIRST
   * row at a position takes part in the triangulation and its edges; later
   * rows at the same position stay isolated (they are still rows). Fewer
   * than three distinct positions, or all collinear, give no edges. */
  triangulate(m: PointsLike, edgeColumns?: Record<string, number>): Material {
    const mm = material(m);
    const X = mm.x;
    const Y = mm.y;
    const firstAt = new Map<string, number>();
    const unique: number[] = [];
    for (let i = 0; i < mm.n; i++) {
      const k = `${X[i]},${Y[i]}`;
      if (firstAt.has(k)) continue;
      firstAt.set(k, i);
      unique.push(i);
    }
    if (unique.length < 3) return addEdges(mm, [], edgeColumns);
    // All collinear: no triangle exists (d3 would perturb the points into a
    // sliver); decided exactly.
    const [u0, u1] = unique;
    if (unique.every((row) => orient2d(X[u0], Y[u0], X[u1], Y[u1], X[row], Y[row]) === 0)) return addEdges(mm, [], edgeColumns);
    const tri = Delaunay.from(unique.map((row) => [X[row], Y[row]] as [number, number])).triangles;
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

/** What a side of `append` that lacks a column gets: `fill` for point
 * columns, `edgeFill` for edge columns. */
export interface AppendOpts {
  fill?: Record<string, CellValue>;
  edgeFill?: Record<string, CellValue>;
}
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
  // Every column, of every kind, joins the one way: one kind on both
  // sides, and a side without one filled by `fill`.
  const attrs = joinColumnRecords(a.store.attrs, b.store.attrs, a.n, b.n, fill, '');
  const edgeAttrs = joinColumnRecords(a.store.edgeAttrs, b.store.edgeAttrs, a.edgeCount, b.edgeCount, edgeFill, 'edge ');
  // Policies are compared as they take effect — an undeclared column
  // interpolates — so joining sides cannot silently change how a column
  // splits afterwards.
  const effective = (m: Material, k: string): PointTransfer => m.transfers[k] ?? 'interpolate';
  for (const k in a.store.attrs) {
    if (k in b.store.attrs && effective(a, k) !== effective(b, k)) {
      throw new Error(`append: '${k}' has transfer '${effective(a, k)}' on one side and '${effective(b, k)}' on the other`);
    }
  }
  const effectiveEdge = (m: Material, k: string): EdgeTransfer => m.edgeTransfers[k] ?? 'copy';
  for (const k in a.store.edgeAttrs) {
    if (k in b.store.edgeAttrs && effectiveEdge(a, k) !== effectiveEdge(b, k)) {
      throw new Error(`append: edge column '${k}' has transfer '${effectiveEdge(a, k)}' on one side and '${effectiveEdge(b, k)}' on the other`);
    }
  }
  const x = new Float64Array(a.n + b.n);
  const y = new Float64Array(a.n + b.n);
  x.set(a.x);
  x.set(b.x, a.n);
  y.set(a.y);
  y.set(b.y, a.n);
  const edges = new Uint32Array(a.edgeList.length + b.edgeList.length);
  edges.set(a.edgeList);
  const bl = b.edgeList;
  for (let e = 0; e < bl.length; e++) edges[a.edgeList.length + e] = bl[e] + a.n;
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
  // The kernel's names ride along, `''` on a side that has none.
  const keys = {
    points: joinKeys(a.store.pointKeys, a.n, b.store.pointKeys, b.n),
    edges: joinKeys(a.store.edgeKeys, a.edgeCount, b.store.edgeKeys, b.edgeCount),
  };
  const faces = joinStated(a, b, edges, edgeIds);
  return new Material(x, y, attrs, edges, { iteration: 0, history: [], edgeAttrs, transfers: { ...b.transfers, ...a.transfers }, edgeTransfers: { ...b.edgeTransfers, ...a.edgeTransfers }, ids: { points: pointIds, edges: edgeIds, edgeRoots }, keys, faceAttrs: { ...b.faceAttrs, ...a.faceAttrs }, space: a.space ?? b.space, ...(faces !== undefined ? { faces } : {}) });
}

/**
 * The stated faces of `a` and `b` appended — a's faces, then b's over its
 * re-based rows — when every side that has edges states its faces: a side
 * whose faces are read off the picture cannot join a statement (the
 * statement would hide them), so then there is none and the faces of the
 * whole are read off the picture. Everything a statement holds is joined:
 * the loops, the nesting, each face's source, the corner columns (a side
 * without one takes its kind's default; two kinds refused by name), the
 * minted ids (the second side's re-minted on a collision, as its points'
 * are), the kernel's names and the fixed triangles.
 */
function joinStated(a: Material, b: Material, edges: Uint32Array, edgeIds: Float64Array): StatedFaces | undefined {
  const sa = a.stated;
  const sb = b.stated;
  if (sa === undefined && sb === undefined) return undefined;
  if ((sa === undefined && a.edgeCount > 0) || (sb === undefined && b.edgeCount > 0)) return undefined;
  const ca = sa?.cycles ?? [];
  const cb = sb?.cycles ?? [];
  const fa = ca.length;
  const fb = cb.length;
  const na = cornerIndex(ca).count;
  const nb = cornerIndex(cb).count;
  const shift = a.n;
  const cycles = Object.freeze([...ca, ...cb.map((runs) => Object.freeze(runs.map((run) => Object.freeze(run.map((p) => p + shift)))))]);
  const parent = sa?.parent === undefined && sb?.parent === undefined ? undefined : Int32Array.from([
    ...(sa?.parent ?? new Int32Array(fa).fill(-1)),
    ...Array.from(sb?.parent ?? new Int32Array(fb).fill(-1), (p) => (p < 0 ? -1 : p + fa)),
  ]);
  const source = sa?.source === undefined && sb?.source === undefined ? undefined
    : (f: number) => (f < fa ? sa?.source?.(f) : sb?.source?.(f - fa));
  // Corner columns: one kind a name, a side without it at the default.
  const corners: Record<string, AnyColumn> = {};
  const colsA = sa?.corners ?? {};
  const colsB = sb?.corners ?? {};
  for (const name of new Set([...Object.keys(colsA), ...Object.keys(colsB)])) {
    const x = colsA[name];
    const y = colsB[name];
    const kind = kindOf((x ?? y)!);
    if (x !== undefined && y !== undefined && kindOf(y) !== kind) throw new Error(`append: the corner column '${name}' holds ${kindWords(kind)} a corner on one side and ${kindWords(kindOf(y))} on the other`);
    corners[name] = joinColumns(x ?? kind.filled(na), y ?? kind.filled(nb));
  }
  const ids = (x: Float64Array | undefined, y: Float64Array | undefined, cx: number, cy: number): Float64Array | undefined => {
    if (x === undefined && y === undefined) return undefined;
    const first = x ?? mintIds(cx);
    const seen = new Set(first);
    const second = y === undefined || y.some((id) => seen.has(id)) ? mintIds(cy) : y;
    const out = new Float64Array(cx + cy);
    out.set(first);
    out.set(second, cx);
    return out;
  };
  const names = (x: readonly string[] | undefined, y: readonly string[] | undefined, cx: number, cy: number): readonly string[] | undefined =>
    x === undefined && y === undefined ? undefined : Object.freeze([...(x ?? new Array<string>(cx).fill('')), ...(y ?? new Array<string>(cy).fill(''))]);
  const faceIds = ids(sa?.faceIds, sb?.faceIds, fa, fb);
  const cornerIds = ids(sa?.cornerIds, sb?.cornerIds, na, nb);
  const faceKeys = names(sa?.faceKeys, sb?.faceKeys, fa, fb);
  const cornerKeys = names(sa?.cornerKeys, sb?.cornerKeys, na, nb);
  const triangles = sa?.triangles === undefined && sb?.triangles === undefined ? undefined
    : Object.freeze([...(sa?.triangles ?? new Array<undefined>(fa)), ...(sb?.triangles ?? new Array<undefined>(fb))]);
  return {
    cycles,
    ...(parent !== undefined ? { parent } : {}),
    ...(source !== undefined ? { source } : {}),
    edgeList: Column.of(edges),
    edgeIds: Column.of(edgeIds),
    ...(Object.keys(corners).length > 0 ? { corners: Object.freeze(corners) } : {}),
    ...(faceIds !== undefined ? { faceIds } : {}),
    ...(cornerIds !== undefined ? { cornerIds } : {}),
    ...(faceKeys !== undefined ? { faceKeys } : {}),
    ...(cornerKeys !== undefined ? { cornerKeys } : {}),
    ...(triangles !== undefined ? { triangles } : {}),
  };
}

/** Two sides' kernel names joined, or null when neither has any. */
function joinKeys(a: StringColumn | null, na: number, b: StringColumn | null, nb: number): StringColumn | null {
  if (a === null && b === null) return null;
  return joinColumns(a ?? kinds.string.filled(na), b ?? kinds.string.filled(nb)) as StringColumn;
}

/** Two column records, `na` and `nb` rows long, joined: every column of
 * every kind, one kind on both sides, and the side that lacks one filled
 * by `fill` (refused by name without it). A name that holds one kind on
 * one side and another on the other is refused. */
function joinColumnRecords(
  a: Readonly<Record<string, AnyColumn>>,
  b: Readonly<Record<string, AnyColumn>>,
  na: number,
  nb: number,
  fill: Readonly<Record<string, unknown>>,
  what: '' | 'edge ',
): Record<string, AnyColumn> {
  const who = 'append';
  const out: Record<string, AnyColumn> = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const ca = a[k];
    const cb = b[k];
    if (ca !== undefined && cb !== undefined) {
      const ka = kindOf(ca);
      const kb = kindOf(cb);
      if (ka !== kb) throw new Error(`${who}: the ${what}column '${k}' holds ${kindWords(ka)} a row on one side and ${kindWords(kb)} on the other`);
      out[k] = joinColumns(ca, cb);
      continue;
    }
    if (!(k in fill)) throw new Error(`${who}: the ${ca === undefined ? 'first' : 'second'} material has no ${what}column '${k}' — give ${what === '' ? 'fill' : 'edgeFill'}: { ${k}: … } or match the columns`);
    const { kind, value } = storedValueOf(fill[k], who, k);
    const held = (ca ?? cb)!;
    if (kind !== kindOf(held)) throw new Error(`${who}: the fill of '${k}' is ${kindWords(kind)}, and the ${what}column holds ${kindWords(kindOf(held))} a row`);
    out[k] = ca !== undefined ? joinColumns(ca, kind.filled(nb, value)) : joinColumns(kind.filled(na, value), cb!);
  }
  return out;
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
  const box = m.cache;
  if (box.area === undefined && box.areaMake !== undefined) {
    box.area = box.areaMake();
    box.areaMake = undefined;
  }
  return box.area ?? m;
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
  const source = input.owner;
  const area = areaMaterial(source);
  if (area === source) return input;
  if (input.length === source.edgeCount) return area.edges;
  const lines = selectionIn(input, area);
  const cut = area.edgeAttrs.cut;
  const L = area.edgeList;
  if (cut === undefined) return lines;
  const ends = new Set<number>();
  for (const e of lines.indices) {
    ends.add(L[2 * e]);
    ends.add(L[2 * e + 1]);
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
    const a = L[2 * e];
    const b = L[2 * e + 1];
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
    if (cut[e] !== 0 && keep.get(find(L[2 * e])) === true) rows.push(e);
  }
  return edgesOf(area, rows);
}

// ---- the 3D section: the words a 2D and a 3D value share ---------------------------

/** A point or a step in space: three numbers. */
export type Vec3 = readonly [number, number, number];

/** @internal Does this value's points have a `z` — is it a value in space? */
export function inSpace3(m: Material): boolean {
  return m.store.attrs.z instanceof Column;
}

/** A 3-vector: three numbers, as an array or `{ x, y, z }`. */
function isVec3(v: unknown): boolean {
  if (Array.isArray(v)) return v.length === 3;
  return typeof v === 'object' && v !== null && typeof (v as { z?: unknown }).z === 'number';
}

// ---- the 3D section: the constructor doors ----------------------------------------
//
// The one geometry holds 2D and 3D alike: points (x, y, a `z` column when
// they have one, and columns of any kind), edges, stated faces, and the
// corners of those faces. The 3D layer (src/three) builds a value and reads
// it back through these doors, never through the public words — they check
// what a program gets wrong, and they read a sketch's intent (a position,
// a view) where the 3D layer holds plain rows.
//
//   materialFromParts(parts)  the value of these parts:
//     { x, y, z?, pointCols?, edges?, edgeCols?,
//       faces?: [{ loop, cols?, corners?, triangles? }], ids?, keys?,
//       source?, space?, transfers?, edgeTransfers?,
//       faceColumns?, cornerColumns? }
//   partsOfMaterial(m)        the same parts read back: the columns as they
//                             are held, the edge list, the ids, and the
//                             stated faces — their loops, their columns by
//                             face row, their corners, their fixed
//                             triangles.
//
// Rows are rows of the value: a loop names point rows, an edge names point
// rows, a corner record is by position round its loop. Ids are the run's
// minted numbers (`mintIds`); given ones are kept, absent ones minted. A
// column is a column of any kind (`kinds.*` in column.ts) or a Float64Array
// of numbers, each exactly as long as its domain.

/** @internal One stated polygon face of `materialFromParts`. */
export interface FacePart {
  /** The face's point rows, in order round it — three or more. The face is
   * on the left of the loop as it runs: counter-clockwise seen from the
   * side it faces. */
  readonly loop: ArrayLike<number>;
  /** The face's columns: one value each, of any kind a column holds. */
  readonly cols?: Readonly<Record<string, CellValue>>;
  /** The corners' columns, one record per point of the loop, in loop
   * order (absent, or a record left out: the kind's default). */
  readonly corners?: readonly (Readonly<Record<string, CellValue>> | undefined)[];
  /** A fixed triangulation of the face: positions round `loop` (0 is its
   * first point), three a triangle. Absent: none — a reader triangulates
   * the loop itself. The statement keeps it with the loop (see
   * `StatedFaces.triangles`). */
  readonly triangles?: ArrayLike<number>;
}

/** @internal Where the rows of a `materialFromParts` value came from
 * (derivation.ts): the node the derivation records on it, and what each
 * row's `source` answers — row links (an input's points, edges or stated
 * faces, one input or a list of them, and parameter columns such as `u`),
 * or a function of the row read the first time the row asks. Every write
 * that keeps a row keeps its answer. */
export interface PartsSource {
  readonly node?: Derivation;
  readonly points?: DomainSpec | ((row: number) => unknown);
  readonly edges?: DomainSpec | ((row: number) => unknown);
  readonly faces?: (f: number) => unknown;
}

/** @internal The parts `materialFromParts` takes. */
export interface MaterialParts {
  readonly x: ArrayLike<number>;
  readonly y: ArrayLike<number>;
  /** The third coordinate, one a point: a value with it is a 3D value. */
  readonly z?: ArrayLike<number>;
  /** Point columns by name (not `x`, `y`, `z`). */
  readonly pointCols?: Readonly<Record<string, AnyColumn | Float64Array>>;
  /** Edges as point rows, two a row: `[a0, b0, a1, b1, …]`. A side of a
   * face loop no edge joins is added after these, in face and loop order,
   * with its columns' defaults and a minted id. */
  readonly edges?: ArrayLike<number>;
  /** Edge columns by name, one value per edge given in `edges`. */
  readonly edgeCols?: Readonly<Record<string, AnyColumn | Float64Array>>;
  /** Stated polygon faces, in face order. */
  readonly faces?: readonly FacePart[];
  /** Ids to keep: one per point, one per edge given in `edges`, each
   * edge's lineage root (absent: its own id), one per face and one per
   * corner. Absent: minted (an edge the door adds always is). */
  readonly ids?: {
    readonly points?: ArrayLike<number>;
    readonly edges?: ArrayLike<number>;
    readonly edgeRoots?: ArrayLike<number>;
    readonly faces?: ArrayLike<number>;
    readonly corners?: ArrayLike<number>;
  };
  /** The kernel's own names of the rows, kept beside the ids and never
   * public (see `MaterialStore.pointKeys`): one per point, per edge given
   * in `edges` (an added edge's is `''`), per face, per corner. */
  readonly keys?: {
    readonly points?: readonly string[];
    readonly edges?: readonly string[];
    readonly faces?: readonly string[];
    readonly corners?: readonly string[];
  };
  readonly source?: PartsSource;
  /** The space the coordinates belong to. */
  readonly space?: Space;
  /** The value's key (see `Material.key`). */
  readonly key?: string;
  /** The prototype the points place (see `Material.prototype`). */
  readonly prototype?: Material;
  /** Declared transfer policies, as `points.set(…, { transfer })` keeps them. */
  readonly transfers?: Readonly<Record<string, PointTransfer>>;
  readonly edgeTransfers?: Readonly<Record<string, EdgeTransfer>>;
  /** Face columns as a value holds them, keyed by each face's walls — for
   * a rebuild that keeps the walls and their lineage roots, and so every
   * face's key: its declared transfer and fallback go with it. Not with a
   * face part's `cols`. */
  readonly faceColumns?: Readonly<Record<string, FaceColumn>>;
  /** Corner columns as a value holds them: one row per loop point, in face
   * and loop order, of any kind. Not with a face part's `corners`. */
  readonly cornerColumns?: Readonly<Record<string, AnyColumn>>;
}

/** @internal The parts of a value, read back (`partsOfMaterial`). The
 * columns are the value's own: read them, never write them. */
export interface MaterialPartsOut {
  readonly x: Float64Array;
  readonly y: Float64Array;
  /** The `z` column's numbers, or undefined for a value in the plane. */
  readonly z: Float64Array | undefined;
  /** Every point column but `z`, as held (a numeric one a `Column`). */
  readonly pointCols: Readonly<Record<string, AnyColumn>>;
  readonly edges: Uint32Array;
  readonly edgeCols: Readonly<Record<string, AnyColumn>>;
  readonly ids: { readonly points: Float64Array; readonly edges: Float64Array; readonly edgeRoots: Float64Array };
  /** The kernel's names of the points and edges, or null where none. */
  readonly keys: { readonly points: readonly string[] | null; readonly edges: readonly string[] | null };
  readonly faces: StatedParts | undefined;
}

/** @internal A value's stated faces, read back (`partsOfMaterial`'s `faces`). */
export interface StatedParts {
  /** Per face row, its loop of point rows (a face with holes: its outer
   * run; a face that holds others: empty). */
  readonly loops: readonly (readonly number[])[];
  /** Face columns by name, of the kind each holds, one row per face row:
   * its own value, else the column's fallback, else the kind's default. */
  readonly cols: Readonly<Record<string, AnyColumn>>;
  /** The corners: each one's face row and point row, where each face's
   * corners start, and the corner columns as held. */
  readonly corners: { readonly face: Uint32Array; readonly point: Uint32Array; readonly start: Uint32Array; readonly cols: Readonly<Record<string, AnyColumn>> };
  /** The faces' and corners' minted ids, where the statement has them. */
  readonly ids: { readonly faces: Float64Array | undefined; readonly corners: Float64Array | undefined };
  /** The kernel's names of the faces and corners, where given. */
  readonly keys: { readonly faces: readonly string[] | undefined; readonly corners: readonly string[] | undefined };
  /** Per face row, its fixed triangles as positions round its loop (see
   * `FacePart.triangles`), undefined for a face without; undefined when
   * no face has any. */
  readonly triangles: readonly (readonly number[] | undefined)[] | undefined;
}

/**
 * @internal The one geometry of these parts: see the section header. A
 * wrong part — a column of the wrong length, a loop of fewer than three
 * points or naming a point that is not there, a value no column holds, a
 * column that holds two kinds — is refused by name.
 */
export function materialFromParts(parts: MaterialParts): Material {
  const who = 'materialFromParts';
  const n = parts.x.length;
  if (parts.y.length !== n) throw new Error(`${who}: ${parts.x.length} x and ${parts.y.length} y`);
  const x = Float64Array.from(parts.x);
  const y = Float64Array.from(parts.y);
  const pointCols: Record<string, ColumnLike<Float64Array> | AnyColumn> = {};
  if (parts.z !== undefined) {
    if (parts.z.length !== n) throw new Error(`${who}: ${parts.z.length} z for ${n} points`);
    pointCols.z = Float64Array.from(parts.z);
  }
  for (const [name, col] of Object.entries(parts.pointCols ?? {})) {
    if (name === 'z' && parts.z !== undefined) throw new Error(`${who}: 'z' is given twice — as z and as a point column`);
    pointCols[name] = col;
  }
  // The edges given, then every loop side no edge joins.
  const given = parts.edges ?? [];
  if (given.length % 2 !== 0) throw new Error(`${who}: edges are pairs of point rows`);
  const ends: number[] = Array.from(given);
  const have = new Set<number>();
  for (let k = 0; k < ends.length; k += 2) have.add(pairKey(ends[k], ends[k + 1]));
  const faces = parts.faces ?? [];
  const loops = faces.map((f, i) => {
    const loop = Array.from(f.loop);
    if (loop.length < 3) throw new Error(`${who}: face ${i} has a loop of ${loop.length} points — a face is three or more`);
    for (const p of loop) if (!Number.isInteger(p) || p < 0 || p >= n) throw new Error(`${who}: face ${i} names point ${p}, and there are ${n}`);
    const tri = f.triangles;
    if (tri !== undefined) {
      if (tri.length % 3 !== 0) throw new Error(`${who}: face ${i} gives ${tri.length} triangle corners — three a triangle`);
      for (let k = 0; k < tri.length; k++) {
        const t = tri[k];
        if (!Number.isInteger(t) || t < 0 || t >= loop.length) throw new Error(`${who}: face ${i} has a triangle at loop position ${t}, and its loop has ${loop.length} points`);
      }
    }
    for (let k = 0; k < loop.length; k++) {
      const a = loop[k];
      const b = loop[(k + 1) % loop.length];
      if (!have.has(pairKey(a, b))) {
        have.add(pairKey(a, b));
        ends.push(a, b);
      }
    }
    return loop;
  });
  const givenEdges = given.length / 2;
  const edgeCount = ends.length / 2;
  const added = edgeCount - givenEdges;
  const edgeCols: Record<string, AnyColumn> = {};
  for (const [name, col] of Object.entries(parts.edgeCols ?? {})) {
    const c = anyColumnOf(col);
    if (c.length !== givenEdges) throw new Error(`${who}: edge column '${name}' has ${c.length} values for ${givenEdges} edges`);
    edgeCols[name] = added === 0 ? c : joinColumns(c, kindOf(c).filled(added));
  }
  const edgeList = Column.of(Uint32Array.from(ends));
  const ids = parts.ids ?? {};
  const pointIds = ids.points === undefined ? undefined : Float64Array.from(ids.points);
  const extra = added === 0 ? null : mintIds(added);
  const withAdded = (given: ArrayLike<number> | undefined, what: string): Float64Array | undefined => {
    if (given === undefined) return undefined;
    if (given.length !== givenEdges) throw new Error(`${who}: ${given.length} ${what} for ${givenEdges} edges`);
    const out = new Float64Array(edgeCount);
    out.set(Array.from(given));
    if (extra !== null) out.set(extra, givenEdges);
    return out;
  };
  const edgeIdsFlat = withAdded(ids.edges, 'edge ids') ?? mintIds(edgeCount);
  const edgeRootsFlat = withAdded(ids.edgeRoots, 'edge roots');
  const edgeIds = Column.of(edgeIdsFlat);
  const cycles = Object.freeze(loops.map((l) => Object.freeze([Object.freeze(l)])));
  const cornerCount = loops.reduce((sum, l) => sum + l.length, 0);
  if (parts.cornerColumns !== undefined && faces.some((f) => f.corners !== undefined)) throw new Error(`${who}: corner columns are given as held and as face parts' corners — give one`);
  if (parts.faceColumns !== undefined && faces.some((f) => f.cols !== undefined)) throw new Error(`${who}: face columns are given as held and as face parts' cols — give one`);
  for (const [name, col] of Object.entries(parts.cornerColumns ?? {})) {
    checkColumnName('corner', name, who);
    if (col.length !== cornerCount) throw new Error(`${who}: corner column '${name}' has ${col.length} values for ${cornerCount} corners`);
  }
  const corners = faces.length === 0 ? undefined
    : parts.cornerColumns !== undefined ? (Object.keys(parts.cornerColumns).length === 0 ? undefined : Object.freeze({ ...parts.cornerColumns }))
    : cornerColumns(faces, loops, who);
  const triangles = faces.some((f) => f.triangles !== undefined)
    ? Object.freeze(faces.map((f) => (f.triangles === undefined ? undefined : Object.freeze(Array.from(f.triangles)))))
    : undefined;
  const counted = (given: ArrayLike<number> | readonly string[] | undefined, count: number, what: string): void => {
    if (given !== undefined && given.length !== count) throw new Error(`${who}: ${given.length} ${what} for ${count}`);
  };
  const keys = parts.keys ?? {};
  counted(ids.faces, faces.length, 'face ids');
  counted(ids.corners, cornerCount, 'corner ids');
  counted(keys.points, n, 'point keys');
  counted(keys.edges, givenEdges, 'edge keys');
  counted(keys.faces, faces.length, 'face keys');
  counted(keys.corners, cornerCount, 'corner keys');
  const stated: StatedFaces | undefined = faces.length === 0 ? undefined : {
    cycles,
    ...(parts.source?.faces ? { source: parts.source.faces } : {}),
    edgeList,
    edgeIds,
    ...(corners !== undefined ? { corners } : {}),
    faceIds: ids.faces === undefined ? mintIds(faces.length) : Float64Array.from(ids.faces),
    cornerIds: ids.corners === undefined ? mintIds(cornerCount) : Float64Array.from(ids.corners),
    ...(keys.faces !== undefined ? { faceKeys: Object.freeze([...keys.faces]) } : {}),
    ...(keys.corners !== undefined ? { cornerKeys: Object.freeze([...keys.corners]) } : {}),
    ...(triangles !== undefined ? { triangles } : {}),
  };
  const nameCols = {
    points: keys.points === undefined ? null : kinds.string.from(keys.points),
    edges: keys.edges === undefined ? null : kinds.string.from([...keys.edges, ...new Array<string>(added).fill('')]),
  };
  let m = new Material(x, y, pointCols, edgeList, {
    edgeAttrs: edgeCols,
    transfers: { ...(parts.transfers ?? {}) },
    edgeTransfers: { ...(parts.edgeTransfers ?? {}) },
    ids: { points: pointIds, edges: edgeIds, edgeRoots: edgeRootsFlat },
    keys: nameCols,
    space: parts.space,
    ...(parts.key !== undefined ? { key: parts.key } : {}),
    ...(parts.prototype !== undefined ? { prototype: parts.prototype } : {}),
    faces: stated,
  });
  // Face columns are keyed by the walls each face is made of, as every
  // face column is, so they follow the faces the way `faces.set`'s do.
  const heldFaces = parts.faceColumns !== undefined && Object.keys(parts.faceColumns).length > 0;
  if (heldFaces || faces.some((f) => f.cols !== undefined && Object.keys(f.cols).length > 0)) {
    m = rebuild(m, {}, { faceAttrs: heldFaces ? { ...parts.faceColumns } : faceColumnsOfParts(faces, statedFaceIds(m, cycles), who) });
  }
  const src = parts.source;
  const spec = (d: DomainSpec | ((row: number) => unknown) | undefined): DomainSpec | undefined =>
    typeof d === 'function' ? { source: { read: d } } : d;
  if (src?.points !== undefined || src?.edges !== undefined) linkRows(m, { points: spec(src.points), edges: spec(src.edges) });
  return src?.node !== undefined ? record(m, src.node) : m;
}

/** The corner columns of a list of face parts: one row per loop point, in
 * face order; each column of one kind, its first value's, and a corner that
 * gives none its kind's default. Undefined when no corner has a column. */
function cornerColumns(faces: readonly FacePart[], loops: readonly (readonly number[])[], who: string): Readonly<Record<string, AnyColumn>> | undefined {
  const count = loops.reduce((s, l) => s + l.length, 0);
  const found = new Map<string, { kind: AnyKind; values: unknown[] }>();
  let at = 0;
  faces.forEach((f, i) => {
    const records = f.corners;
    if (records !== undefined && records.length !== loops[i].length) throw new Error(`${who}: face ${i} gives ${records.length} corner records for a loop of ${loops[i].length}`);
    for (let k = 0; k < loops[i].length; k++, at++) {
      const rec = records?.[k];
      if (rec === undefined) continue;
      for (const [name, v] of Object.entries(rec)) {
        if (v === undefined) continue;
        const cell = storedValueOf(v, who, name);
        let col = found.get(name);
        if (col === undefined) {
          col = { kind: cell.kind, values: new Array<unknown>(count).fill(undefined) };
          found.set(name, col);
        } else if (col.kind !== cell.kind) {
          throw new Error(`${who}: the corner column '${name}' would hold ${kindWords(col.kind)} and ${kindWords(cell.kind)} — a column keeps one kind`);
        }
        col.values[at] = cell.value;
      }
    }
  });
  if (found.size === 0) return undefined;
  const out: Record<string, AnyColumn> = {};
  for (const [name, { kind, values }] of found) {
    checkColumnName('corner', name, who);
    const filled = values.map((v) => (v === undefined ? kind.default : v));
    out[name] = kind.from(filled);
  }
  return Object.freeze(out);
}

/** The face columns of a list of face parts, keyed by `keys` (one per
 * face): each column of one kind, and every face seen. */
function faceColumnsOfParts(faces: readonly FacePart[], keys: readonly string[], who: string): Record<string, FaceColumn> {
  const out: Record<string, FaceColumn> = {};
  const kindOfName = new Map<string, AnyKind>();
  const values = new Map<string, Map<string, unknown>>();
  faces.forEach((f, i) => {
    for (const [name, v] of Object.entries(f.cols ?? {})) {
      if (v === undefined) continue;
      checkColumnName('face', name, who);
      const cell = storedValueOf(v, who, name);
      const had = kindOfName.get(name);
      if (had !== undefined && had !== cell.kind) throw new Error(`${who}: the face column '${name}' would hold ${kindWords(had)} and ${kindWords(cell.kind)} — a column keeps one kind`);
      kindOfName.set(name, cell.kind);
      let map = values.get(name);
      if (map === undefined) values.set(name, (map = new Map()));
      map.set(keys[i], Array.isArray(cell.value) ? Object.freeze(cell.value) : cell.value);
    }
  });
  const seen = new Set(keys);
  for (const [name, map] of values) {
    const kind = kindOfName.get(name)!;
    out[name] = { values: map, transfer: 'nearest', seen, ...(kind === kinds.number ? {} : { kind }) };
  }
  return out;
}

/** @internal The parts of `m` (see `MaterialPartsOut`). */
export function partsOfMaterial(m: Material): MaterialPartsOut {
  const s = m.store;
  const pointCols: Record<string, AnyColumn> = {};
  for (const name of s.attrNames) if (name !== 'z') pointCols[name] = s.attrs[name];
  const z = s.attrs.z;
  return {
    x: s.x.flat(),
    y: s.y.flat(),
    z: z instanceof Column ? z.flat() : undefined,
    pointCols,
    edges: s.edgeList.flat(),
    edgeCols: s.edgeAttrs,
    ids: { points: s.pointIds.flat(), edges: s.edgeIds.flat(), edgeRoots: s.edgeRoots.flat() },
    keys: { points: s.pointKeys === null ? null : s.pointKeys.flat(), edges: s.edgeKeys === null ? null : s.edgeKeys.flat() },
    faces: statedPartsOf(m),
  };
}

/** @internal The stated faces of `m` read back (see `StatedParts`), or
 * undefined when its faces are read off the picture. */
function statedPartsOf(m: Material): StatedParts | undefined {
  const stated = m.stated;
  if (stated === undefined) return undefined;
  const loops = stated.cycles.map((runs) => (runs.length === 0 ? [] : runs[0]));
  const cols: Record<string, AnyColumn> = {};
  const names = Object.keys(m.faceAttrs);
  if (names.length > 0) {
    const keys = statedFaceIds(m, stated.cycles);
    for (const name of names) {
      // A column of the kind it holds, a face row a row: its own value,
      // else the column's fallback, else the kind's default.
      const column = m.faceAttrs[name];
      const kind = column.kind ?? kinds.number;
      const fallback = column.fallback !== undefined ? column.fallback : kind.default;
      cols[name] = (kind as { from(values: readonly unknown[]): AnyColumn }).from(keys.map((key) => {
        const v = column.values.get(key);
        return v === undefined ? fallback : v;
      }));
    }
  }
  const index = cornerIndex(stated.cycles);
  return {
    loops,
    cols,
    corners: { face: index.face, point: index.point, start: index.start, cols: stated.corners ?? {} },
    ids: { faces: stated.faceIds, corners: stated.cornerIds },
    keys: { faces: stated.faceKeys, corners: stated.cornerKeys },
    triangles: stated.triangles,
  };
}
