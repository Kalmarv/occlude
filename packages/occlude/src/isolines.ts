/**
 * Field → contours: marching squares over a sampled grid — the bridge from
 * scalar fields to stampable geometry. Returns plain data (composable data
 * over sealed features): the artist stamps `polygon(c.pts)`, assembles
 * several contours into one evenodd `path()` for regions with holes, or
 * hands the result to `clip`.
 *
 * Semantics: contours trace the boundary of `{ field ≥ at }`. Contour
 * orientation is consistent (holes wind opposite their parents), but the
 * supported stamping story is evenodd winding, which never looks at
 * orientation. Non-finite field samples are ABSENT (a within() bound or a
 * NaN hole): cells touching absence emit nothing, so contours truncate
 * OPEN at a domain edge exactly as at the paper edge. Deterministic: a
 * pure function of the field, level, and options.
 *
 * Boundary policy: an isoline that exits the drawable edge is genuinely
 * open and comes back `closed: false`, drawable as ink without ugly border
 * runs. `close: true` pads the sampled grid with below-threshold sentinels
 * so every region closes along the drawable edge — the form clip and fill
 * want.
 */

import { usableLength } from './guard.js';
import type { FieldFn } from './shapes.js';
import type { Space } from './space.js';
import { mm, type L } from './units.js';
import { chainSegments, marchSegments, type SampledGrid } from './marching.js';

export type { SampledGrid, SegmentBuffer } from './marching.js';
export { chainSegments, marchSegments } from './marching.js';

export interface IsoContour {
  pts: [number, number][];
  closed: boolean;
  /** Segment by segment (a closed contour's closing segment last): is it a
   * geodesic of the sketch's space? Absent, every segment is the image of
   * its coordinate segment. A material's `geodesic` edge column says it. */
  geodesic?: readonly boolean[];
}

export interface IsoOpts {
  /** Sampling step (default: max of mm(1) and long-side/256 — crossings
   * are edge-interpolated, so positional error is far below the step). */
  step?: L;
  /** Close boundary-crossing regions along the drawable edge. */
  close?: boolean;
}

/**
 * Which levels to trace — the spelling `occlude/3d` already uses, so the
 * two `isolines` read the same: one level, a list of them, `count` levels
 * spread evenly inside the field's sampled range (`min`/`max` pin that
 * range), or every multiple of `spacing` (shifted by `offset`) that falls
 * inside it. `count` and `spacing` are answered by the same grid the
 * marching reads, so the range is the range the drawing actually has.
 */
export type IsoLevels =
  | number
  | number[]
  | { count: number; min?: number; max?: number }
  | { spacing: number; offset?: number };

/** The two spellings that need the field's own range before they are levels. */
type IsoLevelSpec = Exclude<IsoLevels, number | number[]>;

/** One level with the contours found at it — the shape `t.isolines` turns
 * into a material whose every edge carries its `level`. */
export interface IsoLevelContours {
  level: number;
  contours: IsoContour[];
}

/** Environment handed in by the toolkit: drawable bounds and sketch-time
 * length resolution, both in user units, and the run's geometry for the
 * words that measure in it (`t.travelTime`). Absent or Euclidean is the
 * flat plane. The marching grid itself is a chart grid either way. */
export interface IsoEnv {
  bounds: { x: number; y: number; w: number; h: number };
  len(l: L): number;
  space?: Space;
}

export function isolinesOf(
  env: IsoEnv,
  field: FieldFn,
  at: number,
  opts?: IsoOpts,
): IsoContour[];
export function isolinesOf(
  env: IsoEnv,
  field: FieldFn,
  at: number[] | IsoLevelSpec,
  opts?: IsoOpts,
): IsoContour[][];
export function isolinesOf(
  env: IsoEnv,
  field: FieldFn,
  at: IsoLevels,
  opts?: IsoOpts,
): IsoContour[] | IsoContour[][];
export function isolinesOf(
  env: IsoEnv,
  field: FieldFn,
  at: IsoLevels,
  opts: IsoOpts = {},
): IsoContour[] | IsoContour[][] {
  const found = levelContours(env, field, at, opts);
  if (typeof at === 'number') return found.length > 0 ? found[0].contours : [];
  return found.map((g) => g.contours);
}

