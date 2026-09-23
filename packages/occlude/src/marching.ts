/**
 * The middle of the isoline pipeline, independently callable: marching
 * squares over an already sampled grid (`marchSegments`), and the chaining
 * of the directed crossing segments into contours (`chainSegments`).
 * `isolines.ts` samples the field before and finishes the contours after
 * (`sampleGrid`, `finishContours`); production runs exactly that
 * composition. Nothing here reads a field, the paper or a unit — a grid
 * in, plain data out — so the marching can be replaced (or run elsewhere)
 * while the sampler and the finishing stay as they are.
 *
 * Case decisions, segment order and the saddle rule are unchanged from
 * the one-file version; the emitted coordinates are the same doubles.
 */

import type { LevelContour } from './isolines.js';

/** A field sampled on the isoline lattice, padded by one ring on every
 * side (stride `pw = gw + 2`): sample (i, j) of the grid is
 * `vals[(j + 1) * pw + (i + 1)]`. `absent` marks in-grid non-finite
 * samples (a `within()` bound or a NaN hole); the ring is never absent.
 * `b`, `sx`, `sy` place the lattice: sample (i, j) sits at
 * `(b.x + i * sx, b.y + j * sy)`. */
export interface SampledGrid {
  vals: Float64Array;
  absent: Uint8Array;
  /** Where the domain ends along each lattice edge that joins a present
   * sample to an absent one, as the fraction of the step from the edge's
   * first sample: `h[j * gw + i]` on the edge (i, j)–(i + 1, j), `v[j * gw
   * + i]` on (i, j)–(i, j + 1). Absent when the grid has no absent sample. */
  wall?: { h: Float64Array; v: Float64Array };
  pw: number;
  gw: number;
  gh: number;
  b: { x: number; y: number; w: number; h: number };
  sx: number;
  sy: number;
}

/** Directed crossing segments, four scalars each: `[ax, ay, bx, by]` at
 * `4k`; only the first `segN` are meaningful. `segWall[k]` is 1 when
 * segment `k` lies in a cell at the edge of the domain — the pad ring
 * outside the drawable, or a cell touching an absent sample — and so
 * closes a region rather than tracing the level through open ground. */
export interface SegmentBuffer {
  segXY: Float64Array;
  segWall: Uint8Array;
  segN: number;
}

/** Marching squares over one sampled grid at one level: the directed
 * crossing segments, four scalars each, in cell order. The pad ring of
 * `grid.vals` is (re)written with the below-level sentinel on every call —
 * the levels of one sampling share the buffer, as they always have.
 *
 * Where the domain ends — the drawable with `close`, or an absent sample —
 * counts as below the level, so every region closes along it. A segment
 * that runs along that edge rather than along the level is marked in
 * `segWall`; the level line is everything else.
 *
 * `cells` picks which cells emit: `'plain'` the level line alone (it never
 * reads `grid.wall`, so a grid sampled without its walls serves), `'all'`
 * every cell, and a list from `edgeCells` the closing runs alone — the
 * cells at the domain's edge are the same at every level, so they are found
 * once and each level visits only them. Plain and edge cells are each
 * other's complement in the same cell order, so either one is
 * `wallSegments` of `'all'`. */
