/**
 * Geometry collections and selections over a material, and relational
 * measures.
 *
 * `m.points` and `m.edges` are collections: iterable, with `length`,
 * `at(i)`, `map` (an ordinary array out), `find`, `some`, `every`,
 * `forEach`, `filter` and `groupBy`. `filter` returns a SELECTION — the
 * same kind of collection, bound to the same source state, holding the
 * rows the predicate picked in source order — so a selection filters
 * again, iterates, maps and groups exactly like the whole. Nothing is
 * copied or changed: views are the source's own views (same row numbers,
 * same ownership). Independent material is made on purpose with
 * `extract()`. Two selections combine only when they share the domain
 * and the exact source state — equal row numbers in different states are
 * not identities.
 *
 * `groupBy(classifier)` splits a collection into selections by key: an
 * ordinary array of selections in first-occurrence order, rows in source
 * order, keys compared as a Map compares them, each selection carrying
 * its `key`. The key describes the classification that made the group;
 * it is written into no column and follows no later state.
 *
 * Relational measures reuse what exists: `connectedPoints` is adjacency,
 * `components` is one prepared topological pass, `meanBy` the scalar
 * reduction; distances come from `query.edges`, spatial neighbourhoods
 * from `neighbours`.
 */

import { Material, geodesicEdges, ownedBy, viewKind, type Curve, type Edge, type Vertex } from './material.js';
import { degreesWithin, walkChains } from './chains.js';
import { thicken as thickenKernel, type ThickenOpts } from './thicken.js';

// Domain comes from the view's own marker, never from attribute names.
const isEdgeView = (v: unknown): v is Edge => viewKind(v) === 'edge';
const isVertexView = (v: unknown): v is Vertex => viewKind(v) === 'vertex';

/** Rows in source order, deduplicated. */
function rowsOf(indices: Iterable<number>): readonly number[] {
  return Object.freeze(Array.from(new Set(indices)).sort((p, q) => p - q));
}

const viewName = (kind: 'vertex' | 'edge' | 'face'): string => (kind === 'edge' ? 'an edge view' : `a ${kind} view`);

/** The source rows `rows` was handed. A view names its own row; a view of
 * another state, or of the other kind, is refused by name. */
function sourceRows<V extends { index: number }>(rows: number | V | Iterable<number | V>, source: Material, kind: 'vertex' | 'edge', what: string): number[] {
  const one = (r: number | V): number => {
    if (typeof r === 'number') return r;
    const k = viewKind(r);
    if (k !== kind) throw new Error(`${what}: expected a row index or ${viewName(kind)}, got ${k === undefined ? typeof r : viewName(k)}`);
    if (!ownedBy(r as object, source)) throw new Error(`${what}: that ${kind} view belongs to another material`);
    return r.index;
  };
  if (typeof rows === 'number' || viewKind(rows) !== undefined) return [one(rows as number | V)];
  if (rows == null || typeof (rows as Iterable<unknown>)[Symbol.iterator] !== 'function') throw new Error(`${what}: expected a row index, a view, or a list of them`);
  return Array.from(rows as Iterable<number | V>, one);
}

/** Two selections of one state holding exactly the same rows: the test
 * `pairs` uses to decide that a pair is unordered. */
