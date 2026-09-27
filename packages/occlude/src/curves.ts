/**
 * The ordered domain: a geometry's curves.
 *
 * `g.curves` is the walk over two facts a geometry already stores — the
 * direction of each edge row (`a` to `b`) and the order of the rows — and
 * it is a domain like `points` and `edges`: a `Selection` of rows, read on
 * first ask and kept on the value. The walk is chains.ts: a chain starts
 * at an endpoint or a junction and runs the way its edges run — from the
 * end its edges leave (a chain whose edges disagree starts at its
 * lower-row end) — through the points two edges meet; a ring starts where
 * its oldest edge lineage starts and runs that lineage's way. Every write
 * keeps both facts — an add puts rows at the end, a remove keeps the order
 * of the rest, a split puts its two children in the parent's direction and
 * keeps the parent's lineage — so a curve keeps its direction, and a ring
 * its seam, under every write.
 *
 * A curve row answers `points` (its point rows in walk order), `edges` (in
 * walk order), `closed`, `length` (in the geometry's space), `contours()`
 * (a ring is an area), and every edge column its edges agree on (`level`,
 * `cut`, `key`), read on the row. On each of its points the domain DERIVES
 * `s` (the arc length from the start), `u` (its fraction of the whole),
 * `heading` (radians), `tangent` and `normal` — read like columns. A
 * point that holds a column `s`, `u` or `heading` of its own reads that on
 * every view of it, the curve's included, so one row never has two
 * answers. `normal` is `perp(tangent)`, the
 * tangent turned a quarter turn toward +y: on a ring drawn
 * counter-clockwise ON THE SHEET (y down) it points out.
 *
 * The chain consumers — `strokes`, `stroke`, the area readers, the chain
 * verbs — read the rows' kernel records here (`chainsOf`, `chainRecordsOf`)
 * and never build a row they do not need: `strokes` reads `curves` on every
 * material it draws.
 */

import { Column, at64, valueAt } from './column.js';
import { Material, cached, geodesicEdges, vertexView, typedCell, type Edge, type Vertex } from './material.js';
import { walkChains, type Chain } from './chains.js';
import { Selection, select, domainKind, rowRange, isSelectionOf, ROW_TYPES, type Domain, type DomainKind, type Types } from './selection.js';
import { pointDomain, edgesOf, pointsOf, extractRows, endpointRows, sameLineage } from './relation.js';
import { describe } from './views.js';
import type { IsoContour } from './isolines.js';
import type { Space } from './space.js';

export type { Chain } from './chains.js';

/** @internal What a selection of curves answers (see `ROW_TYPES`). */
export type CurveTypes = Types<{
  owner: Material;
  points: Selection<Vertex>;
  edges: Selection<Edge>;
  curves: Selection<Curve>;
  contours: () => IsoContour[];
  extract: () => Material;
}>;

/**
 * One curve of a geometry: a maximal chain of its edges, in walk order.
 * Its edge columns that every edge agrees on read on the row (`c.level`);
 * a column the edges disagree on is absent.
 */
export interface Curve {
  /** This curve's row in `g.curves`. */
  readonly index: number;
  /** Its points in walk order — a ring lists each once — each with the
   * derived columns `s`, `u`, `heading`, `tangent` and `normal`. */
  readonly points: Selection<Vertex>;
  /** Its edges in walk order: edge `k` joins point `k` to point `k + 1`
   * (a ring's closing edge last). */
  readonly edges: Selection<Edge>;
  /** True for a ring. */
  readonly closed: boolean;
  /** Its arc length, in the geometry's space. */
  readonly length: number;
  /** The area it bounds: one contour for a ring, none for an open chain. */
  contours(): IsoContour[];
  readonly [ROW_TYPES]?: CurveTypes;
  /** The edge columns its edges agree on. */
  readonly [column: string]: any;
}

/** The names a curve row owns; an edge column of one of these names is
 * read on the edges only. */
const CURVE_WORDS: ReadonlySet<string> = new Set(['index', 'points', 'edges', 'closed', 'length', 'contours']);

