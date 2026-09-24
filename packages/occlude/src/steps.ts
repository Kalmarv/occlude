/**
 * One step: how a pass's edits become a list of records against a frozen
 * state, and how that list lands as the next one. `Next` is the edit
 * vocabulary a rule sees; every call appends plain records to the batch and
 * nothing else happens until the pass is over. `land` folds the list into
 * the next state — the order of resolution, the precedence that decides
 * which records drop and why, and the transfer of columns through moves,
 * splits, removals and connections are all here. `Material.steps` is the
 * loop over it.
 *
 * The contract is one sentence: the call judges the program, the fold
 * judges the data. A wrong program (an unknown column, the wrong kind of
 * reference, a selection of another material) throws at the call. Data
 * that cannot land (a reference that is gone, a join of a point to itself,
 * a move that is not finite, two asks that contradict each other) is
 * dropped with a reason, and the state that comes out says what it
 * dropped.
 *
 * The state class and the selection classes come in through `StepKit`,
 * passed by `Material.steps`, so this module needs nothing of the material
 * module at runtime (types only) and no import cycle exists: material →
 * steps → { vec, views }.
 */

import { vx, vy, type XY } from './vec.js';
import { ownerOf, pairKey, viewKind } from './views.js';
import { mintIds, RESERVED_FACE_FIELDS, withAbsentEdge, type Material, type Vertex, type Edge, type FaceColumn, type TransferPolicy, type EdgeTransfer, type PointId, type EdgeId } from './material.js';
import type { Space } from './space.js';
import type { PointSelection, EdgeSelection } from './relation.js';
import type { Faces, Face, FaceSelection } from './faces.js';

/** What a step needs from the material cluster, handed over by the
 * caller: the state constructor and the two selection classes it must
 * recognise. Typed, explicit and complete — nothing else of the sketch
 * reaches an edit batch. */
export interface StepKit {
  Material: new (
    x: Float64Array, y: Float64Array, attrs: Record<string, Float64Array>, edgeList: Uint32Array,
    carry?: {
      iteration?: number;
      history?: readonly Material[];
      edgeAttrs?: Record<string, Float64Array>;
      transfers?: Record<string, TransferPolicy>;
      edgeTransfers?: Record<string, EdgeTransfer>;
      ids?: { points?: Float64Array; edges?: Float64Array; edgeRoots?: Float64Array };
      faceAttrs?: Record<string, FaceColumn>;
      space?: Space;
      dropped?: readonly Dropped[];
    },
  ) => Material;
  PointSelection: typeof PointSelection;
  EdgeSelection: typeof EdgeSelection;
}

/**
 * The face columns a step hands on: what the state already carried, with
 * this step's writes on top. A column written for the first time starts
 * from the writes alone, with `'nearest'` and no fallback — the same
 * defaults the declaring door gives.
 */
function withWrites(
  carried: Readonly<Record<string, FaceColumn>>,
  writes: ReadonlyMap<string, Map<string, number>>,
  against: () => readonly string[],
): Record<string, FaceColumn> {
  if (writes.size === 0) return { ...carried };
  const out: Record<string, FaceColumn> = { ...carried };
  for (const [name, values] of writes) {
    const was = carried[name];
    const merged = new Map(was?.values ?? []);
    for (const [key, value] of values) merged.set(key, value);
    // The column has now been written against THIS state's faces, so every
    // face of it that got no value has none — only a face that appears
    // later inherits.
    const seen = new Set(against());
    for (const key of merged.keys()) seen.add(key);
    out[name] = { values: merged, transfer: was?.transfer ?? 'nearest', fallback: was?.fallback, seen };
  }
  return out;
}

/** A child edge's inherited columns: a `'copy'` column carries the parent's
 * value, a `'distribute'` column the parent's value times the child's
 * share of the parent. */
export function inheritEdge(m: Material, parent: Record<string, number>, fraction: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name in parent) out[name] = m.edgeTransfers[name] === 'distribute' ? parent[name] * fraction : parent[name];
  return out;
}

// ---- the records ------------------------------------------------------------------

/** A face's key: the lineage roots of its walls, the same in every state
 * whose walls are the same (`faces.keys()`). */
export type FaceKey = string;

/**
 * A point an edit names: a vertex view, a point id, or the record of a
 * point this batch adds (`addPoint`) or cuts (`split`) — a new point's
 * record IS its handle. Never a row: a row is a place in one state, and
 * the row door is `cur.points.at(row)`.
 */
export type PointRef = Vertex | PointId | AddPointEdit | SplitEdit;
/** An edge an edit names: an edge view or an edge id. */
export type EdgeRef = Edge | EdgeId;

/** Displace a point by `by`. Moves on one point add up. */
export interface MoveEdit { readonly op: 'move'; readonly point: PointRef; readonly by: XY }
/** Write point columns. The last `set` of a column wins. */
export interface SetEdit { readonly op: 'set'; readonly point: PointRef; readonly attrs: Readonly<Record<string, number>> }
/** Write edge columns. */
export interface SetEdgeEdit { readonly op: 'setEdge'; readonly edge: EdgeRef; readonly attrs: Readonly<Record<string, number>> }
/** Write face columns on the face with this key. */
export interface SetFaceEdit { readonly op: 'setFace'; readonly face: FaceKey; readonly attrs: Readonly<Record<string, number>> }
/** Add a point. It names every declared point column. */
export interface AddPointEdit { readonly op: 'addPoint'; readonly position: XY; readonly attrs: Readonly<Record<string, number>> }
/** Join two points. The first `connect` of a pair keeps its columns. */
export interface ConnectEdit { readonly op: 'connect'; readonly a: PointRef; readonly b: PointRef; readonly attrs?: Readonly<Record<string, number>> }
/** Remove an edge and keep its points. */
export interface DisconnectEdit { readonly op: 'disconnect'; readonly edge: EdgeRef }
/** Delete a point and the edges that meet it. */
export interface RemoveEdit { readonly op: 'remove'; readonly point: PointRef }
/** Cut an edge at `at` (0…1 along it, stored a → b). */
export interface SplitEdit {
  readonly op: 'split';
  readonly edge: EdgeRef;
  readonly at: number;
  readonly point?: Readonly<Record<string, number>> | ((e: Edge, at: number) => Record<string, number>);
  readonly edges?: Readonly<Record<string, number>> | ((e: Edge, child: ChildInterval) => Record<string, number>);
}
/** One alteration, as data. A batch is a list of these. */
export type Edit = MoveEdit | SetEdit | SetEdgeEdit | SetFaceEdit | AddPointEdit | ConnectEdit | DisconnectEdit | RemoveEdit | SplitEdit;

/** Why the fold left a record out. */
export type DropReason = 'gone' | 'self' | 'already' | 'removed' | 'disconnected' | 'conflict' | 'not-finite';
/** One record a `steps` call did not land, the reason, and the step `k`. */
export interface Dropped { readonly edit: Edit; readonly reason: DropReason; readonly k: number }

/** The columns of a record that names none. */
const NO_COLUMNS: Readonly<Record<string, number>> = Object.freeze({});

const OPS: ReadonlySet<string> = new Set(['move', 'set', 'setEdge', 'setFace', 'addPoint', 'connect', 'disconnect', 'remove', 'split']);

/** A plain object that is not a view and not a list: what a record is. */
const isPlain = (r: unknown): r is Record<string, unknown> => typeof r === 'object' && r !== null && !Array.isArray(r) && viewKind(r) === undefined;
/** The record of a point this batch makes. Read by its `op` alone: a view's
 * columns are numbers, so no view answers `'addPoint'` or `'split'`. */
const isNewPoint = (r: unknown): r is AddPointEdit | SplitEdit => typeof r === 'object' && r !== null && ((r as Edit).op === 'addPoint' || (r as Edit).op === 'split');
const isVertexView = (r: unknown): r is Vertex => viewKind(r) === 'vertex';
/** Something a coordinate can be read from, finite or not. */
const isXY = (v: unknown): v is XY => Array.isArray(v) ? v.length >= 2 : typeof v === 'object' && v !== null && 'x' in v && 'y' in v;

// ---- one pass ---------------------------------------------------------------------

/** One child of `extrude`: a new point (`position` + `attributes`) or an
 * existing target (`to`); either way an edge from the parent, carrying
 * `edgeAttributes` when edge columns are declared. A new point must name
 * every declared column, unless `extrude` runs with `inherit: true`, in
 * which case it starts from its parent's values and `attributes` are the
 * overrides. */
export type ChildSpec =
  | { position: XY; attributes?: Record<string, number>; edgeAttributes?: Record<string, number>; to?: undefined }
  | { to: PointRef; edgeAttributes?: Record<string, number>; position?: undefined };

