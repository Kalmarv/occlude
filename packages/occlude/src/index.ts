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
  sketch, compileSketch, isSketch, sketchAsync, compileSketchAsync, isSketchAsync, commitCamera3,
  circle, ellipse, rect, line, polygon, ngon, stroke, strokes, path, PathValue,
  group, clip, mask, invert, decimate, wobble, modify, dash, smooth, roughen, deform,
  times, range,
} from './api.js';
export type {
  SketchDef, AsyncSketchDef, SketchConfig, Toolkit, Tree,
  ShapeValue, ShapeOpts, PolygonOpts, Contour, GroupValue, GroupOpts, ClipValue, InvertValue, WithinFaces,
} from './api.js';
export type { ModifierValue, FieldFn, VectorFieldFn } from './shapes.js';

// Fills are pure data (module reference + params) or plain functions.
// Built-ins resolve from the package; hosts load custom fills into the
// registry (studio worker per render, node tools from disk).
export {
  fill, fillAsset, customFill, rulings, resolveFill,
  scanFillNames, loadFillModule, fillTable,
  BUILTIN_FILL_NAMES, FILL_NAME_RE, isBuiltinFill,
} from './fills.js';
export type { FillTable } from './fills.js';
export type { FillAssetDef, FillCtx, FillAnchor, RulingOpts } from './fills.js';
export type { FieldAlign } from './shapes.js';
export { svg } from './svgin.js';
export {
  scanAssetNames, assetTable,
  type ImageSampler, type ImagePlacement, type AssetPixels, type ImageChannel, type AssetTable,
} from './imageAsset.js';
export { label, labelWidth } from './font.js';
export { liveExampleToJs, DOC_PAGES, parseLiveMeta, docsPaper } from './docsExamples.js';
export type { LiveMeta } from './docsExamples.js';
export { synth, probe as probeExpression } from './synth.js';
export type { SynthFn, SynthOpts, SynthStats, SynthBounds, WarpFn } from './synth.js';
export type { LabelOpts } from './font.js';
export type { FillSpec, CustomFillFn, CustomPrimitive, FillRegion } from './fills.js';

// Material: meshes with attributes and connections — hold, connect, step,
// resample, reinterpret (pure; the toolkit's t.sample turns a shape into
// material with its outline's connectivity).
export {
  material, curve, append, connect, Material, segmentRuns, extent, banding,
} from './material.js';
export { add, sub, mul, length, distance, unit, limit, perp, dot, cross, fromAngle, angleOf, sum, sumBy } from './vec.js';
export { ownedBy } from './views.js';
export { force, neighbours, sumForces } from './forces.js';
export { query } from './query.js';
export { inheritEdge } from './steps.js';
export type { EdgeRef, StepRule, StepsOptions } from './steps.js';
export type { EdgeTransfer } from './material.js';
export { stationsMaterial, isStations } from './material.js';
export { thicken } from './thicken.js';
export type { ThickenOpts } from './thicken.js';
export type { QuadtreeOpts } from './quadtree.js';
export type { TrailsOpts } from './trails.js';
export { warp } from './warp.js';
export type { WarpOpts, Corner } from './warp.js';
export type { RidgeOpts, RidgeContour } from './ridges.js';
export { envelope } from './envelope.js';
export { interlace } from './interlace.js';
export type { InterlaceOpts, Crossing } from './interlace.js';
export { snap } from './snap.js';
export type { SnapOpts, SnapField } from './snap.js';
export { oscillate } from './oscillate.js';
export type { OscillateOpts, OscillateAmount } from './oscillate.js';
export { PointSelection, EdgeSelection, components, meanBy } from './relation.js';
export type { Components } from './relation.js';
export { planarize, faces, Faces, FaceSelection } from './faces.js';
export type { Face, PlanarizeOpts, PlanarEvent, EventCandidate } from './faces.js';
export type { EdgeQuery, NearestHit, FirstHit } from './query.js';
export type {
  Vertex, Edge, Curve, Station, Snapshot, Transfer, TransferPolicy, SegmentRun, PointsLike,
} from './material.js';
export type { Next, Handle, Ref, ChildSpec, ChildInterval, SplitOpts } from './steps.js';
export type { NeighbourStats, Sources } from './forces.js';
export type { Vec, XY } from './vec.js';