/** Where a curve row came from: its table and its row there. */
const home = new WeakMap<object, { table: CurveTable; r: number }>();

/** @internal Is `v` a curve row? */
export const isCurveRow = (v: unknown): v is Curve => typeof v === 'object' && v !== null && home.has(v);

// ---- arc length and the frame along a chain -------------------------------------------

/** @internal Cumulative arc length at every vertex of a polyline, the seam
 * segment last on a ring. With a curved `space` each step is the space's
 * own distance; the flat plane sums the literal hypotenuse. */
export function chainLengths(pts: readonly (readonly [number, number])[], closed: boolean, space?: Space): number[] {
  const n = pts.length;
  const segs = closed ? n : n - 1;
  const cum = [0];
  const curved = space !== undefined && space.kind !== 'euclidean' ? space : null;
  for (let s = 0; s < segs; s++) {
    const a = pts[s];
    const b = pts[(s + 1) % n];
    cum.push(cum[s] + (curved ? curved.distance(a, b) : Math.hypot(b[0] - a[0], b[1] - a[1])));
  }
  return cum;
}

/**
 * @internal The unit tangent along a polyline. At a vertex it is the
 * bisector of the segments that meet there (an open end has one); inside a
 * segment, the segment's own direction. In a curved space a direction
 * belongs to the point it is taken at: the one `log` answers there, toward
 * the vertex ahead (or away from the one behind).
 */
export function chainTangents(pts: readonly (readonly [number, number])[], closed: boolean, space?: Space): {
  atVertex(v: number): [number, number];
  at(seg: number, t: number, here: readonly [number, number] | null): [number, number];
} {
  const n = pts.length;
  const segs = closed ? n : n - 1;
  const curved = space !== undefined && space.kind !== 'euclidean' ? space : null;
  const dir = (sg: number): [number, number] => {
    const a = pts[sg];
    const b = pts[(sg + 1) % n];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return len > 0 ? [(b[0] - a[0]) / len, (b[1] - a[1]) / len] : [1, 0];
  };
  const tangentAtVertex = (v: number): [number, number] => {
    const hasPrev = closed || v > 0;
    const hasNext = closed || v < segs;
    const before = hasPrev ? dir((v - 1 + segs) % segs) : null;
    const after = hasNext ? dir(v % segs) : null;
    if (!before) return after!;
    if (!after) return before;
    const sx = before[0] + after[0];
    const sy = before[1] + after[1];
    const len = Math.hypot(sx, sy);
    return len > 1e-9 ? [sx / len, sy / len] : after; // a hairpin: carry on
  };
  const unit = (v: readonly number[], sign = 1): [number, number] | null => {
    const len = Math.hypot(v[0], v[1]);
    return len > 0 ? [(sign * v[0]) / len, (sign * v[1]) / len] : null;
  };
  const logTangentAtVertex = (sp: Space, v: number): [number, number] => {
    const here = pts[v % n];
    const hasPrev = closed || v > 0;
    const hasNext = closed || v < segs;
    const before = hasPrev ? unit(sp.log(here, pts[(v - 1 + n) % n]), -1) : null;
    const after = hasNext ? unit(sp.log(here, pts[(v + 1) % n])) : null;
    if (!before) return after ?? [1, 0];
    if (!after) return before;
    const sx = before[0] + after[0];
    const sy = before[1] + after[1];
    const len = Math.hypot(sx, sy);
    return len > 1e-9 ? [sx / len, sy / len] : after; // a hairpin: carry on
  };
  return {
    atVertex: (v) => (curved ? logTangentAtVertex(curved, v) : tangentAtVertex(v)),
    at(seg, t, here) {
      if (t <= 1e-9) return curved ? logTangentAtVertex(curved, seg) : tangentAtVertex(seg);
      if (t >= 1 - 1e-9) return curved ? logTangentAtVertex(curved, seg + 1) : tangentAtVertex(seg + 1);
      if (!curved) return dir(seg);
      const at = here ?? pts[seg];
      return unit(curved.log(at, pts[(seg + 1) % n])) ?? unit(curved.log(at, pts[seg]), -1) ?? [1, 0];
    },
  };
}

