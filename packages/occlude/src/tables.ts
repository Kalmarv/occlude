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

import { Material, mintIds, vertexReader, edgeReader, withAbsentEdge, EDGE_ABSENT, RESERVED_EDGE_FIELDS, RESERVED_FACE_FIELDS, type Vertex, type Edge, type PointId, type EdgeId, type TransferPolicy, type EdgeTransfer, type FaceTransfer, type FaceColumn } from './material.js';
import { chainsOf } from './curves.js';
import { pointDomain, edgeDomain, isPointSelection, isEdgeSelection } from './relation.js';
import { faceTableOf, type Face, type FaceTable } from './faces.js';
import { Selection, rowsIn } from './selection.js';
import { isGraphForce, type GraphForce } from './forces.js';
import { vx, vy, type XY, type Vec } from './vec.js';
import { ownedBy, ownerOfView, pairKey, viewKind } from './views.js';
import { Column, at64, atU32, type ColumnWriter } from './column.js';
import { carryLinks, carryRunLinks, derivation, linkRows, record } from './derivation.js';

/** A point you hold: a position, its columns, and the id minted when it
 * was made (not enumerable — a spread copy is a plain position). */
export type PointValue = { readonly x: number; readonly y: number; readonly id: PointId } & Readonly<Record<string, number>>;

/** An edge you hold: its two ends (point values or views), its columns,
 * and the id minted when it was made. */
export type EdgeValue = { readonly a: PointValue | Vertex; readonly b: PointValue | Vertex; readonly id: EdgeId } & Readonly<Record<string, unknown>>;

/** A point a write names: a point value, or a vertex view of this state
 * or of any other. */
export type PointEnd = PointValue | Vertex;
/** An edge row to add: its two ends. */
export type EdgeRowSpec = readonly [PointEnd | undefined, PointEnd | undefined];
/** An edge a write names: an edge value, or an edge view. */
export type EdgeEnd = EdgeValue | Edge;

/** Which point rows a `where` names: a point selection (of this state or an
 * earlier one), one point value or vertex, or a predicate over the rows. */
export type PointWhere = Selection<Vertex> | PointEnd | ((p: Vertex) => unknown) | undefined;
/** Which edge rows a `where` names, the same three ways. */
export type EdgeWhere = Selection<Edge> | EdgeEnd | ((e: Edge) => unknown) | undefined;

/** A column value: one number for every row, or one per row from its view. */
export type ColumnValue<V> = number | ((row: V) => number);

/** What a displacement in `move` may be: a vector, a function of the point,
 * or a force that the move prepares from the graph. */
export type Displacement = XY | ((p: Vertex) => XY) | GraphForce;

/** How a point column crosses a split, a resample or a replace: the
 * trailing options record of `points.set`. */
export interface PointSetOpts { readonly transfer?: TransferPolicy }
/** How an edge column is shared by the children of a split edge: the
 * trailing options record of `edges.set`. */
export interface EdgeSetOpts { readonly transfer?: EdgeTransfer }
/** How a face column follows a change of walls, and what a face that
 * shares no wall with an old one starts from: the trailing options record
 * of `faces.set`. */
export interface FaceSetOpts { readonly transfer?: FaceTransfer; readonly fallback?: number }

/** The names a point view owns; `x` and `y` are columns a write may set. */
const RESERVED_POINT_FIELDS: readonly string[] = ['index', 'adjacent', 'edges', 'id', 'source'];

// ---- building a new state --------------------------------------------------------

/** The columns a write builds its new state from: `m`'s own, shared, until
 * the write replaces one. A write never copies a column it does not
 * change, and a column it changes shares every leaf it does not touch. */
interface Parts {
  x: Column;
  y: Column;
  attrs: Record<string, Column>;
  pointIds: Column;
  edgeList: Column<Uint32Array>;
  edgeAttrs: Record<string, Column>;
  edgeIds: Column;
  edgeRoots: Column;
}

/** Every column of `m`, shared: the parts a write starts from. */
function partsOf(m: Material): Parts {
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
  };
}

/** What a write hands on besides the rows: by default `m`'s own. */
interface Carry {
  iteration?: number;
  history?: readonly Material[];
  transfers?: Record<string, TransferPolicy>;
  edgeTransfers?: Record<string, EdgeTransfer>;
  faceAttrs?: Record<string, FaceColumn>;
}

/** The new state: `m`'s policies, face columns, space and iteration, with
 * these rows — and `m`'s stated faces, which the new state keeps only when
 * its edges are `m`'s (see `statedFor`). A write keeps row identity, so
 * what a row answers as `source` and `u` (derivation.ts) goes with it. */
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
    faceAttrs: carry.faceAttrs ?? m.faceAttrs,
    from: m,
    faces: m.stated,
  });
}

/** @internal `m` at another iteration and with a history: what `t.steps`
 * hands on between steps and returns at the end. Every row carries, and
 * every column is shared. Given the run's `start`, the state keeps the
 * links the start carried and drops the ones a pass made
 * (`carryRunLinks`): a run does not hold every state it passed through. */
export function restamp(m: Material, iteration: number, history: readonly Material[] = [], start?: unknown): Material {
  const out = build(m, partsOf(m), { iteration, history });
  return start === undefined ? carryLinks(m, out) : carryRunLinks(m, out, start);
}

