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

import { positiveLength } from './guard.js';
import type { FieldFn } from './shapes.js';
import { mm, type L } from './units.js';
import { chainSegments, marchSegments, type SampledGrid } from './marching.js';

export type { SampledGrid, SegmentBuffer } from './marching.js';
export { chainSegments, marchSegments } from './marching.js';

export interface IsoContour {
  pts: [number, number][];
  closed: boolean;
}

export interface IsoOpts {
  /** Sampling step (default: max of mm(1) and long-side/256 — crossings
   * are edge-interpolated, so positional error is far below the step). */
  step?: L;
  /** Close boundary-crossing regions along the drawable edge. */
  close?: boolean;
}

/** Environment handed in by the toolkit: drawable bounds and sketch-time
 * length resolution, both in user units. */
export interface IsoEnv {
  bounds: { x: number; y: number; w: number; h: number };
  len(l: L): number;
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
  at: number[],
  opts?: IsoOpts,
): IsoContour[][];
export function isolinesOf(
  env: IsoEnv,
  field: FieldFn,
  at: number | number[],
  opts: IsoOpts = {},
): IsoContour[] | IsoContour[][] {
  const b = env.bounds;
  positiveLength('isolines', opts.step);
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
  if (!Number.isFinite(cells)) {
    throw new Error(`isolines: grid is ${cells} — check for a zero step`);
  }
  if (cells > 16_777_216) {
    throw new Error(
      `isolines: ${Math.floor(cells)} grid cells (step too fine) — capped at 16.7M (~128MB of samples)`,
    );
  }
  const grid = sampleGrid(field, b, gw, gh);

  const close = opts.close === true;
  const levels = Array.isArray(at) ? at : [at];
  const perLevel = levels.map((lvl) => {
    if (!Number.isFinite(lvl)) throw new Error(`isolines: level is ${lvl}`);
    return finishContours(chainSegments(marchSegments(grid, lvl, close)), b, close);
  });
  return Array.isArray(at) ? perLevel : perLevel[0];
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