// ---- the table -------------------------------------------------------------------------

/**
 * @internal The curves of one geometry state — every edge, or the edges of
 * one selection — as a selection domain. Built on the first read and kept:
 * the chains, then each row the first time it is asked for.
 */
export class CurveTable implements Domain<Curve> {
  readonly kind: DomainKind = CURVES;
  readonly dense = true;
  private readonly rows: (Curve | undefined)[];
  private readonly pointSels: (Selection<Vertex> | undefined)[];
  private allRows: readonly number[] | null = null;
  private keys: Map<string, number> | null = null;
  private ends: Map<number, number[]> | null = null;
  constructor(readonly owner: Material, readonly chains: readonly Chain[]) {
    this.rows = new Array(chains.length);
    this.pointSels = new Array(chains.length);
  }
  get size(): number { return this.chains.length; }
  all(): readonly number[] { return (this.allRows ??= rowRange(this.chains.length)); }
  valid(r: number): boolean { return Number.isInteger(r) && r >= 0 && r < this.chains.length; }
  row(r: number): Curve { return (this.rows[r] ??= curveRow(this, r)); }

  /** A curve is the set of edges it walks: the same edges, by id, name the
   * same curve in another state; a curve whose edges were split or cut
   * away names nothing there. */
  keyOf(r: number): string {
    const ids = this.owner.store.edgeIds;
    const keys = Array.from(this.chains[r].edges, (e) => at64(ids, e));
    return keys.sort((a, b) => a - b).join(',');
  }
  rowOfKey(key: unknown): number {
    if (this.keys === null) {
      this.keys = new Map();
      for (let k = 0; k < this.chains.length; k++) this.keys.set(this.keyOf(k), k);
    }
    return this.keys.get(key as string) ?? -1;
  }
  locate(v: unknown, who: string): { domain: Domain<Curve>; row: number } | null {
    if (v === undefined || v === null) return null;
    const own = typeof v === 'object' ? home.get(v) : undefined;
    if (!own) throw new Error(`${who}: expected a curve — a row of g.curves — got ${describe(v)}`);
    return { domain: own.table, row: own.r };
  }
  shares(other: Domain<Curve>): boolean {
    return sameLineage(this.owner, other.owner as Material);
  }
  /** The curves that share an end with this one: a junction, or the
   * point where a ring leaves its junction. */
  neighbours(r: number): readonly number[] {
    if (this.ends === null) {
      const ends = new Map<number, number[]>();
      this.chains.forEach((c, k) => {
        for (const v of new Set([c.indices[0], c.indices[c.indices.length - 1]])) {
          const list = ends.get(v);
          if (list) list.push(k);
          else ends.set(v, [k]);
        }
      });
      this.ends = ends;
    }
    const c = this.chains[r];
    const out = new Set<number>();
    for (const v of [c.indices[0], c.indices[c.indices.length - 1]]) for (const k of this.ends.get(v) ?? []) if (k !== r) out.add(k);
    return [...out];
  }

