import type { SceneCompute3 } from './three/scene.js';
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

import { bridgeMm, decodePlanBuffer, encodePlanBuffer, makePlan, parseToolpath, planValue, resolveDraw, resolvePlanOptions, selectAll, type DrawRequest, type DrawTiming, type DrawingPlan, type FlatChain, type PlanOptions, type PlanSelection, type PlanSettings } from './plan.js';
import type { EstimateOpts, PenTiming } from './motion.js';
import { resolveFill, fillParamsUsable, checkFillParams, isNativeFill, type FillSpec } from './fills.js';
import { paperSize, type PaperChoice } from './paper.js';
import type { PenDef } from './pens.js';
import { flattenPrim, subPrim, SNAP_GRID, type Prim } from './prims.js';
import { PRIM_STRIDE, FRAG_STRIDE, PrimSink, encodePrim, decodePrim } from './sceneBuffers.js';
import { buildFieldGrids, paperStep, type FieldKind, type FieldUse } from './fieldGrid.js';
import type { FillJob } from './fillJobs.js';
import { renderEncoded, requireWasm, type RawRender, type WasmModule } from './wasmRender.js';
import { shadeChains, type ShadeFrame, type ShaderValue } from './shader.js';

// The render pipeline this module was one file with, re-exported so its
// importers (tools, tests, the studio worker) keep one door: the wasm
// orchestration (wasmRender.ts), the runtime fill jobs (fillJobs.ts).
export { setWasm, renderEncoded } from './wasmRender.js';
export type { WasmModule, RawRender } from './wasmRender.js';
export { runFillJobs } from './fillJobs.js';
export type { FillJob, SuppliedFills } from './fillJobs.js';
import {
  frameMaps, lowerShape, sheetFrame, lowerToUserLoops, makeFrame, unitMm, userToPaperMatrix, type Frame,
} from './record.js';
import { fieldMeta } from './field.js';
import { apply, invert, mul, scale as mscale, translate as mtranslate, type Mat } from './matrix.js';
import { fromSheet, type Space } from './space.js';
import type { FieldAlign, FieldFn, LengthFn, VectorFieldFn } from './shapes.js';
import { Execution, type ExecutionInputs, type PaperSpec } from './execution.js';
import { compileSketch, compileSketchAsync, isSketch, isSketchAsync, type SketchDef, type AsyncSketchDef } from './api.js';
import { mm, resolveLen, type L } from './units.js';

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
  contour?: { components: number; levels: number; contours: number; connectors: number; connectorTests: number; residualPatches: number; fallbacks: number; validationSplits: number; fallbackThin: number; fallbackBudget: number; fallbackUnstable: number; geometryRefinements: number };
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
  /** The sheet the run resolved: size in mm and, when the sketch or the
   * host's paper declared one, the stock colour the preview and exports
   * paint under the ink by default. */
  paper: PaperSpec;
  frame: Frame;
  /** Raw buffers for export calls. */
  raw: { prims: Float64Array; frags: Float64Array };
  /** The sketch's own path optimization (`t.plan`) and the part of the
   * plan it asks to draw (`t.draw`) — exports and the studio honour them. */
  plan?: PlanOptions;
  draw?: DrawRequest;
}

/** What a headless entry point (`render`, `exportSvg` …) needs beyond the
 * sketch: the paper choice, and optionally the rest of the run's inputs —
 * the captured pen library, the seed for an open-seeded sketch, assets,
 * fills. Every field is explicit; nothing is read from a session. */
export interface RenderOptions extends Omit<ExecutionInputs, 'paper'> {
  /** A named paper, a `{ paper, landscape }` choice, or the sheet itself
   * (`{ w, h }` mm — so a tool's `ExecutionInputs` spread straight in). */
  paper?: PaperChoice | string | PaperSpec;
  /** Hatch/stipple coarsening for preview; 1 = exact. */
  coarsen?: number;
  /** Also compute the debug ghost: post-modified pre-occlusion geometry. */
  debugGhost?: boolean;
  /** Stretch the sketch aspect to fill the paper (non-uniform). */
  stretch?: boolean;
  /** Skip the paper clip (useful for tests of raw geometry). */
  unbounded?: boolean;
}


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
  /** Stride 3 normally; stride 5 with source selections appends tape start (-1 absent), count. */
  shapesF64: Float64Array;
  /** Modifier instructions plus source-range pairs referenced by shapesF64. */
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
  paper: PaperSpec;
  /** The sketch's own `t.plan({...})` and `t.draw({...})`, if any. */
  plan?: PlanOptions;
  draw?: DrawRequest;
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

function renderPaper(opts: RenderOptions): PaperSpec {
  const p = opts.paper;
  if (p && typeof p === 'object' && 'w' in p && 'h' in p) return { ...p };
  return paperSize(typeof p === 'string' ? { paper: p } : (p ?? { paper: 'A4' }));
}

/**
 * Encode the recorded sketch for the two-pass render. Pure and synchronous — no
 * wasm involved, so it is cheap enough for the main thread while the actual
 * geometry runs in a worker.
 */
