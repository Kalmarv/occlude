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

import { Material, ownedBy, viewKind, type Curve, type Edge, type Vertex } from './material.js';
import { degreesWithin, walkChains } from './chains.js';

// Domain comes from the view's own marker, never from attribute names.
const isEdgeView = (v: unknown): v is Edge => viewKind(v) === 'edge';
const isVertexView = (v: unknown): v is Vertex => viewKind(v) === 'vertex';

/** Rows in source order, deduplicated. */
function rowsOf(indices: Iterable<number>): readonly number[] {
  return Object.freeze(Array.from(new Set(indices)).sort((p, q) => p - q));
}

function sameSource(a: { source: Material }, b: { source: Material }, what: string): void {
  if (a.source !== b.source) throw new Error(`selection.${what}: the two selections come from different states — combine extracted material instead`);
}

/** Group members by a classifier: first-occurrence key order, members in
 * collection order, Map equality on keys, one classifier call per member. */
export function groupRows<V, K>(members: Iterable<V>, rowOf: (v: V) => number, classify: (v: V, i: number) => K): { key: K; rows: number[] }[] {
  const groups = new Map<K, number[]>();
  let i = 0;
  for (const v of members) {
    const k = classify(v, i++);
    let rows = groups.get(k);
    if (!rows) {
      rows = [];
      groups.set(k, rows);
    }
    rows.push(rowOf(v));
  }
  return Array.from(groups, ([key, rows]) => ({ key, rows }));
}

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
  private readonly rows: readonly number[] | null;
  private readonly set: Set<number> | null;
  /** The lazily built full row list lives in a box, so the selection itself is frozen. */
  private readonly cache: { indices: readonly number[] | null } = { indices: null };

  /** @internal Use `material.points` and `filter`. `rows` null means every row. */
  constructor(source: Material, rows: Iterable<number> | null, key?: K) {
    this.source = source;
    this.rows = rows === null ? null : rowsOf(rows);
    this.set = this.rows === null ? null : new Set(this.rows);
    this.key = key as K;
    Object.freeze(this);
  }

  /** Selected rows of the source, ascending. Not identities across states. */
  get indices(): readonly number[] {
    if (this.rows !== null) return this.rows;
    return (this.cache.indices ??= Object.freeze(fullRows(this.source.n)));
  }

  get length(): number {
    return this.rows === null ? this.source.n : this.rows.length;
  }

  /** The member at position `i` of this collection (a view of the source). */
  at(i: number): Vertex {
    const row = this.rows === null ? i : this.rows[i];
    if (!Number.isInteger(i) || i < 0 || row === undefined || row >= this.source.n) throw new Error(`points.at: no member ${i} (${this.length} members)`);
    return this.source.vertex(row);
  }

  *[Symbol.iterator](): Iterator<Vertex> {
    const n = this.length;
    for (let i = 0; i < n; i++) yield this.source.vertex(this.rows === null ? i : this.rows[i]);
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

  find(fn: (p: Vertex, i: number) => boolean): Vertex | undefined {
    let i = 0;
    for (const p of this) if (fn(p, i++)) return p;
    return undefined;
  }

  some(fn: (p: Vertex, i: number) => boolean): boolean {
    return this.find(fn) !== undefined;
  }

  every(fn: (p: Vertex, i: number) => boolean): boolean {
    let i = 0;
    for (const p of this) if (!fn(p, i++)) return false;
    return true;
  }

  /** The members `fn` picks, as a selection of the same source; a group keeps its key. */
  filter(fn: (p: Vertex, i: number) => boolean): PointSelection<K> {
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
  has(view: Vertex): boolean {
    if (isEdgeView(view)) throw new Error('selection.has: this is a point selection; an edge view cannot be a member');
    if (!isVertexView(view)) throw new Error('selection.has: expected a vertex view');
    if (!ownedBy(view, this.source)) return false;
    return this.set === null ? view.index < this.source.n : this.set.has(view.index);
  }

  union(other: PointSelection<unknown>): PointSelection {
    if (!(other instanceof PointSelection)) throw new Error('selection.union: a point selection combines only with a point selection');
    sameSource(this, other, 'union');
    return new PointSelection(this.source, [...this.indices, ...other.indices]);
  }

  intersect(other: PointSelection<unknown>): PointSelection {
    if (!(other instanceof PointSelection)) throw new Error('selection.intersect: a point selection combines only with a point selection');
    sameSource(this, other, 'intersect');
    return new PointSelection(this.source, this.indices.filter((i) => other.has(this.source.vertex(i))));
  }

  subtract(other: PointSelection<unknown>): PointSelection {
    if (!(other instanceof PointSelection)) throw new Error('selection.subtract: a point selection combines only with a point selection');
    sameSource(this, other, 'subtract');
    return new PointSelection(this.source, this.indices.filter((i) => !other.has(this.source.vertex(i))));
  }

  /** Every point of the source that is NOT selected. */
  complement(): PointSelection {
    const out: number[] = [];
    for (let i = 0; i < this.source.n; i++) if (!(this.set === null || this.set.has(i))) out.push(i);
    return new PointSelection(this.source, out);
  }

  /** The source edges whose BOTH endpoints are selected — connections that
   * already exist, never new ones. Selected points with no such edge are
   * absent from that edge selection's extraction. */
  inducedEdges(): EdgeSelection {
    const m = this.source;
    const rows: number[] = [];
    const inside = (i: number) => this.set === null || this.set.has(i);
    for (let e = 0; e < m.edgeCount; e++) {
      if (inside(m.edgeList[2 * e]) && inside(m.edgeList[2 * e + 1])) rows.push(e);
    }
    return new EdgeSelection(m, rows);
  }

  /** Independent material of the selected points and every point column,
   * with NO edges (use `inducedEdges().extract()` to keep existing
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
  private readonly rows: readonly number[] | null;
  private readonly set: Set<number> | null;
  /** The lazily built full row list lives in a box, so the selection itself is frozen. */
  private readonly cache: { indices: readonly number[] | null } = { indices: null };

  /** @internal Use `material.edges` and `filter`. `rows` null means every row. */
  constructor(source: Material, rows: Iterable<number> | null, key?: K) {
    this.source = source;
    this.rows = rows === null ? null : rowsOf(rows);
    this.set = this.rows === null ? null : new Set(this.rows);
    this.key = key as K;
    Object.freeze(this);
  }

  /** Selected edge rows of the source, ascending. */
  get indices(): readonly number[] {
    if (this.rows !== null) return this.rows;
    return (this.cache.indices ??= Object.freeze(fullRows(this.source.edgeCount)));
  }

  get length(): number {
    return this.rows === null ? this.source.edgeCount : this.rows.length;
  }

  at(i: number): Edge {
    const row = this.rows === null ? i : this.rows[i];
    if (!Number.isInteger(i) || i < 0 || row === undefined || row >= this.source.edgeCount) throw new Error(`edges.at: no member ${i} (${this.length} members)`);
    return this.source.edge(row);
  }

  *[Symbol.iterator](): Iterator<Edge> {
    const n = this.length;
    for (let i = 0; i < n; i++) yield this.source.edge(this.rows === null ? i : this.rows[i]);
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

  find(fn: (e: Edge, i: number) => boolean): Edge | undefined {
    let i = 0;
    for (const e of this) if (fn(e, i++)) return e;
    return undefined;
  }

  some(fn: (e: Edge, i: number) => boolean): boolean {
    return this.find(fn) !== undefined;
  }

  every(fn: (e: Edge, i: number) => boolean): boolean {
    let i = 0;
    for (const e of this) if (!fn(e, i++)) return false;
    return true;
  }

  filter(fn: (e: Edge, i: number) => boolean): EdgeSelection<K> {
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
      if (!ownedBy(view, this.source)) return false;
      return this.set === null ? view.index < this.source.edgeCount : this.set.has(view.index);
    }
    if (isVertexView(view)) throw new Error('selection.has: this is an edge selection; a vertex view cannot be a member');
    throw new Error('selection.has: expected an edge view');
  }

  /** The endpoints of the selected edges — each once, source order. */
  get endpointRows(): readonly number[] {
    const m = this.source;
    const rows: number[] = [];
    for (const e of this.indices) rows.push(m.edgeList[2 * e], m.edgeList[2 * e + 1]);
    return rowsOf(rows);
  }

  /** Endpoint vertices of the selected edges, each once, source order —
   * not every point of the source — as a point selection. */
  get points(): PointSelection {
    return new PointSelection(this.source, this.endpointRows);
  }

  union(other: EdgeSelection<unknown>): EdgeSelection {
    if (!(other instanceof EdgeSelection)) throw new Error('selection.union: an edge selection combines only with an edge selection');
    sameSource(this, other, 'union');
    return new EdgeSelection(this.source, [...this.indices, ...other.indices]);
  }

  intersect(other: EdgeSelection<unknown>): EdgeSelection {
    if (!(other instanceof EdgeSelection)) throw new Error('selection.intersect: an edge selection combines only with an edge selection');
    sameSource(this, other, 'intersect');
    return new EdgeSelection(this.source, this.indices.filter((e) => other.has(this.source.edge(e))));
  }

  subtract(other: EdgeSelection<unknown>): EdgeSelection {
    if (!(other instanceof EdgeSelection)) throw new Error('selection.subtract: an edge selection combines only with an edge selection');
    sameSource(this, other, 'subtract');
    return new EdgeSelection(this.source, this.indices.filter((e) => !other.has(this.source.edge(e))));
  }

  /** Every edge of the source that is NOT selected. */
  complement(): EdgeSelection {
    const out: number[] = [];
    for (let e = 0; e < this.source.edgeCount; e++) if (!(this.set === null || this.set.has(e))) out.push(e);
    return new EdgeSelection(this.source, out);
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
    });
  }

  /** Highest vertex degree within the selected edges: 1 or 2 for chains
   * and rings, more where the selection branches. */
  maxDegree(): number {
    const m = this.source;
    const degree = degreesWithin(m.n, this.indices, (e) => [m.edgeList[2 * e], m.edgeList[2 * e + 1]]);
    let best = 0;
    for (let i = 0; i < degree.length; i++) if (degree[i] > best) best = degree[i];
    return best;
  }
}

