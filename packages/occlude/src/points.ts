/**
 * Point generation and refinement as material operations. `scatter` places
 * field-modulated Poisson-disk points and returns point-only material with
 * one computed column, `density`, the field's value at each point. `relax`
 * (Lloyd) and `settle` (weighted Linde-Buzo-Gray) are explicit operations
 * on a material with their density, spacing, bounds and raster resolution
 * as inputs — nothing about how a material was made is remembered inside
 * it. The numerical kernel is the same as before this consolidation: a
 * density raster over the bounds, every raster sample assigned to its
 * nearest site, per-site integrated demand and density-weighted centroid.
 *
 * Three quantities are kept apart by name: `density` is the field at a
 * point; `demand` (written by settle) is a cell's integrated density
 * divided by the capacity one point carries at the given spacing, so 1 is
 * a full cell; a cell's mean density is `integral / area`, which
 * `faces().measure(field)` reports for any face.
 */

import { Delaunay } from 'd3-delaunay';
import { Material } from './material.js';
import type { L } from './units.js';

export type FieldFn2 = (x: number, y: number) => number;

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PointsEnv {
  /** Seeded [0,1) stream — all randomness flows through this. */
  rnd(): number;
  /** Drawable bounds in user units. */
  bounds: Bounds;
  /** Resolve a length (mm()/w()/…) to user units. */
  len(l: L): number;
}

export interface ScatterOpts {
  /** Target point spacing where the field is 1 (denser nowhere). */
  spacing: L;
}

export interface RelaxOpts {
  /** Lloyd rounds (default 1). */
  iterations?: number;
  /** Weighting density (0…1; default uniform). */
  density?: FieldFn2;
  /** Cells are clipped to these bounds (default: the drawable). */
  bounds?: Bounds;
  /** Density raster resolution along the bounds' long side (default 256, clamped 32…512). */
  resolution?: number;
}

export interface SettleOpts {
  /** Demand density, 0…1 (values outside are clamped). */
  density: FieldFn2;
  /** Spacing at density 1: a full-demand hexagonal cell at this spacing is one point's capacity. */
  spacing: L;
  /** Rounds (default 10). */
  iterations?: number;
  bounds?: Bounds;
  resolution?: number;
}

/** A density raster over `bounds`: cell centres at (i + ½)·cw, values
 * clamped to 0…1, non-positive and non-finite samples empty. */
export interface DensityRaster {
  cols: number;
  rows: number;
  cw: number;
  bounds: Bounds;
  dens: Float64Array;
}

export function densityRaster(field: FieldFn2, bounds: Bounds, resolution: number | undefined): DensityRaster {
  const R = Math.max(32, Math.min(512, resolution ?? 256));
  const long = Math.max(bounds.w, bounds.h);
  const cw = long / R;
  const cols = Math.max(2, Math.round(bounds.w / cw));
  const rows = Math.max(2, Math.round(bounds.h / cw));
  const dens = new Float64Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const v = field(bounds.x + (i + 0.5) * cw, bounds.y + (j + 0.5) * cw);
      dens[j * cols + i] = v > 0 ? Math.min(1, v) : 0;
    }
  }
  return { cols, rows, cw, bounds, dens };
}

/** Every raster sample goes to its nearest site: per site the integrated
 * density (`w`) and the density-weighted coordinate sums. */
export function accumulateCells(coords: Float64Array, raster: DensityRaster): { w: Float64Array; cx: Float64Array; cy: Float64Array } {
  const n = coords.length / 2;
  const del = new Delaunay(coords);
  const w = new Float64Array(n);
  const cx = new Float64Array(n);
  const cy = new Float64Array(n);
  const { cols, rows, cw, bounds, dens } = raster;
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
  return { w, cx, cy };
}

const coordsOf = (m: Material): Float64Array => {
  const c = new Float64Array(m.n * 2);
  for (let i = 0; i < m.n; i++) {
    c[2 * i] = m.x[i];
    c[2 * i + 1] = m.y[i];
  }
  return c;
};

const copyColumns = (cols: Readonly<Record<string, Float64Array>>): Record<string, Float64Array> => {
  const out: Record<string, Float64Array> = {};
  for (const k in cols) out[k] = Float64Array.from(cols[k]);
  return out;
};

/**
 * Lloyd relaxation: each point moves to the density-weighted centroid of
 * its nearest-site cell within the bounds, `iterations` times. Count,
 * rows, edges and every declared column are kept; a point whose cell holds
 * no density stays where it is. Writes no computed column.
 */