export function encodeScene(exec: Execution, opts: RenderOptions = {}): EncodedScene {
  const state = exec;
  const { w: paperW, h: paperH } = exec.paper;
  const frame = makeFrame(state, paperW, paperH, opts.stretch ?? false);

  // Pens: collect used names in order of first use.
  const penIndex = new Map<string, number>();
  const pens: PenDef[] = [];
  const penIdx = (name: string): number => {
    let i = penIndex.get(name);
    if (i === undefined) {
      const def = state.pens.get(name);
      if (!def) throw new Error(`unknown pen '${name}' — available: ${[...state.pens.keys()].join(', ')}`);
      i = pens.length;
      pens.push(def);
      penIndex.set(name, i);
    }
    return i;
  };

  const primsBuf = new PrimSink();
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
  // ---- Fields in a curved space ---------------------------------------
  // A field is written in SKETCH coordinates and the ink is projected, so
  // the engine reads a field at the sketch point under each paper sample —
  // not at the chart point, which is a different place everywhere but the
  // centre. A READING pairs the two directions: `pull` takes a paper point
  // to the field's own coordinates (sheet → `fromSheet` → the field), and
  // `push` takes a field point to the paper (the field → the space →
  // `project`), which is how a `within()` bound lands where it is drawn.
  // The flat plane has no reading and runs the affine path below, byte for
  // byte.
  const space: Space | null = frame.space !== undefined && frame.space.kind !== 'euclidean' ? frame.space : null;
  type Reading = { pull: (px: number, py: number) => [number, number]; push: (fx: number, fy: number) => [number, number] };
  /** The space lives in the sketch's own coordinates, and the origin/yUp
   * convention stands between the projected picture and the paper
   * (`sheetFrame`). The default frame's convention is the identity; its
   * space points pass through it in mm, the arithmetic its fields have
   * always been read with. */
  const turn = sheetFrame(frame);
  const userToDrawable = mul(mtranslate(-frame.offsetX, -frame.offsetY), userToPaper);
  const drawableToUser = invert(userToDrawable);
  /** A paper point → the space point drawn there, or a non-finite pair
   * where the sheet shows no place of the space. */
  const sketchUnder = (sp: Space, px: number, py: number): [number, number] => {
    const [sx, sy] = turn ? apply(turn.fromPaper, px, py) : [px - frame.offsetX, py - frame.offsetY];
    const q = fromSheet(sp, [sx / unit, sy / unit]);
    return [q[0], q[1]];
  };
  /** A space point → paper mm, through the projection. */
  const paperOver = (sp: Space, x: number, y: number): [number, number] => {
    const q = sp.project([x, y]);
    return turn ? apply(turn.toPaper, q[0] * unit, q[1] * unit) : [q[0] * unit + frame.offsetX, q[1] * unit + frame.offsetY];
  };
  const NONE: [number, number] = [NaN, NaN];
  /** Paper-aligned: the field's coordinates are the sketch's own (user
   * units, which the origin/yUp convention carries to the space's). */
  const paperReading: Reading | null = space && {
    pull: (px, py) => {
      const [x, y] = sketchUnder(space, px, py);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return NONE;
      if (turn) return [x, y];
      const [ux, uy] = apply(drawableToUser, x * unit, y * unit);
      return [ux / unit, uy / unit];
    },
    push: (fx, fy) => {
      if (turn) return paperOver(space, fx, fy);
      const [dx, dy] = apply(userToDrawable, fx * unit, fy * unit);
      return paperOver(space, dx / unit, dy / unit);
    },
  };
  /** Shape-aligned: the shape's anchor gives an ORIGIN — its intrinsic
   * centre, as a sketch point — and a linear part, its rotation and scale.
   * A field point is an offset from the origin in the shape's own axes, and
   * an offset is a step in the space: the field is read at
   * `linear⁻¹ · log(origin, p)`, and a field point goes back out with
   * `exp`. The flat plane's `log` is subtraction, which is the affine
   * anchor it has always been. One reading per anchor, so a shape's vector
   * field shares one grid for its two components. */
  const shapeReadings = new Map<Mat, Reading>();
  const shapeReading = (sp: Space, anchor: Mat): Reading => {
    let r = shapeReadings.get(anchor);
    if (r) return r;
    const origin = sketchUnder(sp, anchor.e, anchor.f);
    // The anchor's linear part carries the origin/yUp convention, and a step
    // of the space is in the sketch's coordinates, before it: the offset is
    // read through the convention's own linear part first.
    const convention: Mat | null = turn && { ...turn.toPaper, e: 0, f: 0 };
    const lin: Mat = { a: anchor.a, b: anchor.b, c: anchor.c, d: anchor.d, e: 0, f: 0 };
    const toSpace = convention ? mul(invert(convention), lin) : lin;
    const linInv = invert(toSpace);
    const placed = Number.isFinite(origin[0]) && Number.isFinite(origin[1]);
    r = {
      pull: (px, py) => {
        const [x, y] = sketchUnder(sp, px, py);
        if (!placed || !Number.isFinite(x) || !Number.isFinite(y)) return NONE;
        const v = sp.log(origin, [x, y]);
        return apply(linInv, v[0], v[1]);
      },
      push: (fx, fy) => {
        if (!placed) return NONE;
        const [vx, vy] = apply(toSpace, fx, fy);
        const p = sp.exp(origin, [vx, vy]);
        return paperOver(sp, p[0], p[1]);
      },
    };
    shapeReadings.set(anchor, r);
    return r;
  };
  const readingOf = (align: FieldAlign | undefined, anchor: Mat): Reading | null =>
    space === null ? null : align === 'shape' ? shapeReading(space, anchor) : paperReading;
  type Kind = FieldKind;
  type UseRec = FieldUse;
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
  const pushDomain = (bound: import('./field.js').FieldBound, m: Mat, key: string, reading: Reading | null): number => {
    const cached = domainCache.get(key);
    if (cached !== undefined) return cached;
    const o = bound.shape.opts;
    // In a curved frame this is the ink door's own lowering: the bound's
    // outline placed in the space and sampled where the projection bends it.
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
    // Curved: bound space → field units by the same affine, then out
    // through the space and the projection with the reading's `push`. A
    // point the sheet has no place for (the far hemisphere) drops, and the
    // run's two ends are joined straight — best effort: the clip then
    // follows the chord across the part of the bound that is not drawn.
    const toField = mul(invert(bound.toBound()), mscale(1 / unit, 1 / unit));
    const place = (l: [number, number][]): [number, number][] => {
      if (!reading) return l.map(([x, y]) => apply(toPaper, x, y));
      const out: [number, number][] = [];
      for (const [x, y] of l) {
        const [fx, fy] = apply(toField, x, y);
        const q = reading.push(fx, fy);
        if (Number.isFinite(q[0]) && Number.isFinite(q[1])) out.push(q);
      }
      return out;
    };
    const cs: Prim[][] = loops
      .map(place)
      .filter((pts) => pts.length >= 3)
      .map((pts) => {
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
    const winding = (g.kind === 'path' || g.kind === 'area') && g.winding === 'evenodd' ? 4 : 0;
    clipsU32.push(cStart, cCount, winding);
    const idx = clipsU32.length / 3 - 1;
    domainCache.set(key, idx);
    return idx;
  };
  /** A modifier's `step` in paper mm, or undefined for the paper default.
   * A step that is not a positive finite length has no lattice. */
  const gridStep = (step: L | undefined, word: string): number | undefined => {
    if (step === undefined) return undefined;
    const v = resolveLen(step, frame.inner);
    if (!Number.isFinite(v) || !(v > 0)) throw new Error(`${word}: step must be a positive finite length, got ${v} mm`);
    return v;
  };
  /** Register a use of `field` at this shape and return its index. The
   * use asks for `step` (paper mm) or, without one, the paper default. */
  const useOf = (
    field: LengthFn | FieldFn | VectorFieldFn,
    kind: Kind,
    align: FieldAlign | undefined,
    anchor: Mat,
    footprint: UseRec['footprint'],
    step: number | undefined,
  ): number => {
    const meta = fieldMeta(field);
    const shapeAligned = align === 'shape';
    const key = `${idOf(field)}:${kind}`;
    const pitch = step ?? paperStep(kind === 'vx' || kind === 'vy', paperW, paperH);
    if (!shapeAligned) {
      const hit = paperUseIndex.get(key);
      if (hit !== undefined) {
        // Shared paper-aligned use: widen the read window to cover this shape
        // too, or its side of the raster gets clipped away; the shared grid
        // takes the tighter of the two steps.
        const f = uses[hit].shapeFp;
        f.x0 = Math.min(f.x0, footprint.x0); f.y0 = Math.min(f.y0, footprint.y0);
        f.x1 = Math.max(f.x1, footprint.x1); f.y1 = Math.max(f.y1, footprint.y1);
        uses[hit].step = Math.min(uses[hit].step, pitch);
        return hit;
      }
    }
    // Shape-aligned: field units = shape-local mm / unit, so the shape's
    // intrinsic centre is field (0, 0) and its axes are the field's.
    const m = shapeAligned ? mul(mscale(1 / unit, 1 / unit), invert(anchor)) : paperToUnits;
    const reading = readingOf(align, anchor);
    const domains = meta.bounds.map((b, k) =>
      pushDomain(b, m, shapeAligned ? `${key}:${uses.length}:${k}` : `${key}:paper:${k}`, reading),
    );
    const idx = uses.length;
    uses.push({
      fn: meta.unbounded, kind, m, domains,
      ...(reading ? { toField: reading.pull } : {}),
      footprint: shapeAligned ? footprint : paperFootprint,
      shapeFp: { ...footprint },
      aligned: shapeAligned,
      step: pitch,
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
    const cwinding = (cgeom.kind === 'path' || cgeom.kind === 'area') && cgeom.winding === 'evenodd' ? 4 : 0;
    const flags = (lowered.convex ? 2 : 0) | cwinding | (clipRec.invert ? 8 : 0);
    clipsU32.push(cStart, cCount, flags);
  }

  // Shapes.
  const fillJobs = new Map<number, FillJob>();
  const sourceRangeProtocol=state.shapes.some(shape=>shape.strokeRanges!==undefined);
  const sourceSeedProtocol=state.shapes.some(shape=>shape.strokeSeed!==undefined);
  let shapeIndex = -1;
  for (const shape of state.shapes) {
    shapeIndex++;
    const lowered = lowerShape(shape, frame);
    const [cStart, cCount] = pushContours(lowered.contours);
    const geom = shape.geom;
    const winding = (geom.kind === 'path' || geom.kind === 'area') && geom.winding === 'evenodd' ? 4 : 0;
    let flags = (shape.closed ? 1 : 0) | (lowered.convex ? 2 : 0) | winding | (shape.preserveStroke || shape.strokeRanges ? 16 : 0);
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
      v: number | import('./units.js').L | LengthFn,
      kind: 'p01' | 'len',
      align: FieldAlign | undefined,
      step: number | undefined,
    ): [number, number] => {
      if (typeof v === 'function') return [useOf(v, kind, align, anchor, fp, step), 1];
      return [kind === 'len' ? resolveLen(v, frame.inner) : (v as number), 0];
    };

    let fillPen = 0;
    let fillKind = 0;
    let nativeSpacing = 0;
    if (shape.fillSpec && shape.fillPen) {
      fillPen = penIdx(shape.fillPen) + 1;
      const penDef = pens[fillPen - 1];
      const spec: FillSpec = shape.fillSpec;
      if (spec.type === 'mask') {
        // Opaque with zero ink: registers the occluder, generates nothing.
        fillKind = 2;
      } else if (spec.type === 'use' && isNativeFill(spec.name)) {
        const unknown = Object.keys(spec.params).filter(k => k !== 'spacing' && k !== 'connectors');
        if (unknown.length) throw new Error(`contour: unsupported parameter '${unknown[0]}'`);
        if (spec.params.connectors !== undefined && typeof spec.params.connectors !== 'boolean') throw new Error('contour: connectors must be a boolean');
        // Shape flag bit 3 opts out; old descriptors retain connected output.
        if (spec.params.connectors === false) flags |= 8;
        const spacing = spec.params.spacing === undefined ? penDef.width * 0.9
          : resolveLen(spec.params.spacing as Parameters<typeof resolveLen>[0], frame.inner);
        nativeSpacing = spacing * (opts.coarsen ?? 1);
        // A spacing that is not a positive length — a mid-edit zero, or a
        // coarsen that swallowed it — has no contours to draw. The shape
        // keeps its opacity and generates nothing, exactly as a mask does,
        // so the outline and everything under it still render.
        fillKind = Number.isFinite(nativeSpacing) && nativeSpacing > 0 ? 3 : 2;
      } else {
        // Pending: ink is generated between the passes, against the FINAL
        // outline pass 1 returns — never here, where deform hasn't run.
        fillKind = 1;
        const winding = geom.kind === 'path' || geom.kind === 'area' ? geom.winding : 'nonzero';
        const order = shape.order;
        // null: this use cannot draw (a degenerate spacing), so the shape
        // falls back to an opaque fill with no ink.
        let run: FillJob['run'] | null;
        if (spec.type === 'use' || spec.type === 'asset') {
          const def = spec.type === 'asset' ? spec.def : resolveFill(spec.name, exec.inputs.fills);
          const label = spec.type === 'asset' ? 'fill asset' : spec.name;
          if (!def) {
            throw new Error(
              `unknown fill '${label}' — built-ins: hatch, crosshatch, stipple, solid; ` +
                'custom fills are saved on the studio Fills page',
            );
          }
          checkFillParams(spec.type === 'asset' ? 'asset' : `'${spec.name}'`, def.params, spec.params);
          const params: Record<string, unknown> = { ...def.params, ...spec.params };
          // Field params are anchored by the runtime (rule 10: `align` on the
          // fill use applies to all of them): the fill receives a sampler in
          // PAPER mm — the region's coordinates — that maps through the use's
          // transform into the field's own coordinates. The fill's OWN
          // geometry anchors through ctx.anchor, the same A.
          const fm = params.align === 'shape' ? mul(mscale(1 / unit, 1 / unit), invert(anchor)) : paperToUnits;
          // In a curved space the sampler reads the field at the sketch
          // point under the paper point, as the engine's grids do.
          const fillReading = readingOf(params.align === 'shape' ? 'shape' : undefined, anchor);
          for (const [k, v] of Object.entries(params)) {
            if (typeof v === 'function') {
              const field = v as (x: number, y: number) => unknown;
              params[k] = fillReading
                ? (px: number, py: number) => field(...fillReading.pull(px, py))
                : (px: number, py: number) => field(...apply(fm, px, py));
            }
          }
          run = fillParamsUsable(spec.params) ? (region, ctx) => def.generate(region, params, ctx) : null;
        } else {
          const fn = spec.fn;
          run = (region, ctx) => fn(region, ctx);
        }
        if (run) fillJobs.set(shapeIndex, { order, penWidth: penDef.width, winding, anchor, run });
        else fillKind = 2;
      }
    }

    const clipStart = clipList.length;
    for (const c of shape.clips) clipList.push(c);

    // Modifier tape: [opcode, field_mask, ...params] per instruction, in
    // program order. Opcodes: 1 decimate [stroke_p, fill_p]; 2 wobble
    // [amp_mm, wavelength_mm]. A field-valued param sets its mask bit and
    // stores a field index instead of a literal.
    const modStart = modsBuf.length;
    // The stack the lowering left for the engine: in a curved space a
    // `smooth` already ran on the flat outline, before the placement.
    const modifiers = lowered.modifiers;
    for (const m of modifiers) {
      switch (m.kind) {
        case 'decimate': {
          const step = gridStep(m.step, 'decimate');
          const [s0, m0] = fieldParam(m.stroke, 'p01', m.align, step);
          const [s1, m1] = fieldParam(m.fill, 'p01', m.align, step);
          modsBuf.push(1, m0 | (m1 << 1), s0, s1);
          break;
        }
        case 'wobble': {
          const [a, ma] = fieldParam(m.amount, 'len', m.align, gridStep(m.step, 'wobble'));
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
          const [a, ma] = fieldParam(m.amount, 'len', m.align, gridStep(m.step, 'roughen'));
          modsBuf.push(5, ma, a, resolveLen(m.detail ?? mm(1.5), frame.inner));
          break;
        }
        case 'deform': {
          const step = gridStep(m.step, 'deform');
          const dx = useOf(m.field, 'vx', m.align, anchor, fp, step);
          const dy = useOf(m.field, 'vy', m.align, anchor, fp, step);
          modsBuf.push(6, 0b11, dx, dy, resolveLen(m.detail ?? mm(2), frame.inner));
          break;
        }
      }
    }

    shapesU32.push(
      cStart, cCount, flags, strokePen, fillPen, fillKind,
      clipStart, shape.clips.length, 0, 0, // reserved (old fill_start/count)
      modStart, modifiers.length,
    );
    shapesF64.push(shape.zIndex);
    // Bridge opt-in: endpoint-join tolerance in paper mm (0 = off).
    shapesF64.push(shape.bridge !== undefined ? resolveLen(shape.bridge, frame.inner) : 0);
    shapesF64.push(nativeSpacing);
    // Optional source selection shares the f64 tape, outside modifier instructions.
    const rangeStart=modsBuf.length;
    if(shape.strokeRanges) {
      if(cCount!==1 || lowered.contours[0].some(p=>p.t!=='line') || shape.fillSpec || modifiers.some(m=>['smooth','roughen','deform'].includes(m.kind)))throw new Error('strokeRanges requires one polyline without fill or pre-stage modifiers');
      const count=lowered.contours[0].length;
      let end=0;
      for(const [a,b] of shape.strokeRanges) {
        if(!Number.isFinite(a)||!Number.isFinite(b)||a<end||a>=b||b>count)throw new Error('strokeRanges must be sorted disjoint intervals within the source polyline');
        modsBuf.push(a,b);end=b;
      }
    }
    if(shape.strokeSeed!==undefined && (!shape.strokeRanges || !Number.isInteger(shape.strokeSeed) || shape.strokeSeed<0 || shape.strokeSeed>0xffffffff))throw new Error('strokeSeed requires source ranges and a u32 key');
    if(sourceRangeProtocol || sourceSeedProtocol)shapesF64.push(shape.strokeRanges ? rangeStart : -1,shape.strokeRanges?.length??0);
    if(sourceSeedProtocol)shapesF64.push(shape.strokeSeed??-1);
  }

  // A shader may answer any pen the sketch declares, not only the pens its
  // shapes drew with: those join the table after the used ones, so every
  // slot the shapes hold is unchanged. A drawing with no shader keeps the
  // table it drew.
  if (state.planOptions?.shader) for (const name of state.declaredPens) penIdx(name);

  const fieldData = buildFieldGrids(uses, idOf, unit, frame.inner);
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
    prims: primsBuf.view(),
    contours: new Uint32Array(contours),
    shapesU32: new Uint32Array(shapesU32),
    shapesF64: new Float64Array(shapesF64),
    mods: new Float64Array(modsBuf),
    fieldData,
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
    paper: exec.paper.color !== undefined ? { w: paperW, h: paperH, color: exec.paper.color } : { w: paperW, h: paperH },
    plan: state.planOptions ? resolvePlanOptions(state.planOptions, frame.inner) : undefined,
    draw: state.drawRequest ?? undefined,
  };
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
      contour: s.length >= 14 ? { components:s[6], levels:s[7], contours:s[8], connectors:s[9], connectorTests:s[10], residualPatches:s[11], fallbacks:s[12], validationSplits:s[13], fallbackThin:s[14]??0, fallbackBudget:s[15]??0, fallbackUnstable:s[16]??0, geometryRefinements:s[17]??0 } : undefined,
      renderMs: raw.renderMs,
    },
    paper: scene.paper,
    frame: scene.frame,
    raw: { prims: raw.prims, frags: raw.frags },
    plan: scene.plan,
    draw: scene.draw,
  };
}

