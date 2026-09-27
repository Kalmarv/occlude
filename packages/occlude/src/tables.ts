/**
 * Tables: a graph is two tables of rows with minted ids — points, and
 * edges whose rows name two point ids — and there are three writes on a
 * table: add a row, remove a row, set a column. Faces are a third domain
 * with one write, `set`: a face is not a row, so its columns are keyed by
 * the walls it is made of. Every verb is a few of these writes.
 * `g.points`, `g.edges` and `g.faces` answer them and return the new
 * material; `extrude`, `split`, `replace` and `move` are recipes over them.
 *
 * The call judges the program and the table judges the data. A wrong
 * program (an undeclared column a new row leaves out, a reserved name, a
 * selection of an unrelated material, the wrong kind of member) throws.
 * Data that cannot land is skipped in silence: a write given nothing, an
 * edge row naming a point that is not there, one point twice or a pair
 * that is already an edge, and a value that is not finite.
 *
 * Nothing here mutates: each write builds a new material from the old
 * one's columns and keeps every identity it does not retire.
 *
 * The value you hold is the name. `point(xy, cols?)` and `edge(a, b, cols?)`
 * make a point or an edge with an id minted there and then; a view taken
 * from any state carries its id the same way. Such a value names its row in
 * every later state and in every write: add it, and the row it becomes is
 * the one a later write reaches through it. A reference is always a value
 * or a view — a bare position names nothing, and a write refuses it by
 * name. Adding a value the geometry holds already skips, and so does a
 * value the geometry does not hold, used as a reference.
 */

import { Material, mintIds, vertexReader, edgeReader, withAbsentEdge, EDGE_ABSENT, type Vertex, type Edge, type PointId, type EdgeId, type Transfer, type TransferPolicy, type EdgeTransfer, type FaceTransfer, type FaceColumn } from './material.js';
import { chainsOf } from './curves.js';
import { pointDomain, edgeDomain, pointsOf, edgesOf, notAPoint } from './relation.js';
import { faceTableOf, type Face, type FaceTable, type StatedFaces } from './faces.js';
import type { Corner, CornerDomain } from './corners.js';
import { Selection, rowOf, whereRows } from './selection.js';
import { isGraphForce, type GraphForce } from './forces.js';
import { vx, vy, type XY, type Vec } from './vec.js';
import type { Space } from './space.js';
import { ownerOf, pairKey, viewKind, valueKind, valueProto, describe } from './views.js';
import { Column, at64, atU32, kinds, kindOf, kindWords, valueAt, appendValues, keepRows as keepColumn, writerOf, type AnyColumn, type AnyKind, type AnyWriter, type ArrayColumn, type ColumnWriter } from './column.js';
import { isPlacement, type Placement } from './placement.js';
import { carryLinks, derivation, linkRows, record } from './derivation.js';

/** A point you hold: a position and its columns — the value is the name
 * of the row it becomes. */
export type PointValue = {
  readonly x: number;
  readonly y: number;
  /** @internal The id minted when it was made (not enumerable — a spread
   * copy is a plain position). Ids are the engine's; the value is the name. */
  readonly id: PointId;
} & Readonly<Record<string, number>>;

/** An edge you hold: its two ends (point values or views) and its columns. */
export type EdgeValue = {
  readonly a: PointValue | Vertex;
  readonly b: PointValue | Vertex;
  /** @internal The id minted when it was made. */
  readonly id: EdgeId;
} & Readonly<Record<string, unknown>>;

/** A point a write names: a point value, or a vertex view of this state
 * or of any other. */
export type PointEnd = PointValue | Vertex;
/** An edge row to add: its two ends. */
export type EdgeRowSpec = readonly [PointEnd | undefined, PointEnd | undefined];
/** An edge a write names: an edge value, or an edge view. */
export type EdgeEnd = EdgeValue | Edge;

/** Which point rows a `where` names: a point selection (of this state or an
 * earlier one), one point value or vertex, a list of them, or a predicate
 * over the rows. */
export type PointWhere = Selection<Vertex> | PointEnd | readonly PointEnd[] | ((p: Vertex) => unknown) | undefined;
/** Which edge rows a `where` names, the same four ways. */
export type EdgeWhere = Selection<Edge> | EdgeEnd | readonly EdgeEnd[] | ((e: Edge) => unknown) | undefined;

/** A column value: one value for every row, or one per row from its
 * view (see `CellValue` for the kinds; a function that answers nothing
 * leaves that row as it was). */
export type ColumnValue<V> = CellValue | ((row: V) => CellValue | undefined);

/** What a displacement in `move` may be: a vector, a function of the point,
 * or a force that the move prepares from the graph. A vector with a third
 * number moves `z` too — `[dx, dy, dz]` or `{ x, y, z }`, a third number
 * of 0 included — and gives a value that had none a `z` column. */
export type Displacement = XY | readonly [number, number, number] | ((p: Vertex) => XY | readonly [number, number, number]) | GraphForce;

/** How a point column crosses a split, a resample or a replace: the
 * trailing options record of `points.set`. */
export interface PointSetOpts { readonly transfer?: TransferPolicy }
/** How an edge column is shared by the children of a split edge: the
 * trailing options record of `edges.set`. */
export interface EdgeSetOpts { readonly transfer?: EdgeTransfer }
/** How a face column follows a change of walls, and what a face that
 * shares no wall with an old one starts from: the trailing options record
 * of `faces.set`. */
export interface FaceSetOpts { readonly transfer?: FaceTransfer; readonly fallback?: CellValue }
/** The options record after the record form of `points.set`, which names
 * several columns: one policy for all of them, or a policy by column —
 * `{ transfer: { b: 'nearest' } }` — for those it names. */
export interface PointRecordSetOpts { readonly transfer?: TransferPolicy | Readonly<Record<string, TransferPolicy>> }
/** The options record after the record form of `edges.set`: one policy,
 * or a policy by column. */
export interface EdgeRecordSetOpts { readonly transfer?: EdgeTransfer | Readonly<Record<string, EdgeTransfer>> }
/** The options record after the record form of `faces.set`: one policy,
 * or a policy by column, and the fallback. */
export interface FaceRecordSetOpts { readonly transfer?: FaceTransfer | Readonly<Record<string, FaceTransfer>>; readonly fallback?: CellValue }

// ---- the names a row owns ---------------------------------------------------------

/** The kinds of row a column lives on. */
export type RowKind = 'point' | 'edge' | 'face' | 'corner' | 'lattice face';

/** What a face row answers of its own, on every kind of face. */
const FACE_WORDS = [
  'index', 'id', 'area', 'perimeter', 'bounds', 'centroid', 'center', 'normal', 'corners',
  'edges', 'points', 'boundaryEdges', 'adjacent', 'contours', 'extract',
  'parent', 'children', 'depth', 'leaf', 'source',
];

/**
 * The names each kind of row answers of its own — its view's words — which
 * no column may take: a column reads flat on the row, beside them. The one
 * list per kind: every write, `point`, `edge`, the lattice and the
 * material's constructor ask `checkColumnName`. A lattice face is a face
 * with its grid place and its stencil. A word the row lets a column stand
 * in for — a point's `u`, `tangent`, `normal`, `placement`, `s`, `heading`
 * — is not here: a column of that name is what the row reads, on every
 * view of it. A point's `x` and `y` are its position: `points.set` writes
 * them, and a new point gives them as its place.
 */
const RESERVED: Readonly<Record<RowKind, ReadonlySet<string>>> = {
  point: new Set(['index', 'id', 'source', 'adjacent', 'edges', 'faces', 'corners']),
  edge: new Set(['index', 'id', 'source', 'a', 'b', 'length', 'root', 'center', 'adjacent', 'faces']),
  face: new Set(FACE_WORDS),
  corner: new Set(['index', 'id', 'source', 'point', 'face']),
  'lattice face': new Set([...FACE_WORDS, 'i', 'j', 'laplacian']),
};

/** @internal Every name a kind of row owns (a test reads it). */
export const reservedNames = (kind: RowKind): readonly string[] => [...RESERVED[kind]];

/** Refuse a column name a kind of row owns, by name. */
export function checkColumnName(kind: RowKind, name: string, who: string): void {
  if (RESERVED[kind].has(name)) throw new Error(`${who}: '${name}' is a reserved field of ${kind === 'lattice face' || kind === 'face' ? 'a face' : kind === 'edge' ? 'an edge' : `a ${kind}`}, not a column`);
}

/** Refuse a column name a NEW row may not give: a reserved name, and for a
 * point its position, which a new point gives as its place. */
export function checkNewColumnName(kind: RowKind, name: string, who: string): void {
  if (kind === 'point' && (name === 'x' || name === 'y')) throw new Error(`${who}: '${name}' is a reserved field of a new point, not a column — a new point gives its position as its place`);
  checkColumnName(kind, name, who);
}

// ---- building a new state --------------------------------------------------------

/** The columns a write builds its new state from: `m`'s own, shared, until
 * the write replaces one. A write never copies a column it does not
 * change, and a column it changes shares every leaf it does not touch. */
export interface Parts {
  x: Column;
  y: Column;
  attrs: Record<string, AnyColumn>;
  pointIds: Column;
  edgeList: Column<Uint32Array>;
  edgeAttrs: Record<string, AnyColumn>;
  edgeIds: Column;
  edgeRoots: Column;
  /** The kernel's names of the rows (see `MaterialStore.pointKeys`). */
  pointKeys: ArrayColumn<string> | null;
  edgeKeys: ArrayColumn<string> | null;
}

/** Every column of `m`, shared: the parts a write starts from. */
export function partsOf(m: Material): Parts {
  const s = m.store;
  return {
    x: s.x,
    y: s.y,
    attrs: { ...s.attrs },
    pointIds: s.pointIds,
    edgeList: s.edgeList,
    edgeAttrs: { ...s.edgeAttrs },
    edgeIds: s.edgeIds,
    edgeRoots: s.edgeRoots,
    pointKeys: s.pointKeys,
    edgeKeys: s.edgeKeys,
  };
}

/** @internal What a new state hands on besides the rows: by default `m`'s
 * own — its policies, face columns, stated faces, space and key — at its
 * iteration, with no history. */
export interface Carry {
  iteration?: number;
  history?: readonly Material[];
  transfers?: Record<string, TransferPolicy>;
  edgeTransfers?: Record<string, EdgeTransfer>;
  faceAttrs?: Record<string, FaceColumn>;
  /** The stated faces, when the write changes their corners. */
  faces?: StatedFaces;
  /** The space the coordinates belong to, when it is not `m`'s. */
  space?: Space;
  /** The value's key (see `Material.key`), when it is not `m`'s. */
  key?: string;
  /** The value's area, when it is not its own closed chains (see
   * `areaMaterial`). */
  area?: () => Material;
}

/** The new state: `m`'s policies, face columns, space, key and iteration,
 * with these rows — and `m`'s stated faces, which the new state keeps only
 * when its edges are `m`'s (see `statedFor`). A write keeps row identity,
 * so what a row answers as `source` and `u` (derivation.ts) goes with it. */
function make(m: Material, p: Parts, carry: Carry = {}): Material {
  return carryLinks(m, build(m, p, carry));
}

/** `make` without the links. */
function build(m: Material, p: Parts, carry: Carry): Material {
  return new Material(p.x, p.y, p.attrs, p.edgeList, {
    iteration: carry.iteration ?? m.iteration,
    history: carry.history ?? [],
    edgeAttrs: p.edgeAttrs,
    transfers: carry.transfers ?? { ...m.transfers },
    edgeTransfers: carry.edgeTransfers ?? { ...m.edgeTransfers },
    ids: { points: p.pointIds, edges: p.edgeIds, edgeRoots: p.edgeRoots },
    keys: { points: p.pointKeys, edges: p.edgeKeys },
    faceAttrs: carry.faceAttrs ?? m.faceAttrs,
    from: m,
    ...(carry.space !== undefined ? { space: carry.space } : {}),
    ...(carry.key !== undefined ? { key: carry.key } : {}),
    ...(carry.area !== undefined ? { area: carry.area } : {}),
    faces: carry.faces ?? m.stated,
  });
}

/** The area of `m` for a new state whose rows are where `m`'s are — a
 * column write, a face or corner write, a step of `t.steps` — when `m`
 * has one of its own (a level set: see `areaMaterial`): the one built
 * already, or the rule that builds it. A write that moves, adds or
 * removes rows leaves it behind, and the new state's area is its own
 * closed chains. */
