/**
 * thicken: give points and connections thickness, resolve their combined
 * coverage, and return ordinary boundary Material.
 *
 * Every participating vertex carries a radius and every participating edge
 * sweeps the disc at one end into the disc at the other with the radius
 * interpolated linearly along it. Because centre and radius both interpolate
 * linearly, that swept area is exactly the convex hull of the two endpoint
 * discs — two common tangent segments and the two exposed arcs — so the union
 * of every contribution has an analytic boundary of straight intervals and
 * circular arcs, and no circle sampling is needed to decide connectivity.
 * Those boundaries are split at their real events, intervals another
 * contribution covers are dropped, coincident exposed boundaries are merged,
 * and the survivors are stitched into closed walks with the coverage on the
 * left: outer contours positive, holes negative.
 *
 * Pure and deterministic, like `distanceTo`: a module import with no sketch
 * frame, seed, pen, paper or renderer. The result is a fresh Material of
 * closed chains — ready for `polygon`, `strokes`, `along`, `distanceTo`,
 * `t.within` and the material inspection paths. `tolerance` only bounds the
 * deviation of the tessellated arcs; it is not a weld distance, a nib
 * threshold or a simplification strength.
 */

import { orient2d } from 'robust-predicates';
import { Material, material as makeMaterial, unit, type Vertex } from './material.js';
import { EdgeSelection, PointSelection } from './relation.js';
import type { EventCandidate, PlanarEvent } from './faces.js';

/** How `thicken` resolves a source into thickness. */
export interface ThickenOpts {
  /** Required. Radius in the source material's coordinate units: one number
   * for every participating vertex, or a callback read from the vertex view
   * (its real attributes — `p.radius`, not `p.attrs.radius`). */
  radius: number | ((p: Vertex) => number);

  /** Positive boundary-approximation error for the curved parts, in the same
   * units. Default 0.05. Larger means coarser arcs, never a smaller shape. */
  tolerance?: number;

  /** Optional creation of output point attributes: called once per final
   * output vertex with the boundary position and the source generators that
   * meet there. The returned record is the complete output row. */
  point?: (event: PlanarEvent) => Record<string, number>;
}

// ---- internal construction data --------------------------------------------------

/** A source-generator candidate at an output vertex, before attributes. */
type Cand = { vertex?: number; edge?: number; t?: number };

/** What produced one primitive: a vertex disc, or an edge's two-disc hull
 * with the stored a → b parameter at both analytic endpoints. */
type Gen =
  | { vertex: number }
  | { edge: number; a: number; b: number; t0: number; t1: number };

/** One construction point. Shared between every primitive that meets it, so
 * an intersection's coordinates are computed once and never welded. */
interface Pt {
  id: number;
  x: number;
  y: number;
}

interface Split {
  p: number;
  pt: Pt;
}

/** Edge-like coverage: centreline a → b with the radius at each end. A
 * vertex-only contribution is a === b. */
