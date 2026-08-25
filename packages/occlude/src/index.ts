/**
 * occlude — a drawing library for pen plotters where `fill` means fill.
 *
 * Filled shapes hide what is beneath them; `render()` computes the exact
 * visible strokes and `exportGcode()` emits per-pen G-code.
 */

export {
  sketch, margin, pen, push, clip, setPenLibrary, setPaperHint, getState, bounds,
} from './state.js';
export { rnd, pick, chance, prob, noise, stream } from './state.js';
export type { RandomStream } from './state.js';
export { mapRange as map, normRange as norm, invertRange as invert } from './random.js';
export { circle, ellipse, rect, line, polygon, path, Shape, PathBuilder } from './shapes.js';
export { hatch, crosshatch, stipple, customFill } from './fills.js';
export type { FillSpec, CustomFillFn, CustomPrimitive, FillRegion } from './fills.js';
export { w, h, long, mm, Len } from './units.js';
export type { L } from './units.js';
export { grid, noisyLine } from './layout.js';
export {
  render, exportGcode, exportSvg, exportPng,
  encodeScene, decodeRender, renderEncoded, sceneTransferables,
  pensToJson, profileToJson, tourBudget,
} from './render.js';
export type {
  Fragment,
  RenderResult,
  RenderOptions,
  GcodeJob,
  ExportOptions,
  MachineProfileTS,
  EncodedScene,
  RawRender,
  WasmModule,
} from './render.js';
export { initOcclude } from './init.js';
export { drawFragments, tracePrim } from './draw.js';
export { PAPERS, paperSize } from './paper.js';
export type { Paper, PaperChoice } from './paper.js';
export { DEFAULT_PENS } from './pens.js';
export type { PenDef } from './pens.js';
export type { Prim } from './prims.js';
export { subPrim, evalPrim } from './prims.js';