function keptArea(m: Material): (() => Material) | undefined {
  const built = m.cache.area;
  return built !== undefined ? () => built : m.cache.areaMake;
}

/**
 * @internal A new state of `m`: its columns, shared, with `changes` in
 * place of the ones a verb made anew, and what it hands on (`carry`, by
 * default `m`'s own). The one door every rebuild goes through — a table
 * write, a kernel's rows (`PointRows`, `EdgeRows`), a new position column,
 * a statement of faces — so every column of every kind, the ids, the
 * kernel's names, the key and the links of the rows it keeps go with it,
 * and a column no verb changed is the same column.
 */
export function rebuild(m: Material, changes: Partial<Parts> = {}, carry: Carry = {}): Material {
  return make(m, { ...partsOf(m), ...changes }, carry);
}

/** @internal `m` at another iteration and with a history: what `t.steps`
 * hands on between steps and returns at the end. Every row carries its
 * links, and every column is shared. */
export function restamp(m: Material, iteration: number, history: readonly Material[] = []): Material {
  return carryLinks(m, build(m, partsOf(m), { iteration, history, area: keptArea(m) }));
}

// ---- rows a kernel builds ----------------------------------------------------------
//
// A kernel that rebuilds a geometry — a resample, a spline, a cut, a planar
// walk — says where each row of its answer comes from, and these build every
// column of every kind from that, by one rule: a number and a vector
// interpolate by the column's policy; a boolean, a string, a reference and a
// placement never do — a row made between two rows takes the nearer one's
// value, the first on a tie, as a split's point does. An edge made from an
// edge takes its values, a `'distribute'` number or vector its share.

/**
 * @internal The point rows a kernel builds from `m`, each said by where it
 * comes from: a row of `m` kept as it is, identity and all (`keep`), a new
 * row with its values (`copy`), or a new row `t` of the way from one row to
 * another (`between`). The kernel works out each position and gives it.
 * `transfer` overrides the columns' policies for this call, as
 * `resample({ transfer })` does: a number or a function is a rule for a
 * column of numbers, and refused by name on any other kind.
 */
export class PointRows {
  /** Each row's position: what the kernel reads back as it goes. */
  readonly x: number[] = [];
  readonly y: number[] = [];
  /** Each row's row of `m` (its value, or the start of its blend), the
   * other end (-1: none), the parameter, its id (NaN: a new one, minted by
   * `done` in row order) and the row of `m` whose kernel name it keeps
   * (-1: none). */
  private readonly a: number[] = [];
  private readonly b: number[] = [];
  private readonly t: number[] = [];
  private readonly ids: number[] = [];
  private readonly kept: number[] = [];
  private readonly rules: Readonly<Record<string, Transfer>>;

  constructor(private readonly m: Material, private readonly who: string, transfer?: Readonly<Record<string, Transfer>>) {
    this.rules = transfer === undefined ? m.transfers : { ...m.transfers, ...transfer };
  }

  /** How many rows so far. */
  get length(): number {
    return this.x.length;
  }

  /** Row `i` of `m`, kept: its values and its identity, at (x, y) — where
   * it is, unless the kernel moves it. */
  keep(i: number, x = at64(this.m.store.x, i), y = at64(this.m.store.y, i)): number {
    return this.push(i, -1, 0, x, y, at64(this.m.store.pointIds, i), i);
  }

  /** A new row with the values of row `i` of `m`, at (x, y); its id is
   * `id`, or minted. */
  copy(i: number, x = at64(this.m.store.x, i), y = at64(this.m.store.y, i), id = NaN): number {
    return this.push(i, -1, 0, x, y, id, -1);
  }

  /** A new row at (x, y), `t` of the way from row `a` of `m` to row `b`;
   * its id is `id`, or minted. */
  between(a: number, b: number, t: number, x: number, y: number, id = NaN): number {
    return this.push(a, b, t, x, y, id, -1);
  }

  private push(a: number, b: number, t: number, x: number, y: number, id: number, kept: number): number {
    this.a.push(a);
    this.b.push(b);
    this.t.push(t);
    this.x.push(x);
    this.y.push(y);
    this.ids.push(id);
    this.kept.push(kept);
    return this.x.length - 1;
  }

  /** The rows as parts: positions, every column of `m`, the ids (the new
   * ones minted now, in row order) and the kernel's names. */
  done(): Pick<Parts, 'x' | 'y' | 'attrs' | 'pointIds' | 'pointKeys'> {
    const s = this.m.store;
    const n = this.x.length;
    const attrs: Record<string, AnyColumn> = {};
    // A rule that is a function is the sketch's code: it runs row by row,
    // each row's columns in the record's order, as the rows were made.
    const called: Record<string, Float64Array> = {};
    for (const name of s.attrNames) if (typeof this.rules[name] === 'function' && s.attrs[name] instanceof Column) called[name] = new Float64Array(n);
    const calls = Object.keys(called);
    if (calls.length > 0) {
      for (let r = 0; r < n; r++) {
        if (this.b[r] < 0) continue;
        for (const name of calls) {
          const rule = this.rules[name] as (a: Vertex, b: Vertex, t: number) => number;
          called[name][r] = rule(this.m.vertex(this.a[r]), this.m.vertex(this.b[r]), this.t[r]);
        }
      }
    }
    for (const name of s.attrNames) attrs[name] = this.column(name, s.attrs[name], called[name]);
    const keys = s.pointKeys;
    return {
      x: Column.of(Float64Array.from(this.x)),
      y: Column.of(Float64Array.from(this.y)),
      attrs,
      pointIds: Column.of(withMinted(this.ids)),
      pointKeys: keys === null ? null : (kinds.string.from(this.kept.map((i) => (i < 0 ? '' : keys.get(i)))) as ArrayColumn<string>),
    };
  }

  /** One column of `m` over the rows (`called`: a function rule's values,
   * worked out already). */
  private column(name: string, col: AnyColumn, called: Float64Array | undefined): AnyColumn {
    const { a, b, t } = this;
    const n = a.length;
    const rule = this.rules[name] ?? 'interpolate';
    if (col instanceof Column) {
      const v = col.flat();
      const out = new Float64Array(n);
      for (let r = 0; r < n; r++) {
        const i = a[r];
        const j = b[r];
        if (j < 0) out[r] = v[i];
        else if (called !== undefined) out[r] = called[r];
        else if (rule === 'nearest') out[r] = t[r] <= 0.5 ? v[i] : v[j];
        else if (typeof rule === 'number') out[r] = rule;
        else out[r] = v[i] + (v[j] - v[i]) * t[r];
      }
      return Column.of(out);
    }
    const kind = col.kind;
    if (typeof rule !== 'string') throw new Error(`${this.who}: the transfer of '${name}' is ${typeof rule === 'number' ? 'a number' : 'a function'}, a rule for a column of numbers — '${name}' holds ${kindWords(kind)} a row; its transfer is 'interpolate' or 'nearest'`);
    const interpolate = rule === 'interpolate';
    const values = new Array<unknown>(n);
    for (let r = 0; r < n; r++) values[r] = b[r] < 0 ? valueAt(col, a[r]) : typedBetween(col, a[r], b[r], t[r], interpolate);
    return columnFrom(kind, values);
  }
}

/** Ids a kernel gave its rows, NaN where a row is new: the new ones
 * minted, in row order. */
function withMinted(given: readonly number[]): Float64Array {
  const out = Float64Array.from(given);
  let fresh = 0;
  for (let k = 0; k < out.length; k++) if (out[k] !== out[k]) fresh++;
  if (fresh === 0) return out;
  const minted = mintIds(fresh);
  let next = 0;
  for (let k = 0; k < out.length; k++) if (out[k] !== out[k]) out[k] = minted[next++];
  return out;
}

/** A column of `kind` holding `values` (each a stored value of it). */
function columnFrom(kind: AnyKind, values: readonly unknown[]): AnyColumn {
  return (kind as unknown as { from(values: readonly unknown[]): AnyColumn }).from(values);
}

/**
 * @internal The edge columns of `m` read at rows a kernel makes, each row
 * said by the edge of `m` whose values it takes (`copy`) and, for a
 * `'distribute'` column, what share of them: `share` of that edge's value,
 * or the sum of `parts` — `[e0, w0, e1, w1, …]`, each edge's value times
 * its weight — for a row that covers several. A row of an edge rebuild
 * (`EdgeRows`) is one, and so is a point of `along`, which reads the edge
 * under it.
 */
export class EdgeCells {
  /** Per row: the edge it copies, its share (NaN: its `parts`). */
  protected readonly src: number[] = [];
  protected readonly share: number[] = [];
  protected readonly parts: (readonly number[] | undefined)[] = [];
  /** Does some column of `m` distribute? A kernel works out `parts` only
   * then. */
  readonly distributes: boolean;

  constructor(protected readonly m: Material) {
    let any = false;
    for (const name of m.store.edgeAttrNames) if (m.edgeTransfers[name] === 'distribute') any = true;
    this.distributes = any;
  }

  /** A row with the values of edge `e`, a distributed one `share` of it. */
  copyOf(e: number, share = 1): void {
    this.src.push(e);
    this.share.push(share);
    this.parts.push(undefined);
  }

  /** A row with the values of edge `e`, a distributed one the sum of
   * `parts`. */
  over(e: number, parts: readonly number[]): void {
    this.src.push(e);
    this.share.push(NaN);
    this.parts.push(parts);
  }

  /** Every edge column of `m` over the rows. */
  columns(): Record<string, AnyColumn> {
    const s = this.m.store;
    const out: Record<string, AnyColumn> = {};
    for (const name of s.edgeAttrNames) out[name] = this.column(s.edgeAttrs[name], this.m.edgeTransfers[name] === 'distribute');
    return out;
  }

  private column(col: AnyColumn, distribute: boolean): AnyColumn {
    const { src, share, parts } = this;
    const n = src.length;
    if (col instanceof Column) {
      const v = col.flat();
      const out = new Float64Array(n);
      for (let r = 0; r < n; r++) {
        if (!distribute) out[r] = v[src[r]];
        else if (!Number.isNaN(share[r])) out[r] = v[src[r]] * share[r];
        else {
          const p = parts[r]!;
          let sum = 0;
          for (let k = 0; k < p.length; k += 2) sum += v[p[k]] * p[k + 1];
          out[r] = sum;
        }
      }
      return Column.of(out);
    }
    const kind = col.kind;
    const values = new Array<unknown>(n);
    // Only a vector distributes: no other kind can declare it.
    for (let r = 0; r < n; r++) {
      if (!Number.isNaN(share[r]) || !distribute || kind.name !== 'vector') values[r] = typedShare(col, src[r], share[r], distribute);
      else {
        const p = parts[r]!;
        const sum = new Array<number>(kind.width).fill(0);
        for (let k = 0; k < p.length; k += 2) {
          const v = valueAt(col, p[k]) as number[];
          for (let c = 0; c < sum.length; c++) sum[c] += v[c] * p[k + 1];
        }
        values[r] = sum;
      }
    }
    return columnFrom(kind, values);
  }
}

/**
 * @internal The edge rows a kernel builds from `m`, between point rows of
 * its answer: an edge of `m` kept as it is, identity and lineage too
 * (`keep`); a piece of one — a new edge of its lineage, its columns the
 * parent's and a distributed one `share` of it (`from`); or a new edge
 * that covers edges of `m` — their sum for a distributed column, the
 * columns of the one under it for the rest — of its lineage or its own
 * (`cover`).
 */
export class EdgeRows extends EdgeCells {
  private readonly list: number[] = [];
  private readonly ids: number[] = [];
  /** Each row's lineage root (NaN: its own id). */
  private readonly roots: number[] = [];
  private readonly kept: number[] = [];

  /** How many rows so far. */
  get length(): number {
    return this.ids.length;
  }

  /** Edge `e` of `m`, kept, from point row `a` to point row `b`. */
  keep(e: number, a: number, b: number): void {
    this.copyOf(e);
    this.push(a, b, at64(this.m.store.edgeIds, e), at64(this.m.store.edgeRoots, e), e);
  }

  /** A piece of edge `e`, from `a` to `b`, holding `share` of it; its id
   * is `id`, or minted. */
  from(e: number, a: number, b: number, share = 1, id = NaN): void {
    this.copyOf(e, share);
    this.push(a, b, id, at64(this.m.store.edgeRoots, e), -1);
  }