function sameMembers(a: readonly number[], b: readonly number[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Do two states belong to one evolution? They do when they share any
 * identity at all: a point id, or an edge's lineage root. Every state a
 * `steps` makes from another keeps the ids of what it did not retire, an
 * extracted material keeps the ids of its rows, and a material that was
 * built on its own shares none — ids are minted once and never reused.
 */
export function sameLineage(a: Material, b: Material): boolean {
  if (a === b) return true;
  for (let i = 0; i < b.n; i++) if (a.rowOfPoint(b.pointIds[i] as never) >= 0) return true;
  if (b.edgeCount === 0 || a.edgeCount === 0) return false;
  const roots = new Set<number>();
  for (let e = 0; e < a.edgeCount; e++) roots.add(a.edgeRoots[e]);
  for (let e = 0; e < b.edgeCount; e++) if (roots.has(b.edgeRoots[e])) return true;
  return false;
}

/**
 * The other operand of a set operation, read against the receiver's state.
 *
 * A selection holds rows, and rows belong to one state; who the members
 * ARE does not. So a selection from an earlier state of the same evolution
 * is resolved by identity — `other.in(state)` — and a member that is gone
 * drops out, as it does everywhere else. Only a selection of an unrelated
 * material is refused: nothing in it is anything here.
 */
export function onState<S extends { source: Material; in(state: Material): S }>(mine: { source: Material }, other: S, what: string): S {
  if (other.source === mine.source) return other;
  if (!sameLineage(mine.source, other.source)) {
    throw new Error(`selection.${what}: the two selections come from unrelated materials — nothing in one is anything in the other. Selections of one evolution resolve by identity; to combine two materials, append() them first`);
  }
  return other.in(mine.source);
}

import { groupRows } from './groupRows.js';
import { neighbours } from './forces.js';
import { vx, vy, type XY } from './vec.js';
import { edges as buildEdgeQuery, type EdgeQuery } from './query.js';
import { orient2d } from 'robust-predicates';
import { bucketStretch, type Space } from './space.js';
import type { FaceSelection, Face } from './faces.js';
export { groupRows } from './groupRows.js';

/** The rows a collection over `count` source rows holds: null is all of them. */
function fullRows(count: number): number[] {
  const out = new Array<number>(count);
  for (let i = 0; i < count; i++) out[i] = i;
  return out;
}

/**
 * Points of one state: the whole collection (`m.points`) or the rows a
 * filter picked. `key` is set on the selections `groupBy` makes.
 */
export class PointSelection<K = undefined> implements Iterable<Vertex> {
  /** The exact state selected from. */
  readonly source: Material;
  /** The classification that made this group; undefined otherwise. */
  readonly key: K;
  private readonly memberRows: readonly number[] | null;
  private readonly set: Set<number> | null;
  /** The lazily built full row list lives in a box, so the selection itself is frozen. */
  private readonly cache: { indices: readonly number[] | null } = { indices: null };

  /** @internal Use `material.points` and `filter`. `rows` null means every row. */
  constructor(source: Material, rows: Iterable<number> | null, key?: K) {
    this.source = source;
    this.memberRows = rows === null ? null : rowsOf(rows);
    this.set = this.memberRows === null ? null : new Set(this.memberRows);
    this.key = key as K;
    Object.freeze(this);
  }

  /** Selected rows of the source, ascending. Not identities across states. */
  get indices(): readonly number[] {
    if (this.memberRows !== null) return this.memberRows;
    return (this.cache.indices ??= Object.freeze(fullRows(this.source.n)));
  }

  get length(): number {
    return this.memberRows === null ? this.source.n : this.memberRows.length;
  }

  /** The member at position `i` of this collection (a view of the source). */
  at(i: number): Vertex {
    const row = this.memberRows === null ? i : this.memberRows[i];
    if (!Number.isInteger(i) || i < 0 || row === undefined || row >= this.source.n) throw new Error(`points.at: no member ${i} (${this.length} members)`);
    return this.source.vertex(row);
  }

  *[Symbol.iterator](): Iterator<Vertex> {
    const n = this.length;
    for (let i = 0; i < n; i++) yield this.source.vertex(this.memberRows === null ? i : this.memberRows[i]);
  }

  map<T>(fn: (p: Vertex, i: number) => T): T[] {
    const out = new Array<T>(this.length);
    let i = 0;
    for (const p of this) out[i] = fn(p, i++);
    return out;
  }

  forEach(fn: (p: Vertex, i: number) => void): void {
    let i = 0;
    for (const p of this) fn(p, i++);
  }

  find(fn: (p: Vertex, i: number) => unknown): Vertex | undefined {
    let i = 0;
    for (const p of this) if (fn(p, i++)) return p;
    return undefined;
  }

  some(fn: (p: Vertex, i: number) => unknown): boolean {
    return this.find(fn) !== undefined;
  }

  every(fn: (p: Vertex, i: number) => unknown): boolean {
    let i = 0;
    for (const p of this) if (!fn(p, i++)) return false;
    return true;
  }

  /** The members `fn` picks, as a selection of the same source; a group keeps its key. */
  filter(fn: (p: Vertex, i: number) => unknown): PointSelection<K> {
    const rows: number[] = [];
    let i = 0;
    for (const p of this) if (fn(p, i++)) rows.push(p.index);
    return new PointSelection(this.source, rows, this.key);
  }

  /** Split into selections by key: first-occurrence order, rows in source order. */
  groupBy<G>(classify: (p: Vertex, i: number) => G): PointSelection<G>[] {
    return groupRows(this, (p) => p.index, classify).map(({ key, rows }) => new PointSelection(this.source, rows, key));
  }

  /** True when `view` is a vertex of the source and was selected. A vertex
   * of another state is never a member; an edge view is the wrong domain. */
  /**
   * The points of this selection CLOSER THAN `radius` to `p` — the bound
   * is strict, so a point sitting exactly at `radius` is not one of them.
   *
   * Proximity, not topology: `p.adjacent` is the points an edge joins it
   * to. A vertex of THIS state is never its own neighbour; a point from
   * anywhere else — a midpoint, a bare pair, a vertex of an earlier state
   * — is just a position, and a vertex sitting under it is returned.
   *
   * The radius is a length of the material's SPACE: in a curved space the
   * test is the space's own distance, so a radius means the same thing at
   * the rim of the disk as at its middle. `pairs` with a `radius` takes
   * its candidates here, so it reads the space too.
   *
   * One radius, one grid, kept on the state. A radius that changes from
   * point to point builds a grid for each value, so round it first.
   */
  near(p: XY, opts: { radius: number }): PointSelection {
    const radius = opts.radius;
    if (!(radius > 0)) throw new Error('near: radius must be a positive distance');
    const box = this.source.nearBox;
    let index = box.byRadius.get(radius);
    if (index === undefined) {
      // The radius is a length of the material's space: `neighbours` tests
      // by the space's distance there, and by the old coordinate arithmetic
      // in the flat plane.
      index = neighbours(this.source, { radius, space: this.source.space });
      // Bounded: a per-point radius would otherwise build one grid per
      // distinct float and hold every one of them for the state's life.
      if (box.byRadius.size >= 8) box.byRadius.delete(box.byRadius.keys().next().value as number);
      box.byRadius.set(radius, index);
    }
    const rows = index(p);
    // The index covers the whole state. A selection of part of it answers
    // with its own members only.
    return new PointSelection(this.source, this.memberRows === null ? rows : rows.filter((r) => this.set!.has(r)));
  }

  has(view: Vertex): boolean {
    if (isEdgeView(view)) throw new Error('selection.has: this is a point selection; an edge view cannot be a member');
    if (!isVertexView(view)) throw new Error('selection.has: expected a vertex view');
    // A view from an earlier state of the same evolution is asked about by
    // identity: the row it holds is that state's, but who it is has not
    // changed. A vertex that is gone is not a member, which is the same
    // answer a foreign vertex gets.
    const row = ownedBy(view, this.source) ? view.index : this.source.rowOfPoint(view.id);
    if (row < 0) return false;
    return this.set === null ? row < this.source.n : this.set.has(row);
  }

  /**
   * This selection read against a later state: the rows are found again by
   * identity, and the members that are gone are dropped.
   *
   * A selection holds rows, and rows are a state's own numbering. `in` is
   * how a selection made two steps ago is still about the same points.
   */
  in(state: Material): PointSelection<K> {
    if (state === this.source) return this;
    const rows: number[] = [];
    for (const i of this.indices) {
      const row = state.rowOfPoint(this.source.pointIds[i] as never);
      if (row >= 0) rows.push(row);
    }
    return new PointSelection(state, rows, this.key);
  }

  /** Both selections' members, as a selection of THIS state. The other
   * operand may come from an earlier state of the same evolution: it is
   * read by identity (`other.in(this.source)`). The result keeps this
   * selection's key, as `filter` does, so a list of groups folds with
   * `reduce((a, b) => a.union(b))`. */
  union(other: PointSelection<unknown>): PointSelection<K> {
    if (!(other instanceof PointSelection)) throw new Error('selection.union: a point selection combines only with a point selection');
    const theirs = onState(this, other, 'union');
    return new PointSelection(this.source, [...this.indices, ...theirs.indices], this.key);
  }

  intersect(other: PointSelection<unknown>): PointSelection<K> {
    if (!(other instanceof PointSelection)) throw new Error('selection.intersect: a point selection combines only with a point selection');
    const theirs = onState(this, other, 'intersect');
    return new PointSelection(this.source, this.indices.filter((i) => theirs.holds(i)), this.key);
  }

  subtract(other: PointSelection<unknown>): PointSelection<K> {
    if (!(other instanceof PointSelection)) throw new Error('selection.subtract: a point selection combines only with a point selection');
    const theirs = onState(this, other, 'subtract');
    return new PointSelection(this.source, this.indices.filter((i) => !theirs.holds(i)), this.key);
  }

  /** Every point of the source that is NOT selected. */
  complement(): PointSelection {
    const out: number[] = [];
    for (let i = 0; i < this.source.n; i++) if (!(this.set === null || this.set.has(i))) out.push(i);
    return new PointSelection(this.source, out);
  }

  /** The selection holding those SOURCE rows — never positions within
   * this selection. The door for a relation the sketch worked out for
   * itself: hand back the rows it decided on, as row indices or as the
   * vertex views themselves, one or a list. */
  rows(rows: number | Vertex | Iterable<number | Vertex>): PointSelection {
    const out: number[] = [];
    for (const i of sourceRows(rows, this.source, 'vertex', 'points.rows')) {
      if (!Number.isInteger(i) || i < 0 || i >= this.source.n) {
        throw new Error(`points.rows: no vertex ${i} in this state (${this.source.n} rows)`);
      }
      out.push(i);
    }
    return new PointSelection(this.source, out);
  }

  /**
   * Every pair (a member of this, a member of `other`) the predicate
   * accepts, as views. A point is never paired with itself. `radius`
   * takes the candidates from the spatial index instead of the whole of
   * `other`; without it this is the full product, which is what it
   * sounds like and costs what it sounds like.
   *
   * When the two selections hold the same rows, a pair is unordered and
   * appears once: the predicate sees `(a, b)` with `a` before `b` by row,
   * and never `(b, a)`.
   */
  pairs(
    other: PointSelection<unknown>,
    predicate: (a: Vertex, b: Vertex) => boolean,
    opts: { radius?: number } = {},
  ): [Vertex, Vertex][] {
    if (!(other instanceof PointSelection)) throw new Error('selection.pairs: a point selection pairs only with a point selection');
    other = onState(this, other, 'pairs');
    const m = this.source;
    const mirror = sameMembers(this.indices, other.indices);
    const out: [Vertex, Vertex][] = [];
    for (const i of this.indices) {
      const a = m.vertex(i);
      const candidates = opts.radius === undefined ? other.indices : other.near(a, { radius: opts.radius }).indices;
      for (const j of candidates) {
        if (i === j || (mirror && j < i)) continue;
        const b = m.vertex(j);
        if (predicate(a, b)) out.push([a, b]);
      }
    }
    return out;
  }

  /** The positions this selection holds: itself. A point consumer asks
   * every geometry value for `points`, and a point selection is already
   * the answer. */
  get points(): PointSelection<K> {
    return this;
  }

  /** Every vertex an edge joins to a member, members excluded. One step
   * out from the selection: `p.adjacent` for a whole selection at once. */
  adjacent(): PointSelection {
    const m = this.source;
    const out: number[] = [];
    const seen = new Set<number>();
    for (const i of this.indices) {
      for (const w of m.adjacentRows(i)) {
        if (this.holds(w) || seen.has(w)) continue;
        seen.add(w);
        out.push(w);
      }
    }
    return new PointSelection(m, out.sort((a, b) => a - b));
  }

  /** The members plus every vertex reachable from them through edges of
   * the state — the pieces the selection touches, whole. */
  connected(): PointSelection {
    const m = this.source;
    const seen = new Set<number>(this.indices);
    const stack = [...this.indices];
    while (stack.length) {
      const v = stack.pop()!;
      for (const w of m.adjacentRows(v)) {
        if (seen.has(w)) continue;
        seen.add(w);
        stack.push(w);
      }
    }
    return new PointSelection(m, [...seen].sort((a, b) => a - b));
  }

  /** One selection per connected piece OF THE MEMBERS, joined by the edges
   * among them alone: an isolated member is a piece of its own. Keyed like
   * `groupBy`, in the order the pieces are first met by row. */
  components(): PointSelection<number>[] {
    const m = this.source;
    const among = new Map<number, number[]>();
    for (const e of this.edges.indices) {
      const a = m.edgeList[2 * e];
      const b = m.edgeList[2 * e + 1];
      if (a === b) continue;
      (among.get(a) ?? among.set(a, []).get(a)!).push(b);
      (among.get(b) ?? among.set(b, []).get(b)!).push(a);
    }
    const seen = new Set<number>();
    const out: PointSelection<number>[] = [];
    for (const start of this.indices) {
      if (seen.has(start)) continue;
      const piece: number[] = [];
      const stack = [start];
      seen.add(start);
      while (stack.length) {
        const v = stack.pop()!;
        piece.push(v);
        for (const w of among.get(v) ?? []) {
          if (seen.has(w)) continue;
          seen.add(w);
          stack.push(w);
        }
      }
      out.push(new PointSelection(m, piece.sort((a, b) => a - b), out.length));
    }
    return out;
  }

  /** @internal Does this selection hold that source row? */
  private holds(row: number): boolean {
    return this.set === null || this.set.has(row);
  }

  /** The chains through these points: the chains of the edges among them.
   * A chain consumer reads this — `strokes(sel)` draws what the selected
   * points are connected by, never a new connection. */
  curves(): Curve[] {
    return this.edges.curves();
  }

  /** The source edges whose BOTH endpoints are selected — connections that
   * already exist, never new ones. Selected points with no such edge are
   * absent from that edge selection's extraction. */
  get edges(): EdgeSelection {
    const m = this.source;
    const rows: number[] = [];
    const inside = (i: number) => this.set === null || this.set.has(i);
    for (let e = 0; e < m.edgeCount; e++) {
      if (inside(m.edgeList[2 * e]) && inside(m.edgeList[2 * e + 1])) rows.push(e);
    }
    return new EdgeSelection(m, rows);
  }


  /** Thickness around what this selection holds, as `Material.thicken`
   * does: the selection is the same material's world, and the outline is
   * taken from the rows it picked. */
  thicken(opts: ThickenOpts): Material {
    return thickenKernel(this, opts);
  }

  /** Independent material of the selected points and every point column,
   * with NO edges (use `edges.extract()` to keep existing
   * connections). Edge columns stay declared, empty. Iteration 0, no
   * history; transfer policies carried. */
  extract(): Material {
    return extractRows(this.source, this.indices, []);
  }
}

/**
 * Edges of one state: the whole collection (`m.edges`) or the rows a
 * filter picked. Its chains and boundary are those of the selected edges
 * alone: dropping one branch of a junction lets the other two run on as
 * one chain, and a ring picked out of a network is a valid area.
 */
export class EdgeSelection<K = undefined> implements Iterable<Edge> {
  readonly source: Material;
  readonly key: K;
  private readonly memberRows: readonly number[] | null;
  private readonly set: Set<number> | null;
  /** The lazily built full row list lives in a box, so the selection itself is frozen. */
  private readonly cache: { indices: readonly number[] | null } = { indices: null };

  /** @internal Use `material.edges` and `filter`. `rows` null means every row. */
  constructor(source: Material, rows: Iterable<number> | null, key?: K) {
    this.source = source;
    this.memberRows = rows === null ? null : rowsOf(rows);
    this.set = this.memberRows === null ? null : new Set(this.memberRows);
    this.key = key as K;
    Object.freeze(this);
  }

  /** Selected edge rows of the source, ascending. */
  get indices(): readonly number[] {
    if (this.memberRows !== null) return this.memberRows;
    return (this.cache.indices ??= Object.freeze(fullRows(this.source.edgeCount)));
  }

  get length(): number {
    return this.memberRows === null ? this.source.edgeCount : this.memberRows.length;
  }

  at(i: number): Edge {
    const row = this.memberRows === null ? i : this.memberRows[i];
    if (!Number.isInteger(i) || i < 0 || row === undefined || row >= this.source.edgeCount) throw new Error(`edges.at: no member ${i} (${this.length} members)`);
    return this.source.edge(row);
  }

  *[Symbol.iterator](): Iterator<Edge> {
    const n = this.length;
    for (let i = 0; i < n; i++) yield this.source.edge(this.memberRows === null ? i : this.memberRows[i]);
  }

  map<T>(fn: (e: Edge, i: number) => T): T[] {
    const out = new Array<T>(this.length);
    let i = 0;
    for (const e of this) out[i] = fn(e, i++);
    return out;
  }

  forEach(fn: (e: Edge, i: number) => void): void {
    let i = 0;
    for (const e of this) fn(e, i++);
  }

  find(fn: (e: Edge, i: number) => unknown): Edge | undefined {
    let i = 0;
    for (const e of this) if (fn(e, i++)) return e;
    return undefined;
  }

  some(fn: (e: Edge, i: number) => unknown): boolean {
    return this.find(fn) !== undefined;
  }

  every(fn: (e: Edge, i: number) => unknown): boolean {
    let i = 0;
    for (const e of this) if (!fn(e, i++)) return false;
    return true;
  }

  filter(fn: (e: Edge, i: number) => unknown): EdgeSelection<K> {
    const rows: number[] = [];
    let i = 0;
    for (const e of this) if (fn(e, i++)) rows.push(e.index);
    return new EdgeSelection(this.source, rows, this.key);
  }

  groupBy<G>(classify: (e: Edge, i: number) => G): EdgeSelection<G>[] {
    return groupRows(this, (e) => e.index, classify).map(({ key, rows }) => new EdgeSelection(this.source, rows, key));
  }

  /** True when `view` is an edge of the source and was selected. */
  has(view: Edge): boolean {
    if (isEdgeView(view)) {
      // Asked by identity when the view is from another state of the same
      // evolution; an edge that a split retired is not a member.
      const row = ownedBy(view, this.source) ? view.index : this.source.rowOfEdge(view.id);
      if (row < 0) return false;
      return this.set === null ? row < this.source.edgeCount : this.set.has(row);
    }
    if (isVertexView(view)) throw new Error('selection.has: this is an edge selection; a vertex view cannot be a member');
    throw new Error('selection.has: expected an edge view');
  }

  /** This selection read against a later state, by identity: an edge that
   * was split is gone, because a split retires the parent. */
  in(state: Material): EdgeSelection<K> {
    if (state === this.source) return this;
    const rows: number[] = [];
    for (const e of this.indices) {
      const row = state.rowOfEdge(this.source.edgeIds[e] as never);
      if (row >= 0) rows.push(row);
    }
    return new EdgeSelection(state, rows, this.key);
  }


  /** The selection holding those SOURCE edge rows — never positions
   * within this selection: row indices or the edge views themselves, one
   * or a list. */
  rows(rows: number | Edge | Iterable<number | Edge>): EdgeSelection {
    const out: number[] = [];
    for (const e of sourceRows(rows, this.source, 'edge', 'edges.rows')) {
      if (!Number.isInteger(e) || e < 0 || e >= this.source.edgeCount) {
        throw new Error(`edges.rows: no edge ${e} in this state (${this.source.edgeCount} edges)`);
      }
      out.push(e);
    }
    return new EdgeSelection(this.source, out);
  }

  /**
   * Every pair (a member of this, a member of `other`) the predicate
   * accepts, as views. An edge is never paired with itself. `radius`
   * takes the candidates from a spatial index over edge MIDDLES — an edge
   * is near another edge by its middle — instead of the whole of `other`;
   * without it this is the full product.
   *
   * When the two selections hold the same rows, a pair is unordered and
   * appears once.
   */
  pairs(
    other: EdgeSelection<unknown>,
    predicate: (a: Edge, b: Edge) => boolean,
    opts: { radius?: number } = {},
  ): [Edge, Edge][] {
    if (!(other instanceof EdgeSelection)) throw new Error('selection.pairs: an edge selection pairs only with an edge selection');
    other = onState(this, other, 'pairs');
    const m = this.source;
    const mirror = sameMembers(this.indices, other.indices);
    const radius = opts.radius;
    const mids = radius === undefined ? null : midpoints(m);
    const theirs = radius === undefined ? null : new Set(other.indices);
    const out: [Edge, Edge][] = [];
    for (const e of this.indices) {
      const a = m.edge(e);
      const candidates = mids === null
        ? other.indices
        : mids.points.near(mids.points.at(e), { radius: radius! }).indices.filter((f) => theirs!.has(f));
      for (const f of candidates) {
        if (e === f || (mirror && f < e)) continue;
        const b = m.edge(f);
        if (predicate(a, b)) out.push([a, b]);
      }
    }
    return out;
  }

  /**
   * The edges of this selection CLOSER THAN `radius` to `p`, by the true
   * distance to the segment — so a long wall passing near the place is
   * near it, whichever end it is measured from.
   *
   * Proximity, not topology: `e.adjacent` is the edges that touch this one.
   * `edges.pairs({ radius })` is a different question again — it takes its
   * CANDIDATES by midpoint, because a relation between two walls has no
   * third place to measure from, and its predicate decides the rest.
   *
   * The radius is a length of the material's SPACE, and the distance is
   * to the edge read as a GEODESIC of it; the flat plane is the straight
   * segment it always was.
   *
   * One grid, built once and kept on the state, and it judges every radius,
   * so a radius that changes from edge to edge costs nothing extra.
   */
  near(p: XY, opts: { radius: number }): EdgeSelection {
    const space = this.source.space;
    const rows = space === undefined || space.kind === 'euclidean'
      ? edgeQuery(this.source).within(p, opts.radius)
      : edgesNearInSpace(this.source, space, p, opts.radius);
    // The grid covers the whole state. A selection of part of it answers
    // with its own members only.
    return new EdgeSelection(this.source, this.memberRows === null ? rows : rows.filter((r) => this.set!.has(r)));
  }

  /**
   * The edges of this selection the straight segment `a` → `b` CROSSES:
   * the segment passes from one side of the edge to the other, and the
   * edge passes from one side of the segment to the other.
   *
   * Both sides are strict, and the test is exact (`orient2d`, Shewchuk's
   * adaptive predicate — no tolerance, no snapping). So contact at an end
   * is not a crossing: a segment that stops ON an edge, or starts at one,
   * or brushes an edge's endpoint, has not passed through it. Neither is a
   * segment lying ALONG an edge, which changes no side. The question is
   * "would this move go through a wall", which is what a growth rule asks
   * before it extrudes, and a move up to a wall does not.
   *
   * One grid, the same one `near` reads: the candidates are the edges
   * within half the segment's length of its middle, which is every edge
   * that could reach it.
   */
  crossing(a: XY, b: XY): EdgeSelection {
    const m = this.source;
    const ax = vx(a);
    const ay = vy(a);
    const bx = vx(b);
    const by = vy(b);
    // A segment of no length, or one with no position: nothing to cross.
    if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(bx) || !Number.isFinite(by)) return new EdgeSelection(m, []);
    const half = Math.hypot(bx - ax, by - ay) / 2;
    if (!(half > 0)) return new EdgeSelection(m, []);
    // A crossing point lies strictly inside the segment, so the edge it is
    // on is nearer the middle than half the length. The slack is for the
    // rounding in that distance, never for the judgement itself.
    const rows = edgeQuery(m).within([(ax + bx) / 2, (ay + by) / 2], half * (1 + 1e-9) + 1e-12);
    const out: number[] = [];
    for (const e of rows) {
      if (this.set !== null && !this.set.has(e)) continue;
      const p = m.edgeList[2 * e];
      const q = m.edgeList[2 * e + 1];
      const px = m.x[p];
      const py = m.y[p];
      const qx = m.x[q];
      const qy = m.y[q];
      const s0 = orient2d(ax, ay, bx, by, px, py);
      const s1 = orient2d(ax, ay, bx, by, qx, qy);
      if (!((s0 > 0 && s1 < 0) || (s0 < 0 && s1 > 0))) continue;
      const t0 = orient2d(px, py, qx, qy, ax, ay);
      const t1 = orient2d(px, py, qx, qy, bx, by);
      if (!((t0 > 0 && t1 < 0) || (t0 < 0 && t1 > 0))) continue;
      out.push(e);
    }
    return new EdgeSelection(m, out);
  }

  /** The endpoints of the selected edges — each once, source order. */
  get endpointRows(): readonly number[] {
    const m = this.source;
    const rows: number[] = [];
    for (const e of this.indices) rows.push(m.edgeList[2 * e], m.edgeList[2 * e + 1]);
    return rowsOf(rows);
  }

  /** Itself. Every geometry value answers `edges` with the edges it holds,
   * and an edge selection holds these. The protocol is structural, so the
   * word has to be here for a consumer to read this value the same way it
   * reads a material or a point selection. */
  get edges(): EdgeSelection<K> {
    return this;
  }

  /** Endpoint vertices of the selected edges, each once, source order —
   * not every point of the source — as a point selection. */
  get points(): PointSelection {
    return new PointSelection(this.source, this.endpointRows);
  }

  /** Both selections' members, as a selection of THIS state; an operand
   * from an earlier state of the same evolution is read by identity, as
   * the point selection's is. The result keeps this selection's key. */
  union(other: EdgeSelection<unknown>): EdgeSelection<K> {
    if (!(other instanceof EdgeSelection)) throw new Error('selection.union: an edge selection combines only with an edge selection');
    const theirs = onState(this, other, 'union');
    return new EdgeSelection(this.source, [...this.indices, ...theirs.indices], this.key);
  }

  intersect(other: EdgeSelection<unknown>): EdgeSelection<K> {
    if (!(other instanceof EdgeSelection)) throw new Error('selection.intersect: an edge selection combines only with an edge selection');
    const theirs = onState(this, other, 'intersect');
    return new EdgeSelection(this.source, this.indices.filter((e) => theirs.holds(e)), this.key);
  }

  subtract(other: EdgeSelection<unknown>): EdgeSelection<K> {
    if (!(other instanceof EdgeSelection)) throw new Error('selection.subtract: an edge selection combines only with an edge selection');
    const theirs = onState(this, other, 'subtract');
    return new EdgeSelection(this.source, this.indices.filter((e) => !theirs.holds(e)), this.key);
  }

  /** Every edge of the source that is NOT selected. */
  complement(): EdgeSelection {
    const out: number[] = [];
    for (let e = 0; e < this.source.edgeCount; e++) if (!(this.set === null || this.set.has(e))) out.push(e);
    return new EdgeSelection(this.source, out);
  }

  /** Thickness around what this selection holds, as `Material.thicken`
   * does: the selection is the same material's world, and the outline is
   * taken from the rows it picked. */
  thicken(opts: ThickenOpts): Material {
    return thickenKernel(this, opts);
  }

  /** Independent material of the selected edges, their endpoints and both
   * attribute domains: endpoint rows compacted in source order, edges in
   * source order with stored orientation kept. Iteration 0, no history. */
  extract(): Material {
    return extractRows(this.source, this.endpointRows, this.indices);
  }

  /** The selected edges as chains, each edge once, with `indices` as SOURCE
   * rows. Junctions and open ends are those of the selected graph alone. */
  curves(): Curve[] {
    const m = this.source;
    return walkChains({
      vertexCount: m.n,
      edgeRows: this.indices,
      endpoints: (e) => [m.edgeList[2 * e], m.edgeList[2 * e + 1]],
      x: m.x,
      y: m.y,
      geodesic: geodesicEdges(m),
    });
  }

  /** Every edge that meets a member at a vertex, members excluded. */
  adjacent(): EdgeSelection {
    const m = this.source;
    const out: number[] = [];
    const seen = new Set<number>();
    for (const e of this.indices) {
      for (const end of [m.edgeList[2 * e], m.edgeList[2 * e + 1]]) {
        for (const f of m.incidentEdgeRows(end)) {
          if (this.holds(f) || seen.has(f)) continue;
          seen.add(f);
          out.push(f);
        }
      }
    }
    return new EdgeSelection(m, out.sort((a, b) => a - b));
  }

  /** The members plus every edge reachable from them through shared
   * vertices — the pieces the selection touches, whole. */
  connected(): EdgeSelection {
    const m = this.source;
    const seen = new Set<number>(this.indices);
    const stack = [...this.indices];
    while (stack.length) {
      const e = stack.pop()!;
      for (const end of [m.edgeList[2 * e], m.edgeList[2 * e + 1]]) {
        for (const f of m.incidentEdgeRows(end)) {
          if (seen.has(f)) continue;
          seen.add(f);
          stack.push(f);
        }
      }
    }
    return new EdgeSelection(m, [...seen].sort((a, b) => a - b));
  }

  /** One selection per connected piece OF THE MEMBERS, joined through
   * shared vertices among them alone. Keyed like `groupBy`, in the order
   * the pieces are first met by row. */
  components(): EdgeSelection<number>[] {
    const m = this.source;
    const mine = new Set(this.indices);
    const atVertex = new Map<number, number[]>();
    for (const e of this.indices) {
      for (const end of [m.edgeList[2 * e], m.edgeList[2 * e + 1]]) {
        (atVertex.get(end) ?? atVertex.set(end, []).get(end)!).push(e);
      }
    }
    const seen = new Set<number>();
    const out: EdgeSelection<number>[] = [];
    for (const start of this.indices) {
      if (seen.has(start)) continue;
      const piece: number[] = [];
      const stack = [start];
      seen.add(start);
      while (stack.length) {
        const e = stack.pop()!;
        piece.push(e);
        for (const end of [m.edgeList[2 * e], m.edgeList[2 * e + 1]]) {
          for (const f of atVertex.get(end) ?? []) {
            if (!mine.has(f) || seen.has(f)) continue;
            seen.add(f);
            stack.push(f);
          }
        }
      }
      out.push(new EdgeSelection(m, piece.sort((a, b) => a - b), out.length));
    }
    return out;
  }

  /** @internal Does this selection hold that source row? */
  private holds(row: number): boolean {
    return this.set === null || this.set.has(row);
  }

  /** @internal Highest vertex degree within the selected edges. The area
   * consumers refuse a branching value by it; a sketch counts degree with
   * `p.edges.length`. */
  maxDegree(): number {
    const m = this.source;
    const degree = degreesWithin(m.n, this.indices, (e) => [m.edgeList[2 * e], m.edgeList[2 * e + 1]]);
    let best = 0;
    for (let i = 0; i < degree.length; i++) if (degree[i] > best) best = degree[i];
    return best;
  }
}

/** The edge middles of `m` as a material of their own, row for row, built
 * once and kept on the state: `edges.pairs` with a radius asks the point
 * index about them. */
function midpoints(m: Material): Material {
  const box = m.midBox;
  if (box.material !== null) return box.material;
  const n = m.edgeCount;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  for (let e = 0; e < n; e++) {
    const a = m.edgeList[2 * e];
    const b = m.edgeList[2 * e + 1];
    x[e] = (m.x[a] + m.x[b]) / 2;
    y[e] = (m.y[a] + m.y[b]) / 2;
  }
  box.material = new Material(x, y, {}, new Uint32Array(0), { space: m.space });
  return box.material;
}

/** Copy the given point rows and edge rows of `m` into a fresh material:
 * every column of both domains, transfer policies, no history. */
function extractRows(m: Material, pointRows: readonly number[], edgeRows: readonly number[]): Material {
  const n = pointRows.length;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const rowMap = new Map<number, number>();
  // An extracted row is the row it came from, so it keeps its identity: a
  // selection pulled out and grown is still made of the same points.
  const pointIds = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const i = pointRows[k];
    x[k] = m.x[i];
    y[k] = m.y[i];
    pointIds[k] = m.pointIds[i];
    rowMap.set(i, k);
  }
  const attrs: Record<string, Float64Array> = {};
  for (const name of m.attrNames) {
    const src = m.attrs[name];
    const col = new Float64Array(n);
    for (let k = 0; k < n; k++) col[k] = src[pointRows[k]];
    attrs[name] = col;
  }
  const edges = new Uint32Array(edgeRows.length * 2);
  for (let k = 0; k < edgeRows.length; k++) {
    const e = edgeRows[k];
    edges[2 * k] = rowMap.get(m.edgeList[2 * e])!;
    edges[2 * k + 1] = rowMap.get(m.edgeList[2 * e + 1])!;
  }
  const edgeAttrs: Record<string, Float64Array> = {};
  for (const name of m.edgeAttrNames) {
    const src = m.edgeAttrs[name];
    const col = new Float64Array(edgeRows.length);
    for (let k = 0; k < edgeRows.length; k++) col[k] = src[edgeRows[k]];
    edgeAttrs[name] = col;
  }
  const edgeIds = new Float64Array(edgeRows.length);
  const edgeRoots = new Float64Array(edgeRows.length);
  for (let k = 0; k < edgeRows.length; k++) {
    edgeIds[k] = m.edgeIds[edgeRows[k]];
    edgeRoots[k] = m.edgeRoots[edgeRows[k]];
  }
  return new Material(x, y, attrs, edges, { iteration: 0, history: [], edgeAttrs: edgeAttrs, transfers: { ...m.transfers }, edgeTransfers: { ...m.edgeTransfers }, ids: { points: pointIds, edges: edgeIds, edgeRoots }, faceAttrs: m.faceAttrs, space: m.space });
}

