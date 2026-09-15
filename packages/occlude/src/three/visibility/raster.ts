/**
 * A certified raster filter in front of exact visibility.
 *
 * The exact classifier decides every feature against every candidate
 * triangle. Most of that work answers questions whose answer is obvious
 * from a distance: a line wholly behind a body, or a triangle whose
 * projection never comes near the line. This module answers those cheaply
 * and PROVABLY, and abstains on everything else, so the intervals the exact
 * classifier produces are unchanged: a feature this filter marks hidden is
 * hidden by the same geometry the exact test would find, and a candidate it
 * drops is one the exact test would have found empty.
 *
 * Two structures over the sheet, in paper millimetres:
 *  - `coverFar`: per pixel, the smallest "farthest depth" of any triangle
 *    that covers the WHOLE pixel (all four corners strictly inside the
 *    triangle's projection). A feature whose nearest point is farther than
 *    coverFar at every pixel it crosses lies behind a covering surface along
 *    its entire length under every eye ray, so it is hidden. Depth is camera
 *    distance; a planar triangle's extreme depths are at its vertices and a
 *    segment's at its endpoints, so the bounds are global per item, exact
 *    and cheap. The feature's own triangles never prove it hidden: their
 *    depth equals the feature's, and equality is not "farther by a margin".
 *  - `cells`: a coarse grid of triangle indices by projected bounds. A
 *    feature's candidates are the triangles in the cells its projection
 *    walks through, instead of every triangle whose bounds overlap the
 *    feature's bounds, which for a diagonal line is a large square.
 *
 * Everything outside the raster (style overscan past the sheet, or a
 * projection the raster does not cover) is left to the exact path.
 */
import type { FeatureSnapshot3 } from '../features/snapshot.js';
import { toPaper3, type CameraFrame3 } from '../camera.js';
import type { Vec3 } from '../math.js';

export interface RasterFilter3 {
  /** Whole-feature proof: hidden everywhere by covering surfaces. */
  provenHidden(feature: number): boolean;
  /** Candidate occluder indices for a feature, from the cell walk; `null`
   * when the feature leaves the raster (fall back to the index). */
  candidates(feature: number): readonly number[] | null;
  readonly stats: { pixels: number; coveredPixels: number; cells: number; buildMs: number; triangles: number; skippedLarge: number };
}

/** Relative depth margin covering the float error of projection and depth
 * arithmetic, many orders above it: proofs are conservative, never tight. */
const DEPTH_MARGIN = 1e-7;

/** Raster resolution along the sheet's long side. Measured on the seven
 * benchmark workloads: 2048 proves more than 1024 (58% of the vessel's
 * features hidden against 47%) for a build still under half a second. */
