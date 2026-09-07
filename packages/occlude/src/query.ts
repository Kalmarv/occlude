/**
 * Geometry queries against a material's sampled edges: prepare once for a
 * frozen state, ask many times. Queries return information and never
 * move, split, stop or connect anything; a result is bound to the state
 * it was asked of.
 *
 * Edges are straight segments between sampled vertices; nothing here is
 * analytic geometry, and nothing snaps. Coordinates are the material's
 * own. Numerical policy: exact floating-point arithmetic with a relative
 * tolerance `EPS` (1e-9 of the segment scale) deciding "on the line",
 * parallel and collinear; ties resolve by source edge order.
 *
 * Complexity: preparation lays the endpoint columns out once and builds a
 * uniform grid over the edges' boxes (an edge is registered in every cell
 * its box covers; the cell is at least the mean edge extent, so long
 * edges do not multiply). `nearest` searches rings of cells outward and
 * stops once the best hit is nearer than the next ring; `firstHit` visits
 * the cells the move's box covers. Both see exactly the candidates a full
 * scan would judge (every edge whose box meets the query region) and
 * judge them in source-edge order, so ties resolve as before. A query
 * far longer than a cell degrades toward the full scan.
 */

import { Material, ownedBy, type Edge, type Vertex, type XY } from './material.js';

const EPS = 1e-9;

const vx = (p: XY): number => (Array.isArray(p) ? (p as readonly number[])[0] : (p as { x: number }).x);
const vy = (p: XY): number => (Array.isArray(p) ? (p as readonly number[])[1] : (p as { y: number }).y);

export interface NearestHit {
  edge: Edge;
  /** The closest point on the edge. */
  position: [number, number];
  /** Parameter along the edge in stored a → b order (0 on a zero-length edge). */
  t: number;
  distance: number;
}

export interface FirstHit {
  edge: Edge;
  position: [number, number];
  /** Parameter along the source edge, stored a → b order. */
  t: number;
  /** Parameter along the proposed segment from `from` to `to`. */
  along: number;
  /** Distance travelled from `from` to the hit. */
  distance: number;
  /** `crossing`: the segments cross or meet at an interior point;
   * `touch`: contact at an endpoint of either segment (or a point query);
   * `overlap`: collinear overlap — the start of the overlapping interval. */
  kind: 'crossing' | 'touch' | 'overlap';
}

export interface EdgeQuery {
  /** The closest edge within `within` of `position` (inclusive), or null.
   * Ties go to the earlier source edge. */
  nearest(position: XY, opts: { within: number }): NearestHit | null;
  /** The first edge a straight move from `from` to `to` would meet, by
   * smallest `along` then source edge order; endpoint contact counts.
   * `excludeIncident` skips every edge incident to that vertex of the
   * source state. A zero-length move is a contact query at `from`. */
  firstHit(from: XY, to: XY, opts?: { excludeIncident?: Vertex | number }): FirstHit | null;
}

