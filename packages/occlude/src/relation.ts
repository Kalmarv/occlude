/**
 * The point and edge domains of a material, and relational measures.
 *
 * `m.points` and `m.edges` are selections (selection.ts): the one class
 * every domain shares, over a domain that says how a row of THIS material
 * reads, who it is in another state (its id), which rows neighbour which,
 * and how far a place is from each. A filter picks rows of the same state;
 * nothing is copied or changed, and independent material is made on
 * purpose with `extract()`. A selection of an earlier state of the same
 * evolution is read by identity; one of an unrelated material is refused.
 *
 * The words only points or only edges have come with their kind: the
 * three writes, `extract`, `thicken`, the chains (`curves`), and on
 * edges the spatial questions `nearest`, `firstHit` and `crossing` and the
 * chain verbs. Distances come from `edges.nearest`, spatial neighbourhoods
 * from `near`, and a mean from `sel.mean(column)`.
 */

import { at64, atU32 } from './column.js';
import { Material, alongMaterial, ownedBy, resampleMaterial, viewKind, type Edge, type Vertex } from './material.js';
import { ownerOf } from './views.js';
import { carryLinks } from './derivation.js';
import { degreesWithin } from './chains.js';
import { curvesOfRows, type Curve } from './curves.js';
import { thicken as thickenKernel, type ThickenOpts } from './thicken.js';
import { Selection, select, domainKind, isSelectionOf, rowRange, type Domain, type DomainKind, type Types } from './selection.js';
import { neighbours } from './forces.js';
import {
  addPoints, removePoints, setPoints, addEdges, removeEdges, setEdges, pointRow, edgeRow,
  type ColumnValue, type EdgeEnd, type EdgeRowSpec, type PointEnd, type PointWhere, type EdgeWhere, type PointSetOpts, type EdgeSetOpts,
} from './tables.js';
import { vx, vy, type XY } from './vec.js';
import { edges as buildEdgeQuery, type EdgeQuery, type NearestHit, type FirstHit } from './query.js';
import { orient2d } from 'robust-predicates';
import { bucketStretch, type Space } from './space.js';
import type { Face } from './faces.js';

/**
 * Do two states belong to one evolution? They do when they share any
 * identity at all: a point id, or an edge's lineage root. Every state a
 * `steps` makes from another keeps the ids of what it did not retire, an
 * extracted material keeps the ids of its rows, and a material that was
 * built on its own shares none — ids are minted once and never reused.
 */
export function sameLineage(a: Material, b: Material): boolean {
  if (a === b) return true;
  // States of one run share their id columns, or leaves of them: the same
  // leaf is the same ids.
  const theirs = b.store.pointIds;
  if (a.store.pointIds === theirs && b.n > 0) return true;
  for (const leaf of theirs.leaves()) for (let k = 0; k < leaf.length; k++) if (a.rowOfPoint(leaf[k] as never) >= 0) return true;
  if (b.edgeCount === 0 || a.edgeCount === 0) return false;
  const roots = new Set<number>();
  for (const leaf of a.store.edgeRoots.leaves()) for (let k = 0; k < leaf.length; k++) roots.add(leaf[k]);
  for (const leaf of b.store.edgeRoots.leaves()) for (let k = 0; k < leaf.length; k++) if (roots.has(leaf[k])) return true;
  return false;
}

/** The refusal a selection of an unrelated material gets. */
export function unrelated(who: string): Error {
  return new Error(`${who}: the two selections come from unrelated materials — nothing in one is anything in the other. Selections of one evolution resolve by identity; to combine two materials, append() them first`);
}

const viewName = (kind: string | undefined, v: unknown): string =>
  kind === 'edge' ? 'an edge view' : kind !== undefined ? `a ${kind} view` : v instanceof Selection ? `a ${v.domain.kind.name} selection` : v === null ? 'null' : typeof v;

// ---- what a point or an edge selection answers, by type ----------------------------

/** The point write: a value or a function of the point, on these points or
 * those `where` names, with the options record last. */