/** The run's inputs from the headless options: the paper choice resolved,
 * the rest passed through. */
function inputsOf(opts: RenderOptions): ExecutionInputs {
  return { paper: renderPaper(opts), library: opts.library, seed: opts.seed, marginPct: opts.marginPct, assets: opts.assets, fills: opts.fills, inspect: opts.inspect };
}

/** The execution an entry point works on: compile the sketch with the
 * options' inputs, or take the one the host compiled. */
function runOf(a: SketchDef | Execution, opts: RenderOptions): Execution {
  if (isSketchAsync(a)) throw new Error('async rendering required; use renderAsync');
  return isSketch(a) ? compileSketch(a, inputsOf(opts)) : a;
}

function renderRun(exec: Execution, opts: RenderOptions): RenderResult {
  const scene = encodeScene(exec, opts);
  return decodeRender(scene, renderEncoded(requireWasm(), scene));
}

/** Render a sketch synchronously on this thread, on the paper (and with
 * the inputs) the options give. */
export function render(def: SketchDef, opts?: RenderOptions): RenderResult;
/** Render an execution the host compiled (`compileSketch`). */
export function render(exec: Execution, opts?: RenderOptions): RenderResult;
export function render(a: SketchDef | Execution, b: RenderOptions = {}): RenderResult {
  return renderRun(runOf(a, b), b);
}