// Units.
export { w, h, s, long, mm, inch, degrees, radians, Len } from './units.js';
export type { L } from './units.js';

// Pure helpers. Randomness (rnd/noise/stream/…) and layout (bounds/grid)
// come through the toolkit — they belong to a sketch run, not the module.
export type { RandomStream } from './execution.js';
export { mapRange as map, normRange as norm, invertRange } from './random.js';
export { ease } from './ease.js';

// Render & export (accept a SketchDef, or operate on legacy recorded state).
export {
  render, renderAsync, exportGcode, exportSvg, exportPng,
  encodeScene, decodeRender, renderEncoded,
  pensToJson, profileToJson, tourBudget,
} from './render.js';
export type {
  Fragment, RenderResult, RenderOptions,
  GcodeJob, ExportOptions, MachineProfileTS, YAxis,
  EncodedScene, RawRender, WasmModule,
} from './render.js';
export { initOcclude } from './init.js';
export { drawFragments, tracePrim } from './draw.js';
// The ordered drawing plan as a value: decode/encode, identity, selections,
// standalone timing and duration fitting (never re-plans).
export {
  PLAN_SCHEMA, decodePlanBuffer, encodePlanBuffer, canonicalJson, hashPlan, makePlan, openPlan,
  parseToolpath, encodeToolpath, selectChains, selectAll, selectProgress, selectTime, selectedFlat,
  standaloneEstimate, fitDuration, planSchedule, chainsBounds, resolveDraw, planValue, checkDrawRequest,
} from './plan.js';
export { plan, planBuffer, planSvg, planGcode, planToolpath, bridgeGapFor } from './render.js';
export type { PlanChain, PlanSettings, DrawingPlan, PlanSelection, FlatChain, TimeSelection, FitResult, PlanOptions, DrawRequest, DrawTiming, ResolvedDraw } from './plan.js';
export { PAPERS, DEFAULT_PAPERS, paperSize } from './paper.js';
export type { Paper, PaperChoice, PaperDef } from './paper.js';
export { DEFAULT_PENS } from './pens.js';
export type { PenDef } from './pens.js';
export type { Prim } from './prims.js';
export { subPrim, evalPrim, primLength } from './prims.js';
export { shader } from './shader.js';
export { applyShader, planAsBuffers, planSettings, bridgeArg } from './render.js';
export type { ShaderValue, StrokeCtx, StrokeInk, StrokeProgram } from './shader.js';

// Point-distribution duals: pure, so they take arbitrary point arrays.
export type { ScatterOpts, ThrowOpts, RelaxOpts, SettleOpts, SettleParent, Bounds } from './points.js';
// Voronoi cells as material, with the cell ↔ site correspondence on the result.
export { voronoi, type Sites } from './voronoi.js';
export type { VoronoiLinks } from './material.js';
export { FaceMeasurements } from './measure.js';
export type { FaceMeasure, MeasureOpts } from './measure.js';
export type { IsoContour, IsoOpts } from './isolines.js';
// Loops → signed distance field (positive inside): pure, composes with
// isolines (offsetting is a recipe), scatter, decimate, deform.
export { distanceTo, sdf } from './distance.js';
export { rule } from './rules.js';
export type { PointMatch, EdgeMatch, FaceMatch, FaceRow, ReplaceOpts, Rewrite, PointRule, EdgeRule, FaceRule } from './rules.js';
export type { DistanceField } from './distance.js';
// The one boundary contract of polygon, distanceTo and force.boundary.
export { boundaryLoops, numericLoops } from './boundary.js';
export type { Boundary } from './boundary.js';
// Fields as citizens: explicit transforms, domain bounds, vector marking.
export { rotate, translate, scale, within, vectorField, grad, curl } from './field.js';
export type { Prepared } from './field.js';

// Tweakable values (identity at runtime; the studio scans + builds sliders).
export { ui, scanUiControls } from './ui.js';
export { parseSeed, formatSeed, tagDraws, siteId, DRAW_HOOK, type ParsedSeed, type DrawSite } from './draws.js';
export type { DrawEntry, DrawHook } from './execution.js';
export type { UiOpts, UiControl } from './ui.js';

