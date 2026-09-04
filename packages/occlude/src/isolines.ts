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
  const sx = b.w / (gw - 1);
  const sy = b.h / (gh - 1);

  // Sample once; every level marches over the same grid. Non-finite samples
  // become deeply-outside sentinels so interpolation stays finite and the
  // crossing lands at the finite corner.
  // Padded by one ring on every side (stride pw = gw + 2). The ring holds
  // the `close` sentinel and is never "absent", so marchLevel reads samples
  // with a plain indexed load instead of four bounds checks per access —
  // `val` alone was 20% of isolinesOf.
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

  const close = opts.close === true;
  const levels = Array.isArray(at) ? at : [at];
  const perLevel = levels.map((lvl) => {
    if (!Number.isFinite(lvl)) throw new Error(`isolines: level is ${lvl}`);
    return marchLevel(vals, absent, pw, gw, gh, b, sx, sy, lvl, close);
  });
  return Array.isArray(at) ? perLevel : perLevel[0];
}

function marchLevel(
  vals: Float64Array,
  absent: Uint8Array,
  pw: number,
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
  // The pad ring carries the below-level sentinel; out-of-grid samples are
  // the paper-edge closing ring, never "absent", so `absent` stays 0 there
  // and only in-grid non-finite samples truncate contours. Index (i,j) in
  // grid space is (j+1)*pw + (i+1) in padded space, valid for i,j in
  // [-1, gw] / [-1, gh] — exactly the range marchLevel walks.
  const pad = lvl - 1;
  const ph = gh + 2;
  for (let i = 0; i < pw; i++) {
    vals[i] = pad; // top ring row
    vals[(ph - 1) * pw + i] = pad; // bottom ring row
  }
  for (let j = 0; j < ph; j++) {
    vals[j * pw] = pad; // left ring column
    vals[j * pw + pw - 1] = pad; // right ring column
  }
  const at = (i: number, j: number): number => (j + 1) * pw + (i + 1);
  const px = (i: number): number => b.x + i * sx;
  const py = (j: number): number => b.y + j * sy;
  const lo = close ? -1 : 0;
  const hiI = close ? gw : gw - 1; // exclusive cell upper bounds
  const hiJ = close ? gh : gh - 1;

  // Segments as a flat growable buffer, four scalars per segment. The old
  // shape allocated five closures and two [x, y] tuples PER CELL, which on a
  // 256² grid is ~330k closures a level and showed up as pure GC time.
  let segCap = 1024;
  let segXY = new Float64Array(segCap * 4);
  let segN = 0;
  const emit = (ax: number, ay: number, bx: number, by: number): void => {
    if (ax === bx && ay === by) return;
    if (segN === segCap) {
      segCap *= 2;
      const g = new Float64Array(segCap * 4);
      g.set(segXY);
      segXY = g;
    }
    const o = segN++ * 4;
    segXY[o] = ax; segXY[o + 1] = ay; segXY[o + 2] = bx; segXY[o + 3] = by;
  };
  // Crossing on a horizontal sample edge (i,j)–(i+1,j) and vertical
  // (i,j)–(i,j+1); shared edges produce bitwise-identical points in both
  // adjacent cells, so chaining is a hash hit. Hoisted out of the cell loop
  // and returning scalars — the arithmetic is unchanged, so the emitted
  // coordinates are bit-identical to the tuple version.
  const xTx = (i: number, va: number, vb: number): number =>
    px(i) + sx * ((lvl - va) / (vb - va));
  const yLy = (j: number, va: number, vd: number): number =>
    py(j) + sy * ((lvl - va) / (vd - va));
  for (let j = lo; j < hiJ; j++) {
    for (let i = lo; i < hiI; i++) {
      const o = at(i, j);
      const va = vals[o]; // top-left
      const vb = vals[o + 1]; // top-right
      const vc = vals[o + pw + 1]; // bottom-right
      const vd = vals[o + pw]; // bottom-left
      // Domain-edge policy: a cell touching an absent sample emits nothing
      // — the contour ends (open), like at the paper edge.
      if (absent[o] === 1 || absent[o + 1] === 1 || absent[o + pw + 1] === 1 || absent[o + pw] === 1) continue;
      const code =
        (va >= lvl ? 1 : 0) | (vb >= lvl ? 2 : 0) | (vc >= lvl ? 4 : 0) | (vd >= lvl ? 8 : 0);
      if (code === 0 || code === 15) continue;
      // Crossing coordinates as scalars. Tx/Bx/Ly/Ry are the only varying
      // components; the other component of each is a grid line.
      const Tx = (): number => xTx(i, va, vb);
      const Ty = py(j);
      const Bx = (): number => xTx(i, vd, vc);
      const By = py(j + 1);
      const Lx = px(i);
      const Ly = (): number => yLy(j, va, vd);
      const Rx = px(i + 1);
      const Ry = (): number => yLy(j, vb, vc);
      switch (code) {
        case 1: emit(Lx, Ly(), Tx(), Ty); break;
        case 2: emit(Tx(), Ty, Rx, Ry()); break;
        case 3: emit(Lx, Ly(), Rx, Ry()); break;
        case 4: emit(Rx, Ry(), Bx(), By); break;
        case 5: {
          // Saddle: the cell-centre average decides which diagonal connects.
          const centre = (va + vb + vc + vd) / 4 >= lvl;
          if (centre) { emit(Rx, Ry(), Tx(), Ty); emit(Lx, Ly(), Bx(), By); }
          else { emit(Lx, Ly(), Tx(), Ty); emit(Rx, Ry(), Bx(), By); }
          break;
        }
        case 6: emit(Tx(), Ty, Bx(), By); break;
        case 7: emit(Lx, Ly(), Bx(), By); break;
        case 8: emit(Bx(), By, Lx, Ly()); break;
        case 9: emit(Bx(), By, Tx(), Ty); break;
        case 10: {
          const centre = (va + vb + vc + vd) / 4 >= lvl;
          if (centre) { emit(Tx(), Ty, Lx, Ly()); emit(Bx(), By, Rx, Ry()); }
          else { emit(Tx(), Ty, Rx, Ry()); emit(Bx(), By, Lx, Ly()); }
          break;
        }
        case 11: emit(Bx(), By, Rx, Ry()); break;
        case 12: emit(Rx, Ry(), Lx, Ly()); break;
        case 13: emit(Rx, Ry(), Tx(), Ty); break;
        default: emit(Tx(), Ty, Lx, Ly()); break; // 14
      }
    }
  }
  return finishContours(chain(segXY, segN), b, close);
}