  /** @internal The points of curve `r`, in walk order, with its derived
   * columns: a point selection of the geometry whose rows read `s`, `u`
   * and `heading` along this curve. */
  pointsOf(r: number): Selection<Vertex> {
    const got = this.pointSels[r];
    if (got) return got;
    const c = this.chains[r];
    const m = this.owner;
    const space = m.space;
    const cum = chainLengths(c.pts, c.closed, space);
    const total = cum[cum.length - 1];
    const frames = chainTangents(c.pts, c.closed, space);
    const at = new Map<number, number>();
    c.indices.forEach((v, k) => at.set(v, k));
    const heading = new Float64Array(c.indices.length);
    for (let k = 0; k < c.indices.length; k++) {
      const t = frames.atVertex(k);
      heading[k] = Math.atan2(t[1], t[0]);
    }
    // The material's point domain, read along this curve: every word a
    // point selection has, and the rows carry the curve's own columns.
    // One view per row here too, kept: `===` names a point of the curve.
    const base = pointDomain(m);
    const cols = m.store.attrs;
    const along = Object.create(base) as typeof base;
    const views = new Map<number, Vertex>();
    Object.defineProperty(along, 'row', {
      value(v: number): Vertex {
        let view = views.get(v);
        if (view !== undefined) return view;
        const p = vertexView(m, v) as Record<string, number | undefined>;
        const k = at.get(v);
        if (k !== undefined) {
          // A column the point holds of one of these names — a sketch's,
          // or the one `along` stores — is what it reads on every view of
          // it, so one row has one answer; the curve gives the ones it
          // does not hold.
          if (!('s' in cols)) p.s = cum[k];
          if (!('u' in cols)) p.u = total > 0 ? cum[k] / total : 0;
          if (!('heading' in cols)) p.heading = heading[k];
        }
        view = Object.freeze(p) as Vertex;
        views.set(v, view);
        return view;
      },
    });
    return (this.pointSels[r] = select(along, c.indices, undefined, true));
  }
}

/** @internal The walk over some edge rows of `m` (all of them: null). */
export function walkOf(m: Material, edgeRows: ArrayLike<number> | null): Chain[] {
  let rows = edgeRows;
  if (rows === null) {
    const all = new Uint32Array(m.edgeCount);
    for (let e = 0; e < all.length; e++) all[e] = e;
    rows = all;
  }
  const list = m.edgeList;
  const roots = m.store.edgeRoots;
  return walkChains({
    vertexCount: m.n,
    edgeRows: rows,
    endpoints: (e) => [list[2 * e], list[2 * e + 1]],
    root: (e) => at64(roots, e),
    x: m.x,
    y: m.y,
    geodesic: geodesicEdges(m),
  });
}

declare module './material.js' {
  interface StateCache { curveTable?: CurveTable; curves?: Selection<Curve> }
}

/** @internal The curve table of every edge of `m`, made on the first read
 * and kept on the state. */
export function curveTable(m: Material): CurveTable {
  return cached(m, 'curveTable', () => new CurveTable(m, walkOf(m, null)));
}

/** @internal The chains of every edge of `m`, in curve order: the kernel
 * records the chain verbs read. Kept on the state; never mutate them. */
export function chainsOf(m: Material): readonly Chain[] {
  return curveTable(m).chains;
}

/** @internal `m.curves`: every curve of the state, in row order. */
export function curvesOf(m: Material): Selection<Curve> {
  return cached(m, 'curves', () => select(curveTable(m), null));
}

/** The curves some edge rows of `m` walk, as a selection of their own
 * table: what an edge, point or face selection `sel` answers for `curves`,
 * made on the first read and kept on the selection. */
export function curvesOfRows(sel: Selection<unknown>, m: Material, edgeRows: readonly number[] | null): Selection<Curve> {
  const box = sel.box;
  return (box.curves ??= edgeRows === null ? curvesOf(m) : select(new CurveTable(m, walkOf(m, edgeRows)), null)) as Selection<Curve>;
}

// ---- the row ---------------------------------------------------------------------------

const CURVE_PROTO = Object.freeze(Object.create(Object.prototype, {
  points: {
    get(this: Curve) { const h = home.get(this)!; return h.table.pointsOf(h.r); },
    enumerable: false,
  },
  edges: {
    get(this: Curve) { const h = home.get(this)!; return edgesOf(h.table.owner, Array.from(h.table.chains[h.r].edges), undefined, true); },
    enumerable: false,
  },
  contours: {
    value(this: Curve): IsoContour[] { const h = home.get(this)!; return contourOf(h.table.chains[h.r]); },
    enumerable: false,
  },
}) as object);