  /** A new edge from `a` to `b` with the columns of edge `e`, a
   * distributed one the sum over the edges it covers (`parts`, see
   * `EdgeCells.over`; none: no share of any). Its lineage is `e`'s, or its
   * own; its id is `id`, or minted. */
  cover(e: number, a: number, b: number, parts: readonly number[], lineage: 'lineage' | 'own' = 'lineage', id = NaN): void {
    this.over(e, parts);
    this.push(a, b, id, lineage === 'own' ? NaN : at64(this.m.store.edgeRoots, e), -1);
  }

  /** Row `k`'s ends, as point rows of the answer. */
  endA(k: number): number {
    return this.list[2 * k];
  }

  endB(k: number): number {
    return this.list[2 * k + 1];
  }

  /** The edge of `m` row `k` was made from; -1 for an edge kept as it
   * was, which is that edge and says nothing new. */
  madeFrom(k: number): number {
    return this.kept[k] >= 0 ? -1 : this.src[k];
  }

  private push(a: number, b: number, id: number, root: number, kept: number): void {
    this.list.push(a, b);
    this.ids.push(id);
    this.roots.push(root);
    this.kept.push(kept);
  }

  /** The rows as parts: the edge list, every edge column of `m`, the ids
   * (the new ones minted now, in row order), the roots and the kernel's
   * names. */
  done(): Pick<Parts, 'edgeList' | 'edgeAttrs' | 'edgeIds' | 'edgeRoots' | 'edgeKeys'> {
    const ids = withMinted(this.ids);
    const roots = new Float64Array(ids.length);
    for (let k = 0; k < roots.length; k++) roots[k] = Number.isNaN(this.roots[k]) ? ids[k] : this.roots[k];
    const keys = this.m.store.edgeKeys;
    return {
      edgeList: Column.of(Uint32Array.from(this.list)),
      edgeAttrs: this.columns(),
      edgeIds: Column.of(ids),
      edgeRoots: Column.of(roots),
      edgeKeys: keys === null ? null : (kinds.string.from(this.kept.map((e) => (e < 0 ? '' : keys.get(e)))) as ArrayColumn<string>),
    };
  }
}

// ---- column values -------------------------------------------------------------------

/**
 * A value a column holds, one per row: a number, a boolean, a string, a
 * list of `k` numbers (a vector), a row — a point or edge value or view,
 * kept as a reference to that row — or a placement. `null` is no row, or
 * no placement. A column holds ONE kind, taken from the first value it is
 * given; a value of another kind is refused by name.
 */
export type CellValue = number | boolean | string | readonly number[] | PointEnd | EdgeEnd | Placement | null;

/** @internal A column's own stored value, handed from one state of a
 * geometry to the next by a recipe (a split child's parent value): taken
 * as it is, never read as a new value. */
export class Stored {
  constructor(readonly value: unknown) {}
}

/** @internal The kind a value is of: a kind, `null` for the value null (a
 * reference or a placement column takes it), or undefined for a value no
 * column holds. */
export function kindOfValue(v: unknown): AnyKind | null | undefined {
  if (typeof v === 'number') return kinds.number;
  if (typeof v === 'boolean') return kinds.boolean;
  if (typeof v === 'string') return kinds.string;
  if (v === null) return null;
  if (typeof v !== 'object') return undefined;
  if (Array.isArray(v) || (ArrayBuffer.isView(v) && !(v instanceof DataView))) {
    const list = v as ArrayLike<unknown>;
    if (list.length === 0) return undefined;
    for (let k = 0; k < list.length; k++) if (typeof list[k] !== 'number') return undefined;
    return kinds.vector(list.length);
  }
  if (isPointValue(v) || isEdgeValue(v)) return kinds.reference;
  const view = viewKind(v);
  if (view === 'vertex' || view === 'edge') return kinds.reference;
  if (isPlacement(v)) return kinds.placement;
  return undefined;
}

/** Nothing lands: a value that is not finite, or a vector with such a
 * number, leaves the row as it was. */
const SKIP: unique symbol = Symbol('skip');

/** The stored form of `v`, a value of `kind` (checked): a reference is its
 * row's id, a vector a copy; or SKIP for data that cannot land. */
function storedCell(kind: AnyKind, v: unknown): unknown {
  if (v instanceof Stored) return v.value;
  switch (kind.name) {
    case 'number': return Number.isFinite(v as number) ? v : SKIP;
    case 'vector': {
      const list = v as ArrayLike<number>;
      for (let k = 0; k < list.length; k++) if (!Number.isFinite(list[k])) return SKIP;
      return Array.from(list);
    }
    case 'reference': return v === null ? null : (v as { id: number }).id;
    default: return v;
  }
}

/** @internal A value a column holds, as its kind and the stored value —
 * or refused by name. What a record of values (a fill, a part's columns)
 * turns into a column through. */
export function cellOf(v: unknown, who: string, name: string): { kind: AnyKind; value: unknown } {
  const kind = kindOfValue(v);
  if (kind === undefined || kind === null) throw notACell(who, name, v);
  const value = storedCell(kind, v);
  if (value === SKIP) throw new Error(`${who}: the value of '${name}' is not finite`);
  return { kind, value };
}

/** A value the geometry refuses: not one of the kinds a column holds.
 * `row` names the row a function of it may answer one for, where the
 * write takes a function. */
function notACell(who: string, name: string, v: unknown, row?: string): Error {
  return new Error(`${who}: the value of '${name}' is a number, a boolean, a string, a list of numbers, a row or a placement${row === undefined ? '' : ` — or a function of the ${row} that answers one`} — got ${describe(v)}`);
}

/** A value of one kind into a column of another, refused by name. */
function wrongKind(who: string, name: string, held: AnyKind, got: AnyKind): Error {
  return new Error(`${who}: the column '${name}' holds ${kindWords(held)} a row, and this value is ${kindWords(got)} — a column keeps one kind; write another column to hold another`);
}

/** @internal The kind a value of `name` must be, or refused: a value of
 * `got` kind into a column that holds `held` (undefined: a new column). A
 * `z` holds numbers, as the position does. */
function checkKind(who: string, name: string, held: AnyKind | undefined, got: AnyKind, isPosition: boolean): AnyKind {
  if (isPosition && got !== kinds.number) throw new Error(`${who}: '${name}' is a position, a number — got ${kindWords(got)}`);
  if (held !== undefined && held !== got) throw wrongKind(who, name, held, got);
  return got;
}

/** A column's kind as a write finds it: undefined for a new column that
 * has no kind yet, and `open` while a new column's kind is a guess that a
 * later value may still change (a new column written by a function starts
 * as numbers). */
interface CellKind {
  kind: AnyKind | undefined;
  open: boolean;
}

/**
 * The ladder every write lands a value by — a new row's, a column write's,
 * a face column's — as what the column stores, or SKIP when nothing
 * lands: `undefined` (the row keeps what it had), a value that is not
 * finite, `null` on a column that holds neither rows nor placements. The
 * first value that lands names a new column's kind; a value of another
 * kind than the column's is refused by name, and so is a value no column
 * holds. `position`: the column is a place (`z`), numbers only. A number
 * on a numeric column is each caller's fast path, before the ladder.
 */
function landCell(col: CellKind, v: unknown, who: string, name: string, position: boolean): unknown {
  if (v instanceof Stored) return v.value;
  if (v === undefined) return SKIP;
  const got = kindOfValue(v);
  if (got === undefined) throw notACell(who, name, v);
  if (got === null) {
    // No row, or no placement: a column that holds either takes it; a new
    // column that has no kind yet is a column of rows; a column whose kind
    // is still a guess stays one.
    if (col.open) return SKIP;
    col.kind ??= kinds.reference;
    return col.kind.name === 'reference' || col.kind.name === 'placement' ? null : SKIP;
  }
  const stored = storedCell(got, v);
  if (col.open) {
    // A value that does not land leaves a guess a guess.
    if (stored === SKIP) return SKIP;
    col.kind = got;
    col.open = false;
  }
  col.kind = checkKind(who, name, col.kind, got, position);
  return stored;
}

// ---- values you hold ----------------------------------------------------------------

/** The brand of a point or edge value (views.ts): on the prototype, so a
 * spread copy is a plain record, as a spread view is. */
const POINT_PROTO: object = valueProto('point');
const EDGE_PROTO: object = valueProto('edge');

/** Is `v` a point value that `point(…)` made? */
const isPointValue = (v: unknown): v is PointValue => valueKind(v) === 'point';
/** Is `v` an edge value that `edge(…)` made? */
const isEdgeValue = (v: unknown): v is EdgeValue => valueKind(v) === 'edge';

/** The stored value of a column that is not numbers, at a row made `t` of
 * the way from row `i` to row `j`: a vector blended when it interpolates,
 * any other kind — or a vector that does not — the nearer row's (the
 * first on a tie). The rule `PointRows` builds by. */
function typedBetween(col: Exclude<AnyColumn, Column>, i: number, j: number, t: number, interpolate: boolean): unknown {
  if (!col.kind.interpolates || !interpolate) return valueAt(col, t <= 0.5 ? i : j);
  const va = valueAt(col, i) as number[];
  const vb = valueAt(col, j) as number[];
  return va.map((x, k) => x + (vb[k] - x) * t);
}

/** The stored value of an edge column that is not numbers, at a row
 * holding `share` of edge `e`: a distributed vector's share, any other
 * value the edge's. The rule `EdgeCells` builds by. */
function typedShare(col: Exclude<AnyColumn, Column>, e: number, share: number, distribute: boolean): unknown {
  const v = valueAt(col, e);
  return distribute && col.kind.name === 'vector' ? (v as number[]).map((x) => x * share) : v;
}

/** Every column of a point made between point rows `a` and `b` of `m`, `t`
 * of the way along, by the rule `PointRows` builds by, as a record a write
 * lands: a number as it is, any other kind its stored value. */
function cellsBetween(m: Material, a: number, b: number, t: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const cols = m.store.attrs;
  for (const name in cols) {
    const col = cols[name];
    const nearest = m.transfers[name] === 'nearest';
    if (col instanceof Column) {
      const va = at64(col, a);
      const vb = at64(col, b);
      out[name] = nearest ? (t <= 0.5 ? va : vb) : va + (vb - va) * t;
    } else {
      out[name] = new Stored(typedBetween(col, a, b, t, !nearest));
    }
  }
  return out;
}

/** Every column of an edge that holds `share` of edge row `e` of `m` — a
 * split's child, a piece of a replaced edge, the edge itself at 1 — by
 * the rule `EdgeCells` builds by, as a record a write lands. */
function edgeCells(m: Material, e: number, share = 1): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const cols = m.store.edgeAttrs;
  for (const name in cols) {
    const col = cols[name];
    const distribute = m.edgeTransfers[name] === 'distribute';
    if (col instanceof Column) {
      const v = at64(col, e);
      out[name] = distribute ? v * share : v;
    } else {
      out[name] = new Stored(typedShare(col, e, share, distribute));
    }
  }
  return out;
}

/** A value's columns: a point value's or a view's own enumerable values,
 * less the names the value owns. */
function columnsOf(v: object, own: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(v)) if (!own.includes(name)) out[name] = (v as Record<string, unknown>)[name];
  return out;
}

/** A new row's columns as a record, checked: no name the row owns, and
 * each value one a column holds (see `CellValue`). */
function checkColumns(cols: unknown, kind: 'point' | 'edge', who: string): Record<string, CellValue> {
  if (cols === undefined) return {};
  if (typeof cols !== 'object' || cols === null || Array.isArray(cols)) throw new Error(`${who}: the columns of a new ${kind} are a record, { name: value } — got ${describe(cols)}`);
  for (const name in cols) {
    checkNewColumnName(kind, name, who);
    const v = (cols as Record<string, unknown>)[name];
    if (v !== undefined && kindOfValue(v) === undefined) throw notACell(who, name, v);
  }
  return cols as Record<string, CellValue>;
}

/**
 * A point you hold: a position with its columns, named from the moment it
 * is made. Add it to a geometry, and it names the row it became in that
 * state and in every later one — `g.points.add(q).edges.add([q, p])`.
 * `xy` is `[x, y]`, `{ x, y }` or a view, of which it takes only the place;
 * `cols` are the new row's columns, and a geometry that declares a column
 * needs it here.
 */
export function point(xy: XY | readonly [number, number, number], cols?: Record<string, CellValue>): PointValue {
  const who = 'point';
  if (!isPosition(xy) && !isPointValue(xy) && viewKind(xy) !== 'vertex') throw new Error(`${who}: expected a position [x, y] or { x, y } — got ${describe(xy)}`);
  const own = checkColumns(cols, 'point', who);
  const p = Object.create(POINT_PROTO) as Record<string, unknown>;
  p.x = vx(xy);
  p.y = vy(xy);
  // A place with a third number is a place in 3D: its `z` is a column.
  const z = zOf(xy);
  if (z !== undefined) p.z = z;
  for (const name in own) p[name] = own[name];
  Object.defineProperty(p, 'id', { value: mintIds(1)[0], enumerable: false });
  return Object.freeze(p) as PointValue;
}