interface Shape {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  ra: number;
  rb: number;
  va: number;
  vb: number;
  /** Source edge row, or −1 for a vertex-only disc. */
  edge: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface PrimBase {
  start: Pt;
  end: Pt;
  splits: Split[];
  shapes: number[];
  gens: Gen[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface SegPrim extends PrimBase {
  kind: 'seg';
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface ArcPrim extends PrimBase {
  kind: 'arc';
  cx: number;
  cy: number;
  r: number;
  a0: number;
  a1: number;
  full: boolean;
}

type Prim = SegPrim | ArcPrim;

interface Piece {
  prim: Prim;
  p0: number;
  p1: number;
  start: Pt;
  end: Pt;
  shapes: number[];
  gens: Gen[];
  /** Departure direction at `start`. */
  sTan: [number, number];
  /** Arrival direction at `end` (direction of travel). */
  eTan: [number, number];
}

interface OutVert {
  x: number;
  y: number;
  cands: Cand[];
}

const TAU = Math.PI * 2;
const EPS_PARAM = 1e-12;
const EPS_ANGLE = 1e-12;
const MAX_ARC_SEGMENTS = 1_000_000;

// ---- shared construction points --------------------------------------------------

/** Shared construction points. Two primitives that meet must name one
 * point, so an already-recorded point within `tol` is reused: a near-tangency
 * and a collinear junction can compute the same geometric vertex through
 * different formulas and land a few ulps apart. */
class Events {
  private readonly grid = new Map<string, Pt[]>();
  private readonly size: number;
  private count = 0;

  constructor(tol: number) {
    this.size = Math.max(tol, 1e-300) * 2;
  }

  at(x: number, y: number): Pt {
    const ix = Math.floor(x / this.size);
    const iy = Math.floor(y / this.size);
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        const cell = this.grid.get(`${ix + di},${iy + dj}`);
        if (!cell) continue;
        for (const p of cell) {
          if (Math.abs(p.x - x) <= this.size / 2 && Math.abs(p.y - y) <= this.size / 2) return p;
        }
      }
    }
    const e: Pt = { id: this.count++, x: x === 0 ? 0 : x, y: y === 0 ? 0 : y };
    const key = `${ix},${iy}`;
    const cell = this.grid.get(key);
    if (cell) cell.push(e);
    else this.grid.set(key, [e]);
    return e;
  }
}

// ---- numeric helpers -------------------------------------------------------------

/** The counter-clockwise span from one direction angle to another, in [0, 2π). */
function ccwSpan(from: number, to: number): number {
  let d = to - from;
  while (d < 0) d += TAU;
  while (d >= TAU) d -= TAU;
  return d;
}

/** `angle` pulled into `[a0, a1]`, or null when it lies outside. */
function angleInArc(angle: number, a0: number, a1: number): number | null {
  let q = angle;
  while (q < a0 - Math.PI) q += TAU;
  while (q > a0 + Math.PI) q -= TAU;
  while (q < a0) q += TAU;
  while (q > a1) q -= TAU;
  if (q < a0 - EPS_ANGLE || q > a1 + EPS_ANGLE) return null;
  return Math.min(a1, Math.max(a0, q));
}

function paramOnSeg(s: SegPrim, x: number, y: number): number {
  const dx = s.x1 - s.x0;
  const dy = s.y1 - s.y0;
  return ((x - s.x0) * dx + (y - s.y0) * dy) / (dx * dx + dy * dy);
}

function primPoint(prim: Prim, p: number): [number, number] {
  if (prim.kind === 'seg') {
    return [prim.x0 + (prim.x1 - prim.x0) * p, prim.y0 + (prim.y1 - prim.y0) * p];
  }
  return [prim.cx + prim.r * Math.cos(p), prim.cy + prim.r * Math.sin(p)];
}

// ---- coverage predicates ---------------------------------------------------------

/** Is `(x, y)` inside the coverage of one edge-like shape? `F(t)` is the
 * squared distance to the moving centre minus the moving radius squared,
 * minimised over the edge's parameter — the independent membership formula
 * the analytic boundary is checked against. */
function shapeContains(s: Shape, x: number, y: number): boolean {
  const qx = x - s.ax;
  const qy = y - s.ay;
  const dx = s.bx - s.ax;
  const dy = s.by - s.ay;
  const dr = s.rb - s.ra;
  const A = dx * dx + dy * dy - dr * dr;
  const B = -2 * ((qx * dx + qy * dy) + s.ra * dr);
  const C = qx * qx + qy * qy - s.ra * s.ra;
  const f = (t: number) => A * t * t + B * t + C;
  let best = Math.min(f(0), f(1));
  if (A > 0) {
    const t = Math.min(1, Math.max(0, -B / (2 * A)));
    best = Math.min(best, f(t));
  }
  return best <= 0;
}

/** A uniform grid of shape bounding boxes, so a midpoint tests only nearby
 * coverage rather than every edge of the source. */
function shapeLookup(shapes: readonly Shape[]): (x: number, y: number) => readonly number[] {
  const n = shapes.length;
  if (n === 0) return () => [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of shapes) {
    minX = Math.min(minX, s.minX);
    minY = Math.min(minY, s.minY);
    maxX = Math.max(maxX, s.maxX);
    maxY = Math.max(maxY, s.maxY);
  }
  const cells = Math.max(1, Math.min(96, Math.ceil(Math.sqrt(n))));
  const w = Math.max(maxX - minX, 1e-9);
  const h = Math.max(maxY - minY, 1e-9);
  const buckets: number[][] = Array.from({ length: cells * cells }, () => []);
  const col = (x: number) => Math.min(cells - 1, Math.max(0, Math.floor(((x - minX) / w) * cells)));
  const row = (y: number) => Math.min(cells - 1, Math.max(0, Math.floor(((y - minY) / h) * cells)));
  for (let i = 0; i < n; i++) {
    const s = shapes[i];
    const c0 = col(s.minX);
    const c1 = col(s.maxX);
    const r0 = row(s.minY);
    const r1 = row(s.maxY);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) buckets[r * cells + c].push(i);
  }
  return (x, y) => buckets[row(y) * cells + col(x)] ?? [];
}

// ---- primitive construction ------------------------------------------------------

function segPrim(x0: number, y0: number, x1: number, y1: number, gen: Gen, shape: number, events: Events): SegPrim {
  const start = events.at(x0, y0);
  const end = events.at(x1, y1);
  return {
    kind: 'seg',
    x0, y0, x1, y1,
    start, end,
    splits: [{ p: 0, pt: start }, { p: 1, pt: end }],
    shapes: [shape],
    gens: [gen],
    minX: Math.min(x0, x1),
    minY: Math.min(y0, y1),
    maxX: Math.max(x0, x1),
    maxY: Math.max(y0, y1),
  };
}

function arcPrim(
  cx: number, cy: number, r: number, a0: number, a1: number, full: boolean,
  gens: Gen[], shape: number, start: Pt, end: Pt,
): ArcPrim {
  // The endpoints keep their own coordinates; interior sampling reads the
  // circle. `start`/`end` are the shared events the neighbouring primitive
  // also meets, so no arc endpoint is re-derived through cos/sin.
  return {
    kind: 'arc',
    cx, cy, r, a0, a1, full,
    start, end,
    splits: [{ p: a0, pt: start }, { p: a1, pt: end }],
    shapes: [shape],
    gens,
    minX: cx - r,
    minY: cy - r,
    maxX: cx + r,
    maxY: cy + r,
  };
}

/** Every analytic boundary element of every shape: the two-disc hull's
 * tangent segments and exposed arcs, or the single larger/full disc. */
function buildPrims(shapes: readonly Shape[], events: Events): Prim[] {
  const prims: Prim[] = [];
  for (let si = 0; si < shapes.length; si++) {
    const s = shapes[si];
    const dx = s.bx - s.ax;
    const dy = s.by - s.ay;
    const L = Math.hypot(dx, dy);
    const dr = s.rb - s.ra;
    if (L === 0 || Math.abs(dr) >= L) {
      // One disc contains the other; the hull is that disc.
      let cx = s.ax;
      let cy = s.ay;
      let gens: Gen[];
      if (s.rb > s.ra) {
        cx = s.bx;
        cy = s.by;
        gens = [{ vertex: s.vb }];
      } else if (s.ra > s.rb) {
        gens = [{ vertex: s.va }];
      } else {
        // Coincident centres, equal radii: one disc with two generators.
        gens = s.va === s.vb ? [{ vertex: s.va }] : [{ vertex: s.va }, { vertex: s.vb }];
      }
      const disc = Math.max(s.ra, s.rb);
      const start = events.at(cx + disc, cy);
      prims.push(arcPrim(cx, cy, disc, 0, TAU, true, gens, si, start, start));
      continue;
    }

    const ux = dx / L;
    const uy = dy / L;
    const vx = -uy;
    const vy = ux;
    const k = dr / L;
    const sq = Math.sqrt(Math.max(0, 1 - k * k));
    const npx = -k * ux + sq * vx;
    const npy = -k * uy + sq * vy;
    const nmx = -k * ux - sq * vx;
    const nmy = -k * uy - sq * vy;

    const Apx = s.ax + s.ra * npx;
    const Apy = s.ay + s.ra * npy;
    const Bpx = s.bx + s.rb * npx;
    const Bpy = s.by + s.rb * npy;
    const Amx = s.ax + s.ra * nmx;
    const Amy = s.ay + s.ra * nmy;
    const Bmx = s.bx + s.rb * nmx;
    const Bmy = s.by + s.rb * nmy;

    // Tangent segments, interior of the hull on the left of travel.
    const edgeGen = (t0: number, t1: number): Gen => ({ edge: s.edge, a: s.va, b: s.vb, t0, t1 });
    prims.push(segPrim(Bpx, Bpy, Apx, Apy, edgeGen(1, 0), si, events));
    prims.push(segPrim(Amx, Amy, Bmx, Bmy, edgeGen(0, 1), si, events));

    const angP = Math.atan2(npy, npx);
    const angM = Math.atan2(nmy, nmx);
    if (s.ra > 0) {
      const span = ccwSpan(angP, angM);
      if (span > EPS_ANGLE) {
        prims.push(arcPrim(s.ax, s.ay, s.ra, angP, angP + span, false, [{ vertex: s.va }], si,
          events.at(Apx, Apy), events.at(Amx, Amy)));
      }
    }
    if (s.rb > 0) {
      const span = ccwSpan(angM, angP);
      if (span > EPS_ANGLE) {
        prims.push(arcPrim(s.bx, s.by, s.rb, angM, angM + span, false, [{ vertex: s.vb }], si,
          events.at(Bmx, Bmy), events.at(Bpx, Bpy)));
      }
    }
  }
  return prims;
}

// ---- pairwise events -------------------------------------------------------------

function addSplit(prim: Prim, p: number, pt: Pt): void {
  prim.splits.push({ p, pt });
}

/** The endpoint a computed intersection coincides with, within the
 * floating-point error a near-tangency amplifies — so a tangent line's
 * grazing contact lands on the vertex it grazes instead of beside it. */
function snapTo(pts: readonly Pt[], x: number, y: number, tol: number): Pt | null {
  for (const p of pts) if (Math.abs(p.x - x) <= tol && Math.abs(p.y - y) <= tol) return p;
  return null;
}

function segSeg(a: SegPrim, b: SegPrim, events: Events, tol: number): void {
  const a0 = orient2d(a.x0, a.y0, a.x1, a.y1, b.x0, b.y0);
  const a1 = orient2d(a.x0, a.y0, a.x1, a.y1, b.x1, b.y1);
  const b0 = orient2d(b.x0, b.y0, b.x1, b.y1, a.x0, a.y0);
  const b1 = orient2d(b.x0, b.y0, b.x1, b.y1, a.x1, a.y1);
  if (a0 === 0 && a1 === 0) {
    // Collinear: each endpoint that lies inside the other becomes a split of
    // the other, at the endpoint's own coordinates so coincident sub-pieces align.
    const ta0 = paramOnSeg(a, b.x0, b.y0);
    const ta1 = paramOnSeg(a, b.x1, b.y1);
    if (ta0 > EPS_PARAM && ta0 < 1 - EPS_PARAM) addSplit(a, ta0, events.at(b.x0, b.y0));
    if (ta1 > EPS_PARAM && ta1 < 1 - EPS_PARAM) addSplit(a, ta1, events.at(b.x1, b.y1));
    const tb0 = paramOnSeg(b, a.x0, a.y0);
    const tb1 = paramOnSeg(b, a.x1, a.y1);
    if (tb0 > EPS_PARAM && tb0 < 1 - EPS_PARAM) addSplit(b, tb0, events.at(a.x0, a.y0));
    if (tb1 > EPS_PARAM && tb1 < 1 - EPS_PARAM) addSplit(b, tb1, events.at(a.x1, a.y1));
    return;
  }
  if (a0 === 0) {
    const t = paramOnSeg(a, b.x0, b.y0);
    if (t > EPS_PARAM && t < 1 - EPS_PARAM) addSplit(a, t, events.at(b.x0, b.y0));
  }
  if (a1 === 0) {
    const t = paramOnSeg(a, b.x1, b.y1);
    if (t > EPS_PARAM && t < 1 - EPS_PARAM) addSplit(a, t, events.at(b.x1, b.y1));
  }
  if (b0 === 0) {
    const t = paramOnSeg(b, a.x0, a.y0);
    if (t > EPS_PARAM && t < 1 - EPS_PARAM) addSplit(b, t, events.at(a.x0, a.y0));
  }
  if (b1 === 0) {
    const t = paramOnSeg(b, a.x1, a.y1);
    if (t > EPS_PARAM && t < 1 - EPS_PARAM) addSplit(b, t, events.at(a.x1, a.y1));
  }
  if ((a0 > 0) !== (a1 > 0) && (b0 > 0) !== (b1 > 0)) {
    const t = b0 / (b0 - b1);
    const x = a.x0 + (a.x1 - a.x0) * t;
    const y = a.y0 + (a.y1 - a.y0) * t;
    const pt = snapTo([a.start, a.end, b.start, b.end], x, y, tol) ?? events.at(x, y);
    const ta = paramOnSeg(a, pt.x, pt.y);
    const tb = paramOnSeg(b, pt.x, pt.y);
    if (ta > EPS_PARAM && ta < 1 - EPS_PARAM) addSplit(a, ta, pt);
    if (tb > EPS_PARAM && tb < 1 - EPS_PARAM) addSplit(b, tb, pt);
  }
}

function segArc(s: SegPrim, arc: ArcPrim, events: Events, tol: number): void {
  const dx = s.x1 - s.x0;
  const dy = s.y1 - s.y0;
  const fx = s.x0 - arc.cx;
  const fy = s.y0 - arc.cy;
  const A = dx * dx + dy * dy;
  const B = 2 * (fx * dx + fy * dy);
  const C = fx * fx + fy * fy - arc.r * arc.r;
  let disc = B * B - 4 * A * C;
  const discScale = B * B + Math.abs(4 * A * C) + 1;
  if (disc < -1e-12 * discScale) return;
  if (disc < 0) disc = 0;
  const sq = Math.sqrt(disc);
  const roots = sq <= EPS_PARAM ? [-B / (2 * A)] : [(-B - sq) / (2 * A), (-B + sq) / (2 * A)];
  for (const t of roots) {
    const x = s.x0 + dx * t;
    const y = s.y0 + dy * t;
    const pt = snapTo([s.start, s.end, arc.start, arc.end], x, y, tol) ?? events.at(x, y);
    const tt = paramOnSeg(s, pt.x, pt.y);
    if (tt < -EPS_PARAM || tt > 1 + EPS_PARAM) continue;
    const ang = angleInArc(Math.atan2(pt.y - arc.cy, pt.x - arc.cx), arc.a0, arc.a1);
    if (ang === null) continue;
    if (tt > EPS_PARAM && tt < 1 - EPS_PARAM) addSplit(s, tt, pt);
    if (ang > arc.a0 + EPS_ANGLE && ang < arc.a1 - EPS_ANGLE) addSplit(arc, ang, pt);
  }
}

function sameCircle(a: ArcPrim, b: ArcPrim, events: Events): void {
  for (const [target, other] of [[a, b], [b, a]] as const) {
    for (const pt of [other.start, other.end]) {
      const ang = angleInArc(Math.atan2(pt.y - target.cy, pt.x - target.cx), target.a0, target.a1);
      if (ang === null) continue;
      if (ang < target.a0 + EPS_ANGLE || ang > target.a1 - EPS_ANGLE) continue;
      addSplit(target, ang, events.at(pt.x, pt.y));
    }
  }
}

function arcArc(a: ArcPrim, b: ArcPrim, events: Events, tol: number): void {
  if (a.cx === b.cx && a.cy === b.cy) {
    if (a.r === b.r) sameCircle(a, b, events);
    return;
  }
  const dx = b.cx - a.cx;
  const dy = b.cy - a.cy;
  const d = Math.hypot(dx, dy);
  if (d > a.r + b.r + tol || d < Math.abs(a.r - b.r) - tol) return;
  const p = (a.r * a.r - b.r * b.r + d * d) / (2 * d);
  let h2 = a.r * a.r - p * p;
  if (h2 < 0) h2 = 0;
  const ux = dx / d;
  const uy = dy / d;
  const bx = a.cx + p * ux;
  const by = a.cy + p * uy;
  const h = Math.sqrt(h2);
  const raw: [number, number][] = h <= EPS_PARAM * Math.max(1, a.r)
    ? [[bx, by]]
    : [[bx - h * uy, by + h * ux], [bx + h * uy, by - h * ux]];
  for (const [x, y] of raw) {
    const pt = snapTo([a.start, a.end, b.start, b.end], x, y, tol) ?? events.at(x, y);
    const aa = angleInArc(Math.atan2(pt.y - a.cy, pt.x - a.cx), a.a0, a.a1);
    const ba = angleInArc(Math.atan2(pt.y - b.cy, pt.x - b.cx), b.a0, b.a1);
    if (aa === null || ba === null) continue;
    if (aa > a.a0 + EPS_ANGLE && aa < a.a1 - EPS_ANGLE) addSplit(a, aa, pt);
    if (ba > b.a0 + EPS_ANGLE && ba < b.a1 - EPS_ANGLE) addSplit(b, ba, pt);
  }
}

function intersect(a: Prim, b: Prim, events: Events, tol: number): void {
  if (a.kind === 'seg' && b.kind === 'seg') segSeg(a, b, events, tol);
  else if (a.kind === 'seg' && b.kind === 'arc') segArc(a, b, events, tol);
  else if (a.kind === 'arc' && b.kind === 'seg') segArc(b, a, events, tol);
  else if (a.kind === 'arc' && b.kind === 'arc') arcArc(a, b, events, tol);
}

/** Box-overlap sweep: only primitives whose boxes meet reach the exact tests. */
function sweepPairs(prims: readonly Prim[], visit: (i: number, j: number) => void): void {
  const n = prims.length;
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  const arr = Array.from(order);
  arr.sort((p, q) => prims[p].minX - prims[q].minX || p - q);
  for (let oi = 0; oi < n; oi++) {
    const i = arr[oi];
    const maxX = prims[i].maxX;
    const minY = prims[i].minY;
    const maxY = prims[i].maxY;
    for (let oj = oi + 1; oj < n; oj++) {
      const j = arr[oj];
      if (prims[j].minX > maxX) break;
      if (prims[j].minY > maxY || prims[j].maxY < minY) continue;
      visit(i < j ? i : j, i < j ? j : i);
    }
  }
}

// ---- splitting, classification, assembly -----------------------------------------

function arcSegments(r: number, span: number, tol: number): number {
  if (!(span > 0) || r <= 0) return 1;
  const ratio = tol / r;
  const step = ratio >= 1 ? Math.PI : 2 * Math.acos(1 - ratio);
  const n = Math.max(1, Math.ceil(span / step), Math.ceil(span / (Math.PI / 4)));
  if (n > MAX_ARC_SEGMENTS) {
    throw new Error(`thicken: one arc needs ${n} segments (radius ${r}, tolerance ${tol}) — above the internal limit of ${MAX_ARC_SEGMENTS}; raise tolerance`);
  }
  return n;
}

function pieceTangents(prim: Prim, p0: number, p1: number): { sTan: [number, number]; eTan: [number, number] } {
  if (prim.kind === 'seg') {
    const d = unit([prim.x1 - prim.x0, prim.y1 - prim.y0]);
    return { sTan: d, eTan: d };
  }
  return { sTan: [-Math.sin(p0), Math.cos(p0)], eTan: [-Math.sin(p1), Math.cos(p1)] };
}

function makePieces(prim: Prim, events: Events): Piece[] {
  const out: Piece[] = [];
  const ptOf = new Map<number, Pt>();
  for (const s of prim.splits) ptOf.set(s.pt.id, s.pt);
  const emit = (p0: number, p1: number, a: Pt, b: Pt) => {
    if (p1 - p0 <= EPS_PARAM) return;
    const { sTan, eTan } = pieceTangents(prim, p0, p1);
    out.push({ prim, p0, p1, start: a, end: b, shapes: prim.shapes.slice(), gens: prim.gens.slice(), sTan, eTan });
  };

  if (prim.kind === 'seg') {
    const rows = prim.splits.slice().sort((x, y) => x.p - y.p);
    const kept: Split[] = [];
    for (const r of rows) {
      const p = Math.min(1, Math.max(0, r.p));
      if (kept.length && (kept[kept.length - 1].pt.id === r.pt.id || Math.abs(kept[kept.length - 1].p - p) <= EPS_PARAM)) continue;
      kept.push({ p, pt: r.pt });
    }
    for (let k = 1; k < kept.length; k++) emit(kept[k - 1].p, kept[k].p, kept[k - 1].pt, kept[k].pt);
    return out;
  }

  if (prim.full) {
    // Angles folded into [0, 2π), one entry per distinct event.
    const byId = new Map<number, number>();
    for (const sp of prim.splits) {
      let p = sp.p % TAU;
      if (p < 0) p += TAU;
      if (!byId.has(sp.pt.id)) byId.set(sp.pt.id, p);
    }
    if (byId.size < 2) {
      const base = byId.size === 1 ? [...byId.values()][0] : 0;
      const q = base + Math.PI;
      const pt = events.at(prim.cx + prim.r * Math.cos(q), prim.cy + prim.r * Math.sin(q));
      if (!byId.has(pt.id)) {
        byId.set(pt.id, ((q % TAU) + TAU) % TAU);
        ptOf.set(pt.id, pt);
      }
    }
    const list = Array.from(byId, ([id, p]) => ({ id, p })).sort((x, y) => x.p - y.p);
    for (let k = 0; k < list.length; k++) {
      const cur = list[k];
      const nxt = list[(k + 1) % list.length];
      const p1 = k === list.length - 1 ? nxt.p + TAU : nxt.p;
      const a = ptOf.get(cur.id)!;
      const b = ptOf.get(nxt.id)!;
      emit(cur.p, p1, a, b);
    }
    return out;
  }

  const rows = prim.splits.slice().sort((x, y) => x.p - y.p);
  const kept: Split[] = [];
  for (const r of rows) {
    const p = Math.min(prim.a1, Math.max(prim.a0, r.p));
    if (kept.length && (kept[kept.length - 1].pt.id === r.pt.id || Math.abs(kept[kept.length - 1].p - p) <= EPS_PARAM)) continue;
    kept.push({ p, pt: r.pt });
  }
  for (let k = 1; k < kept.length; k++) emit(kept[k - 1].p, kept[k].p, kept[k - 1].pt, kept[k].pt);
  return out;
}

function genKey(g: Gen): string {
  return 'vertex' in g ? `v${g.vertex}` : `e${g.edge}:${g.t0}:${g.t1}:${g.a}:${g.b}`;
}

function pieceKey(pc: Piece): string {
  if (pc.prim.kind === 'seg') return `s|${pc.start.id}|${pc.end.id}`;
  const p = pc.prim;
  return `a|${p.cx},${p.cy},${p.r}|${pc.start.id}|${pc.end.id}`;
}

function mergePiece(into: Piece, other: Piece): void {
  for (const s of other.shapes) if (!into.shapes.includes(s)) into.shapes.push(s);
  for (const g of other.gens) {
    const k = genKey(g);
    if (!into.gens.some((x) => genKey(x) === k)) into.gens.push(g);
  }
}

/** Candidate at one generator and one parameter along a piece. */
function genCand(g: Gen, p: number): Cand {
  if ('vertex' in g) return { vertex: g.vertex };
  let t = g.t0 + (g.t1 - g.t0) * p;
  if (t <= 0) return { vertex: g.a };
  if (t >= 1) return { vertex: g.b };
  if (t < 0) t = 0;
  if (t > 1) t = 1;
  return { edge: g.edge, t };
}

function candKey(c: Cand): string {
  return c.vertex !== undefined ? `v${c.vertex}` : `e${c.edge}:${c.t}`;
}

function candOrder(a: Cand, b: Cand): number {
  const av = a.vertex ?? Infinity;
  const bv = b.vertex ?? Infinity;
  if (av !== bv) return av - bv;
  const ae = a.edge ?? Infinity;
  const be = b.edge ?? Infinity;
  if (ae !== be) return ae - be;
  return (a.t ?? 0) - (b.t ?? 0);
}

/** Clockwise angle from direction `r` to direction `o`, in [0, 2π). */
function clockwiseAngle(r: [number, number], o: [number, number]): number {
  const ccw = Math.atan2(r[0] * o[1] - r[1] * o[0], r[0] * o[0] + r[1] * o[1]);
  let th = -ccw;
  if (th < 0) th += TAU;
  if (th >= TAU) th -= TAU;
  if (th < EPS_ANGLE || th > TAU - EPS_ANGLE) return 0;
  return th;
}

/** Closed walks from the kept intervals, coverage on the left. At a point
 * contact the degenerate straight reversal is skipped, so each traversal
 * keeps its own loop and no degree-4 weld forms. */
function walkCycles(pieces: readonly Piece[]): number[][] {
  const outgoing = new Map<number, number[]>();
  for (let i = 0; i < pieces.length; i++) {
    const list = outgoing.get(pieces[i].start.id);
    if (list) list.push(i);
    else outgoing.set(pieces[i].start.id, [i]);
  }
  const next = new Int32Array(pieces.length).fill(-1);
  for (let i = 0; i < pieces.length; i++) {
    const cands = outgoing.get(pieces[i].end.id);
    if (!cands || cands.length === 0) {
      throw new Error('thicken: the resolved boundary has an open end — this input hit a numerical degeneracy; nudge a coordinate or change tolerance');
    }
    const r: [number, number] = [-pieces[i].eTan[0], -pieces[i].eTan[1]];
    let best = -1;
    let bestTheta = Infinity;
    let any = -1;
    let anyTheta = Infinity;
    for (const j of cands) {
      const th = clockwiseAngle(r, pieces[j].sTan);
      if (th < anyTheta) { anyTheta = th; any = j; }
      if (th <= EPS_ANGLE) continue;
      if (th < bestTheta) { bestTheta = th; best = j; }
    }
    next[i] = best >= 0 ? best : any;
  }
  const used = new Uint8Array(pieces.length);
  const cycles: number[][] = [];
  for (let i = 0; i < pieces.length; i++) {
    if (used[i]) continue;
    const cycle: number[] = [];
    let j = i;
    while (!used[j]) {
      used[j] = 1;
      cycle.push(j);
      j = next[j];
      if (j < 0) throw new Error('thicken: boundary walk left the arrangement — this input hit a numerical degeneracy; nudge a coordinate or change tolerance');
    }
    if (j !== i) {
      throw new Error('thicken: boundary walk did not close — this input hit a numerical degeneracy; nudge a coordinate or change tolerance');
    }
    cycles.push(cycle);
  }
  return cycles;
}

// ---- canonical output ------------------------------------------------------------

function loopArea(loop: readonly OutVert[]): number {
  let a = 0;
  for (let k = 0; k < loop.length; k++) {
    const p = loop[k];
    const q = loop[(k + 1) % loop.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

function canonicalize(loop: OutVert[]): OutVert[] {
  // Same coordinate twice in a row is one vertex (merge its candidates).
  const compact: OutVert[] = [];
  for (const v of loop) {
    const last = compact[compact.length - 1];
    if (last && last.x === v.x && last.y === v.y) {
      for (const c of v.cands) if (!last.cands.some((x) => candKey(x) === candKey(c))) last.cands.push(c);
      continue;
    }
    compact.push({ x: v.x, y: v.y, cands: v.cands.slice() });
  }
  if (compact.length > 1) {
    const first = compact[0];
    const last = compact[compact.length - 1];
    if (first.x === last.x && first.y === last.y) {
      for (const c of last.cands) if (!first.cands.some((x) => candKey(x) === candKey(c))) first.cands.push(c);
      compact.pop();
    }
  }
  if (compact.length < 3) return [];
  // Deterministic start: the lexicographically smallest vertex.
  let start = 0;
  for (let k = 1; k < compact.length; k++) {
    const v = compact[k];
    const s = compact[start];
    if (v.x < s.x || (v.x === s.x && v.y < s.y)) start = k;
  }
  const out = compact.slice(start).concat(compact.slice(0, start));
  for (const v of out) v.cands.sort(candOrder);
  return out;
}

// ---- public entry -----------------------------------------------------------------

function candidateAttrs(c: Cand, source: Material): Record<string, number> {
  const out: Record<string, number> = {};
  if (c.vertex !== undefined) {
    for (const name of source.attrNames) out[name] = source.attrs[name][c.vertex];
    return out;
  }
  const e = c.edge!;
  const t = c.t!;
  const a = source.edgeList[2 * e];
  const b = source.edgeList[2 * e + 1];
  for (const name of source.attrNames) {
    const va = source.attrs[name][a];
    const vb = source.attrs[name][b];
    out[name] = source.transfers[name] === 'nearest' ? (t <= 0.5 ? va : vb) : va + (vb - va) * t;
  }
  return out;
}

function checkOpts(opts: ThickenOpts): number {
  if (typeof opts !== 'object' || opts === null || Array.isArray(opts)) {
    throw new Error('thicken: options must be an object with a radius');
  }
  for (const key of Object.keys(opts)) {
    if (key !== 'radius' && key !== 'tolerance' && key !== 'point') throw new Error(`thicken: unknown option '${key}'`);
  }
  const radius = opts.radius;
  if (radius === undefined) throw new Error('thicken: radius is required');
  if (typeof radius !== 'number' && typeof radius !== 'function') {
    throw new Error('thicken: radius must be a number or a function of a vertex');
  }
  if (typeof radius === 'number' && (!Number.isFinite(radius) || radius < 0)) {
    throw new Error(`thicken: radius must be finite and non-negative, got ${radius}`);
  }
  const tol = opts.tolerance ?? 0.05;
  if (typeof tol !== 'number' || !Number.isFinite(tol) || tol <= 0) {
    throw new Error(`thicken: tolerance must be finite and greater than zero, got ${String(opts.tolerance)}`);
  }
  if (opts.point !== undefined && typeof opts.point !== 'function') {
    throw new Error('thicken: point must be a function of an event');
  }
  return tol;
}

/**
 * Give `source`'s points and connections thickness: the union of every
 * participating vertex's disc and every participating edge's variable-radius
 * disc envelope, as ordinary boundary Material.
 *
 * Participation: a Material contributes every vertex (isolated ones as bare
 * discs) and every edge; a point selection contributes its selected vertices
 * — including selected vertices with no selected neighbour, which stay bare
 * discs — and the edges whose both endpoints are selected; an edge selection
 * contributes its edges and their endpoints only.
 *
 * `radius` is one number or a callback over the source's own vertex views,
 * evaluated once per participating vertex in source row order. `tolerance`
 * (default 0.05, source units) bounds the arc tessellation only. Without
 * `point` the result is geometry only; with `point` each final boundary
 * vertex gets the callback's record as its complete attribute row.
 */
export function thicken(
  source: Material | PointSelection<unknown> | EdgeSelection<unknown>,
  opts: ThickenOpts,
): Material {
  const tol = checkOpts(opts);

  let src: Material;
  let vRows: readonly number[];
  let eRows: readonly number[];
  if (source instanceof Material) {
    src = source;
    const v: number[] = [];
    for (let i = 0; i < source.n; i++) v.push(i);
    const e: number[] = [];
    for (let i = 0; i < source.edgeCount; i++) e.push(i);
    vRows = v;
    eRows = e;
  } else if (source instanceof PointSelection) {
    src = source.source;
    vRows = source.indices;
    eRows = source.inducedEdges().indices;
  } else if (source instanceof EdgeSelection) {
    src = source.source;
    vRows = source.endpointRows;
    eRows = source.indices;
  } else {
    throw new Error('thicken: source must be a Material, a point selection or an edge selection');
  }

  if (vRows.length === 0) return makeMaterial([]);

  const radii = new Float64Array(src.n);
  radii.fill(NaN);
  for (const row of vRows) {
    const x = src.x[row];
    const y = src.y[row];
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`thicken: vertex ${row} is not finite`);
    let r: number;
    if (typeof opts.radius === 'number') r = opts.radius;
    else r = opts.radius(src.vertex(row));
    if (typeof r !== 'number' || !Number.isFinite(r) || r < 0) {
      throw new Error(`thicken: radius for vertex ${row} must be finite and non-negative, got ${String(r)}`);
    }
    radii[row] = r;
  }

  // ---- coverage shapes: edges first, then isolated participating vertices ----
  const onEdge = new Set<number>();
  const shapes: Shape[] = [];
  for (const e of eRows) {
    const a = src.edgeList[2 * e];
    const b = src.edgeList[2 * e + 1];
    onEdge.add(a);
    onEdge.add(b);
    const ra = radii[a];
    const rb = radii[b];
    if (!(ra > 0) && !(rb > 0)) continue;
    shapes.push({
      ax: src.x[a], ay: src.y[a], bx: src.x[b], by: src.y[b], ra, rb, va: a, vb: b, edge: e,
      minX: Math.min(src.x[a] - ra, src.x[b] - rb),
      minY: Math.min(src.y[a] - ra, src.y[b] - rb),
      maxX: Math.max(src.x[a] + ra, src.x[b] + rb),
      maxY: Math.max(src.y[a] + ra, src.y[b] + rb),
    });
  }
  for (const row of vRows) {
    if (onEdge.has(row) || !(radii[row] > 0)) continue;
    const r = radii[row];
    shapes.push({
      ax: src.x[row], ay: src.y[row], bx: src.x[row], by: src.y[row], ra: r, rb: r, va: row, vb: row, edge: -1,
      minX: src.x[row] - r, minY: src.y[row] - r, maxX: src.x[row] + r, maxY: src.y[row] + r,
    });
  }
  if (shapes.length === 0) return makeMaterial([]);

  // ---- analytic primitives, their events, and the union's exposed intervals ----
  // A near-tangency amplifies floating point error to ~sqrt(eps) relative to
  // the coordinate magnitude; that is the only tolerance here, and it only
  // ever joins points that are PROVEN one vertex (shared endpoints, grazing
  // contacts, collinear junctions) — never a gap.
  let scale = 1;
  for (const s of shapes) scale = Math.max(scale, Math.abs(s.minX), Math.abs(s.minY), Math.abs(s.maxX), Math.abs(s.maxY));
  const snapTol = 1e-7 * scale;
  const events = new Events(snapTol);
  const prims = buildPrims(shapes, events);

  sweepPairs(prims, (i, j) => intersect(prims[i], prims[j], events, snapTol));

  const pieceMap = new Map<string, Piece>();
  for (const prim of prims) {
    for (const pc of makePieces(prim, events)) {
      const key = pieceKey(pc);
      const existing = pieceMap.get(key);
      if (existing) mergePiece(existing, pc);
      else pieceMap.set(key, pc);
    }
  }

  const lookup = shapeLookup(shapes);
  const kept: Piece[] = [];
  for (const pc of pieceMap.values()) {
    const pm = (pc.p0 + pc.p1) / 2;
    const [mx, my] = primPoint(pc.prim, pm);
    let covered = false;
    for (const si of lookup(mx, my)) {
      if (pc.shapes.includes(si)) continue;
      if (shapeContains(shapes[si], mx, my)) {
        covered = true;
        break;
      }
    }
    if (!covered) kept.push(pc);
  }
  if (kept.length === 0) return makeMaterial([]);

  // ---- candidates at every construction point ----
  const eventCands = new Map<number, Cand[]>();
  const addCand = (pt: Pt, c: Cand) => {
    let list = eventCands.get(pt.id);
    if (!list) { list = []; eventCands.set(pt.id, list); }
    if (!list.some((x) => candKey(x) === candKey(c))) list.push(c);
  };
  for (const pc of kept) {
    for (const g of pc.gens) {
      addCand(pc.start, genCand(g, pc.p0));
      addCand(pc.end, genCand(g, pc.p1));
    }
  }
  for (const list of eventCands.values()) list.sort(candOrder);

  // ---- closed walks, tessellated ----
  const loops: OutVert[][] = [];
  for (const cycle of walkCycles(kept)) {
    const verts: OutVert[] = [];
    for (const pi of cycle) {
      const pc = kept[pi];
      verts.push({ x: pc.start.x, y: pc.start.y, cands: eventCands.get(pc.start.id) ?? [] });
      if (pc.prim.kind === 'arc') {
        const span = pc.p1 - pc.p0;
        const n = arcSegments(pc.prim.r, span, tol);
        for (let k = 1; k < n; k++) {
          const p = pc.p0 + (span * k) / n;
          const [x, y] = primPoint(pc.prim, p);
          verts.push({ x, y, cands: pc.gens.map((g) => genCand(g, p)) });
        }
      }
    }
    const loop = canonicalize(verts);
    if (loop.length >= 3 && loopArea(loop) !== 0) loops.push(loop);
  }
  if (loops.length === 0) return makeMaterial([]);

  loops.sort((a, b) => {
    const aa = loopArea(a);
    const ab = loopArea(b);
    if (aa !== ab) return ab - aa;
    if (a[0].x !== b[0].x) return a[0].x - b[0].x;
    return a[0].y - b[0].y;
  });

  // ---- output material: fresh arrays, no inherited columns ----
  let total = 0;
  for (const loop of loops) total += loop.length;
  const x = new Float64Array(total);
  const y = new Float64Array(total);
  const edges = new Uint32Array(total * 2);
  let at = 0;
  let et = 0;
  for (const loop of loops) {
    const base = at;
    for (let k = 0; k < loop.length; k++) {
      x[at] = loop[k].x;
      y[at] = loop[k].y;
      at++;
    }
    for (let k = 0; k < loop.length; k++) {
      edges[et++] = base + k;
      edges[et++] = base + ((k + 1) % loop.length);
    }
  }

  let attrs: Record<string, Float64Array> = {};
  if (opts.point) {
    const point = opts.point;
    let schema: string[] | null = null;
    const cols: Record<string, Float64Array> = {};
    let index = 0;
    for (const loop of loops) {
      for (const v of loop) {
        const event: PlanarEvent = {
          position: [v.x, v.y],
          candidates: v.cands.map((c): EventCandidate => {
            const base: EventCandidate = { attrs: candidateAttrs(c, src) };
            if (c.vertex !== undefined) base.vertex = c.vertex;
            else { base.edge = c.edge; base.t = c.t; }
            return base;
          }),
        };
        let record: Record<string, number>;
        try {
          record = point(event);
        } catch (err) {
          const why = err instanceof Error ? err.message : String(err);
          throw new Error(`thicken: point callback threw at output vertex ${index} (${v.x}, ${v.y}): ${why}`);
        }
        if (typeof record !== 'object' || record === null) {
          throw new Error(`thicken: point callback must return a record for output vertex ${index}`);
        }
        const keys = Object.keys(record);
        for (const key of keys) {
          if (key === 'x' || key === 'y' || key === 'index') throw new Error(`thicken: point callback used reserved name '${key}' at output vertex ${index}`);
          if (!Number.isFinite(record[key])) throw new Error(`thicken: point callback returned a non-finite '${key}' at output vertex ${index}`);
        }
        if (schema === null) {
          schema = keys;
          for (const key of keys) cols[key] = new Float64Array(total);
        } else if (keys.length !== schema.length || schema.some((k) => !keys.includes(k))) {
          throw new Error(`thicken: point callback changed its columns at output vertex ${index} (expected ${schema.join(', ') || 'none'}; got ${keys.join(', ') || 'none'})`);
        }
        for (const key of schema) cols[key][index] = record[key];
        index++;
      }
    }
    attrs = cols;
  }

  return new Material(x, y, attrs, edges, 0, [], {}, {}, {});
}