/** Copy the given point rows and edge rows of `m` into a fresh material:
 * every column of both domains, transfer policies, no history. */
function extractRows(m: Material, pointRows: readonly number[], edgeRows: readonly number[]): Material {
  const n = pointRows.length;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const rowMap = new Map<number, number>();
  for (let k = 0; k < n; k++) {
    const i = pointRows[k];
    x[k] = m.x[i];
    y[k] = m.y[i];
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
  return new Material(x, y, attrs, edges, 0, [], edgeAttrs, { ...m.transfers }, { ...m.edgeTransfers });
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

/** Connected components of one state, prepared once (O(V + E)). */
export interface Components {
  /** How many components; isolated vertices count one each. */
  readonly count: number;
  /** Source-aligned label per row: 0 for the component of the lowest row,
   * then in the order components are first met scanning rows. */
  readonly labels: Int32Array;
  /** Label of a vertex of the source (a view or a row). */
  label(vertex: Vertex | number): number;
}

/** Undirected connected components of `m`. Labels belong to this state
 * only; the next step may renumber them. */
export function components(m: Material): Components {
  const labels = new Int32Array(m.n).fill(-1);
  let count = 0;
  const stack: number[] = [];
  for (let s = 0; s < m.n; s++) {
    if (labels[s] !== -1) continue;
    const id = count++;
    labels[s] = id;
    stack.push(s);
    while (stack.length) {
      const v = stack.pop()!;
      for (const w of m.connected(v)) {
        if (labels[w] === -1) {
          labels[w] = id;
          stack.push(w);
        }
      }
    }
  }
  return {
    count,
    labels,
    label(vertex) {
      if (typeof vertex === 'number') {
        if (!Number.isInteger(vertex) || vertex < 0 || vertex >= m.n) throw new Error(`components: no vertex ${vertex} in this state`);
        return labels[vertex];
      }
      if (!ownedBy(vertex, m)) throw new Error('components: that vertex belongs to another state');
      return labels[vertex.index];
    },
  };
}