export function marchSegments(grid: SampledGrid, lvl: number, close: boolean, cells: 'all' | 'plain' | Int32Array = 'all'): SegmentBuffer {
  const { vals, absent, pw, gw, gh, b, sx, sy, wall } = grid;
  // With `close`, one ring of below-level sentinel samples surrounds the
  // grid (indices -1 and gw/gh), so every region's boundary closes just
  // outside the drawable; the emitted points are clamped back onto it and
  // the colinear merge collapses the border runs.
  // The pad ring carries the below-level sentinel; out-of-grid samples are
  // the paper-edge closing ring, never "absent", so `absent` stays 0 there
  // and only in-grid non-finite samples are absent. Index (i,j) in
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
  let segWall = new Uint8Array(segCap);
  let segN = 0;
  const emit = (ax: number, ay: number, bx: number, by: number, onWall = 0): void => {
    if (ax === bx && ay === by) return;
    if (segN === segCap) {
      segCap *= 2;
      const g = new Float64Array(segCap * 4);
      g.set(segXY);
      segXY = g;
      const w = new Uint8Array(segCap);
      w.set(segWall);
      segWall = w;
    }
    segWall[segN] = onWall;
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

  // A cell on the domain's edge: in the pad ring, or touching an absent
  // sample. Few of them, so they take a slower path that names each
  // crossing by the cell side it lies on: T, R, B, L = 0, 1, 2, 3.
  const edgeX = new Float64Array(4);
  const edgeY = new Float64Array(4);
  const wallCell = (i: number, j: number, o: number, va: number, vb: number, vc: number, vd: number, code: number): void => {
    // Top (i,j)–(i+1,j), right (i+1,j)–(i+1,j+1), bottom (i,j+1)–(i+1,j+1),
    // left (i,j)–(i,j+1). A crossing against an absent sample lies where the
    // field stops, which the sampler found; any other is interpolated as in
    // the plain cell, the pad ring included.
    const aT = absent[o] === 1 || absent[o + 1] === 1;
    const aR = absent[o + 1] === 1 || absent[o + pw + 1] === 1;
    const aB = absent[o + pw] === 1 || absent[o + pw + 1] === 1;
    const aL = absent[o] === 1 || absent[o + pw] === 1;
    edgeY[0] = py(j);
    edgeX[0] = aT ? px(i) + sx * wall!.h[j * gw + i] : xTx(i, va, vb);
    edgeX[1] = px(i + 1);
    edgeY[1] = aR ? py(j) + sy * wall!.v[j * gw + i + 1] : yLy(j, vb, vc);
    edgeY[2] = py(j + 1);
    edgeX[2] = aB ? px(i) + sx * wall!.h[(j + 1) * gw + i] : xTx(i, vd, vc);
    edgeX[3] = px(i);
    edgeY[3] = aL ? py(j) + sy * wall!.v[j * gw + i] : yLy(j, va, vd);
    // Every segment of an edge cell closes the region: a ring cell lies
    // outside the drawable and is clamped onto its edge, and a cell touching
    // an absent sample is where the field stops. The level line is the
    // plain cells alone — exactly the line an open march draws.
    const seg = (p: number, q: number): void => emit(edgeX[p], edgeY[p], edgeX[q], edgeY[q], 1);
    switch (code) {
      case 1: seg(3, 0); break;
      case 2: seg(0, 1); break;
      case 3: seg(3, 1); break;
      case 4: seg(1, 2); break;
      case 5: {
        const centre = (va + vb + vc + vd) / 4 >= lvl;
        if (centre) { seg(1, 0); seg(3, 2); }
        else { seg(3, 0); seg(1, 2); }
        break;
      }
      case 6: seg(0, 2); break;
      case 7: seg(3, 2); break;
      case 8: seg(2, 3); break;
      case 9: seg(2, 0); break;
      case 10: {
        const centre = (va + vb + vc + vd) / 4 >= lvl;
        if (centre) { seg(0, 3); seg(2, 1); }
        else { seg(0, 1); seg(2, 3); }
        break;
      }
      case 11: seg(2, 1); break;
      case 12: seg(1, 3); break;
      case 13: seg(1, 0); break;
      default: seg(0, 3); break; // 14
    }
  };
  // The edge cells alone: each packed as its padded top-left index, in the
  // order the full walk meets them. The list is the closing walk's, ring
  // included, so it is marched as `close` marches.
  if (cells instanceof Int32Array) {
    for (let k = 0; k < cells.length; k++) {
      const o = cells[k];
      const j = Math.floor(o / pw) - 1;
      const i = o - (j + 1) * pw - 1;
      const va = vals[o];
      const vb = vals[o + 1];
      const vc = vals[o + pw + 1];
      const vd = vals[o + pw];
      const code =
        (va >= lvl ? 1 : 0) | (vb >= lvl ? 2 : 0) | (vc >= lvl ? 4 : 0) | (vd >= lvl ? 8 : 0);
      if (code === 0 || code === 15) continue;
      wallCell(i, j, o, va, vb, vc, vd, code);
    }
    return { segXY, segWall, segN };
  }
  for (let j = lo; j < hiJ; j++) {
    for (let i = lo; i < hiI; i++) {
      const o = at(i, j);
      const va = vals[o]; // top-left
      const vb = vals[o + 1]; // top-right
      const vc = vals[o + pw + 1]; // bottom-right
      const vd = vals[o + pw]; // bottom-left
      // An absent sample reads as below the level (its value is the deep
      // sentinel), so the region stops where the field does.
      const code =
        (va >= lvl ? 1 : 0) | (vb >= lvl ? 2 : 0) | (vc >= lvl ? 4 : 0) | (vd >= lvl ? 8 : 0);
      if (code === 0 || code === 15) continue;
      const ring = i < 0 || j < 0 || i >= gw - 1 || j >= gh - 1;
      if (ring || absent[o] === 1 || absent[o + 1] === 1 || absent[o + pw + 1] === 1 || absent[o + pw] === 1) {
        if (cells === 'all') wallCell(i, j, o, va, vb, vc, vd, code);
        continue;
      }
      // Crossing coordinates as scalars. The x of a top/bottom crossing and
      // the y of a left/right crossing are the only varying components; the
      // other component of each is a grid line. Each case reads only the
      // crossings it needs, so an edge with no crossing is never divided.
      const Ty = py(j);
      const By = py(j + 1);
      const Lx = px(i);
      const Rx = px(i + 1);
      switch (code) {
        case 1: emit(Lx, yLy(j, va, vd), xTx(i, va, vb), Ty); break;
        case 2: emit(xTx(i, va, vb), Ty, Rx, yLy(j, vb, vc)); break;
        case 3: emit(Lx, yLy(j, va, vd), Rx, yLy(j, vb, vc)); break;
        case 4: emit(Rx, yLy(j, vb, vc), xTx(i, vd, vc), By); break;
        case 5: {
          // Saddle: the cell-centre average decides which diagonal connects.
          const centre = (va + vb + vc + vd) / 4 >= lvl;
          if (centre) { emit(Rx, yLy(j, vb, vc), xTx(i, va, vb), Ty); emit(Lx, yLy(j, va, vd), xTx(i, vd, vc), By); }
          else { emit(Lx, yLy(j, va, vd), xTx(i, va, vb), Ty); emit(Rx, yLy(j, vb, vc), xTx(i, vd, vc), By); }
          break;
        }
        case 6: emit(xTx(i, va, vb), Ty, xTx(i, vd, vc), By); break;
        case 7: emit(Lx, yLy(j, va, vd), xTx(i, vd, vc), By); break;
        case 8: emit(xTx(i, vd, vc), By, Lx, yLy(j, va, vd)); break;
        case 9: emit(xTx(i, vd, vc), By, xTx(i, va, vb), Ty); break;
        case 10: {
          const centre = (va + vb + vc + vd) / 4 >= lvl;
          if (centre) { emit(xTx(i, va, vb), Ty, Lx, yLy(j, va, vd)); emit(xTx(i, vd, vc), By, Rx, yLy(j, vb, vc)); }
          else { emit(xTx(i, va, vb), Ty, Rx, yLy(j, vb, vc)); emit(xTx(i, vd, vc), By, Lx, yLy(j, va, vd)); }
          break;
        }
        case 11: emit(xTx(i, vd, vc), By, Rx, yLy(j, vb, vc)); break;
        case 12: emit(Rx, yLy(j, vb, vc), Lx, yLy(j, va, vd)); break;
        case 13: emit(Rx, yLy(j, vb, vc), xTx(i, va, vb), Ty); break;
        default: emit(xTx(i, va, vb), Ty, Lx, yLy(j, va, vd)); break; // 14
      }
    }
  }
  return { segXY, segWall, segN };
}

/** The cells at the edge of the domain — the pad ring around the lattice
 * and every cell touching an absent sample — in the order `marchSegments`
 * walks the cells with `close`, each as its padded top-left index. They do
 * not depend on the level: `marchSegments(grid, lvl, true, edgeCells(grid))`
 * is the closing runs of any level. */
export function edgeCells(grid: SampledGrid): Int32Array {
  const { absent, pw, gw, gh } = grid;
  const out: number[] = [];
  for (let j = -1; j < gh; j++) {
    for (let i = -1; i < gw; i++) {
      const o = (j + 1) * pw + (i + 1);
      const ring = i < 0 || j < 0 || i >= gw - 1 || j >= gh - 1;
      if (ring || absent[o] === 1 || absent[o + 1] === 1 || absent[o + pw + 1] === 1 || absent[o + pw] === 1) out.push(o);
    }
  }
  return Int32Array.from(out);
}

/** The segments of one buffer that do (`wall` true) or do not lie in an
 * edge cell, as a buffer of their own, in the order they were emitted. */
export function wallSegments({ segXY, segWall, segN }: SegmentBuffer, wall: boolean): SegmentBuffer {
  const keep = wall ? 1 : 0;
  let n = 0;
  for (let k = 0; k < segN; k++) if (segWall[k] === keep) n++;
  const xy = new Float64Array(n * 4);
  let o = 0;
  for (let k = 0; k < segN; k++) {
    if (segWall[k] !== keep) continue;
    xy.set(segXY.subarray(k * 4, k * 4 + 4), o);
    o += 4;
  }
  return { segXY: xy, segWall: new Uint8Array(n).fill(keep), segN: n };
}

/** Join directed segments end-to-start into contours. Orientation is
 * consistent from the case table, so forward extension follows `b → a`
 * matches and backward extension `a → b` matches; iteration is emission
 * order, so the result is deterministic. Each contour's `cut[k]` is the
 * wall mark of its edge from point `k` to the next. */
export function chainSegments({ segXY, segWall, segN }: SegmentBuffer): LevelContour[] {
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
  const out: LevelContour[] = [];
  for (let k = 0; k < segN; k++) {
    if (used[k]) continue;
    used[k] = 1;
    let pts: [number, number][] = [
      [ax(k), ay(k)],
      [bx(k), by(k)],
    ];
    let cut: number[] = [segWall[k]];
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
      cut.push(segWall[n]);
    }
    let closed = endsAtStart();
    if (closed) {
      pts.pop();
    } else {
      // Backward: prepend segments ending where the chain starts. Collected
      // and spliced once — unshift per segment made long open chains
      // quadratic.
      const head: [number, number][] = [];
      const headCut: number[] = [];
      for (;;) {
        const n = take(byEnd, sx, sy);
        if (n === undefined) break;
        used[n] = 1;
        head.push([ax(n), ay(n)]);
        headCut.push(segWall[n]);
        sx = q(ax(n));
        sy = q(ay(n));
      }
      if (head.length > 0) {
        head.reverse();
        pts = head.concat(pts);
        cut = headCut.reverse().concat(cut);
      }
      closed = endsAtStart();
      if (closed) pts.pop();
    }
    out.push({ pts, closed, cut });
  }
  return out;
}