// ---- relational measures ----------------------------------------------------------

/** Arithmetic mean of `fn` over `items`; 0 for no items. NaN and infinity
 * propagate as in ordinary arithmetic. Scalar counterpart of `sumBy`. */
export function meanBy<T>(items: Iterable<T>, fn: (item: T, index: number) => number): number {
  let total = 0;
  let count = 0;
  for (const item of items) total += fn(item, count++);
  return count === 0 ? 0 : total / count;
}

/**
 * What a `where` may be: a selection in any domain, or one face.
 */
export type Where = PointSelection<unknown> | EdgeSelection<unknown> | FaceSelection<unknown> | Face;

/**
 * The rows a `where` names, in the domain the verb consumes.
 *
 * `where` says which part of the material an operation is eligible to
 * touch. It is not a promise that every row it names is changed: the
 * operation's own rule still applies on top, and for a chain rebuild that
 * rule keeps the ends of each run.
 *
 * A `where` is read through the protocol: the verb asks it for the domain
 * it consumes, `points` or `edges`, and every selection answers both. A
 * point selection asked for edges gives THE EDGES AMONG ITS MEMBERS — the
 * same thing `strokes(sel)` draws and `sel.edges.extract()` keeps
 * (`sel.extract()` itself keeps no edges: it is the points alone), and the
 * reason `sel.edges.adjacent()` exists for when the wider span is what is
 * wanted. An edge selection asked for points gives its endpoints. A face
 * selection, or one face, gives its corners and its edges.
 *
 * `undefined` is the whole material, which is what every verb did before
 * there was a way to say otherwise.
 */