/** Join directed segments end-to-start into contours. Orientation is
 * consistent from the case table, so forward extension follows `b → a`
 * matches and backward extension `a → b` matches; iteration is emission
 * order, so the result is deterministic. */
function chain(segXY: Float64Array, segN: number): IsoContour[] {
  const Q = 1e-6; // user units — far below any step, above float noise
  const q = (v: number): number => Math.round(v / Q);
  const ax = (k: number): number => segXY[k * 4];
  const ay = (k: number): number => segXY[k * 4 + 1];
  const bx = (k: number): number => segXY[k * 4 + 2];
  const by = (k: number): number => segXY[k * 4 + 3];
  // Endpoint index keyed by the quantised pair as NUMBERS, two levels deep.
  // The old shape built a `${rx},${ry}` string for every endpoint and every
  // probe; chain + take were 22% of isolinesOf, most of it string building.
  interface Bucket {
    idx: number[];
    /** Entries before this are all consumed — see `take`. */
    cur: number;
  }
  type Index = Map<number, Map<number, Bucket>>;
  const byStart: Index = new Map();
  const byEnd: Index = new Map();
  const add = (m: Index, rx: number, ry: number, k: number): void => {
    let inner = m.get(rx);
    if (inner === undefined) {
      inner = new Map();
      m.set(rx, inner);
    }
    const bkt = inner.get(ry);
    if (bkt === undefined) inner.set(ry, { idx: [k], cur: 0 });
    else bkt.idx.push(k);
  };
  for (let k = 0; k < segN; k++) {
    add(byStart, q(ax(k)), q(ay(k)), k);
    add(byEnd, q(bx(k)), q(by(k)), k);
  }
  const used = new Uint8Array(segN);
  // A segment never becomes unused again, so a bucket's cursor can advance
  // past consumed entries for good: same "first unused" answer, without
  // rescanning the bucket from the front on every probe.
  const take = (m: Index, rx: number, ry: number): number | undefined => {
    const inner = m.get(rx);
    if (inner === undefined) return undefined;
    const bkt = inner.get(ry);
    if (bkt === undefined) return undefined;
    const list = bkt.idx;
    let c = bkt.cur;
    while (c < list.length && used[list[c]] === 1) c++;
    bkt.cur = c;
    return c < list.length ? list[c] : undefined;
  };
  const out: IsoContour[] = [];
  for (let k = 0; k < segN; k++) {
    if (used[k]) continue;
    used[k] = 1;
    let pts: [number, number][] = [
      [ax(k), ay(k)],
      [bx(k), by(k)],
    ];
    // Quantised key of the chain's first point, kept in step with pts[0].
    let sx = q(ax(k));
    let sy = q(ay(k));
    const endsAtStart = (): boolean => {
      const l = pts[pts.length - 1];
      return pts.length > 2 && q(l[0]) === sx && q(l[1]) === sy;
    };
    // Forward: append segments starting where the chain ends.
    for (;;) {
      const last = pts[pts.length - 1];
      const lx = q(last[0]);
      const ly = q(last[1]);
      if (lx === sx && ly === sy && pts.length > 2) break;
      const n = take(byStart, lx, ly);
      if (n === undefined) break;
      used[n] = 1;
      pts.push([bx(n), by(n)]);
    }
    let closed = endsAtStart();
    if (closed) {
      pts.pop();
    } else {
      // Backward: prepend segments ending where the chain starts. Collected
      // and spliced once — unshift per segment made long open chains
      // quadratic.
      const head: [number, number][] = [];
      for (;;) {
        const n = take(byEnd, sx, sy);
        if (n === undefined) break;
        used[n] = 1;
        head.push([ax(n), ay(n)]);
        sx = q(ax(n));
        sy = q(ay(n));
      }
      if (head.length > 0) {
        head.reverse();
        pts = head.concat(pts);
      }
      closed = endsAtStart();
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
