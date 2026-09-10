/**
 * A filled region and its actual boundary. Source edges are split at crossings
 * and overlap endpoints before classification: fill can change along an edge.
 * Side winding uses an infinitesimal normal, evaluated lexicographically rather
 * than by moving a finite distance. Original directed edges retain multiplicity,
 * so coincident edges reinforce or cancel according to the requested fill rule.
 *
 * Intersection coordinates are floating point; orientation signs use adaptive
 * predicates. Point-on-edge recognition has a coordinate-roundoff tolerance,
 * not a geometric offset. With n source edges and k split pieces, preparation
 * is O(n² + nk), sampling O(n + k). Dense intersections can make k quadratic.
 */

import { orient2d } from 'robust-predicates';
import { distanceTo } from './distance.js';
import { loopCrossings } from './material.js';

type Pt = readonly [number, number];

/** Crossings carry the query parameter `t` and the point, as `loopCrossings`. */
export interface AreaCrossing {
  t: number;
  x: number;
  y: number;
}

export interface AreaFill {
  /** Signed insideness: positive inside the filled region, 0 ON a real
   * boundary (which the engine's clip reads as outside, and a contained face
   * reads as belonging to it), negative outside. Only the sign is meaningful.
   * A point on an INTERIOR contour is positive: it is filled on both sides. */
  at(x: number, y: number): number;
  /** Where a segment crosses the REAL boundary, sorted and without duplicates
   * (a segment reported by both of its directions). */
  crossings(ax: number, ay: number, bx: number, by: number): AreaCrossing[];
  /** The real boundary segments, four numbers each: `[ax, ay, bx, by]`. A face
   * that strictly contains one of these covers excluded space. */
  readonly boundary: readonly (readonly [number, number, number, number])[];
}

interface Seg {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

/** Squared distance from a point to a segment. */
function dist2ToSeg(px: number, py: number, s: Seg): number {
  const dx = s.bx - s.ax;
  const dy = s.by - s.ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - s.ax) * dx + (py - s.ay) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = s.ax + dx * t - px;
  const qy = s.ay + dy * t - py;
  return qx * qx + qy * qy;
}

/**
 * The fill of `loops` under `rule`. `loops` are numeric and closed (the shape
 * lowering or `polygon`'s boundary resolution has already closed them).
 */
export function areaFill(loops: readonly (readonly Pt[])[], rule: 'evenodd' | 'nonzero'): AreaFill {
  const segs = segmentsOf(loops);
  const { pieces, overlaps } = splitSegments(segs);
  // Without coincident edges, parity flips at every contour. Preserve the
  // existing indexed distance field and crossing arithmetic on this common path.
  if (rule === 'evenodd' && !overlaps) {
    return {
      at: distanceTo(loops),
      crossings: (ax, ay, bx, by) => loopCrossings(loops, ax, ay, bx, by),
      boundary: segs.map((s) => [s.ax, s.ay, s.bx, s.by]),
    };
  }

  const filled = (w: number): boolean => rule === 'nonzero' ? w !== 0 : w % 2 !== 0;
  // robust-predicates uses the opposite sign from the usual cross product.
  const side = (s: Seg, x: number, y: number): number =>
    -orient2d(s.ax, s.ay, s.bx, s.by, x, y);
  // Evaluate at (x, y) + ε(nx, ny), ε positive and infinitesimal: compare
  // the constant term first and use the normal only to break an exact tie.
  const winding = (x: number, y: number, source?: Seg, nx = 0, ny = 0): number => {
    let w = 0;
    for (const s of segs) {
      // For a point infinitesimally displaced from a piece, collinear source
      // edges have exactly zero constant term, even if its midpoint rounded.
      const collinear = source && side(s, source.ax, source.ay) === 0 && side(s, source.bx, source.by) === 0;
      const constant = collinear ? 0 : side(s, x, y);
      const sign = Math.sign(constant) || Math.sign((s.bx - s.ax) * ny - (s.by - s.ay) * nx);
      const aboveA = y > s.ay || (y === s.ay && ny >= 0);
      const aboveB = y > s.by || (y === s.by && ny >= 0);
      if (aboveA && !aboveB && sign > 0) w++;
      else if (!aboveA && aboveB && sign < 0) w--;
    }
    return w;
  };

  const boundary: Seg[] = [];
  const interior: Seg[] = [];
  const exterior: Seg[] = [];
  for (const s of pieces) {
    const mx = s.ax + (s.bx - s.ax) / 2;
    const my = s.ay + (s.by - s.ay) / 2;
    const nx = -(s.by - s.ay);
    const ny = s.bx - s.ax;
    const left = filled(winding(mx, my, s.source, nx, ny));
    const right = filled(winding(mx, my, s.source, -nx, -ny));
    (left !== right ? boundary : left ? interior : exterior).push(s);
  }

  let magnitude = 1;
  for (const s of segs) magnitude = Math.max(magnitude, Math.abs(s.ax), Math.abs(s.ay), Math.abs(s.bx), Math.abs(s.by));
  const eps = 32 * Number.EPSILON * magnitude;
  const onAny = (list: readonly Seg[], x: number, y: number): boolean =>
    list.some((s) => dist2ToSeg(x, y, s) <= eps * eps);
  const boundaryLoops = boundary.map((s) => [[s.ax, s.ay], [s.bx, s.by]] as [number, number][]);
  return {
    at(x, y) {
      if (onAny(boundary, x, y)) return 0;
      if (onAny(interior, x, y)) return 1;
      if (onAny(exterior, x, y)) return -1;
      return filled(winding(x, y)) ? 1 : -1;
    },
    crossings(ax, ay, bx, by) {
      const hits = loopCrossings(boundaryLoops, ax, ay, bx, by);
      return hits.filter((h, k) => k === 0 || (h.t !== hits[k - 1].t
        && (h.x !== hits[k - 1].x || h.y !== hits[k - 1].y)));
    },
    boundary: boundary.map((s) => [s.ax, s.ay, s.bx, s.by]),
  };
}