/** Await compilation, then use the same vector renderer as synchronous sketches.
 * WASM initialization remains explicit through initOcclude. */
export async function renderAsync(
  source: SketchDef | AsyncSketchDef | Execution,
  opts: RenderOptions & { signal?: AbortSignal; compute3?: SceneCompute3 } = {},
): Promise<RenderResult> {
  opts.signal?.throwIfAborted();
  const exec = source instanceof Execution ? source : await compileSketchAsync(source, inputsOf(opts), opts);
  opts.signal?.throwIfAborted();
  return renderRun(exec, opts);
}

export interface MachineProfileTS {
  bed?: [number, number];
  resolution?: number;
  travelFeed?: number;
  zMode?: boolean;
  arcSupport?: boolean;
  /** The controller's Y against the paper's (which grows down the sheet
   * from the top-left corner): 'down' writes paper Y as is; 'up' is the
   * standard GRBL frame, Y growing upward from a bottom-left home
   * (y' = bed height - y); 'negative' is a top-left home counting down the
   * sheet (y' = -y; the iDraw H after homing). Arcs follow the frame. */
  yAxis?: YAxis;
  /** The machine's pen heights (Z when `zMode`), one pair for the whole
   * machine; when set they override every pen's own `penUp`/`penDown`. */
  penUp?: number;
  penDown?: number;
}
export type YAxis = 'down' | 'up' | 'negative';

