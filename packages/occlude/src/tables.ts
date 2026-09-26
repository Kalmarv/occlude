/**
 * Tables: a graph is two tables of rows with minted ids — points, and
 * edges whose rows name two point ids — and there are three writes on a
 * table: add a row, remove a row, set a column. Every verb is a few of
 * them. `g.points` and `g.edges` answer the three writes and return the new
 * material; `extrude`, `split` and `move` are recipes over them.
 *
 * The contract is the step batch's, said about one write: the call judges
 * the program and the table judges the data. A wrong program (an undeclared
 * column a new row leaves out, a reserved name, a selection of an unrelated
 * material, the wrong kind of member) throws. Data that cannot land is
 * skipped in silence: a write given nothing, an edge row naming a point
 * that is not there (`gone`), one point twice (`self`) or a pair that is
 * already an edge (`already`), and a value that is not finite.
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
 * name. Adding a value the geometry holds already is `already`, and a value
 * the geometry does not hold, used as a reference, is `gone`: both skip.
 */

import { Material, mintIds, withAbsentEdge, EDGE_ABSENT, RESERVED_EDGE_FIELDS, type Vertex, type Edge, type PointId, type EdgeId } from './material.js';
import { PointSelection, EdgeSelection, onState } from './relation.js';
import { isGraphForce, type GraphForce } from './forces.js';
import { vx, vy, type XY, type Vec } from './vec.js';
import { ownedBy, pairKey, viewKind } from './views.js';

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
export type PointWhere = PointSelection<unknown> | PointEnd | ((p: Vertex) => unknown) | undefined;
/** Which edge rows a `where` names, the same three ways. */
export type EdgeWhere = EdgeSelection<unknown> | EdgeEnd | ((e: Edge) => unknown) | undefined;

/** A column value: one number for every row, or one per row from its view. */
export type ColumnValue<V> = number | ((row: V) => number);

/** What a displacement in `move` may be: a vector, a function of the point
 * (and the step count), or a force that the move prepares from the graph. */
export type Displacement = XY | ((p: Vertex, k: number) => XY) | GraphForce;

/** The names a point view owns; `x` and `y` are columns a write may set. */
const RESERVED_POINT_FIELDS: readonly string[] = ['index', 'adjacent', 'edges', 'id'];

// ---- building a new state --------------------------------------------------------

interface Parts {
  x: Float64Array;
  y: Float64Array;
  attrs: Record<string, Float64Array>;
  pointIds: Float64Array;
  edgeList: Uint32Array;
  edgeAttrs: Record<string, Float64Array>;
  edgeIds: Float64Array;
  edgeRoots: Float64Array;
}

const copyCols = (cols: Readonly<Record<string, Float64Array>>): Record<string, Float64Array> => {
  const out: Record<string, Float64Array> = {};
  for (const k in cols) out[k] = Float64Array.from(cols[k]);
  return out;
};

/** Every column of `m`, copied: the parts a write starts from. */
function partsOf(m: Material): Parts {
  return {
    x: Float64Array.from(m.x),
    y: Float64Array.from(m.y),
    attrs: copyCols(m.attrs),
    pointIds: Float64Array.from(m.pointIds),
    edgeList: Uint32Array.from(m.edgeList),
    edgeAttrs: copyCols(m.edgeAttrs),
    edgeIds: Float64Array.from(m.edgeIds),
    edgeRoots: Float64Array.from(m.edgeRoots),
  };
}

/** The new state: `m`'s policies, face columns, space and iteration, with
 * these rows. */
function make(m: Material, p: Parts, carry: { iteration?: number; history?: readonly Material[] } = {}): Material {
  return new Material(p.x, p.y, p.attrs, p.edgeList, {
    iteration: carry.iteration ?? m.iteration,
    history: carry.history ?? [],
    edgeAttrs: p.edgeAttrs,
    transfers: { ...m.transfers },
    edgeTransfers: { ...m.edgeTransfers },
    ids: { points: p.pointIds, edges: p.edgeIds, edgeRoots: p.edgeRoots },
    faceAttrs: m.faceAttrs,
    space: m.space,
  });
}