export interface PointSet {
  (column: string, value: ColumnValue<Vertex>, where?: PointWhere, opts?: PointSetOpts): Material;
  (column: string, value: ColumnValue<Vertex>, opts: PointSetOpts): Material;
  (values: Record<string, ColumnValue<Vertex>>, where?: PointWhere, opts?: PointSetOpts): Material;
  (values: Record<string, ColumnValue<Vertex>>, opts: PointSetOpts): Material;
}
/** The edge write, as the point write. */
export interface EdgeSet {
  (column: string, value: ColumnValue<Edge>, where?: EdgeWhere, opts?: EdgeSetOpts): Material;
  (column: string, value: ColumnValue<Edge>, opts: EdgeSetOpts): Material;
  (values: Record<string, ColumnValue<Edge>>, where?: EdgeWhere, opts?: EdgeSetOpts): Material;
  (values: Record<string, ColumnValue<Edge>>, opts: EdgeSetOpts): Material;
}

/** @internal What a selection of vertices answers (see `ROW_TYPES`). */
export type PointTypes = Types<{
  source: Material;
  points: Selection<Vertex>;
  edges: Selection<Edge>;
  curves: Selection<Curve>;
  extract: () => Material;
  set: PointSet;
  add: (at: XY | PointEnd | Iterable<XY | PointEnd> | undefined, cols?: Record<string, number>) => Material;
  remove: (what: Selection<Vertex> | PointEnd | undefined) => Material;
  thicken: (opts: ThickenOpts) => Material;
}>;

/** @internal What a selection of edges answers (see `ROW_TYPES`). */
export type EdgeTypes = Types<{
  source: Material;
  points: Selection<Vertex>;
  edges: Selection<Edge>;
  curves: Selection<Curve>;
  extract: () => Material;
  set: EdgeSet;
  add: (rows: EdgeRowSpec | EdgeEnd | readonly (EdgeRowSpec | EdgeEnd)[] | undefined, cols?: Record<string, number>) => Material;
  remove: (what: Selection<Edge> | EdgeEnd | undefined) => Material;
  thicken: (opts: ThickenOpts) => Material;
  resample: (opts: Parameters<Material['resample']>[0]) => Material;
  trim: (opts: Parameters<Material['trim']>[0]) => Material;
  spline: (opts?: Parameters<Material['spline']>[0]) => Material;
  oscillate: (opts: Parameters<Material['oscillate']>[0]) => Material;
  along: (opts?: Parameters<Material['along']>[0]) => ReturnType<Material['along']>;
}>;

// ---- the point domain ----------------------------------------------------------------

class PointDomain implements Domain<Vertex> {
  readonly kind: DomainKind = POINTS;
  readonly dense = true;
  private allRows: readonly number[] | null = null;
  constructor(readonly source: Material) {}
  get size(): number { return this.source.n; }
  all(): readonly number[] { return (this.allRows ??= rowRange(this.source.n)); }
  valid(r: number): boolean { return r >= 0 && r < this.source.n && Number.isInteger(r); }
  row(r: number): Vertex { return this.source.vertex(r); }
  rowOf(v: unknown, who: string): number {
    const kind = viewKind(v);
    if (kind === 'edge' || kind === 'face' || v instanceof Selection) {
      throw new Error(`${who}: expected a vertex view or a point value — got ${viewName(kind, v)}${kind === 'edge' ? '; its ends are e.a and e.b' : ''}`);
    }
    // A view of a material that shares no identity with this one names
    // nothing here, whatever its id: ids are minted per run.
    if (kind === 'vertex' && !ownedBy(v as object, this.source) && !sameLineage(this.source, ownerOf(v as object) as Material)) return -1;
    return pointRow(this.source, v, who);
  }
  resolve(other: Selection<any>, who: string): number[] {
    if (other.domain.kind !== POINTS) throw new Error(`${who}: expected points — a point selection — got ${other.domain.kind.plural}`);
    const theirs = other.source as Material;
    // The same state: the same rows (a curve's points are this domain read
    // along the curve).
    if (theirs === this.source) return [...other.indices];
    if (!sameLineage(this.source, theirs)) throw unrelated(who);
    const out: number[] = [];
    const ids = theirs.store.pointIds;
    for (const i of other.indices) {
      const r = this.source.rowOfPoint(at64(ids, i) as never);
      if (r >= 0) out.push(r);
    }
    return out;
  }
  on(state: unknown, who: string): Domain<Vertex> {
    if (!(state instanceof Material)) throw new Error(`${who}: expected the material to read the points on`);
    return pointDomain(state);
  }
  neighbours(r: number): readonly number[] { return this.source.adjacentRows(r); }
  near(p: unknown, radius: number, who: string): { rows: readonly number[]; distances: ArrayLike<number> } {
    if (!(typeof radius === 'number' && radius > 0)) throw new Error(`${who}: radius must be a positive distance`);
    const m = this.source;
    const box = m.nearBox;
    let index = box.byRadius.get(radius);
    if (index === undefined) {
      // The radius is a length of the material's space: `neighbours` tests
      // by the space's distance there, and by the old coordinate arithmetic
      // in the flat plane. One grid per radius, kept on the state, and
      // bounded: a per-point radius would otherwise build one grid per
      // distinct float and hold every one of them for the state's life.
      index = neighbours(m, { radius });
      if (box.byRadius.size >= 8) box.byRadius.delete(box.byRadius.keys().next().value as number);
      box.byRadius.set(radius, index);
    }
    const px = vx(p as XY);
    const py = vy(p as XY);
    const space = m.space;
    const rows = index(p as XY);
    const distances = new Float64Array(rows.length);
    // The index is built over every position, so the flats are joined
    // already: the distances read them.
    const x = m.x;
    const y = m.y;
    if (space === undefined || space.kind === 'euclidean') for (let k = 0; k < rows.length; k++) distances[k] = Math.hypot(px - x[rows[k]], py - y[rows[k]]);
    else for (let k = 0; k < rows.length; k++) distances[k] = space.distance([px, py], [x[rows[k]], y[rows[k]]]);
    return { rows, distances };
  }
}

