/**
 * Point distributions as a first-class, composable value. One generic entry
 * (`scatter`: field-modulated Poisson-disk) plus refinement verbs — the
 * named algorithms are recipes, not API surface:
 *
 *   scatter(field, { spacing })              field-following blue noise
 *   scatter(field, { spacing }).relax(3)     … + Lloyd relaxation
 *   scatter(field, { spacing }).settle(30)   weighted Linde-Buzo-Gray
 *
 * `cells()` (Voronoi) and `mesh()` (Delaunay) are pure views, also exported
 * as plain functions over arbitrary point arrays. Everything is seeded and
 * deterministic; `relax`/`settle` return NEW Points (value semantics).
 */

import { Delaunay } from 'd3-delaunay';
import type { L } from './units.js';

export type FieldFn2 = (x: number, y: number) => number;

export interface ScatterPoint {
  x: number;
  y: number;
  /** Local field demand at settle/relax time (≈ relative darkness); 1 for
   * points that never went through a weighted pass. */
  w: number;
}

export interface PointsEnv {
  /** Seeded [0,1) stream — all randomness flows through this. */
  rnd(): number;
  /** Drawable bounds in user units. */
  bounds: { x: number; y: number; w: number; h: number };
  /** Resolve a length (mm()/w()/…) to user units. */
  len(l: L): number;
}

export interface ScatterOpts {
  /** Target point spacing where the field is 1 (denser nowhere). */
  spacing: L;
  /** Density raster resolution used by relax/settle (per long side). */
  resolution?: number;
}

const asXY = (p: ScatterPoint | { x: number; y: number } | [number, number]): [number, number] =>
  Array.isArray(p) ? [p[0], p[1]] : [p.x, p.y];

/** Voronoi cells of arbitrary points, clipped to a rect. Pure. `site` is
 * the INPUT point itself — identity and metadata (e.g. a scatter point's
 * demand weight) ride along untouched; tuples exist only inside the
 * boundary loop, where vertices are anonymous. */
export function voronoi<P extends ScatterPoint | { x: number; y: number } | [number, number]>(
  points: readonly P[],
  bounds: { x: number; y: number; w: number; h: number },
): { site: P; pts: [number, number][] }[] {
  if (points.length === 0) return [];
  const flat = points.map(asXY);
  const d = Delaunay.from(flat);
  const v = d.voronoi([bounds.x, bounds.y, bounds.x + bounds.w, bounds.y + bounds.h]);
  const out: { site: P; pts: [number, number][] }[] = [];
  for (let i = 0; i < flat.length; i++) {
    const pts = v.cellPolygon(i) as [number, number][] | null;
    if (!pts || pts.length < 3) continue;
    // d3 closes the ring with a duplicate vertex; drop it (a zero-length
    // closing segment would otherwise reach the engine).
    const [fx, fy] = pts[0];
    const [lx, ly] = pts[pts.length - 1];
    if (fx === lx && fy === ly) pts.pop();
    if (pts.length >= 3) out.push({ site: points[i], pts });
  }
  return out;
}

/** Delaunay triangulation of arbitrary points. Pure. */
export function triangulate(
  points: readonly (ScatterPoint | { x: number; y: number } | [number, number])[],
): [[number, number], [number, number], [number, number]][] {
  if (points.length < 3) return [];
  const flat = points.map(asXY);
  const d = Delaunay.from(flat);
  const out: [[number, number], [number, number], [number, number]][] = [];
  for (let t = 0; t < d.triangles.length; t += 3) {
    out.push([flat[d.triangles[t]], flat[d.triangles[t + 1]], flat[d.triangles[t + 2]]]);
  }
  return out;
}

/** Array-like point set carrying its field + spacing so refinement verbs
 * compose. `map` etc. return plain arrays (species override). */
export class Points extends Array<ScatterPoint> {
  static override get [Symbol.species](): ArrayConstructor {
    return Array;
  }

  private env!: PointsEnv;
  private field!: FieldFn2;
  private spacingU!: number; // user units
  private resolution!: number;