/**
 * The contours of `field` at every level `at` asks for, each level named by
 * the value it was traced at. One sampling of the field serves them all,
 * and `{ count }` / `{ spacing }` read their range from that same sampling.
 * `isolinesOf` is this without the names.
 */
export function levelContours(
  env: IsoEnv,
  field: FieldFn,
  at: IsoLevels,
  opts: IsoOpts = {},
): IsoLevelContours[] {
  const b = env.bounds;
  // A list is the levels themselves, in the order given — a non-finite one
  // keeps its place and draws nothing. A spec has to see the field first.
  const given = typeof at === 'number' ? [at] : Array.isArray(at) ? at : null;
  if (given === null) checkSpec(at as IsoLevelSpec);
  const empty = (): IsoLevelContours[] =>
    given === null ? [] : given.map((level) => ({ level, contours: [] }));
  // A step that is not a positive length draws no contours at all.
  if (!usableLength(opts.step)) return empty();
  const stepU =
    opts.step !== undefined
      ? env.len(opts.step)
      : Math.max(env.len(mm(1)), Math.max(b.w, b.h) / 256);
  const gw = Math.max(2, Math.ceil(b.w / stepU) + 1);
  const gh = Math.max(2, Math.ceil(b.h / stepU) + 1);
  // Grid cells are O(1) samples, not shape repetitions, so the combinator
  // cap doesn't apply — only memory sanity does. 2^24 cells is a 128MB
  // sample buffer (4096², step 0.05mm on 200mm paper — far sub-nib);
  // beyond that is a mid-edit transient, not a sketch.
  const cells = gw * gh;
  // A grid that is not a finite size has no samples to march over.
  if (!Number.isFinite(cells)) return empty();
  if (cells > 16_777_216) {
    throw new Error(
      `isolines: ${Math.floor(cells)} grid cells (step too fine) — capped at 16.7M (~128MB of samples)`,
    );
  }
  const grid = sampleGrid(field, b, gw, gh);

  const close = opts.close === true;
  const levels = given ?? resolveLevels(at as IsoLevelSpec, grid);
  return levels.map((level) => ({
    level,
    // A level that is not a number is skipped; the others still march.
    contours: Number.isFinite(level)
      ? finishContours(chainSegments(marchSegments(grid, level, close)), b, close)
      : [],
  }));
}

/** A count that is not a whole repetition count is a mistake, whatever the
 * field turns out to hold, so it is caught before the field is sampled. */
function checkSpec(spec: IsoLevelSpec): void {
  if ('count' in spec && !Number.isSafeInteger(spec.count)) {
    throw new Error('isolines count must be a positive integer');
  }
}

/** The levels `{ count }` or `{ spacing }` asks for, read against the range
 * of the sampled field. A flat field, a spacing of zero and a field with no
 * finite samples all resolve to nothing to draw. */
function resolveLevels(spec: IsoLevelSpec, grid: SampledGrid): number[] {
  const { min, max } = sampledRange(grid);
  if ('count' in spec) {
    const count = spec.count;
    const lo = spec.min ?? min;
    const hi = spec.max ?? max;
    if (count < 1 || !Number.isFinite(lo) || !Number.isFinite(hi) || !(hi > lo)) return [];
    return Array.from({ length: count }, (_, i) => lo + ((hi - lo) * (i + 1)) / (count + 1));
  }
  const spacing = spec.spacing;
  const offset = spec.offset ?? 0;
  if (!Number.isFinite(spacing) || spacing <= 0 || !Number.isFinite(offset)) return [];
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  const first = Math.ceil((min - offset) / spacing);
  const last = Math.floor((max - offset) / spacing);
  if (last - first > 1_000_000) throw new Error('isolines spacing produces too many levels');
  const out: number[] = [];
  for (let k = first; k <= last; k++) out.push(k * spacing + offset);
  return out;
}

/** The range of the samples that exist: absent samples (a `within()` bound,
 * a NaN hole) and the pad ring are not part of the field. */
