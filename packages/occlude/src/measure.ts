/**
 * Measurements over faces: geometric area and centroid from the contours
 * (holes respected), and, given a scalar field, its integral, mean and
 * density-weighted centre over each face by a midpoint rule on a square
 * raster. A measurement is a frozen result about its exact input faces —
 * looked up by face with ownership checked — and never geometry.
 *
 * Approximation: the raster has cells of side `step`, a length in the
 * material's units (default: the long side of `bounds` — the measured
 * faces' bounding box unless given — over 256); each cell centre inside a
 * face (even-odd over its contours) contributes `field × cellSize²`. The
 * error is of the order of the perimeter times the cell size; halving the
 * cell size roughly halves it. Non-finite samples are absent, as for
 * isolines and scatter. The same raster convention as `settle` uses, so a
 * measurement over Voronoi cells with the settle's bounds and resolution
 * reproduces its per-cell demand integrals.
 *
 * `mean` is the average of the samples inside the face, so it always lies
 * within the field's own range; `integral` is the raster's ∫field dA over
 * the face. A face that caught no sample has no mean.
 *
 * A density-weighted centre needs a nonnegative field with positive total
 * over the face; with any negative sample, or zero total, it is null.
 * Signed fields still have an integral and a mean.
 *
 * Shape columns — `orientation`, `elongation`, `inscribedCentre` and
 * `inscribedRadius` — are exact from the contours and need no field, so a
 * measurement with no field still carries them. Orientation is the
 * principal axis of the face's area second moments, in radians like every
 * other computed angle; elongation says how much to trust it (0 for a disc
 * or a square, approaching 1 for a sliver). The inscribed circle is the
 * largest circle that fits inside the face, holes respected, found by
 * branch and bound on the exact distance to the contours: a cell can only
 * beat the best circle so far if its centre's distance plus its half
 * diagonal does, so whole regions are discarded rather than sampled. It is
 * refined until the remaining uncertainty is `precision` (default: the
 * face's diagonal over 4096).
 *
 * IN A SPACE. A material in a curved space measures in that space: the
 * face is the region its walls enclose as they are drawn — each wall the
 * straight run between its ends in the sketch's coordinates — and `area`,
 * the field's `integral`, `mean` and `weightedCentroid` weigh every sample
 * by the space's `density`; `perimeter` is each wall's length in the
 * space; the inscribed circle is the largest circle OF THE SPACE inside
 * the face, its radius a length of the space. `centroid`, `orientation`
 * and `elongation` stay chart readings of the coordinates.
 */

import type { Face, Faces } from './faces.js';
import type { Bounds } from './points.js';
import type { Space } from './space.js';
import { ownedBy, viewKind } from './material.js';
import type { IsoContour } from './isolines.js';
import { distanceTo } from './distance.js';

/** One face's measurement. Records and their coordinate tuples are frozen. */
export interface FaceMeasure {
  readonly face: Face;
  /** Geometric area, holes subtracted (the face's own `area`). */
  readonly area: number;
  /** Geometric area centroid, holes respected. */
  readonly centroid: readonly [number, number];
  /** ∫ field dA over the face; NaN when no field was given. */
  readonly integral: number;
  /** integral / area; NaN when no field was given. */
  readonly mean: number;
  /** Density-weighted centre, or null when the density contract fails. */
  readonly weightedCentroid: readonly [number, number] | null;
  /** How many raster samples fell inside the face (0 for none). */
  readonly samples: number;
  /** Principal axis of the face's area, in radians; 0 when the area is 0. */
  readonly orientation: number;
  /** 1 − minor/major of the equivalent ellipse: 0 is isotropic, 1 a sliver. */
  readonly elongation: number;
  /** Centre of the largest circle inside the face, holes respected. */
  readonly inscribedCentre: readonly [number, number];
  /** Its radius; 0 for a face with no interior. */
  readonly inscribedRadius: number;
}

/** A finished record: the tuples and the record itself frozen. */
function freezeMeasure(r: Draft): FaceMeasure {
  Object.freeze(r.centroid);
  Object.freeze(r.inscribedCentre);
  if (r.weightedCentroid) Object.freeze(r.weightedCentroid);
  return Object.freeze(r);
}

