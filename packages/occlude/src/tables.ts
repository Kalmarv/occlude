/**
 * Tables: a graph is two tables of rows with minted ids — points, and
 * edges whose rows name two point ids — and there are three writes on a
 * table: add a row, remove a row, set a column. Faces are a third domain
 * with one write, `set`: a face is not a row, so its columns are keyed by
 * the walls it is made of. Every verb is a few of these writes.
 * `g.points`, `g.edges` and `g.faces()` answer them and return the new
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

import { Material, mintIds, withAbsentEdge, EDGE_ABSENT, RESERVED_EDGE_FIELDS, RESERVED_FACE_FIELDS, type Vertex, type Edge, type PointId, type EdgeId, type TransferPolicy, type EdgeTransfer, type FaceTransfer, type FaceColumn } from './material.js';
import { PointSelection, EdgeSelection, onState } from './relation.js';
import { FaceSelection, type Face } from './faces.js';
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
 * of `faces().set`. */
export interface FaceSetOpts { readonly transfer?: FaceTransfer; readonly fallback?: number }

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

/** What a write hands on besides the rows: by default `m`'s own. */
interface Carry {
  iteration?: number;
  history?: readonly Material[];
  transfers?: Record<string, TransferPolicy>;
  edgeTransfers?: Record<string, EdgeTransfer>;
  faceAttrs?: Record<string, FaceColumn>;
}

/** The new state: `m`'s policies, face columns, space and iteration, with
 * these rows. */
