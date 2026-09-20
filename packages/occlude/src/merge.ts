/**
 * `m.merge({ tolerance })`: coincident ink resolved in geometry.
 *
 * Two rectangles snapped edge to edge, a stick font, an imported SVG, a
 * lattice assembled cell by cell — each draws a shared wall twice, and each
 * makes `planarize` refuse: a collinear overlap is the one thing it cannot
 * resolve. This is the word that resolves it, on the material, where the
 * artist asked. It is deliberately not a plan option: retrace is an
 * artist's choice (`passes`), so ink is only ever removed from geometry
 * the sketch handed here.
 *
 * What it does, in order:
 *   1. Vertices within `tolerance` of each other are one vertex — the
 *      lowest row survives, at its own position, with its own columns.
 *   2. Edges are rewritten onto the survivors. An edge whose two ends are
 *      now the same vertex was a duplicate of a point and goes; a pair
 *      of edges joining the same two vertices, either way round, is one
 *      edge.
 *   3. Edges that lie along one line within `tolerance` and overlap by a
 *      positive length are cut at every endpoint that falls inside the
 *      overlap, and each span is kept once. Direction is ignored.
 *
 * Identity follows the split rule: a vertex that survives is the vertex it
 * was; an edge nothing touched keeps its id; a span is a new edge with the
 * lineage root of the lowest source edge that covered it, so a face column
 * keyed by that wall still finds it. Edge columns come from that same
 * source, `distribute` columns scaled by the span's share of it.
 *
 * `tolerance` is in the material's own units; the default 0 means exact
 * coincidence only. Nothing here reads paper, units or the seed, so it is a
 * Material method. Degenerate input (an empty material, no overlaps) comes
 * back equal to itself with the same ids; a non-finite coordinate is a
 * mistake and refuses by row.
 */

import { orient2d } from 'robust-predicates';
import { Material, mintIds, inheritEdge } from './material.js';

export interface MergeOpts {
  /** Two vertices closer than this are one vertex; two edges within this of
   * one line that overlap are one run of edges. Material units; default 0. */
  tolerance?: number;
}

class Union {
  private readonly parent: Int32Array;
  constructor(n: number) {
    this.parent = new Int32Array(n);
    for (let i = 0; i < n; i++) this.parent[i] = i;
  }
  find(i: number): number {
    let r = i;
    while (this.parent[r] !== r) r = this.parent[r];
    while (this.parent[i] !== r) { const next = this.parent[i]; this.parent[i] = r; i = next; }
    return r;
  }
  /** Joins two sets; the lower root wins, so a representative is the lowest row. */
  join(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
}

/** Uniform grid over points, cell = `size`, for "all pairs within size". */
function pairsWithin(x: ArrayLike<number>, y: ArrayLike<number>, n: number, size: number, visit: (i: number, j: number) => void): void {
  if (n < 2) return;
  const cell = size > 0 ? size : 1e-12;
  const key = (i: number) => `${Math.floor(x[i] / cell)},${Math.floor(y[i] / cell)}`;
  const buckets = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const k = key(i);
    const list = buckets.get(k);
    if (list) list.push(i); else buckets.set(k, [i]);
  }
  const tol2 = size * size;
  for (let i = 0; i < n; i++) {
    const cx = Math.floor(x[i] / cell);
    const cy = Math.floor(y[i] / cell);
    for (let gx = cx - 1; gx <= cx + 1; gx++) for (let gy = cy - 1; gy <= cy + 1; gy++) {
      const list = buckets.get(`${gx},${gy}`);
      if (!list) continue;
      for (const j of list) {
        if (j <= i) continue;
        const dx = x[i] - x[j];
        const dy = y[i] - y[j];
        if (dx * dx + dy * dy <= tol2) visit(i, j);
      }
    }
  }
}

interface Seg { row: number; a: number; b: number; ax: number; ay: number; bx: number; by: number }

/** Every pair of segments whose boxes (grown by `pad`) overlap, by an x-sorted sweep. */
function boxPairs(segs: Seg[], pad: number, visit: (i: number, j: number) => void): void {
  const order = segs.map((_, i) => i).sort((i, j) => Math.min(segs[i].ax, segs[i].bx) - Math.min(segs[j].ax, segs[j].bx));
  const lox = order.map((i) => Math.min(segs[i].ax, segs[i].bx) - pad);
  const hix = order.map((i) => Math.max(segs[i].ax, segs[i].bx) + pad);
  const loy = order.map((i) => Math.min(segs[i].ay, segs[i].by) - pad);
  const hiy = order.map((i) => Math.max(segs[i].ay, segs[i].by) + pad);
  for (let p = 0; p < order.length; p++) {
    for (let q = p + 1; q < order.length && lox[q] <= hix[p]; q++) {
      if (loy[q] > hiy[p] || hiy[q] < loy[p]) continue;
      visit(order[p], order[q]);
    }
  }
}

