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
 * orientation. Non-finite field samples count as outside. Deterministic:
 * a pure function of the field, level, and options.
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

interface Seg {
  ax: number;
  ay: number;
  bx: number;
  by: number;
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
  const sx = b.w / (gw - 1);
  const sy = b.h / (gh - 1);

  // Sample once; every level marches over the same grid. Non-finite samples
  // become deeply-outside sentinels so interpolation stays finite and the
  // crossing lands at the finite corner.
  const vals = new Float64Array(gw * gh);
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      const v = field(b.x + i * sx, b.y + j * sy);
      vals[j * gw + i] = Number.isFinite(v) ? v : -1e30;
    }
  }

  const close = opts.close === true;
  const levels = Array.isArray(at) ? at : [at];
  const perLevel = levels.map((lvl) => {
    if (!Number.isFinite(lvl)) throw new Error(`isolines: level is ${lvl}`);
    return marchLevel(vals, gw, gh, b, sx, sy, lvl, close);
  });
  return Array.isArray(at) ? perLevel : perLevel[0];
}

function marchLevel(
  vals: Float64Array,
  gw: number,
  gh: number,
  b: { x: number; y: number; w: number; h: number },
  sx: number,
  sy: number,
  lvl: number,
  close: boolean,
): IsoContour[] {
  // With `close`, one ring of below-level sentinel samples surrounds the
  // grid (indices -1 and gw/gh), so every region's boundary closes just
  // outside the drawable; the emitted points are clamped back onto it and
  // the colinear merge collapses the border runs.
  const pad = lvl - 1;
  const val = (i: number, j: number): number =>
    i < 0 || j < 0 || i >= gw || j >= gh ? pad : vals[j * gw + i];
  const px = (i: number): number => b.x + i * sx;
  const py = (j: number): number => b.y + j * sy;
  const lo = close ? -1 : 0;
  const hiI = close ? gw : gw - 1; // exclusive cell upper bounds
  const hiJ = close ? gh : gh - 1;

  const segs: Seg[] = [];
  // Crossing on a horizontal sample edge (i,j)–(i+1,j) and vertical
  // (i,j)–(i,j+1); shared edges produce bitwise-identical points in both
  // adjacent cells, so chaining is a hash hit.
  const xT = (i: number, j: number, va: number, vb: number): [number, number] => [
    px(i) + sx * ((lvl - va) / (vb - va)),
    py(j),
  ];
  const yL = (i: number, j: number, va: number, vd: number): [number, number] => [
    px(i),
    py(j) + sy * ((lvl - va) / (vd - va)),
  ];
  for (let j = lo; j < hiJ; j++) {
    for (let i = lo; i < hiI; i++) {
      const va = val(i, j); // top-left
      const vb = val(i + 1, j); // top-right
      const vc = val(i + 1, j + 1); // bottom-right
      const vd = val(i, j + 1); // bottom-left
      const code =
        (va >= lvl ? 1 : 0) | (vb >= lvl ? 2 : 0) | (vc >= lvl ? 4 : 0) | (vd >= lvl ? 8 : 0);
      if (code === 0 || code === 15) continue;
      const T = (): [number, number] => xT(i, j, va, vb);
      const B = (): [number, number] => xT(i, j + 1, vd, vc);
      const Lf = (): [number, number] => yL(i, j, va, vd);
      const R = (): [number, number] => yL(i + 1, j, vb, vc);
      const emit = (p: [number, number], q: [number, number]): void => {
        if (p[0] !== q[0] || p[1] !== q[1]) {
          segs.push({ ax: p[0], ay: p[1], bx: q[0], by: q[1] });
        }
      };
      switch (code) {
        case 1: emit(Lf(), T()); break;
        case 2: emit(T(), R()); break;
        case 3: emit(Lf(), R()); break;
        case 4: emit(R(), B()); break;
        case 5: {
          // Saddle: the cell-centre average decides which diagonal connects.
          const centre = (va + vb + vc + vd) / 4 >= lvl;
          if (centre) { emit(R(), T()); emit(Lf(), B()); }
          else { emit(Lf(), T()); emit(R(), B()); }
          break;
        }
        case 6: emit(T(), B()); break;
        case 7: emit(Lf(), B()); break;
        case 8: emit(B(), Lf()); break;
        case 9: emit(B(), T()); break;
        case 10: {
          const centre = (va + vb + vc + vd) / 4 >= lvl;
          if (centre) { emit(T(), Lf()); emit(B(), R()); }
          else { emit(T(), R()); emit(B(), Lf()); }
          break;
        }
        case 11: emit(B(), R()); break;
        case 12: emit(R(), Lf()); break;
        case 13: emit(R(), T()); break;
        default: emit(T(), Lf()); break; // 14
      }
    }
  }
  return finishContours(chain(segs), b, close);
}

/** Join directed segments end-to-start into contours. Orientation is
 * consistent from the case table, so forward extension follows `b → a`
 * matches and backward extension `a → b` matches; iteration is emission
 * order, so the result is deterministic. */
function chain(segs: Seg[]): IsoContour[] {
  const Q = 1e-6; // user units — far below any step, above float noise
  const key = (x: number, y: number): string =>
    `${Math.round(x / Q)},${Math.round(y / Q)}`;
  const byStart = new Map<string, number[]>();
  const byEnd = new Map<string, number[]>();
  segs.forEach((s, k) => {
    const ks = key(s.ax, s.ay);
    const ke = key(s.bx, s.by);
    (byStart.get(ks) ?? byStart.set(ks, []).get(ks)!).push(k);
    (byEnd.get(ke) ?? byEnd.set(ke, []).get(ke)!).push(k);
  });
  const used = new Uint8Array(segs.length);
  const take = (m: Map<string, number[]>, k: string): number | undefined => {
    const cands = m.get(k);
    if (!cands) return undefined;
    for (const c of cands) if (!used[c]) return c;
    return undefined;
  };
  const out: IsoContour[] = [];
  for (let k = 0; k < segs.length; k++) {
    if (used[k]) continue;
    used[k] = 1;
    const s = segs[k];
    const pts: [number, number][] = [
      [s.ax, s.ay],
      [s.bx, s.by],
    ];
    const startKey = (): string => key(pts[0][0], pts[0][1]);
    // Forward: append segments starting where the chain ends.
    for (;;) {
      const last = pts[pts.length - 1];
      const nk = key(last[0], last[1]);
      if (nk === startKey() && pts.length > 2) break;
      const n = take(byStart, nk);
      if (n === undefined) break;
      used[n] = 1;
      pts.push([segs[n].bx, segs[n].by]);
    }
    let closed = pts.length > 2 && key(pts[pts.length - 1][0], pts[pts.length - 1][1]) === startKey();
    if (closed) {
      pts.pop();
    } else {
      // Backward: prepend segments ending where the chain starts.
      for (;;) {
        const n = take(byEnd, startKey());
        if (n === undefined) break;
        used[n] = 1;
        pts.unshift([segs[n].ax, segs[n].ay]);
      }
      closed =
        pts.length > 2 && key(pts[pts.length - 1][0], pts[pts.length - 1][1]) === startKey();
      if (closed) pts.pop();
    }
    out.push({ pts, closed });
  }
  return out;
}

/** Clamp close-mode points onto the drawable, drop duplicate vertices, and
 * merge colinear runs (the clamped border runs collapse to their corners). */
function finishContours(
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
