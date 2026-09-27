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

import { at64, atU32, kinds, kindOf, type AnyColumn } from './column.js';
import { Material, alongMaterial, cached, inSpace3, resampleMaterial, splineMaterial, vertexReader, edgeReader, type Edge, type Vertex, type PointId, type EdgeId } from './material.js';
import { ownerOf, viewKind, valueKind, describe } from './views.js';
import { carryLinks } from './derivation.js';
import { degreesWithin } from './chains.js';
import { curvesOfRows, type Curve } from './curves.js';
import { thicken as thickenKernel, type ThickenOpts } from './thicken.js';
import { Selection, select, domainKind, isSelectionOf, rowRange, rowOf, memberRows, checkRadius, type Domain, type DomainKind, type Types } from './selection.js';
import { neighbours } from './forces.js';
import {
  addPoints, removePoints, setPoints, addEdges, removeEdges, setEdges,
  type CellValue, type ColumnValue, type EdgeEnd, type EdgeRowSpec, type PointEnd, type PointWhere, type EdgeWhere, type PointSetOpts, type EdgeSetOpts, type PointRecordSetOpts, type EdgeRecordSetOpts,
} from './tables.js';
import { vx, vy, type XY } from './vec.js';
import { edges as buildEdgeQuery, type EdgeQuery, type NearestHit, type FirstHit } from './query.js';
import { orient2d } from 'robust-predicates';
import { bucketStretch, type Space } from './space.js';
import type { Face } from './faces.js';
import { refuseShape } from './boundary.js';

/**
 * Do two states belong to one evolution? They do when they share any
 * identity at all: a point id, or an edge's lineage root. Every state a
 * `steps` makes from another keeps the ids of what it did not retire, an
 * extracted material keeps the ids of its rows, and a material that was
 * built on its own shares none — ids are minted once and never reused.
 * Asked once per pair: the answer is kept on both states.
 */
export function sameLineage(a: Material, b: Material): boolean {
  if (a === b) return true;
  // Two runs count their ids from the same place: a value one run made is
  // no row of another, whatever its numbers (material.ts `mintIds`).
  if (a.epoch !== b.epoch && a.epoch !== 0 && b.epoch !== 0) return false;
  const mine = pointDomain(a);
  let got = mine.lineage?.get(b);
  if (got === undefined) {
    got = shareIdentity(a, b);
    (mine.lineage ??= new WeakMap()).set(b, got);
    const theirs = pointDomain(b);
    (theirs.lineage ??= new WeakMap()).set(a, got);
  }
  return got;
}

