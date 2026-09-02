/**
 * Scene dumping, shared by the dump-scene CLI and the golden-fixture
 * sentinel test: run an emitted sketch module, encode it, run pass 1 and
 * the JS fill jobs (exactly what a render does), and return every buffer
 * the native side consumes — the encoder's arguments plus the fills
 * sidecar — as files. `initOcclude` must have run; assets and custom
 * fills are the caller's to preload.
 */

import * as core from 'occlude-core';
import * as occlude from '../src/index.js';
import {
  compileSketch, isSketch, paperSize, setPaperHint, setPenLibrary,
  type PaperChoice, type PenDef, type SketchDef,
} from '../src/index.js';
import { encodeScene, runFillJobs, type WasmModule } from '../src/render.js';

export type DumpFiles = Record<string, Uint8Array | string>;

const bytes = (arr: Float64Array | Uint32Array): Uint8Array =>
  new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);

export function dumpSceneFiles(js: string, opts: { paper: PaperChoice; pens?: PenDef[] }): DumpFiles {
  if (opts.pens) setPenLibrary(opts.pens);
  const size = paperSize(opts.paper);
  setPaperHint(size.w, size.h);
  const module = { exports: {} as Record<string, unknown> };
  const requireShim = (name: string): unknown => {
    if (name === 'occlude') return occlude;
    throw new Error(`sketches can only import from 'occlude' (tried '${name}')`);
  };
  new Function('require', 'exports', 'module', js)(requireShim, module.exports, module);
  const exp = module.exports;
  const def = (isSketch(exp.default)
    ? exp.default
    : Object.values(exp).find(isSketch)) as SketchDef | undefined;
  if (!def) throw new Error('no sketch exported — write `export default sketch({ … }, (toolkit) => tree)`');
  compileSketch(def);
  const scene = encodeScene({ paper: opts.paper });
  const files: DumpFiles = {
    'prims.f64': bytes(scene.prims),
    'contours.u32': bytes(scene.contours),
    'shapes_u32.u32': bytes(scene.shapesU32),
    'shapes_f64.f64': bytes(scene.shapesF64),
    'mods.f64': bytes(scene.mods),
    'fields.f64': bytes(scene.fieldData),
    'field_uses.f64': bytes(scene.fieldUses),
    'domain_list.u32': bytes(scene.domainList),
    'clip_list.u32': bytes(scene.clipList),
    'clips_u32.u32': bytes(scene.clipsU32),
  };
  // Fills sidecar: pass 1 + the fill jobs, exactly what a render does.
  const mod = core as unknown as WasmModule;
  const prepared = mod.wasm_prepare(
    scene.prims, scene.contours, scene.shapesU32, scene.shapesF64, scene.mods,
    scene.fieldData, scene.fieldUses, scene.domainList, scene.clipList, scene.clipsU32,
    scene.pensJson, scene.paperArr, scene.seed, scene.coarsen, 0,
  );
  let supplied;
  try {
    supplied = runFillJobs(scene, prepared.jobs_index, prepared.jobs_contours, prepared.jobs_prims);
  } finally {
    prepared.free?.(); // never passed to finish here, so free on both paths
  }
  files['fills_index.u32'] = bytes(supplied.fillsIndex);
  files['fill_chains.u32'] = bytes(supplied.fillChains);
  files['fill_prims.f64'] = bytes(supplied.fillPrims);
  files['fill_dots.f64'] = bytes(supplied.fillDots);
  files['pens.json'] = scene.pensJson;
  files['meta.json'] = JSON.stringify({
    paper: Array.from(scene.paperArr), seed: scene.seed, coarsen: scene.coarsen,
    shapes: scene.shapesU32.length / 12, primRows: scene.prims.length / 9,
  });
  return files;
}