// ---- values you hold ----------------------------------------------------------------

/** The brand of a point or edge value: on the prototype, so a spread copy
 * is a plain record, as a spread view is. */
const VALUE = Symbol('value');
const POINT_PROTO: object = Object.freeze(Object.create(Object.prototype, { [VALUE]: { value: 'point' } }));
const EDGE_PROTO: object = Object.freeze(Object.create(Object.prototype, { [VALUE]: { value: 'edge' } }));

/** @internal Is `v` a point value that `point(…)` made? */
export const isPointValue = (v: unknown): v is PointValue =>
  typeof v === 'object' && v !== null && (v as Record<symbol, unknown>)[VALUE] === 'point';
/** @internal Is `v` an edge value that `edge(…)` made? */
export const isEdgeValue = (v: unknown): v is EdgeValue =>
  typeof v === 'object' && v !== null && (v as Record<symbol, unknown>)[VALUE] === 'edge';

/** A value's columns: a point value's or a view's own enumerable numbers,
 * less the names the value owns. */
/** The edge columns of row `e` of `m`, as a record. */
function edgeColumns(m: Material, e: number): Record<string, number> {
  const out: Record<string, number> = {};
  const cols = m.store.edgeAttrs;
  for (const name in cols) out[name] = at64(cols[name], e);
  return out;
}

function columnsOf(v: object, own: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of Object.keys(v)) if (!own.includes(name)) out[name] = (v as Record<string, number>)[name];
  return out;
}

/** A value's columns as a record, checked: a column is a number. */
function checkColumns(cols: unknown, reserved: readonly string[], what: string, who: string): Record<string, number> {
  if (cols === undefined) return {};
  if (typeof cols !== 'object' || cols === null || Array.isArray(cols)) throw new Error(`${who}: the columns of ${what} are a record, { name: value }`);
  for (const name in cols) {
    if (reserved.includes(name)) throw new Error(`${who}: '${name}' is a reserved field of ${what}, not a column`);
    if (typeof (cols as Record<string, unknown>)[name] !== 'number') throw new Error(`${who}: the column '${name}' of ${what} is a number — got ${typeof (cols as Record<string, unknown>)[name]}`);
  }
  return cols as Record<string, number>;
}

/**
 * A point you hold: a position with its columns, named from the moment it
 * is made. Add it to a geometry, and it names the row it became in that
 * state and in every later one — `g.points.add(q).edges.add([q, p])`.
 * `xy` is `[x, y]`, `{ x, y }` or a view, of which it takes only the place;
 * `cols` are the new row's columns, and a geometry that declares a column
 * needs it here.
 */