/**
 * An edge you hold: two points — point values or views — with its
 * columns, named from the moment it is made. Add it with `g.edges.add(e)`,
 * and it names the row it became in every later state: `split(e)`,
 * `edges.remove(e)`, the `where` of `edges.set`.
 */
export function edge(a: PointEnd, b: PointEnd, cols?: Record<string, CellValue>): EdgeValue {
  const who = 'edge';
  for (const end of [a, b]) {
    if (!isPointValue(end) && viewKind(end) !== 'vertex') throw notAPoint(who, end);
  }
  const own = checkColumns(cols, 'edge', who);
  const e = Object.create(EDGE_PROTO) as Record<string, unknown>;
  Object.defineProperty(e, 'a', { value: a, enumerable: false });
  Object.defineProperty(e, 'b', { value: b, enumerable: false });
  for (const name in own) e[name] = own[name];
  Object.defineProperty(e, 'id', { value: mintIds(1)[0], enumerable: false });
  return Object.freeze(e) as EdgeValue;
}

// ---- reading references ------------------------------------------------------------

const isPosition = (v: unknown): v is XY => {
  if (Array.isArray(v)) return (v.length === 2 || (v.length === 3 && typeof v[2] === 'number')) && typeof v[0] === 'number' && typeof v[1] === 'number';
  if (typeof v !== 'object' || v === null || viewKind(v) !== undefined || isPointValue(v)) return false;
  const o = v as { x?: unknown; y?: unknown };
  return typeof o.x === 'number' && typeof o.y === 'number';
};

/** The third number of a place — `[x, y, z]` or `{ x, y, z }` — or
 * undefined for a place in the plane. */
function zOf(v: unknown): number | undefined {
  if (Array.isArray(v)) return v.length > 2 && typeof v[2] === 'number' ? v[2] : undefined;
  const z = (v as { z?: unknown }).z;
  return typeof z === 'number' ? z : undefined;
}

/** The row a point reference names in `m` — a point value, or a vertex
 * view of this state or of another — or -1 when it names nothing here. */
export function pointRow(m: Material, end: unknown, who: string): number {
  return rowOf(pointDomain(m), end, who);
}

/** The row an edge reference names in `m`, or -1 when it is gone. */
export function edgeRow(m: Material, e: unknown, who: string): number {
  return rowOf(edgeDomain(m), e, who);
}

// ---- the three writes on points -----------------------------------------------------

/** Columns a new row gives, checked: a name the row owns refused, and
 * every declared column named. */
function checkNewRowColumns(given: Readonly<Record<string, unknown>>, declared: readonly string[], kind: 'point' | 'edge', who: string): void {
  if (typeof given !== 'object' || given === null || Array.isArray(given)) throw new Error(`${who}: the columns of a new ${kind} are a record, { name: value } — got ${describe(given)}`);
  for (const name in given) checkNewColumnName(kind, name, who);
  for (const name of declared) {
    if (!(name in given)) throw new Error(`${who}: must give '${name}' for a new ${kind} — every declared column is a choice`);
  }
}

/**
 * The new rows' columns, read against the columns the geometry holds,
 * row by row: each value's kind checked (a value of another kind is
 * refused by name), the kind of each column a row names for the first
 * time taken from its first value, and each value turned into what the
 * column stores — or SKIP where it cannot land (then the whole row is
 * skipped). A number stays as it is, so a numeric column appends the very
 * values it was given.
 */
class RowCells {
  private readonly cols = new Map<string, CellKind>();

  constructor(held: Readonly<Record<string, AnyColumn>>, private readonly who: string, private readonly positions: readonly string[] = []) {
    for (const name in held) this.cols.set(name, { kind: kindOf(held[name]), open: false });
  }

  read(c: Readonly<Record<string, unknown>>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const name in c) {
      const v = c[name];
      let col = this.cols.get(name);
      if (col === undefined) this.cols.set(name, (col = { kind: undefined, open: false }));
      // A number stays as it is, so a numeric column appends the very
      // values it was given; `landsRecord` skips one that is not finite.
      if (typeof v === 'number' && (col.kind === undefined || col.kind === kinds.number)) {
        col.kind = kinds.number;
        out[name] = v;
      } else {
        out[name] = landCell(col, v, this.who, name, this.positions.includes(name));
      }
    }
    return out;
  }

  /** The kind of a column the rows name: the one it holds, or its first
   * value's. */
  kindOf(name: string): AnyKind {
    return this.cols.get(name)?.kind ?? kinds.number;
  }

  /** What a row that gives no value for a column appends there: the
   * kind's default, 0 for numbers. */
  fallback(name: string): unknown {
    return this.kindOf(name).default;
  }
}

/** Can every value of a row land (see `RowCells`)? */
const landsRecord = (r: Readonly<Record<string, unknown>>): boolean => {
  for (const k in r) {
    const v = r[k];
    if (v === SKIP || (typeof v === 'number' && !Number.isFinite(v))) return false;
  }
  return true;
};

/** @internal Add point rows, one column record per row and one id (NaN:
 * mint one) per row. A column value is any value a column holds (see
 * `CellValue`), or a `Stored` value a recipe hands on. A row at a
 * position or with a value that is not finite is skipped, and so is a row
 * whose id the geometry holds already (`already`), or that comes twice in
 * one write. */
export function addPointRows(m: Material, xs: readonly number[], ys: readonly number[], cols: readonly Readonly<Record<string, unknown>>[], ids: readonly number[] | null, who: string): Material {
  if (xs.length === 0) return m;
  const declared = m.store.attrNames;
  const extra = new Set<string>();
  for (const c of cols) {
    checkNewRowColumns(c, declared, 'point', who);
    for (const name in c) if (!declared.includes(name)) extra.add(name);
  }
  const reader = new RowCells(m.store.attrs, who, ['z']);
  const cells = cols.map((c) => reader.read(c));
  const keep: number[] = [];
  const held = new Set<number>();
  for (let k = 0; k < xs.length; k++) {
    const id = ids === null ? NaN : ids[k];
    if (!Number.isNaN(id)) {
      if (held.has(id) || m.rowOfPoint(id as PointId) >= 0) continue;
      held.add(id);
    }
    if (Number.isFinite(xs[k]) && Number.isFinite(ys[k]) && landsRecord(cells[k])) keep.push(k);
  }
  if (keep.length === 0) return m;
  const p = partsOf(m);
  p.x = p.x.append(keep.map((k) => xs[k]));
  p.y = p.y.append(keep.map((k) => ys[k]));
  // A column a new row declares is its kind's default — 0 for numbers — on
  // every row that was already there.
  for (const name of extra) p.attrs[name] = newColumn(reader.kindOf(name), m.n);
  for (const name in p.attrs) p.attrs[name] = appendValues(p.attrs[name], keep.map((k) => cells[k][name]));
  const given = keep.map((k) => (ids === null ? NaN : ids[k]));
  const minted = mintIds(given.filter((id) => Number.isNaN(id)).length);
  let next = 0;
  p.pointIds = p.pointIds.append(given.map((id) => (Number.isNaN(id) ? minted[next++] : id)));
  // A row a write makes has no kernel name: the 3D layer names it.
  if (p.pointKeys !== null) p.pointKeys = p.pointKeys.append(keep.map(() => ''));
  return make(m, p);
}

/** A new column of `kind`, `length` rows of its default. */
function newColumn(kind: AnyKind, length: number): AnyColumn {
  return kind === kinds.number ? Column.zeros(Float64Array, length) : (kind.filled(length) as AnyColumn);
}

/** @internal Remove point rows and every edge row that names one of them. */
export function removePointRows(m: Material, rows: readonly number[]): Material {
  if (rows.length === 0) return m;
  const gone = new Uint8Array(m.n);
  for (const r of rows) gone[r] = 1;
  const rowMap = new Int32Array(m.n).fill(-1);
  const survivors: number[] = [];
  for (let i = 0; i < m.n; i++) if (!gone[i]) { rowMap[i] = survivors.length; survivors.push(i); }
  const list = m.store.edgeList;
  const edges: number[] = [];
  for (let e = 0; e < m.edgeCount; e++) if (!gone[atU32(list, 2 * e)] && !gone[atU32(list, 2 * e + 1)]) edges.push(e);
  return make(m, keepRows(m, survivors, edges, rowMap));
}

/** The parts of `m` holding only these point rows (null: every one) and
 * these edge rows, the point rows renumbered by `rowMap` (null: as they
 * are). Every leaf in front of the first row that moves is shared. */
function keepRows(m: Material, points: readonly number[] | null, edges: readonly number[], rowMap: Int32Array | null): Parts {
  const p = partsOf(m);
  if (points !== null) {
    p.x = p.x.keep(points);
    p.y = p.y.keep(points);
    for (const name in p.attrs) p.attrs[name] = keepColumn(p.attrs[name], points);
    p.pointIds = p.pointIds.keep(points);
    if (p.pointKeys !== null) p.pointKeys = p.pointKeys.keep(points);
  }
  if (p.edgeKeys !== null) p.edgeKeys = p.edgeKeys.keep(edges);
  for (const name in p.edgeAttrs) p.edgeAttrs[name] = keepColumn(p.edgeAttrs[name], edges);
  p.edgeIds = p.edgeIds.keep(edges);
  p.edgeRoots = p.edgeRoots.keep(edges);
  if (rowMap === null) {
    p.edgeList = p.edgeList.keep(edges, 2);
  } else {
    // Renumbered ends are new values: the list is written out.
    const from = m.store.edgeList;
    const list = new Uint32Array(edges.length * 2);
    for (let k = 0; k < edges.length; k++) {
      const e = edges[k];
      list[2 * k] = rowMap[from.get(2 * e)];
      list[2 * k + 1] = rowMap[from.get(2 * e + 1)];
    }
    p.edgeList = Column.of(list);
  }
  return p;
}

// ---- one write, over any table ----------------------------------------------------

/**
 * What a write needs to know of the table it lands on, beyond its rows:
 * the kind of row (the names it owns, how a refusal names it), the
 * policies a column may declare — the default first; none: the table takes
 * no options, and `why` says why — whether a face column's `fallback` is
 * an option, the columns that are places (`x`, `y` and `z` hold numbers,
 * and `x`, `y` live beside the columns and have no policy), and whether
 * the table holds numbers only (a lattice's rasters).
 */
interface WriteTable {
  readonly kind: RowKind;
  readonly transfers?: readonly string[];
  readonly why?: string;
  readonly fallback?: boolean;
  readonly places?: readonly string[];
  readonly numbers?: boolean;
}

const POINT_TABLE: WriteTable = { kind: 'point', transfers: ['interpolate', 'nearest'], places: ['x', 'y', 'z'] };
const EDGE_TABLE: WriteTable = { kind: 'edge', transfers: ['copy', 'distribute'] };
const FACE_TABLE: WriteTable = { kind: 'face', transfers: ['nearest', 'drop'], fallback: true };
const CORNER_TABLE: WriteTable = { kind: 'corner', why: 'a corner has no transfer; it lives and dies with its face' };
/** @internal A lattice's faces: numbers only, fixed rows, no policy. */
export const LATTICE_TABLE: WriteTable = { kind: 'lattice face', numbers: true, why: "a lattice's faces never change, so a column has no transfer" };

/** How a refusal names a row of a table. */
const rowWord = (table: WriteTable): string => (table.kind === 'lattice face' ? 'face' : table.kind);

/** A write's options, read: the policy each written column is declared
 * with (undefined: none declared), and a face column's fallback. */
interface WriteOptions {
  readonly transfer?: Readonly<Record<string, string>>;
  readonly fallback?: unknown;
  /** `{ fallback: undefined }`: the column's fallback is dropped. */
  readonly clearsFallback: boolean;
}

/**
 * The options record of a write, checked against its table: `transfer` —
 * one policy for every column the write names, or after the record form a
 * record by column (`transferRecord`) — and a face column's `fallback`. A
 * place has no policy; a table with no policies takes no options, and
 * says why.
 */