export function whereRows(
  m: Material,
  where: Where | undefined,
  domain: 'points' | 'edges',
  who: string,
): ReadonlySet<number> | null {
  if (where === undefined) return null;
  const read = typeof where === 'object' && where !== null ? (where as { points?: unknown; edges?: unknown })[domain] : undefined;
  if (!(read instanceof PointSelection) && !(read instanceof EdgeSelection)) {
    throw new Error(`${who}: { where } must be a selection — of points, edges or faces — or one face`);
  }
  if (read.source !== m) {
    throw new Error(`${who}: { where } is a selection of another material — it names rows of a state this is not; read it against this one with sel.in(m)`);
  }
  return new Set(read.indices);
}

/**
 * The length of the geodesic from `p` to the nearest point of the geodesic
 * SEGMENT `a` → `b`.
 *
 * The foot of the perpendicular lies on the segment when the triangle
 * `p a b` has no obtuse angle at `a` or at `b`; the angles are read in the
 * space's own local frame (`log`), which is orthonormal. Otherwise the
 * nearest point is the nearer end. With the foot inside, the triangle
 * `p, a, foot` has a right angle at the foot, and its hypotenuse and the
 * angle at `a` give the leg: `sinh h = sinh c · sin A` below zero and
 * `sin h = sin c · sin A` above, in units of the curvature's length.
 */