function curveRow(table: CurveTable, r: number): Curve {
  const c = table.chains[r];
  const m = table.owner;
  const row = Object.create(CURVE_PROTO) as Record<string, unknown>;
  // The edge columns every edge of the curve agrees on, first, so the
  // row's own words win over a column of the same name.
  for (const name of m.store.edgeAttrNames) {
    if (CURVE_WORDS.has(name) || c.edges.length === 0) continue;
    const col = m.store.edgeAttrs[name];
    if (!(col instanceof Column)) {
      // A column of another kind agrees by its kind's equality, and reads
      // on the curve as it reads on an edge.
      const kind = col.kind as { equal(a: unknown, b: unknown): boolean };
      const first = valueAt(col, c.edges[0]);
      let same = true;
      for (let k = 1; k < c.edges.length && same; k++) same = kind.equal(valueAt(col, c.edges[k]), first);
      if (same) typedCell(m, row, name, col, c.edges[0]);
      continue;
    }
    const v = at64(col, c.edges[0]);
    let same = true;
    for (let k = 1; k < c.edges.length && same; k++) same = at64(col, c.edges[k]) === v;
    if (same) row[name] = v;
  }
  row.index = r;
  row.closed = c.closed;
  const cum = chainLengths(c.pts, c.closed, m.space);
  row.length = cum[cum.length - 1];
  home.set(row, { table, r });
  return Object.freeze(row) as unknown as Curve;
}

/** @internal A ring as the one contour record of its area; an open chain
 * bounds nothing. */
function contourOf(c: Chain): IsoContour[] {
  if (!c.closed) return [];
  return [c.geodesic ? { pts: c.pts.map((p) => [p[0], p[1]] as [number, number]), closed: true, geodesic: c.geodesic } : { pts: c.pts.map((p) => [p[0], p[1]] as [number, number]), closed: true }];
}

// ---- the kind --------------------------------------------------------------------------

type CurveSel = Selection<Curve> & { readonly domain: CurveTable };

/** The edge rows of a curve selection's members, in their order. */
function memberEdges(sel: CurveSel): number[] {
  const out: number[] = [];
  for (const r of sel.indices) for (const e of sel.domain.chains[r].edges) out.push(e);
  return out;
}

const CURVES: DomainKind = domainKind('curve', 'curves', {
  /** The points of the members, each once, curve by curve in walk order. */
  points: { get(this: CurveSel) {
    const rows: number[] = [];
    const seen = new Set<number>();
    for (const r of this.indices) {
      for (const v of this.domain.chains[r].indices) {
        if (seen.has(v)) continue;
        seen.add(v);
        rows.push(v);
      }
    }
    return pointsOf(this.domain.owner, rows, undefined, true);
  } },
  /** The edges of the members, curve by curve in walk order. */
  edges: { get(this: CurveSel) { return edgesOf(this.domain.owner, memberEdges(this), undefined, true); } },
  /** Itself: a curve selection is already curves. */
  curves: { get(this: CurveSel) { return this; } },
  /** The rings among the members, as areas. */
  contours: { value(this: CurveSel): IsoContour[] { return this.indices.flatMap((r) => contourOf(this.domain.chains[r])); } },
  /** Independent material of the members' edges and their ends, every
   * column and id kept, the edges in walk order. */
  extract: { value(this: CurveSel): Material {
    const edges = edgesOf(this.domain.owner, memberEdges(this), undefined, true);
    return extractRows(this.domain.owner, endpointRows(edges), edges.indices);
  } },
}, {
  near: 'a curve is not a place — ask g.edges.near(p, { radius }) or g.points.near(p, { radius })',
  nearest: 'ask the edges: g.edges.nearest(p, { within })',
  firstHit: 'ask the edges: g.edges.firstHit(from, to)',
  crossing: 'ask the edges: g.edges.crossing(a, b)',
  set: 'a curve is derived from the edges, so it has no write of its own — write its edges (c.edges.set(…)) or its points (c.points.set(…))',
  add: 'curves are derived from the edges — add edges (g.edges.add(…))',
  remove: 'curves are derived from the edges — remove those (g.edges.remove(c.edges))',
  thicken: 'read it on their edges — sel.edges.thicken(…)',
  resample: 'read it on their edges — sel.edges.resample(…)',
  trim: 'read it on their edges — sel.edges.trim(…)',
  spline: 'read it on their edges — sel.edges.spline(…)',
  oscillate: 'read it on their edges — sel.edges.oscillate(…)',
  along: 'read it on their edges — sel.edges.along(…)',
});