/** @internal `m` at another iteration and with a history: what `t.steps`
 * hands on between steps and returns at the end. Every row carries. */
export function restamp(m: Material, iteration: number, history: readonly Material[] = []): Material {
  return make(m, partsOf(m), { iteration, history });
}

const concat = (a: Float64Array, b: readonly number[]): Float64Array => {
  const out = new Float64Array(a.length + b.length);
  out.set(a);
  for (let i = 0; i < b.length; i++) out[a.length + i] = b[i];
  return out;
};

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
function pointRow(m: Material, end: unknown, who: string): number {
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
function edgeRow(m: Material, e: unknown, who: string): number {
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
  if (v instanceof PointSelection) return 'a point selection';
  if (v instanceof EdgeSelection) return 'an edge selection';
  if (isPosition(v)) return Array.isArray(v) ? 'a position [x, y]' : 'a position { x, y }';
  if (Array.isArray(v)) return 'a list';
  return typeof v;
};

/** The point rows a selection or a member names in `m`, ascending. A
 * selection of an earlier state is read by identity; nothing is none. */
export function pointRowsOf(m: Material, what: unknown, who: string): number[] {
  if (what === undefined || what === null) return [];
  if (what instanceof PointSelection) {
    if (what.length === 0) return [];
    return [...onState({ source: m }, what, who).indices];
  }
  if (what instanceof EdgeSelection) throw new Error(`${who}: expected points — a point selection or a vertex — got an edge selection; its points are sel.points`);
  const row = pointRow(m, what, who);
  return row < 0 ? [] : [row];
}

/** The edge rows a selection or a member names in `m`, ascending. */
export function edgeRowsOf(m: Material, what: unknown, who: string): number[] {
  if (what === undefined || what === null) return [];
  if (what instanceof EdgeSelection) {
    if (what.length === 0) return [];
    return [...onState({ source: m }, what, who).indices];
  }
  if (what instanceof PointSelection) throw new Error(`${who}: expected edges — an edge selection or an edge — got a point selection; the edges among its points are sel.edges`);
  const row = edgeRow(m, what, who);
  return row < 0 ? [] : [row];
}

/** The rows `where` names among `members` (null: every row of `m`). */
function whereOf<V>(
  m: Material,
  members: readonly number[] | null,
  count: number,
  view: (i: number) => V,
  given: boolean,
  where: unknown,
  rowsOf: (m: Material, what: unknown, who: string) => number[],
  who: string,
): number[] | null {
  if (!given) return members === null ? null : [...members];
  if (typeof where === 'function') {
    const out: number[] = [];
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
  p.x = concat(m.x, keep.map((k) => xs[k]));
  p.y = concat(m.y, keep.map((k) => ys[k]));
  // A column a new row declares is 0 on every row that was already there.
  for (const name of extra) p.attrs[name] = new Float64Array(m.n);
  for (const name in p.attrs) p.attrs[name] = concat(p.attrs[name], keep.map((k) => cols[k][name]));
  const given = keep.map((k) => (ids === null ? NaN : ids[k]));
  const minted = mintIds(given.filter((id) => Number.isNaN(id)).length);
  let next = 0;
  p.pointIds = concat(m.pointIds, given.map((id) => (Number.isNaN(id) ? minted[next++] : id)));
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
  const edges: number[] = [];
  for (let e = 0; e < m.edgeCount; e++) if (!gone[m.edgeList[2 * e]] && !gone[m.edgeList[2 * e + 1]]) edges.push(e);
  return make(m, keepRows(m, survivors, edges, rowMap));
}

/** The parts of `m` holding only these point rows and edge rows. */
function keepRows(m: Material, points: readonly number[], edges: readonly number[], rowMap: Int32Array | null): Parts {
  const pick = (col: Float64Array, rows: readonly number[]) => Float64Array.from(rows, (r) => col[r]);
  const attrs: Record<string, Float64Array> = {};
  for (const name in m.attrs) attrs[name] = pick(m.attrs[name], points);
  const edgeAttrs: Record<string, Float64Array> = {};
  for (const name in m.edgeAttrs) edgeAttrs[name] = pick(m.edgeAttrs[name], edges);
  const list = new Uint32Array(edges.length * 2);
  edges.forEach((e, k) => {
    const a = m.edgeList[2 * e];
    const b = m.edgeList[2 * e + 1];
    list[2 * k] = rowMap ? rowMap[a] : a;
    list[2 * k + 1] = rowMap ? rowMap[b] : b;
  });
  return {
    x: pick(m.x, points),
    y: pick(m.y, points),
    attrs,
    pointIds: pick(m.pointIds, points),
    edgeList: list,
    edgeAttrs,
    edgeIds: pick(m.edgeIds, edges),
    edgeRoots: pick(m.edgeRoots, edges),
  };
}

/** @internal Set columns over `rows` (null: every row), one instant: every
 * callback reads `m` as it was. */
function setRows<V>(
  m: Material,
  domain: 'points' | 'edges',
  values: Readonly<Record<string, ColumnValue<V>>>,
  rows: readonly number[] | null,
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
  if (rows !== null && rows.length === 0) return m;
  const p = partsOf(m);
  const count = domain === 'points' ? m.n : m.edgeCount;
  const cols = domain === 'points' ? p.attrs : p.edgeAttrs;
  // A column the write names for the first time is declared, 0 elsewhere;
  // `x` and `y` are the position columns.
  const out = names.map((name) => {
    if (domain === 'points' && name === 'x') return p.x;
    if (domain === 'points' && name === 'y') return p.y;
    return (cols[name] ??= new Float64Array(count));
  });
  const fns = names.map((name) => values[name]);
  const anyFn = fns.some((f) => typeof f === 'function');
  const view = (i: number): V => (domain === 'points' ? m.vertex(i) : m.edge(i)) as V;
  const write = (i: number) => {
    const v = anyFn ? view(i) : (undefined as V);
    for (let k = 0; k < names.length; k++) {
      const f = fns[k];
      const value = typeof f === 'number' ? f : f(v);
      if (Number.isFinite(value)) out[k][i] = value;
    }
  };
  if (rows === null) for (let i = 0; i < count; i++) write(i);
  else for (const i of rows) write(i);
  return make(m, p);
}

/** @internal `points.set` / `edges.set` arguments, read: the values, and
 * whether a `where` was given at all (an `undefined` one is nothing). */
function readSet<V>(args: readonly unknown[], who: string): { values: Record<string, ColumnValue<V>>; given: boolean; where: unknown } {
  if (typeof args[0] === 'string') {
    if (args.length < 2) throw new Error(`${who}: '${args[0]}' needs a value — a number, or a function of the row`);
    return { values: { [args[0]]: args[1] as ColumnValue<V> }, given: args.length > 2, where: args[2] };
  }
  return { values: args[0] as Record<string, ColumnValue<V>>, given: args.length > 1, where: args[1] };
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
  const { values, given, where } = readSet<Vertex>(args, who);
  const rows = whereOf(m, members, m.n, (i) => m.vertex(i), given, where, pointRowsOf, who);
  return setRows(m, 'points', values, rows, who);
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
      return { a: e.a, b: e.b, id: e.id, cols: { ...e.attrs } };
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
  const seen = new Set<number>();
  for (let e = 0; e < m.edgeCount; e++) seen.add(pairKey(m.edgeList[2 * e], m.edgeList[2 * e + 1]));
  const held = new Set<number>();
  const keep: number[] = [];
  const records: Record<string, number>[] = [];
  const extra = new Set<string>();
  for (let k = 0; k < pairs.length; k++) {
    const [a, b] = pairs[k];
    if (a < 0 || b < 0 || a === b) continue;
    const key = pairKey(a, b);
    if (seen.has(key)) continue;
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
  const list = new Uint32Array(m.edgeList.length + 2 * keep.length);
  list.set(m.edgeList);
  keep.forEach((k, j) => {
    list[m.edgeList.length + 2 * j] = pairs[k][0];
    list[m.edgeList.length + 2 * j + 1] = pairs[k][1];
  });
  p.edgeList = list;
  for (const name of extra) p.edgeAttrs[name] = new Float64Array(m.edgeCount);
  for (const name in p.edgeAttrs) p.edgeAttrs[name] = concat(p.edgeAttrs[name], records.map((r) => r[name] ?? 0));
  const given = keep.map((k) => (ids === null ? NaN : ids[k]));
  const minted = mintIds(given.filter((id) => Number.isNaN(id)).length);
  let next = 0;
  const rowIds = given.map((id) => (Number.isNaN(id) ? minted[next++] : id));
  p.edgeIds = concat(m.edgeIds, rowIds);
  p.edgeRoots = concat(m.edgeRoots, keep.map((k, j) => (roots !== null && roots[k] >= 0 ? roots[k] : rowIds[j])));
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
  const all = Array.from({ length: m.n }, (_, i) => i);
  return make(m, keepRows(m, all, edges, null));
}

/** `edges.remove`: the rows; their points stay. */
export function removeEdges(m: Material, what: unknown): Material {
  return removeEdgeRows(m, edgeRowsOf(m, what, 'edges.remove'));
}

/** `edges.set`, over `members` (null: the whole table). */
export function setEdges(m: Material, members: readonly number[] | null, args: readonly unknown[]): Material {
  const who = 'edges.set';
  const { values, given, where } = readSet<Edge>(args, who);
  const rows = whereOf(m, members, m.edgeCount, (e) => m.edge(e), given, where, edgeRowsOf, who);
  return setRows(m, 'edges', values, rows, who);
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
  const q: Vec = sp ? sp.exp([m.x[row], m.y[row]], [dx, dy]) : [m.x[row] + dx, m.y[row] + dy];
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
 * edge.
 */
export function split(m: Material, edges: unknown, at: number | ((e: Edge) => number) = 0.5): Material {
  const who = 'split';
  if (typeof at !== 'number' && typeof at !== 'function') throw new Error(`${who}: at is a number along the edge, or a function of the edge — got ${typeof at}`);
  const rows = edgeRowsOf(m, edges, who);
  const names = m.attrNames;
  const enames = m.edgeAttrNames;
  const cut: { e: number; t: number }[] = [];
  for (const e of rows) {
    const t = typeof at === 'number' ? at : at(m.edge(e));
    if (!Number.isFinite(t)) continue;
    const a = m.edgeList[2 * e];
    const b = m.edgeList[2 * e + 1];
    const x = m.x[a] + (m.x[b] - m.x[a]) * t;
    const y = m.y[a] + (m.y[b] - m.y[a]) * t;
    if (Number.isFinite(x) && Number.isFinite(y)) cut.push({ e, t });
  }
  if (cut.length === 0) return m;
  const xs: number[] = [];
  const ys: number[] = [];
  const cols: Record<string, number>[] = [];
  for (const { e, t } of cut) {
    const a = m.edgeList[2 * e];
    const b = m.edgeList[2 * e + 1];
    xs.push(m.x[a] + (m.x[b] - m.x[a]) * t);
    ys.push(m.y[a] + (m.y[b] - m.y[a]) * t);
    // A point column crosses by its policy; the values at both ends are
    // finite, so the new one is too.
    const rec: Record<string, number> = {};
    for (const name of names) {
      const va = m.attrs[name][a];
      const vb = m.attrs[name][b];
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
    const a = m.edgeList[2 * e];
    const b = m.edgeList[2 * e + 1];
    const mid = m.n + k;
    const parent: Record<string, number> = {};
    for (const name of enames) parent[name] = m.edgeAttrs[name][e];
    pairs.push([a, mid], [mid, b]);
    childCols.push(share(m, parent, t), share(m, parent, 1 - t));
    roots.push(m.edgeRoots[e], m.edgeRoots[e]);
  });
  return addEdgeRows(without, pairs, childCols, roots, who);
}

/** A child edge's columns: a `'copy'` column the parent's value, a
 * `'distribute'` one the parent's value times the child's share. */
function share(m: Material, parent: Readonly<Record<string, number>>, fraction: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name in parent) out[name] = m.edgeTransfers[name] === 'distribute' ? parent[name] * fraction : parent[name];
  return out;
}

/**
 * `g.move(...displacements, where?)`: every point of `where` (default all)
 * moved by the SUM of the displacements, in one instant — each is read on
 * the graph as it was. A displacement is a vector, a function of the point
 * `(p, k) => [dx, dy]` (`k` is the material's iteration, which is how
 * `force.drift` turns), or a force such as `force.tension({ rest })`, which
 * the move prepares from the graph once. A trailing selection, point value
 * or vertex says which points move. A move that is not
 * finite skips that point. In a curved space the point walks the geodesic.
 */
export function move(m: Material, args: readonly unknown[]): Material {
  const who = 'move';
  let parts = args;
  let rows: number[] | null = null;
  const last = args[args.length - 1];
  if (args.length > 0 && (last === undefined || last === null || last instanceof PointSelection || last instanceof EdgeSelection || isPointValue(last) || viewKind(last) !== undefined)) {
    parts = args.slice(0, -1);
    rows = pointRowsOf(m, last, who);
  }
  if (parts.length === 0 || (rows !== null && rows.length === 0)) return m;
  const k = m.iteration;
  const fns = parts.map((d, i): ((p: Vertex) => XY) => {
    if (isGraphForce(d)) {
      const f = d.prepare(m);
      return (p) => f(p, k);
    }
    if (typeof d === 'function') return (p) => (d as (p: Vertex, k: number) => XY)(p, k);
    if (isPosition(d)) {
      const c: Vec = [vx(d), vy(d)];
      return () => c;
    }
    throw new Error(`${who}: displacement ${i + 1} is ${describe(d)} — give a vector, a function of the point, or a force; which points move is the last argument`);
  });
  const p = partsOf(m);
  const sp = m.space !== undefined && m.space.kind !== 'euclidean' ? m.space : null;
  const step = (i: number) => {
    const v = m.vertex(i);
    const first = fns[0](v);
    let dx = vx(first);
    let dy = vy(first);
    for (let j = 1; j < fns.length; j++) {
      const d = fns[j](v);
      dx += vx(d);
      dy += vy(d);
    }
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    if (sp) {
      const q = sp.exp([m.x[i], m.y[i]], [dx, dy]);
      p.x[i] = q[0];
      p.y[i] = q[1];
    } else {
      p.x[i] = m.x[i] + dx;
      p.y[i] = m.y[i] + dy;
    }
  };
  if (rows === null) for (let i = 0; i < m.n; i++) step(i);
  else for (const i of rows) step(i);
  return make(m, p);
}

// ---- selections ----------------------------------------------------------------------

/** @internal `sel.without(x)`: the members that `x` does not name. */
export function withoutRows(m: Material, members: readonly number[], what: unknown, domain: 'points' | 'edges'): number[] {
  const rows = domain === 'points' ? pointRowsOf(m, what, 'without') : edgeRowsOf(m, what, 'without');
  if (rows.length === 0) return [...members];
  const out = new Set(rows);
  return members.filter((r) => !out.has(r));
}

/** @internal A member position read from the end when negative. */
export const fromEnd = (i: number, length: number): number => (i < 0 ? length + i : i);