export interface GcodeJob {
  pen: number;
  penName: string;
  gcode: string;
  inkMm: number;
  travelMm: number;
}

export interface ExportOptions extends RenderOptions {
  profile?: MachineProfileTS;
  /** 2-opt iteration budget for the pen tour; the sketch's own `t.plan`
   * is the default. */
  optimize?: boolean | number;
  /** Machine timing, needed only when the sketch draws by minutes or a
   * budget (`t.draw({ minutes | budget })`). */
  timing?: { penOf: (pen: number) => PenTiming | undefined; opts: EstimateOpts };
}

/** The sketch's requested range of its own plan, resolved: exports honour
 * `t.draw` so the same program gives the same ink everywhere. */
function requestedRange(result: RenderResult, opts: ExportOptions, tol: number): { buffer: Float64Array; from: number; to: number } {
  const planOpts: PlanOptions = { ...(result.plan ?? {}), ...(opts.optimize !== undefined ? { optimize: opts.optimize } : {}) };
  const pb = planBuffer(result, planOpts);
  const p = planValue(pb.buffer, pb.settings, '');
  let timing: DrawTiming | undefined;
  if (opts.timing) timing = { flat: planToolpath(p, selectAll(p), tol), penOf: opts.timing.penOf, opts: opts.timing.opts };
  const sel = resolveDraw(p, result.draw, timing).final;
  return { buffer: pb.buffer, from: sel.fromChain, to: sel.toChain };
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
    yAxis: p.yAxis ?? 'down',
    ...(p.penUp !== undefined ? { penUp: p.penUp } : {}),
    ...(p.penDown !== undefined ? { penDown: p.penDown } : {}),
  });
}