  static make(
    pts: ScatterPoint[],
    env: PointsEnv,
    field: FieldFn2,
    spacingU: number,
    resolution: number,
  ): Points {
    const p = new Points();
    p.push(...pts);
    p.env = env;
    p.field = field;
    p.spacingU = spacingU;
    p.resolution = resolution;
    return p;
  }

  private derive(pts: ScatterPoint[]): Points {
    return Points.make(pts, this.env, this.field, this.spacingU, this.resolution);
  }

  /** Voronoi cells of this set, clipped to the drawable (or given) bounds.
   * Each cell's `site` is the scatter point itself (with its `w`). */
  cells(bounds = this.env.bounds): { site: ScatterPoint; pts: [number, number][] }[] {
    return voronoi(this, bounds);
  }

  /** Delaunay triangulation of this set. */
  mesh(): [[number, number], [number, number], [number, number]][] {
    return triangulate(this);
  }

  /** n rounds of Lloyd relaxation toward field-weighted cell centroids —
   * spacing evens out, density keeps following the field, count is fixed. */
  relax(n = 1): Points {
    return this.iterate(n, false);
  }

  /** n rounds of the full adaptive loop — relax PLUS population control:
   * overloaded cells split their point, starved cells lose theirs, so the
   * count converges to the field's ink budget. scatter + settle is the
   * weighted Linde-Buzo-Gray stippling algorithm. */
  settle(n = 10): Points {
    return this.iterate(n, true);
  }

  private iterate(n: number, adapt: boolean): Points {
    const { bounds } = this.env;
    const R = this.resolution;
    const long = Math.max(bounds.w, bounds.h);
    const cw = long / R;
    const cols = Math.max(2, Math.round(bounds.w / cw));
    const rows = Math.max(2, Math.round(bounds.h / cw));
    // Density raster, sampled once per verb call.
    const dens = new Float64Array(cols * rows);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const v = this.field(bounds.x + (i + 0.5) * cw, bounds.y + (j + 0.5) * cw);
        dens[j * cols + i] = v > 0 ? Math.min(1, v) : 0;
      }
    }
    // Capacity: integrated density a single point should carry — the amount
    // a full-demand hex cell at `spacing` holds. Cells above split, below
    // die (settle only).
    const cap = ((this.spacingU * this.spacingU * 0.866) / (cw * cw)) * 1.0;

    let pts: ScatterPoint[] = [...this];
    for (let it = 0; it < n && pts.length > 0; it++) {
      const flat = pts.map((p) => [p.x, p.y] as [number, number]);
      const del = Delaunay.from(flat);
      const w = new Float64Array(pts.length);
      const cx = new Float64Array(pts.length);
      const cy = new Float64Array(pts.length);
      let found = 0;
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const d = dens[j * cols + i];
          if (d === 0) continue;
          const x = bounds.x + (i + 0.5) * cw;
          const y = bounds.y + (j + 0.5) * cw;
          found = del.find(x, y, found);
          w[found] += d;
          cx[found] += d * x;
          cy[found] += d * y;
        }
      }
      const h = adapt ? 0.5 * (1 - it / n) : 0;
      const next: ScatterPoint[] = [];
      for (let p = 0; p < pts.length; p++) {
        if (w[p] <= 0) {
          if (!adapt) next.push(pts[p]); // keep orphans under pure relax
          continue;
        }
        const mx = cx[p] / w[p];
        const my = cy[p] / w[p];
        const demand = w[p] / cap;
        if (adapt && w[p] < cap * (1 - h) * 0.3) continue; // starved
        if (adapt && w[p] > cap * (1 + h)) {
          const a = this.env.rnd() * Math.PI * 2;
          const r = this.spacingU * 0.35;
          next.push({ x: mx + Math.cos(a) * r, y: my + Math.sin(a) * r, w: demand });
          next.push({ x: mx - Math.cos(a) * r, y: my - Math.sin(a) * r, w: demand });
        } else {
          next.push({ x: mx, y: my, w: demand });
        }
      }
      pts = next;
    }
    return this.derive(pts);
  }
}