function geodesicSegmentDistance(space: Space, p: XY, a: XY, b: XY): number {
  const u = space.log(a, b);
  const v = space.log(a, p);
  const len = Math.hypot(u[0], u[1]);
  const c = Math.hypot(v[0], v[1]);
  if (!(len > 0) || !(c > 0) || u[0] * v[0] + u[1] * v[1] <= 0) return c;
  const back = space.log(b, a);
  const w = space.log(b, p);
  if (back[0] * w[0] + back[1] * w[1] <= 0) return Math.hypot(w[0], w[1]);
  const sinA = Math.min(1, Math.abs(u[0] * v[1] - u[1] * v[0]) / (len * c));
  const ell = 1 / Math.sqrt(Math.abs(space.curvature));
  return space.curvature < 0
    ? ell * Math.asinh(Math.sinh(c / ell) * sinA)
    : ell * Math.asin(Math.min(1, Math.sin(c / ell) * sinA));
}

/** How far any edge's geodesic strays from its straight chord, in
 * coordinates, bounded by half again the stray at its middle (the stray of
 * a short arc is a parabola, widest there). Once per state. */
const bows = new WeakMap<Material, number>();
function geodesicBow(m: Material, space: Space): number {
  let bow = bows.get(m);
  if (bow !== undefined) return bow;
  bow = 0;
  for (let e = 0; e < m.edgeCount; e++) {
    const a: [number, number] = [m.x[m.edgeList[2 * e]], m.y[m.edgeList[2 * e]]];
    const b: [number, number] = [m.x[m.edgeList[2 * e + 1]], m.y[m.edgeList[2 * e + 1]]];
    const mid = space.geodesic(a, b, 0.5);
    const off = Math.hypot(mid[0] - (a[0] + b[0]) / 2, mid[1] - (a[1] + b[1]) / 2);
    if (Number.isFinite(off) && off > bow) bow = off;
  }
  bow = 1.5 * bow;
  bows.set(m, bow);
  return bow;
}