const RESOLUTION = 2048;
export function rasterFilter3(snapshot: FeatureSnapshot3, resolution = RESOLUTION, cellCount = 256): RasterFilter3 {
  const frame: CameraFrame3 = snapshot.frame, r = frame.paper;
  // The raster spans the sheet; lines beyond it are the exact path's.
  const scale = resolution / Math.max(r.width, r.height);
  const w = Math.ceil(r.width * scale) + 1, h = Math.ceil(r.height * scale) + 1;
  const px = (p: readonly [number, number]): [number, number] => [(p[0] - r.x) * scale, (p[1] - r.y) * scale];
  const coverFar = new Float64Array(w * h).fill(Infinity);
  const cellScale = cellCount / Math.max(r.width, r.height), cellPerPixel = cellScale / scale;
  const cw = Math.ceil(r.width * cellScale) + 1, ch = Math.ceil(r.height * cellScale) + 1;
  const cells: number[][] = Array.from({ length: cw * ch }, () => []);
  let coveredPixels = 0, skippedLarge = 0;
  const t0 = performance.now();
  const depth = (p: Vec3): number => -p[2];
  const SHRINK = 0.1;
  for (let j = 0; j < snapshot.occluders.length; j++) {
    const tri = snapshot.occluders[j].triangle;
    // Behind or straddling the eye: projection is meaningless; the exact path keeps it.
    if (!(depth(tri[0]) > 0) || !(depth(tri[1]) > 0) || !(depth(tri[2]) > 0)) continue;
    const p0 = px(toPaper3(frame, tri[0])), p1 = px(toPaper3(frame, tri[1])), p2 = px(toPaper3(frame, tri[2]));
    const far = Math.max(depth(tri[0]), depth(tri[1]), depth(tri[2]));
    const minX = Math.min(p0[0], p1[0], p2[0]), maxX = Math.max(p0[0], p1[0], p2[0]), minY = Math.min(p0[1], p1[1], p2[1]), maxY = Math.max(p0[1], p1[1], p2[1]);
    // Cells: every cell the projected bounds touch (clamped to the sheet).
    const cx0 = Math.max(0, Math.floor(minX * cellPerPixel)), cx1 = Math.min(cw - 1, Math.floor(maxX * cellPerPixel));
    const cy0 = Math.max(0, Math.floor(minY * cellPerPixel)), cy1 = Math.min(ch - 1, Math.floor(maxY * cellPerPixel));
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) cells[cy * cw + cx].push(j);
    // Fully covered pixels. Each edge is a linear function e(x, y) = a x + b y + c,
    // scaled to unit normal, positive on the inside once oriented; a pixel is
    // covered when the SMALLEST corner value of every edge exceeds the shrink.
    // For a linear function the smallest of the four corners is
    // e(x, y) + min(0, a) + min(0, b), so the cover test is one evaluation
    // per edge per pixel, no allocation.
    if (maxX - minX < 1 || maxY - minY < 1) continue; // narrower than a pixel: cannot cover one
    const x0 = Math.max(0, Math.floor(minX)), x1 = Math.min(w - 2, Math.ceil(maxX)), y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(h - 2, Math.ceil(maxY));
    if (x1 - x0 > 4096 || y1 - y0 > 4096) { skippedLarge++; continue; }
    const area = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p1[1] - p0[1]) * (p2[0] - p0[0]);
    if (!(Math.abs(area) > 0)) continue;
    const orient = area > 0 ? 1 : -1;
    const edges: [number, number, number][] = [];
    for (const [a, b] of [[p0, p1], [p1, p2], [p2, p0]] as const) {
      const ex = b[0] - a[0], ey = b[1] - a[1], len = Math.hypot(ex, ey);
      if (!(len > 0)) { edges.length = 0; break; }
      // e(p) = ((ex)(py - ay) - (ey)(px - ax)) / len, positive on the orient side
      const ea = -ey / len * orient, eb = ex / len * orient, ec = (ey * a[0] - ex * a[1]) / len * orient;
      edges.push([ea, eb, ec + Math.min(0, ea) + Math.min(0, eb)]);
    }
    if (edges.length !== 3) continue;
    const [[a0, b0, c0], [a1, b1, c1], [a2, b2, c2]] = edges;
    for (let y = y0; y <= y1; y++) {
      const row = y * w;
      for (let x = x0; x <= x1; x++) {
        if (a0 * x + b0 * y + c0 > SHRINK && a1 * x + b1 * y + c1 > SHRINK && a2 * x + b2 * y + c2 > SHRINK) {
          const i = row + x;
          if (far < coverFar[i]) { if (coverFar[i] === Infinity) coveredPixels++; coverFar[i] = far; }
        }
      }
    }
  }
  /** Cells or pixels a segment touches, conservatively: every square the
   * segment's path, widened by half a unit, enters. False if it leaves the grid. */
  const walk = (a: [number, number], b: [number, number], gw: number, gh: number, visit: (i: number) => boolean): boolean => {
    const minX = Math.floor(Math.min(a[0], b[0]) - 0.5), maxX = Math.floor(Math.max(a[0], b[0]) + 0.5);
    const minY = Math.floor(Math.min(a[1], b[1]) - 0.5), maxY = Math.floor(Math.max(a[1], b[1]) + 0.5);
    if (minX < 0 || minY < 0 || maxX >= gw || maxY >= gh) return false;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    if (Math.abs(dx) >= Math.abs(dy)) {
      const step = dx >= 0 ? 1 : -1, last = Math.floor(b[0]);
      for (let x = Math.floor(a[0]); ; x += step) {
        const tx0 = dx === 0 ? 0 : Math.max(0, Math.min(1, (x - a[0]) / dx)), tx1 = dx === 0 ? 1 : Math.max(0, Math.min(1, (x + 1 - a[0]) / dx));
        const ya = a[1] + dy * tx0, yb = a[1] + dy * tx1;
        for (let y = Math.floor(Math.min(ya, yb) - 0.5); y <= Math.floor(Math.max(ya, yb) + 0.5); y++) { if (y < 0 || y >= gh) return false; if (!visit(y * gw + x)) return false; }
        if (x === last) break;
      }
    } else {
      const step = dy >= 0 ? 1 : -1, last = Math.floor(b[1]);
      for (let y = Math.floor(a[1]); ; y += step) {
        const ty0 = Math.max(0, Math.min(1, (y - a[1]) / dy)), ty1 = Math.max(0, Math.min(1, (y + 1 - a[1]) / dy));
        const xa = a[0] + dx * ty0, xb = a[0] + dx * ty1;
        for (let x = Math.floor(Math.min(xa, xb) - 0.5); x <= Math.floor(Math.max(xa, xb) + 0.5); x++) { if (x < 0 || x >= gw) return false; if (!visit(y * gw + x)) return false; }
        if (y === last) break;
      }
    }
    return true;
  };
  const featurePx = (i: number): [[number, number], [number, number]] | null => {
    const f = snapshot.features[i];
    if (!(depth(f.a) > 0) || !(depth(f.b) > 0)) return null;
    return [px(toPaper3(frame, f.a)), px(toPaper3(frame, f.b))];
  };
  const stats = { pixels: w * h, coveredPixels, cells: cw * ch, buildMs: performance.now() - t0, triangles: snapshot.occluders.length, skippedLarge };
  return {
    provenHidden(i) {
      const f = snapshot.features[i], ends = featurePx(i);
      if (!ends) return false;
      const near = Math.min(depth(f.a), depth(f.b)), limit = near - Math.max(1, Math.abs(near)) * DEPTH_MARGIN;
      return walk(ends[0], ends[1], w, h, (p) => coverFar[p] < limit);
    },
    candidates(i) {
      const ends = featurePx(i);
      if (!ends) return null;
      const a: [number, number] = [ends[0][0] * cellPerPixel, ends[0][1] * cellPerPixel], b: [number, number] = [ends[1][0] * cellPerPixel, ends[1][1] * cellPerPixel];
      const seen = new Set<number>();
      if (!walk(a, b, cw, ch, (c) => { for (const j of cells[c]) seen.add(j); return true; })) return null;
      return [...seen];
    },
    stats,
  };
}