export function writeOptions(opts: Readonly<Record<string, unknown>> | undefined, table: WriteTable, names: readonly string[], single: boolean, who: string): WriteOptions {
  if (opts === undefined) return { clearsFallback: false };
  const row = rowWord(table);
  const a = row === 'edge' ? 'an' : 'a';
  if (table.transfers === undefined) throw new Error(`${who}: ${a} ${row} write takes no options — ${table.why}`);
  for (const key of Object.keys(opts)) {
    if (key === 'transfer' || (key === 'fallback' && table.fallback)) continue;
    if (key === 'fallback') throw new Error(`${who}: 'fallback' is an option of a face column — ${a} ${row} row always has a value`);
    throw new Error(`${who}: unknown option '${key}' — the options record of ${table.fallback ? 'a face write is { transfer, fallback }' : 'a write is { transfer }'}`);
  }
  const transfer = transferRecord(opts.transfer, names, table.transfers, single, who);
  if (transfer !== undefined) for (const name of Object.keys(transfer)) if (name === 'x' || name === 'y') throw new Error(`${who}: '${name}' is a position, and a position has no transfer policy`);
  const f = opts.fallback;
  if (f !== undefined) {
    const kind = kindOfValue(f);
    if (kind === undefined || kind === null || kind.name === 'reference' || (typeof f === 'number' && !Number.isFinite(f))) {
      throw new Error(`${who}: fallback is a value of the column's kind — a finite number, a boolean, a string, a list of numbers or a placement — got ${describe(f)}`);
    }
  }
  return { ...(transfer !== undefined ? { transfer } : {}), fallback: f, clearsFallback: 'fallback' in opts && f === undefined };
}

/**
 * `transfer` as a policy by column name: one word for every column the
 * write names, or — only after the record form, which names several — a
 * record `{ column: word }` naming some of them. A record in the
 * one-column form is a second spelling of the word, and refused; a record
 * naming a column the write does not write is refused by name.
 */
function transferRecord(t: unknown, names: readonly string[], allowed: readonly string[], single: boolean, who: string): Record<string, string> | undefined {
  if (t === undefined) return undefined;
  const words = allowed.map((a) => `'${a}'`).join(' or ');
  if (typeof t === 'string') {
    if (!allowed.includes(t)) throw new Error(`${who}: transfer is ${words} — got ${describe(t)}`);
    const out: Record<string, string> = {};
    for (const name of names) out[name] = t;
    return out;
  }
  if (!isOptionsRecord(t)) throw new Error(`${who}: transfer is ${words}${single ? '' : ', or a record of them by column'} — got ${describe(t)}`);
  if (single) throw new Error(`${who}: one column's transfer is a word — { transfer: ${allowed.map((a) => `'${a}'`).join(' | ')} }; a record of transfers by column goes with the record form, set({ a, b }, { transfer: { b: … } })`);
  const out: Record<string, string> = {};
  for (const [name, v] of Object.entries(t)) {
    if (!names.includes(name)) throw new Error(`${who}: transfer names '${name}', and this write does not write it — a column's transfer is declared by the write that names it`);
    if (v === undefined) continue;
    if (typeof v !== 'string' || !allowed.includes(v)) throw new Error(`${who}: the transfer of '${name}' is ${words} — got ${describe(v)}`);
    out[name] = v;
  }
  return out;
}

/** A declared policy the column's kind cannot follow, refused by name: a
 * kind that never interpolates (a boolean, a string, a reference, a
 * placement) takes the parent's value whatever is declared, so declaring
 * `'interpolate'` — or sharing it out, `'distribute'` — on one says
 * something that cannot happen. */
function checkPolicy(who: string, name: string, kind: AnyKind, transfer: string): void {
  if (kind.interpolates) return;
  if (transfer === 'interpolate' || transfer === 'distribute') {
    throw new Error(`${who}: the column '${name}' holds ${kindWords(kind)} a row, which never ${transfer === 'interpolate' ? 'interpolates' : 'shares out'} — a row made between rows takes its parent's value; declare '${transfer === 'interpolate' ? 'nearest' : 'copy'}' or nothing`);
  }
}

/**
 * One column of a write: where its values land, and what kind they are.
 * A numeric column keeps the fast path — a dense write fills the new
 * array directly (`out`), a sparse one goes through the writer (`num`) —
 * and a column of another kind goes through `slow`, as does the first
 * value of a new column that is not a number: a new column written by a
 * function starts as numbers, the kind of every column a sketch has
 * written so far, and becomes the kind of its first value that is not.
 */
class ColumnSink {
  kind: AnyKind;
  /** True while a new column's kind is still a guess: nothing but values
   * that do not land has been read. */
  open: boolean;
  out: Float64Array | null = null;
  num: ColumnWriter<Float64Array> | null = null;
  any: AnyWriter | null = null;

  constructor(
    readonly name: string,
    base: AnyColumn | undefined,
    first: unknown,
    private readonly count: number,
    private readonly reach: 'all' | readonly number[],
    private readonly who: string,
    private readonly position: boolean,
  ) {
    // A constant names its kind now; a function names it with its first
    // value; a column the geometry holds has its kind already.
    const constant = typeof first === 'function' ? undefined : kindOfValue(first);
    if (base !== undefined) {
      this.kind = kindOf(base);
      this.open = false;
      if (constant) checkKind(who, name, this.kind, constant, position);
    } else if (constant) {
      this.kind = checkKind(who, name, undefined, constant, position);
      this.open = false;
    } else {
      this.kind = kinds.number;
      this.open = !position;
    }
    this.start(base ?? newColumn(this.kind, count));
  }

  private start(col: AnyColumn): void {
    this.out = null;
    this.num = null;
    this.any = null;
    if (col instanceof Column) {
      const w = col.writer(this.reach);
      if (this.reach === 'all') this.out = w.array()!;
      else this.num = w;
      this.anyDone = () => w.done();
    } else {
      const w = writerOf(col, this.reach);
      this.any = w;
      this.anyDone = () => w.done();
    }
  }

  private anyDone: () => AnyColumn = () => { throw new Error('unreachable'); };

  /** Row `i` takes `value`, which is not a number landing on a numeric
   * column (that is the caller's fast path), by the ladder every write
   * lands by. A guess that becomes another kind starts the column again. */
  slow(i: number, value: unknown): void {
    const was = this.kind;
    const cell = landCell(this, value, this.who, this.name, this.position);
    if (this.kind !== was) this.start(newColumn(this.kind, this.count));
    if (cell === SKIP) return;
    if (this.out !== null) this.out[i] = cell as number;
    else if (this.num !== null) this.num.set(i, cell as number);
    else this.any!.set(i, cell);
  }

  /** A number landed: the column's kind is numbers from now on. */
  settle(): void {
    this.open = false;
  }

  done(): AnyColumn {
    return this.anyDone();
  }
}

/**
 * The columns a write lands on `held` (by name; a new one is declared),
 * over `rows` (null: every one of `count`), ONE instant: every function
 * reads the rows as they were, row by row, each row's columns in the
 * record's order — the order every write reads a record in, so draws
 * happen in the same order anywhere. `places` hold numbers; `read` is the
 * view a function of the row is handed. Each column is written through a
 * writer that copies only the leaves the rows fall in.
 */
function landColumns<V>(
  held: Readonly<Record<string, AnyColumn>>,
  count: number,
  places: readonly string[],
  values: Readonly<Record<string, ColumnValue<V>>>,
  names: readonly string[],
  rows: readonly number[] | null,
  read: (count: number) => (i: number) => V,
  who: string,
): ColumnSink[] {
  const reach = rows === null ? 'all' : rows;
  const sinks = names.map((name) => new ColumnSink(name, held[name], values[name], count, reach, who, places.includes(name)));
  const fns = names.map((name) => values[name]);
  const view = fns.some((f) => typeof f === 'function') ? read(rows === null ? count : rows.length) : null;
  writeRows(rows, count, fns, view, sinks);
  return sinks;
}

/**
 * @internal `points.set` or `edges.set` on the rows `sel` holds, or on
 * those `where` names among them: the columns landed (`landColumns`), and
 * the policy each named column is declared with, when the write declares
 * one — the default is stored as none.
 */
function setMaterial<V>(sel: Selection<V>, table: WriteTable, args: readonly unknown[]): Material {
  const who = `${sel.domain.kind.plural}.set`;
  const m = sel.owner as Material;
  const points = table === POINT_TABLE;
  const { values, names, single, given, where, opts } = readSet<V>(args, table, who);
  const { transfer } = writeOptions(opts, table, names, single, who);
  const rows = given ? whereRows(sel, where, who) : sel.members;
  // A write that reaches no row still declares its policy: the declaration
  // is about the column, not about the rows it writes.
  if (rows !== null && rows.length === 0 && transfer === undefined) return m;
  const p = partsOf(m);
  const cols = points ? p.attrs : p.edgeAttrs;
  const d = sel.domain;
  const sinks = landColumns(points ? { ...cols, x: p.x, y: p.y } : cols, d.size, table.places ?? [], values, names, rows, (n) => d.reader?.(n) ?? ((i) => d.row(i)), who);
  for (const sink of sinks) {
    const col = sink.done();
    if (points && sink.name === 'x') p.x = col as Column;
    else if (points && sink.name === 'y') p.y = col as Column;
    else cols[sink.name] = col;
  }
  // A write of columns keeps the rows where they are, and so a level set's
  // area; a write of a place moves them.
  const area = names.some((name) => table.places?.includes(name)) ? undefined : keptArea(m);
  if (transfer === undefined) return make(m, p, { area });
  for (const sink of sinks) {
    const t = transfer[sink.name];
    if (t !== undefined) checkPolicy(who, sink.name, sink.kind, t);
  }
  // Setting a value keeps a column's declared policy; declaring the default
  // restores it, which is stored as no entry at all.
  const policies: Record<string, string> = { ...(points ? m.transfers : m.edgeTransfers) };
  for (const [name, t] of Object.entries(transfer)) {
    if (t === table.transfers![0]) delete policies[name];
    else policies[name] = t;
  }
  return make(m, p, points ? { transfers: policies as Record<string, TransferPolicy>, area } : { edgeTransfers: policies as Record<string, EdgeTransfer>, area });
}

/** A write over `rows` (null: every row): each column's value worked out
 * from the row as it was, and landed. A finite number on a numeric column
 * lands directly — the dense new array, or the writer, which copies only
 * the leaves the rows fall in; anything else goes through the sink. */
function writeRows<V>(rows: readonly number[] | null, count: number, fns: readonly unknown[], view: ((i: number) => V) | null, sinks: readonly ColumnSink[]): void {
  const n = rows === null ? count : rows.length;
  const width = fns.length;
  // Where a finite number lands, per column, read off the sink once and
  // again only when a slow value changed it: the dense array, or the writer.
  const outs: (Float64Array | null)[] = [];
  const nums: (ColumnWriter<Float64Array> | null)[] = [];
  // A new column's kind is a guess until a value lands: the first number
  // that lands settles it as numbers, so a later value of another kind is
  // refused by name whichever comes first.
  const open: boolean[] = [];
  const refresh = (k: number): void => {
    const sink = sinks[k];
    const numeric = sink.kind === kinds.number;
    outs[k] = numeric ? sink.out : null;
    nums[k] = numeric ? sink.num : null;
    open[k] = sink.open;
  };
  for (let k = 0; k < width; k++) refresh(k);
  for (let r = 0; r < n; r++) {
    const i = rows === null ? r : rows[r];
    const v = view === null ? (undefined as V) : view(i);
    for (let k = 0; k < width; k++) {
      const f = fns[k];
      const value = typeof f === 'function' ? (f as (row: V) => unknown)(v) : f;
      if (typeof value === 'number' && Number.isFinite(value)) {
        if (open[k]) {
          sinks[k].settle();
          open[k] = false;
        }
        const out = outs[k];
        if (out !== null) {
          out[i] = value;
          continue;
        }
        const num = nums[k];
        if (num !== null) {
          num.set(i, value);
          continue;
        }
      }
      sinks[k].slow(i, value);
      refresh(k);
    }
  }
  for (const sink of sinks) if (sink.open && sink.kind === kinds.number) sink.settle();
}

/** A plain record — never a `where`: a `where` is a selection, a value, a
 * view, a function, or — for a lattice — a place, and none of those is a
 * plain object other than a place `{ x, y }`. */
const isOptionsRecord = (v: unknown): v is Readonly<Record<string, unknown>> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype &&
  !(typeof (v as { x?: unknown }).x === 'number' && typeof (v as { y?: unknown }).y === 'number');