interface Piece extends Seg { source: Seg }
interface Stop { t: number; x: number; y: number }

/** Split both proper intersections and collinear overlaps. A shared event uses
 * the same coordinates on both edges; existing endpoints are kept verbatim.
 * No snapping or quantisation: distinct, representable intervals stay distinct. */
function splitSegments(segs: Seg[]): { pieces: Piece[]; overlaps: boolean } {
  const stops: Stop[][] = segs.map((s) => [
    { t: 0, x: s.ax, y: s.ay }, { t: 1, x: s.bx, y: s.by },
  ]);
  const parameter = (s: Seg, x: number, y: number): number =>
    Math.abs(s.bx - s.ax) >= Math.abs(s.by - s.ay)
      ? (x - s.ax) / (s.bx - s.ax) : (y - s.ay) / (s.by - s.ay);
  const contact = (i: number, x: number, y: number): void => {
    const t = parameter(segs[i], x, y);
    if (t > 0 && t < 1) stops[i].push({ t, x, y });
  };
  let overlaps = false;
  for (let i = 0; i < segs.length; i++) {
    const a = segs[i];
    for (let j = i + 1; j < segs.length; j++) {
      const b = segs[j];
      if (Math.max(a.ax, a.bx) < Math.min(b.ax, b.bx) || Math.max(b.ax, b.bx) < Math.min(a.ax, a.bx)
        || Math.max(a.ay, a.by) < Math.min(b.ay, b.by) || Math.max(b.ay, b.by) < Math.min(a.ay, a.by)) continue;
      const a0 = orient2d(a.ax, a.ay, a.bx, a.by, b.ax, b.ay);
      const a1 = orient2d(a.ax, a.ay, a.bx, a.by, b.bx, b.by);
      const b0 = orient2d(b.ax, b.ay, b.bx, b.by, a.ax, a.ay);
      const b1 = orient2d(b.ax, b.ay, b.bx, b.by, a.bx, a.by);
      if (a0 === 0 && a1 === 0) {
        const t0 = parameter(a, b.ax, b.ay);
        const t1 = parameter(a, b.bx, b.by);
        if (Math.max(0, Math.min(t0, t1)) < Math.min(1, Math.max(t0, t1))) overlaps = true;
        contact(i, b.ax, b.ay); contact(i, b.bx, b.by);
        contact(j, a.ax, a.ay); contact(j, a.bx, a.by);
      } else if (a0 === 0 || a1 === 0 || b0 === 0 || b1 === 0) {
        if (a0 === 0) contact(i, b.ax, b.ay);
        if (a1 === 0) contact(i, b.bx, b.by);
        if (b0 === 0) contact(j, a.ax, a.ay);
        if (b1 === 0) contact(j, a.bx, a.by);
      } else if (Math.sign(a0) !== Math.sign(a1) && Math.sign(b0) !== Math.sign(b1)) {
        const dx = a.bx - a.ax, dy = a.by - a.ay;
        const ex = b.bx - b.ax, ey = b.by - b.ay;
        const ox = b.ax - a.ax, oy = b.ay - a.ay;
        const den = dx * ey - dy * ex;
        const t = (ox * ey - oy * ex) / den;
        const u = (ox * dy - oy * dx) / den;
        // Prefer an axis-aligned edge's parametrisation to retain exact x/y.
        const [x, y] = ex === 0 || ey === 0 ? [b.ax + u * ex, b.ay + u * ey] : [a.ax + t * dx, a.ay + t * dy];
        stops[i].push({ t, x, y }); stops[j].push({ t: u, x, y });
      }
    }
  }
  const pieces: Piece[] = [];
  for (let i = 0; i < segs.length; i++) {
    const row = stops[i].sort((a, b) => a.t - b.t);
    for (let k = 1; k < row.length; k++) {
      const a = row[k - 1], b = row[k];
      if (a.t === b.t || (a.x === b.x && a.y === b.y)) continue;
      pieces.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y, source: segs[i] });
    }
  }
  return { pieces, overlaps };
}

