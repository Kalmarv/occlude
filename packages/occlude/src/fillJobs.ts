/**
 * The runtime fill jobs: the ink a filled shape's fill generator produces
 * between the two wasm passes, against the FINAL outline pass 1 returns.
 * `FillJob` is what the scene encoder records per filled shape (a closure
 * — the scene never crosses a thread); `runFillJobs` runs them and packs
 * the supplied-ink buffers pass 2 consumes. Randomness is a seeded
 * sub-stream keyed by the shape's draw order.
 */

import { flattenPrim, type Prim } from './prims.js';
import type { CustomPrimitive, FillCtx, FillRegion } from './fills.js';
import type { Mat } from './matrix.js';
import { Rng } from './random.js';
import type { Winding } from './execution.js';
import { resolveLen } from './units.js';
import { PRIM_STRIDE, PrimSink, decodePrim, encodePrim } from './sceneBuffers.js';
import type { EncodedScene } from './render.js';

/** Build the region object handed to custom fill functions. `contains`
 * works on a 0.05 mm flattening — plenty for fill generation; the returned
 * primitives are clipped exactly regardless. */
export function makeFillRegion(contours: Prim[][], winding: Winding): FillRegion {
  const polys: [number, number][][] = contours.map((c) => {
    const pts: [number, number][] = [];
    for (const p of c) {
      const fp = flattenPrim(p, 0.05);
      for (let i = pts.length > 0 ? 1 : 0; i < fp.length; i++) pts.push(fp[i]);
    }
    return pts;
  });
  let bx0 = Infinity;
  let by0 = Infinity;
  let bx1 = -Infinity;
  let by1 = -Infinity;
  for (const poly of polys) {
    for (const [x0, y0] of poly) {
      bx0 = Math.min(bx0, x0);
      by0 = Math.min(by0, y0);
      bx1 = Math.max(bx1, x0);
      by1 = Math.max(by1, y0);
    }
  }
  const contains = (x: number, y: number): boolean => {
    let windingNum = 0;
    let crossings = 0;
    for (const poly of polys) {
      for (let i = 0, n = poly.length; i < n; i++) {
        const [x0, y0] = poly[i];
        const [x1, y1] = poly[(i + 1) % n];
        const spans = y0 <= y ? y1 > y : y1 <= y;
        if (!spans) continue;
        const xi = x0 + ((y - y0) / (y1 - y0)) * (x1 - x0);
        if (xi > x) {
          crossings++;
          windingNum += y1 > y0 ? 1 : -1;
        }
      }
    }
    return winding === 'evenodd' ? crossings % 2 === 1 : windingNum !== 0;
  };
  return {
    bbox: { x: bx0, y: by0, w: bx1 - bx0, h: by1 - by0 },
    path: contours,
    contains,
  };
}

// wasm module bindings, injected by initOcclude.
/** One shape's between-pass fill: run against the FINAL outline pass 1
 * returns. `order` keys the seeded sub-stream (draw order, as always). */
export interface FillJob {
  order: number;
  penWidth: number;
  winding: Winding;
  /** The shape anchor A = G ∘ C compiled to paper (shape-local mm → paper
   * mm): identity-plus-centre for coordinate-placed shapes, so a shape-
   * aligned texture turns only when its motif does. */
  anchor: Mat;
  run(region: FillRegion, ctx: FillCtx): CustomPrimitive[];
}

/** The supplied-ink buffers one render's fill jobs produced — also the
 * dump-scene sidecar format. Strides are documented at the top of
 * scene.rs: fills_index 5 [shape, chain_start, chain_count, dot_start,
 * dot_count]; fill_chains 2 [prim_start, prim_count]. A chain is one
 * connected pen stroke — the nib rule judges it whole. */
export interface SuppliedFills {
  fillsIndex: Uint32Array;
  fillChains: Uint32Array;
  fillPrims: Float64Array;
  fillDots: Float64Array;
}