// ---- the edge domain -----------------------------------------------------------------

class EdgeDomain implements Domain<Edge> {
  readonly kind: DomainKind = EDGES;
  readonly dense = true;
  private allRows: readonly number[] | null = null;
  constructor(readonly source: Material) {}
  get size(): number { return this.source.edgeCount; }
  all(): readonly number[] { return (this.allRows ??= rowRange(this.source.edgeCount)); }
  valid(r: number): boolean { return r >= 0 && r < this.source.edgeCount && Number.isInteger(r); }
  row(r: number): Edge { return this.source.edge(r); }
  rowOf(v: unknown, who: string): number {
    const kind = viewKind(v);
    if (kind === 'vertex' || kind === 'face' || v instanceof Selection) {
      throw new Error(`${who}: expected an edge view or an edge value — got ${viewName(kind, v)}${kind === 'vertex' ? '; its edges are p.edges' : ''}`);
    }
    if (kind === 'edge' && !ownedBy(v as object, this.source) && !sameLineage(this.source, ownerOf(v as object) as Material)) return -1;
    return edgeRow(this.source, v, who);
  }
  resolve(other: Selection<any>, who: string): number[] {
    if (other.domain.kind !== EDGES) throw new Error(`${who}: expected edges — an edge selection — got ${other.domain.kind.plural}`);
    const theirs = other.source as Material;
    if (theirs === this.source) return [...other.indices];
    if (!sameLineage(this.source, theirs)) throw unrelated(who);
    const out: number[] = [];
    const ids = theirs.store.edgeIds;
    for (const e of other.indices) {
      const r = this.source.rowOfEdge(at64(ids, e) as never);
      if (r >= 0) out.push(r);
    }
    return out;
  }
  on(state: unknown, who: string): Domain<Edge> {
    if (!(state instanceof Material)) throw new Error(`${who}: expected the material to read the edges on`);
    return edgeDomain(state);
  }
  /** Every edge that meets this one at a vertex, this one excluded. */
  neighbours(e: number): number[] {
    const m = this.source;
    const list = m.store.edgeList;
    const out: number[] = [];
    for (const f of m.incidentEdgeRows(atU32(list, 2 * e))) if (f !== e) out.push(f);
    for (const f of m.incidentEdgeRows(atU32(list, 2 * e + 1))) if (f !== e) out.push(f);
    return out;
  }
  near(p: unknown, radius: number, who: string): { rows: readonly number[]; distances: ArrayLike<number> } {
    if (!(typeof radius === 'number' && radius > 0 && Number.isFinite(radius))) throw new Error(`${who}: radius must be a positive distance`);
    const m = this.source;
    const space = m.space;
    const px = vx(p as XY);
    const py = vy(p as XY);
    if (space === undefined || space.kind === 'euclidean') {
      const distances: number[] = [];
      return { rows: edgeQuery(m).within([px, py], radius, distances), distances };
    }
    const at: [number, number] = [px, py];
    const rows = edgesNearInSpace(m, space, at, radius);
    const distances = rows.map((e) => geodesicSegmentDistance(space, at, [m.x[m.edgeList[2 * e]], m.y[m.edgeList[2 * e]]], [m.x[m.edgeList[2 * e + 1]], m.y[m.edgeList[2 * e + 1]]]));
    return { rows, distances };
  }
}