/**
 * @internal `set` arguments, read against the table: the values, checked —
 * a record, no name the row owns, each value one the table holds or a
 * function of the row — whether a `where` was given at all (an `undefined`
 * one is nothing), and the options record. A plain record in the `where`
 * place is the options, so `set(col, v, opts)` needs no `undefined`
 * between them. The one parser every write reads its arguments with.
 */
export function readSet<V>(args: readonly unknown[], table: WriteTable, who: string): { values: Record<string, ColumnValue<V>>; names: string[]; single: boolean; given: boolean; where: unknown; opts: Readonly<Record<string, unknown>> | undefined } {
  const row = rowWord(table);
  let values: Record<string, ColumnValue<V>>;
  let rest: readonly unknown[];
  const single = typeof args[0] === 'string';
  if (single) {
    if (args.length < 2) throw new Error(`${who}: '${args[0]}' needs a value — a number, or a function of the ${row}`);
    values = { [args[0] as string]: args[1] as ColumnValue<V> };
    rest = args.slice(2);
  } else {
    if (typeof args[0] !== 'object' || args[0] === null || Array.isArray(args[0])) throw new Error(`${who}: give a column and a value, or a record { column: value } — got ${describe(args[0])}`);
    values = args[0] as Record<string, ColumnValue<V>>;
    rest = args.slice(1);
  }
  const names = Object.keys(values);
  for (const name of names) {
    checkColumnName(table.kind, name, who);
    const v = values[name];
    if (typeof v === 'function') continue;
    if (table.numbers ? typeof v !== 'number' : kindOfValue(v) === undefined) {
      throw table.numbers ? new Error(`${who}: the value of '${name}' is a number or a function of the ${row} — a lattice holds numbers — got ${describe(v)}`) : notACell(who, name, v, row);
    }
  }
  if (rest.length > 0 && isOptionsRecord(rest[0])) {
    if (rest.length > 1) throw new Error(`${who}: the options record comes last, after the where`);
    return { values, names, single, given: false, where: undefined, opts: rest[0] };
  }
  if (rest.length > 1 && rest[1] !== undefined && !isOptionsRecord(rest[1])) throw new Error(`${who}: the last argument is the options record — got ${describe(rest[1])}`);
  if (rest.length > 2) throw new Error(`${who}: a write takes a value, a where and an options record — got ${rest.length + 1} arguments after the column`);
  return { values, names, single, given: rest.length > 0, where: rest[0], opts: rest[1] as Readonly<Record<string, unknown>> | undefined };
}

// ---- the writes, as the selections answer them --------------------------------------

/**
 * `points.add`: one point, or a list, with the new rows' columns. A
 * position makes a row with a new id. A point value or a view makes the row
 * it names, with its id and its own columns (`cols` gives the others); one
 * the geometry holds already is skipped.
 */
export function addPoints(m: Material, at: XY | PointEnd | Iterable<XY | PointEnd> | undefined, cols: Readonly<Record<string, CellValue>> = {}): Material {
  const who = 'points.add';
  if (at === undefined || at === null) return m;
  const one = isPosition(at) || isPointValue(at) || viewKind(at) === 'vertex';
  if (!one && typeof (at as Iterable<unknown>)[Symbol.iterator] !== 'function') throw new Error(`${who}: expected a point — a position, a point value or a view — or a list of them; got ${describe(at)}`);
  const list: readonly unknown[] = one ? [at] : [...(at as Iterable<unknown>)];
  const xs: number[] = [];
  const ys: number[] = [];
  const records: Record<string, unknown>[] = [];
  const ids: number[] = [];
  checkColumns(cols, 'point', who);
  for (const q of list) {
    if (q === undefined || q === null) continue;
    if (isPointValue(q) || viewKind(q) === 'vertex') {
      const v = q as PointEnd;
      xs.push(v.x);
      ys.push(v.y);
      records.push({ ...cols, ...columnsOf(v, ['index', 'x', 'y']) });
      ids.push(v.id);
    } else if (isPosition(q)) {
      xs.push(vx(q));
      ys.push(vy(q));
      // A place with a third number is a point in 3D: its `z` is a column.
      const z = zOf(q);
      records.push(z === undefined ? cols : { ...cols, z });
      ids.push(NaN);
    } else {
      throw new Error(`${who}: expected a point — a position, a point value or a view — or a list of them; got ${describe(q)}`);
    }
  }
  return addPointRows(m, xs, ys, records, ids, who);
}

/** `points.remove`: the rows `what` names — a where, as a write reads one
 * — and every edge row that names one of them. */
export function removePoints(m: Material, what: unknown): Material {
  return removePointRows(m, whereRows(pointsOf(m), what, 'points.remove'));
}

/** `points.set`, on the points `sel` holds. */
export function setPoints(sel: Selection<Vertex>, args: readonly unknown[]): Material {
  return setMaterial(sel, POINT_TABLE, args);
}

/** One edge row a write asks for: its ends, the id it names (NaN: mint
 * one), its lineage root (-1: its own) and its own columns. */
interface EdgeAsk {
  readonly a: unknown;
  readonly b: unknown;
  readonly id: number;
  readonly root: number;
  readonly cols: Readonly<Record<string, unknown>>;
}

/** The edge rows `edges.add` is asked for: one pair `[a, b]`, one edge
 * value or view, or a list of them. */
function edgeAsks(rows: unknown, who: string): EdgeAsk[] {
  if (rows === undefined || rows === null) return [];
  const asEdge = (r: unknown): EdgeAsk | null => {
    if (isEdgeValue(r)) return { a: r.a, b: r.b, id: r.id, root: -1, cols: columnsOf(r, []) };
    if (viewKind(r) === 'edge') {
      // A view of an edge is that edge: added back, it is the wall it was,
      // with the lineage the faces through it are keyed by.
      const e = r as Edge;
      const owner = ownerOf(e);
      if (!(owner instanceof Material)) return { a: e.a, b: e.b, id: e.id, root: -1, cols: {} };
      return { a: e.a, b: e.b, id: e.id, root: at64(owner.store.edgeRoots, e.index), cols: edgeCells(owner, e.index) };
    }
    return null;
  };
  const one = asEdge(rows);
  if (one) return [one];
  if (!Array.isArray(rows)) throw new Error(`${who}: expected a pair [a, b], an edge value, or a list of them — got ${describe(rows)}`);
  if (rows.length === 0) return [];
  // One pair when either member reads as an end rather than as a row: a
  // value, a view, nothing, or a wrong end (a number, a { x, y }) that the
  // reference check then refuses by name.
  const endLike = (v: unknown) => v === undefined || v === null || typeof v === 'number' || isPointValue(v) || viewKind(v) === 'vertex' || (isPosition(v) && !Array.isArray(v));
  if (rows.length === 2 && (endLike(rows[0]) || endLike(rows[1]))) return [{ a: rows[0], b: rows[1], id: NaN, root: -1, cols: {} }];
  const out: EdgeAsk[] = [];
  for (const r of rows) {
    if (r === undefined || r === null) continue;
    const e = asEdge(r);
    if (e) out.push(e);
    else if (isPosition(r)) throw notAPoint(who, r);
    else if (Array.isArray(r) && r.length === 2) out.push({ a: r[0], b: r[1], id: NaN, root: -1, cols: {} });
    else throw new Error(`${who}: an edge row is a pair [a, b] or an edge value — got ${describe(r)}`);
  }
  return out;
}

/** Which of `pairs` is an edge of `m` already, either way round: one pass
 * over the edge list, leaf by leaf. A few pairs — a split's children, an
 * extrude — are compared directly; many go through a set of the asked
 * pairs, so the list is never keyed whole. */
function existingPairs(m: Material, pairs: readonly (readonly [number, number])[]): Uint8Array {
  const out = new Uint8Array(pairs.length);
  if (pairs.length === 0 || m.edgeCount === 0) return out;
  const leaves = m.store.edgeList.leaves();
  if (pairs.length <= 8) {
    for (const leaf of leaves) {
      for (let j = 0; j < leaf.length; j += 2) {
        const u = leaf[j];
        const v = leaf[j + 1];
        for (let k = 0; k < pairs.length; k++) {
          const [a, b] = pairs[k];
          if ((a === u && b === v) || (a === v && b === u)) out[k] = 1;
        }
      }
    }
    return out;
  }
  const asked = new Map<number, number[]>();
  pairs.forEach(([a, b], k) => {
    if (a < 0 || b < 0 || a === b) return;
    const key = pairKey(a, b);
    const list = asked.get(key);
    if (list) list.push(k);
    else asked.set(key, [k]);
  });
  for (const leaf of leaves) {
    for (let j = 0; j < leaf.length; j += 2) {
      const hit = asked.get(pairKey(leaf[j], leaf[j + 1]));
      if (hit) for (const k of hit) out[k] = 1;
    }
  }
  return out;
}

/** @internal Add edge rows between point rows (-1: gone), one column record,
 * one id (NaN: mint one) and one lineage root (-1: its own) per row. Gone,
 * self and already — a pair that is an edge, or an id the geometry holds —
 * are skipped, as is a row with a value that is not finite. */
export function addEdgeRows(
  m: Material,
  pairs: readonly (readonly [number, number])[],
  cols: readonly Readonly<Record<string, unknown>>[],
  roots: readonly number[] | null,
  who: string,
  ids: readonly number[] | null = null,
): Material {
  const declared = m.store.edgeAttrNames;
  const already = existingPairs(m, pairs);
  const seen = new Set<number>();
  const held = new Set<number>();
  const keep: number[] = [];
  const records: Record<string, unknown>[] = [];
  const extra = new Set<string>();
  const reader = new RowCells(m.store.edgeAttrs, who);
  for (let k = 0; k < pairs.length; k++) {
    const [a, b] = pairs[k];
    if (a < 0 || b < 0 || a === b) continue;
    const key = pairKey(a, b);
    if (already[k] === 1 || seen.has(key)) continue;
    const id = ids === null ? NaN : ids[k];
    if (!Number.isNaN(id) && (held.has(id) || m.rowOfEdge(id as EdgeId) >= 0)) continue;
    const given = withAbsentEdge({ ...cols[k] } as Record<string, number>, declared);
    checkNewRowColumns(given, declared, 'edge', who);
    const cells = reader.read(given);
    if (!landsRecord(cells)) continue;
    for (const name in given) if (!declared.includes(name)) extra.add(name);
    seen.add(key);
    if (!Number.isNaN(id)) held.add(id);
    keep.push(k);
    records.push(cells);
  }
  if (keep.length === 0) return m;
  const p = partsOf(m);
  const ends: number[] = [];
  for (const k of keep) ends.push(pairs[k][0], pairs[k][1]);
  p.edgeList = p.edgeList.append(ends);
  for (const name of extra) p.edgeAttrs[name] = newColumn(reader.kindOf(name), m.edgeCount);
  for (const name in p.edgeAttrs) p.edgeAttrs[name] = appendValues(p.edgeAttrs[name], records.map((r) => r[name] ?? reader.fallback(name)));
  const given = keep.map((k) => (ids === null ? NaN : ids[k]));
  const minted = mintIds(given.filter((id) => Number.isNaN(id)).length);
  let next = 0;
  const rowIds = given.map((id) => (Number.isNaN(id) ? minted[next++] : id));
  p.edgeIds = p.edgeIds.append(rowIds);
  p.edgeRoots = p.edgeRoots.append(keep.map((k, j) => (roots !== null && roots[k] >= 0 ? roots[k] : rowIds[j])));
  if (p.edgeKeys !== null) p.edgeKeys = p.edgeKeys.append(keep.map(() => ''));
  return make(m, p);
}

/**
 * `edges.add`: one pair `[a, b]` of point values or views, one edge value
 * or view, or a list of them, with the new rows' columns. An edge value
 * makes the row it names, with its id and its own columns (`cols` gives
 * the others).
 */
export function addEdges(m: Material, rows: unknown, cols: Readonly<Record<string, CellValue>> = {}): Material {
  const who = 'edges.add';
  const asks = edgeAsks(rows, who);
  const pairs = asks.map(({ a, b }) => [pointRow(m, a, who), pointRow(m, b, who)] as const);
  return addEdgeRows(m, pairs, asks.map((e) => ({ ...cols, ...e.cols })), asks.map((e) => e.root), who, asks.map((e) => e.id));
}

/** @internal Remove edge rows; their points stay. */
export function removeEdgeRows(m: Material, rows: readonly number[]): Material {
  if (rows.length === 0) return m;
  const gone = new Set(rows);
  const edges: number[] = [];
  for (let e = 0; e < m.edgeCount; e++) if (!gone.has(e)) edges.push(e);
  return make(m, keepRows(m, null, edges, null));
}