/** Run the between-pass fill jobs against pass 1's outlines. Exposed so
 * dump-scene can persist the sidecar the native replay consumes. */
export function runFillJobs(
  scene: EncodedScene,
  jobsIndex: Uint32Array,
  jobsContours: Uint32Array,
  jobsPrims: Float64Array,
): SuppliedFills {
  const fillsIndex: number[] = [];
  const fillChains: number[] = [];
  const fillPrims = new PrimSink();
  const fillDots: number[] = [];
  for (let j = 0; j + 2 < jobsIndex.length; j += 3) {
    const shapeIdx = jobsIndex[j];
    const cStart = jobsIndex[j + 1];
    const cCount = jobsIndex[j + 2];
    const job = scene.fillJobs.get(shapeIdx);
    if (!job) continue;
    // Decode the FINAL outline (post-deform, post-cull) into contours.
    const contours: Prim[][] = [];
    for (let c = cStart; c < cStart + cCount; c++) {
      const ps = jobsContours[c * 2];
      const pc = jobsContours[c * 2 + 1];
      const contour: Prim[] = [];
      for (let r = ps; r < ps + pc; r++) {
        contour.push(decodePrim(jobsPrims, r * PRIM_STRIDE));
      }
      contours.push(contour);
    }
    const region = makeFillRegion(contours, job.winding);
    const fillRng = new Rng(`${scene.seedUsed}:fill:${job.order}`);
    const a = job.anchor;
    const ctx: FillCtx = {
      penWidth: job.penWidth,
      rnd: fillRng.floatFn(),
      coarsen: scene.coarsen,
      len: (l) => resolveLen(l, scene.frame.inner),
      anchor: { ...a, rotation: (Math.atan2(a.b, a.a) * 180) / Math.PI },
    };
    const marks = job.run(region, ctx);
    const chainStart = fillChains.length / 2;
    const dotStart = fillDots.length / 2;
    // One chain per mark: a polyline is a connected run of lines (one pen
    // stroke, judged whole by the nib rule); any other primitive is a
    // chain of one.
    const pushChain = (prims: Prim[]): void => {
      fillChains.push(fillPrims.n / PRIM_STRIDE, prims.length);
      for (const p of prims) encodePrim(p, fillPrims);
    };
    for (const cp of marks) {
      if (cp.type === 'dot') {
        fillDots.push(cp.x, cp.y);
        continue;
      }
      if (cp.type === 'polyline') {
        const lines: Prim[] = [];
        for (let i = 0; i + 1 < cp.pts.length; i++) {
          const [x0, y0] = cp.pts[i];
          const [x1, y1] = cp.pts[i + 1];
          lines.push({ t: 'line', x0, y0, x1, y1 });
        }
        if (lines.length > 0) pushChain(lines);
        continue;
      }
      const prim: Prim =
        cp.type === 'line'
          ? { t: 'line', x0: cp.x1, y0: cp.y1, x1: cp.x2, y1: cp.y2 }
          : cp.type === 'arc'
            ? { t: 'arc', cx: cp.cx, cy: cp.cy, r: cp.r, start: cp.start, sweep: cp.sweep }
            : {
                t: 'cubic',
                x0: cp.x1, y0: cp.y1,
                c0x: cp.cx1, c0y: cp.cy1,
                c1x: cp.cx2, c1y: cp.cy2,
                x1: cp.x2, y1: cp.y2,
              };
      pushChain([prim]);
    }
    fillsIndex.push(
      shapeIdx,
      chainStart,
      fillChains.length / 2 - chainStart,
      dotStart,
      fillDots.length / 2 - dotStart,
    );
  }
  return {
    fillsIndex: new Uint32Array(fillsIndex),
    fillChains: new Uint32Array(fillChains),
    fillPrims: fillPrims.view(),
    fillDots: new Float64Array(fillDots),
  };
}