/** The non-degenerate segments of closed loops. */
function segmentsOf(loops: readonly (readonly Pt[])[]): Seg[] {
  const out: Seg[] = [];
  for (const loop of loops) {
    for (let k = 0; k < loop.length; k++) {
      const p = loop[k];
      const q = loop[(k + 1) % loop.length];
      if (p[0] === q[0] && p[1] === q[1]) continue;
      out.push({ ax: p[0], ay: p[1], bx: q[0], by: q[1] });
    }
  }
  return out;
}

/** Signed area (shoelace); positive for the outer orientation. */
function areaOf(loop: readonly Pt[]): number {
  let a = 0;
  for (let k = 0; k < loop.length; k++) {
    const p = loop[k];
    const q = loop[(k + 1) % loop.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/**
 * A point strictly inside the region `contours` bounds (its outer contour taken
 * as the one with the largest absolute signed area), or null when no probe
 * lands there. Step off an outer edge by a quarter of the distance to the
 * nearest other edge, halving until the signed distance test confirms an
 * interior point. This finite probe is independent of boundary classification.
 *
 * This is what tells a face that fills a hole from the annulus around it: their
 * walls are the same segments, so only their interiors differ.
 */
export function interiorPoint(contours: readonly (readonly Pt[])[]): Pt | null {
  const loops = contours.filter((c) => c.length >= 3);
  if (loops.length === 0) return null;
  const insideRegion = distanceTo(loops);
  const segs = segmentsOf(loops);
  const outer = loops.reduce((a, b) => (Math.abs(areaOf(b)) > Math.abs(areaOf(a)) ? b : a));
  for (let k = 0; k < outer.length; k++) {
    const p = outer[k];
    const q = outer[(k + 1) % outer.length];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (len === 0) continue;
    const mx = (p[0] + q[0]) / 2;
    const my = (p[1] + q[1]) / 2;
    const nx = -(q[1] - p[1]) / len;
    const ny = (q[0] - p[0]) / len;
    let near = Infinity;
    for (const s of segs) {
      if (s.ax === p[0] && s.ay === p[1] && s.bx === q[0] && s.by === q[1]) continue;
      near = Math.min(near, dist2ToSeg(mx, my, s));
    }
    let h = Math.min(len / 4, Math.sqrt(near) / 4);
    for (let tries = 0; tries < 8; tries++) {
      for (const sgn of [1, -1] as const) {
        const px = mx + sgn * nx * h;
        const py = my + sgn * ny * h;
        if (insideRegion(px, py) > 0) return [px, py];
      }
      h /= 2;
    }
  }
  return null;
}