/** The interval of a split child edge in the ORIGINAL edge's parameter
 * space: `from` → `to`, and its share `fraction = to - from`. */
export interface ChildInterval {
  from: number;
  to: number;
  fraction: number;
}

export interface SplitOpts {
  /** Fraction along the edge (stored a → b), default 0.5; 0 or 1 name the
   * existing endpoint and create nothing. */
  at?: number;
  /** Point attributes for the inserted vertex, merged over the inherited
   * ones (declared transfer policies, interpolate by default): a partial
   * record, or a callback of the moved parent edge and `at`. */
  point?: Record<string, number> | ((e: Edge, at: number) => Record<string, number>);
  /** Edge attributes for each child edge, merged over the parent's
   * (updated) values: a partial record, or a callback of the moved parent
   * edge and the child's interval. */
  edges?: Record<string, number> | ((e: Edge, child: ChildInterval) => Record<string, number>);
}

/** One pass reads a frozen material and batches edits for its output. A
 * pass that returns a list makes that list the batch; any other value
 * (nothing, or one record, such as `next.split` hands back) leaves the batch as
 * `next` left it. */
export type StepRule = (prev: Material, next: Next, k: number) => void | Edit | readonly Edit[];
/** The everyday step, without the pass ceremony: `{ move, set }` fields over
 * every point of the pass's input. (A bare callback is not a shorthand:
 * TypeScript cannot tell a one-parameter point field from a rule.) */
export type StepShorthand = { readonly move?: XY | ((p: Vertex) => XY); readonly set?: Record<string, number> | ((p: Vertex) => Record<string, number>) };
export function isStepShorthand(rule: StepRule | StepShorthand): rule is StepShorthand {
  return typeof rule === 'object' && rule !== null;
}
export function stepRuleOf(shorthand: StepShorthand): StepRule {
  const { move, set } = shorthand;
  if (move === undefined && set === undefined) throw new Error('a steps shorthand needs a move field, a set field, or both');
  return (prev, next) => {
    if (set !== undefined) next.set(prev.points, set);
    if (move !== undefined) next.move(prev.points, move);
  };
}
export interface StepsOptions {
  /** Capture after every m complete iterations, plus the initial and final states. */
  every?: number;
}

/** How a motif lands on an edge. */
export interface ReplaceOpts {
  /** Mirror the motif across the edge. The callback sees the edge and the
   * step, so alternating on the step grows a curve inward and outward by
   * turns. Which side is "outward" depends on the seed's winding. */
  flip?: boolean | ((e: Edge, k: number) => boolean);
}

/**
 * The next state under construction, as a list of records. Every vertex
 * and edge starts as a copy of the current one, so a rule only states what
 * changes. All callbacks and selectors see the FROZEN current state; no
 * edit changes what a later callback reads. The fold resolves in one
 * order: removals and disconnections, new points, moves and attribute
 * writes (moves add up, the last write of a column wins), splits (sorted
 * along each original edge), then connections, then one compaction. What
 * cannot land is dropped with a reason (see `Dropped`).
 */
export interface Next {
  /** The batch so far, as records. A pass that returns a list replaces it. */
  readonly edits: readonly Edit[];
  /** Displace selected points. Callbacks read this pass's input; moves add up. */
  move(points: PointSelection, by: XY | ((p: Vertex) => XY)): void;
  move(point: PointRef, by: XY): void;
  /** Write selected point attributes; the last write of a field wins. */
  set(points: PointSelection, attrs: Record<string, number> | ((p: Vertex) => Record<string, number>)): void;
  set(point: PointRef, attrs: Record<string, number>): void;
  /** Write attributes of one edge or a selection of this pass's input edges. */
  setEdge(edge: EdgeRef, attrs: Record<string, number>): void;
  setEdges(edges: EdgeSelection, attrs: Record<string, number> | ((e: Edge) => Record<string, number>)): void;
  /**
   * Write face columns for a selection of faces.
   *
   * A face is not a row, so this touches no row array and takes part in no
   * compaction: it records a value against the walls the face is made of,
   * and the state that comes out of the step carries it. Reading the faces
   * is what makes a step pay for them, so a loop that never asks never
   * builds them.
   */
  setFaces(faces: Faces | FaceSelection, attrs: Record<string, number> | ((f: Face) => Record<string, number>)): void;
  /** Add a point. Every declared point column must be given. The record
   * that comes back names the new point in this batch. */
  addPoint(position: XY, attributes: Record<string, number>): AddPointEdit;
  /** Connect two points: vertices, ids, or new points' records. */
  connect(a: PointRef, b: PointRef, edgeAttributes?: Record<string, number>): void;
  /** Remove edges, keeping their points. */
  disconnect(edges: EdgeSelection): void;
  disconnect(edge: EdgeRef): void;
  /** Delete points and their incident edges; never join their neighbours. */
  remove(points: PointSelection): void;
  remove(point: PointRef): void;
  /** Split an edge. Several requests on one edge are resolved together. The
   * record that comes back names the new point in this batch. */
  split(edge: EdgeRef, opts?: SplitOpts): SplitEdit;
  /** Split selected input edges. To select by completed movement, use a later pass. */
  splitEdges(edges: EdgeSelection, opts?: SplitOpts): void;
  /** Swap every selected edge for a motif. The edge goes, and the motif's
   * one open chain takes its place between the same two points, scaled and
   * turned to the edge. Point columns interpolate and edge columns inherit,
   * exactly as a split's children do. A motif point that lands on a point
   * already there — a corner, or the tip another wall's motif put in the
   * same place — IS that point, and keeps that point's columns, so motifs
   * that meet share a vertex. This is the substitution an L-system is made
   * of: a Koch curve is one motif and four steps. */
  replace(edges: EdgeSelection, motif: Material, opts?: ReplaceOpts): void;
  /** Create children connected to selected parents. Children do not enter the
   * parent selection. With inherit, parent attributes precede explicit overrides. */
  extrude(points: PointSelection | Vertex, spec: (p: Vertex) => ChildSpec | ChildSpec[], opts?: { inherit?: boolean }): void;
}