/** Field-modulated Poisson-disk sampling (Bridson, variable radius): local
 * spacing = `spacing / sqrt(field)`, so demand-1 areas pack at `spacing`
 * and empty areas stay empty. The generic scatter entry point. */
export function scatterPoints(
  env: PointsEnv,
  field: FieldFn2 | undefined,
  opts: ScatterOpts,
): Points {
  const f: FieldFn2 = field ?? (() => 1);
  const spacingU = env.len(opts.spacing);
  if (!(spacingU > 0)) throw new Error('scatter: spacing must be a positive length');
  const resolution = Math.max(32, Math.min(512, opts.resolution ?? 256));
  const { bounds } = env;
  const rMin = spacingU; // full-demand radius
  const rMax = spacingU * 6; // demand below (1/6)² is treated as empty
  const rOf = (x: number, y: number): number => {
    const v = f(x, y);
    if (!(v > 1 / 36)) return Infinity;
    return rMin / Math.sqrt(Math.min(1, v));
  };
  // Neighbour grid at the minimum radius.
  const cell = rMin / Math.SQRT2;
  const cols = Math.max(1, Math.ceil(bounds.w / cell));
  const rows = Math.max(1, Math.ceil(bounds.h / cell));
  const grid: number[][] = Array.from({ length: cols * rows }, () => []);
  const pts: ScatterPoint[] = [];
  // Each placed point's radius, kept from the moment it was computed: the
  // field is a pure function of position (contract), so the value is the
  // same one `rOf` would return again — and the neighbour test asked for it
  // once per neighbour per candidate, which made the field the hot spot.
  const radii: number[] = [];
  const reach = Math.ceil(rMax / cell) + 1;
  const col = (x: number): number => Math.min(cols - 1, Math.max(0, Math.floor((x - bounds.x) / cell)));
  const row = (y: number): number => Math.min(rows - 1, Math.max(0, Math.floor((y - bounds.y) / cell)));
  const fits = (x: number, y: number, r: number): boolean => {
    const ci = col(x);
    const cj = row(y);
    for (let dj = -reach; dj <= reach; dj++) {
      const nj = cj + dj;
      if (nj < 0 || nj >= rows) continue;
      for (let di = -reach; di <= reach; di++) {
        const ni = ci + di;
        if (ni < 0 || ni >= cols) continue;
        const bucket = grid[nj * cols + ni];
        for (let b = 0; b < bucket.length; b++) {
          const k = bucket[b];
          const q = pts[k];
          const need = (r + radii[k]) / 2;
          if (!Number.isFinite(need)) continue;
          const dx = q.x - x;
          const dy = q.y - y;
          if (dx * dx + dy * dy < need * need) return false;
        }
      }
    }
    return true;
  };
  const put = (x: number, y: number, r: number): void => {
    grid[row(y) * cols + col(x)].push(pts.length);
    radii.push(r);
    pts.push({ x, y, w: Math.min(1, Math.max(0, f(x, y))) });
  };

  // Seed: rejection-sample a first point inside the field.
  const active: number[] = [];
  for (let tries = 0; tries < 500 && pts.length === 0; tries++) {
    const x = bounds.x + env.rnd() * bounds.w;
    const y = bounds.y + env.rnd() * bounds.h;
    const r0 = rOf(x, y);
    if (Number.isFinite(r0)) {
      put(x, y, r0);
      active.push(0);
    }
  }
  const K = 20;
  const flood = (): void => {
    while (active.length > 0) {
      const pick = Math.floor(env.rnd() * active.length);
      const base = pts[active[pick]];
      const rb = radii[active[pick]];
      let placed = false;
      for (let k = 0; k < K; k++) {
        const a = env.rnd() * Math.PI * 2;
        const rr = rb * (1 + env.rnd());
        const x = base.x + Math.cos(a) * rr;
        const y = base.y + Math.sin(a) * rr;
        if (x < bounds.x || y < bounds.y || x > bounds.x + bounds.w || y > bounds.y + bounds.h) {
          continue;
        }
        const r = rOf(x, y);
        if (!Number.isFinite(r) || !fits(x, y, r)) continue;
        active.push(pts.length);
        put(x, y, r);
        placed = true;
        break;
      }
      if (!placed) {
        active[pick] = active[active.length - 1];
        active.pop();
      }
    }
  };
  flood();

  // Bridson grows from its seed and cannot cross a stretch of empty field
  // wider than its candidate reach (2·rMax), so a field made of ISLANDS —
  // the bright parts of a key on black — kept only the island the first
  // point landed in, chosen by the seed. Scan the field for non-empty
  // places no point can see, seed each, and flood again.
  // A field the first flood already covered draws nothing here, so its
  // points (and everything downstream in the stream) are unchanged.
  const anyWithin = (x: number, y: number, dist: number): boolean => {
    const ci = col(x);
    const cj = row(y);
    const span = Math.ceil(dist / cell) + 1;
    const d2 = dist * dist;
    for (let dj = -span; dj <= span; dj++) {
      const nj = cj + dj;
      if (nj < 0 || nj >= rows) continue;
      for (let di = -span; di <= span; di++) {
        const ni = ci + di;
        if (ni < 0 || ni >= cols) continue;
        const bucket = grid[nj * cols + ni];
        for (let b = 0; b < bucket.length; b++) {
          const q = pts[bucket[b]];
          const dx = q.x - x;
          const dy = q.y - y;
          if (dx * dx + dy * dy <= d2) return true;
        }
      }
    }
    return false;
  };
  // Scan at twice the minimum spacing: any island that can hold a point
  // is at least that wide, so a cell centre lands in it.
  const scan = 2 * rMin;
  const sc = Math.max(1, Math.ceil(bounds.w / scan));
  const sr = Math.max(1, Math.ceil(bounds.h / scan));
  for (let pass = 0; pass < 8; pass++) {
    let seeded = 0;
    for (let j = 0; j < sr; j++) {
      for (let i = 0; i < sc; i++) {
        const cx = bounds.x + (i + 0.5) * scan;
        const cy = bounds.y + (j + 0.5) * scan;
        const rc = rOf(cx, cy);
        if (!Number.isFinite(rc) || anyWithin(cx, cy, 2 * rc)) continue;
        for (let tries = 0; tries < 30; tries++) {
          const x = cx + (env.rnd() - 0.5) * scan;
          const y = cy + (env.rnd() - 0.5) * scan;
          if (x < bounds.x || y < bounds.y || x > bounds.x + bounds.w || y > bounds.y + bounds.h) continue;
          const r = rOf(x, y);
          if (!Number.isFinite(r) || !fits(x, y, r)) continue;
          active.push(pts.length);
          put(x, y, r);
          seeded++;
          flood();
          break;
        }
      }
    }
    if (seeded === 0) break;
  }
  return Points.make(pts, env, f, spacingU, resolution);
}

/** Lift an arbitrary point collection into a Points value so the verbs
 * (`relax`/`settle`/`cells`/`mesh`) apply to hand-rolled data. `settle`
 * requires `spacing`; the field defaults to uniform. */
export function liftPoints(
  env: PointsEnv,
  raw: readonly ({ x: number; y: number } | [number, number])[],
  opts: { field?: FieldFn2; spacing?: L; resolution?: number } = {},
): Points {
  const spacingU = opts.spacing !== undefined ? env.len(opts.spacing) : NaN;
  const pts = raw.map((p) => {
    const [x, y] = asXY(p);
    return { x, y, w: 1 };
  });
  const res = Math.max(32, Math.min(512, opts.resolution ?? 256));
  const field = opts.field ?? (() => 1);
  const set = Points.make(pts, env, field, spacingU, res);
  if (Number.isNaN(spacingU)) {
    const original = set.settle.bind(set);
    void original;
    set.settle = () => {
      throw new Error(
        "points(...).settle() needs a spacing — pass { spacing: mm(…) } to t.points() (it defines a point's ink capacity)",
      );
    };
  }
  return set;
}
