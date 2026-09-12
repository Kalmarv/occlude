/** Numeric render context requested lazily. No fill closures cross workers. */
import type {
  EncodedScene,
  EstimateOpts,
  PenDef,
  PlanEstimate,
  PlanSettings,
} from "occlude";
export type GeometrySnapshot = Pick<
  EncodedScene,
  | "prims"
  | "contours"
  | "shapesU32"
  | "shapesF64"
  | "mods"
  | "fieldData"
  | "fieldUses"
  | "domainList"
  | "clipList"
  | "clipsU32"
  | "pensJson"
  | "paperArr"
  | "seed"
  | "coarsen"
>;
export interface OptimizationContext {
  scene: GeometrySnapshot;
  prims: Float64Array;
  frags: Float64Array;
}
export interface OptimizationOptions {
  tolerance: number;
  maxSegment: number;
  cornerDegrees: number;
  gap: number;
  tourBudget: number;
}
export interface OptimizationRequest {
  buffer: Float64Array;
  settings: PlanSettings;
  sourcePlanHash: string;
  sourceRange: [number, number];
  options: OptimizationOptions;
  auto?: AutoOptions;
  context?: OptimizationContext;
  pens: PenDef[];
  timing: EstimateOpts;
  machineTolerance: number;
}
export interface OptimizationReply {
  strategy: string;
  fidelity?: InkDifference;
  skipped?: string[];
  attempts: number;
  improved: boolean;
  buffer: Float64Array;
  settings: PlanSettings;
  planHash: string;
  before: Float64Array;
  after: Float64Array;
  stats: Float64Array;
  metrics: {
    original: PlanEstimate;
    optimized: PlanEstimate;
    primitivesBefore: number;
    primitivesAfter: number;
  };
  elapsedMs: number;
}

export interface AutoOptions {
  localNib: number;
  missingPercent: number;
  addedPercent: number;
  alternatives: number;
  connections: boolean;
}
export interface InkDifference {
  complete: boolean;
  status: "passed" | "rejected" | "inconclusive";
  changedCells: number;
  model: string;
  pens: {
    pen: number;
    originalLower: number;
    originalUpper: number;
    missingLower: number;
    missingUpper: number;
    addedLower: number;
    addedUpper: number;
    localLimitMm: number;
    localPass: boolean;
  }[];
}