/** @internal Every declared column named (unless `complete: false`), no unknown name, every value finite. */
export function checkAttrs(attrs: Record<string, number>, names: string[], what: string, opts: { complete?: boolean } = {}): void {
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

/** The program half of `checkAttrs`: a record, naming only declared
 * columns (and every one of them when `complete`). A value that is not
 * finite is data, and the fold judges it. */
function checkNames(attrs: unknown, names: readonly string[], what: string, opts: { complete?: boolean; edge?: boolean } = {}): asserts attrs is Record<string, number> {
  if (typeof attrs !== 'object' || attrs === null || Array.isArray(attrs)) throw new Error(`steps: ${what} needs a record of columns`);
  if (opts.complete) {
    for (const name of names) {
      if (!(name in attrs)) throw new Error(`steps: must give '${name}' for ${what} (every attribute is a choice)`);
    }
  }
  for (const name in attrs) {
    if (!names.includes(name)) {
      throw new Error(opts.edge ? `steps: no edge attribute '${name}' — declare it with edgeAttribute()` : `steps: no attribute '${name}' — declare it first`);
    }
  }
}

const finiteValues = (attrs: Readonly<Record<string, number>>): boolean => {
  for (const name in attrs) if (!Number.isFinite(attrs[name])) return false;
  return true;
};

/**
 * The record of a new point, as `next.addPoint` and `next.split` make it:
 * its fields are the plain data a record literal has, and the batch that
 * made it keeps, privately, which of its new points it is. A private field
 * is no property — a spread, `Object.keys`, JSON and a deep equal never see
 * it — so a copy of the record is a record like any other a sketch writes,
 * and the fold finds the batch's own records without a lookup table.
 */
class AddPointRecord implements AddPointEdit {
  readonly op: 'addPoint';
  readonly position: XY;
  readonly attrs: Readonly<Record<string, number>>;
  readonly #batch: object;
  readonly #slot: number;
  constructor(position: XY, attrs: Readonly<Record<string, number>>, batch: object, slot: number) {
    this.op = 'addPoint';
    this.position = position;
    this.attrs = attrs;
    this.#batch = batch;
    this.#slot = slot;
  }
  static slotIn(r: object, batch: object): number {
    return #slot in r && (r as AddPointRecord).#batch === batch ? (r as AddPointRecord).#slot : -1;
  }
}
class SplitRecord implements SplitEdit {
  readonly op: 'split';
  readonly edge: EdgeRef;
  readonly at: number;
  readonly point?: SplitEdit['point'];
  readonly edges?: SplitEdit['edges'];
  readonly #batch: object;
  readonly #slot: number;
  constructor(ask: Omit<SplitEdit, 'op'>, batch: object, slot: number) {
    this.op = 'split';
    this.edge = ask.edge;
    this.at = ask.at;
    if (ask.point !== undefined) this.point = ask.point;
    if (ask.edges !== undefined) this.edges = ask.edges;
    this.#batch = batch;
    this.#slot = slot;
  }
  static slotIn(r: object, batch: object): number {
    return #slot in r && (r as SplitRecord).#batch === batch ? (r as SplitRecord).#slot : -1;
  }
}
/** Which of `batch`'s new points `r` is, or -1 when `batch` did not make it. */
const slotIn = (r: object, batch: object): number => {
  const i = AddPointRecord.slotIn(r, batch);
  return i >= 0 ? i : SplitRecord.slotIn(r, batch);
};
const isMinted = (r: unknown): boolean => r instanceof AddPointRecord || r instanceof SplitRecord;

/** The ops a selection asks for once per member. */
type RunOp = 'move' | 'set' | 'setEdge' | 'remove' | 'disconnect' | 'split';

/**
 * The records of one edit over a selection, kept as columns: the rows of
 * the frozen state it names (point rows, or edge rows for the edge ops),
 * and the value each member asked for — a move, a record of columns, or a
 * split's parameter and overrides. A pass that never reads `next.edits`
 * never pays for a record per member, and the fold reads the rows as they
 * are; reading `next.edits` turns the run into records that name their
 * points and edges by id.
 */
class Run {
  constructor(
    readonly op: RunOp,
    readonly rows: readonly number[],
    readonly values: readonly unknown[] | null,
    private readonly cur: Material,
  ) {}

  value(i: number): unknown {
    return this.values === null ? undefined : this.values[i];
  }

  record(i: number): Edit {
    const row = this.rows[i];
    const point = this.cur.pointIds[row] as PointId;
    const edge = this.cur.edgeIds[row] as EdgeId;
    const v = this.value(i);
    const attrs = () => (Object.isFrozen(v) ? (v as Record<string, number>) : Object.freeze({ ...(v as Record<string, number>) }));
    switch (this.op) {
      case 'move': return Object.freeze({ op: 'move', point, by: v as XY });
      case 'set': return Object.freeze({ op: 'set', point, attrs: attrs() });
      case 'setEdge': return Object.freeze({ op: 'setEdge', edge, attrs: attrs() });
      case 'remove': return Object.freeze({ op: 'remove', point });
      case 'disconnect': return Object.freeze({ op: 'disconnect', edge });
      case 'split': return Object.freeze({ ...(v as Omit<SplitEdit, 'edge'>), edge });
    }
  }
}

/** @internal A pass's return value: a list becomes the batch (every item a
 * record, or the pass is a wrong program); anything else leaves the batch
 * as `next` left it. */
export function adopt(next: Next, out: unknown): void {
  if (Array.isArray(out)) (next as Batch).adopt(out);
}

/** How close, as a fraction of the replaced edge's length, a motif point
 * must land on a point already there to be that point. Rounding in the
 * motif's frame is some 1e-14 of it; a distance a sketch means is not
 * below 1e-9 of it. */
const WELD = 1e-9;

/** The places `replace` has landed on in one step: the state's own points
 * first, by row, then every motif point minted, by its record. Looked up in a grid of cells sized
 * to the state's shortest edge, so a weld is a handful of compares. */
class Landing {
  private readonly cells = new Map<string, { x: number; y: number; ref: PointRef | number }[]>();
  private readonly size: number;

  constructor(cur: Material) {
    let shortest = Infinity;
    for (let e = 0; e < cur.edgeCount; e++) {
      const a = cur.edgeList[2 * e];
      const b = cur.edgeList[2 * e + 1];
      const d = Math.hypot(cur.x[b] - cur.x[a], cur.y[b] - cur.y[a]);
      if (d > 0 && d < shortest) shortest = d;
    }
    this.size = Number.isFinite(shortest) ? shortest : 1;
    for (let i = 0; i < cur.n; i++) this.add(cur.x[i], cur.y[i], i);
  }

  private key(i: number, j: number): string {
    return `${i},${j}`;
  }

  /** A place: a row of the state (a number), or a new point's record. */
  add(x: number, y: number, ref: PointRef | number): void {
    const k = this.key(Math.floor(x / this.size), Math.floor(y / this.size));
    const cell = this.cells.get(k);
    if (cell) cell.push({ x, y, ref });
    else this.cells.set(k, [{ x, y, ref }]);
  }

  /** The first place within `tol` of (x, y), oldest first. */
  find(x: number, y: number, tol: number): PointRef | number | undefined {
    const ci = Math.floor(x / this.size);
    const cj = Math.floor(y / this.size);
    for (let i = ci - 1; i <= ci + 1; i++) {
      for (let j = cj - 1; j <= cj + 1; j++) {
        for (const held of this.cells.get(this.key(i, j)) ?? []) {
          if (Math.hypot(held.x - x, held.y - y) <= tol) return held.ref;
        }
      }
    }
    return undefined;
  }
}

// ---- the program checks: every one of them throws ----

const checkXY = (v: unknown, what: string): void => {
  if (!isXY(v)) throw new Error(`steps: ${what} is not a point — give [x, y] or { x, y }`);
};
const checkOverride = (v: unknown, cols: readonly string[], what: string, edge: boolean): void => {
  if (v === undefined || typeof v === 'function') return;
  checkNames(v, cols, what, { edge });
};
const checkFaceAttrs = (attrs: unknown): void => {
  if (!isPlain(attrs)) throw new Error('steps: setFaces needs a record of columns');
  for (const name in attrs) if (RESERVED_FACE_FIELDS.includes(name)) throw new Error(`steps: setFaces: '${name}' is a reserved face field`);
};
const checkEdge = (e: unknown, what: string): void => {
  if (typeof e === 'number' || viewKind(e) === 'edge') return;
  throw new Error(`steps: ${what} needs an edge — an edge view or an edge id`);
};
// Options are recorded as they are at the call: a plain record is copied, a
// frozen one kept, and a callback stays a function (it runs on the moved state).
const byValue = <T,>(v: T): T => (v !== null && typeof v === 'object' && !Object.isFrozen(v) ? (Object.freeze({ ...(v as object) }) as T) : v);
const splitRecord = (edge: EdgeRef, at: number, opts: SplitOpts): Omit<SplitEdit, 'op'> => {
  const r: { edge: EdgeRef; at: number; point?: SplitEdit['point']; edges?: SplitEdit['edges'] } = { edge, at };
  if (opts.point !== undefined) r.point = byValue(opts.point);
  if (opts.edges !== undefined) r.edges = byValue(opts.edges);
  return r;
};

/**
 * One pass's batch: the `Next` a rule is handed. Every call appends records
 * (or a run of them) to the list, and nothing else happens until the fold.
 * Its state is private, so what a sketch sees of `next` is the verbs and
 * `edits`; the fold reads the state through `Batch.parts`.
 */
class Batch implements Next {
  #entries: (Edit | Run)[] = [];
  /** The records a pass handed back: the sketch's own values, never frozen here. */
  #handed: Set<object> | null = null;
  /** How many new-point records this batch has made. */
  #minted = 0;
  /** The vertex views of this state, made once each: the compound verbs
   * name an existing point by its view, which the fold reads by row. */
  #views: Vertex[] = [];
  #landed: Landing | undefined;
  readonly #cur: Material;
  readonly #k: number;
  readonly #kit: StepKit;
  readonly #names: string[];
  readonly #enames: string[];

  constructor(cur: Material, k: number, kit: StepKit) {
    this.#cur = cur;
    this.#k = k;
    this.#kit = kit;
    this.#names = cur.attrNames;
    this.#enames = cur.edgeAttrNames;
  }

  /** @internal What the fold reads. */
  static parts(b: Batch) {
    return { entries: b.#entries, handed: b.#handed, minted: b.#minted, names: b.#names, enames: b.#enames };
  }

  /** @internal A list a pass returned becomes the batch, judged as the calls would judge it. */
  adopt(list: readonly unknown[]): void {
    for (let i = 0; i < list.length; i++) this.#checkRecord(list[i], i);
    this.#entries = list.slice() as Edit[];
    this.#handed ??= new Set();
    for (const r of list) if (!Object.isFrozen(r)) this.#handed.add(r as object);
  }

  // A record is frozen by the time anything outside can reach it: when a
  // call returns it, when `next.edits` is read, and when the fold drops it.
  // Until then it is the batch's own, and freezing it early only costs.
  #append<T extends Edit>(r: T): T {
    this.#entries.push(r);
    return r;
  }

  #viewAt(row: number): Vertex {
    return (this.#views[row] ??= this.#cur.vertex(row));
  }

  #checkPoint(r: unknown, what: string): void {
    if (typeof r === 'number' || isMinted(r) || isVertexView(r) || isNewPoint(r)) return;
    const { PointSelection, EdgeSelection } = this.#kit;
    if (r instanceof EdgeSelection || viewKind(r) === 'edge') throw new Error(`steps: ${what} needs a point, not an edge`);
    if (r instanceof PointSelection) throw new Error(`steps: ${what} takes one point here — a vertex, a point id, or a new point's record`);
    throw new Error(`steps: ${what} needs a point — a vertex, a point id, or a new point's record (a row is cur.points.at(row))`);
  }

  /** A record a pass handed back, judged as a call would judge it. */
  #checkRecord(r: unknown, i: number): void {
    if (!isPlain(r) || !('op' in r)) throw new Error(`steps: a pass returned something that is not an edit record (index ${i})`);
    if (typeof r.op !== 'string' || !OPS.has(r.op)) throw new Error(`steps: unknown edit op '${String(r.op)}' (index ${i})`);
    const e = r as unknown as Edit;
    const names = this.#names;
    const enames = this.#enames;
    switch (e.op) {
      case 'move': this.#checkPoint(e.point, 'a move'); checkXY(e.by, 'a move\'s by'); break;
      case 'set': this.#checkPoint(e.point, 'a set'); checkNames(e.attrs, names, 'a set'); break;
      case 'setEdge': checkEdge(e.edge, 'a setEdge'); checkNames(e.attrs, enames, 'a setEdge', { edge: true }); break;
      case 'setFace':
        if (typeof e.face !== 'string') throw new Error(`steps: a setFace names a face by its key (a string) (index ${i})`);
        checkFaceAttrs(e.attrs);
        break;
      case 'addPoint': checkXY(e.position, 'a new vertex'); checkNames(e.attrs, names, 'a new vertex', { complete: true }); break;
      case 'connect':
        this.#checkPoint(e.a, 'connect'); this.#checkPoint(e.b, 'connect');
        if (e.attrs !== undefined) checkNames(e.attrs, enames, 'a new edge');
        break;
      case 'disconnect': checkEdge(e.edge, 'disconnect'); break;
      case 'remove': this.#checkPoint(e.point, 'remove'); break;
      case 'split':
        checkEdge(e.edge, 'split');
        if (typeof e.at !== 'number') throw new Error(`steps: a split's at is a number along the edge (index ${i})`);
        checkOverride(e.point, names, 'a split vertex', false);
        checkOverride(e.edges, enames, 'a split child edge', true);
        break;
    }
  }

  // A selection from an EARLIER state of the same evolution is re-bound by
  // identity rather than refused: the rows are that state's numbering, but
  // the points are the same points. Members that are gone are skipped.
  //
  // A selection that shares NOTHING with this state is a wrong program: a
  // selection of another material and a selection whose every member has
  // been removed look alike from here, and the words say so. One shared
  // vertex is enough to tell this is the same evolution, so skipping what
  // is gone goes on working.
  #strangerTo(source: Material): boolean {
    const cur = this.#cur;
    for (const id of source.pointIds) if (cur.rowOfPoint(id as PointId) >= 0) return false;
    for (const id of source.edgeIds) if (cur.rowOfEdge(id as EdgeId) >= 0) return false;
    return source.n > 0 || source.edgeCount > 0;
  }

  #pointRows(selection: PointSelection | Vertex, what: string): readonly number[] {
    const cur = this.#cur;
    // One vertex is a collection of one. `t.pick(cur.points)` gives a
    // vertex, and having to write `.rows([p.index])` to hand it back would
    // be the library asking for ceremony it can do itself.
    if (isVertexView(selection)) {
      const row = ownerOf(selection) === cur ? selection.index : cur.rowOfPoint(selection.id);
      return row < 0 ? [] : [row];
    }
    if (!(selection instanceof this.#kit.PointSelection)) throw new Error(`steps: ${what} needs a point selection — use prev.points.filter(...)`);
    if (selection.source === cur) return selection.indices;
    if (selection.length > 0 && this.#strangerTo(selection.source)) {
      throw new Error(`steps: ${what} names ${selection.length} vertices and this state has none of them — the selection is of another material, or everything it named is gone`);
    }
    return selection.in(cur).indices;
  }

  #edgeRows(selection: EdgeSelection, what: string): readonly number[] {
    const cur = this.#cur;
    if (!(selection instanceof this.#kit.EdgeSelection)) throw new Error(`steps: ${what} needs an edge selection — use prev.edges.filter(...)`);
    if (selection.source !== cur && selection.length > 0 && this.#strangerTo(selection.source)) {
      throw new Error(`steps: ${what} names ${selection.length} edges and this state has none of them — the selection is of another material, or everything it named is gone`);
    }
    return selection.source === cur ? selection.indices : selection.in(cur).indices;
  }

  #splitAt(opts: SplitOpts, what: string): number {
    for (const retired of ['attributes', 'parent']) {
      if (retired in opts) throw new Error(`steps: ${what}: the '${retired}' option is retired — give the new vertex's columns as 'point' and the child edges' as 'edges'`);
    }
    const at = opts.at ?? 0.5;
    if (typeof at !== 'number') throw new Error(`steps: ${what}: at is a number along the edge, from 0 to 1`);
    checkOverride(opts.point, this.#names, 'a split vertex', false);
    checkOverride(opts.edges, this.#enames, 'a split child edge', true);
    return at;
  }

  /** The move or set of a selection of points, one value per member. */
  #run(op: 'move' | 'set', rows: readonly number[], value: unknown): void {
    if (rows.length === 0) return;
    const cur = this.#cur;
    const values = new Array<unknown>(rows.length);
    if (typeof value === 'function') {
      for (let i = 0; i < rows.length; i++) {
        const v = (value as (p: Vertex) => unknown)(cur.vertex(rows[i]));
        if (op === 'move') checkXY(v, 'a move');
        else checkNames(v, this.#names, 'a set');
        values[i] = v;
      }
    } else {
      if (op === 'move') checkXY(value, 'a move');
      else checkNames(value, this.#names, 'a set');
      values.fill(op === 'set' ? byValue(value) : value);
    }
    this.#entries.push(new Run(op, rows, values, cur));
  }

  /** The row a single reference names now, for a callback to read; none when it is gone or new. */
  #rowsOf(target: PointRef, what: string): readonly number[] {
    if (isVertexView(target)) return this.#pointRows(target, what);
    const row = typeof target === 'number' ? this.#cur.rowOfPoint(target) : -1;
    return row < 0 ? [] : [row];
  }

  get edits(): readonly Edit[] {
    const out: Edit[] = [];
    for (const e of this.#entries) {
      if (!(e instanceof Run)) { out.push(Object.freeze(e)); continue; }
      for (let i = 0; i < e.rows.length; i++) out.push(e.record(i));
    }
    this.#entries = out;
    return Object.freeze(out.slice());
  }

  move(points: PointSelection, by: XY | ((p: Vertex) => XY)): void;
  move(point: PointRef, by: XY): void;
  move(target: PointRef | PointSelection, by: XY | ((p: Vertex) => XY)): void {
    if (target instanceof this.#kit.PointSelection) return this.#run('move', this.#pointRows(target, 'move'), by);
    this.#checkPoint(target, 'move');
    // A callback reads the point as it stands in this state.
    if (typeof by === 'function') return this.#run('move', this.#rowsOf(target, 'move'), by);
    checkXY(by, 'a move');
    this.#append({ op: 'move', point: target, by });
  }

  set(points: PointSelection, attrs: Record<string, number> | ((p: Vertex) => Record<string, number>)): void;
  set(point: PointRef, attrs: Record<string, number>): void;
  set(target: PointRef | PointSelection, attrs: Record<string, number> | ((p: Vertex) => Record<string, number>)): void {
    if (target instanceof this.#kit.PointSelection) return this.#run('set', this.#pointRows(target, 'set'), attrs);
    this.#checkPoint(target, 'set');
    if (typeof attrs === 'function') return this.#run('set', this.#rowsOf(target, 'set'), attrs);
    checkNames(attrs, this.#names, 'a set');
    this.#append({ op: 'set', point: target, attrs: byValue(attrs) });
  }

  setEdge(edge: EdgeRef, attrs: Record<string, number>): void {
    checkEdge(edge, 'setEdge');
    checkNames(attrs, this.#enames, 'setEdge', { edge: true });
    this.#append({ op: 'setEdge', edge, attrs: byValue(attrs) });
  }

  setEdges(selection: EdgeSelection, attrs: Record<string, number> | ((e: Edge) => Record<string, number>)): void {
    const rows = this.#edgeRows(selection, 'setEdges');
    if (rows.length === 0) return;
    const cur = this.#cur;
    const values = new Array<unknown>(rows.length);
    if (typeof attrs === 'function') {
      for (let i = 0; i < rows.length; i++) {
        const written = attrs(cur.edge(rows[i]));
        checkNames(written, this.#enames, 'setEdges', { edge: true });
        values[i] = written;
      }
    } else {
      checkNames(attrs, this.#enames, 'setEdges', { edge: true });
      values.fill(byValue(attrs));
    }
    this.#entries.push(new Run('setEdge', rows, values, cur));
  }

  setFaces(faces: Faces | FaceSelection, attrs: Record<string, number> | ((f: Face) => Record<string, number>)): void {
    const cells = faces.collection;
    // Faces of an earlier state are the same faces when their walls are:
    // the key says which, and the fold drops a key this state lacks.
    if (cells.source !== this.#cur && faces.length > 0 && this.#strangerTo(cells.source)) {
      throw new Error(`steps: setFaces names ${faces.length} faces and this state has none of their walls — the faces are of another material, or everything they named is gone`);
    }
    const keys = cells.keys();
    for (const index of faces.indices) {
      const written = typeof attrs === 'function' ? attrs(cells.at(index)) : attrs;
      checkFaceAttrs(written);
      this.#append({ op: 'setFace', face: keys[index], attrs: byValue(written) });
    }
  }

  addPoint(position: XY, attributes: Record<string, number>): AddPointEdit {
    checkXY(position, 'a new vertex');
    checkNames(attributes, this.#names, 'a new vertex', { complete: true });
    return Object.freeze(this.#append(new AddPointRecord(position, byValue(attributes), this, this.#minted++)));
  }

  connect(a: PointRef, b: PointRef, edgeAttributes: Record<string, number> = NO_COLUMNS): void {
    this.#checkPoint(a, 'connect');
    this.#checkPoint(b, 'connect');
    // Unknown names fail now; completeness is judged once the fold knows
    // the pair is new (an existing pair is left as it is and needs nothing).
    checkNames(edgeAttributes, this.#enames, 'a new edge');
    this.#append({ op: 'connect', a, b, attrs: byValue(edgeAttributes) });
  }

  disconnect(edges: EdgeSelection): void;
  disconnect(edge: EdgeRef): void;
  disconnect(target: EdgeRef | EdgeSelection): void {
    if (target instanceof this.#kit.EdgeSelection) {
      const rows = this.#edgeRows(target, 'disconnect');
      if (rows.length > 0) this.#entries.push(new Run('disconnect', rows, null, this.#cur));
      return;
    }
    checkEdge(target, 'disconnect');
    this.#append({ op: 'disconnect', edge: target });
  }

  remove(points: PointSelection): void;
  remove(point: PointRef): void;
  remove(target: PointRef | PointSelection): void {
    if (target instanceof this.#kit.PointSelection) {
      const rows = this.#pointRows(target, 'remove');
      if (rows.length > 0) this.#entries.push(new Run('remove', rows, null, this.#cur));
      return;
    }
    this.#checkPoint(target, 'remove');
    this.#append({ op: 'remove', point: target });
  }

  split(edge: EdgeRef, opts: SplitOpts = {}): SplitEdit {
    checkEdge(edge, 'split');
    return Object.freeze(this.#append(new SplitRecord(splitRecord(edge, this.#splitAt(opts, 'split'), opts), this, this.#minted++)));
  }

  replace(selection: EdgeSelection, motif: Material, opts: ReplaceOpts = {}): void {
    // The motif's CHAIN, not its rows. A material's row order is an
    // accident of how it was built — a split point is inserted after its
    // edge's start, and an added point goes last — so threading rows
    // would silently draw a different motif than the one on screen.
    const chains = motif.curves();
    if (chains.length !== 1) throw new Error(`steps: replace: a motif is one open chain, and this one has ${chains.length === 0 ? 'none' : String(chains.length)}. Give the motif's points the edges that join them in order.`);
    if (chains[0].closed) throw new Error('steps: replace: a motif is an open chain, and this one is closed');
    const pts = chains[0].pts;
    if (pts.length < 2) throw new Error('steps: replace: a motif needs at least two points');
    const [mx0, my0] = pts[0];
    const [mx1, my1] = pts[pts.length - 1];
    const mdx = mx1 - mx0;
    const mdy = my1 - my0;
    const span = mdx * mdx + mdy * mdy;
    if (!(span > 0)) throw new Error('steps: replace: a motif must start and end at different points');
    // The motif in its own frame: along the line from first to last, and
    // across it. Both are fractions of the motif's own span, so the shape
    // rides any edge at any length and any angle.
    const local = pts.slice(1, -1).map(([px, py]) => {
      const ux = px - mx0;
      const uy = py - my0;
      return [(ux * mdx + uy * mdy) / span, (ux * -mdy + uy * mdx) / span] as [number, number];
    });
    const rows = this.#edgeRows(selection, 'replace');
    if (rows.length === 0) return;
    const cur = this.#cur;
    const names = this.#names;
    const flip = opts.flip;
    for (const row of rows) {
      const e = cur.edge(row);
      this.#append({ op: 'disconnect', edge: e });
      const ex = e.b.x - e.a.x;
      const ey = e.b.y - e.a.y;
      const across = (typeof flip === 'function' ? flip(e, this.#k) : flip === true) ? -1 : 1;
      // A motif point stands between the edge's ends, so it inherits from
      // them the way a split point does: the declared transfer policy,
      // interpolating by default. Every declared column must be given,
      // because a column is never dropped in silence.
      const inherit = (at: number): Record<string, number> => {
        const out: Record<string, number> = {};
        for (const name of names) {
          const va = e.a[name];
          const vb = e.b[name];
          out[name] = cur.transfers[name] === 'nearest' ? (at <= 0.5 ? va : vb) : va + (vb - va) * at;
        }
        return out;
      };
      // The records below are the library's own values, made here: they
      // are frozen as they are, with no copy and no second check.
      const childEdge = this.#enames.length > 0 ? Object.freeze(inheritEdge(cur, e.attrs, 1 / (local.length + 1))) : NO_COLUMNS;
      const landed = (this.#landed ??= new Landing(cur));
      // Two positions this close are one place worked out twice: the
      // motifs of two walls that meet at a tip, or a tip on a corner.
      const tol = WELD * Math.hypot(ex, ey);
      const end = this.#viewAt(e.b.index);
      let from: PointRef = this.#viewAt(e.a.index);
      for (const [along, off] of local) {
        const o = off * across;
        const x = e.a.x + along * ex - o * ey;
        const y = e.a.y + along * ey + o * ex;
        const found = landed.find(x, y, tol);
        let at: PointRef;
        if (found === undefined) {
          at = this.#append(new AddPointRecord([x, y], Object.freeze(inherit(along)), this, this.#minted++));
          landed.add(x, y, at);
        } else at = typeof found === 'number' ? this.#viewAt(found) : found;
        if (at !== from) this.#append({ op: 'connect', a: from, b: at, attrs: childEdge });
        from = at;
      }
      if (from !== end) this.#append({ op: 'connect', a: from, b: end, attrs: childEdge });
    }
  }

  splitEdges(selection: EdgeSelection, opts: SplitOpts = {}): void {
    const rows = this.#edgeRows(selection, 'splitEdges');
    const end = Math.min(Math.max(opts.at ?? 0.5, 0), 1);
    if ((end === 0 || end === 1) && (opts.point || opts.edges)) throw new Error('steps: a split at an endpoint creates nothing — point/edge overrides would modify existing data');
    const at = this.#splitAt(opts, 'splitEdges');
    if (rows.length === 0) return;
    // One split per edge, every one the same ask: the record without its edge.
    const { edge: _edge, ...ask } = splitRecord(0 as EdgeId, at, opts);
    this.#entries.push(new Run('split', rows, new Array<unknown>(rows.length).fill(Object.freeze({ op: 'split', ...ask })), this.#cur));
  }

  extrude(selection: PointSelection | Vertex, spec: (p: Vertex) => ChildSpec | ChildSpec[], opts?: { inherit?: boolean }): void {
    const rows = this.#pointRows(selection, 'extrude');
    const inherit = opts?.inherit === true;
    const cur = this.#cur;
    const names = this.#names;
    const inherited = (p: Vertex): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const name of names) out[name] = cur.attrs[name][p.index];
      return out;
    };
    for (const row of rows) {
      const p = this.#viewAt(row);
      const specs = spec(p);
      for (const sp of Array.isArray(specs) ? specs : [specs]) {
        const hasPos = sp.position !== undefined;
        const hasTo = sp.to !== undefined;
        if (hasPos === hasTo) throw new Error('steps: extrude needs exactly one of { position } (a new child) or { to } (an existing target)');
        const own = (sp as { attributes?: Record<string, number> }).attributes ?? {};
        const target: PointRef = hasPos ? this.addPoint(sp.position!, inherit ? { ...inherited(p), ...own } : own) : sp.to!;
        this.connect(p, target, sp.edgeAttributes ?? NO_COLUMNS);
      }
    }
  }
}

// ---- the fold ---------------------------------------------------------------------

/**
 * @internal Run one pass over `cur` and land its batch as the next state.
 * What the fold drops is pushed onto `dropped`; `seal` hands that list to
 * the state it makes (the last state of a `steps` call carries it).
 */
export function stepOnce(cur: Material, k: number, rule: StepRule, iteration: number, kit: StepKit, dropped: Dropped[] = [], seal = false): Material {
  const batch = new Batch(cur, k, kit);
  adopt(batch, rule(cur, batch, k));
  return land(cur, batch, k, iteration, kit, dropped, seal);
}

/** One split the fold will cut: its record, or its member of a run. */
interface Req { rec: SplitEdit | null; run: Run | null; i: number; ask: Omit<SplitEdit, 'op' | 'edge'>; at: number; explicit: Record<string, number> }
interface Cut { at: number; point: Record<string, number> }
/** What the fold knows of one new point's record: whether the batch
 * removes it, its verdict once judged (null lands), the end a split at an
 * end names, the cut a split makes, and the row it lands at. */
interface Slot { removed: boolean; judged: boolean; verdict: DropReason | null; end: number; cut: Req | null; row: number }

function land(cur: Material, batch: Batch, k: number, iteration: number, kit: StepKit, dropped: Dropped[], seal: boolean): Material {
  const { Material } = kit;
  const { entries, handed, minted, names, enames } = Batch.parts(batch);
  const n = cur.n;
  const m = cur.edgeCount;
  // A record the batch made is frozen once it is reachable; one the sketch
  // handed back stays as the sketch made it.
  const drop = (edit: Edit, reason: DropReason) => {
    if (handed === null || !handed.has(edit)) Object.freeze(edit);
    dropped.push(Object.freeze({ edit, reason, k }));
  };
  const dropAt = (e: Edit | Run, i: number, reason: DropReason) => drop(e instanceof Run ? e.record(i) : e, reason);

  /** The row of an existing point, or -1 when it is gone. */
  const pointRow = (r: Vertex | PointId): number => {
    if (typeof r === 'number') return cur.rowOfPoint(r);
    return ownerOf(r) === cur ? r.index : cur.rowOfPoint(r.id);
  };
  const edgeRow = (e: EdgeRef): number => {
    if (typeof e === 'number') return cur.rowOfEdge(e);
    return ownerOf(e as unknown as Vertex) === cur ? e.index : cur.rowOfEdge(e.id);
  };
  const clamp = (at: number) => Math.min(Math.max(at, 0), 1);

  // ---- sort the list by op, keeping list order within each ----
  const pointEdits: (MoveEdit | SetEdit | Run)[] = [];
  const edgeSets: (SetEdgeEdit | Run)[] = [];
  const faceSets: SetFaceEdit[] = [];
  const adds: AddPointEdit[] = [];
  const addSlots: Slot[] = [];
  const links: ConnectEdit[] = [];
  const cuts: (DisconnectEdit | Run)[] = [];
  const removes: (RemoveEdit | Run)[] = [];
  const splitAsks: (SplitEdit | Run)[] = [];
  /** Every new point's record this list holds: only these can land. The
   * batch's own records find theirs by the slot they carry; a record the
   * sketch wrote, by identity. */
  const own: (Slot | undefined)[] = new Array(minted);
  const others = new Map<object, Slot>();
  const fresh = (): Slot => ({ removed: false, judged: false, verdict: null, end: -1, cut: null, row: -1 });
  const slot = (r: object): Slot => {
    const i = slotIn(r, batch);
    if (i >= 0) return (own[i] ??= fresh());
    let s = others.get(r);
    if (s === undefined) others.set(r, (s = fresh()));
    return s;
  };
  const slots = {
    get(r: object): Slot | undefined {
      const i = slotIn(r, batch);
      return i >= 0 ? own[i] : others.get(r);
    },
  };
  for (const e of entries) {
    if (e instanceof Run) {
      switch (e.op) {
        case 'move': case 'set': pointEdits.push(e); break;
        case 'setEdge': edgeSets.push(e); break;
        case 'remove': removes.push(e); break;
        case 'disconnect': cuts.push(e); break;
        case 'split': splitAsks.push(e); break;
      }
      continue;
    }
    switch (e.op) {
      case 'move': case 'set': pointEdits.push(e); break;
      case 'setEdge': edgeSets.push(e); break;
      case 'setFace': faceSets.push(e); break;
      case 'addPoint': adds.push(e); addSlots.push(slot(e)); break;
      case 'connect': links.push(e); break;
      case 'disconnect': cuts.push(e); break;
      case 'remove': removes.push(e); break;
      case 'split': splitAsks.push(e); slot(e); break;
    }
  }

  /** Whether the batch asks for any change of rows or edges. When it does
   * not, the rows, the edges and every id stay as they are. */
  const structural = removes.length + cuts.length + adds.length + links.length + splitAsks.length > 0;

  // ---- removals and disconnections: they beat every other ask on what they name ----
  const removedRows = new Set<number>();
  const removeRow = (row: number, e: Edit | Run, i: number) => {
    if (removedRows.has(row)) dropAt(e, i, 'already');
    else removedRows.add(row);
  };
  for (const r of removes) {
    if (r instanceof Run) {
      for (let i = 0; i < r.rows.length; i++) removeRow(r.rows[i], r, i);
      continue;
    }
    const p = r.point;
    if (isNewPoint(p)) {
      const s = slots.get(p);
      if (s === undefined) drop(r, 'gone');
      else if (s.removed) drop(r, 'already');
      else s.removed = true;
      continue;
    }
    const row = pointRow(p);
    if (row < 0) drop(r, 'gone');
    else removeRow(row, r, 0);
  }
  const disconnected = new Set<number>();
  const disconnectRow = (row: number, e: Edit | Run, i: number) => {
    if (disconnected.has(row)) dropAt(e, i, 'already');
    else disconnected.add(row);
  };
  for (const r of cuts) {
    if (r instanceof Run) {
      for (let i = 0; i < r.rows.length; i++) disconnectRow(r.rows[i], r, i);
      continue;
    }
    const row = edgeRow(r.edge);
    if (row < 0) drop(r, 'gone');
    else disconnectRow(row, r, 0);
  }
  const incident = (row: number) => removedRows.has(cur.edgeList[2 * row]) || removedRows.has(cur.edgeList[2 * row + 1]);

  // ---- new points: which land ----
  // Each distinct new-point record is judged once. A record listed twice
  // lands once; the repeat is `already`, or the first one's reason.
  const again = (r: AddPointEdit | SplitEdit, s: Slot): boolean => {
    if (!s.judged) return false;
    drop(r, s.verdict ?? 'already');
    return true;
  };
  const judge = (r: AddPointEdit | SplitEdit, s: Slot, v: DropReason | null) => {
    s.judged = true;
    s.verdict = v;
    if (v) drop(r, v);
  };
  const addOrder: AddPointEdit[] = [];
  const addOrderSlots: Slot[] = [];
  for (let j = 0; j < adds.length; j++) {
    const r = adds[j];
    const s = addSlots[j];
    if (again(r, s)) continue;
    const v: DropReason | null = s.removed ? 'removed' : !Number.isFinite(vx(r.position)) || !Number.isFinite(vy(r.position)) || !finiteValues(r.attrs) ? 'not-finite' : null;
    judge(r, s, v);
    if (!v) { addOrder.push(r); addOrderSlots.push(s); }
  }
  const splits = new Map<number, Req[]>(); // by ORIGINAL edge row, in the order first asked
  const plainNotFinite = (o: unknown) => o !== undefined && typeof o !== 'function' && !finiteValues(o as Record<string, number>);
  /** Judge one split ask on an existing edge row: why it drops, or null
   * once it is queued (a cut) or names an end (`end`). */
  const judgeSplit = (row: number, ask: Omit<SplitEdit, 'op' | 'edge'>, req: Req, onEnd: (end: number) => void): DropReason | null => {
    if (!Number.isFinite(ask.at) || plainNotFinite(ask.point) || plainNotFinite(ask.edges)) return 'not-finite';
    const at = clamp(ask.at);
    if (at === 0 || at === 1) {
      // A split at an end creates nothing and names that end.
      const end = cur.edgeList[2 * row + at];
      if (removedRows.has(end)) return 'removed';
      onEnd(end);
      return null;
    }
    if (incident(row)) return 'removed';
    if (disconnected.has(row)) return 'disconnected';
    req.at = at;
    const list = splits.get(row) ?? [];
    list.push(req);
    splits.set(row, list);
    return null;
  };
  for (const r of splitAsks) {
    if (r instanceof Run) {
      const ask = r.value(0) as Omit<SplitEdit, 'op' | 'edge'>;
      for (let i = 0; i < r.rows.length; i++) {
        const v = judgeSplit(r.rows[i], ask, { rec: null, run: r, i, ask, at: 0, explicit: {} }, () => {});
        if (v) dropAt(r, i, v);
      }
      continue;
    }
    const s = slots.get(r)!;
    if (again(r, s)) continue;
    const row = edgeRow(r.edge);
    const req: Req = { rec: r, run: null, i: 0, ask: r, at: 0, explicit: {} };
    const v = row < 0 ? 'gone' : s.removed ? 'removed' : judgeSplit(row, r, req, (end) => { s.end = end; });
    if (!v && s.end < 0) s.cut = req;
    judge(r, s, v);
  }
  const reqRecord = (q: Req): Edit => q.rec ?? q.run!.record(q.i);

  // ---- moves and point writes on the state's own points ----
  const nx = Float64Array.from(cur.x);
  const ny = Float64Array.from(cur.y);
  const nattrs: Record<string, Float64Array> = {};
  for (const name of names) nattrs[name] = Float64Array.from(cur.attrs[name]);
  const neattrs: Record<string, Float64Array> = {};
  for (const name of enames) neattrs[name] = Float64Array.from(cur.edgeAttrs[name]);
  // A move is a STEP in the material's space. The moves a batch holds add
  // up first, as vectors in the point's own frame, and the sum is walked
  // once with `exp` after them all. The flat plane's walk is addition, so a
  // flat material (or one with no space) adds in place as it always has.
  const space = cur.space !== undefined && cur.space.kind !== 'euclidean' ? cur.space : null;
  const walk = space ? { dx: new Float64Array(n), dy: new Float64Array(n), rows: new Set<number>() } : null;
  const moveRow = (row: number, by: XY, e: Edit | Run, i: number) => {
    const dx = vx(by);
    const dy = vy(by);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return dropAt(e, i, 'not-finite');
    if (walk) { walk.dx[row] += dx; walk.dy[row] += dy; walk.rows.add(row); }
    else { nx[row] += dx; ny[row] += dy; }
  };
  const setRow = (row: number, attrs: Readonly<Record<string, number>>, e: Edit | Run, i: number) => {
    if (!finiteValues(attrs)) return dropAt(e, i, 'not-finite');
    for (const name in attrs) nattrs[name][row] = attrs[name];
  };
  /** Moves and writes that name a cut vertex: judged once the cuts are. */
  const later: (MoveEdit | SetEdit)[] = [];
  for (const e of pointEdits) {
    if (e instanceof Run) {
      const move = e.op === 'move';
      for (let i = 0; i < e.rows.length; i++) {
        const row = e.rows[i];
        if (removedRows.has(row)) dropAt(e, i, 'removed');
        else if (move) moveRow(row, e.values![i] as XY, e, i);
        else setRow(row, e.values![i] as Record<string, number>, e, i);
      }
      continue;
    }
    let row: number;
    const p = e.point;
    if (isNewPoint(p)) {
      const s = slots.get(p);
      if (s === undefined || s.end < 0) { later.push(e); continue; }
      row = s.end;
    } else {
      row = pointRow(p);
      if (row < 0) { drop(e, 'gone'); continue; }
      if (removedRows.has(row)) { drop(e, 'removed'); continue; }
    }
    if (e.op === 'move') moveRow(row, e.by, e, 0);
    else setRow(row, e.attrs, e, 0);
  }
  if (space && walk) {
    for (const row of walk.rows) {
      const q = space.exp([cur.x[row], cur.y[row]], [walk.dx[row], walk.dy[row]]);
      nx[row] = q[0];
      ny[row] = q[1];
    }
  }
  const setEdgeRow = (row: number, attrs: Readonly<Record<string, number>>, e: Edit | Run, i: number) => {
    if (incident(row)) dropAt(e, i, 'removed');
    else if (disconnected.has(row)) dropAt(e, i, 'disconnected');
    else if (!finiteValues(attrs)) dropAt(e, i, 'not-finite');
    else for (const name in attrs) neattrs[name][row] = attrs[name];
  };
  for (const e of edgeSets) {
    if (e instanceof Run) {
      for (let i = 0; i < e.rows.length; i++) setEdgeRow(e.rows[i], e.values![i] as Record<string, number>, e, i);
      continue;
    }
    const row = edgeRow(e.edge);
    if (row < 0) drop(e, 'gone');
    else setEdgeRow(row, e.attrs, e, 0);
  }
  /** Face columns written in this step, by column name and face key. */
  const pendingFaces = new Map<string, Map<string, number>>();
  let faceKeys: readonly string[] | undefined;
  const keysOfFaces = () => (faceKeys ??= cur.faces().keys());
  if (faceSets.length > 0) {
    const known = new Set(keysOfFaces());
    for (const e of faceSets) {
      if (!known.has(e.face)) { drop(e, 'gone'); continue; }
      if (!finiteValues(e.attrs)) { drop(e, 'not-finite'); continue; }
      for (const name in e.attrs) {
        const column = pendingFaces.get(name) ?? new Map<string, number>();
        column.set(e.face, e.attrs[name]);
        pendingFaces.set(name, column);
      }
    }
  }

  if (!structural) {
    // A move or a write that names a new point names one this list does not hold.
    for (const e of later) drop(e, 'gone');
    return new Material(nx, ny, nattrs, Uint32Array.from(cur.edgeList), { iteration: iteration, history: [], edgeAttrs: neattrs, transfers: { ...cur.transfers }, edgeTransfers: { ...cur.edgeTransfers }, ids: { points: Float64Array.from(cur.pointIds), edges: Float64Array.from(cur.edgeIds), edgeRoots: Float64Array.from(cur.edgeRoots) }, faceAttrs: withWrites(cur.faceAttrs, pendingFaces, keysOfFaces), space: cur.space, dropped: seal ? dropped : undefined });
  }

  // ---- the moved state: split transfer callbacks read it ----
  // The same rows, moved: the split callbacks read this state and must see
  // the identities they will be asked about. Built only when something is cut.
  let movedEdges: Material['edges'] | undefined;
  if (splits.size > 0) {
    movedEdges = new Material(nx, ny, nattrs, cur.edgeList, { iteration: iteration, history: [], edgeAttrs: neattrs, transfers: { ...cur.transfers }, edgeTransfers: { ...cur.edgeTransfers }, ids: { points: Float64Array.from(cur.pointIds), edges: Float64Array.from(cur.edgeIds), edgeRoots: Float64Array.from(cur.edgeRoots) }, faceAttrs: cur.faceAttrs, space: cur.space }).edges;
  }

  // ---- resolve splits per original edge: sorted, one cut per place, one child-edge definition ----
  const cutsByEdge = new Map<number, Cut[]>();
  const childEdgeOverride = new Map<number, SplitEdit['edges']>();
  /** The asks whose child-edge definition one child's callback made not finite. */
  const childDefs = new Map<number, Req[]>();
  const landedCut = new Set<Req>();
  const conflicted = new Set<Req>();
  const sameDef = (a: unknown, b: unknown) => a === b || (typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b));
  for (const [row, reqs] of splits) {
    const parentEdge = movedEdges!.at(row);
    const pa = parentEdge.a;
    const pb = parentEdge.b;
    // Every split inherits from the state as it stood before any of them:
    // the moved columns, which all callbacks read.
    const inherit = (at: number): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const name of names) {
        const va = nattrs[name][pa.index];
        const vb = nattrs[name][pb.index];
        out[name] = cur.transfers[name] === 'nearest' ? (at <= 0.5 ? va : vb) : va + (vb - va) * at;
      }
      return out;
    };
    // Point overrides, each evaluated once on the moved state, in the order asked.
    const live: Req[] = [];
    for (const q of reqs) {
      const pt = typeof q.ask.point === 'function' ? q.ask.point(parentEdge, q.at) : q.ask.point;
      if (pt) {
        checkNames(pt, names, 'a split vertex');
        if (!finiteValues(pt)) {
          if (q.rec) slots.get(q.rec)!.verdict = 'not-finite';
          drop(reqRecord(q), 'not-finite');
          continue;
        }
        q.explicit = pt;
      }
      live.push(q);
    }
    // One cut per place. Two asks at one place that disagree on a column
    // conflict: both overrides go and the cut takes what it inherits.
    const byAt = new Map<number, Req[]>();
    for (const q of live) {
      const group = byAt.get(q.at);
      if (group) group.push(q);
      else byAt.set(q.at, [q]);
    }
    const cuts: Cut[] = [];
    for (const [at, group] of byAt) {
      const merged: Record<string, number> = {};
      let clash = false;
      for (const q of group) {
        for (const name in q.explicit) {
          if (name in merged && merged[name] !== q.explicit[name]) clash = true;
          merged[name] = q.explicit[name];
        }
      }
      if (clash) for (const q of group) if (Object.keys(q.explicit).length > 0) conflicted.add(q);
      cuts.push({ at, point: { ...inherit(at), ...(clash ? {} : merged) } });
    }
    cuts.sort((p, q) => p.at - q.at);
    cutsByEdge.set(row, cuts);
    // One child-edge definition per parent: definitions that disagree conflict.
    const defs = live.filter((q) => q.ask.edges !== undefined);
    let def: SplitEdit['edges'] = defs.length > 0 ? defs[0].ask.edges : undefined;
    if (defs.some((q) => !sameDef(def, q.ask.edges))) {
      def = undefined;
      for (const q of defs) conflicted.add(q);
    }
    childEdgeOverride.set(row, def);
    if (def !== undefined) childDefs.set(row, defs);
    for (const q of live) landedCut.add(q);
  }
  for (const q of conflicted) drop(reqRecord(q), 'conflict');

  // ---- compact rows: survivors in order, split vertices after their edge's start row, new points last ----
  const rowMap = new Int32Array(n).fill(-1);
  const ox: number[] = [];
  const oy: number[] = [];
  const oattrs: Record<string, number[]> = {};
  for (const name of names) oattrs[name] = [];
  // Identity rides beside the coordinates: a survivor's id is pushed where
  // its position is, and a row that did not exist before takes a fresh one.
  const oids: number[] = [];
  const mint = (): number => (mintIds(1)[0]);
  const cutRow = new Map<string, number>(); // `${edge}@${at}` → row
  const insertAfter = new Map<number, [number, Cut][]>();
  for (const [row, cuts] of cutsByEdge) {
    const a = cur.edgeList[2 * row];
    const list = insertAfter.get(a) ?? [];
    for (const c of cuts) list.push([row, c]);
    insertAfter.set(a, list);
  }
  for (let i = 0; i < n; i++) {
    if (removedRows.has(i)) continue;
    rowMap[i] = ox.length;
    ox.push(nx[i]);
    oy.push(ny[i]);
    oids.push(cur.pointIds[i]);
    for (const name of names) oattrs[name].push(nattrs[name][i]);
    for (const [row, c] of insertAfter.get(i) ?? []) {
      const e = movedEdges!.at(row);
      cutRow.set(`${row}@${c.at}`, ox.length);
      ox.push(e.a.x + (e.b.x - e.a.x) * c.at);
      oy.push(e.a.y + (e.b.y - e.a.y) * c.at);
      oids.push(mint()); // a vertex where an edge was cut is a new vertex
      for (const name of names) oattrs[name].push(c.point[name]);
    }
  }
  for (let j = 0; j < addOrder.length; j++) {
    const r = addOrder[j];
    addOrderSlots[j].row = ox.length;
    ox.push(vx(r.position));
    oy.push(vy(r.position));
    oids.push(mint());
    for (const name of names) oattrs[name].push(r.attrs[name]);
  }
  const place = (s: Slot | undefined) => {
    if (s === undefined) return;
    if (s.end >= 0) s.row = rowMap[s.end];
    else if (s.cut !== null && landedCut.has(s.cut)) s.row = cutRow.get(`${edgeRow(s.cut.rec!.edge)}@${s.cut.at}`)!;
  };
  for (const s of own) place(s);
  for (const s of others.values()) place(s);

  /** Where a reference lands in the next state, or why it does not. */
  const target = (r: PointRef): number | DropReason => {
    if (isNewPoint(r)) {
      const s = slots.get(r);
      if (s === undefined) return 'gone';
      if (s.removed) return 'removed';
      return s.verdict ? 'gone' : s.row;
    }
    const row = pointRow(r);
    if (row < 0) return 'gone';
    return removedRows.has(row) ? 'removed' : rowMap[row];
  };

  // ---- moves and writes on new points: they stand where they were made ----
  const newWalk = new Map<number, [number, number]>();
  for (const e of later) {
    const row = target(e.point);
    if (typeof row === 'string') { drop(e, row); continue; }
    if (e.op === 'set') {
      if (!finiteValues(e.attrs)) { drop(e, 'not-finite'); continue; }
      for (const name in e.attrs) oattrs[name][row] = e.attrs[name];
      continue;
    }
    const dx = vx(e.by);
    const dy = vy(e.by);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) { drop(e, 'not-finite'); continue; }
    const sum = newWalk.get(row) ?? [0, 0];
    sum[0] += dx;
    sum[1] += dy;
    newWalk.set(row, sum);
  }
  for (const [row, [dx, dy]] of newWalk) {
    if (space) [ox[row], oy[row]] = space.exp([ox[row], oy[row]], [dx, dy]);
    else { ox[row] += dx; oy[row] += dy; }
  }

  // ---- edges: survivors (split into chains), then new connections ----
  const edges: number[] = [];
  const eattrs: Record<string, number[]> = {};
  for (const name of enames) eattrs[name] = [];
  const eids: number[] = [];
  const eroots: number[] = [];
  /** A new edge row. `id` is its own; `root` is the wall it descends from,
   * which is itself unless a split made it. */
  const pushEdge = (a: number, b: number, attrs: Record<string, number>, id = mint(), root = id) => {
    edges.push(a, b);
    eids.push(id);
    eroots.push(root);
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
      // Nothing cut it: this is the same edge it was.
      pushEdge(a, b, parentAttrs, cur.edgeIds[e], cur.edgeRoots[e]);
      continue;
    }
    const override = childEdgeOverride.get(e);
    const stops = [0, ...cuts.map((c) => c.at), 1];
    const rows = [a, ...cuts.map((c) => cutRow.get(`${e}@${c.at}`)!), b];
    for (let i = 0; i + 1 < stops.length; i++) {
      const child: ChildInterval = { from: stops[i], to: stops[i + 1], fraction: stops[i + 1] - stops[i] };
      let extra = typeof override === 'function' ? override(movedEdges!.at(e), child) : override ?? {};
      checkNames(extra, enames, 'a child edge', { edge: true });
      if (!finiteValues(extra)) {
        // This child keeps what it inherits; the definition is reported once.
        for (const q of childDefs.get(e) ?? []) drop(reqRecord(q), 'not-finite');
        childDefs.delete(e);
        extra = {};
      }
      // A child is a new edge with a new id, but it is still a piece of the
      // wall its parent was: the root carries, so a face that lost nothing
      // but a subdivision still shares its boundary.
      pushEdge(rows[i], rows[i + 1], { ...inheritEdge(cur, parentAttrs, child.fraction), ...extra }, mint(), cur.edgeRoots[e]);
    }
  }
  const have = new Set<number>();
  for (let e = 0; e < edges.length; e += 2) have.add(pairKey(edges[e], edges[e + 1]));
  for (const l of links) {
    const ra = target(l.a);
    const rb = target(l.b);
    if (typeof ra === 'string' || typeof rb === 'string') { drop(l, ra === 'gone' || rb === 'gone' ? 'gone' : 'removed'); continue; }
    if (l.attrs !== undefined && !finiteValues(l.attrs)) { drop(l, 'not-finite'); continue; }
    // A link whose ends land on one vertex is no edge.
    if (ra === rb) { drop(l, 'self'); continue; }
    const key = pairKey(ra, rb);
    if (have.has(key)) { drop(l, 'already'); continue; } // an existing pair is left as it is
    const record = withAbsentEdge(l.attrs ?? NO_COLUMNS, enames);
    checkAttrs(record, enames, 'a new edge');
    have.add(key);
    pushEdge(ra, rb, record);
  }

  const attrs: Record<string, Float64Array> = {};
  for (const name of names) attrs[name] = Float64Array.from(oattrs[name]);
  const edgeAttrs: Record<string, Float64Array> = {};
  for (const name of enames) edgeAttrs[name] = Float64Array.from(eattrs[name]);
  return new Material(Float64Array.from(ox), Float64Array.from(oy), attrs, Uint32Array.from(edges), { iteration: iteration, history: [], edgeAttrs: edgeAttrs, transfers: { ...cur.transfers }, edgeTransfers: { ...cur.edgeTransfers }, ids: { points: Float64Array.from(oids), edges: Float64Array.from(eids), edgeRoots: Float64Array.from(eroots) }, faceAttrs: withWrites(cur.faceAttrs, pendingFaces, keysOfFaces), space: cur.space, dropped: seal ? dropped : undefined });
}