/** `sameLineage`, worked out: an id of one in the other, or a root. */
function shareIdentity(a: Material, b: Material): boolean {
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

// ---- what a point or an edge selection answers, by type ----------------------------

/** The point write: a value or a function of the point, on these points or
 * those `where` names, with the options record last. */
export interface PointSet {
  (column: string, value: ColumnValue<Vertex>, where?: PointWhere, opts?: PointSetOpts): Material;
  (column: string, value: ColumnValue<Vertex>, opts: PointSetOpts): Material;
  (values: Record<string, ColumnValue<Vertex>>, where?: PointWhere, opts?: PointRecordSetOpts): Material;
  (values: Record<string, ColumnValue<Vertex>>, opts: PointRecordSetOpts): Material;
}
/** The edge write, as the point write. */
export interface EdgeSet {
  (column: string, value: ColumnValue<Edge>, where?: EdgeWhere, opts?: EdgeSetOpts): Material;
  (column: string, value: ColumnValue<Edge>, opts: EdgeSetOpts): Material;
  (values: Record<string, ColumnValue<Edge>>, where?: EdgeWhere, opts?: EdgeRecordSetOpts): Material;
  (values: Record<string, ColumnValue<Edge>>, opts: EdgeRecordSetOpts): Material;
}

/** @internal What a selection of vertices answers (see `ROW_TYPES`). */
export type PointTypes = Types<{
  owner: Material;
  points: Selection<Vertex>;
  edges: Selection<Edge>;
  curves: Selection<Curve>;
  extract: () => Material;
  set: PointSet;
  add: (at: XY | readonly [number, number, number] | PointEnd | Iterable<XY | readonly [number, number, number] | PointEnd> | undefined, cols?: Record<string, CellValue>) => Material;
  remove: (what: PointWhere) => Material;
  thicken: (opts: ThickenOpts) => Material;
}>;

/** @internal What a selection of edges answers (see `ROW_TYPES`). */
export type EdgeTypes = Types<{
  owner: Material;
  points: Selection<Vertex>;
  edges: Selection<Edge>;
  curves: Selection<Curve>;
  extract: () => Material;
  set: EdgeSet;
  add: (rows: EdgeRowSpec | EdgeEnd | readonly (EdgeRowSpec | EdgeEnd)[] | undefined, cols?: Record<string, CellValue>) => Material;
  remove: (what: EdgeWhere) => Material;
  thicken: (opts: ThickenOpts) => Material;
  resample: (opts: Parameters<Material['resample']>[0]) => Material;
  trim: (opts: Parameters<Material['trim']>[0]) => Material;
  spline: (opts?: Parameters<Material['spline']>[0]) => Material;
  oscillate: (opts: Parameters<Material['oscillate']>[0]) => Material;
  along: (opts?: Parameters<Material['along']>[0]) => ReturnType<Material['along']>;
}>;

// ---- the point domain ----------------------------------------------------------------

declare module './material.js' {
  interface StateCache {
    pointDomain?: PointDomain;
    edgeDomain?: EdgeDomain;
    edgeQuery?: EdgeQuery;
    /** How far any edge's geodesic strays from its chord (`geodesicBow`). */
    bow?: number;
  }
}

/** The refusal of anything that is not a point where one is named. */
export function notAPoint(who: string, v: unknown): Error {
  return new Error(`${who}: expected a point — a vertex view or a point value; make one with point(…) — got ${describe(v)}${viewKind(v) === 'edge' ? '; its ends are e.a and e.b' : ''}`);
}

/** The refusal of anything that is not an edge where one is named. */
export function notAnEdge(who: string, v: unknown): Error {
  return new Error(`${who}: expected an edge — an edge view or an edge value; make one with edge(…) — got ${describe(v)}${viewKind(v) === 'vertex' ? '; its edges are p.edges' : ''}`);
}

class PointDomain implements Domain<Vertex> {
  readonly kind: DomainKind = POINTS;
  readonly dense = true;
  private allRows: readonly number[] | null = null;
  /** The grid `near` reads, built on the first ask and kept: one for the
   * state, whatever radius each question asks with. */
  private index: ((p: XY, reach?: number) => number[]) | null = null;
  /** @internal Which states this one shares identity with (`sameLineage`),
   * asked once per pair. */
  lineage: WeakMap<Material, boolean> | undefined;
  constructor(readonly owner: Material) {}
  get size(): number { return this.owner.n; }
  all(): readonly number[] { return (this.allRows ??= rowRange(this.owner.n)); }
  valid(r: number): boolean { return r >= 0 && r < this.owner.n && Number.isInteger(r); }
  row(r: number): Vertex { return this.owner.vertex(r); }
  reader(count: number): (r: number) => Vertex { return vertexReader(this.owner, count); }
  keyOf(r: number): number { return at64(this.owner.store.pointIds, r); }
  rowOfKey(key: unknown): number { return this.owner.rowOfPoint(key as PointId); }
  locate(v: unknown, who: string): { domain: Domain<Vertex>; row: number } | { key: unknown } | null {
    if (v === undefined || v === null) return null;
    if (valueKind(v) === 'point') return { key: (v as { id: number }).id };
    if (viewKind(v) === 'vertex') return { domain: pointDomain(ownerOf(v as object) as Material), row: (v as Vertex).index };
    throw notAPoint(who, v);
  }
  shares(other: Domain<Vertex>): boolean { return sameLineage(this.owner, other.owner as Material); }
  neighbours(r: number): readonly number[] { return this.owner.adjacentRows(r); }
  near(p: unknown, r: number, who: string): { rows: readonly number[]; distances: ArrayLike<number> } {
    refuseShape(p, who);
    const radius = checkRadius(r, who);
    if (radius === 0) return { rows: [], distances: [] };
    const m = this.owner;
    const z = zColumn(m);
    const space = m.space;
    const flat = space === undefined || space.kind === 'euclidean';
    if (z !== null && !flat) throw inCurvedSpace(who);
    const px = vx(p as XY);
    const py = vy(p as XY);
    const pz = z !== null ? placeZ(p, who) : 0;
    if (z === null) placeFlat(p, who);
    const x = m.x;
    const y = m.y;
    // The candidates: the state's grid, asked with this radius as its
    // reach — or every row, for a radius that reaches every point, where
    // the grid has nothing to narrow. The radius is a length of the
    // material's space: the grid tests by the space's distance there, and
    // by the old coordinate arithmetic in the flat plane.
    const self = typeof p === 'object' && p !== null && ownerOf(p) === m ? (p as Vertex).index : -1;
    const every = this.covers(px, py, radius);
    const found = every ? this.everyRow(self) : (this.index ??= this.grid(radius))(p as XY, radius);
    const rows: number[] = [];
    const distances: number[] = [];
    if (z !== null) {
      // In space the distance is the straight one, z counted. The plane's
      // grid finds every candidate — a point nearer than the radius in
      // space is nearer than it in x and y — and each is judged in space.
      for (const j of found) {
        const d = Math.hypot(px - x[j], py - y[j], pz - z[j]);
        if (d < radius) {
          rows.push(j);
          distances.push(d);
        }
      }
      return { rows, distances };
    }
    const r2 = radius * radius;
    for (const j of found) {
      if (flat) {
        const dx = px - x[j];
        const dy = py - y[j];
        // The grid judged its rows already, by this same test.
        if (every && !(dx * dx + dy * dy < r2)) continue;
        rows.push(j);
        distances.push(Math.hypot(dx, dy));
      } else {
        rows.push(j);
        distances.push(space.distance([px, py], [x[j], y[j]]));
      }
    }
    return { rows, distances };
  }

  /** The grid over this state's points, made on the first `near` and kept:
   * in the flat plane, cells from the points' own extent — about one point
   * to a cell — which a radius of any size walks as many rings of as it
   * needs; in a curved space, cells of the first radius asked, a length of
   * the space, which a later radius widens or narrows. */
  private grid(radius: number): (p: XY, reach?: number) => number[] {
    const m = this.owner;
    if (m.space !== undefined && m.space.kind !== 'euclidean') return neighbours(m, { radius });
    const { w, h } = this.extent();
    const cell = Math.max(w, h) / Math.ceil(Math.sqrt(Math.max(1, m.n)));
    return neighbours(m, { radius: cell > 0 && Number.isFinite(cell) ? cell : radius });
  }

  /** Does a radius around (px, py) reach every point? A radius of
   * `Infinity` does, in any space. */
  private covers(px: number, py: number, radius: number): boolean {
    if (radius === Infinity) return true;
    const m = this.owner;
    if (m.space !== undefined && m.space.kind !== 'euclidean') return false;
    const b = this.extent();
    const dx = Math.max(Math.abs(px - b.x), Math.abs(px - (b.x + b.w)));
    const dy = Math.max(Math.abs(py - b.y), Math.abs(py - (b.y + b.h)));
    return Math.hypot(dx, dy) < radius;
  }

  /** Every row but `self`, in row order. */
  private everyRow(self: number): number[] {
    const out: number[] = [];
    for (let j = 0; j < this.owner.n; j++) if (j !== self) out.push(j);
    return out;
  }

  /** The box of the points (all zero for none, or for a place that is not
   * finite), worked out once. */
  private box: { x: number; y: number; w: number; h: number } | null = null;
  private extent(): { x: number; y: number; w: number; h: number } {
    if (this.box !== null) return this.box;
    const m = this.owner;
    const X = m.x;
    const Y = m.y;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < m.n; i++) {
      if (X[i] < x0) x0 = X[i];
      if (X[i] > x1) x1 = X[i];
      if (Y[i] < y0) y0 = Y[i];
      if (Y[i] > y1) y1 = Y[i];
    }
    const finite = Number.isFinite(x0) && Number.isFinite(x1) && Number.isFinite(y0) && Number.isFinite(y1);
    return (this.box = finite ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : { x: 0, y: 0, w: 0, h: 0 });
  }
}