/** @internal Is `v` a selection of curves? */
export const isCurveSelection = (v: unknown): v is Selection<Curve> => isSelectionOf(v, CURVES);

// ---- reading any chain value -----------------------------------------------------------

/** A chain record a consumer reads: positions, closure, geodesic flags,
 * and — for a geometry of this library — the vertex rows it walks. */
export type ChainRecord = Pick<Chain, 'pts' | 'closed' | 'geodesic'> & { readonly indices?: readonly number[] };

/**
 * @internal The chains a value answers, as kernel records, or null when it
 * answers no `curves`. A geometry of this library is read straight from its
 * curve table — no row is built. Anything else that answers the protocol
 * is read through its rows: each row's `points` (pairs or `{ x, y }`
 * records, in order) and `closed`.
 */
export function chainRecordsOf(value: unknown): readonly ChainRecord[] | null {
  if (value instanceof Material) return chainsOf(value);
  if (typeof value !== 'object' || value === null || !('curves' in value)) return null;
  const curves = (value as { curves: unknown }).curves;
  if (curves instanceof Selection && curves.domain instanceof CurveTable) {
    const d = curves.domain;
    return curves.members === null ? d.chains : curves.indices.map((r) => d.chains[r]);
  }
  if (typeof curves !== 'object' || curves === null || typeof (curves as Iterable<unknown>)[Symbol.iterator] !== 'function') return null;
  return Array.from(curves as Iterable<unknown>, (row) => chainRecordOf(row));
}

/** @internal One curve row as a chain record: a row of this library by its
 * table, any other by its `points` and `closed`. */
export function chainRecordOf(row: unknown): ChainRecord {
  const own = typeof row === 'object' && row !== null ? home.get(row) : undefined;
  if (own) return own.table.chains[own.r];
  const r = row as { points?: unknown; closed?: unknown };
  const pts: [number, number][] = [];
  if (r !== null && typeof r === 'object' && r.points !== undefined && typeof (r.points as Iterable<unknown>)[Symbol.iterator] === 'function') {
    for (const p of r.points as Iterable<unknown>) {
      if (Array.isArray(p)) pts.push([p[0] as number, p[1] as number]);
      else pts.push([(p as { x: number }).x, (p as { y: number }).y]);
    }
  }
  return { pts, closed: r?.closed === true };
}

/**
 * @internal Chains as a material of their own and its curves: a row per
 * position, the edges along each chain in order (a ring's closing edge
 * last), so the walk gives the chains back as given. What a value that
 * holds chains but no material answers for `curves` — a glyph, projected
 * lines. Each chain's own columns ride on its edges.
 */
export function materialOfChains(chains: readonly { pts: readonly (readonly [number, number])[]; closed: boolean }[], space?: Space): Material {
  let n = 0;
  let e = 0;
  for (const c of chains) {
    n += c.pts.length;
    e += c.closed && c.pts.length > 2 ? c.pts.length : Math.max(0, c.pts.length - 1);
  }
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const edges = new Uint32Array(2 * e);
  let vi = 0;
  let ei = 0;
  for (const c of chains) {
    const first = vi;
    const k = c.pts.length;
    for (let i = 0; i < k; i++) {
      x[vi] = c.pts[i][0];
      y[vi] = c.pts[i][1];
      if (i > 0) {
        edges[ei++] = vi - 1;
        edges[ei++] = vi;
      }
      vi++;
    }
    if (c.closed && k > 2) {
      edges[ei++] = vi - 1;
      edges[ei++] = first;
    }
  }
  return new Material(x, y, {}, edges, { space });
}

/** @internal The curves of chains held as records: `materialOfChains`, read. */
export function curvesOfChains(chains: readonly { pts: readonly (readonly [number, number])[]; closed: boolean }[], space?: Space): Selection<Curve> {
  return curvesOf(materialOfChains(chains, space));
}