// Motion planning + the plot-time ground-truth model (shared by the EBB
// driver, plotstats, and the export panel).
export {
  planPolyline, planDurationMs, segmentsToBlocks, estimatePlanMs, schedulePlan,
} from './motion.js';
export type { PenTiming,
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
// The run: one object per execution, no ambient state (execution.ts).
export { Execution, pen, penModel, paper, paperModel, userModules, moduleName, exportCollisions } from './execution.js';
export type {
  ExecutionInputs, PaperSpec, CompileConfig, ProbeSummary, InspectionEntry, InspectionPayload, SketchOptions, TransformOp, Winding,
} from './execution.js';
export { userUnitsToPaper } from './record.js';
export { inspectHook, bindToolkit, DEFAULT_INPUTS } from './api.js';

// A fill file's `import … from 'occlude'` resolves to this very module: the
// registry hands loaded fills the package's own namespace (self-import is
// ordinary ESM — the namespace is created at link time, bindings are live).
import * as occludeNamespace from './index.js';
import { setOccludeModule } from './fills.js';
/** Host integration and runtime entry points a fill file must not reach. */
const HOST_ONLY = new Set([
  'GpuSceneCompute3', 'Execution', 'fillTable', 'assetTable', 'loadFillModule', 'initOcclude', 'bindToolkit', 'inspectHook',
  'compileSketch', 'compileSketchAsync', 'commitCamera3', 'render', 'renderAsync', 'exportGcode', 'exportSvg', 'exportPng',
  'encodeScene', 'decodeRender', 'renderEncoded',
]);
setOccludeModule(() =>
  Object.fromEntries(
    Object.entries(occludeNamespace as unknown as Record<string, unknown>).filter(
      ([k]) => !HOST_ONLY.has(k),
    ),
  ),
);

// Explicit 3D geometry and deferred drawing values. No device is acquired on import.
export { lineArt3, isLineArt3 } from './three/scene.js';
export { drawing3 } from './three/drawing.js';
export type { Drawing3 } from './three/drawing.js';
export type { LineArtScene3, LineArtOptions3, SceneCompute3 } from './three/scene.js';
export { surface3, box3, pointCloud3 } from './three/geometry/surface.js';
export type { Surface3, SurfaceCorner3, Attributes3 } from './three/geometry/surface.js';
export { FeatureKind3 } from './three/features/snapshot.js';
export type { SurfaceObject3, WireObject3, Feature3 } from './three/features/snapshot.js';
export type { Camera3, PaperFrame3 } from './three/camera.js';
export type { LineSet3, Stroke3, StrokeReference3 } from './three/strokes/construct.js';
export { GpuSceneCompute3 } from './compute/webgpu/scene.js';

export { grid3, FaceSelection3, measureFaces3, extrudeFaces3, transformSurface3, stepsSurface3, cloneSurface3, snapshotSurface3 } from './three/geometry/model.js';
export type { DeformOptions3 } from './three/geometry/deform.js';
export type { SurfaceQueryInput3, SurfaceQueryResult3, ModelingStats3 } from './three/modeling.js';
export type { RayQuery3, NearestQuery3, SurfaceHit3 } from './three/queries/surface.js';
export type { Vec3 } from './three/math.js';
export { PointSelection3, EdgeSelection3, editPoints3, editEdges3 } from './three/geometry/selection.js';
export type { PointMeasure3, EdgeMeasure3, PointEdit3 } from './three/geometry/selection.js';

export { constructStrokes3, FeatureSelection3 } from './three/strokes/construct.js';
export type { ClassifiedScene3, ClassifiedFeature3 } from './three/visibility/scene.js';

export { section3 } from './three/curves/section.js';
export type { SectionPlane3, SurfaceCurves3, SurfaceCurveSegment3, SurfaceCurvePoint3 } from './three/curves/section.js';

export { hatch3 } from './three/curves/hatch.js';
export type { HatchFamily3, HatchSource3 } from './three/curves/hatch.js';
export type { StageEvent3, StageListener3 } from './three/resolve.js';
export type { ModelingProgress3, ProgressListener3 } from './three/modeling.js';
