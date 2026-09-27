/**
 * occlude/host — the words a host needs and a sketch does not.
 *
 * A host (the studio, the node tools, the tests) compiles a sketch, runs
 * it, renders and plans the result, and writes files. A sketch does none
 * of that: it returns a drawing. So these words live here, and the root
 * module (`occlude`) holds only what a sketch can use. A fill file sees
 * the root module, so it never has a handle on the runtime around it.
 */

// The root module hands the fill registry its namespace when it evaluates;
// a host that imports only from here still loads fill files.
import './index.js';

// Compile and run: one Execution per run, the toolkit bound to it.
export {
  compileSketch, compileSketchAsync, isSketch, commitCamera3,
  inspectHook, bindToolkit, DEFAULT_INPUTS,
} from './api.js';
export { Execution, userModules, moduleName, exportCollisions } from './execution.js';
export type {
  ExecutionInputs, CompileConfig, ProbeSummary, InspectionEntry, InspectionPayload, DrawEntry, DrawHook,
} from './execution.js';
export { userUnitsToPaper } from './record.js';
export type { Frame } from './record.js';

// Render, plan and export.
export { initOcclude } from './init.js';
export {
  render, renderAsync, exportGcode, exportSvg, exportPng,
  encodeScene, decodeRender, renderEncoded,
  pensToJson, profileToJson, tourBudget,
  plan, planBuffer, planSvg, planGcode, planToolpath,
  applyShader, planAsBuffers, planSettings, bridgeArg,
} from './render.js';
export type {
  Fragment, RenderResult, RenderOptions,
  GcodeJob, ExportOptions, MachineProfileTS, YAxis,
  EncodedScene, RawRender, WasmModule,
} from './render.js';

// The ordered drawing plan as a value: decode/encode, identity, selections,
// standalone timing and duration fitting (never re-plans).
export {
  PLAN_SCHEMA, decodePlanBuffer, encodePlanBuffer, canonicalJson, hashPlan, makePlan, openPlan,
  parseToolpath, encodeToolpath, selectChains, selectAll, selectProgress, selectTime, selectedFlat,
  standaloneEstimate, fitDuration, planSchedule, chainsBounds, resolveDraw, planValue, checkDrawRequest,
} from './plan.js';
export type {
  PlanChain, PlanSettings, DrawingPlan, PlanSelection, FlatChain, TimeSelection, FitResult,
  DrawTiming, ResolvedDraw,
} from './plan.js';

// Motion planning and the one plot-time estimator (law 4: `estimatePlanMs`
// is the clock the driver, plotstats and the export panel share).
export {
  planPolyline, planDurationMs, segmentsToBlocks, estimatePlanMs, schedulePlan,
} from './motion.js';
export type {
  PenTiming, MotionLimits, PlannedSegment, MotionBlock, Point, PlanEstimate, EstimateOpts, PlanSchedule,
} from './motion.js';

// Pen height: the clearance map read off the lift-grid card, the settle
// curve from the settle×lift card, and the one pen-cycle model both the
// driver and the estimator use.
export {
  cellCentre, liftMapFromCounts, refineLiftMap, liftAt, liftForTravel, parseCounts,
  travelLiftPulse, curveMs, settleAtLift,
} from './liftmap.js';
export type { LiftMap, CellGeometry, SettlePoint, LiftModel } from './liftmap.js';

// Drawing primitives on a canvas (the preview) and along a path.
export { drawFragments, tracePrim } from './draw.js';
export { subPrim, evalPrim, primLength } from './prims.js';
export type { Prim } from './prims.js';

// The fill registry: built-ins resolve from the package; hosts load custom
// fills into it (the studio worker per render, node tools from disk).
export {
  resolveFill, scanFillNames, loadFillModule, fillTable,
  BUILTIN_FILL_NAMES, FILL_NAME_RE, isBuiltinFill,
} from './fills.js';
export type { FillTable } from './fills.js';

// Image assets, loaded by the host into a table the run reads.
export { scanAssetNames, assetTable } from './imageAsset.js';
export type { AssetTable } from './imageAsset.js';

// The docs pages and their live examples (the site and the checker).
export { liveExampleToJs, DOC_PAGES, parseLiveMeta, docsPaper } from './docsExamples.js';
export type { LiveMeta } from './docsExamples.js';

// Seeds, draws and the ui() scan behind the studio's sliders.
export { parseSeed, formatSeed, tagDraws, siteId, DRAW_HOOK } from './draws.js';
export type { ParsedSeed, DrawSite } from './draws.js';
export { scanUiControls } from './ui.js';
export type { UiControl } from './ui.js';

// Paper and pen data a host offers before a sketch declares its own.
export { PAPERS, DEFAULT_PAPERS, paperSize } from './paper.js';
export type { Paper, PaperChoice, PaperDef } from './paper.js';
export { DEFAULT_PENS } from './pens.js';