/** Distance from point (px, py) to the infinite line through s. */
function lineDistance(s: Seg, px: number, py: number): number {
  const dx = s.bx - s.ax;
  const dy = s.by - s.ay;
  const len = Math.hypot(dx, dy);
  return Math.abs((px - s.ax) * dy - (py - s.ay) * dx) / len;
}

export function merge(m: Material, opts: MergeOpts = {}): Material {
  const tol = opts.tolerance ?? 0;
  if (!Number.isFinite(tol) || tol < 0) throw new Error('merge: tolerance must be a finite length of zero or more');
  const n = m.n;
  const E = m.edgeCount;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(m.x[i]) || !Number.isFinite(m.y[i])) throw new Error(`merge: vertex ${i} is not finite`);
  }
  const names = m.attrNames;
  const enames = m.edgeAttrNames;

  // ---- 1. vertices within tolerance are one vertex (lowest row survives) ----
  const verts = new Union(n);
  if (tol > 0) pairsWithin(m.x, m.y, n, tol, (i, j) => verts.join(i, j));
  else {
    const byPos = new Map<string, number>();
    for (let i = 0; i < n; i++) {
      const k = `${m.x[i] === 0 ? 0 : m.x[i]},${m.y[i] === 0 ? 0 : m.y[i]}`;
      const first = byPos.get(k);
      if (first === undefined) byPos.set(k, i); else verts.join(first, i);
    }
  }
  const rep = new Int32Array(n);
  for (let i = 0; i < n; i++) rep[i] = verts.find(i);

  // ---- 2. edges onto survivors; zero-length and exact duplicates go ----
  const segs: Seg[] = [];
  const seenPair = new Map<string, number>();
  for (let e = 0; e < E; e++) {
    const a = rep[m.edgeList[2 * e]];
    const b = rep[m.edgeList[2 * e + 1]];
    if (a === b) continue; // both ends are one vertex now: it was a duplicate of a point
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    if (seenPair.has(key)) continue; // the same two vertices, either way round
    seenPair.set(key, e);
    segs.push({ row: e, a, b, ax: m.x[a], ay: m.y[a], bx: m.x[b], by: m.y[b] });
  }

  // ---- 3. collinear overlapping edges become line groups ----
  const groups = new Union(segs.length);
  const overlaps = (s: Seg, u: Seg): boolean => {
    const collinear = tol > 0
      ? lineDistance(s, u.ax, u.ay) <= tol && lineDistance(s, u.bx, u.by) <= tol
      : orient2d(s.ax, s.ay, s.bx, s.by, u.ax, u.ay) === 0 && orient2d(s.ax, s.ay, s.bx, s.by, u.bx, u.by) === 0;
    if (!collinear) return false;
    const dx = s.bx - s.ax;
    const dy = s.by - s.ay;
    const l2 = dx * dx + dy * dy;
    const p = ((u.ax - s.ax) * dx + (u.ay - s.ay) * dy) / l2;
    const q = ((u.bx - s.ax) * dx + (u.by - s.ay) * dy) / l2;
    const lo = Math.min(p, q);
    const hi = Math.max(p, q);
    // A positive-length overlap of the two parameter ranges. Touching end
    // to end (hi === 0 or lo === 1) is not an overlap: no ink is doubled.
    const slack = tol / Math.sqrt(l2);
    return hi > slack && lo < 1 - slack;
  };
  boxPairs(segs, tol, (i, j) => {
    // A shared vertex means the two edges leave one point; they overlap
    // only if they leave it the same way, which `overlaps` also finds.
    if (overlaps(segs[i], segs[j])) groups.join(i, j);
  });
  const members = new Map<number, number[]>();
  for (let i = 0; i < segs.length; i++) {
    const g = groups.find(i);
    const list = members.get(g);
    if (list) list.push(i); else members.set(g, [i]);
  }

  // ---- rows out: surviving vertices in source order ----
  const rowMap = new Int32Array(n).fill(-1);
  const ox: number[] = [];
  const oy: number[] = [];
  const oids: number[] = [];
  const oattrs: Record<string, number[]> = {};
  for (const name of names) oattrs[name] = [];
  for (let i = 0; i < n; i++) {
    if (rep[i] !== i) continue;
    rowMap[i] = ox.length;
    ox.push(m.x[i]);
    oy.push(m.y[i]);
    oids.push(m.pointIds[i]);
    for (const name of names) oattrs[name].push(m.attrs[name][i]);
  }

  // ---- edges out: source order; a line group is emitted where its first member was ----
  const edges: number[] = [];
  const eids: number[] = [];
  const eroots: number[] = [];
  const eattrs: Record<string, number[]> = {};
  for (const name of enames) eattrs[name] = [];
  const emitted = new Set<number>();
  const push = (a: number, b: number, source: number, fraction: number, keepId: boolean) => {
    edges.push(rowMap[a], rowMap[b]);
    eids.push(keepId ? m.edgeIds[source] : mintIds(1)[0]);
    eroots.push(m.edgeRoots[source]);
    const parent: Record<string, number> = {};
    for (const name of enames) parent[name] = m.edgeAttrs[name][source];
    const inherited = inheritEdge(m, parent, fraction);
    for (const name of enames) eattrs[name].push(inherited[name]);
  };
  for (let k = 0; k < segs.length; k++) {
    const g = groups.find(k);
    if (emitted.has(g)) continue;
    emitted.add(g);
    const list = members.get(g)!;
    if (list.length === 1) {
      const s = segs[k];
      push(s.a, s.b, s.row, 1, true);
      continue;
    }
    // Axis: the longest member. Every endpoint projects to a parameter on
    // it; spans between consecutive distinct parameters are kept once,
    // each from the lowest source row covering it.
    let axis = segs[list[0]];
    let best = -1;
    for (const i of list) {
      const s = segs[i];
      const l2 = (s.bx - s.ax) ** 2 + (s.by - s.ay) ** 2;
      if (l2 > best) { best = l2; axis = s; }
    }
    const dx = axis.bx - axis.ax;
    const dy = axis.by - axis.ay;
    const l2 = dx * dx + dy * dy;
    const len = Math.sqrt(l2);
    const param = (v: number) => ((m.x[v] - axis.ax) * dx + (m.y[v] - axis.ay) * dy) / l2;
    const stops = new Map<number, number>(); // vertex → parameter
    const ranges: { lo: number; hi: number; row: number; length: number }[] = [];
    for (const i of list) {
      const s = segs[i];
      const pa = param(s.a);
      const pb = param(s.b);
      stops.set(s.a, pa);
      stops.set(s.b, pb);
      ranges.push({ lo: Math.min(pa, pb), hi: Math.max(pa, pb), row: s.row, length: Math.abs(pb - pa) * len });
    }
    ranges.sort((p, q) => p.row - q.row);
    const ordered = [...stops.entries()].sort((p, q) => p[1] - q[1]);
    // Endpoints within tolerance along the axis are already one vertex
    // (step 1 joined them); two distinct vertices can still project to
    // parameters closer than that when they are off-axis. Keep the earlier
    // as the stop and let the later collapse into it.
    const slack = tol / len;
    const chosen: [number, number][] = [];
    for (const [v, t] of ordered) {
      const last = chosen[chosen.length - 1];
      if (last && t - last[1] <= slack) continue;
      chosen.push([v, t]);
    }
    for (let s = 0; s + 1 < chosen.length; s++) {
      const [va, ta] = chosen[s];
      const [vb, tb] = chosen[s + 1];
      const mid = (ta + tb) / 2;
      const cover = ranges.find((r) => r.lo <= mid + slack && r.hi >= mid - slack);
      if (!cover) continue; // a gap between two runs on one line
      const src = segs.find((x) => x.row === cover.row)!;
      const whole = (src.a === va && src.b === vb) || (src.a === vb && src.b === va);
      const share = cover.length > 0 ? ((tb - ta) * len) / cover.length : 1;
      // Its own span, uncut and covered by nothing else: the edge it was.
      const alone = whole && ranges.every((r) => r.row === cover.row || r.hi <= ta + slack || r.lo >= tb - slack);
      push(va, vb, cover.row, alone ? 1 : Math.min(1, share), alone);
    }
  }
  const attrs: Record<string, Float64Array> = {};
  for (const name of names) attrs[name] = Float64Array.from(oattrs[name]);
  const edgeAttrs: Record<string, Float64Array> = {};
  for (const name of enames) edgeAttrs[name] = Float64Array.from(eattrs[name]);
  return new Material(Float64Array.from(ox), Float64Array.from(oy), attrs, Uint32Array.from(edges), {
    iteration: 0,
    edgeAttrs,
    transfers: { ...m.transfers },
    edgeTransfers: { ...m.edgeTransfers },
    ids: { points: Float64Array.from(oids), edges: Float64Array.from(eids), edgeRoots: Float64Array.from(eroots) },
    faceAttrs: m.faceAttrs,
  });
}
