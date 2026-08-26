/**
 * The deferred renderer: encodes the whole recording into flat typed arrays,
 * makes ONE wasm call, and decodes fragments back. Also G-code / SVG export.
 *
 * The encode and decode halves are exported separately so a host (the studio)
 * can run the wasm call in a Web Worker — the spec requires render off the
 * main thread. `render()` itself stays synchronous for tests and simple use.
 */

import {
  defaultHatchSpacing, defaultStippleMinDist,
  type FillRegion, type FillSpec,
} from './fills.js';
import { paperSize, type PaperChoice } from './paper.js';
import type { PenDef } from './pens.js';
import { flattenPrim, subPrim, type Prim } from './prims.js';
import { lowerShape, makeFrame, paperToUser, type Frame } from './record.js';
import type { FieldFn, VectorFieldFn } from './shapes.js';
import { Rng } from './random.js';
import { getState, type Winding } from './state.js';
import { compileSketch, isSketch, type SketchDef } from './api.js';
import { mm, resolveLen } from './units.js';

/** Build the region object handed to custom fill functions. `contains` and
 * `area` work on a 0.05 mm flattening — plenty for fill generation; the
 * returned primitives are clipped exactly regardless. */
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
  let signedArea = 0;
  for (const poly of polys) {
    for (let i = 0, n = poly.length; i < n; i++) {
      const [x0, y0] = poly[i];
      const [x1, y1] = poly[(i + 1) % n];
      bx0 = Math.min(bx0, x0);
      by0 = Math.min(by0, y0);
      bx1 = Math.max(bx1, x0);
      by1 = Math.max(by1, y0);
      signedArea += (x0 * y1 - x1 * y0) / 2;
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
    area: Math.abs(signedArea),
  };
}

// wasm module bindings, injected by initOcclude.
export interface WasmModule {
  wasm_render(
    prims: Float64Array,
    contours: Uint32Array,
    shapes_u32: Uint32Array,
    shapes_f64: Float64Array,
    mods: Float64Array,
    field_data: Float64Array,
    fill_params: Float64Array,
    clip_list: Uint32Array,
    clips_u32: Uint32Array,
    pens_json: string,
    paper: Float64Array,
    seed: number,
    coarsen: number,
  ): { prims: Float64Array; frags: Float64Array; stats: Float64Array; free?(): void };
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
  /** Stretch the sketch aspect to fill the paper (non-uniform). */
  stretch?: boolean;
  /** Skip the paper clip (useful for tests of raw geometry). */
  unbounded?: boolean;
}

const PRIM_STRIDE = 9;
const FRAG_STRIDE = 6;

/**
 * A fully encoded scene: exactly the arguments of `wasm_render` (all
 * transferable) plus the metadata `decodeRender` needs afterwards.
 */
export interface EncodedScene {
  prims: Float64Array;
  contours: Uint32Array;
  shapesU32: Uint32Array;
  shapesF64: Float64Array;
  /** Modifier tape: [opcode, field_mask, ...params] per instruction. */
  mods: Float64Array;
  /** Concatenated field rasters: [w, h, x0, y0, dx, dy, ...samples] each. */
  fieldData: Float64Array;
  fillParams: Float64Array;
  clipList: Uint32Array;
  clipsU32: Uint32Array;
  pensJson: string;
  paperArr: Float64Array;
  seed: number;
  coarsen: number;
  // decode metadata (plain data)
  pens: PenDef[];
  frame: Frame;
  paper: { w: number; h: number };
}