/** @internal The point domain of a material, made once per state. */
export function pointDomain(m: Material): PointDomain {
  return ((m.domainBox.points as PointDomain | null) ??= new PointDomain(m)) as PointDomain;
}
/** @internal The edge domain of a material, made once per state. */
export function edgeDomain(m: Material): EdgeDomain {
  return ((m.domainBox.edges as EdgeDomain | null) ??= new EdgeDomain(m)) as EdgeDomain;
}

/** The points of `m`, `rows` of them (null: every one, in row order). */
export function pointsOf(m: Material, rows: readonly number[] | null = null, key?: unknown, unique = false): Selection<Vertex> {
  return select(pointDomain(m), rows, key, unique);
}
/** The edges of `m`, `rows` of them (null: every one, in row order). */
export function edgesOf(m: Material, rows: readonly number[] | null = null, key?: unknown, unique = false): Selection<Edge> {
  return select(edgeDomain(m), rows, key, unique);
}

/** Is `v` a selection of a material's points? */
export const isPointSelection = (v: unknown): v is Selection<Vertex> => isSelectionOf(v, POINTS);
/** Is `v` a selection of a material's edges? */
export const isEdgeSelection = (v: unknown): v is Selection<Edge> => isSelectionOf(v, EDGES);

// ---- the words only points or only edges have ----------------------------------------

type Sel = Selection<any> & { readonly source: Material };

/** The edges whose BOTH ends a point selection holds, row order. */
function edgeRowsAmong(sel: Sel): readonly number[] {
  const m = sel.source;
  return sel.members === null ? edgeDomain(m).all() : edgesAmong(m, (r) => sel.holds(r));
}

/** @internal The ends of the selected edges, each once, row order. A
 * mark per row for the whole collection; a set for a few edges, so a face's
 * corners never cost a pass over every point. */
export function endpointRows(sel: Selection<Edge>): number[] {
  const m = sel.source as Material;
  const list = m.store.edgeList;
  const rows = sel.indices;
  if (rows.length * 8 < m.n) {
    const ends = new Set<number>();
    for (const e of rows) {
      ends.add(atU32(list, 2 * e));
      ends.add(atU32(list, 2 * e + 1));
    }
    return [...ends].sort((a, b) => a - b);
  }
  const seen = new Uint8Array(m.n);
  for (const e of rows) {
    seen[atU32(list, 2 * e)] = 1;
    seen[atU32(list, 2 * e + 1)] = 1;
  }
  const out: number[] = [];
  for (let i = 0; i < m.n; i++) if (seen[i]) out.push(i);
  return out;
}

/** The edges of `m` whose both ends `inside` holds, in row order. */
function edgesAmong(m: Material, inside: (r: number) => boolean): number[] {
  const rows: number[] = [];
  const list = m.store.edgeList;
  for (let e = 0; e < m.edgeCount; e++) if (inside(atU32(list, 2 * e)) && inside(atU32(list, 2 * e + 1))) rows.push(e);
  return rows;
}

