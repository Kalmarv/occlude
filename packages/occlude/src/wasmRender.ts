/**
 * The wasm render orchestration: the module interface the core exposes,
 * where the initialised module is kept, and the two-pass render itself —
 * `wasm_prepare` → the runtime fill jobs → `wasm_finish` — with the
 * prepared handle's lifetime rule: finish consumes it (Ok and Err alike),
 * so only the fill-throw path frees it by hand, and the result is freed
 * once after its buffers are taken. `test/fills.test.ts` ("pass-1 handle
 * lifetime") pins every path with a fake module.
 */

import { runFillJobs, type SuppliedFills } from './fillJobs.js';
import type { EncodedScene } from './render.js';
import { PRIM_STRIDE } from './sceneBuffers.js';

/**
 * What the engine can hold. The core is wasm32: one linear memory of at most
 * 4 GiB, and a scene past it dies inside the engine as `RuntimeError:
 * unreachable` with nothing on the page. So the render estimates the
 * engine's peak memory from the buffers before it calls in, and refuses by
 * name.
 *
 * The cost is measured, not derived: the memory the wasm instance had grown
 * to after one render, on a fresh instance per scene (2026-09-23, this
 * build). Scattered single lines, 20 000 to 100 000 shapes of one primitive:
 * 1 110–1 170 bytes a point. Polylines of 1 000 points, 100 000 to 800 000
 * points: 620–720 bytes a point. Hatch fills, 43 000 to 347 000 fill
 * primitives: 620–830. Polylines under 400 opaque discs: 440–470. A
 * primitive costs about 620 bytes and a shape about 560 more, and the
 * budget keeps 15% of the 4 GiB for the growth of the engine's largest
 * vector, which doubles.
 */
export const ENGINE_BYTES_PER_POINT = 620;
export const ENGINE_BYTES_PER_SHAPE = 560;
export const ENGINE_BUDGET_BYTES = 0.85 * 2 ** 32;
/** shapes_u32 stride (scene.rs). */
const SHAPE_STRIDE = 12;

/** The engine's estimated peak for a scene, in bytes. `points` counts every
 * primitive and fill dot the engine will hold. */
export function engineBytes(points: number, shapes: number): number {
  return points * ENGINE_BYTES_PER_POINT + shapes * ENGINE_BYTES_PER_SHAPE;
}

/** Refuse a scene the engine cannot hold, before the call that would die. */
export function checkEngineCapacity(points: number, shapes: number): void {
  if (engineBytes(points, shapes) <= ENGINE_BUDGET_BYTES) return;
  const most = Math.max(0, Math.floor((ENGINE_BUDGET_BYTES - shapes * ENGINE_BYTES_PER_SHAPE) / ENGINE_BYTES_PER_POINT));
  const n = (v: number): string => v.toLocaleString('en-US');
  throw new Error(
    `render: ${n(points)} points is more than the engine can hold (about ${n(most)} in ${n(shapes)} shapes); ` +
      'draw fewer or shorter strokes — a longer resample spacing, a wider fill spacing — or split the drawing across sheets',
  );
}

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
    tour_budget: number,
  ): string;
  wasm_plan(prims: Float64Array, frags: Float64Array, pens_json: string, tour_budget: number, bridge_gap: number): Float64Array;
  wasm_plan_svg(
    plan: Float64Array,
    pens_json: string,
    width: number,
    height: number,
    background: string | undefined,
    only_pen: number,
    from: number,
    to: number,
  ): string;
  wasm_plan_gcode(plan: Float64Array, pens_json: string, profile_json: string, from: number, to: number): string;
  wasm_plan_toolpath(plan: Float64Array, tolerance: number, from: number, to: number): Float64Array;
  wasm_plan_png(
    plan: Float64Array, pens_json: string, width_mm: number, height_mm: number,
    scale: number, background: string | undefined, from: number, to: number,
  ): Uint8Array;
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

/** @internal The initialised module, or a clear error. */
export function requireWasm(): WasmModule {
  if (!wasm) {
    throw new Error('occlude core not initialised — call initOcclude() first');
  }
  return wasm;
}

/** Raw render output (the transferable half of a worker reply). */
export interface RawRender {
  prims: Float64Array;
  frags: Float64Array;
  stats: Float64Array;
  ghost?: Float64Array;
  renderMs: number;
}

/** Two-pass render on an encoded scene: pass 1 prepares and exposes the
 * surviving outlines, the fill jobs generate ink here in the runtime, and
 * pass 2 clips and occludes it. One synchronous call frame. */
export function renderEncoded(mod: WasmModule, scene: EncodedScene): RawRender {
  const t0 = performance.now();
  const shapes = scene.shapesU32.length / SHAPE_STRIDE;
  const outlinePoints = scene.prims.length / PRIM_STRIDE;
  checkEngineCapacity(outlinePoints, shapes);
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
    // The fills are ink the outline count did not know about: judge the
    // whole scene again before pass 2 takes it.
    checkEngineCapacity(outlinePoints + supplied.fillPrims.length / PRIM_STRIDE + supplied.fillDots.length / 2, shapes);
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
