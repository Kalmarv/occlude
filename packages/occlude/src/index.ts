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
  circle, ellipse, rect, line, polygon, ngon, stroke, strokes, dots, path, PathValue,
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
  type PaletteEntry, type PaletteSource, type ImageRegion, type RegionOpts,
} from './imageAsset.js';
export type { ColourSpace } from './colour.js';
export { label, labelWidth } from './font.js';
export { strokeFont } from './strokeFont.js';
export type { Font, Glyph, TextOpts } from './strokeFont.js';
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
export { add, sub, mul, length, distance, unit, limit, perp, dot, cross, fromAngle, angleOf, sum, sumBy, turn, lerp, reflect, angleBetween } from './vec.js';
export { ownedBy } from './views.js';
export { force, sumForces } from './forces.js';
export { query } from './query.js';
export { inheritEdge } from './steps.js';
export type { EdgeRef, StepRule, StepsOptions } from './steps.js';
export type { EdgeTransfer } from './material.js';
export { stationsMaterial, isStations } from './material.js';
// Same-world transforms are methods on Material now (`m.thicken(opts)`),
// so only their options types are exported.
export type { ThickenOpts } from './thicken.js';
export type { QuadtreeOpts } from './quadtree.js';
// The fold tables are plain data: read one, edit it, or write your own.
export { hilbertRule, peanoRule, meanderRule } from './spacefill.js';
export type { SpacefillOpts, SpacefillRule, SpacefillTurn } from './spacefill.js';
export type { TrailsOpts } from './trails.js';
export type { WarpOpts, Corner } from './warp.js';
export type { RidgeOpts, RidgeContour } from './ridges.js';
export type { InterlaceOpts, Crossing } from './interlace.js';
export type { SnapOpts, SnapField } from './snap.js';
export type { OscillateOpts, OscillateAmount } from './oscillate.js';
export type { CoilOpts } from './coil.js';
export type { MergeOpts } from './merge.js';
export { PointSelection, EdgeSelection, meanBy } from './relation.js';
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

// The seventeen wallpaper groups as placements. Pure: a lattice and a cell,
// no paper and no seed. `t.symmetry` is the same list, sized to the drawable.
export { symmetry, PLANE_GROUPS } from './symmetry.js';
export type { PlaneGroup, SymmetryOptions } from './symmetry.js';

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
export type { ReplaceOpts } from './steps.js';
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
export { voronoi, hull, type Sites } from './voronoi.js';
export type { VoronoiLinks } from './material.js';
export { FaceMeasurements } from './measure.js';
export type { FaceMeasure, MeasureOpts } from './measure.js';
export type { IsoContour, IsoOpts, IsoLevels } from './isolines.js';
// A grid of values you can step: the stateful counterpart of a field. The
// door is `t.lattice` — it reads the drawable and the seeded init.
export type { Lattice, LatticeOpts, LatticeInit, LatticeRule, LatticeState, LatticeNext, LatticeValues } from './lattice.js';
// Ink as a budget: the tone a drawing still owes, paid down by the marks it
// makes. The door is `t.residual` — it reads the drawable and the nib.
export type { Residual, ResidualOpts, SpendMarks, SpendOpts } from './residual.js';
// Loops → signed distance field (positive inside): pure, composes with
// isolines (offsetting is a recipe), scatter, decimate, deform.
export { distanceTo, distanceToPoints, sdf } from './distance.js';
export type { DistanceField } from './distance.js';
// Complex arithmetic over the pair spelling, and the escape-time field as
// a field word: the artist's own map in, a smooth count (and its
// potential) out.
export { complex } from './complex.js';
export { escape } from './escape.js';
export type { EscapeOpts, EscapeField, EscapeStep } from './escape.js';
// The sketch's geometry as a frame setting: `space` says what a length is
// worth and `projection` which chart the sheet draws it in. The
// constructors are pure data words — the run resolves them against the
// drawable, and `t.space` is the record every word reads. The isometries
// of the disk and of the Klein ball are what those words are MADE of, and
// stay internal (hyperbolic.ts, hyperbolicSpace.ts).
export { space } from './space.js';
export type { Space, SpaceKind, SpaceSpec, SpaceOption, Projection } from './space.js';
// `t.tiling(p, q)` is one word for the regular tilings of all three
// geometries: the Schläfli symbol picks the sphere, the plane or the disk,
// and the answer is the cell and its placements as point maps on the
// drawable, the same shape in each.
export type { Tiling, TilingGeometry, TilingOpts } from './tiling.js';
// Seeds → arrival times (fast marching): the distance a walk actually
// takes, with walls and a slow ground. `t.travelTime` is the word.
export type { TravelFrom, TravelOpts } from './travel.js';
export type { TravelTimeOpts } from './api.js';
// The geometry protocol: what a value can say about itself, and the one
// area contract of polygon, distanceTo, force.boundary and t.within.
export { areaLoops, isGeometry, numericLoops } from './boundary.js';
export type { AreaInput, Geometry } from './boundary.js';
// Fields as citizens: explicit transforms, domain bounds, vector marking.
export { rotate, translate, scale, within, vectorField, grad, curl } from './field.js';
// Unoriented direction fields: an axis has no front, and `across` is the
// perpendicular family of either kind.
export { axisField, across } from './field.js';
export type { AxisFieldFn } from './field.js';
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
