/**
 * The deferred renderer: encodes the whole recording into flat typed arrays,
 * runs the TWO-PASS render (wasm pass 1 prepares and exposes surviving
 * outlines; the fill jobs generate ink here in JS; wasm pass 2 clips and
 * occludes it), and decodes fragments back. Also G-code / SVG / PNG export.
 *
 * Everything from sketch execution to `renderEncoded` lives in ONE runtime
 * (the studio's render worker, or node): the encoded scene carries fill
 * closures and never crosses a thread. `decodeRender` is the only half a
 * host runs elsewhere (the studio's main thread decodes posted buffers).
 */

import {
  resolveFill, validateFillParams,
  type CustomPrimitive, type FillCtx, type FillRegion, type FillSpec,
} from './fills.js';
import { paperSize, type PaperChoice } from './paper.js';
import type { PenDef } from './pens.js';
import { flattenPrim, subPrim, type Prim } from './prims.js';
import {
  lowerShape, lowerToUserLoops, makeFrame, unitMm, userToPaperMatrix, type Frame,
} from './record.js';
import { fieldMeta } from './field.js';
import { apply, invert, minScale, mul, scale as mscale, type Mat } from './matrix.js';
import type { FieldAlign, FieldFn, VectorFieldFn } from './shapes.js';
import { Rng } from './random.js';
import { getState, type Winding } from './state.js';
import { compileSketch, isSketch, type SketchDef } from './api.js';
import { mm, resolveLen } from './units.js';

/** Build the region object handed to custom fill functions. `contains`
 * works on a 0.05 mm flattening — plenty for fill generation; the returned
 * primitives are clipped exactly regardless. */