export function point(xy: XY, cols?: Record<string, number>): PointValue {
  const who = 'point';
  if (!isPosition(xy) && !isPointValue(xy) && viewKind(xy) !== 'vertex') throw new Error(`${who}: expected a position [x, y] or { x, y } — got ${describe(xy)}`);
  const own = checkColumns(cols, ['x', 'y', ...RESERVED_POINT_FIELDS], 'a point', who);
  const p = Object.create(POINT_PROTO) as Record<string, unknown>;
  p.x = vx(xy);
  p.y = vy(xy);
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
export function edge(a: PointEnd, b: PointEnd, cols?: Record<string, number>): EdgeValue {
  const who = 'edge';
  for (const end of [a, b]) {
    if (!isPointValue(end) && viewKind(end) !== 'vertex') throw referenceError(who, end);
  }
  const own = checkColumns(cols, RESERVED_EDGE_FIELDS, 'an edge', who);
  const e = Object.create(EDGE_PROTO) as Record<string, unknown>;
  Object.defineProperty(e, 'a', { value: a, enumerable: false });
  Object.defineProperty(e, 'b', { value: b, enumerable: false });
  for (const name in own) e[name] = own[name];
  Object.defineProperty(e, 'id', { value: mintIds(1)[0], enumerable: false });
  return Object.freeze(e) as EdgeValue;
}

// ---- reading references ------------------------------------------------------------

const isPosition = (v: unknown): v is XY => {
  if (Array.isArray(v)) return v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number';
  if (typeof v !== 'object' || v === null || viewKind(v) !== undefined || isPointValue(v)) return false;
  const o = v as { x?: unknown; y?: unknown };
  return typeof o.x === 'number' && typeof o.y === 'number';
};

/** A reference that is not a value: a wrong program, refused by name. */
const referenceError = (who: string, got: unknown): Error =>
  new Error(`${who}: a reference must be a point value or a view; make one with point(…) — got ${describe(got)}`);

/** The row a point reference names in `m`, or -1 when it names nothing here. */
export function pointRow(m: Material, end: unknown, who: string): number {
  if (end === undefined || end === null) return -1;
  if (isPointValue(end)) return m.rowOfPoint(end.id);
  const kind = viewKind(end);
  if (kind === 'vertex') {
    const v = end as Vertex;
    return ownedBy(v, m) ? v.index : m.rowOfPoint(v.id);
  }
  throw referenceError(who, end);
}

/** The row an edge reference names in `m`, or -1 when it is gone. */
export function edgeRow(m: Material, e: unknown, who: string): number {
  if (e === undefined || e === null) return -1;
  if (isEdgeValue(e)) return m.rowOfEdge(e.id);
  if (viewKind(e) === 'edge') {
    const v = e as Edge;
    return ownedBy(v, m) ? v.index : m.rowOfEdge(v.id);
  }
  throw new Error(`${who}: an edge reference must be an edge value or an edge view; make one with edge(…) — got ${describe(e)}`);
}

const describe = (v: unknown): string => {
  const kind = viewKind(v);
  if (kind) return `a ${kind} view`;
  if (isPointValue(v)) return 'a point value';
  if (isEdgeValue(v)) return 'an edge value';
  if (v instanceof Selection) return `a${v.domain.kind.name === 'edge' ? 'n' : ''} ${v.domain.kind.name} selection`;
  if (isPosition(v)) return Array.isArray(v) ? 'a position [x, y]' : 'a position { x, y }';
  if (Array.isArray(v)) return 'a list';
  return typeof v;
};

/** The point rows a selection or a member names in `m`, ascending. A
 * selection of an earlier state is read by identity; nothing is none. */
export function pointRowsOf(m: Material, what: unknown, who: string): number[] {
  if (what === undefined || what === null) return [];
  if (isPointSelection(what)) {
    if (what.length === 0) return [];
    return [...rowsIn(pointDomain(m), what, who)];
  }
  if (isEdgeSelection(what)) throw new Error(`${who}: expected points — a point selection or a vertex — got an edge selection; its points are sel.points`);
  const row = pointRow(m, what, who);
  return row < 0 ? [] : [row];
}

/** The edge rows a selection or a member names in `m`, ascending. */
export function edgeRowsOf(m: Material, what: unknown, who: string): number[] {
  if (what === undefined || what === null) return [];
  if (isEdgeSelection(what)) {
    if (what.length === 0) return [];
    return [...rowsIn(edgeDomain(m), what, who)];
  }
  if (isPointSelection(what)) throw new Error(`${who}: expected edges — an edge selection or an edge — got a point selection; the edges among its points are sel.edges`);
  const row = edgeRow(m, what, who);
  return row < 0 ? [] : [row];
}

/** The rows `where` names among `members` (null: every row of `m`). */
function whereOf<V>(
  m: Material,
  members: readonly number[] | null,
  count: number,
  reader: (m: Material, count: number) => (i: number) => V,
  given: boolean,
  where: unknown,
  rowsOf: (m: Material, what: unknown, who: string) => number[],
  who: string,
): number[] | null {
  if (!given) return members === null ? null : [...members];
  if (typeof where === 'function') {
    const out: number[] = [];
    const view = reader(m, members === null ? count : members.length);
    const pick = where as (v: V) => unknown;
    if (members === null) {
      for (let i = 0; i < count; i++) if (pick(view(i))) out.push(i);
    } else {
      for (const i of members) if (pick(view(i))) out.push(i);
    }
    return out;
  }
  const rows = rowsOf(m, where, who);
  if (members === null) return rows;
  const inside = new Set(members);
  return rows.filter((r) => inside.has(r));
}

// ---- the three writes on points -----------------------------------------------------

/** Columns a new row gives, checked: reserved names refused, and every
 * declared column named when a row is being added. */
function checkNewRowColumns(given: Readonly<Record<string, number>>, declared: readonly string[], reserved: readonly string[], what: string, who: string): void {
  if (typeof given !== 'object' || given === null || Array.isArray(given)) throw new Error(`${who}: the columns of ${what} are a record, { name: value }`);
  for (const name in given) {
    if (reserved.includes(name)) throw new Error(`${who}: '${name}' is a reserved field of ${what}, not a column`);
  }
  for (const name of declared) {
    if (!(name in given)) throw new Error(`${who}: must give '${name}' for ${what} — every declared column is a choice`);
  }
}

const finiteRecord = (r: Readonly<Record<string, number>>): boolean => {
  for (const k in r) if (!Number.isFinite(r[k])) return false;
  return true;
};

/** @internal Add point rows, one column record per row and one id (NaN:
 * mint one) per row. A row at a position or with a value that is not
 * finite is skipped, and so is a row whose id the geometry holds already
 * (`already`), or that comes twice in one write. */
export function addPointRows(m: Material, xs: readonly number[], ys: readonly number[], cols: readonly Readonly<Record<string, number>>[], ids: readonly number[] | null, who: string): Material {
  if (xs.length === 0) return m;
  const declared = m.attrNames;
  const extra = new Set<string>();
  for (const c of cols) {
    checkNewRowColumns(c, declared, ['x', 'y', ...RESERVED_POINT_FIELDS], 'a new point', who);
    for (const name in c) if (!declared.includes(name)) extra.add(name);
  }
  const keep: number[] = [];
  const held = new Set<number>();
  for (let k = 0; k < xs.length; k++) {
    const id = ids === null ? NaN : ids[k];
    if (!Number.isNaN(id)) {
      if (held.has(id) || m.rowOfPoint(id as PointId) >= 0) continue;
      held.add(id);
    }
    if (Number.isFinite(xs[k]) && Number.isFinite(ys[k]) && finiteRecord(cols[k])) keep.push(k);
  }
  if (keep.length === 0) return m;
  const p = partsOf(m);
  p.x = p.x.append(keep.map((k) => xs[k]));
  p.y = p.y.append(keep.map((k) => ys[k]));
  // A column a new row declares is 0 on every row that was already there.
  for (const name of extra) p.attrs[name] = Column.zeros(Float64Array, m.n);
  for (const name in p.attrs) p.attrs[name] = p.attrs[name].append(keep.map((k) => cols[k][name]));
  const given = keep.map((k) => (ids === null ? NaN : ids[k]));
  const minted = mintIds(given.filter((id) => Number.isNaN(id)).length);
  let next = 0;
  p.pointIds = p.pointIds.append(given.map((id) => (Number.isNaN(id) ? minted[next++] : id)));
  return make(m, p);
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
    for (const name in p.attrs) p.attrs[name] = p.attrs[name].keep(points);
    p.pointIds = p.pointIds.keep(points);
  }
  for (const name in p.edgeAttrs) p.edgeAttrs[name] = p.edgeAttrs[name].keep(edges);
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

/** The transfer policies a write declares, checked against the domain:
 * `undefined` when the write declares none. */
function declaredTransfer(opts: Readonly<Record<string, unknown>> | undefined, domain: 'points' | 'edges', names: readonly string[], who: string): string | undefined {
  if (opts === undefined) return undefined;
  for (const key of Object.keys(opts)) {
    if (key === 'transfer') continue;
    if (key === 'fallback') throw new Error(`${who}: 'fallback' is an option of a face column — a ${domain === 'points' ? 'point' : 'n edge'} row always has a value`);
    throw new Error(`${who}: unknown option '${key}' — the options record of a write is { transfer }`);
  }
  const t = opts.transfer;
  if (t === undefined) return undefined;
  const allowed = domain === 'points' ? ['interpolate', 'nearest'] : ['copy', 'distribute'];
  if (typeof t !== 'string' || !allowed.includes(t)) throw new Error(`${who}: transfer is ${allowed.map((a) => `'${a}'`).join(' or ')} — got ${typeof t === 'string' ? `'${t}'` : typeof t}`);
  if (domain === 'points') for (const name of names) if (name === 'x' || name === 'y') throw new Error(`${who}: '${name}' is a position, and a position has no transfer policy`);
  return t;
}

/** @internal Set columns over `rows` (null: every row), one instant: every
 * callback reads `m` as it was. `transfer`, when given, is the policy every
 * named column is declared with; the default policy is stored as none. */
function setRows<V>(
  m: Material,
  domain: 'points' | 'edges',
  values: Readonly<Record<string, ColumnValue<V>>>,
  rows: readonly number[] | null,
  opts: Readonly<Record<string, unknown>> | undefined,
  who: string,
): Material {
  if (typeof values !== 'object' || values === null || Array.isArray(values)) throw new Error(`${who}: give a column and a value, or a record { column: value }`);
  const names = Object.keys(values);
  const reserved = domain === 'points' ? RESERVED_POINT_FIELDS : RESERVED_EDGE_FIELDS;
  for (const name of names) {
    if (reserved.includes(name)) throw new Error(`${who}: '${name}' is a reserved field of ${domain === 'points' ? 'a point' : 'an edge'}, not a column`);
    const v = values[name];
    if (typeof v !== 'number' && typeof v !== 'function') throw new Error(`${who}: the value of '${name}' is a number or a function of the row — got ${typeof v}`);
  }
  const transfer = declaredTransfer(opts, domain, names, who);
  // A write that reaches no row still declares its policy: the declaration
  // is about the column, not about the rows it writes.
  if (rows !== null && rows.length === 0 && transfer === undefined) return m;
  const p = partsOf(m);
  const count = domain === 'points' ? m.n : m.edgeCount;
  const cols = domain === 'points' ? p.attrs : p.edgeAttrs;
  // A column the write names for the first time is declared, 0 elsewhere;
  // `x` and `y` are the position columns. Each is written through a writer
  // that copies only the leaves the rows fall in.
  const reach = rows === null ? 'all' : rows;
  const writers = names.map((name) => {
    if (domain === 'points' && name === 'x') return p.x.writer(reach);
    if (domain === 'points' && name === 'y') return p.y.writer(reach);
    return (cols[name] ?? Column.zeros(Float64Array, count)).writer(reach);
  });
  const fns = names.map((name) => values[name]);
  const anyFn = fns.some((f) => typeof f === 'function');
  const passed = rows === null ? count : rows.length;
  const view = (anyFn ? (domain === 'points' ? vertexReader(m, passed) : edgeReader(m, passed)) : null) as ((i: number) => V) | null;
  if (rows === null) writeEvery(count, fns, view, writers.map((w) => w.array()!));
  else writeSome(rows, fns, view, writers);
  names.forEach((name, k) => {
    const done = writers[k].done();
    if (domain === 'points' && name === 'x') p.x = done;
    else if (domain === 'points' && name === 'y') p.y = done;
    else cols[name] = done;
  });
  if (transfer === undefined) return make(m, p);
  // Setting a value keeps a column's declared policy; declaring the default
  // restores it, which is stored as no entry at all.
  const policies: Record<string, string> = domain === 'points' ? { ...m.transfers } : { ...m.edgeTransfers };
  const fallback = domain === 'points' ? 'interpolate' : 'copy';
  for (const name of names) {
    if (transfer === fallback) delete policies[name];
    else policies[name] = transfer;
  }
  return domain === 'points'
    ? make(m, p, { transfers: policies as Record<string, TransferPolicy> })
    : make(m, p, { edgeTransfers: policies as Record<string, EdgeTransfer> });
}

/** A write over every row: each column's new array written directly. */
function writeEvery<V>(count: number, fns: readonly ColumnValue<V>[], view: ((i: number) => V) | null, outs: readonly Float64Array[]): void {
  for (let i = 0; i < count; i++) {
    const v = view === null ? (undefined as V) : view(i);
    for (let k = 0; k < fns.length; k++) {
      const f = fns[k];
      const value = typeof f === 'number' ? f : f(v);
      if (Number.isFinite(value)) outs[k][i] = value;
    }
  }
}

/** A write over some rows: each through its column's writer, which copies
 * only the leaves the rows fall in. */
function writeSome<V>(rows: readonly number[], fns: readonly ColumnValue<V>[], view: ((i: number) => V) | null, writers: readonly ColumnWriter<Float64Array>[]): void {
  for (const i of rows) {
    const v = view === null ? (undefined as V) : view(i);
    for (let k = 0; k < fns.length; k++) {
      const f = fns[k];
      const value = typeof f === 'number' ? f : f(v);
      if (Number.isFinite(value)) writers[k].set(i, value);
    }
  }
}

/** A plain record — never a `where`: a `where` is a selection, a value, a
 * view or a function, and none of those is a plain object. */
const isOptionsRecord = (v: unknown): v is Readonly<Record<string, unknown>> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/** @internal `set` arguments, read: the values, whether a `where` was given
 * at all (an `undefined` one is nothing), and the options record. A plain
 * record in the `where` place is the options, so `set(col, v, opts)` needs
 * no `undefined` between them. */
function readSet<V>(args: readonly unknown[], who: string): { values: Record<string, ColumnValue<V>>; given: boolean; where: unknown; opts: Readonly<Record<string, unknown>> | undefined } {
  let values: Record<string, ColumnValue<V>>;
  let rest: readonly unknown[];
  if (typeof args[0] === 'string') {
    if (args.length < 2) throw new Error(`${who}: '${args[0]}' needs a value — a number, or a function of the row`);
    values = { [args[0]]: args[1] as ColumnValue<V> };
    rest = args.slice(2);
  } else {
    values = args[0] as Record<string, ColumnValue<V>>;
    rest = args.slice(1);
  }
  if (rest.length > 0 && isOptionsRecord(rest[0])) {
    if (rest.length > 1) throw new Error(`${who}: the options record { transfer } comes last, after the where`);
    return { values, given: false, where: undefined, opts: rest[0] };
  }
  if (rest.length > 1 && rest[1] !== undefined && !isOptionsRecord(rest[1])) throw new Error(`${who}: the last argument is the options record { transfer } — got ${describe(rest[1])}`);
  if (rest.length > 2) throw new Error(`${who}: a write takes a value, a where and an options record — got ${rest.length + 1} arguments after the column`);
  return { values, given: rest.length > 0, where: rest[0], opts: rest[1] as Readonly<Record<string, unknown>> | undefined };
}

// ---- the writes, as the selections answer them --------------------------------------

/**
 * `points.add`: one point, or a list, with the new rows' columns. A
 * position makes a row with a new id. A point value or a view makes the row
 * it names, with its id and its own columns (`cols` gives the others); one
 * the geometry holds already is skipped.
 */
export function addPoints(m: Material, at: XY | PointEnd | Iterable<XY | PointEnd> | undefined, cols: Readonly<Record<string, number>> = {}): Material {
  const who = 'points.add';
  if (at === undefined || at === null) return m;
  const one = isPosition(at) || isPointValue(at) || viewKind(at) === 'vertex';
  if (!one && typeof (at as Iterable<unknown>)[Symbol.iterator] !== 'function') throw new Error(`${who}: expected a point — a position, a point value or a view — or a list of them; got ${describe(at)}`);
  const list: readonly unknown[] = one ? [at] : [...(at as Iterable<unknown>)];
  const xs: number[] = [];
  const ys: number[] = [];
  const records: Record<string, number>[] = [];
  const ids: number[] = [];
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
      records.push(cols);
      ids.push(NaN);
    } else {
      throw new Error(`${who}: expected a point — a position, a point value or a view — or a list of them; got ${describe(q)}`);
    }
  }
  return addPointRows(m, xs, ys, records, ids, who);
}