export function relaxMaterial(env: PointsEnv, m: Material, opts: RelaxOpts = {}): Material {
  const n = opts.iterations ?? 1;
  if (!Number.isInteger(n) || n < 0) throw new Error('relax: iterations must be a non-negative integer');
  const bounds = opts.bounds ?? env.bounds;
  const raster = densityRaster(opts.density ?? (() => 1), bounds, opts.resolution);
  const coords = coordsOf(m);
  for (let it = 0; it < n && m.n > 0; it++) {
    const { w, cx, cy } = accumulateCells(coords, raster);
    for (let p = 0; p < m.n; p++) {
      if (w[p] <= 0) continue;
      coords[2 * p] = cx[p] / w[p];
      coords[2 * p + 1] = cy[p] / w[p];
    }
  }
  const x = new Float64Array(m.n);
  const y = new Float64Array(m.n);
  for (let p = 0; p < m.n; p++) {
    x[p] = coords[2 * p];
    y[p] = coords[2 * p + 1];
  }
  return new Material(x, y, copyColumns(m.attrs), Uint32Array.from(m.edgeList), m.iteration, [], copyColumns(m.edgeAttrs), { ...m.transfers }, { ...m.edgeTransfers });
}

/**
 * Weighted Linde-Buzo-Gray settling: relaxation plus population control.
 * Each round, a point whose cell's demand exceeds its capacity splits into
 * two (placed either side of the weighted centroid, direction from the
 * seeded stream), one whose cell is starved dies, the rest move to their
 * centroids; the thresholds tighten with the round. Point-only input:
 * connected material is refused. Survivors keep their declared columns,
 * children copy their parent's (a copied value is duplicated, not shared
 * out), and `demand` is written for every point of the result.
 */
export function settleMaterial(env: PointsEnv, m: Material, opts: SettleOpts): Material {
  if (m.edgeCount > 0) throw new Error(`settle: the input has ${m.edgeCount} edges — settling changes the point count, so it takes point-only material; extract the points first (m.points.extract())`);
  if (typeof opts?.density !== 'function') throw new Error('settle: { density } is required — the field the point count follows');
  if (opts.spacing === undefined) throw new Error('settle: { spacing } is required — it sets one point\'s capacity');
  const spacingU = env.len(opts.spacing);
  if (!(spacingU > 0)) throw new Error('settle: { spacing } must be a positive length — it sets one point\'s capacity');
  const n = opts.iterations ?? 10;
  if (!Number.isInteger(n) || n < 0) throw new Error('settle: iterations must be a non-negative integer');
  const bounds = opts.bounds ?? env.bounds;
  const raster = densityRaster(opts.density, bounds, opts.resolution);
  const cw = raster.cw;
  // Capacity: integrated density a single point should carry — the amount
  // a full-demand hex cell at `spacing` holds. Cells above split, below die.
  const cap = ((spacingU * spacingU * 0.866) / (cw * cw)) * 1.0;

  let coords = coordsOf(m);
  let parent = Int32Array.from({ length: m.n }, (_, i) => i);
  let demand = new Float64Array(m.n);
  for (let it = 0; it < n && coords.length > 0; it++) {
    const count = coords.length / 2;
    const { w, cx, cy } = accumulateCells(coords, raster);
    const h = 0.5 * (1 - it / n);
    const nx: number[] = [];
    const ny: number[] = [];
    const np: number[] = [];
    const nd: number[] = [];
    for (let p = 0; p < count; p++) {
      if (w[p] <= 0) continue; // starved of any density: dies
      const mx = cx[p] / w[p];
      const my = cy[p] / w[p];
      const d = w[p] / cap;
      if (w[p] < cap * (1 - h) * 0.3) continue; // starved
      if (w[p] > cap * (1 + h)) {
        const a = env.rnd() * Math.PI * 2;
        const r = spacingU * 0.35;
        nx.push(mx + Math.cos(a) * r, mx - Math.cos(a) * r);
        ny.push(my + Math.sin(a) * r, my - Math.sin(a) * r);
        np.push(parent[p], parent[p]);
        nd.push(d, d);
      } else {
        nx.push(mx);
        ny.push(my);
        np.push(parent[p]);
        nd.push(d);
      }
    }
    coords = new Float64Array(nx.length * 2);
    for (let k = 0; k < nx.length; k++) {
      coords[2 * k] = nx[k];
      coords[2 * k + 1] = ny[k];
    }
    parent = Int32Array.from(np);
    demand = Float64Array.from(nd);
  }
  const count = coords.length / 2;
  const x = new Float64Array(count);
  const y = new Float64Array(count);
  for (let k = 0; k < count; k++) {
    x[k] = coords[2 * k];
    y[k] = coords[2 * k + 1];
  }
  const attrs: Record<string, Float64Array> = {};
  for (const name of m.attrNames) {
    if (name === 'demand') continue;
    const src = m.attrs[name];
    const col = new Float64Array(count);
    for (let k = 0; k < count; k++) col[k] = src[parent[k]];
    attrs[name] = col;
  }
  attrs.demand = demand;
  return new Material(x, y, attrs, new Uint32Array(0), m.iteration, [], {}, { ...m.transfers }, {});
}

