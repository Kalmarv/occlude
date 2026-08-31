/**
 * occlude — a drawing library for pen plotters where `fill` means fill.
 *
 * A sketch is a pure function from a toolkit to a tree of shape values:
 *
 *   export default sketch({ aspect: 'square', margin: 6 }, ({ circle, hatch, rnd, bounds }) => {
 *     const b = bounds();
 *     return Array.from({ length: 24 }, () =>
 *       circle(rnd(b.w), rnd(b.h), rnd(6, 22), { fill: hatch(rnd(180)) }));
 *   });
 *
 * Filled/opaque shapes hide what is beneath them; `render()` computes the
 * exact visible strokes and `exportGcode()` emits per-pen G-code.
 *
 * The imperative machinery underneath is internal — this is the only API.
 */

// The declarative API.
export {
  sketch, compileSketch, isSketch,
  circle, ellipse, rect, line, polygon, path, PathValue,
  group, clip, mask, decimate, wobble, modify, dash, smooth, roughen, deform, noiseField,
  times, range,
} from './api.js';
export type {
  SketchDef, SketchConfig, Toolkit, Tree,
  ShapeValue, ShapeOpts, GroupValue, GroupOpts, ClipValue,
} from './api.js';
export type { ModifierValue, FieldFn, VectorFieldFn } from './shapes.js';

// Fills are already pure specs.
export { hatch, crosshatch, stipple, customFill } from './fills.js';
export { svg } from './svgin.js';
export {
  asset, image, scanAssetNames, registerTextAsset, registerImageAsset, clearAssets,
  type ImageSampler, type ImagePlacement, type AssetPixels,
} from './imageAsset.js';
export { label, labelWidth } from './font.js';
export { liveExampleToJs } from './docsExamples.js';
export type { LabelOpts } from './font.js';
export type { FillSpec, CustomFillFn, CustomPrimitive, FillRegion } from './fills.js';

// Units.
export { w, h, s, long, mm, Len } from './units.js';
export type { L } from './units.js';

// Pure helpers. Randomness (rnd/noise/stream/…) and layout (bounds/grid)
// come through the toolkit — they belong to a sketch run, not the module.
export type { RandomStream } from './state.js';
export { mapRange as map, normRange as norm, invertRange as invert } from './random.js';
export { ease } from './ease.js';

// Render & export (accept a SketchDef, or operate on legacy recorded state).
export {
  render, exportGcode, exportSvg, exportPng,
  encodeScene, decodeRender, renderEncoded, sceneTransferables,
  pensToJson, profileToJson, tourBudget,
} from './render.js';
export type {
  Fragment, RenderResult, RenderOptions,
  GcodeJob, ExportOptions, MachineProfileTS,
  EncodedScene, RawRender, WasmModule,
} from './render.js';
export { initOcclude } from './init.js';
export { drawFragments, tracePrim } from './draw.js';
export { PAPERS, paperSize } from './paper.js';
export type { Paper, PaperChoice } from './paper.js';
export { DEFAULT_PENS } from './pens.js';
export type { PenDef } from './pens.js';
export type { Prim } from './prims.js';
export { subPrim, evalPrim } from './prims.js';

// Host integration.
export { setPenLibrary, setPaperHint, getState } from './state.js';
