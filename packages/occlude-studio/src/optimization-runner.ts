/** One timing model selects among bounded alternatives, including the source.
 * No candidate is accepted merely because it has fewer primitives. */
import init, * as core from "occlude-core";
import {
  PLAN_SCHEMA,
  decodePlanBuffer,
  estimatePlanMs,
  hashPlan,
  parseToolpath,
} from "occlude";
import type { OptimizationRequest, OptimizationReply } from "./optimization.js";

export async function optimizeRequest(
  r: OptimizationRequest,
  progress: (stage: string) => void = () => {},
): Promise<OptimizationReply> {
  const started = performance.now();
  progress("Loading geometry engine…");
  await init();
  const o = r.options;
  if (
    !Number.isInteger(o.tourBudget) ||
    o.tourBudget < 0 ||
    o.tourBudget > 0xffffffff
  )
    throw new Error(
      "Routing effort must be a non-negative whole number below 4,294,967,296.",
    );
  let prepared: ReturnType<typeof core.wasm_prepare> | undefined;
  const measure = (b: Float64Array) => {
    const chains = decodePlanBuffer(b);
    const flat = parseToolpath(
      core.wasm_plan_toolpath(b, r.machineTolerance, 0, chains.length),
    );
    return {
      estimate: estimatePlanMs(flat, (i) => r.pens[i], r.timing),
      primitives: chains.reduce((n, c) => n + c.prims.length, 0),
    };
  };
  try {
    progress("Measuring the original machine path…");
    const original = measure(r.buffer);
    let best = original,
      strategy = "Original retained";
    let buffer: Float64Array = r.buffer.slice(),
      before: Float64Array = Float64Array.of(PLAN_SCHEMA, 0),
      after: Float64Array = Float64Array.of(PLAN_SCHEMA, 0),
      stats: Float64Array = new Float64Array(4);
    if (o.gap > 0) {
      if (!r.context)
        throw new Error(
          "Joining needs the original render context. Render this sketch again first.",
        );
      progress("Preparing visibility checks…");
      const s = r.context.scene;
      prepared = core.wasm_prepare(
        s.prims,
        s.contours,
        s.shapesU32,
        s.shapesF64,
        s.mods,
        s.fieldData,
        s.fieldUses,
        s.domainList,
        s.clipList,
        s.clipsU32,
        s.pensJson,
        s.paperArr,
        s.seed,
        s.coarsen,
        0,
      );
    }
    const attempts = [{ ...o, label: "Requested settings" }];
    if (o.tolerance > 0 && (o.gap > 0 || o.tourBudget > 0))
      attempts.push({
        ...o,
        tolerance: 0,
        label: "Joining / ordering without fitting",
      });
    if (o.tolerance > 0)
      attempts.push({
        ...o,
        tolerance: o.tolerance / 4,
        label: "Tighter fitting",
      });
    for (let i = 0; i < attempts.length; i++) {
      const a = attempts[i];
      progress(`Comparing paths ${i + 1}/${attempts.length}…`);
      const result =
        prepared && r.context
          ? prepared.optimize_plan(
              r.buffer,
              r.context.prims,
              r.context.frags,
              a.tolerance,
              a.maxSegment,
              a.cornerDegrees,
              a.gap,
              a.tourBudget,
            )
          : core.wasm_optimize_plan(
              r.buffer,
              a.tolerance,
              a.maxSegment,
              a.cornerDegrees,
              a.tourBudget,
            );
      try {
        const b = result.plan,
          measured = measure(b);
        if (measured.estimate.totalMs < best.estimate.totalMs) {
          best = measured;
          buffer = b;
          before = result.before;
          after = result.after;
          stats = result.stats;
          strategy = a.label;
        }
      } finally {
        result.free();
      }
    }
    const settings = {
      ...r.settings,
      optimization: {
        version: 2,
        sourcePlanHash: r.sourcePlanHash,
        sourceRange: r.sourceRange,
        ...o,
      },
    };
    return {
      buffer,
      settings,
      planHash: await hashPlan(buffer, settings),
      before,
      after,
      stats,
      strategy,
      attempts: attempts.length,
      improved: best.estimate.totalMs < original.estimate.totalMs,
      metrics: {
        original: original.estimate,
        optimized: best.estimate,
        primitivesBefore: original.primitives,
        primitivesAfter: best.primitives,
      },
      elapsedMs: performance.now() - started,
    };
  } finally {
    prepared?.free();
  }
}