export function tourBudget(optimize: ExportOptions['optimize']): number {
  return optimize === false ? 0 : typeof optimize === 'number' ? optimize : 200_000;
}

/** Render exactly and export per-pen G-code jobs (synchronous). */
export function exportGcode(def: SketchDef | Execution, opts: ExportOptions = {}): GcodeJob[] {
  const mod = requireWasm();
  const result = renderRun(runOf(def, opts), { ...opts, coarsen: 1 });
  const profile = opts.profile ?? {};
  const tol = Math.max(0.0001, Math.min(profile.resolution ?? 0.025, result.pens.reduce((t, p) => Math.min(t, p.width / 4), Infinity)));
  const range = requestedRange(result, opts, tol);
  const json = mod.wasm_plan_gcode(range.buffer, pensToJson(result.pens), profileToJson(profile, result.paper), range.from, range.to);
  return JSON.parse(json) as GcodeJob[];
}

export interface SvgOptions extends ExportOptions {
  background?: string;
  /** Restrict to one pen index (an execution filter over the plan). */
  onlyPen?: number;
  /** 2-opt tour budget; the SVG's paths are the plotted chains in plot
   * order (merge → tour → bridge, as the G-code). The sketch's `t.plan`
   * is the default, then `optimize`, then 200 000. */
  tourBudget?: number;
}