/** `edges.remove`: the rows `what` names — a where, as a write reads one;
 * their points stay. */
export function removeEdges(m: Material, what: unknown): Material {
  return removeEdgeRows(m, whereRows(edgesOf(m), what, 'edges.remove'));
}

/** `edges.set`, on the edges `sel` holds. */
export function setEdges(sel: Selection<Edge>, args: readonly unknown[]): Material {
  return setMaterial(sel, EDGE_TABLE, args);
}

// ---- the face write ------------------------------------------------------------------

/**
 * @internal `faces.set`, over the faces `sel` holds: the columns keyed by
 * face identity. Every face of the state keeps what it carries of a column
 * (its own value, or the one it inherited) and the faces written take
 * their new values, all read from the faces as they were; the column is
 * then written against THIS state's faces, so only a face that appears
 * later inherits. A value that is not finite leaves that face as it was.
 * A face column holds one kind, as a point column does.
 */
export function writeFaces(sel: Selection<Face>, args: readonly unknown[]): Material {
  const who = 'faces.set';
  const { values, names, single, given, where, opts } = readSet<Face>(args, FACE_TABLE, who);
  const face = writeOptions(opts, FACE_TABLE, names, single, who);
  const cells = faceTableOf(sel);
  const rows = given ? whereRows(sel, where, who) : sel.indices;
  if (rows.length === 0 && opts === undefined) return sel.owner as Material;
  const views = cells.faces;
  // Every value is worked out before any lands: one instant. Row by row,
  // each row's columns in the record's order — the order every domain's
  // write reads a record in, so draws happen in the same order anywhere.
  const written: Record<string, unknown[]> = {};
  for (const name of names) written[name] = new Array<unknown>(rows.length);
  rows.forEach((f, i) => {
    for (const name of names) {
      const v = values[name];
      written[name][i] = typeof v === 'function' ? (v as (f: Face) => unknown)(views[f]) : v;
    }
  });
  return writeFaceColumns(cells, rows, written, false, face);
}

/**
 * @internal Face columns written onto faces `rows` of `cells`, the values
 * by position in `rows`: the one door every face write goes through. With
 * `keepNaN` a value that is not finite is written as it is — a
 * measurement that has no answer for a face says so — and otherwise it
 * leaves that face as it was. The faces keep their statement: a column
 * write touches no edge. A column's kind is its first value's (or the one
 * it holds); a value of another kind is refused by name.
 */
export function writeFaceColumns(
  cells: FaceTable,
  rows: readonly number[],
  columns: Readonly<Record<string, ArrayLike<unknown>>>,
  keepNaN: boolean,
  face: WriteOptions = { clearsFallback: false },
): Material {
  const who = 'faces.set';
  const m = cells.source;
  // By id: two faces with the same walls are two faces.
  const keys = cells.ids();
  const next: Record<string, FaceColumn> = { ...m.faceAttrs };
  for (const name of Object.keys(columns)) {
    checkColumnName('face', name, who);
    const values = columns[name];
    const was = m.faceAttrs[name];
    const col: CellKind = { kind: was === undefined ? undefined : (was.kind ?? kinds.number), open: false };
    const map = new Map<string, unknown>();
    const held = cells.carried.get(name);
    if (held) held.forEach((v, f) => { if (v !== undefined) map.set(keys[f], v); });
    rows.forEach((f, i) => {
      const v = values[i];
      if (typeof v === 'number' && (col.kind === undefined || col.kind === kinds.number)) {
        col.kind = kinds.number;
        if (keepNaN || Number.isFinite(v)) map.set(keys[f], v);
        return;
      }
      const cell = landCell(col, v, who, name, false);
      if (cell === SKIP) return;
      map.set(keys[f], Array.isArray(cell) ? Object.freeze(cell) : cell);
    });
    const kind = col.kind;
    const fallback = face.fallback !== undefined ? face.fallback : face.clearsFallback ? undefined : was?.fallback;
    const finalKind = kind ?? kinds.number;
    if (fallback !== undefined) {
      const fk = kindOfValue(fallback);
      if (fk !== finalKind) throw new Error(`${who}: the fallback of '${name}' is ${fk ? kindWords(fk) : String(fallback)}, and the column holds ${kindWords(finalKind)} a face`);
    }
    next[name] = {
      values: map,
      transfer: (face.transfer?.[name] as FaceTransfer | undefined) ?? was?.transfer ?? 'nearest',
      fallback: fallback === undefined ? undefined : Array.isArray(fallback) ? Object.freeze([...fallback]) : fallback,
      seen: new Set(keys),
      // A numeric column says nothing of its kind, as it always has.
      ...(finalKind === kinds.number ? {} : { kind: finalKind }),
    };
  }
  return make(m, partsOf(m), { faceAttrs: next, area: keptArea(m) });
}

// ---- the corner write -----------------------------------------------------------------

/**
 * @internal `corners.set`, over the corners `sel` holds: the corner
 * columns of the stated faces, one instant, each value of any kind. The
 * corners are the faces' own, so the write answers the geometry with a new
 * statement of the same faces — the same loops, the same edges — whose
 * corner columns are these. A corner takes no options: it has no transfer.
 */
export function writeCorners(sel: Selection<Corner>, args: readonly unknown[]): Material {
  const who = 'corners.set';
  const { values, names, single, given, where, opts } = readSet<Corner>(args, CORNER_TABLE, who);
  writeOptions(opts, CORNER_TABLE, names, single, who);
  const d = sel.domain as CornerDomain;
  const m = d.owner;
  const stated = d.stated;
  if (stated === undefined) return m;
  const rows = given ? whereRows(sel, where, who) : sel.members;
  if (rows !== null && rows.length === 0) return m;
  const cols: Record<string, AnyColumn> = { ...(stated.corners ?? {}) };
  for (const sink of landColumns(cols, d.size, [], values, names, rows, () => (i: number) => d.row(i), who)) cols[sink.name] = sink.done();
  return make(m, partsOf(m), { faces: { ...stated, corners: Object.freeze(cols) }, area: keptArea(m) });
}

// ---- recipes -------------------------------------------------------------------------

/**
 * `g.extrude(from, offset, cols?)`: add a point at `from + offset`, then
 * add the edge from `from` to it. The offset is a step from the point — in
 * a curved space it walks the geodesic (`exp`). Given nothing, or a point
 * that is gone, it returns `g`. To name the new point in a later write,
 * write the two writes with a point value: `q = point(…)`, then
 * `g.points.add(q).edges.add([from, q])`.
 */
export function extrude(m: Material, from: PointEnd | undefined, offset: XY | readonly [number, number, number], cols: Readonly<Record<string, CellValue>> = {}): Material {
  const who = 'extrude';
  // The new edge has no value for a declared edge column, and extrude has
  // no place to take one: that is the two table lines, written out.
  const owed = m.store.edgeAttrNames.filter((name) => !(name in EDGE_ABSENT));
  if (owed.length > 0) throw new Error(`${who}: this material declares the edge column '${owed[0]}', and the new edge needs a value for it — write the two writes: q = point(xy, cols), then g.points.add(q).edges.add([from, q], { ${owed[0]}: … })`);
  if (from === undefined || from === null) return m;
  const row = pointRow(m, from, who);
  if (row < 0) return m;
  const dx = vx(offset);
  const dy = vy(offset);
  const sp = m.space !== undefined && m.space.kind !== 'euclidean' ? m.space : null;
  const px = at64(m.store.x, row);
  const py = at64(m.store.y, row);
  const q: Vec = sp ? sp.exp([px, py], [dx, dy]) : [px + dx, py + dy];
  // A point with a `z` is extruded in 3D: the offset's third number, or
  // level with the point it grows from.
  const Z = m.store.attrs.z;
  const own = Z instanceof Column && !('z' in cols) ? { ...cols, z: at64(Z, row) + dzOf(offset) } : cols;
  const withPoint = addPointRows(m, [q[0]], [q[1]], [own], null, who);
  if (withPoint.n === m.n) return m;
  return addEdgeRows(withPoint, [[row, m.n]], [{}], null, who);
}

/**
 * `g.split(edges, at?)`: for each edge, add the point `at` of the way along
 * it (its columns by the transfer rules), remove the edge, and add the two
 * edges through the new point, which keep the parent's lineage root and
 * share its columns (`'copy'` or `'distribute'`). `at` is a number or a
 * function of the edge, default 0.5; one that is not finite skips that
 * edge, and one outside 0…1 is read as the nearer end, where a cut makes
 * nothing.
 */
export function split(m: Material, edges: unknown, at: number | ((e: Edge) => number) = 0.5): Material {
  const who = 'split';
  if (typeof at !== 'number' && typeof at !== 'function') throw new Error(`${who}: at is a number along the edge, or a function of the edge — got ${typeof at}`);
  const rows = whereRows(edgesOf(m), edges, who);
  const { x: X, y: Y, edgeList: list, edgeRoots } = m.store;
  // Each cut, decided before any row is numbered: its place, the new
  // point's columns and the two children's.
  const cut: { e: number; x: number; y: number; point: Record<string, unknown>; children: [Record<string, unknown>, Record<string, unknown>] }[] = [];
  const view = typeof at === 'function' ? edgeReader(m, rows.length) : null;
  for (const e of rows) {
    const asked = view === null ? (at as number) : (at as (e: Edge) => number)(view(e));
    if (!Number.isFinite(asked)) continue;
    // A place past an end is read as that end, and a cut at an end cuts
    // nothing: the end is already a point.
    const t = Math.min(Math.max(asked, 0), 1);
    if (t === 0 || t === 1) continue;
    const a = atU32(list, 2 * e);
    const b = atU32(list, 2 * e + 1);
    const x = at64(X, a) + (at64(X, b) - at64(X, a)) * t;
    const y = at64(Y, a) + (at64(Y, b) - at64(Y, a)) * t;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    // A point column crosses by its policy, and the children share the
    // edge's columns. A cut whose point or child would not land — a column
    // that is not finite at an end — leaves the edge as it is, as a place
    // that is not finite does.
    const point = cellsBetween(m, a, b, t);
    const children: [Record<string, unknown>, Record<string, unknown>] = [edgeCells(m, e, t), edgeCells(m, e, 1 - t)];
    if (landsRecord(point) && landsRecord(children[0]) && landsRecord(children[1])) cut.push({ e, x, y, point, children });
  }
  if (cut.length === 0) return m;
  const withPoints = addPointRows(m, cut.map((c) => c.x), cut.map((c) => c.y), cut.map((c) => c.point), null, who);
  const without = removeEdgeRows(withPoints, cut.map((c) => c.e));
  const pairs: [number, number][] = [];
  const childCols: Record<string, unknown>[] = [];
  const roots: number[] = [];
  cut.forEach(({ e, children }, k) => {
    const a = atU32(list, 2 * e);
    const b = atU32(list, 2 * e + 1);
    const mid = m.n + k;
    pairs.push([a, mid], [mid, b]);
    childCols.push(...children);
    roots.push(at64(edgeRoots, e), at64(edgeRoots, e));
  });
  const out = addEdgeRows(without, pairs, childCols, roots, who);
  // A new point and the two edges through it came from the edge it cut:
  // that edge's row of the value split was given.
  const from = new Map<number, number>();
  pairs.forEach((pair, k) => from.set(pairKey(pair[0], pair[1]), cut[k >> 1].e));
  return linkMade(m, out, cut.map((c) => c.e), without.edgeCount, from, derivation('split', [m], { at }));
}

/**
 * A recipe's result, linked to the value it was given: point row `m.n + k`
 * of `out` came from input edge `pointFrom[k]`, and every edge row from
 * `edgeBase` on from the input edge its two ends name in `edgeFrom` (-1 or
 * absent: from none). A row the recipe did not make keeps what it answered
 * before (derivation.ts): its layer here says nothing about it.
 */
function linkMade(m: Material, out: Material, pointFrom: readonly number[], edgeBase: number, edgeFrom: ReadonlyMap<number, number>, node: ReturnType<typeof derivation>): Material {
  if (out === m) return m;
  // Sparse: only the rows the recipe made hold a number, so a long run of
  // recipes keeps one entry a made row, not one a row of the state.
  const points: number[] = [];
  points.length = out.n;
  for (let k = 0; k < pointFrom.length && m.n + k < out.n; k++) points[m.n + k] = pointFrom[k];
  const edges: number[] = [];
  edges.length = out.edgeCount;
  const list = out.store.edgeList;
  for (let e = edgeBase; e < out.edgeCount; e++) {
    const src = edgeFrom.get(pairKey(atU32(list, 2 * e), atU32(list, 2 * e + 1)));
    if (src !== undefined && src >= 0) edges[e] = src;
  }
  linkRows(out, {
    points: { source: { of: m, domain: 'edges', rows: points } },
    edges: { source: { of: m, domain: 'edges', rows: edges } },
  });
  return record(out, node);
}