/** Prepare edge queries for a frozen material. */
export function edges(m: Material): EdgeQuery {
  const E = m.edgeCount;
  const ax = new Float64Array(E);
  const ay = new Float64Array(E);
  const bx = new Float64Array(E);
  const by = new Float64Array(E);
  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;
  let extent = 0;
  for (let e = 0; e < E; e++) {
    const a = m.edgeList[2 * e];
    const b = m.edgeList[2 * e + 1];
    ax[e] = m.x[a];
    ay[e] = m.y[a];
    bx[e] = m.x[b];
    by[e] = m.y[b];
    minx = Math.min(minx, ax[e], bx[e]);
    miny = Math.min(miny, ay[e], by[e]);
    maxx = Math.max(maxx, ax[e], bx[e]);
    maxy = Math.max(maxy, ay[e], by[e]);
    extent += Math.max(Math.abs(bx[e] - ax[e]), Math.abs(by[e] - ay[e]));
  }
  // ---- the grid: about one edge per cell, never finer than the mean edge extent ----
  if (!Number.isFinite(minx)) { minx = miny = 0; maxx = maxy = 1; }
  const span = Math.max(maxx - minx, maxy - miny, 1e-9);
  const cell = Math.max(span / Math.max(1, Math.ceil(Math.sqrt(E))), E > 0 ? extent / E : span, 1e-9);
  const cols = Math.floor((maxx - minx) / cell) + 1;
  const rows = Math.floor((maxy - miny) / cell) + 1;
  const col = (x: number) => Math.min(cols - 1, Math.max(0, Math.floor((x - minx) / cell)));
  const row = (y: number) => Math.min(rows - 1, Math.max(0, Math.floor((y - miny) / cell)));
  const buckets: number[][] = Array.from({ length: cols * rows }, () => []);
  for (let e = 0; e < E; e++) {
    const c0 = col(Math.min(ax[e], bx[e]));
    const c1 = col(Math.max(ax[e], bx[e]));
    const r0 = row(Math.min(ay[e], by[e]));
    const r1 = row(Math.max(ay[e], by[e]));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) buckets[r * cols + c].push(e);
  }
  const stamp = new Int32Array(E).fill(-1);
  let query = 0;
  /** Edges registered in the cells of a box, each once, in source order. */
  const everyEdge = Array.from({ length: E }, (_, e) => e);
  const candidatesIn = (x0: number, y0: number, x1: number, y1: number): number[] => {
    query++;
    const out: number[] = [];
    if (x1 < minx - cell || x0 > maxx + cell || y1 < miny - cell || y0 > maxy + cell) return out;
    // a box over most of the grid would visit and sort nearly everything: the plain scan is cheaper
    if ((row(y1) - row(y0) + 1) * (col(x1) - col(x0) + 1) > 0.4 * cols * rows) return everyEdge;
    for (let r = row(y0); r <= row(y1); r++) {
      for (let c = col(x0); c <= col(x1); c++) {
        for (const e of buckets[r * cols + c]) {
          if (stamp[e] === query) continue;
          stamp[e] = query;
          out.push(e);
        }
      }
    }
    return out.sort((p, q) => p - q);
  };
  const incidentRows = (v: Vertex | number): Set<number> => {
    let row: number;
    if (typeof v === 'number') {
      if (!Number.isInteger(v) || v < 0 || v >= m.n) throw new Error(`query: no vertex ${v} in the source material`);
      row = v;
    } else {
      if (!ownedBy(v, m)) throw new Error('query: excludeIncident must be a vertex of the queried material');
      row = v.index;
    }
    const out = new Set<number>();
    for (let e = 0; e < E; e++) if (m.edgeList[2 * e] === row || m.edgeList[2 * e + 1] === row) out.add(e);
    return out;
  };

  return {
    nearest(position, opts) {
      const within = opts.within;
      if (!Number.isFinite(within) || within < 0) throw new Error('query.nearest: within must be finite and non-negative');
      const px = vx(position);
      const py = vy(position);
      let best: NearestHit | null = null;
      // every edge within `within` of the point has its box within `within` of it
      for (const e of candidatesIn(px - within, py - within, px + within, py + within)) {
        const dx = bx[e] - ax[e];
        const dy = by[e] - ay[e];
        const len2 = dx * dx + dy * dy;
        let t = 0;
        if (len2 > 0) t = Math.max(0, Math.min(1, ((px - ax[e]) * dx + (py - ay[e]) * dy) / len2));
        const qx = ax[e] + dx * t;
        const qy = ay[e] + dy * t;
        const d = Math.hypot(px - qx, py - qy);
        if (d > within) continue;
        if (best === null || d < best.distance) best = { edge: m.edge(e), position: [qx, qy], t, distance: d };
      }
      return best;
    },
    firstHit(from, to, opts = {}) {
      const fx = vx(from);
      const fy = vy(from);
      const tx = vx(to);
      const ty = vy(to);
      const skip = opts.excludeIncident !== undefined ? incidentRows(opts.excludeIncident) : null;
      const sx = tx - fx;
      const sy = ty - fy;
      const slen = Math.hypot(sx, sy);
      let best: FirstHit | null = null;
      const consider = (e: number, along: number, t: number, kind: FirstHit['kind']) => {
        if (best !== null && along >= best.along) return;
        const px = fx + sx * along;
        const py = fy + sy * along;
        best = { edge: m.edge(e), position: [px, py], t, along, distance: slen * along, kind };
      };
      for (const e of candidatesIn(Math.min(fx, tx), Math.min(fy, ty), Math.max(fx, tx), Math.max(fy, ty))) {
        if (skip && skip.has(e)) continue;
        const dx = bx[e] - ax[e];
        const dy = by[e] - ay[e];
        const scale = Math.max(1, Math.abs(dx), Math.abs(dy), Math.abs(sx), Math.abs(sy));
        const eps = EPS * scale;
        if (slen === 0) {
          // contact query: is `from` on this edge?
          const t = pointOnSegment(fx, fy, ax[e], ay[e], dx, dy, eps);
          if (t !== null) consider(e, 0, t, 'touch');
          continue;
        }
        const denom = sx * dy - sy * dx; // cross(s, d)
        const wx = ax[e] - fx;
        const wy = ay[e] - fy;
        if (Math.abs(denom) <= eps * eps) {
          // parallel: collinear overlap, or nothing
          const cross = wx * sy - wy * sx;
          if (Math.abs(cross) > eps * Math.max(1, slen)) continue;
          // project edge endpoints onto the move
          const s2 = sx * sx + sy * sy;
          const u0 = (wx * sx + wy * sy) / s2;
          const u1 = ((bx[e] - fx) * sx + (by[e] - fy) * sy) / s2;
          const lo = Math.max(0, Math.min(u0, u1));
          const hi = Math.min(1, Math.max(u0, u1));
          if (lo > hi + EPS) continue;
          // tolerated endpoint contact resolves to the segment's end, never beyond it
          const along = Math.max(0, Math.min(1, lo));
          const t = dx * dx + dy * dy > 0 ? Math.max(0, Math.min(1, ((fx + sx * along - ax[e]) * dx + (fy + sy * along - ay[e]) * dy) / (dx * dx + dy * dy))) : 0;
          consider(e, along, t, hi - lo <= EPS ? 'touch' : 'overlap');
          continue;
        }
        const along = (wx * dy - wy * dx) / denom;
        const t = (wx * sy - wy * sx) / denom;
        const tolA = eps / slen;
        const elen = Math.hypot(dx, dy);
        const tolT = elen > 0 ? eps / elen : 0;
        if (along < -tolA || along > 1 + tolA || t < -tolT || t > 1 + tolT) continue;
        const a2 = Math.max(0, Math.min(1, along));
        const t2 = Math.max(0, Math.min(1, t));
        const atEnd = a2 <= tolA || a2 >= 1 - tolA || t2 <= tolT || t2 >= 1 - tolT;
        consider(e, a2, t2, atEnd ? 'touch' : 'crossing');
      }
      return best;
    },
  };
}

function pointOnSegment(px: number, py: number, ax: number, ay: number, dx: number, dy: number, eps: number): number | null {
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay) <= eps ? 0 : null;
  const t = ((px - ax) * dx + (py - ay) * dy) / len2;
  if (t < -eps || t > 1 + eps) return null;
  const qx = ax + dx * t;
  const qy = ay + dy * t;
  return Math.hypot(px - qx, py - qy) <= eps ? Math.max(0, Math.min(1, t)) : null;
}

/** Queries as one namespace: `query.edges(current)`. */
export const query = { edges };