export interface PngOptions extends ExportOptions {
  background?: string;
  /** Pixels per millimetre (default 4 ≈ 100 dpi; 12 ≈ 300 dpi). */
  scale?: number;
}

/** Render exactly and rasterise to PNG bytes (synchronous). */
export function exportPng(def: SketchDef | Execution, opts: PngOptions = {}): Uint8Array {
  const mod = requireWasm();
  const result = renderRun(runOf(def, opts), { ...opts, coarsen: 1 });
  const tol = Math.max(0.0001, Math.min(0.025, result.pens.reduce((t, p) => Math.min(t, p.width / 4), Infinity)));
  const range = requestedRange(result, opts, tol);
  return mod.wasm_plan_png(
    range.buffer,
    pensToJson(result.pens),
    result.paper.w,
    result.paper.h,
    opts.scale ?? 4,
    opts.background ?? result.paper.color,
    range.from,
    range.to,
  );
}

// ---- the ordered plan: planned once, exported many ways ----------------------------

/** The bridge gap a pen gets under an option: the resolved number the
 * plan's settings record, so the identity says what was bridged. */
export function bridgeGapFor(pen: PenDef, bridge: PlanOptions['bridge']): number {
  if (bridge === false) return 0;
  if (bridge !== undefined && bridge !== true) return Math.max(0, bridgeMm(bridge));
  return Math.max(pen.width, 0.05) * 0.5;
}

/**
 * Run a shader over plan bytes and give the shaded bytes back.
 *
 * THE one shading call. The studio plans in its worker and the headless
 * exporters plan here, and law 5 says the preview, the export and the
 * machine agree — so both go through this, and neither grows a second
 * copy of the sampling, the cutting or the pen lookup.
 *
 * The tour is already decided when this runs: a program repeats, cuts,
 * drops or re-pens a stroke, and never reorders the drawing. A program
 * that returns `{}` leaves the bytes untouched.
 */
export function applyShader(buffer: Float64Array, shader: ShaderValue, pens: readonly PenDef[], frame: Frame): Float64Array {
  const maps = frameMaps(frame);
  const shade: ShadeFrame = {
    nibOf: (pen: number): number => Math.max(pens[pen]?.width ?? 0, SNAP_GRID),
    resolve: (v: L): number => resolveLen(v, frame.inner),
    penCount: (): number => pens.length,
    nameOf: (pen: number): string => pens[pen]?.name ?? String(pen),
    penOf: (name: string): number => {
      const i = pens.findIndex((p) => p.name === name);
      if (i < 0) throw new Error(`shader: this drawing has no pen '${name}' (it has ${pens.map((p) => `'${p.name}'`).join(', ')}). A shader chooses among the pens the drawing draws with and the pens the sketch declares in its \`pens\`.`);
      return i;
    },
    unit: unitMm(frame),
    toUnits: maps.toUnits,
  };
  return encodePlanBuffer(shadeChains(decodePlanBuffer(buffer), shader.program, shade));
}

/**
 * A plan, re-encoded as the primitive and fragment buffers a preview
 * draws. One fragment per primitive, whole, carrying its chain's pen.
 *
 * This is how the studio can show what the machine will actually draw. The
 * finished PAPER render precedes planning, so it cannot show a shader; the
 * plan is the ink itself. Nothing is flattened on the way — a plan keeps
 * lines, arcs and cubics exactly as the render made them, so a preview of
 * the plan is no coarser than a preview of the paper.
 */
export function planAsBuffers(buffer: Float64Array): { prims: Float64Array<ArrayBuffer>; frags: Float64Array<ArrayBuffer> } {
  const chains = decodePlanBuffer(buffer);
  const sink = new PrimSink();
  const frags: number[] = [];
  let index = 0;
  for (const chain of chains) {
    for (const prim of chain.prims) {
      encodePrim(prim, sink);
      // [origin, t0, t1, pen, shape, flags, run id, run start, run end]
      frags.push(index, 0, 1, chain.pen, 0, chain.dot ? 1 : 0, 0, 0, 0);
      index++;
    }
  }
  // `slice` and `from` both allocate a plain ArrayBuffer, and the type
  // says so: the studio transfers these buffers to the main thread, and a
  // transfer list will not take an ArrayBufferLike.
  return { prims: sink.view().slice() as Float64Array<ArrayBuffer>, frags: Float64Array.from(frags) as Float64Array<ArrayBuffer> };
}