/** How a motif lands on an edge in `replace`. */
export interface ReplaceOpts {
  /** Mirror the motif across the edge: for every edge, or for the edges a
   * test of the edge picks. Which side is "outward" depends on the winding
   * of the edges the motif lands on. */
  flip?: boolean | ((e: Edge) => boolean);
}

/** How close, as a fraction of the replaced edge's length, a motif point
 * must land on a point already there to be that point. Rounding in the
 * motif's frame is some 1e-14 of it; a distance a sketch means is not
 * below 1e-9 of it. */
const WELD = 1e-9;

/** The places `replace` has landed on: the state's own points first, then
 * every motif point it adds, each by its row in the result. Looked up in a
 * grid of cells sized to the state's shortest edge, so a weld is a handful
 * of compares. */
class Landing {
  private readonly cells = new Map<string, { x: number; y: number; row: number }[]>();
  private readonly size: number;

  constructor(m: Material) {
    const { x, y, edgeList } = m.store;
    let shortest = Infinity;
    for (let e = 0; e < m.edgeCount; e++) {
      const a = atU32(edgeList, 2 * e);
      const b = atU32(edgeList, 2 * e + 1);
      const d = Math.hypot(at64(x, b) - at64(x, a), at64(y, b) - at64(y, a));
      if (d > 0 && d < shortest) shortest = d;
    }
    this.size = Number.isFinite(shortest) ? shortest : 1;
    for (let i = 0; i < m.n; i++) this.add(at64(x, i), at64(y, i), i);
  }

  add(x: number, y: number, row: number): void {
    const k = `${Math.floor(x / this.size)},${Math.floor(y / this.size)}`;
    const cell = this.cells.get(k);
    if (cell) cell.push({ x, y, row });
    else this.cells.set(k, [{ x, y, row }]);
  }

  /** The first place within `tol` of (x, y), oldest first; -1 for none. */
  find(x: number, y: number, tol: number): number {
    const ci = Math.floor(x / this.size);
    const cj = Math.floor(y / this.size);
    for (let i = ci - 1; i <= ci + 1; i++) {
      for (let j = cj - 1; j <= cj + 1; j++) {
        for (const held of this.cells.get(`${i},${j}`) ?? []) {
          if (Math.hypot(held.x - x, held.y - y) <= tol) return held.row;
        }
      }
    }
    return -1;
  }
}

/**
 * `g.replace(edges, motif, opts?)`: every edge swapped for a motif. The
 * edge goes, and the motif's one open chain takes its place between the
 * same two points, scaled and turned to the edge: remove the edge rows,
 * add the motif's inner points, add the edges along the chain. Point
 * columns cross by their transfer policy and edge columns are shared as a
 * split's children share them, each piece taking an equal share. A motif
 * point that lands on a point already there — a corner, or the tip another
 * edge's motif put in the same place — IS that point, so motifs that meet
 * share a vertex. This is the substitution an L-system is made of: a Koch
 * curve is one motif and four steps.
 */
export function replace(m: Material, edges: unknown, motif: Material, opts: ReplaceOpts = {}): Material {
  const who = 'replace';
  if (!(motif instanceof Material)) throw new Error(`${who}: a motif is a material — one open chain — got ${describe(motif)}`);
  const flip = opts.flip;
  if (flip !== undefined && typeof flip !== 'boolean' && typeof flip !== 'function') throw new Error(`${who}: flip is true, false, or a test of the edge — got ${typeof flip}`);
  // The motif's CHAIN, not its rows. A material's row order is an accident
  // of how it was built, so threading rows would silently draw a different
  // motif than the one on screen.
  const chains = chainsOf(motif);
  if (chains.length !== 1) throw new Error(`${who}: a motif is one open chain, and this one has ${chains.length === 0 ? 'none' : String(chains.length)}. Give the motif's points the edges that join them in order.`);
  if (chains[0].closed) throw new Error(`${who}: a motif is an open chain, and this one is closed`);
  const pts = chains[0].pts;
  if (pts.length < 2) throw new Error(`${who}: a motif needs at least two points`);
  const [mx0, my0] = pts[0];
  const [mx1, my1] = pts[pts.length - 1];
  const mdx = mx1 - mx0;
  const mdy = my1 - my0;
  const span = mdx * mdx + mdy * mdy;
  if (!(span > 0)) throw new Error(`${who}: a motif must start and end at different points`);
  // The motif in its own frame: along the line from first to last, and
  // across it, both as fractions of the motif's own span, so the shape
  // rides any edge at any length and any angle.
  const local = pts.slice(1, -1).map(([px, py]) => {
    const ux = px - mx0;
    const uy = py - my0;
    return [(ux * mdx + uy * mdy) / span, (ux * -mdy + uy * mdx) / span] as const;
  });
  const rows = whereRows(edgesOf(m), edges, who);
  if (rows.length === 0) return m;
  const landed = new Landing(m);
  const xs: number[] = [];
  const ys: number[] = [];
  const cols: Record<string, unknown>[] = [];
  // The replaced edge each new point and each new edge came from.
  const pointFrom: number[] = [];
  const edgeFrom = new Map<number, number>();
  const pairs: [number, number][] = [];
  const pairCols: Record<string, unknown>[] = [];
  const gone: number[] = [];
  const view = edgeReader(m, rows.length);
  for (const row of rows) {
    const e = view(row);
    const ex = e.b.x - e.a.x;
    const ey = e.b.y - e.a.y;
    const across = (typeof flip === 'function' ? flip(e) : flip === true) ? -1 : 1;
    const places = local.map(([along, off]) => [e.a.x + along * ex - off * across * ey, e.a.y + along * ey + off * across * ex] as const);
    // An edge whose motif does not land on finite places is left as it is.
    if (!places.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))) continue;
    // A motif point stands between the edge's ends, so it takes their
    // columns the way a split point does, and each piece an equal share.
    // What lands is decided before any row is numbered: an edge whose
    // points or pieces would not land — a column that is not finite at an
    // end — is left as it is too.
    const child = edgeCells(m, row, 1 / (local.length + 1));
    const cells = local.map(([along]) => cellsBetween(m, e.a.index, e.b.index, along));
    if (!landsRecord(child) || !cells.every(landsRecord)) continue;
    gone.push(row);
    // Two positions this close are one place worked out twice: the motifs
    // of two walls that meet at a tip, or a tip on a corner.
    const tol = WELD * Math.hypot(ex, ey);
    let from = e.a.index;
    places.forEach(([x, y], k) => {
      let at = landed.find(x, y, tol);
      if (at < 0) {
        at = m.n + xs.length;
        xs.push(x);
        ys.push(y);
        cols.push(cells[k]);
        pointFrom.push(row);
        landed.add(x, y, at);
      }
      if (at !== from) {
        pairs.push([from, at]);
        pairCols.push(child);
        if (!edgeFrom.has(pairKey(from, at))) edgeFrom.set(pairKey(from, at), row);
      }
      from = at;
    });
    if (from !== e.b.index) {
      pairs.push([from, e.b.index]);
      pairCols.push(child);
      if (!edgeFrom.has(pairKey(from, e.b.index))) edgeFrom.set(pairKey(from, e.b.index), row);
    }
  }
  if (gone.length === 0) return m;
  const withPoints = addPointRows(removeEdgeRows(m, gone), xs, ys, cols, null, who);
  const out = addEdgeRows(withPoints, pairs, pairCols, null, who);
  return linkMade(m, out, pointFrom, withPoints.edgeCount, edgeFrom, derivation('replace', [m, motif], { flip }));
}

/**
 * `g.move(...displacements, where?)`: every point of `where` (default all)
 * moved by the SUM of the displacements, in one instant — each is read on
 * the graph as it was. A displacement is a vector, a function of the point
 * `(p) => [dx, dy]`, or a force such as `force.tension({ rest })`, which
 * the move prepares from the graph once. A trailing selection, point value
 * or vertex says which points move. A move that is not finite skips that
 * point. In a curved space the point walks the geodesic.
 */
export function move(m: Material, args: readonly unknown[]): Material {
  const who = 'move';
  let parts = args;
  let rows: number[] | null = null;
  const last = args[args.length - 1];
  // Which points move: a selection, one point, or a list of them — a list
  // of points, never a vector, which holds numbers.
  const listed = Array.isArray(last) && last.every((v) => isPointValue(v) || viewKind(v) !== undefined);
  if (args.length > 0 && (last === undefined || last === null || last instanceof Selection || isPointValue(last) || viewKind(last) !== undefined || listed)) {
    parts = args.slice(0, -1);
    rows = [...whereRows(pointsOf(m), last, who)];
  }
  if (parts.length === 0 || (rows !== null && rows.length === 0)) return m;
  const fns = parts.map((d, i): ((p: Vertex) => XY) => {
    if (isGraphForce(d)) return d.prepare(m);
    if (typeof d === 'function') return d as (p: Vertex) => XY;
    if (isPosition(d)) {
      const z = zOf(d);
      const c = (z === undefined ? [vx(d), vy(d)] : [vx(d), vy(d), z]) as Vec;
      return () => c;
    }
    throw new Error(`${who}: displacement ${i + 1} is ${describe(d)} — give a vector, a function of the point, or a force; which points move is the last argument`);
  });
  const p = partsOf(m);
  const sp = m.space !== undefined && m.space.kind !== 'euclidean' ? m.space : null;
  // Only the leaves the moving points fall in are copied.
  const X = m.store.x;
  const Y = m.store.y;
  const reach = rows === null ? 'all' : rows;
  const nx = X.writer(reach);
  const ny = Y.writer(reach);
  // Where row `i` lands, into `to` (x, y, and the step in z); false when
  // its move is not finite. `lifts` is whether its step has a third number
  // at all — a step in space, even one of zero, moves in space.
  const to = new Float64Array(3);
  let lifts = false;
  const view = vertexReader(m, rows === null ? m.n : rows.length);
  const shift = (i: number): boolean => {
    const v = view(i);
    const first = fns[0](v);
    let dx = vx(first);
    let dy = vy(first);
    let dz = dzOf(first);
    lifts = hasZ(first);
    for (let j = 1; j < fns.length; j++) {
      const d = fns[j](v);
      dx += vx(d);
      dy += vy(d);
      dz += dzOf(d);
      if (hasZ(d)) lifts = true;
    }
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(dz)) return false;
    to[2] = dz;
    const px = at64(X, i);
    const py = at64(Y, i);
    if (sp) {
      const q = sp.exp([px, py], [dx, dy]);
      to[0] = q[0];
      to[1] = q[1];
    } else {
      to[0] = px + dx;
      to[1] = py + dy;
    }
    return true;
  };
  // A step in z lands in the `z` column, made the first time one does.
  const Z = m.store.attrs.z;
  let nz: ColumnWriter<Float64Array> | null = null;
  const lift = (i: number): void => {
    nz ??= (Z instanceof Column ? Z : Column.zeros(Float64Array, m.n)).writer(reach);
    nz.set(i, nz.get(i) + to[2]);
  };
  if (rows === null) {
    const ax = nx.array()!;
    const ay = ny.array()!;
    for (let i = 0; i < m.n; i++) {
      if (!shift(i)) continue;
      ax[i] = to[0];
      ay[i] = to[1];
      if (lifts) lift(i);
    }
  } else {
    for (const i of rows) {
      if (!shift(i)) continue;
      nx.set(i, to[0]);
      ny.set(i, to[1]);
      if (lifts) lift(i);
    }
  }
  p.x = nx.done();
  p.y = ny.done();
  if (nz !== null) p.attrs.z = (nz as ColumnWriter<Float64Array>).done();
  return make(m, p);
}

/** The step in z of a displacement: its third number, or 0 for a step in
 * the plane. */
function dzOf(d: XY): number {
  return hasZ(d) ? (Array.isArray(d) ? (d[2] as number) : (d as unknown as { z: number }).z) : 0;
}

/** Does a displacement have a third number — is it a step in space? */
function hasZ(d: XY): boolean {
  if (Array.isArray(d)) return d.length > 2 && typeof d[2] === 'number';
  return typeof (d as { z?: unknown }).z === 'number';
}