const POINTS: DomainKind = domainKind('point', 'points', {
  /** Itself: a point selection is already the positions. */
  points: { get(this: Sel) { return this; } },
  /** The edges whose BOTH ends are members — connections that already
   * exist, never new ones — in row order. */
  edges: { get(this: Sel) { return edgesOf(this.source, this.members === null ? null : edgeRowsAmong(this), undefined, true); } },
  /** The chains through these points: the curves of the edges among them,
   * read on first ask and kept. `strokes(sel)` draws what the members are
   * connected by. */
  curves: { get(this: Sel): Selection<Curve> { return curvesOfRows(this, this.source, this.members === null ? null : edgeRowsAmong(this)); } },
  /** Independent material of the members in this order and every point
   * column, with NO edges (`sel.edges.extract()` keeps them). */
  extract: { value(this: Sel): Material { return extractRows(this.source, this.indices, []); } },
  set: { value(this: Sel, ...args: unknown[]): Material { return setPoints(this.source, this.members, args); } },
  add: { value(this: Sel, at: unknown, cols?: Record<string, number>): Material { return addPoints(this.source, at as never, cols); } },
  remove: { value(this: Sel, what: unknown): Material { return removePoints(this.source, what); } },
  thicken: { value(this: Sel, opts: ThickenOpts): Material { return thickenKernel(this, opts); } },
});

const EDGES: DomainKind = domainKind('edge', 'edges', {
  /** The ends of the members, each once, in row order. */
  points: { get(this: Sel) { return pointsOf(this.source, endpointRows(this), undefined, true); } },
  /** Itself. */
  edges: { get(this: Sel) { return this; } },
  /** The curves the members walk — junctions and open ends those of the
   * selected edges alone — read on first ask and kept. */
  curves: { get(this: Sel): Selection<Curve> { return curvesOfRows(this, this.source, this.members === null ? null : this.indices); } },
  /** Independent material of the members, their ends and both column
   * domains: the ends compacted in row order, the edges in this order
   * with their stored direction. */
  extract: { value(this: Sel): Material { return extractRows(this.source, endpointRows(this), this.indices); } },
  set: { value(this: Sel, ...args: unknown[]): Material { return setEdges(this.source, this.members, args); } },
  add: { value(this: Sel, rows: unknown, cols?: Record<string, number>): Material { return addEdges(this.source, rows, cols); } },
  remove: { value(this: Sel, what: unknown): Material { return removeEdges(this.source, what); } },
  thicken: { value(this: Sel, opts: ThickenOpts): Material { return thickenKernel(this, opts); } },
  // A resample or an along of the members answers rows of their material.
  resample: { value(this: Sel, opts: Parameters<Material['resample']>[0]): Material { return resampleMaterial(extractRows(this.source, endpointRows(this), this.indices), opts, { of: this.source, edges: this.indices }); } },
  trim: { value(this: Sel, opts: Parameters<Material['trim']>[0]): Material { return extractRows(this.source, endpointRows(this), this.indices).trim(opts); } },
  spline: { value(this: Sel, opts?: Parameters<Material['spline']>[0]): Material { return extractRows(this.source, endpointRows(this), this.indices).spline(opts); } },
  oscillate: { value(this: Sel, opts: Parameters<Material['oscillate']>[0]): Material { return extractRows(this.source, endpointRows(this), this.indices).oscillate(opts); } },
  along: { value(this: Sel, opts?: Parameters<Material['along']>[0]) { return alongMaterial(extractRows(this.source, endpointRows(this), this.indices), opts ?? {}, { of: this.source, edges: this.indices }); } },
  /** @internal Highest vertex degree within the members. The area
   * consumers refuse a branching value by it. */
  maxDegree: { value(this: Sel): number {
    const m = this.source;
    const degree = degreesWithin(m.n, this.indices, (e) => [m.edgeList[2 * e], m.edgeList[2 * e + 1]]);
    let best = 0;
    for (let i = 0; i < degree.length; i++) if (degree[i] > best) best = degree[i];
    return best;
  } },
  /** The closest member within `within` of `position`, or null. */
  nearest: { value(this: Sel, position: XY, opts: { within: number; excludeIncident?: Vertex | number }): NearestHit | null {
    return edgeQuery(this.source).nearest(position, this.members === null ? opts : { ...opts, accept: (e: number) => this.holds(e) });
  } },
  /** The first member a straight move would meet. */
  firstHit: { value(this: Sel, from: XY, to: XY, opts: { excludeIncident?: Vertex | number } = {}): FirstHit | null {
    return edgeQuery(this.source).firstHit(from, to, this.members === null ? opts : { ...opts, accept: (e: number) => this.holds(e) });
  } },
  /**
   * The members the straight segment `a` → `b` CROSSES: the segment passes
   * from one side of the edge to the other, and the edge from one side of
   * the segment to the other. Both sides are strict and the test is exact
   * (`orient2d`), so contact at an end, a move that stops on an edge, and a
   * segment lying along one are not crossings. Row order.
   */
  crossing: { value(this: Sel, a: XY, b: XY): Selection<Edge> {
    const m = this.source;
    const ax = vx(a);
    const ay = vy(a);
    const bx = vx(b);
    const by = vy(b);
    if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(bx) || !Number.isFinite(by)) return edgesOf(m, []);
    const half = Math.hypot(bx - ax, by - ay) / 2;
    if (!(half > 0)) return edgesOf(m, []);
    // A crossing point lies strictly inside the segment, so the edge it is
    // on is nearer the middle than half the length. The slack is for the
    // rounding in that distance, never for the judgement itself.
    const rows = edgeQuery(m).within([(ax + bx) / 2, (ay + by) / 2], half * (1 + 1e-9) + 1e-12);
    const out: number[] = [];
    for (const e of rows) {
      if (!this.holds(e)) continue;
      const p = m.edgeList[2 * e];
      const q = m.edgeList[2 * e + 1];
      const s0 = orient2d(ax, ay, bx, by, m.x[p], m.y[p]);
      const s1 = orient2d(ax, ay, bx, by, m.x[q], m.y[q]);
      if (!((s0 > 0 && s1 < 0) || (s0 < 0 && s1 > 0))) continue;
      const t0 = orient2d(m.x[p], m.y[p], m.x[q], m.y[q], ax, ay);
      const t1 = orient2d(m.x[p], m.y[p], m.x[q], m.y[q], bx, by);
      if (!((t0 > 0 && t1 < 0) || (t0 < 0 && t1 > 0))) continue;
      out.push(e);
    }
    return edgesOf(m, out, undefined, true);
  } },
});

