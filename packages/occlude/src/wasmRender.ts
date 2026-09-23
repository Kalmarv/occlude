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
 * unreachable` with nothing on the page. No estimate stands in front of
 * the engine — a model that refuses a scene the engine would have held is
 * a cap, and the artist's numbers are the artist's. Two things are done
 * instead: the encoded buffers themselves must fit the address space at
 * all (a scene whose input alone is past 4 GiB is refused by name before
 * the call), and the engine's own death is caught and named with the
 * counts, so the page says what happened instead of going blank.
 */
const WASM_ADDRESS_SPACE = 2 ** 32;
/** shapes_u32 stride (scene.rs). */
const SHAPE_STRIDE = 12;

const n = (v: number): string => v.toLocaleString('en-US');
const ADVICE = 'draw fewer or shorter strokes — a longer resample spacing, a wider fill spacing — or split the drawing across sheets';

/** The bytes the encoded input buffers take: what the engine must copy in
 * before it computes anything. */
export function inputBytes(scene: Pick<EncodedScene, 'prims' | 'contours' | 'shapesU32' | 'shapesF64' | 'mods' | 'fieldData' | 'fieldUses' | 'domainList' | 'clipList' | 'clipsU32'>): number {
  return scene.prims.length * 8 + scene.shapesF64.length * 8 + scene.mods.length * 8 + scene.fieldData.length * 8 + scene.fieldUses.length * 8
    + (scene.contours.length + scene.shapesU32.length + scene.domainList.length + scene.clipList.length + scene.clipsU32.length) * 4;
}

/** Refuse, by name, a scene whose input alone cannot fit the engine's
 * address space — the one case that is known before the call. */
export function checkInputFits(scene: Parameters<typeof inputBytes>[0], points: number, shapes: number): void {
  const bytes = inputBytes(scene);
  if (bytes < WASM_ADDRESS_SPACE) return;
  throw new Error(`render: ${n(points)} points in ${n(shapes)} shapes is ${n(Math.round(bytes / 2 ** 20))} MiB of input, more than the engine's 4 GiB address space; ${ADVICE}`);
}

/** Is this the engine dying for want of memory? wasm32 aborts with
 * `unreachable` when its linear memory cannot grow; a RangeError names the
 * same thing from the JS side. */
function isEngineDeath(e: unknown): boolean {
  if (typeof WebAssembly !== 'undefined' && e instanceof WebAssembly.RuntimeError) return true;
  if (e instanceof RangeError) return true;
  const msg = e instanceof Error ? e.message : String(e);
  return /unreachable|out of memory|memory access out of bounds|Cannot enlarge memory|allocation failed/i.test(msg);
}

/** The engine's death, named with the counts the artist can act on. */
export function engineDeath(e: unknown, points: number, shapes: number, stage: 'prepare' | 'finish'): Error {
  if (!isEngineDeath(e)) return e instanceof Error ? e : new Error(String(e));
  return new Error(`render: the engine ran out of memory at ${n(points)} points in ${n(shapes)} shapes (${stage === 'prepare' ? 'preparing the outlines' : 'clipping and occluding'}; its space is 4 GiB); ${ADVICE}`);
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
  checkInputFits(scene, outlinePoints, shapes);
  let prepared: ReturnType<WasmModule['wasm_prepare']>;
  try {
    prepared = mod.wasm_prepare(
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
  } catch (e) {
    throw engineDeath(e, outlinePoints, shapes, 'prepare');
  }
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
  const allPoints = outlinePoints + supplied.fillPrims.length / PRIM_STRIDE + supplied.fillDots.length / 2;
  let result: ReturnType<WasmModule['wasm_finish']>;
  try {
    result = mod.wasm_finish(
      prepared,
      supplied.fillsIndex,
      supplied.fillChains,
      supplied.fillPrims,
      supplied.fillDots,
    );
  } catch (e) {
    // wasm_finish consumes the handle on Ok and Err alike.
    throw engineDeath(e, allPoints, shapes, 'finish');
  }
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