/** A measurement under construction: the same fields, still writable. */
type Draft = {
  face: Face;
  area: number;
  centroid: [number, number];
  integral: number;
  mean: number;
  weightedCentroid: [number, number] | null;
  samples: number;
  orientation: number;
  elongation: number;
  inscribedCentre: [number, number];
  inscribedRadius: number;
};

export interface MeasureOpts {
  /** The raster's cell, a length in the material's units (default: the
   * long side of `bounds` / 256). */
  step?: number;
  /** Raster extent and origin (default: the measured faces' bounding box). */
  bounds?: Bounds;
  /** How close the inscribed circle's radius is driven to the true maximum
   * (default: the face's bounding-box diagonal / 4096). */
  precision?: number;
}

/** Signed shoelace area and centroid of one closed contour. */
export function contourMoment(c: IsoContour): { a: number; cx: number; cy: number } {
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

/** The space a measurement reads: the material's own, or null when it is
 * flat and the chart is the space. */
export function curvedSpaceOf(space: Space | undefined): Space | null {
  return space !== undefined && space.kind !== 'euclidean' ? space : null;
}

/** Sub-steps a wall is walked in to find its length in a curved space. */
const WALL_STEPS = 32;
/** Sub-divisions of a fan triangle's side for the area quadrature. */
const FAN_STEPS = 16;

/** The length in `space` of the straight coordinate run from `a` to `b`:
 * the space's distance summed over short steps along it. */
export function spaceLength(space: Space, a: readonly [number, number], b: readonly [number, number]): number {
  let total = 0;
  let px = a[0];
  let py = a[1];
  for (let k = 1; k <= WALL_STEPS; k++) {
    const t = k / WALL_STEPS;
    const x = a[0] + (b[0] - a[0]) * t;
    const y = a[1] + (b[1] - a[1]) * t;
    total += space.distance([px, py], [x, y]);
    px = x;
    py = y;
  }
  return total;
}

/** The perimeter in `space` of a face's contours: every wall once. */
export function spacePerimeter(space: Space, contours: readonly IsoContour[]): number {
  let total = 0;
  for (const c of contours) {
    const pts = c.pts;
    for (let k = 0; k < pts.length; k++) total += spaceLength(space, pts[k], pts[(k + 1) % pts.length]);
  }
  return total;
}

/** The area in `space` of the region a face's contours enclose: the
 * space's density integrated over it. Each wall with the face's first
 * corner makes a signed triangle, so outer minus holes and any non-convex
 * outline come out of the signs; each triangle is summed by the midpoint
 * rule over `FAN_STEPS²` small triangles. */
export function spaceArea(space: Space, contours: readonly IsoContour[]): number {
  const first = contours.find((c) => c.pts.length > 0);
  if (!first) return 0;
  const [ox, oy] = first.pts[0];
  const n = FAN_STEPS;
  let total = 0;
  for (const c of contours) {
    const pts = c.pts;
    for (let k = 0; k < pts.length; k++) {
      const [ax, ay] = pts[k];
      const [bx, by] = pts[(k + 1) % pts.length];
      const ux = (ax - ox) / n;
      const uy = (ay - oy) / n;
      const vx = (bx - ox) / n;
      const vy = (by - oy) / n;
      const small = (ux * vy - uy * vx) / 2;
      if (small === 0) continue;
      let sum = 0;
      for (let i = 0; i < n; i++) {
        for (let j = 0; i + j < n; j++) {
          // The upward small triangle at (i, j), and the downward one beside
          // it where there is room; each weighted at its centroid.
          sum += space.density([ox + (i + 1 / 3) * ux + (j + 1 / 3) * vx, oy + (i + 1 / 3) * uy + (j + 1 / 3) * vy]);
          if (i + j < n - 1) sum += space.density([ox + (i + 2 / 3) * ux + (j + 2 / 3) * vx, oy + (i + 2 / 3) * uy + (j + 2 / 3) * vy]);
        }
      }
      total += sum * small;
    }
  }
  return total;
}

/** The distance in `space` from `p` to the straight coordinate run from
 * `a` to `b`: the nearest of a few samples along it, then a golden-section
 * search on the stretch around it. */
function spaceDistanceToWall(space: Space, p: readonly [number, number], a: readonly [number, number], b: readonly [number, number]): number {
  const at = (t: number): number => space.distance(p, [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  const n = 8;
  let best = 0;
  let bestD = Infinity;
  for (let k = 0; k <= n; k++) {
    const d = at(k / n);
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  let lo = Math.max(0, (best - 1) / n);
  let hi = Math.min(1, (best + 1) / n);
  const g = (Math.sqrt(5) - 1) / 2;
  let x1 = hi - g * (hi - lo);
  let x2 = lo + g * (hi - lo);
  let f1 = at(x1);
  let f2 = at(x2);
  for (let it = 0; it < 24; it++) {
    if (f1 < f2) {
      hi = x2;
      x2 = x1;
      f2 = f1;
      x1 = hi - g * (hi - lo);
      f1 = at(x1);
    } else {
      lo = x1;
      x1 = x2;
      f1 = f2;
      x2 = lo + g * (hi - lo);
      f2 = at(x2);
    }
  }
  return Math.min(bestD, f1, f2);
}

/** Raw area moments of one closed contour about the origin, signed by the
 * contour's winding, so summing over a face's contours subtracts its holes:
 * `a` = ∫dA, `mx`/`my` = ∫x dA and ∫y dA, `xx`/`yy`/`xy` the second moments.
 * The standard shoelace forms — each term is the exact integral over the
 * triangle the edge makes with the origin. */
function contourAreaMoments(c: IsoContour): { a: number; mx: number; my: number; xx: number; yy: number; xy: number } {
  const pts = c.pts;
  let a2 = 0;
  let mx = 0;
  let my = 0;
  let xx = 0;
  let yy = 0;
  let xy = 0;
  for (let k = 0; k < pts.length; k++) {
    const [x0, y0] = pts[k];
    const [x1, y1] = pts[(k + 1) % pts.length];
    const cross = x0 * y1 - x1 * y0;
    a2 += cross;
    mx += (x0 + x1) * cross;
    my += (y0 + y1) * cross;
    xx += (x0 * x0 + x0 * x1 + x1 * x1) * cross;
    yy += (y0 * y0 + y0 * y1 + y1 * y1) * cross;
    xy += (x0 * y1 + 2 * x0 * y0 + 2 * x1 * y1 + x1 * y0) * cross;
  }
  return { a: a2 / 2, mx: mx / 6, my: my / 6, xx: xx / 12, yy: yy / 12, xy: xy / 24 };
}

/** The principal axis of a face's area and how eccentric that area is.
 * Central second moments give the equivalent ellipse; its major axis is the
 * orientation and `1 − minor/major` the elongation. A face whose moments are
 * isotropic has no principal axis, and reports orientation 0 with
 * elongation 0 rather than an arbitrary angle. */
function principalAxis(face: Face): { orientation: number; elongation: number } {
  let a = 0;
  let mx = 0;
  let my = 0;
  let xx = 0;
  let yy = 0;
  let xy = 0;
  for (const c of face.contours()) {
    const m = contourAreaMoments(c);
    a += m.a;
    mx += m.mx;
    my += m.my;
    xx += m.xx;
    yy += m.yy;
    xy += m.xy;
  }
  if (a === 0) return { orientation: 0, elongation: 0 };
  const cx = mx / a;
  const cy = my / a;
  // Central moments: the parallel-axis shift onto the centroid.
  const uxx = xx / a - cx * cx;
  const uyy = yy / a - cy * cy;
  const uxy = xy / a - cx * cy;
  const half = (uxx + uyy) / 2;
  const disc = Math.hypot((uxx - uyy) / 2, uxy);
  const major = half + disc;
  const minor = half - disc;
  if (!(major > 0)) return { orientation: 0, elongation: 0 };
  const orientation = disc === 0 ? 0 : 0.5 * Math.atan2(2 * uxy, uxx - uyy);
  // The ellipse's semi-axes are the square roots of the eigenvalues.
  const elongation = 1 - Math.sqrt(Math.max(0, minor) / major);
  return { orientation, elongation };
}

/** The largest circle that fits inside the face, holes respected.
 *
 * Branch and bound over square cells: a cell can only contain a better
 * centre than the best found so far if the distance at its own centre plus
 * its half diagonal exceeds that best, because the distance function is
 * 1-Lipschitz. Cells that cannot are discarded whole; the rest are
 * quartered, best-first, until the remaining slack is under `precision`.
 * Exact input, deterministic, and no seed involved. */
function inscribedCircle(face: Face, precision: number, space: Space | null): { centre: [number, number]; radius: number } {
  const b = face.bounds;
  if (!(b.w > 0) || !(b.h > 0)) return { centre: [b.x, b.y], radius: 0 };
  let best: [number, number] = [b.x + b.w / 2, b.y + b.h / 2];
  const flat = distanceTo(face.contours());
  // In a space the distance is the space's own to the nearest wall, signed
  // by the flat test's side, and a coordinate step of `h` is worth at most
  // `lip · h` of it — the widest stretch the metric has over the box (the
  // density's square root bounds the linear stretch along one axis, and a
  // step across the rows is never stretched) — so the bound stays a bound.
  const walls = space ? face.contours().flatMap((c) => c.pts.map((p, k) => [p, c.pts[(k + 1) % c.pts.length]] as const)) : [];
  const dist = space
    ? (x: number, y: number): number => {
      const side = flat(x, y);
      if (!(side > 0)) return side;
      let d = Infinity;
      for (const [a, q] of walls) d = Math.min(d, spaceDistanceToWall(space, [x, y], a, q));
      return d;
    }
    : flat;
  const lip = space ? Math.max(1, Math.sqrt(densityOver(space, b))) : 1;
  let bestR = -Infinity;
  // Cells as a centre and a half-side, in a max-heap on their upper bound,
  // so the most promising region is always split next and the search
  // converges on the true maximum from above.
  const heap: { x: number; y: number; h: number; bound: number }[] = [];
  const up = (i: number): void => {
    let k = i;
    while (k > 0) {
      const parent = (k - 1) >> 1;
      if (heap[parent].bound >= heap[k].bound) break;
      [heap[parent], heap[k]] = [heap[k], heap[parent]];
      k = parent;
    }
  };
  const down = (): void => {
    let k = 0;
    for (;;) {
      const l = 2 * k + 1;
      const r = l + 1;
      let big = k;
      if (l < heap.length && heap[l].bound > heap[big].bound) big = l;
      if (r < heap.length && heap[r].bound > heap[big].bound) big = r;
      if (big === k) break;
      [heap[big], heap[k]] = [heap[k], heap[big]];
      k = big;
    }
  };
  const push = (x: number, y: number, h: number): void => {
    const d = dist(x, y);
    if (d > bestR) {
      bestR = d;
      best = [x, y];
    }
    const bound = d + lip * h * Math.SQRT2;
    if (bound > bestR + precision) {
      heap.push({ x, y, h, bound });
      up(heap.length - 1);
    }
  };
  push(b.x + b.w / 2, b.y + b.h / 2, Math.max(b.w, b.h) / 2);
  while (heap.length) {
    const c = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      down();
    }
    // The heap's own top can no longer beat the best found since it was added.
    if (c.bound <= bestR + precision) break;
    const h = c.h / 2;
    push(c.x - h, c.y - h, h);
    push(c.x + h, c.y - h, h);
    push(c.x - h, c.y + h, h);
    push(c.x + h, c.y + h, h);
  }
  return { centre: best, radius: Math.max(0, bestR) };
}

/** The largest density over a box, from its rows: the density reads the
 * row alone in every space this library has. */
function densityOver(space: Space, b: { x: number; y: number; w: number; h: number }): number {
  let top = 0;
  for (let k = 0; k <= 64; k++) top = Math.max(top, space.density([b.x, b.y + (b.h * k) / 64]));
  return top;
}

/** Even-odd containment over a face's contours. */
/** The x positions where the face's contours cross the horizontal line at
 * `y`, sorted. Even-odd: a point is inside the face exactly when an odd
 * number of crossings lie strictly to its right, i.e. when it sits in
 * [c0, c1) ∪ [c2, c3) ∪ … of the sorted crossings — the same rule as the
 * classic per-point ray test, applied to a whole row at once. */
function rowCrossings(f: Face, y: number, out: number[]): number[] {
  out.length = 0;
  for (const c of f.contours()) {
    const pts = c.pts;
    for (let k = 0, j = pts.length - 1; k < pts.length; j = k++) {
      const [xi, yi] = pts[k];
      const [xj, yj] = pts[j];
      if (yi > y !== yj > y) out.push(((xj - xi) * (y - yi)) / (yj - yi) + xi);
    }
  }
  out.sort((a, b) => a - b);
  return out;
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
  if ('resolution' in opts) throw new Error('measure: resolution is now step — the raster cell, a length in the material\'s units');
  if (opts.step !== undefined && !(typeof opts.step === 'number' && Number.isFinite(opts.step) && opts.step > 0)) {
    throw new Error(`measure: step must be a positive finite number in the material's units, got ${String(opts.step)} — resolve a length such as mm() with t.len`);
  }
  const space = curvedSpaceOf(source.source.space);
  // Geometry first: exact from the contours.
  const results: Draft[] = members.map((face) => {
    let a = 0;
    let mx = 0;
    let my = 0;
    for (const c of face.contours()) {
      const m = contourMoment(c);
      a += m.a;
      mx += m.a * m.cx;
      my += m.a * m.cy;
    }
    const centroid: [number, number] = a !== 0 ? [mx / a, my / a] : [NaN, NaN];
    const axis = principalAxis(face);
    const slack = opts.precision ?? Math.hypot(face.bounds.w, face.bounds.h) / 4096;
    const circle = inscribedCircle(face, slack, space);
    return { face, area: face.area, centroid, integral: NaN, mean: NaN, weightedCentroid: null, samples: 0, orientation: axis.orientation, elongation: axis.elongation, inscribedCentre: circle.centre, inscribedRadius: circle.radius };
  });
  if (!field || members.length === 0) return new FaceMeasurements(source, results.map(freezeMeasure));
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
  const cw = opts.step ?? Math.max(b.w, b.h) / 256;
  const cols = Math.max(2, Math.round(b.w / cw));
  const rows = Math.max(2, Math.round(b.h / cw));
  if (!(cols * rows <= 1 << 26)) throw new Error(`measure: a raster of ${cols} × ${rows} cells is too fine — give a larger step`);
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
    // The weight of the samples inside: their count flat, the space's area
    // they hold in a curved space.
    let weight = 0;
    const crossings: number[] = [];
    for (let j = j0; j <= j1; j++) {
      const y = b.y + (j + 0.5) * cw;
      const xs = rowCrossings(f, y, crossings);
      // Cells whose centre lies in [xs[a], xs[a + 1]) are inside; the
      // explicit comparisons keep the exact boundary rule of the ray test.
      for (let a = 0; a + 1 < xs.length; a += 2) {
        const from = Math.max(i0, Math.floor((xs[a] - b.x) / cw - 0.5));
        const to = Math.min(i1, Math.ceil((xs[a + 1] - b.x) / cw - 0.5));
        for (let i = from; i <= to; i++) {
          const x = b.x + (i + 0.5) * cw;
          if (x < xs[a] || x >= xs[a + 1]) continue;
          const v = sampleAt(i, j);
          if (!Number.isFinite(v)) continue;
          samples++;
          if (v < 0) negative = true;
          if (space) {
            const d = space.density([x, y]);
            weight += d;
            integral += v * d;
            wx += v * d * x;
            wy += v * d * y;
            continue;
          }
          integral += v;
          wx += v * x;
          wy += v * y;
        }
      }
    }
    r.integral = integral * cellArea;
    // The mean is the average of the samples that fell inside, not the
    // integral over the geometric area: a face smaller than a raster cell
    // divides a whole cell's worth of integral by almost nothing and reports
    // a mean far outside the field's own range. Averaging the samples stays
    // inside that range, converges to the same value as the raster refines,
    // and makes a face that caught no sample NaN — absent — rather than 0.
    r.mean = samples > 0 ? integral / (space ? weight : samples) : NaN;
    r.weightedCentroid = !negative && integral > 0 ? [wx / integral, wy / integral] : null;
    r.samples = samples;
  }
  return new FaceMeasurements(source, results.map(freezeMeasure));
}
