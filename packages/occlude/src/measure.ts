/**
 * Measurements over faces: geometric area and centroid from the contours
 * (holes respected), and, given a scalar field, its integral, mean and
 * density-weighted centre over each face by a midpoint rule on a square
 * raster. A measurement is a frozen result about its exact input faces —
 * looked up by face with ownership checked — and never geometry.
 *
 * Approximation: the raster has cells of side `cellSize`, the long side of
 * `bounds` (default: the measured faces' bounding box) divided by
 * `resolution` (default 256, clamped 32…512); each cell centre inside a
 * face (even-odd over its contours) contributes `field × cellSize²`. The
 * error is of the order of the perimeter times the cell size; halving the
 * cell size roughly halves it. Non-finite samples are absent, as for
 * isolines and scatter. The same raster convention as `settle` uses, so a
 * measurement over Voronoi cells with the settle's bounds and resolution
 * reproduces its per-cell demand integrals.
 *
 * A density-weighted centre needs a nonnegative field with positive total
 * over the face; with any negative sample, or zero total, it is null.
 * Signed fields still have an integral and a mean.
 */

import type { Face, Faces } from './faces.js';
import type { Bounds } from './points.js';
import { ownedBy, viewKind } from './material.js';
import type { IsoContour } from './isolines.js';

export interface FaceMeasure {
  face: Face;
  /** Geometric area, holes subtracted (the face's own `area`). */
  area: number;
  /** Geometric area centroid, holes respected. */
  centroid: [number, number];
  /** ∫ field dA over the face; NaN when no field was given. */
  integral: number;
  /** integral / area; NaN when no field was given. */
  mean: number;
  /** Density-weighted centre, or null when the density contract fails. */
  weightedCentroid: [number, number] | null;
  /** How many raster samples fell inside the face (0 for none). */
  samples: number;
}

export interface MeasureOpts {
  /** Raster cells along the long side of `bounds` (default 256). */
  resolution?: number;
  /** Raster extent and origin (default: the measured faces' bounding box). */
  bounds?: Bounds;
}

