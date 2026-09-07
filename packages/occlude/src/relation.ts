/**
 * Selections, extraction and relational attributes over a material.
 *
 * A selection is a source-bound value: the rows of ONE frozen state that
 * a predicate picked, fixed at the moment it was made. It copies nothing
 * and changes nothing; its views are the source's own views (same row
 * numbers, same ownership). Independent material is made explicitly with
 * `extract()`. Two selections combine only when they share the domain
 * (points or edges) and the exact source state — equal row numbers in
 * different states are not identities.
 *
 * Relational measures reuse what exists: `connectedPoints` is adjacency,
 * `components` is one prepared topological pass, `meanBy` is the scalar
 * reduction; distances come from `query.edges`, spatial neighbourhoods
 * from `neighbours`. Connected neighbours and nearby points are different
 * questions and stay different calls.
 */

import { Material, ownedBy, viewKind, type Curve, type Edge, type Vertex } from './material.js';

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

/** Points of one state chosen by a predicate; membership is fixed. */
export class PointSelection {
  /** The exact state selected from. */
  readonly source: Material;
  /** Selected rows of the source, ascending. Not identities across states. */
  readonly indices: readonly number[];
  private readonly set: Set<number>;

  /** @internal Use `material.selectPoints(pred)`. */
  constructor(source: Material, indices: Iterable<number>) {
    this.source = source;
    this.indices = rowsOf(indices);
    this.set = new Set(this.indices);
    Object.freeze(this);
  }

  get size(): number {
    return this.indices.length;
  }

  /** True when `view` is a vertex of the source and was selected. A vertex
   * of another state is never a member; an edge view is the wrong domain. */
  has(view: Vertex): boolean {
    if (isEdgeView(view)) throw new Error('selection.has: this is a point selection; an edge view cannot be a member');
    if (!isVertexView(view)) throw new Error('selection.has: expected a vertex view');
    return ownedBy(view, this.source) && this.set.has(view.index);
  }

  /** The selected vertices as the source's own views, source order. */
  get points(): Vertex[] {
    return this.indices.map((i) => this.source.vertex(i));
  }

  union(other: PointSelection): PointSelection {
    if (!(other instanceof PointSelection)) throw new Error('selection.union: a point selection combines only with a point selection');
    sameSource(this, other, 'union');
    return new PointSelection(this.source, [...this.indices, ...other.indices]);
  }

  intersect(other: PointSelection): PointSelection {
    if (!(other instanceof PointSelection)) throw new Error('selection.intersect: a point selection combines only with a point selection');
    sameSource(this, other, 'intersect');
    return new PointSelection(this.source, this.indices.filter((i) => other.set.has(i)));
  }

  subtract(other: PointSelection): PointSelection {
    if (!(other instanceof PointSelection)) throw new Error('selection.subtract: a point selection combines only with a point selection');
    sameSource(this, other, 'subtract');
    return new PointSelection(this.source, this.indices.filter((i) => !other.set.has(i)));
  }

  /** The source edges whose BOTH endpoints are selected — connections that
   * already exist, never new ones. Selected points with no such edge are
   * absent from that edge selection's extraction. */
  inducedEdges(): EdgeSelection {
    const m = this.source;
    const rows: number[] = [];
    for (let e = 0; e < m.edgeCount; e++) {
      if (this.set.has(m.edgeList[2 * e]) && this.set.has(m.edgeList[2 * e + 1])) rows.push(e);
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

/** Edges of one state chosen by a predicate; membership is fixed. */
export class EdgeSelection {
  readonly source: Material;
  /** Selected edge rows of the source, ascending. */
  readonly indices: readonly number[];
  private readonly set: Set<number>;

  /** @internal Use `material.selectEdges(pred)`. */
  constructor(source: Material, indices: Iterable<number>) {
    this.source = source;
    this.indices = rowsOf(indices);
    this.set = new Set(this.indices);
    Object.freeze(this);
  }

  get size(): number {
    return this.indices.length;
  }

  /** True when `view` is an edge of the source and was selected. */
  has(view: Edge): boolean {
    if (isEdgeView(view)) return ownedBy(view, this.source) && this.set.has(view.index);
    if (isVertexView(view)) throw new Error('selection.has: this is an edge selection; a vertex view cannot be a member');
    throw new Error('selection.has: expected an edge view');
  }

  /** The selected edges as the source's own views, source order. */
  get edges(): Edge[] {
    return this.indices.map((e) => this.source.edge(e));
  }

  /** The endpoints of the selected edges — each once, source order. */
  get endpointRows(): readonly number[] {
    const m = this.source;
    const rows: number[] = [];
    for (const e of this.indices) rows.push(m.edgeList[2 * e], m.edgeList[2 * e + 1]);
    return rowsOf(rows);
  }

  /** Endpoint vertices of the selected edges, each once, source order —
   * not every point of the source. */
  get points(): Vertex[] {
    return this.endpointRows.map((i) => this.source.vertex(i));
  }

  union(other: EdgeSelection): EdgeSelection {
    if (!(other instanceof EdgeSelection)) throw new Error('selection.union: an edge selection combines only with an edge selection');
    sameSource(this, other, 'union');
    return new EdgeSelection(this.source, [...this.indices, ...other.indices]);
  }

  intersect(other: EdgeSelection): EdgeSelection {
    if (!(other instanceof EdgeSelection)) throw new Error('selection.intersect: an edge selection combines only with an edge selection');
    sameSource(this, other, 'intersect');
    return new EdgeSelection(this.source, this.indices.filter((e) => other.set.has(e)));
  }

  subtract(other: EdgeSelection): EdgeSelection {
    if (!(other instanceof EdgeSelection)) throw new Error('selection.subtract: an edge selection combines only with an edge selection');
    sameSource(this, other, 'subtract');
    return new EdgeSelection(this.source, this.indices.filter((e) => !other.set.has(e)));
  }

  /** Independent material of the selected edges, their endpoints and both
   * attribute domains: endpoint rows compacted in source order, edges in
   * source order with stored orientation kept. Iteration 0, no history. */
  extract(): Material {
    return extractRows(this.source, this.endpointRows, this.indices);
  }

  /** The selected edges as chains, each edge once, with `indices` as SOURCE
   * rows. Junctions and open ends are those of the selected graph alone:
   * dropping one branch lets the other two run on as one chain. Built by
   * extracting the selection and walking it (one allocation of the
   * selected rows per call). */
  curves(): Curve[] {
    const rows = this.endpointRows;
    return extractRows(this.source, rows, this.indices).curves().map((c) => ({
      ...c,
      indices: c.indices.map((i) => rows[i]),
    }));
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
  return new Material(x, y, attrs, edges, 0, [], edgeAttrs, { ...m.transfers });
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