// ---- the edge domain -----------------------------------------------------------------

class EdgeDomain implements Domain<Edge> {
  readonly kind: DomainKind = EDGES;
  readonly dense = true;
  private allRows: readonly number[] | null = null;
  constructor(readonly owner: Material) {}
  get size(): number { return this.owner.edgeCount; }
  all(): readonly number[] { return (this.allRows ??= rowRange(this.owner.edgeCount)); }
  valid(r: number): boolean { return r >= 0 && r < this.owner.edgeCount && Number.isInteger(r); }
  row(r: number): Edge { return this.owner.edge(r); }
  reader(count: number): (r: number) => Edge { return edgeReader(this.owner, count); }
  keyOf(r: number): number { return at64(this.owner.store.edgeIds, r); }
  rowOfKey(key: unknown): number { return this.owner.rowOfEdge(key as EdgeId); }
  locate(v: unknown, who: string): { domain: Domain<Edge>; row: number } | { key: unknown } | null {
    if (v === undefined || v === null) return null;
    if (valueKind(v) === 'edge') return { key: (v as { id: number }).id };
    if (viewKind(v) === 'edge') return { domain: edgeDomain(ownerOf(v as object) as Material), row: (v as Edge).index };
    throw notAnEdge(who, v);
  }
  shares(other: Domain<Edge>): boolean { return sameLineage(this.owner, other.owner as Material); }
  /** Every edge that meets this one at a vertex, this one excluded, each
   * once: the edges at its `a` end, then the new ones at its `b` end. */
  neighbours(e: number): number[] {
    const m = this.owner;
    const list = m.store.edgeList;
    const out: number[] = [];
    for (const f of m.incidentEdgeRows(atU32(list, 2 * e))) if (f !== e) out.push(f);
    const atA = out.length;
    for (const f of m.incidentEdgeRows(atU32(list, 2 * e + 1))) {
      // A ring of two meets its partner at both ends: once is enough.
      if (f !== e && out.lastIndexOf(f, atA - 1) < 0) out.push(f);
    }
    return out;
  }
  near(p: unknown, r: number, who: string): { rows: readonly number[]; distances: ArrayLike<number> } {
    refuseShape(p, who);
    const radius = checkRadius(r, who);
    if (radius === 0) return { rows: [], distances: [] };
    const m = this.owner;
    const space = m.space;
    const px = vx(p as XY);
    const py = vy(p as XY);
    const z = zColumn(m);
    if (z !== null) {
      if (space !== undefined && space.kind !== 'euclidean') throw inCurvedSpace(who);
      // As for points: the plane's grid finds every candidate (a segment is
      // no farther in x and y than in space), and each is judged by the
      // straight distance to the whole segment in space.
      const pz = placeZ(p, who);
      const rows: number[] = [];
      const distances: number[] = [];
      for (const e of edgeQuery(m).within([px, py], radius)) {
        const a = m.edgeList[2 * e];
        const b = m.edgeList[2 * e + 1];
        const d = segmentDistance3(px, py, pz, m.x[a], m.y[a], z[a], m.x[b], m.y[b], z[b]);
        if (d < radius) {
          rows.push(e);
          distances.push(d);
        }
      }
      return { rows, distances };
    }
    placeFlat(p, who);
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

/** The `z` numbers of a value in space, or null for a value in the plane. */
function zColumn(m: Material): Float64Array | null {
  return inSpace3(m) ? m.attrs.z : null;
}

/** The third number of a place a question about a value in space asks
 * with: `[x, y, z]`, `{ x, y, z }` or a point of a value in space. */
function placeZ(p: unknown, who: string): number {
  const z = Array.isArray(p) ? p[2] : typeof p === 'object' && p !== null ? (p as { z?: unknown }).z : undefined;
  if (typeof z !== 'number' || !Number.isFinite(z)) throw new Error(`${who}: this value is in space — ask with a place in space: [x, y, z], { x, y, z } or a point of a value in space`);
  return z;
}

/** A question about a value in the plane asks with a place in the plane:
 * a place in space is refused by name, not read as its shadow. */
function placeFlat(p: unknown, who: string): void {
  const z = Array.isArray(p) ? p[2] : typeof p === 'object' && p !== null ? (p as { z?: unknown }).z : undefined;
  if (z !== undefined) throw new Error(`${who}: this value is in the plane — ask with a place in the plane: [x, y], { x, y } or a point of a value in the plane; [x, y, z] is a place in space`);
}

const inCurvedSpace = (who: string): Error =>
  new Error(`${who}: a value with a z is measured straight in space — it cannot also lie in a curved space of the plane`);

/** The straight distance from `p` to the segment `a`–`b`, in space. */
function segmentDistance3(px: number, py: number, pz: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const wx = px - ax;
  const wy = py - ay;
  const wz = pz - az;
  const l = dx * dx + dy * dy + dz * dz;
  const t = l > 0 ? Math.max(0, Math.min(1, (wx * dx + wy * dy + wz * dz) / l)) : 0;
  return Math.hypot(wx - t * dx, wy - t * dy, wz - t * dz);
}

/** @internal The point domain of a material, made once per state. */
export function pointDomain(m: Material): PointDomain {
  return cached(m, 'pointDomain', () => new PointDomain(m));
}
/** @internal The edge domain of a material, made once per state. */
export function edgeDomain(m: Material): EdgeDomain {
  return cached(m, 'edgeDomain', () => new EdgeDomain(m));
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

type Sel = Selection<any> & { readonly owner: Material };

/** The edges whose BOTH ends a point selection holds, row order. */
function edgeRowsAmong(sel: Sel): readonly number[] {
  const m = sel.owner;
  return sel.members === null ? edgeDomain(m).all() : edgesAmong(m, (r) => sel.holds(r));
}

/** @internal The ends of the selected edges, each once, row order. A
 * mark per row for the whole collection; a set for a few edges, so a face's
 * corners never cost a pass over every point. */
export function endpointRows(sel: Selection<Edge>): number[] {
  const m = sel.owner as Material;
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
  edges: { get(this: Sel) { return edgesOf(this.owner, this.members === null ? null : edgeRowsAmong(this), undefined, true); } },
  /** The chains through these points: the curves of the edges among them,
   * read on first ask and kept. `strokes(sel)` draws what the members are
   * connected by. */
  curves: { get(this: Sel): Selection<Curve> { return curvesOfRows(this, this.owner, this.members === null ? null : edgeRowsAmong(this)); } },
  /** Independent material of the members in this order and every point
   * column, with NO edges (`sel.edges.extract()` keeps them). */
  extract: { value(this: Sel): Material { return extractRows(this.owner, this.indices, []); } },
  set: { value(this: Sel, ...args: unknown[]): Material { return setPoints(this, args); } },
  add: { value(this: Sel, at: unknown, cols?: Record<string, CellValue>): Material { return addPoints(this.owner, at as never, cols); } },
  remove: { value(this: Sel, what: unknown): Material { return removePoints(this.owner, what); } },
  thicken: { value(this: Sel, opts: ThickenOpts): Material { return thickenKernel(this, opts); } },
});

const EDGES: DomainKind = domainKind('edge', 'edges', {
  /** The ends of the members, each once, in row order. */
  points: { get(this: Sel) { return pointsOf(this.owner, endpointRows(this), undefined, true); } },
  /** Itself. */
  edges: { get(this: Sel) { return this; } },
  /** The curves the members walk — junctions and open ends those of the
   * selected edges alone — read on first ask and kept. */
  curves: { get(this: Sel): Selection<Curve> { return curvesOfRows(this, this.owner, this.members === null ? null : this.indices); } },
  /** Independent material of the members, their ends and both column
   * domains: the ends compacted in row order, the edges in this order
   * with their stored direction. */
  extract: { value(this: Sel): Material { return extractRows(this.owner, endpointRows(this), this.indices); } },
  set: { value(this: Sel, ...args: unknown[]): Material { return setEdges(this, args); } },
  add: { value(this: Sel, rows: unknown, cols?: Record<string, CellValue>): Material { return addEdges(this.owner, rows, cols); } },
  remove: { value(this: Sel, what: unknown): Material { return removeEdges(this.owner, what); } },
  thicken: { value(this: Sel, opts: ThickenOpts): Material { return thickenKernel(this, opts); } },
  // A resample, a spline or an along of the members answers rows of their material.
  resample: { value(this: Sel, opts: Parameters<Material['resample']>[0]): Material { return resampleMaterial(extractRows(this.owner, endpointRows(this), this.indices), opts, { of: this.owner, edges: this.indices }); } },
  trim: { value(this: Sel, opts: Parameters<Material['trim']>[0]): Material { return extractRows(this.owner, endpointRows(this), this.indices).trim(opts); } },
  spline: { value(this: Sel, opts?: Parameters<Material['spline']>[0]): Material { return splineMaterial(extractRows(this.owner, endpointRows(this), this.indices), opts ?? {}, { of: this.owner, edges: this.indices }); } },
  oscillate: { value(this: Sel, opts: Parameters<Material['oscillate']>[0]): Material { return extractRows(this.owner, endpointRows(this), this.indices).oscillate(opts); } },
  along: { value(this: Sel, opts?: Parameters<Material['along']>[0]) { return alongMaterial(extractRows(this.owner, endpointRows(this), this.indices), opts ?? {}, { of: this.owner, edges: this.indices }); } },
  /** @internal Highest vertex degree within the members. The area
   * consumers refuse a branching value by it. */
  maxDegree: { value(this: Sel): number {
    const m = this.owner;
    const degree = degreesWithin(m.n, this.indices, (e) => [m.edgeList[2 * e], m.edgeList[2 * e + 1]]);
    let best = 0;
    for (let i = 0; i < degree.length; i++) if (degree[i] > best) best = degree[i];
    return best;
  } },
  /** The closest member within `within` of `position`, or null. */
  nearest: { value(this: Sel, position: XY, opts: { within: number; excludeIncident?: PointEnd }): NearestHit | null {
    return edgeQuery(this.owner).nearest(position, queryOpts(this, opts, 'edges.nearest') as { within: number });
  } },
  /** The first member a straight move would meet. */
  firstHit: { value(this: Sel, from: XY, to: XY, opts: { excludeIncident?: PointEnd } = {}): FirstHit | null {
    return edgeQuery(this.owner).firstHit(from, to, queryOpts(this, opts, 'edges.firstHit'));
  } },
  /**
   * The members the straight segment `a` → `b` CROSSES: the segment passes
   * from one side of the edge to the other, and the edge from one side of
   * the segment to the other. Both sides are strict and the test is exact
   * (`orient2d`), so contact at an end, a move that stops on an edge, and a
   * segment lying along one are not crossings. Row order.
   */
  crossing: { value(this: Sel, a: XY, b: XY): Selection<Edge> {
    const m = this.owner;
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

/** The options an edge query reads: the vertex whose edges it skips, found
 * by identity as `has` finds it — a vertex of this state or of another of
 * the same evolution, or a point value; one that is gone skips nothing —
 * and the members a selection holds. */
function queryOpts<O extends { excludeIncident?: PointEnd }>(sel: Sel, opts: O, who: string): Omit<O, 'excludeIncident'> & { excludeIncident?: number; accept?: (e: number) => boolean } {
  const { excludeIncident, ...rest } = opts ?? ({} as O);
  const out: Omit<O, 'excludeIncident'> & { excludeIncident?: number; accept?: (e: number) => boolean } = rest;
  if (excludeIncident !== undefined) {
    const v = rowOf(pointDomain(sel.owner), excludeIncident, `${who}: excludeIncident`);
    if (v >= 0) out.excludeIncident = v;
  }
  if (sel.members !== null) out.accept = (e: number) => sel.holds(e);
  return out;
}

/** @internal Copy the given point rows and edge rows of `m` into a fresh
 * material: every column of both domains, transfer policies, no history. */
export function extractRows(m: Material, pointRows: readonly number[], edgeRows: readonly number[]): Material {
  const s = m.store;
  const rowMap = new Map<number, number>();
  for (let k = 0; k < pointRows.length; k++) rowMap.set(pointRows[k], k);
  // An extracted row is the row it came from, so it keeps its identity: a
  // selection pulled out and grown is still made of the same points.
  const attrs: Record<string, AnyColumn> = {};
  for (const name in s.attrs) attrs[name] = kindOf(s.attrs[name]).of(s.attrs[name].gather(pointRows));
  const edges = new Uint32Array(edgeRows.length * 2);
  for (let k = 0; k < edgeRows.length; k++) {
    const e = edgeRows[k];
    edges[2 * k] = rowMap.get(s.edgeList.get(2 * e))!;
    edges[2 * k + 1] = rowMap.get(s.edgeList.get(2 * e + 1))!;
  }
  const edgeAttrs: Record<string, AnyColumn> = {};
  for (const name in s.edgeAttrs) edgeAttrs[name] = kindOf(s.edgeAttrs[name]).of(s.edgeAttrs[name].gather(edgeRows));
  const ids = { points: s.pointIds.gather(pointRows), edges: s.edgeIds.gather(edgeRows), edgeRoots: s.edgeRoots.gather(edgeRows) };
  const keys = {
    points: s.pointKeys === null ? null : kinds.string.of(s.pointKeys.gather(pointRows)),
    edges: s.edgeKeys === null ? null : kinds.string.of(s.edgeKeys.gather(edgeRows)),
  };
  return carryLinks(m, new Material(s.x.gather(pointRows), s.y.gather(pointRows), attrs, edges, { iteration: 0, history: [], edgeAttrs: edgeAttrs, transfers: { ...m.transfers }, edgeTransfers: { ...m.edgeTransfers }, ids, keys, faceAttrs: m.faceAttrs, from: m, faces: m.stated }));
}

/**
 * What a `where` may be: a selection in any domain, one face, or a list of
 * rows — views or values of points, edges or faces.
 */
export type Where = Selection<Vertex> | Selection<Edge> | Selection<Face> | Face | readonly (PointEnd | EdgeEnd | Face)[];

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
 * selection, or one face, gives its corners and its edges. A list of rows
 * is the selection `rows` makes of it in this material: its members found
 * by identity, a gone one skipped.
 *
 * `undefined` is the whole material, which is what every verb did before
 * there was a way to say otherwise.
 */
export function eligibleRows(
  m: Material,
  where: Where | undefined,
  domain: 'points' | 'edges',
  who: string,
): ReadonlySet<number> | null {
  if (where === undefined) return null;
  const given = Array.isArray(where) ? listed(m, where, who) : where;
  const read = typeof given === 'object' && given !== null ? (given as { points?: unknown; edges?: unknown })[domain] : undefined;
  if (!isPointSelection(read) && !isEdgeSelection(read)) {
    throw new Error(`${who}: { where } must be a selection — of points, edges or faces — one face, or a list of rows`);
  }
  if (read.owner !== m) {
    throw new Error(`${who}: { where } is a selection of another material — it names rows of a state this is not; name them in this one with m.points.intersect(sel) or m.edges.intersect(sel)`);
  }
  return new Set(read.indices);
}

/** A list of rows as the selection of `m` that `rows` makes of it: points,
 * edges or faces by what its first member is. */
function listed(m: Material, list: readonly unknown[], who: string): Selection<unknown> {
  const first = list.find((v) => v !== undefined && v !== null);
  const kind = viewKind(first) ?? valueKind(first);
  const d: Domain<unknown> = (kind === 'edge' ? m.edges : kind === 'face' ? m.faces : m.points).domain;
  return select(d, memberRows(d, list, who));
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
function geodesicBow(m: Material, space: Space): number {
  if (m.cache.bow !== undefined) return m.cache.bow;
  let bow = 0;
  for (let e = 0; e < m.edgeCount; e++) {
    const a: [number, number] = [m.x[m.edgeList[2 * e]], m.y[m.edgeList[2 * e]]];
    const b: [number, number] = [m.x[m.edgeList[2 * e + 1]], m.y[m.edgeList[2 * e + 1]]];
    const mid = space.geodesic(a, b, 0.5);
    const off = Math.hypot(mid[0] - (a[0] + b[0]) / 2, mid[1] - (a[1] + b[1]) / 2);
    if (Number.isFinite(off) && off > bow) bow = off;
  }
  return (m.cache.bow = 1.5 * bow);
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
  return cached(m, 'edgeQuery', () => buildEdgeQuery(m));
}