function make(m: Material, p: Parts, carry: Carry = {}): Material {
  return new Material(p.x, p.y, p.attrs, p.edgeList, {
    iteration: carry.iteration ?? m.iteration,
    history: carry.history ?? [],
    edgeAttrs: p.edgeAttrs,
    transfers: carry.transfers ?? { ...m.transfers },
    edgeTransfers: carry.edgeTransfers ?? { ...m.edgeTransfers },
    ids: { points: p.pointIds, edges: p.edgeIds, edgeRoots: p.edgeRoots },
    faceAttrs: carry.faceAttrs ?? m.faceAttrs,
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
  const rows = whereOf(m, members, m.n, (i) => m.vertex(i), given, where, pointRowsOf, who);
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
  const { values, given, where, opts } = readSet<Edge>(args, who);
  const rows = whereOf(m, members, m.edgeCount, (e) => m.edge(e), given, where, edgeRowsOf, who);
  return setRows(m, 'edges', values, rows, opts, who);
}

// ---- the face write ------------------------------------------------------------------

/** The face rows `where` names among `members`, ascending. */
function faceRowsWhere(sel: FaceSelection<unknown>, members: readonly number[], where: unknown, who: string): number[] {
  const cells = sel.collection;
  if (where === undefined || where === null) return [];
  let rows: readonly number[];
  if (typeof where === 'function') {
    const pick = where as (f: Face) => unknown;
    return members.filter((f) => pick(cells.faces[f]));
  }
  if (where instanceof FaceSelection) {
    rows = where.collection === cells ? where.indices : where.in(sel.source).indices;
  } else if (viewKind(where) === 'face') {
    const f = where as Face;
    const row = ownedBy(f, cells) ? f.index : cells.rowOfFace(f.id);
    rows = row < 0 ? [] : [row];
  } else {
    throw new Error(`${who}: a where is a face selection, one face, or a test of the face — got ${describe(where)}`);
  }
  const inside = new Set(members);
  return rows.filter((r) => inside.has(r));
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
 * @internal `faces().set`, over the faces `sel` holds: the columns keyed by
 * wall lineage. Every face of the state keeps what it carries of a column
 * (its own value, or the one it inherited) and the faces written take
 * their new values, all read from the faces as they were; the column is
 * then written against THIS state's faces, so only a face that appears
 * later inherits.
 */
export function writeFaces(sel: FaceSelection<unknown>, args: readonly unknown[]): Material {
  const who = 'faces.set';
  const { values, given, where, opts } = readSet<Face>(args, who);
  if (typeof values !== 'object' || values === null || Array.isArray(values)) throw new Error(`${who}: give a column and a value, or a record { column: value }`);
  const names = Object.keys(values);
  for (const name of names) {
    if (RESERVED_FACE_FIELDS.includes(name)) throw new Error(`${who}: '${name}' is a reserved field of a face, not a column`);
    const v = values[name];
    if (typeof v !== 'number' && typeof v !== 'function') throw new Error(`${who}: the value of '${name}' is a number or a function of the face — got ${typeof v}`);
  }
  const { transfer, fallback, clearsFallback } = faceOptions(opts, who);
  const m = sel.source;
  const cells = sel.collection;
  const rows = given ? faceRowsWhere(sel, sel.indices, where, who) : sel.indices;
  if (rows.length === 0 && opts === undefined) return m;
  const keys = cells.keys();
  const views = cells.faces;
  // Every value is worked out before any lands: one instant.
  const written = names.map((name) => {
    const v = values[name];
    return rows.map((f) => (typeof v === 'number' ? v : v(views[f])));
  });
  const next: Record<string, FaceColumn> = { ...m.faceAttrs };
  names.forEach((name, k) => {
    const was = m.faceAttrs[name];
    const map = new Map<string, number>();
    const held = cells.carried.get(name);
    if (held) held.forEach((v, f) => { if (v !== undefined) map.set(keys[f], v); });
    rows.forEach((f, i) => { if (Number.isFinite(written[k][i])) map.set(keys[f], written[k][i]); });
    next[name] = {
      values: map,
      transfer: transfer ?? was?.transfer ?? 'nearest',
      fallback: fallback !== undefined ? fallback : clearsFallback ? undefined : was?.fallback,
      seen: new Set(keys),
    };
  });
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
 * edge, and one outside 0…1 is read as the nearer end, where a cut makes
 * nothing.
 */
export function split(m: Material, edges: unknown, at: number | ((e: Edge) => number) = 0.5): Material {
  const who = 'split';
  if (typeof at !== 'number' && typeof at !== 'function') throw new Error(`${who}: at is a number along the edge, or a function of the edge — got ${typeof at}`);
  const rows = edgeRowsOf(m, edges, who);
  const names = m.attrNames;
  const enames = m.edgeAttrNames;
  const cut: { e: number; t: number }[] = [];
  for (const e of rows) {
    const asked = typeof at === 'number' ? at : at(m.edge(e));
    if (!Number.isFinite(asked)) continue;
    // A place past an end is read as that end, and a cut at an end cuts
    // nothing: the end is already a point.
    const t = Math.min(Math.max(asked, 0), 1);
    if (t === 0 || t === 1) continue;
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
    childCols.push(inheritEdge(m, parent, t), inheritEdge(m, parent, 1 - t));
    roots.push(m.edgeRoots[e], m.edgeRoots[e]);
  });
  return addEdgeRows(without, pairs, childCols, roots, who);
}

/** A child edge's columns: a `'copy'` column the parent's value, a
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
    let shortest = Infinity;
    for (let e = 0; e < m.edgeCount; e++) {
      const a = m.edgeList[2 * e];
      const b = m.edgeList[2 * e + 1];
      const d = Math.hypot(m.x[b] - m.x[a], m.y[b] - m.y[a]);
      if (d > 0 && d < shortest) shortest = d;
    }
    this.size = Number.isFinite(shortest) ? shortest : 1;
    for (let i = 0; i < m.n; i++) this.add(m.x[i], m.y[i], i);
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
  const chains = motif.curves();
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
  const pairs: [number, number][] = [];
  const pairCols: Record<string, number>[] = [];
  const gone: number[] = [];
  for (const row of rows) {
    const e = m.edge(row);
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
    const child = enames.length > 0 ? inheritEdge(m, e.attrs, 1 / (local.length + 1)) : {};
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
        landed.add(x, y, at);
      }
      if (at !== from) {
        pairs.push([from, at]);
        pairCols.push(child);
      }
      from = at;
    });
    if (from !== e.b.index) {
      pairs.push([from, e.b.index]);
      pairCols.push(child);
    }
  }
  if (gone.length === 0) return m;
  const withPoints = addPointRows(removeEdgeRows(m, gone), xs, ys, cols, null, who);
  return addEdgeRows(withPoints, pairs, pairCols, null, who);
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
  if (args.length > 0 && (last === undefined || last === null || last instanceof PointSelection || last instanceof EdgeSelection || isPointValue(last) || viewKind(last) !== undefined)) {
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