/** Signed shoelace area and centroid of one closed contour. */
function contourMoment(c: IsoContour): { a: number; cx: number; cy: number } {
  const pts = c.pts;
  let a2 = 0;
  let cx = 0;
  let cy = 0;
  for (let k = 0; k < pts.length; k++) {
    const [x0, y0] = pts[k];
    const [x1, y1] = pts[(k + 1) % pts.length];
    const cross = x0 * y1 - x1 * y0;
    a2 += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  if (a2 === 0) return { a: 0, cx: 0, cy: 0 };
  return { a: a2 / 2, cx: cx / (3 * a2), cy: cy / (3 * a2) };
}

/** Even-odd containment over a face's contours. */
function faceContains(f: Face, x: number, y: number): boolean {
  let inside = false;
  for (const c of f.contours) {
    const pts = c.pts;
    for (let k = 0, j = pts.length - 1; k < pts.length; j = k++) {
      const [xi, yi] = pts[k];
      const [xj, yj] = pts[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

export class FaceMeasurements implements Iterable<FaceMeasure> {
  readonly source: Faces;
  readonly results: readonly FaceMeasure[];
  private readonly byIndex: Map<number, FaceMeasure>;

  /** @internal Use `faces.measure(...)`. */
  constructor(source: Faces, results: FaceMeasure[]) {
    this.source = source;
    this.results = Object.freeze(results);
    this.byIndex = new Map(results.map((r) => [r.face.index, r]));
    Object.freeze(this);
  }

  get length(): number {
    return this.results.length;
  }

  [Symbol.iterator](): Iterator<FaceMeasure> {
    return this.results[Symbol.iterator]();
  }

  map<T>(fn: (r: FaceMeasure, i: number) => T): T[] {
    return this.results.map(fn);
  }

  /** The measurement of `face`, which must be a view of the measured collection and among the measured faces. */
  forFace(face: Face): FaceMeasure {
    if (viewKind(face) !== 'face') throw new Error('measure.forFace: expected a face view');
    if (!ownedBy(face, this.source)) throw new Error('measure.forFace: that face belongs to another face collection — measure the collection it came from');
    const r = this.byIndex.get(face.index);
    if (!r) throw new Error(`measure.forFace: face ${face.index} was not among the measured faces`);
    return r;
  }
}

export function measureFaces(source: Faces, members: readonly Face[], field: ((x: number, y: number) => number) | undefined, opts: MeasureOpts = {}): FaceMeasurements {
  // Geometry first: exact from the contours.
  const results: FaceMeasure[] = members.map((face) => {
    let a = 0;
    let mx = 0;
    let my = 0;
    for (const c of face.contours) {
      const m = contourMoment(c);
      a += m.a;
      mx += m.a * m.cx;
      my += m.a * m.cy;
    }
    const centroid: [number, number] = a !== 0 ? [mx / a, my / a] : [NaN, NaN];
    return { face, area: face.area, centroid, integral: NaN, mean: NaN, weightedCentroid: null, samples: 0 };
  });
  if (!field || members.length === 0) return new FaceMeasurements(source, results);
  // The raster.
  let b = opts.bounds;
  if (!b) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const f of members) {
      x0 = Math.min(x0, f.bounds.x);
      y0 = Math.min(y0, f.bounds.y);
      x1 = Math.max(x1, f.bounds.x + f.bounds.w);
      y1 = Math.max(y1, f.bounds.y + f.bounds.h);
    }
    b = { x: x0, y: y0, w: Math.max(x1 - x0, 1e-9), h: Math.max(y1 - y0, 1e-9) };
  }
  const R = Math.max(32, Math.min(512, opts.resolution ?? 256));
  const cw = Math.max(b.w, b.h) / R;
  const cols = Math.max(2, Math.round(b.w / cw));
  const rows = Math.max(2, Math.round(b.h / cw));
  const cellArea = cw * cw;
  // Sample the field once per raster cell that any face's box covers.
  const values = new Float64Array(cols * rows).fill(NaN);
  const sampled = new Uint8Array(cols * rows);
  const sampleAt = (i: number, j: number): number => {
    const k = j * cols + i;
    if (!sampled[k]) {
      sampled[k] = 1;
      values[k] = field(b.x + (i + 0.5) * cw, b.y + (j + 0.5) * cw);
    }
    return values[k];
  };
  for (const r of results) {
    const f = r.face;
    const i0 = Math.max(0, Math.floor((f.bounds.x - b.x) / cw - 0.5));
    const i1 = Math.min(cols - 1, Math.ceil((f.bounds.x + f.bounds.w - b.x) / cw - 0.5));
    const j0 = Math.max(0, Math.floor((f.bounds.y - b.y) / cw - 0.5));
    const j1 = Math.min(rows - 1, Math.ceil((f.bounds.y + f.bounds.h - b.y) / cw - 0.5));
    let integral = 0;
    let wx = 0;
    let wy = 0;
    let negative = false;
    let samples = 0;
    for (let j = j0; j <= j1; j++) {
      const y = b.y + (j + 0.5) * cw;
      for (let i = i0; i <= i1; i++) {
        const x = b.x + (i + 0.5) * cw;
        if (!faceContains(f, x, y)) continue;
        const v = sampleAt(i, j);
        if (!Number.isFinite(v)) continue;
        samples++;
        integral += v;
        if (v < 0) negative = true;
        wx += v * x;
        wy += v * y;
      }
    }
    r.integral = integral * cellArea;
    r.mean = f.area > 0 ? r.integral / f.area : NaN;
    r.weightedCentroid = !negative && integral > 0 ? [wx / integral, wy / integral] : null;
    r.samples = samples;
  }
  return new FaceMeasurements(source, results);
}