function sampledRange(grid: SampledGrid): { min: number; max: number } {
  const { vals, absent, pw, gw, gh } = grid;
  let min = Infinity;
  let max = -Infinity;
  for (let j = 0; j < gh; j++) {
    const row = (j + 1) * pw + 1;
    for (let i = 0; i < gw; i++) {
      if (absent[row + i]) continue;
      const v = vals[row + i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return { min, max };
}

/** Sample `field` on the `gw × gh` lattice over `b`, padded by one ring.
 * Non-finite samples become deeply-outside sentinels so interpolation
 * stays finite and the crossing lands at the finite corner; they are also
 * marked absent, so cells touching them emit nothing (see marching.ts). */
export function sampleGrid(
  field: FieldFn,
  b: { x: number; y: number; w: number; h: number },
  gw: number,
  gh: number,
): SampledGrid {
  const sx = b.w / (gw - 1);
  const sy = b.h / (gh - 1);
  // Sample once; every level marches over the same grid. Padded by one ring
  // on every side (stride pw = gw + 2). The ring holds the `close` sentinel
  // and is never "absent", so the marching reads samples with a plain
  // indexed load instead of four bounds checks per access — `val` alone was
  // 20% of isolinesOf.
  const pw = gw + 2;
  const ph = gh + 2;
  const vals = new Float64Array(pw * ph);
  // Absent samples (non-finite — a within() bound or a hand-rolled NaN
  // hole) are tracked separately: cells touching absence emit NOTHING, so
  // contours truncate OPEN at the domain edge exactly as they do at the
  // paper edge — never a staircase wall hugging the bound.
  const absent = new Uint8Array(pw * ph);
  for (let j = 0; j < gh; j++) {
    const row = (j + 1) * pw + 1;
    for (let i = 0; i < gw; i++) {
      const v = field(b.x + i * sx, b.y + j * sy);
      const fin = Number.isFinite(v);
      vals[row + i] = fin ? v : -1e30;
      absent[row + i] = fin ? 0 : 1;
    }
  }
  return { vals, absent, pw, gw, gh, b, sx, sy };
}

/** Clamp close-mode points onto the drawable, drop duplicate vertices, and
 * merge colinear runs (the clamped border runs collapse to their corners). */
export function finishContours(
  contours: IsoContour[],
  b: { x: number; y: number; w: number; h: number },
  close: boolean,
): IsoContour[] {
  const out: IsoContour[] = [];
  for (const c of contours) {
    let pts = c.pts;
    if (close) {
      pts = pts.map(([x, y]) => [
        Math.min(b.x + b.w, Math.max(b.x, x)),
        Math.min(b.y + b.h, Math.max(b.y, y)),
      ]);
    }
    // Consecutive duplicates.
    const dedup: [number, number][] = [];
    for (const p of pts) {
      const l = dedup[dedup.length - 1];
      if (!l || Math.abs(p[0] - l[0]) > 1e-9 || Math.abs(p[1] - l[1]) > 1e-9) dedup.push(p);
    }
    if (c.closed && dedup.length > 1) {
      const [f, l] = [dedup[0], dedup[dedup.length - 1]];
      if (Math.abs(f[0] - l[0]) <= 1e-9 && Math.abs(f[1] - l[1]) <= 1e-9) dedup.pop();
    }
    pts = mergeColinear(dedup, c.closed);
    if (pts.length >= (c.closed ? 3 : 2)) out.push({ pts, closed: c.closed });
  }
  return out;
}

function mergeColinear(pts: [number, number][], closed: boolean): [number, number][] {
  const n = pts.length;
  if (n < 3) return pts;
  const keep: boolean[] = new Array<boolean>(n).fill(true);
  const lo = closed ? 0 : 1;
  const hi = closed ? n : n - 1;
  for (let k = lo; k < hi; k++) {
    const p = pts[(k - 1 + n) % n];
    const q = pts[k];
    const r = pts[(k + 1) % n];
    const ux = q[0] - p[0];
    const uy = q[1] - p[1];
    const vx = r[0] - q[0];
    const vy = r[1] - q[1];
    const cross = ux * vy - uy * vx;
    const dot = ux * vx + uy * vy;
    if (dot > 0 && Math.abs(cross) <= 1e-9 * Math.hypot(ux, uy) * Math.hypot(vx, vy)) {
      keep[k] = false;
    }
  }
  return pts.filter((_, k) => keep[k]);
}
