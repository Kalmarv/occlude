/**
 * occlude — a drawing library for pen plotters where `fill` means fill.
 *
 * A sketch is a pure function from a toolkit to a tree of shape values:
 *
 *   export default sketch({ aspect: 'square', margin: 6 }, ({ circle, hatch, rnd, bounds }) => {
 *     const b = bounds();
 *     return Array.from({ length: 24 }, () =>
 *       circle(rnd(b.w), rnd(b.h), rnd(6, 22), { fill: fill('hatch', { angle: rnd(180) }) }));
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
  circle, ellipse, rect, line, polygon, ngon, stroke, path, PathValue,
  group, clip, mask, invert, decimate, wobble, modify, dash, smooth, roughen, deform, noiseField,
  times, range,
} from './api.js';
export type {
  SketchDef, SketchConfig, Toolkit, Tree,
  ShapeValue, ShapeOpts, PolygonOpts, Contour, GroupValue, GroupOpts, ClipValue, InvertValue,
} from './api.js';
export type { ModifierValue, FieldFn, VectorFieldFn } from './shapes.js';

// Fills are pure data (module reference + params) or plain functions.
// Built-ins resolve from the package; hosts load custom fills into the
// registry (studio worker per render, node tools from disk).
export {
  fill, fillAsset, customFill, rulings, resolveFill,
  scanFillNames, loadFillModule, registerFill, clearFills,
  BUILTIN_FILL_NAMES, FILL_NAME_RE, isBuiltinFill,
} from './fills.js';
export type { FillAssetDef, FillCtx, FillAnchor, RulingOpts } from './fills.js';
export type { FieldAlign } from './shapes.js';
export { svg } from './svgin.js';
export {
  asset, image, scanAssetNames, registerTextAsset, registerImageAsset, clearAssets,
  type ImageSampler, type ImagePlacement, type AssetPixels,
} from './imageAsset.js';
export { label, labelWidth } from './font.js';
export { liveExampleToJs } from './docsExamples.js';
export { synth, probe as probeExpression } from './synth.js';
export type { SynthFn, SynthOpts, SynthStats, SynthBounds, WarpFn } from './synth.js';
export type { LabelOpts } from './font.js';
export type { FillSpec, CustomFillFn, CustomPrimitive, FillRegion } from './fills.js';

// Curves with attributes: hold, step, reinterpret (pure; the toolkit's
// t.sample turns a shape into the starting positions).
export {
  curve, Curve, segmentRuns, neighbours, separation, tension,
  add, sub, mul, length, distance, unit, limit, perp, sum, sumBy,
} from './curve.js';
export type { Vertex, Edge, Next, Snapshot, NeighbourStats, SegmentRun, Vec, XY } from './curve.js';

// Units.
export { w, h, s, long, mm, Len } from './units.js';
export type { L } from './units.js';

// Pure helpers. Randomness (rnd/noise/stream/…) and layout (bounds/grid)
// come through the toolkit — they belong to a sketch run, not the module.
export type { RandomStream } from './state.js';
export { mapRange as map, normRange as norm, invertRange } from './random.js';
export { ease } from './ease.js';

// Render & export (accept a SketchDef, or operate on legacy recorded state).
export {
  render, exportGcode, exportSvg, exportPng,
  encodeScene, decodeRender, renderEncoded,
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

// Point-distribution duals: pure, so they take arbitrary point arrays.
export { voronoi, triangulate, Points } from './points.js';
export type { ScatterPoint, ScatterOpts } from './points.js';
export type { IsoContour, IsoOpts } from './isolines.js';
// Loops → signed distance field (positive inside): pure, composes with
// isolines (offsetting is a recipe), scatter, decimate, deform.
export { distanceTo } from './distance.js';
export type { DistanceField } from './distance.js';
// Fields as citizens: explicit transforms, domain bounds, vector marking.
export { rotate, translate, scale, within, vectorField, grad, curl } from './field.js';

// Tweakable values (identity at runtime; the studio scans + builds sliders).
export { ui, scanUiControls } from './ui.js';
export type { UiOpts, UiControl } from './ui.js';

// Motion planning + the plot-time ground-truth model (shared by the EBB
// driver, plotstats, and the export panel).
export {
  planPolyline, planDurationMs, segmentsToBlocks, estimatePlanMs, schedulePlan,
} from './motion.js';
export type {
  MotionLimits, PlannedSegment, MotionBlock, Point, PlanEstimate, EstimateOpts, PlanSchedule,
} from './motion.js';

export type { StreamOpts } from './streamlines.js';
export { shaper } from './shaper.js';
export type { Shaper, ShaperOpts, ShaperPoint } from './shaper.js';

// Pen height: the clearance map read off the lift-grid card, the settle
// curve from the settle×lift card, and the one pen-cycle model both the
// driver and the estimator use.
export {
  cellCentre, liftMapFromCounts, refineLiftMap, liftAt, liftForTravel, parseCounts,
  travelLiftPulse, curveMs, settleAtLift, SETTLE_FLOOR_MS,
} from './liftmap.js';
export type { LiftMap, CellGeometry, SettlePoint, LiftModel } from './liftmap.js';

// Host integration.
export { setPenLibrary, setPaperHint, setSeedHint, getState, getProbeStats } from './state.js';
export type { ProbeSummary } from './state.js';

// A fill file's `import … from 'occlude'` resolves to this very module: the
// registry hands loaded fills the package's own namespace (self-import is
// ordinary ESM — the namespace is created at link time, bindings are live).
import * as occludeNamespace from './index.js';
import { setOccludeModule } from './fills.js';
/** Host integration and runtime entry points a fill file must not reach. */
const HOST_ONLY = new Set([
  'setPenLibrary', 'setPaperHint', 'setSeedHint', 'getState',
  'registerFill', 'clearFills', 'loadFillModule', 'initOcclude',
  'compileSketch', 'render', 'exportGcode', 'exportSvg', 'exportPng',
  'encodeScene', 'decodeRender', 'renderEncoded',
]);
setOccludeModule(() =>
  Object.fromEntries(
    Object.entries(occludeNamespace as unknown as Record<string, unknown>).filter(
      ([k]) => !HOST_ONLY.has(k),
    ),
  ),
);