/** @internal Copy the given point rows and edge rows of `m` into a fresh
 * material: every column of both domains, transfer policies, no history. */
export function extractRows(m: Material, pointRows: readonly number[], edgeRows: readonly number[]): Material {
  const s = m.store;
  const rowMap = new Map<number, number>();
  for (let k = 0; k < pointRows.length; k++) rowMap.set(pointRows[k], k);
  // An extracted row is the row it came from, so it keeps its identity: a
  // selection pulled out and grown is still made of the same points.
  const attrs: Record<string, Float64Array> = {};
  for (const name in s.attrs) attrs[name] = s.attrs[name].gather(pointRows);
  const edges = new Uint32Array(edgeRows.length * 2);
  for (let k = 0; k < edgeRows.length; k++) {
    const e = edgeRows[k];
    edges[2 * k] = rowMap.get(s.edgeList.get(2 * e))!;
    edges[2 * k + 1] = rowMap.get(s.edgeList.get(2 * e + 1))!;
  }
  const edgeAttrs: Record<string, Float64Array> = {};
  for (const name in s.edgeAttrs) edgeAttrs[name] = s.edgeAttrs[name].gather(edgeRows);
  const ids = { points: s.pointIds.gather(pointRows), edges: s.edgeIds.gather(edgeRows), edgeRoots: s.edgeRoots.gather(edgeRows) };
  return carryLinks(m, new Material(s.x.gather(pointRows), s.y.gather(pointRows), attrs, edges, { iteration: 0, history: [], edgeAttrs: edgeAttrs, transfers: { ...m.transfers }, edgeTransfers: { ...m.edgeTransfers }, ids, faceAttrs: m.faceAttrs, from: m, faces: m.stated }));
}

/**
 * What a `where` may be: a selection in any domain, or one face.
 */
export type Where = Selection<Vertex> | Selection<Edge> | Selection<Face> | Face;

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
  if (!isPointSelection(read) && !isEdgeSelection(read)) {
    throw new Error(`${who}: { where } must be a selection — of points, edges or faces — or one face`);
  }
  if (read.source !== m) {
    throw new Error(`${who}: { where } is a selection of another material — it names rows of a state this is not; name them in this one with m.points.intersect(sel) or m.edges.intersect(sel)`);
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
  const candidates = Number.isFinite(reach) ? edgeQuery(m).within([px, py], reach) : rowRange(m.edgeCount);
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