/** Plan a rendered result ONCE (merge → tour → bridge per pen, pen order):
 * the exact plan bytes and the settings that identify them. Feed
 * `makePlan` for the hashed value, then the `plan*` exporters. */
/**
 * The gap the engine is told to bridge: `false` never, a number for every
 * pen, and -1 for "each pen's own half nib".
 */
export const bridgeArg = (bridge: PlanOptions['bridge']): number =>
  bridge === false ? 0 : bridge !== undefined && bridge !== true ? Math.max(0, bridgeMm(bridge)) : -1;

/**
 * THE plan settings — what identifies a plan besides its bytes.
 *
 * Both planners build this: `planBuffer` here, and the studio's worker,
 * which plans on its own thread from a flattened snapshot. They must agree
 * exactly, because the settings go into the plan's hash, and a hash that
 * differs by a rounding is a plan the studio calls stale. One function, so
 * the next field added lands in both.
 */
export function planSettings(
  pens: readonly PenDef[],
  paper: { w: number; h: number },
  opts: PlanOptions,
  engine?: string,
): PlanSettings {
  return {
    tourBudget: tourBudget(opts.optimize),
    pens: pens.map((p) => ({ name: p.name, width: p.width })),
    paper: { w: paper.w, h: paper.h },
    bridgeGapMm: pens.map((p) => bridgeGapFor(p, opts.bridge)),
    ...(engine ? { engine } : {}),
  };
}

export function planBuffer(result: RenderResult, given: PlanOptions = result.plan ?? {}, engine?: string): { buffer: Float64Array; settings: PlanSettings } {
  const opts = resolvePlanOptions(given, result.frame.inner);
  let buffer = requireWasm().wasm_plan(result.raw.prims, result.raw.frags, pensToJson(result.pens), tourBudget(opts.optimize), bridgeArg(opts.bridge));
  if (opts.shader) buffer = applyShader(buffer, opts.shader, result.pens, result.frame);
  return { buffer, settings: planSettings(result.pens, result.paper, opts, engine) };
}

/** THE entry: plan a rendered result once and get the plan as a value —
 * hashed, decoded, ready for `selectChains` & co. and the `plan*`
 * exporters. `plan(render(def))` is the whole story; nothing downstream
 * plans again. Async only because the identity is a SHA-256 digest. */
export async function plan(result: RenderResult, opts: PlanOptions = result.plan ?? {}, engine?: string): Promise<DrawingPlan> {
  const { buffer, settings } = planBuffer(result, opts, engine);
  return makePlan(buffer, settings);
}

const checkSelection = (plan: DrawingPlan, sel: PlanSelection): void => {
  if (sel.sourcePlanHash !== plan.planHash) throw new Error('that selection belongs to another plan');
};

/** SVG of a selection: the same chains, order and native curves the plan
 * holds — no planning happens here. `onlyPen` is an execution filter. */
export function planSvg(plan: DrawingPlan, sel: PlanSelection, pens: PenDef[], opts: { background?: string; onlyPen?: number } = {}): string {
  checkSelection(plan, sel);
  return requireWasm().wasm_plan_svg(plan.buffer, pensToJson(pens), plan.settings.paper.w, plan.settings.paper.h, opts.background, opts.onlyPen ?? -1, sel.fromChain, sel.toChain);
}

/** G-code jobs (one per pen present) of a selection. */
export function planGcode(plan: DrawingPlan, sel: PlanSelection, pens: PenDef[], profile: MachineProfileTS = {}): GcodeJob[] {
  checkSelection(plan, sel);
  return JSON.parse(requireWasm().wasm_plan_gcode(plan.buffer, pensToJson(pens), profileToJson(profile, plan.settings.paper), sel.fromChain, sel.toChain)) as GcodeJob[];
}

/** Sampled chains of a selection at `tolerance` mm, source indices kept. */
export function planToolpath(plan: DrawingPlan, sel: PlanSelection, tolerance: number): FlatChain[] {
  checkSelection(plan, sel);
  return parseToolpath(requireWasm().wasm_plan_toolpath(plan.buffer, tolerance, sel.fromChain, sel.toChain), sel.fromChain);
}

/** Render exactly and export SVG: exact curves, one path per plotted chain
 * (the same merge → tour → bridge as the G-code, so the SVG IS the plot). */
export function exportSvg(def: SketchDef | Execution, opts: SvgOptions = {}): string {
  const mod = requireWasm();
  const result = renderRun(runOf(def, opts), { ...opts, coarsen: 1 });
  const tol = Math.max(0.0001, Math.min(0.025, result.pens.reduce((t, p) => Math.min(t, p.width / 4), Infinity)));
  const range = requestedRange(result, { ...opts, ...(opts.tourBudget !== undefined ? { optimize: opts.tourBudget } : {}) }, tol);
  return mod.wasm_plan_svg(range.buffer, pensToJson(result.pens), result.paper.w, result.paper.h, opts.background ?? result.paper.color, opts.onlyPen ?? -1, range.from, range.to);
}