/**
 * `edges.near` in a curved space: the edges whose geodesic comes closer
 * than `radius`, a length of the space, to `p`.
 *
 * The coordinate grid still narrows the search. A space length is at
 * least its coordinate length in the disk and at most `bucketStretch`
 * times shorter on the sphere, and a geodesic strays from its chord by at
 * most the bow; so every edge that can be near is inside the widened
 * coordinate radius, and each one found is judged by the space's
 * distance. Where no bound holds (a pole in the box) every edge is judged.
 */
function edgesNearInSpace(m: Material, space: Space, p: XY, radius: number): number[] {
  if (!(radius > 0) || !Number.isFinite(radius)) throw new Error('edges.near: radius must be a positive distance');
  const px = vx(p);
  const py = vy(p);
  let minx = px;
  let miny = py;
  let maxx = px;
  let maxy = py;
  for (let i = 0; i < m.n; i++) {
    if (m.x[i] < minx) minx = m.x[i];
    if (m.x[i] > maxx) maxx = m.x[i];
    if (m.y[i] < miny) miny = m.y[i];
    if (m.y[i] > maxy) maxy = m.y[i];
  }
  const widen = bucketStretch(space, { x: minx, y: miny, w: maxx - minx, h: maxy - miny });
  const reach = radius * widen + geodesicBow(m, space);
  const candidates = Number.isFinite(reach) ? edgeQuery(m).within([px, py], reach) : fullRows(m.edgeCount);
  const out: number[] = [];
  for (const e of candidates) {
    const a = m.edgeList[2 * e];
    const b = m.edgeList[2 * e + 1];
    if (geodesicSegmentDistance(space, [px, py], [m.x[a], m.y[a]], [m.x[b], m.y[b]]) < radius) out.push(e);
  }
  return out;
}

/** The edge grid for one state, built the first time it is asked for. */
function edgeQuery(m: Material): EdgeQuery {
  return (m.edgeQueryBox.query ??= buildEdgeQuery(m));
}