/** Field-modulated Poisson-disk sampling (Bridson, variable radius): local
 * spacing = `spacing / sqrt(field)`, so demand-1 areas pack at `spacing`
 * and empty areas stay empty. Returns point-only material with a `density`
 * column: the field's value at each point, clamped to 0…1. */
export function scatterPoints(env: PointsEnv, field: FieldFn2 | undefined, opts: ScatterOpts): Material {
  const f: FieldFn2 = field ?? (() => 1);
  const spacingU = env.len(opts.spacing);
  if (!(spacingU > 0)) throw new Error('scatter: spacing must be a positive length');
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
  // Neighbour buckets as an intrusive linked list over two Int32Arrays:
  // `head[cell]` is the newest point in that cell, `nextOf[i]` the one
  // before it, -1 terminating. Both consumers (`fits`, `anyWithin`) are
  // pure any-overlap predicates that return on the first hit, so bucket
  // ORDER cannot change the answer.
  const head = new Int32Array(cols * rows).fill(-1);
  let nextCap = 1024;
  let nextOf = new Int32Array(nextCap).fill(-1);
  const px: number[] = [];
  const py: number[] = [];
  const density: number[] = [];
  // Each placed point's radius, kept from the moment it was computed: the
  // field is a pure function of position (contract).
  const radii: number[] = [];
  // Candidate reach is sized by the largest radius placed so far: no
  // already-placed neighbour can exceed it, so (r + rMaxSeen) / 2 bounds the
  // distance that can matter. A pure any-overlap predicate over a superset.
  const reachMax = Math.ceil(rMax / cell) + 1;
  let rMaxSeen = 0;
  const col = (x: number): number => Math.min(cols - 1, Math.max(0, Math.floor((x - bounds.x) / cell)));
  const row = (y: number): number => Math.min(rows - 1, Math.max(0, Math.floor((y - bounds.y) / cell)));
  const fits = (x: number, y: number, r: number): boolean => {
    const reach = Math.min(reachMax, Math.ceil((r + rMaxSeen) / 2 / cell) + 1);
    const ci = col(x);
    const cj = row(y);
    for (let dj = -reach; dj <= reach; dj++) {
      const nj = cj + dj;
      if (nj < 0 || nj >= rows) continue;
      for (let di = -reach; di <= reach; di++) {
        const ni = ci + di;
        if (ni < 0 || ni >= cols) continue;
        for (let k = head[nj * cols + ni]; k >= 0; k = nextOf[k]) {
          const need = (r + radii[k]) / 2;
          if (!Number.isFinite(need)) continue;
          const dx = px[k] - x;
          const dy = py[k] - y;
          if (dx * dx + dy * dy < need * need) return false;
        }
      }
    }
    return true;
  };
  const put = (x: number, y: number, r: number): void => {
    if (r > rMaxSeen) rMaxSeen = r;
    const id = px.length;
    if (id >= nextCap) {
      nextCap *= 2;
      const g = new Int32Array(nextCap).fill(-1);
      g.set(nextOf);
      nextOf = g;
    }
    const c = row(y) * cols + col(x);
    nextOf[id] = head[c];
    head[c] = id;
    radii.push(r);
    px.push(x);
    py.push(y);
    density.push(Math.min(1, Math.max(0, f(x, y))));
  };

  // Seed: rejection-sample a first point inside the field.
  const active: number[] = [];
  for (let tries = 0; tries < 500 && px.length === 0; tries++) {
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
      const bi = active[pick];
      const bx = px[bi];
      const by = py[bi];
      const rb = radii[bi];
      let placed = false;
      for (let k = 0; k < K; k++) {
        const a = env.rnd() * Math.PI * 2;
        const rr = rb * (1 + env.rnd());
        const x = bx + Math.cos(a) * rr;
        const y = by + Math.sin(a) * rr;
        if (x < bounds.x || y < bounds.y || x > bounds.x + bounds.w || y > bounds.y + bounds.h) {
          continue;
        }
        const r = rOf(x, y);
        if (!Number.isFinite(r) || !fits(x, y, r)) continue;
        active.push(px.length);
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
  // wider than its candidate reach, so a field made of ISLANDS kept only
  // the island the first point landed in. Scan the field for non-empty
  // places no point can see, seed each, and flood again. A field the first
  // flood already covered draws nothing here, so its points (and everything
  // downstream in the stream) are unchanged.
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
        for (let k = head[nj * cols + ni]; k >= 0; k = nextOf[k]) {
          const dx = px[k] - x;
          const dy = py[k] - y;
          if (dx * dx + dy * dy <= d2) return true;
        }
      }
    }
    return false;
  };
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
          active.push(px.length);
          put(x, y, r);
          seeded++;
          flood();
          break;
        }
      }
    }
    if (seeded === 0) break;
  }
  return new Material(Float64Array.from(px), Float64Array.from(py), { density: Float64Array.from(density) }, new Uint32Array(0));
}