function makeFillRegion(contours: Prim[][], winding: Winding): FillRegion {
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
export interface WasmModule {
  wasm_prepare(
    prims: Float64Array,
    contours: Uint32Array,
    shapes_u32: Uint32Array,
    shapes_f64: Float64Array,
    mods: Float64Array,
    field_data: Float64Array,
    field_uses: Float64Array,
    domain_list: Uint32Array,
    clip_list: Uint32Array,
    clips_u32: Uint32Array,
    pens_json: string,
    paper: Float64Array,
    seed: number,
    coarsen: number,
    debug_ghost: number,
  ): {
    jobs_index: Uint32Array;
    jobs_contours: Uint32Array;
    jobs_prims: Float64Array;
    free?(): void;
  };
  wasm_finish(
    prepared: unknown,
    fills_index: Uint32Array,
    fill_chains: Uint32Array,
    fill_prims: Float64Array,
    fill_dots: Float64Array,
  ): { prims: Float64Array; frags: Float64Array; stats: Float64Array; ghost: Float64Array; free?(): void };
  wasm_export_gcode(
    prims: Float64Array,
    frags: Float64Array,
    pens_json: string,
    profile_json: string,
    tour_budget: number,
  ): string;
  wasm_export_svg(
    prims: Float64Array,
    frags: Float64Array,
    pens_json: string,
    width: number,
    height: number,
    background: string | undefined,
    only_pen: number,
  ): string;
  wasm_export_png(
    prims: Float64Array,
    frags: Float64Array,
    pens_json: string,
    width_mm: number,
    height_mm: number,
    scale: number,
    background: string | undefined,
  ): Uint8Array;
}

let wasm: WasmModule | null = null;

/** Inject the initialised occlude-core wasm module (see occlude-core pkg). */
export function setWasm(mod: WasmModule): void {
  wasm = mod;
}

function requireWasm(): WasmModule {
  if (!wasm) {
    throw new Error('occlude core not initialised — call initOcclude() first');
  }
  return wasm;
}

export interface Fragment {
  origin: number;
  t0: number;
  t1: number;
  /** Pen index into RenderResult.pens. */
  pen: number;
  /** Shape draw index. */
  shape: number;
  dot: boolean;
  /** Bridge connector inserted by the endpoint-join pass. */
  bridge: boolean;
  /** Exact sub-primitive geometry in paper mm. */
  geom: Prim;
}

export interface RenderStats {
  shapesIn: number;
  culledOffPaper: number;
  culledContained: number;
  clean: number;
  fragments: number;
  fillPrims: number;
  /** Wall time of the wasm call, ms. */
  renderMs: number;
}

export interface RenderResult {
  frags: Fragment[];
  /** Full primitive table (outlines + generated fills), paper mm. */
  prims: Prim[];
  /** Debug ghost: post-modified pre-occlusion geometry (wobbles/dashes
   * like the ink). Present only when the render asked for it. */
  ghost?: Prim[];
  pens: PenDef[];
  stats: RenderStats;
  paper: { w: number; h: number };
  frame: Frame;
  /** Raw buffers for export calls. */
  raw: { prims: Float64Array; frags: Float64Array };
}

export interface RenderOptions {
  paper?: PaperChoice | string;
  /** Hatch/stipple coarsening for preview; 1 = exact. */
  coarsen?: number;
  /** Also compute the debug ghost: post-modified pre-occlusion geometry. */
  debugGhost?: boolean;
  /** Stretch the sketch aspect to fill the paper (non-uniform). */
  stretch?: boolean;
  /** Skip the paper clip (useful for tests of raw geometry). */
  unbounded?: boolean;
}

const PRIM_STRIDE = 9;
const FRAG_STRIDE = 6;

/**
 * A fully encoded scene: the arguments of `wasm_prepare` plus the between-
 * pass fill jobs (closures!) and the metadata `decodeRender` needs. It is
 * NOT transferable and must never cross a thread: it belongs to the runtime
 * that executed the sketch, which is the runtime that renders it.
 */
export interface EncodedScene {
  prims: Float64Array;
  contours: Uint32Array;
  shapesU32: Uint32Array;
  shapesF64: Float64Array;
  /** Modifier tape: [opcode, field_mask, ...params] per instruction. */
  mods: Float64Array;
  /** Concatenated field grids in FIELD space: [w, h, x0, y0, dx, dy,
   * ...samples] each — one grid per field, shared by every use. */
  fieldData: Float64Array;
  /** Engine field uses, stride 14 (see scene.rs): grid, paper→field
   * transform, field→paper linear part, magnitude scale, domain refs. */
  fieldUses: Float64Array;
  /** Domain refs: clip-region indices (`within()` bounds ride the clip
   * table as exact paper-mm regions). */
  domainList: Uint32Array;
  clipList: Uint32Array;
  clipsU32: Uint32Array;
  pensJson: string;
  paperArr: Float64Array;
  seed: number;
  /** The seed as the sketch used it (may be a string) — keys per-fill
   * randomness sub-streams. */
  seedUsed: number | string;
  coarsen: number;
  debugGhost: boolean;
  /** Between-pass fill generators, indexed by wasm shape index. Function-
   * bearing: the scene never leaves the runtime that owns the sketch. */
  fillJobs: Map<number, FillJob>;
  // decode metadata (plain data)
  pens: PenDef[];
  frame: Frame;
  paper: { w: number; h: number };
}

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

function encodePrim(p: Prim, out: number[]): void {
  switch (p.t) {
    case 'line':
      out.push(0, p.x0, p.y0, p.x1, p.y1, 0, 0, 0, 0);
      break;
    case 'arc':
      out.push(1, p.cx, p.cy, p.r, p.start, p.sweep, 0, 0, 0);
      break;
    case 'cubic':
      out.push(2, p.x0, p.y0, p.c0x, p.c0y, p.c1x, p.c1y, p.x1, p.y1);
      break;
  }
}

function decodePrim(row: Float64Array | number[], off: number): Prim {
  const k = row[off];
  if (k === 0) {
    return { t: 'line', x0: row[off + 1], y0: row[off + 2], x1: row[off + 3], y1: row[off + 4] };
  }
  if (k === 1) {
    return {
      t: 'arc',
      cx: row[off + 1], cy: row[off + 2], r: row[off + 3],
      start: row[off + 4], sweep: row[off + 5],
    };
  }
  return {
    t: 'cubic',
    x0: row[off + 1], y0: row[off + 2],
    c0x: row[off + 3], c0y: row[off + 4],
    c1x: row[off + 5], c1y: row[off + 6],
    x1: row[off + 7], y1: row[off + 8],
  };
}

export function pensToJson(pens: PenDef[]): string {
  return JSON.stringify(
    pens.map((p) => ({
      name: p.name,
      width: p.width,
      color: p.color,
      feed: p.feed,
      penDown: p.penDown,
      penUp: p.penUp,
      penDelay: p.penDelay,
    })),
  );
}

/**
 * Encode the recorded sketch for the two-pass render. Pure and synchronous — no
 * wasm involved, so it is cheap enough for the main thread while the actual
 * geometry runs in a worker.
 */
export function encodeScene(opts: RenderOptions = {}): EncodedScene {
  const state = getState();
  const paperChoice: PaperChoice =
    typeof opts.paper === 'string' ? { paper: opts.paper } : (opts.paper ?? { paper: 'A4' });
  const { w: paperW, h: paperH } = paperSize(paperChoice);
  const frame = makeFrame(state, paperW, paperH, opts.stretch ?? false);

  // Pens: collect used names in order of first use.
  const penIndex = new Map<string, number>();
  const pens: PenDef[] = [];
  const penIdx = (name: string): number => {
    let i = penIndex.get(name);
    if (i === undefined) {
      const def = state.penLib.get(name);
      if (!def) throw new Error(`unknown pen '${name}'`);
      i = pens.length;
      pens.push(def);
      penIndex.set(name, i);
    }
    return i;
  };

  const primsBuf: number[] = [];
  const contours: number[] = [];
  const shapesU32: number[] = [];
  const shapesF64: number[] = [];
  const modsBuf: number[] = [];
  const clipList: number[] = [];
  const clipsU32: number[] = [];

  let primCount = 0;
  const pushContours = (cs: Prim[][]): [number, number] => {
    const start = contours.length / 2;
    for (const c of cs) {
      contours.push(primCount, c.length);
      for (const p of c) {
        encodePrim(p, primsBuf);
        primCount++;
      }
    }
    return [start, cs.length];
  };

  // ---- Engine field uses (spec rules 10–12) -------------------------
  // A modifier's field param becomes a USE: (grid, per-use sampling
  // transform, domain refs). The transform stays OUTSIDE the grid — one
  // raster per field, shared by every use; a thousand shape-anchored
  // halftone dots are a thousand tiny matrices over one grid. Grids are
  // built after the shape loop, over the union of the uses' pulled-back
  // footprints, at a pitch the largest use needs. `within()` bounds ship
  // as exact clip regions the engine tests before sampling.
  const unit = unitMm(frame);
  const userToPaper = userToPaperMatrix(frame);
  /** paper mm → user units: the paper-aligned sampling transform. */
  const paperToUnits = mul(mscale(1 / unit, 1 / unit), invert(userToPaper));
  type Kind = 'p01' | 'len' | 'vx' | 'vy';
  interface UseRec {
    fn: FieldFn | VectorFieldFn; // the UNBOUNDED field the grid samples
    kind: Kind;
    m: Mat; // paper mm → field units
    domains: number[];
    footprint: { x0: number; y0: number; x1: number; y1: number }; // paper mm
    grid?: number;
  }
  const uses: UseRec[] = [];
  const paperUseIndex = new Map<string, number>();
  const fnIds = new Map<object, number>();
  const idOf = (fn: object): number => {
    let id = fnIds.get(fn);
    if (id === undefined) fnIds.set(fn, (id = fnIds.size));
    return id;
  };
  const paperFootprint = { x0: 0, y0: 0, x1: paperW, y1: paperH };
  /** Push a domain bound as a clip region in paper mm and return its index. */
  const domainCache = new Map<string, number>();
  const pushDomain = (bound: import('./field.js').FieldBound, m: Mat, key: string): number => {
    const cached = domainCache.get(key);
    if (cached !== undefined) return cached;
    const o = bound.shape.opts;
    const loops = lowerToUserLoops(
      bound.shape.geom,
      { translate: o.translate, rotate: o.rotate, scale: o.scale },
      frame,
    );
    // bound space (user mm) → user units → field units → paper mm.
    const toPaper = mul(
      invert(m),
      mul(invert(bound.toBound()), mscale(1 / unit, 1 / unit)),
    );
    const cs: Prim[][] = loops
      .filter((l) => l.length >= 3)
      .map((l) => {
        const pts = l.map(([x, y]) => apply(toPaper, x, y));
        const out: Prim[] = [];
        for (let i = 0; i < pts.length; i++) {
          const [x0, y0] = pts[i];
          const [x1, y1] = pts[(i + 1) % pts.length];
          out.push({ t: 'line', x0, y0, x1, y1 });
        }
        return out;
      });
    const [cStart, cCount] = pushContours(cs);
    const g = bound.shape.geom;
    const winding = g.kind === 'path' && g.winding === 'evenodd' ? 4 : 0;
    clipsU32.push(cStart, cCount, winding);
    const idx = clipsU32.length / 3 - 1;
    domainCache.set(key, idx);
    return idx;
  };
  /** Register a use of `field` at this shape and return its index. */
  const useOf = (
    field: FieldFn | VectorFieldFn,
    kind: Kind,
    align: FieldAlign | undefined,
    anchor: Mat,
    footprint: UseRec['footprint'],
  ): number => {
    const meta = fieldMeta(field);
    const shapeAligned = align === 'shape';
    const key = `${idOf(field)}:${kind}`;
    if (!shapeAligned) {
      const hit = paperUseIndex.get(key);
      if (hit !== undefined) return hit;
    }
    // Shape-aligned: field units = shape-local mm / unit, so the shape's
    // intrinsic centre is field (0, 0) and its axes are the field's.
    const m = shapeAligned ? mul(mscale(1 / unit, 1 / unit), invert(anchor)) : paperToUnits;
    const domains = meta.bounds.map((b, k) =>
      pushDomain(b, m, shapeAligned ? `${key}:${uses.length}:${k}` : `${key}:paper:${k}`),
    );
    const idx = uses.length;
    uses.push({
      fn: meta.unbounded, kind, m, domains,
      footprint: shapeAligned ? footprint : paperFootprint,
    });
    if (!shapeAligned) paperUseIndex.set(key, idx);
    return idx;
  };
  // Clip regions first (shapes reference them by index).
  for (const clipRec of state.clips) {
    if (!clipRec.shape.closed) {
      throw new Error('clip() region must be a closed shape');
    }
    const lowered = lowerShape(clipRec.shape, frame);
    const [cStart, cCount] = pushContours(lowered.contours);
    const cgeom = clipRec.shape.geom;
    const cwinding = cgeom.kind === 'path' && cgeom.winding === 'evenodd' ? 4 : 0;
    const flags = (lowered.convex ? 2 : 0) | cwinding | (clipRec.invert ? 8 : 0);
    clipsU32.push(cStart, cCount, flags);
  }

  // Shapes.
  const fillJobs = new Map<number, FillJob>();
  let shapeIndex = -1;
  for (const shape of state.shapes) {
    shapeIndex++;
    const lowered = lowerShape(shape, frame);
    const [cStart, cCount] = pushContours(lowered.contours);
    const geom = shape.geom;
    const winding = geom.kind === 'path' && geom.winding === 'evenodd' ? 4 : 0;
    const flags = (shape.closed ? 1 : 0) | (lowered.convex ? 2 : 0) | winding;
    const strokePen = shape.strokePen !== null ? penIdx(shape.strokePen) + 1 : 0;
    // Paper footprint of this shape, for shape-aligned grid extents.
    const fp = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (const c of lowered.contours) {
      for (const p of c) {
        for (const [x, y] of flattenPrim(p, 0.5)) {
          fp.x0 = Math.min(fp.x0, x); fp.y0 = Math.min(fp.y0, y);
          fp.x1 = Math.max(fp.x1, x); fp.y1 = Math.max(fp.y1, y);
        }
      }
    }
    if (!Number.isFinite(fp.x0)) Object.assign(fp, paperFootprint);
    const anchor = lowered.anchor;
    const fieldParam = (
      v: number | import('./units.js').L | FieldFn,
      kind: 'p01' | 'len',
      align: FieldAlign | undefined,
    ): [number, number] => {
      if (typeof v === 'function') return [useOf(v, kind, align, anchor, fp), 1];
      return [kind === 'len' ? resolveLen(v, frame.inner) : (v as number), 0];
    };

    let fillPen = 0;
    let fillKind = 0;
    if (shape.fillSpec && shape.fillPen) {
      fillPen = penIdx(shape.fillPen) + 1;
      const penDef = pens[fillPen - 1];
      const spec: FillSpec = shape.fillSpec;
      if (spec.type === 'mask') {
        // Opaque with zero ink: registers the occluder, generates nothing.
        fillKind = 2;
      } else {
        // Pending: ink is generated between the passes, against the FINAL
        // outline pass 1 returns — never here, where deform hasn't run.
        fillKind = 1;
        const winding = geom.kind === 'path' ? geom.winding : 'nonzero';
        const order = shape.order;
        let run: FillJob['run'];
        if (spec.type === 'use' || spec.type === 'asset') {
          const def = spec.type === 'asset' ? spec.def : resolveFill(spec.name);
          const label = spec.type === 'asset' ? 'fill asset' : spec.name;
          if (!def) {
            throw new Error(
              `unknown fill '${label}' — built-ins: hatch, crosshatch, stipple, solid; ` +
                'custom fills are saved on the studio Fills page',
            );
          }
          validateFillParams(label, spec.params);
          const params: Record<string, unknown> = { ...def.params, ...spec.params };
          // Field params are anchored by the runtime (rule 10: `align` on the
          // fill use applies to all of them): the fill receives a sampler in
          // PAPER mm — the region's coordinates — that maps through the use's
          // transform into the field's own coordinates. The fill's OWN
          // geometry anchors through ctx.anchor, the same A.
          const fm = params.align === 'shape' ? mul(mscale(1 / unit, 1 / unit), invert(anchor)) : paperToUnits;
          for (const [k, v] of Object.entries(params)) {
            if (typeof v === 'function') {
              const field = v as (x: number, y: number) => unknown;
              params[k] = (px: number, py: number) => field(...apply(fm, px, py));
            }
          }
          run = (region, ctx) => def.generate(region, params, ctx);
        } else {
          const fn = spec.fn;
          run = (region, ctx) => fn(region, ctx);
        }
        fillJobs.set(shapeIndex, {
          order, penWidth: penDef.width, winding, anchor, run,
        });
      }
    }

    const clipStart = clipList.length;
    for (const c of shape.clips) clipList.push(c);

    // Modifier tape: [opcode, field_mask, ...params] per instruction, in
    // program order. Opcodes: 1 decimate [stroke_p, fill_p]; 2 wobble
    // [amp_mm, wavelength_mm]. A field-valued param sets its mask bit and
    // stores a field index instead of a literal.
    const modStart = modsBuf.length;
    for (const m of shape.modifiers) {
      switch (m.kind) {
        case 'decimate': {
          const [s0, m0] = fieldParam(m.stroke, 'p01', m.align);
          const [s1, m1] = fieldParam(m.fill, 'p01', m.align);
          modsBuf.push(1, m0 | (m1 << 1), s0, s1);
          break;
        }
        case 'wobble': {
          const [a, ma] = fieldParam(m.amount, 'len', m.align);
          modsBuf.push(2, ma, a, resolveLen(m.wavelength ?? mm(25), frame.inner));
          break;
        }
        case 'dash':
          modsBuf.push(
            3, 0,
            resolveLen(m.len, frame.inner),
            resolveLen(m.gap, frame.inner),
            resolveLen(m.offset ?? 0, frame.inner),
          );
          break;
        case 'smooth':
          modsBuf.push(4, 0, Math.max(1, Math.round(m.passes)));
          break;
        case 'roughen': {
          const [a, ma] = fieldParam(m.amount, 'len', m.align);
          modsBuf.push(5, ma, a, resolveLen(m.detail ?? mm(1.5), frame.inner));
          break;
        }
        case 'deform': {
          const dx = useOf(m.field, 'vx', m.align, anchor, fp);
          const dy = useOf(m.field, 'vy', m.align, anchor, fp);
          modsBuf.push(6, 0b11, dx, dy, resolveLen(m.detail ?? mm(2), frame.inner));
          break;
        }
      }
    }

    shapesU32.push(
      cStart, cCount, flags, strokePen, fillPen, fillKind,
      clipStart, shape.clips.length, 0, 0, // reserved (old fill_start/count)
      modStart, shape.modifiers.length,
    );
    shapesF64.push(shape.zIndex);
    // Bridge opt-in: endpoint-join tolerance in paper mm (0 = off).
    shapesF64.push(shape.bridge !== undefined ? resolveLen(shape.bridge, frame.inner) : 0);
  }

  // ---- Build the grids: one per (unbounded field, kind), over the union
  // of its uses' pulled-back footprints, at the pitch the tightest use
  // needs (paper pitch × the smallest scale any use applies) — a shrunken
  // motif never aliases, a magnified one never wastes cells.
  const fieldData: number[] = [];
  const groups = new Map<string, UseRec[]>();
  for (const u of uses) {
    const key = `${idOf(u.fn)}:${u.kind}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(u);
  }
  let gridCount = 0;
  const done = new Set<string>();
  for (const [gkey, group] of groups) {
    if (done.has(gkey)) continue;
    const kind = group[0].kind;
    const vector = kind === 'vx' || kind === 'vy';
    // A vector field's two grids share every use (both components are
    // registered together, same transform, same footprint), so they share
    // the extent and are filled from ONE evaluation per sample — the
    // field is the sketch's own closure and may be expensive.
    const partner = kind === 'vx' ? groups.get(`${idOf(group[0].fn)}:vy`) : undefined;
    if (partner) done.add(`${idOf(group[0].fn)}:vy`);
    // Deform geometry follows its raster directly and vortex-like fields
    // turn fast near their cores: finer than the scalar pitch.
    const paperStep = vector
      ? Math.max(0.25, Math.min(1, Math.max(paperW, paperH) / 256))
      : Math.max(0.5, Math.min(2, Math.max(paperW, paperH) / 128));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    let cell = Infinity;
    for (const u of group) {
      const f = u.footprint;
      for (const [px, py] of [[f.x0, f.y0], [f.x1, f.y0], [f.x0, f.y1], [f.x1, f.y1]]) {
        const [fx, fy] = apply(u.m, px, py);
        x0 = Math.min(x0, fx); y0 = Math.min(y0, fy);
        x1 = Math.max(x1, fx); y1 = Math.max(y1, fy);
      }
      cell = Math.min(cell, paperStep * minScale(u.m));
    }
    if (!Number.isFinite(cell) || !(cell > 0)) cell = paperStep / unit;
    // Cell budget: coarsen rather than allocate without bound.
    const MAX_SAMPLES = 1_048_576;
    const span = Math.max(x1 - x0, y1 - y0, cell);
    const need = ((x1 - x0) / cell + 2) * ((y1 - y0) / cell + 2);
    if (need > MAX_SAMPLES) cell = span / Math.sqrt(MAX_SAMPLES) * 1.05;
    // One cell of margin so Catmull-Rom never clamps on a footprint edge.
    x0 -= cell; y0 -= cell; x1 += cell; y1 += cell;
    const gw = Math.max(2, Math.ceil((x1 - x0) / cell) + 1);
    const gh = Math.max(2, Math.ceil((y1 - y0) / cell) + 1);
    fieldData.push(gw, gh, x0, y0, cell, cell);
    const fn = group[0].fn;
    const second = partner ? new Float64Array(gw * gh) : null;
    for (let j = 0; j < gh; j++) {
      for (let i = 0; i < gw; i++) {
        const raw = fn(x0 + i * cell, y0 + j * cell) as unknown;
        let val: number;
        if (kind === 'p01') val = Math.min(1, Math.max(0, Number(raw)));
        else if (kind === 'len') val = resolveLen(raw as number, frame.inner);
        else val = Number((raw as [number, number])?.[kind === 'vx' ? 0 : 1]);
        // Fail open on a non-finite sample: a hand-rolled NaN is
        // fail-soft; the exact edge is within()'s job, shipped as regions.
        fieldData.push(Number.isFinite(val) ? val : 0);
        if (second) {
          const vy = Number((raw as [number, number])?.[1]);
          second[j * gw + i] = Number.isFinite(vy) ? vy : 0;
        }
      }
    }
    for (const u of group) u.grid = gridCount;
    gridCount++;
    if (partner && second) {
      fieldData.push(gw, gh, x0, y0, cell, cell);
      for (let k = 0; k < second.length; k++) fieldData.push(second[k]);
      for (const u of partner) u.grid = gridCount;
      gridCount++;
    }
  }
  const fieldUses: number[] = [];
  const domainList: number[] = [];
  for (const u of uses) {
    const inv = invert(u.m);
    const ds = domainList.length;
    domainList.push(...u.domains);
    fieldUses.push(
      u.grid ?? 0,
      u.m.a, u.m.b, u.m.c, u.m.d, u.m.e, u.m.f,
      inv.a, inv.b, inv.c, inv.d,
      unit,
      ds, u.domains.length,
    );
  }

  return {
    prims: new Float64Array(primsBuf),
    contours: new Uint32Array(contours),
    shapesU32: new Uint32Array(shapesU32),
    shapesF64: new Float64Array(shapesF64),
    mods: new Float64Array(modsBuf),
    fieldData: new Float64Array(fieldData),
    fieldUses: new Float64Array(fieldUses),
    domainList: new Uint32Array(domainList),
    clipList: new Uint32Array(clipList),
    clipsU32: new Uint32Array(clipsU32),
    pensJson: pensToJson(pens),
    paperArr: opts.unbounded
      ? new Float64Array(0)
      : new Float64Array([0, 0, paperW, paperH]),
    seed: state.rng.seed32,
    seedUsed: state.seedUsed,
    fillJobs,
    coarsen: opts.coarsen ?? 1,
    debugGhost: opts.debugGhost ?? false,
    pens,
    frame,
    paper: { w: paperW, h: paperH },
  };
}

/** Raw render output (the transferable half of a worker reply). */
export interface RawRender {
  prims: Float64Array;
  frags: Float64Array;
  stats: Float64Array;
  ghost?: Float64Array;
  renderMs: number;
}

/** Decode a raw wasm result against its scene into a full RenderResult. */
export function decodeRender(scene: EncodedScene, raw: RawRender): RenderResult {
  const outPrims: Prim[] = [];
  for (let off = 0; off < raw.prims.length; off += PRIM_STRIDE) {
    outPrims.push(decodePrim(raw.prims, off));
  }
  const frags: Fragment[] = [];
  for (let off = 0; off < raw.frags.length; off += FRAG_STRIDE) {
    const origin = raw.frags[off];
    const t0f = raw.frags[off + 1];
    const t1f = raw.frags[off + 2];
    frags.push({
      origin,
      t0: t0f,
      t1: t1f,
      pen: raw.frags[off + 3],
      shape: raw.frags[off + 4],
      dot: (raw.frags[off + 5] & 1) !== 0,
      bridge: (raw.frags[off + 5] & 2) !== 0,
      geom: subPrim(outPrims[origin], t0f, t1f),
    });
  }
  let ghost: Prim[] | undefined;
  if (raw.ghost && raw.ghost.length > 0) {
    ghost = [];
    for (let off = 0; off < raw.ghost.length; off += PRIM_STRIDE) {
      ghost.push(decodePrim(raw.ghost, off));
    }
  }
  const s = raw.stats;
  return {
    frags,
    prims: outPrims,
    ghost,
    pens: scene.pens,
    stats: {
      shapesIn: s[0],
      culledOffPaper: s[1],
      culledContained: s[2],
      clean: s[3],
      fragments: s[4],
      fillPrims: s[5],
      renderMs: raw.renderMs,
    },
    paper: scene.paper,
    frame: scene.frame,
    raw: { prims: raw.prims, frags: raw.frags },
  };
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
  const fillPrims: number[] = [];
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
      rnd: () => fillRng.float(),
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
      fillChains.push(fillPrims.length / PRIM_STRIDE, prims.length);
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
    fillPrims: new Float64Array(fillPrims),
    fillDots: new Float64Array(fillDots),
  };
}

/** Two-pass render on an encoded scene: pass 1 prepares and exposes the
 * surviving outlines, the fill jobs generate ink here in the runtime, and
 * pass 2 clips and occludes it. One synchronous call frame. */
export function renderEncoded(mod: WasmModule, scene: EncodedScene): RawRender {
  const t0 = performance.now();
  const prepared = mod.wasm_prepare(
    scene.prims,
    scene.contours,
    scene.shapesU32,
    scene.shapesF64,
    scene.mods,
    scene.fieldData,
    scene.fieldUses,
    scene.domainList,
    scene.clipList,
    scene.clipsU32,
    scene.pensJson,
    scene.paperArr,
    scene.seed,
    scene.coarsen,
    scene.debugGhost ? 1 : 0,
  );
  // The pass-1 handle owns the whole prepared scene; wasm_finish consumes
  // it (freed on Ok and Err alike), so only the fill-throw path must free
  // it by hand — a bad inline closure must not leak a scene per keystroke.
  // Not `finally`: after finish the handle is consumed and a second free
  // is a null-pointer error.
  let supplied: SuppliedFills;
  try {
    supplied = runFillJobs(
      scene,
      prepared.jobs_index,
      prepared.jobs_contours,
      prepared.jobs_prims,
    );
  } catch (e) {
    prepared.free?.();
    throw e;
  }
  const result = mod.wasm_finish(
    prepared,
    supplied.fillsIndex,
    supplied.fillChains,
    supplied.fillPrims,
    supplied.fillDots,
  );
  const raw: RawRender = {
    prims: result.prims,
    frags: result.frags,
    stats: result.stats,
    ghost: result.ghost,
    renderMs: performance.now() - t0,
  };
  result.free?.();
  return raw;
}

function renderState(opts: RenderOptions = {}): RenderResult {
  const scene = encodeScene(opts);
  return decodeRender(scene, renderEncoded(requireWasm(), scene));
}

/** Render a sketch synchronously on this thread. */
export function render(def: SketchDef, opts?: RenderOptions): RenderResult;
/** Render whatever is currently compiled (host use, after compileSketch). */
export function render(opts?: RenderOptions): RenderResult;
export function render(a?: SketchDef | RenderOptions, b?: RenderOptions): RenderResult {
  if (isSketch(a)) {
    compileSketch(a);
    return renderState(b ?? {});
  }
  return renderState(a ?? {});
}

export interface MachineProfileTS {
  bed?: [number, number];
  resolution?: number;
  travelFeed?: number;
  zMode?: boolean;
  arcSupport?: boolean;
}

export interface GcodeJob {
  pen: number;
  penName: string;
  gcode: string;
  inkMm: number;
  travelMm: number;
  estSeconds: number;
}

export interface ExportOptions extends RenderOptions {
  profile?: MachineProfileTS;
  /** 2-opt iteration budget for the pen tour. */
  optimize?: boolean | number;
}

export function profileToJson(
  p: MachineProfileTS,
  paper: { w: number; h: number },
): string {
  return JSON.stringify({
    bed: p.bed ?? [paper.w, paper.h],
    resolution: p.resolution ?? 0.025,
    travelFeed: p.travelFeed ?? 6000,
    zMode: p.zMode ?? true,
    arcSupport: p.arcSupport ?? false,
  });
}

export function tourBudget(optimize: ExportOptions['optimize']): number {
  return optimize === false ? 0 : typeof optimize === 'number' ? optimize : 200_000;
}

/** Render exactly and export per-pen G-code jobs (synchronous). */
export function exportGcode(def: SketchDef, opts?: ExportOptions): GcodeJob[];
export function exportGcode(opts?: ExportOptions): GcodeJob[];
export function exportGcode(a?: SketchDef | ExportOptions, b?: ExportOptions): GcodeJob[] {
  const opts = isSketch(a) ? (compileSketch(a), b ?? {}) : (a ?? {});
  const mod = requireWasm();
  const result = renderState({ ...opts, coarsen: 1 });
  const json = mod.wasm_export_gcode(
    result.raw.prims,
    result.raw.frags,
    pensToJson(result.pens),
    profileToJson(opts.profile ?? {}, result.paper),
    tourBudget(opts.optimize),
  );
  return JSON.parse(json) as GcodeJob[];
}

export interface SvgOptions extends RenderOptions {
  background?: string;
  /** Restrict to one pen index. */
  onlyPen?: number;
}

export interface PngOptions extends RenderOptions {
  background?: string;
  /** Pixels per millimetre (default 4 ≈ 100 dpi; 12 ≈ 300 dpi). */
  scale?: number;
}

/** Render exactly and rasterise to PNG bytes (synchronous). */
export function exportPng(def: SketchDef, opts?: PngOptions): Uint8Array;
export function exportPng(opts?: PngOptions): Uint8Array;
export function exportPng(a?: SketchDef | PngOptions, b?: PngOptions): Uint8Array {
  const opts = isSketch(a) ? (compileSketch(a), b ?? {}) : (a ?? {});
  const mod = requireWasm();
  const result = renderState({ ...opts, coarsen: 1 });
  return mod.wasm_export_png(
    result.raw.prims,
    result.raw.frags,
    pensToJson(result.pens),
    result.paper.w,
    result.paper.h,
    opts.scale ?? 4,
    opts.background,
  );
}

/** Render exactly and export SVG (exact curves, no flattening; synchronous). */
export function exportSvg(def: SketchDef, opts?: SvgOptions): string;
export function exportSvg(opts?: SvgOptions): string;
export function exportSvg(a?: SketchDef | SvgOptions, b?: SvgOptions): string {
  const opts = isSketch(a) ? (compileSketch(a), b ?? {}) : (a ?? {});
  const mod = requireWasm();
  const result = renderState({ ...opts, coarsen: 1 });
  return mod.wasm_export_svg(
    result.raw.prims,
    result.raw.frags,
    pensToJson(result.pens),
    result.paper.w,
    result.paper.h,
    opts.background,
    opts.onlyPen ?? -1,
  );
}
