/**
 * The filled region an area names — winding-aware, so a contour that is not a
 * boundary of the fill is never read as one.
 *
 * The area consumers ask two questions: is this point inside the filled region,
 * and where does a segment cross the region's BOUNDARY. Under `evenodd` every
 * contour is a boundary — crossing one flips parity, so the two sides always
 * differ — and the answers are exactly the loops. Under `nonzero` a contour can
 * have filled space on BOTH sides: a nested loop wound the same way is interior
 * geometry, not a hole. Then it is not a boundary at all — a point on it is
 * inside, a material edge along it is not cut, and a face may cross or enclose
 * it — while the fill itself is `winding ≠ 0`, which is what `polygon` and the
 * engine's clip read.
 *
 * So the whole job is to classify each input segment: boundary or interior.
 * The probe distance is derived from the geometry rather than chosen — for a
 * segment's midpoint, a fraction of the distance to the nearest OTHER segment,
 * so a probe cannot cross anything, and the two probes on a side must agree
 * (the distance halves until they do). A probe reads a winding number, which is
 * exact away from the loops; the only tolerance in the file is the float-noise
 * guard that decides whether a POINT lies on a segment, scaled by the area's
 * own size, and it is a millionth of the 0.005 mm input grid.
 *
 * Pure: loops and a rule in, predicates out. No seed, no paper, no state.
 */

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
  // Even-odd: every contour is a boundary, every answer is the loops' own, and
  // this must stay bit-identical to what the area consumers did before.
  if (rule === 'evenodd') {
    const sdf = distanceTo(loops);
    const segs = segmentsOf(loops);
    return {
      at: sdf,
      crossings: (ax, ay, bx, by) => loopCrossings(loops, ax, ay, bx, by),
      boundary: segs.map((s) => [s.ax, s.ay, s.bx, s.by] as [number, number, number, number]),
    };
  }

  const segs = segmentsOf(loops);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const s of segs) {
    x0 = Math.min(x0, s.ax, s.bx);
    x1 = Math.max(x1, s.ax, s.bx);
    y0 = Math.min(y0, s.ay, s.by);
    y1 = Math.max(y1, s.ay, s.by);
  }
  const eps = 1e-9 * (1 + Math.max(0, x1 - x0) + Math.max(0, y1 - y0));

  /** The winding number at a point away from the loops (the classic
   * half-open ray cast: an edge counts when it crosses the ray upward to the
   * right, or downward to the left). */
  const winding = (x: number, y: number): number => {
    let w = 0;
    for (const s of segs) {
      const side = (s.bx - s.ax) * (y - s.ay) - (x - s.ax) * (s.by - s.ay);
      if (s.ay <= y) {
        if (s.by > y && side > 0) w++;
      } else if (s.by <= y && side < 0) w--;
    }
    return w;
  };

  /** Boundary or interior: filled on one side only? */
  const isBoundary = (s: Seg): boolean => {
    const mx = (s.ax + s.bx) / 2;
    const my = (s.ay + s.by) / 2;
    const len = Math.hypot(s.bx - s.ax, s.by - s.ay);
    const nx = -(s.by - s.ay) / len;
    const ny = (s.bx - s.ax) / len;
    let near = Infinity;
    for (const o of segs) {
      if (o === s) continue;
      near = Math.min(near, dist2ToSeg(mx, my, o));
    }
    // A quarter of the way to the nearest other segment, so the probe stays in
    // the free neighbourhood of this segment's own midpoint — and never past
    // half its own length, or a short segment's two sides would be the same
    // neighbourhood.
    let h = Math.min(len / 4, Math.sqrt(near) / 4);
    for (let tries = 0; tries < 8; tries++) {
      const up1 = winding(mx + nx * h, my + ny * h);
      const up2 = winding(mx + nx * 2 * h, my + ny * 2 * h);
      const dn1 = winding(mx - nx * h, my - ny * h);
      const dn2 = winding(mx - nx * 2 * h, my - ny * 2 * h);
      if (up1 === up2 && dn1 === dn2) return (up1 === 0) !== (dn1 === 0);
      h /= 2;
    }
    return (winding(mx + nx * h, my + ny * h) === 0) !== (winding(mx - nx * h, my - ny * h) === 0);
  };

  const boundary: Seg[] = [];
  const interior: Seg[] = [];
  for (const s of segs) (isBoundary(s) ? boundary : interior).push(s);

  const onAny = (list: readonly Seg[], x: number, y: number): boolean => {
    for (const s of list) if (dist2ToSeg(x, y, s) <= eps * eps) return true;
    return false;
  };

  return {
    at(x, y) {
      // ON a real boundary is the engine's clip rule: outside. On an interior
      // contour the fill is on both sides, so it is inside.
      if (onAny(boundary, x, y)) return 0;
      if (onAny(interior, x, y)) return 1;
      return winding(x, y) === 0 ? -1 : 1;
    },
    crossings(ax, ay, bx, by) {
      // Each real segment as its own two-point loop; `loopCrossings` walks that
      // loop in both directions, so a hit comes back twice — deduped here.
      const hits = loopCrossings(
        boundary.map((s) => [[s.ax, s.ay], [s.bx, s.by]] as [number, number][]),
        ax, ay, bx, by,
      );
      return hits.filter((h, k) => k === 0 || h.t !== hits[k - 1].t);
    },
    boundary: boundary.map((s) => [s.ax, s.ay, s.bx, s.by] as [number, number, number, number]),
  };
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
 * as the one with the largest span), or null when no probe lands there. Found
 * by stepping off an edge, at the same geometry-derived distance the boundary
 * classification uses — a quarter of the way to the nearest other edge, halved
 * until both sides agree on which one is the region's interior.
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
