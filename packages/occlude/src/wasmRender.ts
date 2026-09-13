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