/** `points.remove`: the rows, and every edge row that names one of them. */
export function removePoints(m: Material, what: unknown): Material {
  return removePointRows(m, pointRowsOf(m, what, 'points.remove'));
}

/** `points.set`, over `members` (null: the whole table). */
export function setPoints(m: Material, members: readonly number[] | null, args: readonly unknown[]): Material {
  const who = 'points.set';
  const { values, given, where, opts } = readSet<Vertex>(args, who);
  const rows = whereOf(m, members, m.n, vertexReader, given, where, pointRowsOf, who);
  return setRows(m, 'points', values, rows, opts, who);
}

/** One edge row a write asks for: its ends, the id it names (NaN: mint
 * one), and its own columns. */
interface EdgeAsk {
  readonly a: unknown;
  readonly b: unknown;
  readonly id: number;
  readonly cols: Readonly<Record<string, number>>;
}

/** The edge rows `edges.add` is asked for: one pair `[a, b]`, one edge
 * value or view, or a list of them. */
function edgeAsks(rows: unknown, who: string): EdgeAsk[] {
  if (rows === undefined || rows === null) return [];
  const asEdge = (r: unknown): EdgeAsk | null => {
    if (isEdgeValue(r)) return { a: r.a, b: r.b, id: r.id, cols: columnsOf(r, []) };
    if (viewKind(r) === 'edge') {
      const e = r as Edge;
      const owner = ownerOfView(e);
      return { a: e.a, b: e.b, id: e.id, cols: owner instanceof Material ? edgeColumns(owner, e.index) : {} };
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
  if (rows.length === 2 && (endLike(rows[0]) || endLike(rows[1]))) return [{ a: rows[0], b: rows[1], id: NaN, cols: {} }];
  const out: EdgeAsk[] = [];
  for (const r of rows) {
    if (r === undefined || r === null) continue;
    const e = asEdge(r);
    if (e) out.push(e);
    else if (isPosition(r)) throw referenceError(who, r);
    else if (Array.isArray(r) && r.length === 2) out.push({ a: r[0], b: r[1], id: NaN, cols: {} });
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
  cols: readonly Readonly<Record<string, number>>[],
  roots: readonly number[] | null,
  who: string,
  ids: readonly number[] | null = null,
): Material {
  const declared = m.edgeAttrNames;
  const already = existingPairs(m, pairs);
  const seen = new Set<number>();
  const held = new Set<number>();
  const keep: number[] = [];
  const records: Record<string, number>[] = [];
  const extra = new Set<string>();
  for (let k = 0; k < pairs.length; k++) {
    const [a, b] = pairs[k];
    if (a < 0 || b < 0 || a === b) continue;
    const key = pairKey(a, b);
    if (already[k] === 1 || seen.has(key)) continue;
    const id = ids === null ? NaN : ids[k];
    if (!Number.isNaN(id) && (held.has(id) || m.rowOfEdge(id as EdgeId) >= 0)) continue;
    const given = withAbsentEdge({ ...cols[k] }, declared);
    checkNewRowColumns(given, declared, RESERVED_EDGE_FIELDS, 'a new edge', who);
    if (!finiteRecord(given)) continue;
    for (const name in given) if (!declared.includes(name)) extra.add(name);
    seen.add(key);
    if (!Number.isNaN(id)) held.add(id);
    keep.push(k);
    records.push(given);
  }
  if (keep.length === 0) return m;
  const p = partsOf(m);
  const ends: number[] = [];
  for (const k of keep) ends.push(pairs[k][0], pairs[k][1]);
  p.edgeList = p.edgeList.append(ends);
  for (const name of extra) p.edgeAttrs[name] = Column.zeros(Float64Array, m.edgeCount);
  for (const name in p.edgeAttrs) p.edgeAttrs[name] = p.edgeAttrs[name].append(records.map((r) => r[name] ?? 0));
  const given = keep.map((k) => (ids === null ? NaN : ids[k]));
  const minted = mintIds(given.filter((id) => Number.isNaN(id)).length);
  let next = 0;
  const rowIds = given.map((id) => (Number.isNaN(id) ? minted[next++] : id));
  p.edgeIds = p.edgeIds.append(rowIds);
  p.edgeRoots = p.edgeRoots.append(keep.map((k, j) => (roots !== null && roots[k] >= 0 ? roots[k] : rowIds[j])));
  return make(m, p);
}

/**
 * `edges.add`: one pair `[a, b]` of point values or views, one edge value
 * or view, or a list of them, with the new rows' columns. An edge value
 * makes the row it names, with its id and its own columns (`cols` gives
 * the others).
 */
export function addEdges(m: Material, rows: unknown, cols: Readonly<Record<string, number>> = {}): Material {
  const who = 'edges.add';
  const asks = edgeAsks(rows, who);
  const pairs = asks.map(({ a, b }) => [pointRow(m, a, who), pointRow(m, b, who)] as const);
  return addEdgeRows(m, pairs, asks.map((e) => ({ ...cols, ...e.cols })), null, who, asks.map((e) => e.id));
}

/** @internal Remove edge rows; their points stay. */
export function removeEdgeRows(m: Material, rows: readonly number[]): Material {
  if (rows.length === 0) return m;
  const gone = new Set(rows);
  const edges: number[] = [];
  for (let e = 0; e < m.edgeCount; e++) if (!gone.has(e)) edges.push(e);
  return make(m, keepRows(m, null, edges, null));
}

/** `edges.remove`: the rows; their points stay. */
export function removeEdges(m: Material, what: unknown): Material {
  return removeEdgeRows(m, edgeRowsOf(m, what, 'edges.remove'));
}

/** `edges.set`, over `members` (null: the whole table). */
export function setEdges(m: Material, members: readonly number[] | null, args: readonly unknown[]): Material {
  const who = 'edges.set';
  const { values, given, where, opts } = readSet<Edge>(args, who);
  const rows = whereOf(m, members, m.edgeCount, edgeReader, given, where, edgeRowsOf, who);
  return setRows(m, 'edges', values, rows, opts, who);
}

// ---- the face write ------------------------------------------------------------------

/** The face rows `where` names among `members`, in the members' order. */
function faceRowsWhere(sel: Selection<Face>, members: readonly number[], where: unknown, who: string): number[] {
  if (where === undefined || where === null) return [];
  let rows: readonly number[];
  if (typeof where === 'function') {
    const pick = where as (f: Face) => unknown;
    return members.filter((f) => pick(sel.domain.row(f)));
  }
  if (where instanceof Selection) {
    rows = sel.operand(where, 'set');
  } else if (viewKind(where) === 'face') {
    const row = sel.domain.rowOf(where, who);
    rows = row < 0 ? [] : [row];
  } else {
    throw new Error(`${who}: a where is a face selection, one face, or a test of the face — got ${describe(where)}`);
  }
  const named = new Set(rows);
  return members.filter((r) => named.has(r));
}

/** A face column's options, checked. */
function faceOptions(opts: Readonly<Record<string, unknown>> | undefined, who: string): { transfer?: FaceTransfer; fallback?: number; clearsFallback: boolean } {
  if (opts === undefined) return { clearsFallback: false };
  for (const key of Object.keys(opts)) {
    if (key !== 'transfer' && key !== 'fallback') throw new Error(`${who}: unknown option '${key}' — the options record of a face write is { transfer, fallback }`);
  }
  const t = opts.transfer;
  if (t !== undefined && t !== 'nearest' && t !== 'drop') throw new Error(`${who}: transfer is 'nearest' or 'drop' — got ${typeof t === 'string' ? `'${t}'` : typeof t}`);
  const f = opts.fallback;
  if (f !== undefined && (typeof f !== 'number' || !Number.isFinite(f))) throw new Error(`${who}: fallback is a finite number — got ${String(f)}`);
  return { transfer: t as FaceTransfer | undefined, fallback: f as number | undefined, clearsFallback: 'fallback' in opts && f === undefined };
}

/**
 * @internal `faces.set`, over the faces `sel` holds: the columns keyed by
 * wall lineage. Every face of the state keeps what it carries of a column
 * (its own value, or the one it inherited) and the faces written take
 * their new values, all read from the faces as they were; the column is
 * then written against THIS state's faces, so only a face that appears
 * later inherits. A value that is not finite leaves that face as it was.
 */
export function writeFaces(sel: Selection<Face>, args: readonly unknown[]): Material {
  const who = 'faces.set';
  const { values, given, where, opts } = readSet<Face>(args, who);
  if (typeof values !== 'object' || values === null || Array.isArray(values)) throw new Error(`${who}: give a column and a value, or a record { column: value }`);
  const names = Object.keys(values);
  for (const name of names) {
    if (RESERVED_FACE_FIELDS.includes(name)) throw new Error(`${who}: '${name}' is a reserved field of a face, not a column`);
    const v = values[name];
    if (typeof v !== 'number' && typeof v !== 'function') throw new Error(`${who}: the value of '${name}' is a number or a function of the face — got ${typeof v}`);
  }
  const face = faceOptions(opts, who);
  const cells = faceTableOf(sel);
  const rows = given ? faceRowsWhere(sel, sel.indices, where, who) : sel.indices;
  if (rows.length === 0 && opts === undefined) return sel.source as Material;
  const views = cells.faces;
  // Every value is worked out before any lands: one instant.
  const written: Record<string, number[]> = {};
  for (const name of names) {
    const v = values[name];
    written[name] = rows.map((f) => (typeof v === 'number' ? v : v(views[f])));
  }
  return writeFaceColumns(cells, rows, written, false, face);
}

/**
 * @internal Face columns written onto faces `rows` of `cells`, the values
 * by position in `rows`: the one door every face write goes through. With
 * `keepNaN` a value that is not finite is written as it is — a
 * measurement that has no answer for a face says so — and otherwise it
 * leaves that face as it was. The faces keep their statement: a column
 * write touches no edge.
 */
export function writeFaceColumns(
  cells: FaceTable,
  rows: readonly number[],
  columns: Readonly<Record<string, ArrayLike<number>>>,
  keepNaN: boolean,
  face: { transfer?: FaceTransfer; fallback?: number; clearsFallback: boolean } = { clearsFallback: false },
): Material {
  const m = cells.source;
  const keys = cells.keys();
  const next: Record<string, FaceColumn> = { ...m.faceAttrs };
  for (const name of Object.keys(columns)) {
    if (RESERVED_FACE_FIELDS.includes(name)) throw new Error(`faces.set: '${name}' is a reserved field of a face, not a column`);
    const values = columns[name];
    const was = m.faceAttrs[name];
    const map = new Map<string, number>();
    const held = cells.carried.get(name);
    if (held) held.forEach((v, f) => { if (v !== undefined) map.set(keys[f], v); });
    rows.forEach((f, i) => { if (keepNaN || Number.isFinite(values[i])) map.set(keys[f], values[i]); });
    next[name] = {
      values: map,
      transfer: face.transfer ?? was?.transfer ?? 'nearest',
      fallback: face.fallback !== undefined ? face.fallback : face.clearsFallback ? undefined : was?.fallback,
      seen: new Set(keys),
    };
  }
  return make(m, partsOf(m), { faceAttrs: next });
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
export function extrude(m: Material, from: PointEnd | undefined, offset: XY, cols: Readonly<Record<string, number>> = {}): Material {
  const who = 'extrude';
  // The new edge has no value for a declared edge column, and extrude has
  // no place to take one: that is the two table lines, written out.
  const owed = m.edgeAttrNames.filter((name) => !(name in EDGE_ABSENT));
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
  const withPoint = addPointRows(m, [q[0]], [q[1]], [cols], null, who);
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
  const rows = edgeRowsOf(m, edges, who);
  const names = m.attrNames;
  const { x: X, y: Y, attrs: A, edgeList: list, edgeRoots } = m.store;
  const cut: { e: number; t: number }[] = [];
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
    if (Number.isFinite(x) && Number.isFinite(y)) cut.push({ e, t });
  }
  if (cut.length === 0) return m;
  const xs: number[] = [];
  const ys: number[] = [];
  const cols: Record<string, number>[] = [];
  for (const { e, t } of cut) {
    const a = atU32(list, 2 * e);
    const b = atU32(list, 2 * e + 1);
    xs.push(at64(X, a) + (at64(X, b) - at64(X, a)) * t);
    ys.push(at64(Y, a) + (at64(Y, b) - at64(Y, a)) * t);
    // A point column crosses by its policy; the values at both ends are
    // finite, so the new one is too.
    const rec: Record<string, number> = {};
    for (const name of names) {
      const va = at64(A[name], a);
      const vb = at64(A[name], b);
      rec[name] = m.transfers[name] === 'nearest' ? (t <= 0.5 ? va : vb) : va + (vb - va) * t;
    }
    cols.push(rec);
  }
  const withPoints = addPointRows(m, xs, ys, cols, null, who);
  const without = removeEdgeRows(withPoints, cut.map((c) => c.e));
  const pairs: [number, number][] = [];
  const childCols: Record<string, number>[] = [];
  const roots: number[] = [];
  cut.forEach(({ e, t }, k) => {
    const a = atU32(list, 2 * e);
    const b = atU32(list, 2 * e + 1);
    const mid = m.n + k;
    const parent = edgeColumns(m, e);
    pairs.push([a, mid], [mid, b]);
    childCols.push(inheritEdge(m, parent, t), inheritEdge(m, parent, 1 - t));
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

/** @internal A child edge's columns: a `'copy'` column the parent's value, a
 * `'distribute'` one the parent's value times the child's share. */
export function inheritEdge(m: Material, parent: Readonly<Record<string, number>>, fraction: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name in parent) out[name] = m.edgeTransfers[name] === 'distribute' ? parent[name] * fraction : parent[name];
  return out;
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
  const rows = edgeRowsOf(m, edges, who);
  if (rows.length === 0) return m;
  const names = m.attrNames;
  const enames = m.edgeAttrNames;
  const landed = new Landing(m);
  const xs: number[] = [];
  const ys: number[] = [];
  const cols: Record<string, number>[] = [];
  // The replaced edge each new point and each new edge came from.
  const pointFrom: number[] = [];
  const edgeFrom = new Map<number, number>();
  const pairs: [number, number][] = [];
  const pairCols: Record<string, number>[] = [];
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
    gone.push(row);
    // A motif point stands between the edge's ends, so it takes their
    // columns the way a split point does.
    const inherit = (at: number): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const name of names) {
        const va = e.a[name];
        const vb = e.b[name];
        out[name] = m.transfers[name] === 'nearest' ? (at <= 0.5 ? va : vb) : va + (vb - va) * at;
      }
      return out;
    };
    const child = enames.length > 0 ? inheritEdge(m, edgeColumns(m, row), 1 / (local.length + 1)) : {};
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
        cols.push(inherit(local[k][0]));
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
  if (args.length > 0 && (last === undefined || last === null || last instanceof Selection || isPointValue(last) || viewKind(last) !== undefined)) {
    parts = args.slice(0, -1);
    rows = pointRowsOf(m, last, who);
  }
  if (parts.length === 0 || (rows !== null && rows.length === 0)) return m;
  const fns = parts.map((d, i): ((p: Vertex) => XY) => {
    if (isGraphForce(d)) return d.prepare(m);
    if (typeof d === 'function') return d as (p: Vertex) => XY;
    if (isPosition(d)) {
      const c: Vec = [vx(d), vy(d)];
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
  // Where row `i` lands, into `to`; false when its move is not finite.
  const to = new Float64Array(2);
  const view = vertexReader(m, rows === null ? m.n : rows.length);
  const shift = (i: number): boolean => {
    const v = view(i);
    const first = fns[0](v);
    let dx = vx(first);
    let dy = vy(first);
    for (let j = 1; j < fns.length; j++) {
      const d = fns[j](v);
      dx += vx(d);
      dy += vy(d);
    }
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;
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
  if (rows === null) {
    const ax = nx.array()!;
    const ay = ny.array()!;
    for (let i = 0; i < m.n; i++) {
      if (!shift(i)) continue;
      ax[i] = to[0];
      ay[i] = to[1];
    }
  } else {
    for (const i of rows) {
      if (!shift(i)) continue;
      nx.set(i, to[0]);
      ny.set(i, to[1]);
    }
  }
  p.x = nx.done();
  p.y = ny.done();
  return make(m, p);
}
