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
 * uniform grid over the edges' boxes in one compressed block (an edge is
 * registered in every cell its box covers; the cell is at least the mean
 * edge extent, so long edges do not multiply). `nearest` searches rings
 * of cells outward from the query point and stops once the nearest
 * unvisited ring is further than the best hit so far; `firstHit` walks
 * the corridor of cells the move itself crosses, not the box it spans, so
 * a move across the whole drawing costs a diagonal of cells rather than
 * the grid. Both see every edge that could win and settle on the same
 * one a full scan would: the answer is the least `(distance, edge)` —
 * respectively `(along, edge)` — pair, which does not depend on the order
 * candidates are judged in, so pruning candidates that cannot win and
 * judging the rest as they come is the same answer.
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
   * Ties go to the earlier source edge. `excludeIncident` skips every edge
   * incident to that vertex of the source state, so a tip can sense the
   * nearest line that is not its own stem. */
  nearest(position: XY, opts: { within: number; excludeIncident?: Vertex | number }): NearestHit | null;
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
  // One compressed block instead of cols × rows arrays: count, prefix-sum, fill.
  const cellStart = new Int32Array(cols * rows + 1);
  const eC0 = new Int32Array(E);
  const eC1 = new Int32Array(E);
  const eR0 = new Int32Array(E);
  const eR1 = new Int32Array(E);
  for (let e = 0; e < E; e++) {
    const c0 = col(Math.min(ax[e], bx[e]));
    const c1 = col(Math.max(ax[e], bx[e]));
    const r0 = row(Math.min(ay[e], by[e]));
    const r1 = row(Math.max(ay[e], by[e]));
    eC0[e] = c0; eC1[e] = c1; eR0[e] = r0; eR1[e] = r1;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) cellStart[r * cols + c + 1]++;
  }
  for (let i = 0; i < cols * rows; i++) cellStart[i + 1] += cellStart[i];
  const items = new Int32Array(cellStart[cols * rows]);
  const cursor = cellStart.slice(0, cols * rows);
  for (let e = 0; e < E; e++) {
    for (let r = eR0[e]; r <= eR1[e]; r++) for (let c = eC0[e]; c <= eC1[e]; c++) items[cursor[r * cols + c]++] = e;
  }

  // ---- candidate gathering: each edge offered once per query, in no particular order ----
  const stamp = new Int32Array(E).fill(-1);
  let queryId = 0;
  const cand = new Int32Array(E);
  let candN = 0;
  const pushCell = (cellIndex: number): void => {
    const end = cellStart[cellIndex + 1];
    for (let i = cellStart[cellIndex]; i < end; i++) {
      const e = items[i];
      if (stamp[e] === queryId) continue;
      stamp[e] = queryId;
      cand[candN++] = e;
    }
  };
  // The exact test accepts contacts within EPS × scale (scale ≤ the largest
  // extent in play): every gathered region is padded by more than that, so
  // a contact just across a cell boundary is still judged.
  const pad = Math.max(1e-9, EPS * 1000 * Math.max(1, span));

  /** The cells of the axis-aligned box, clipped to the grid. */
  const gatherBox = (bx0: number, by0: number, bx1: number, by1: number): void => {
    for (let r = row(by0); r <= row(by1); r++) {
      for (let c = col(bx0); c <= col(bx1); c++) pushCell(r * cols + c);
    }
  };
  /** The cells at Chebyshev distance `k` from (cc, cr), clipped to a window. */
  const gatherRing = (k: number, cc: number, cr: number, c0: number, c1: number, r0: number, r1: number): void => {
    if (k === 0) {
      if (cc >= c0 && cc <= c1 && cr >= r0 && cr <= r1) pushCell(cr * cols + cc);
      return;
    }
    const lo = Math.max(c0, cc - k);
    const hi = Math.min(c1, cc + k);
    if (cr - k >= r0 && cr - k <= r1) for (let c = lo; c <= hi; c++) pushCell((cr - k) * cols + c);
    if (cr + k >= r0 && cr + k <= r1) for (let c = lo; c <= hi; c++) pushCell((cr + k) * cols + c);
    const top = Math.max(r0, cr - k + 1);
    const bot = Math.min(r1, cr + k - 1);
    if (cc - k >= c0 && cc - k <= c1) for (let r = top; r <= bot; r++) pushCell(r * cols + (cc - k));
    if (cc + k >= c0 && cc + k <= c1) for (let r = top; r <= bot; r++) pushCell(r * cols + (cc + k));
  };
  /** The cells the padded segment itself crosses — a corridor, not its box. */
  const gatherSegment = (x0: number, y0: number, x1: number, y1: number): void => {
    const dx = x1 - x0;
    const dy = y1 - y0;
    if (dx === 0 && dy === 0) { gatherBox(x0 - pad, y0 - pad, x0 + pad, y0 + pad); return; }
    if (Math.abs(dx) >= Math.abs(dy)) {
      const xlo = Math.min(x0, x1) - pad;
      const xhi = Math.max(x0, x1) + pad;
      const ylo = Math.min(y0, y1) - pad;
      const yhi = Math.max(y0, y1) + pad;
      const cA = col(xlo);
      const cB = col(xhi);
      for (let c = cA; c <= cB; c++) {
        // border columns stand for everything beyond the grid, so their span is open
        const lo = Math.max(xlo, c === 0 ? -Infinity : minx + c * cell);
        const hi = Math.min(xhi, c === cols - 1 ? Infinity : minx + (c + 1) * cell);
        const ea = y0 + dy * ((lo - x0) / dx);
        const eb = y0 + dy * ((hi - x0) / dx);
        const from = Math.max(ylo, Math.min(ea, eb) - pad);
        const to = Math.min(yhi, Math.max(ea, eb) + pad);
        for (let r = row(from); r <= row(to); r++) pushCell(r * cols + c);
      }
      return;
    }
    const ylo = Math.min(y0, y1) - pad;
    const yhi = Math.max(y0, y1) + pad;
    const xlo = Math.min(x0, x1) - pad;
    const xhi = Math.max(x0, x1) + pad;
    const rA = row(ylo);
    const rB = row(yhi);
    for (let r = rA; r <= rB; r++) {
      const lo = Math.max(ylo, r === 0 ? -Infinity : miny + r * cell);
      const hi = Math.min(yhi, r === rows - 1 ? Infinity : miny + (r + 1) * cell);
      const ea = x0 + dx * ((lo - y0) / dy);
      const eb = x0 + dx * ((hi - y0) / dy);
      const from = Math.max(xlo, Math.min(ea, eb) - pad);
      const to = Math.min(xhi, Math.max(ea, eb) + pad);
      for (let c = col(from); c <= col(to); c++) pushCell(r * cols + c);
    }
  };

  // ---- incident edges of a vertex: the adjacency is built once, when first asked ----
  let vertexStart: Int32Array | null = null;
  let vertexEdges: Int32Array | null = null;
  const buildAdjacency = (): void => {
    const start = new Int32Array(m.n + 1);
    for (let e = 0; e < 2 * E; e++) start[m.edgeList[e] + 1]++;
    for (let i = 0; i < m.n; i++) start[i + 1] += start[i];
    const fill = start.slice(0, m.n);
    const list = new Int32Array(2 * E);
    for (let e = 0; e < E; e++) {
      list[fill[m.edgeList[2 * e]]++] = e;
      list[fill[m.edgeList[2 * e + 1]]++] = e;
    }
    vertexStart = start;
    vertexEdges = list;
  };
  const incidentRow = (v: Vertex | number): number => {
    if (typeof v === 'number') {
      if (!Number.isInteger(v) || v < 0 || v >= m.n) throw new Error(`query: no vertex ${v} in the source material`);
      return v;
    }
    if (!ownedBy(v, m)) throw new Error('query: excludeIncident must be a vertex of the queried material');
    return v.index;
  };

  return {
    nearest(position, opts) {
      const within = opts.within;
      if (!Number.isFinite(within) || within < 0) throw new Error('query.nearest: within must be finite and non-negative');
      const px = vx(position);
      const py = vy(position);
      let skipStart = -1;
      let skipEnd = -1;
      if (opts.excludeIncident !== undefined) {
        const v = incidentRow(opts.excludeIncident);
        if (vertexStart === null) buildAdjacency();
        skipStart = vertexStart![v];
        skipEnd = vertexStart![v + 1];
      }
      const isIncident = (e: number): boolean => {
        for (let j = skipStart; j < skipEnd; j++) if (vertexEdges![j] === e) return true;
        return false;
      };
      queryId++;
      candN = 0;
      // the window is the box the full scan would have judged; rings inside it
      // stop as soon as no unvisited cell can hold anything closer
      const c0 = col(px - within - pad);
      const c1 = col(px + within + pad);
      const r0 = row(py - within - pad);
      const r1 = row(py + within + pad);
      const cc = col(px);
      const cr = row(py);
      const kMax = Math.max(cc - c0, c1 - cc, cr - r0, r1 - cr);
      let bestE = -1;
      let bestD = Infinity;
      let bestT = 0;
      let bestX = 0;
      let bestY = 0;
      let judged = 0;
      for (let k = 0; k <= kMax; k++) {
        if (k > 0) {
          // everything left unvisited lies outside the square already covered
          const x0 = minx + (cc - k + 1) * cell;
          const x1 = minx + (cc + k) * cell;
          const y0 = miny + (cr - k + 1) * cell;
          const y1 = miny + (cr + k) * cell;
          const reach = Math.max(0, Math.min(px - x0, x1 - px, py - y0, y1 - py));
          if (reach > within + pad) break;
          if (reach > bestD + pad) break;
        }
        gatherRing(k, cc, cr, c0, c1, r0, r1);
        for (; judged < candN; judged++) {
          const e = cand[judged];
          if (skipStart >= 0 && isIncident(e)) continue;
          const dx = bx[e] - ax[e];
          const dy = by[e] - ay[e];
          const len2 = dx * dx + dy * dy;
          let t = 0;
          if (len2 > 0) t = Math.max(0, Math.min(1, ((px - ax[e]) * dx + (py - ay[e]) * dy) / len2));
          const qx = ax[e] + dx * t;
          const qy = ay[e] + dy * t;
          const d = Math.hypot(px - qx, py - qy);
          if (d > within) continue;
          if (bestE < 0 || d < bestD || (d === bestD && e < bestE)) {
            bestE = e; bestD = d; bestT = t; bestX = qx; bestY = qy;
          }
        }
      }
      return bestE < 0 ? null : { edge: m.edge(bestE), position: [bestX, bestY], t: bestT, distance: bestD };
    },
    firstHit(from, to, opts = {}) {
      const fx = vx(from);
      const fy = vy(from);
      const tx = vx(to);
      const ty = vy(to);
      let skipStart = -1;
      let skipEnd = -1;
      if (opts.excludeIncident !== undefined) {
        const v = incidentRow(opts.excludeIncident);
        if (vertexStart === null) buildAdjacency();
        skipStart = vertexStart![v];
        skipEnd = vertexStart![v + 1];
      }
      const sx = tx - fx;
      const sy = ty - fy;
      const slen = Math.hypot(sx, sy);
      let bestE = -1;
      let bestAlong = 0;
      let bestT = 0;
      let bestKind: FirstHit['kind'] = 'touch';
      const consider = (e: number, along: number, t: number, kind: FirstHit['kind']) => {
        if (bestE >= 0 && (along > bestAlong || (along === bestAlong && e > bestE))) return;
        bestE = e; bestAlong = along; bestT = t; bestKind = kind;
      };
      queryId++;
      candN = 0;
      gatherSegment(fx, fy, tx, ty);
      for (let i = 0; i < candN; i++) {
        const e = cand[i];
        if (skipStart >= 0) {
          let incident = false;
          for (let j = skipStart; j < skipEnd; j++) if (vertexEdges![j] === e) { incident = true; break; }
          if (incident) continue;
        }
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
      if (bestE < 0) return null;
      return {
        edge: m.edge(bestE),
        position: [fx + sx * bestAlong, fy + sy * bestAlong],
        t: bestT,
        along: bestAlong,
        distance: slen * bestAlong,
        kind: bestKind,
      };
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