/** The transferable buffers of a scene (for postMessage transfer lists). */
export function sceneTransferables(s: EncodedScene): ArrayBuffer[] {
  return [
    s.prims.buffer,
    s.contours.buffer,
    s.shapesU32.buffer,
    s.shapesF64.buffer,
    s.mods.buffer,
    s.fieldData.buffer,
    s.fillParams.buffer,
    s.clipList.buffer,
    s.clipsU32.buffer,
    s.paperArr.buffer,
  ] as ArrayBuffer[];
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
 * Encode the recorded sketch for `wasm_render`. Pure and synchronous — no
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
  const fieldData: number[] = [];
  const fillParams: number[] = [];

  // Field rasterisation: sample the user's function over the paper on a
  // coarse mm grid (the core interpolates bilinearly). Sampled in user
  // coordinates, stored per value kind — 'p01' clamps to a probability,
  // 'len' resolves lengths (bare units or Len) to mm. One raster per
  // (function, kind), shared across shapes.
  const toUser = paperToUser(frame);
  const fieldIndex = new Map<FieldFn, { p01?: number; len?: number }>();
  let fieldCount = 0;
  const fieldParam = (
    v: number | import('./units.js').L | FieldFn,
    kind: 'p01' | 'len',
  ): [number, number] => {
    if (typeof v === 'function') {
      let slots = fieldIndex.get(v);
      if (!slots) fieldIndex.set(v, (slots = {}));
      if (slots[kind] === undefined) {
        const step = Math.max(0.5, Math.min(2, Math.max(paperW, paperH) / 128));
        const gw = Math.max(2, Math.ceil(paperW / step) + 1);
        const gh = Math.max(2, Math.ceil(paperH / step) + 1);
        fieldData.push(gw, gh, 0, 0, step, step);
        for (let j = 0; j < gh; j++) {
          for (let i = 0; i < gw; i++) {
            const [ux, uy] = toUser(i * step, j * step);
            const raw = v(ux, uy);
            const val =
              kind === 'p01'
                ? Math.min(1, Math.max(0, Number(raw)))
                : resolveLen(raw, frame.inner);
            // Fail open on a non-finite field sample: draw normally rather
            // than silently deleting or teleporting ink.
            fieldData.push(Number.isFinite(val) ? val : 0);
          }
        }
        slots[kind] = fieldCount++;
      }
      return [slots[kind], 1];
    }
    return [kind === 'len' ? resolveLen(v, frame.inner) : (v as number), 0];
  };
  // Vector fields (deform): two scalar rasters per function — dx then dy —
  // converted from user-unit displacement to paper mm (yUp flips dy).
  const vectorIndex = new Map<VectorFieldFn, [number, number]>();
  const vectorField = (fn: VectorFieldFn): [number, number] => {
    let ids = vectorIndex.get(fn);
    if (ids) return ids;
    const unit = Math.min(frame.inner.innerW, frame.inner.innerH) / 100;
    const ySign = frame.yUp ? -1 : 1;
    // Finer than scalar fields: deform geometry follows this raster
    // directly, and vortex-like fields turn fast near their cores.
    const step = Math.max(0.25, Math.min(1, Math.max(paperW, paperH) / 256));
    const gw = Math.max(2, Math.ceil(paperW / step) + 1);
    const gh = Math.max(2, Math.ceil(paperH / step) + 1);
    for (const axis of [0, 1] as const) {
      fieldData.push(gw, gh, 0, 0, step, step);
      for (let j = 0; j < gh; j++) {
        for (let i = 0; i < gw; i++) {
          const [ux, uy] = toUser(i * step, j * step);
          const d = fn(ux, uy)[axis] * unit;
          fieldData.push(Number.isFinite(d) ? (axis === 1 ? d * ySign : d) : 0);
        }
      }
    }
    ids = [fieldCount, fieldCount + 1];
    fieldCount += 2;
    vectorIndex.set(fn, ids);
    return ids;
  };
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

  // Clip regions first (shapes reference them by index).
  for (const clipRec of state.clips) {
    if (!clipRec.shape.closed) {
      throw new Error('clip() region must be a closed shape');
    }
    const lowered = lowerShape(clipRec.shape, frame);
    const [cStart, cCount] = pushContours(lowered.contours);
    const flags = lowered.convex ? 2 : 0;
    clipsU32.push(cStart, cCount, flags);
  }

  // Shapes.
  for (const shape of state.shapes) {
    const lowered = lowerShape(shape, frame);
    const [cStart, cCount] = pushContours(lowered.contours);
    const geom = shape.geom;
    const winding = geom.kind === 'path' && geom.winding === 'evenodd' ? 4 : 0;
    const flags = (shape.closed ? 1 : 0) | (lowered.convex ? 2 : 0) | winding;
    const strokePen = shape.strokePen !== null ? penIdx(shape.strokePen) + 1 : 0;

    let fillPen = 0;
    let fillKind = 0;
    let fillStart = 0;
    let fillCount = 0;
    if (shape.fillSpec && shape.fillPen) {
      fillPen = penIdx(shape.fillPen) + 1;
      const penDef = pens[fillPen - 1];
      const spec: FillSpec = shape.fillSpec;
      if (spec.type === 'hatch') {
        fillKind = 1;
        fillStart = fillParams.length;
        fillCount = spec.passes.length;
        for (const pass of spec.passes) {
          const spacing = resolveLen(
            pass.spacing ?? defaultHatchSpacing(penDef.width),
            frame.inner,
          );
          fillParams.push(pass.angle, spacing, pass.offset);
        }
      } else if (spec.type === 'stipple') {
        fillKind = 2;
        fillStart = fillParams.length;
        fillCount = 2;
        const minDist = resolveLen(
          spec.minDist ?? defaultStippleMinDist(penDef.width),
          frame.inner,
        );
        fillParams.push(spec.density, minDist);
      } else if (spec.type === 'mask') {
        // Opaque with zero ink: registers the occluder, generates nothing.
        fillKind = 4;
      } else {
        // Custom fill: run the user function now, in paper mm.
        fillKind = 3;
        const winding = geom.kind === 'path' ? geom.winding : 'nonzero';
        const region = makeFillRegion(lowered.contours, winding);
        const fillRng = new Rng(`${state.seedUsed}:fill:${shape.order}`);
        const custom = spec.fn(region, {
          penWidth: penDef.width,
          rnd: () => fillRng.float(),
        });
        fillStart = primCount;
        for (const cp of custom) {
          if (cp.type === 'polyline') {
            for (let i = 0; i + 1 < cp.pts.length; i++) {
              const [x0, y0] = cp.pts[i];
              const [x1, y1] = cp.pts[i + 1];
              encodePrim({ t: 'line', x0, y0, x1, y1 }, primsBuf);
              primCount++;
            }
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
          encodePrim(prim, primsBuf);
          primCount++;
        }
        fillCount = primCount - fillStart;
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
          const [s0, m0] = fieldParam(m.stroke, 'p01');
          const [s1, m1] = fieldParam(m.fill, 'p01');
          modsBuf.push(1, m0 | (m1 << 1), s0, s1);
          break;
        }
        case 'wobble': {
          const [a, ma] = fieldParam(m.amount, 'len');
          modsBuf.push(2, ma, a, resolveLen(m.wavelength ?? mm(25), frame.inner));
          break;
        }
        case 'dash':
          modsBuf.push(
            3, 0,
            resolveLen(m.len, frame.inner),
            resolveLen(m.gap, frame.inner),
          );
          break;
        case 'smooth':
          modsBuf.push(4, 0, Math.max(1, Math.round(m.passes)));
          break;
        case 'roughen': {
          const [a, ma] = fieldParam(m.amount, 'len');
          modsBuf.push(5, ma, a, resolveLen(m.detail ?? mm(1.5), frame.inner));
          break;
        }
        case 'deform': {
          const [dx, dy] = vectorField(m.field);
          modsBuf.push(6, 0b11, dx, dy, resolveLen(m.detail ?? mm(2), frame.inner));
          break;
        }
      }
    }

    shapesU32.push(
      cStart, cCount, flags, strokePen, fillPen, fillKind,
      clipStart, shape.clips.length, fillStart, fillCount,
      modStart, shape.modifiers.length,
    );
    shapesF64.push(shape.zIndex);
  }

  return {
    prims: new Float64Array(primsBuf),
    contours: new Uint32Array(contours),
    shapesU32: new Uint32Array(shapesU32),
    shapesF64: new Float64Array(shapesF64),
    mods: new Float64Array(modsBuf),
    fieldData: new Float64Array(fieldData),
    fillParams: new Float64Array(fillParams),
    clipList: new Uint32Array(clipList),
    clipsU32: new Uint32Array(clipsU32),
    pensJson: pensToJson(pens),
    paperArr: opts.unbounded
      ? new Float64Array(0)
      : new Float64Array([0, 0, paperW, paperH]),
    seed: state.rng.seed32,
    coarsen: opts.coarsen ?? 1,
    pens,
    frame,
    paper: { w: paperW, h: paperH },
  };
}

/** Raw wasm_render output (the transferable half of a worker reply). */
export interface RawRender {
  prims: Float64Array;
  frags: Float64Array;
  stats: Float64Array;
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
      geom: subPrim(outPrims[origin], t0f, t1f),
    });
  }
  const s = raw.stats;
  return {
    frags,
    prims: outPrims,
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

/** Run wasm_render on an encoded scene with a given wasm module instance. */
export function renderEncoded(mod: WasmModule, scene: EncodedScene): RawRender {
  const t0 = performance.now();
  const result = mod.wasm_render(
    scene.prims,
    scene.contours,
    scene.shapesU32,
    scene.shapesF64,
    scene.mods,
    scene.fieldData,
    scene.fillParams,
    scene.clipList,
    scene.clipsU32,
    scene.pensJson,
    scene.paperArr,
    scene.seed,
    scene.coarsen,
  );
  const raw: RawRender = {
    prims: result.prims,
    frags: result.frags,
    stats: result.stats,
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
