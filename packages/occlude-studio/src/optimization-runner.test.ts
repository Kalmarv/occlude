import { readFileSync } from "node:fs";
import { beforeAll, expect, it } from "vitest";
import init, * as core from "occlude-core";
import {
  encodePlanBuffer,
  decodePlanBuffer,
  parseToolpath,
  estimatePlanMs,
  type PlanChain,
} from "occlude";
import { optimizeRequest } from "./optimization-runner.js";
import type { OptimizationRequest } from "./optimization.js";

beforeAll(async () => {
  await init({
    module_or_path: readFileSync(
      new URL(
        "../../../crates/occlude-core/pkg/occlude_core_bg.wasm",
        import.meta.url,
      ),
    ),
  });
});
const pens = [
  {
    name: "test",
    width: 0.4,
    color: "#000",
    feed: 3000,
    penDown: 0,
    penUp: 5,
    penDelay: 600,
  },
];
function request(chains: PlanChain[]): OptimizationRequest {
  return {
    buffer: encodePlanBuffer(chains),
    sourcePlanHash: "source",
    sourceRange: [0, chains.length],
    settings: {
      tourBudget: 0,
      pens,
      paper: { w: 100, h: 100 },
      bridgeGapMm: [0],
    },
    options: {
      tolerance: 0.1,
      maxSegment: 10,
      cornerDegrees: 30,
      gap: 0,
      tourBudget: 10000,
    },
    pens,
    timing: {
      travelFeed: 6000,
      acceleration: 1000,
      travelAcceleration: 2000,
      junctionDeviation: 0.02,
      minimumCruiseRatio: 0.5,
    },
    machineTolerance: 0.025,
  };
}
it("selects by machine ETA among alternatives and the original, including permissive fitting", async () => {
  const r = request(
    Array.from({ length: 5 }, (_, index) => ({
      index,
      pen: 0,
      dot: false,
      prims: Array.from({ length: 100 }, (_, i) => ({
        t: "line" as const,
        x0: i * 0.5,
        y0: 10 + index * 4 + Math.sin(i * 0.08),
        x1: (i + 1) * 0.5,
        y1: 10 + index * 4 + Math.sin((i + 1) * 0.08),
      })),
    })),
  );
  const source = r.buffer.slice();
  const eta = (b: Float64Array) =>
    estimatePlanMs(
      parseToolpath(
        core.wasm_plan_toolpath(
          b,
          r.machineTolerance,
          0,
          decodePlanBuffer(b).length,
        ),
      ),
      (i) => pens[i],
      r.timing,
    ).totalMs;
  const totals = [eta(source)];
  for (const tolerance of [0.1, 0, 0.025]) {
    const result = core.wasm_optimize_plan(source, tolerance, 10, 30, 10000);
    try {
      totals.push(eta(result.plan));
    } finally {
      result.free();
    }
  }
  const out = await optimizeRequest(r);
  expect(out.metrics.optimized.totalMs).toBe(Math.min(...totals));
  expect(out.metrics.optimized.totalMs).toBeLessThanOrEqual(
    out.metrics.original.totalMs,
  );
  expect(out.attempts).toBe(3);
  expect(r.buffer).toEqual(source);
});
it("retains exact original bytes and disables acceptance when no faster candidate exists", async () => {
  const r = request([
    {
      index: 0,
      pen: 0,
      dot: false,
      prims: [{ t: "line", x0: 0, y0: 0, x1: 10, y1: 0 }],
    },
  ]);
  const out = await optimizeRequest(r);
  expect(out.improved).toBe(false);
  expect(out.buffer).toEqual(r.buffer);
  expect(out.strategy).toBe("Original retained");
});

it("Auto checks per-pen vector fidelity and preserves an unchanged original", async () => {
  const r = request([
    {
      index: 0,
      pen: 0,
      dot: false,
      prims: [{ t: "line", x0: 0, y0: 0, x1: 10, y1: 0 }],
    },
  ]);
  r.auto = {
    localNib: 0.1,
    missingPercent: 0.1,
    addedPercent: 0.5,
    alternatives: 3,
    connections: false,
  };
  const out = await optimizeRequest(r);
  expect(out.improved).toBe(false);
  expect(out.buffer).toEqual(r.buffer);
  expect(out.settings.optimization?.auto?.model).toBe(
    "round-nib-machine-polyline-v1",
  );
});
it("Auto measures actual machine ink for faster routing without changing pen assignment", async () => {
  const r = request(
    [10, 30, 20, 0].map((x, index) => ({
      index,
      pen: 0,
      dot: false,
      prims: [{ t: "line" as const, x0: x, y0: 0, x1: x + 1, y1: 0 }],
    })),
  );
  r.auto = {
    localNib: 0.1,
    missingPercent: 0.1,
    addedPercent: 0.5,
    alternatives: 1,
    connections: false,
  };
  const out = await optimizeRequest(r);
  expect(out.improved).toBe(true);
  expect(out.fidelity?.status).toBe("passed");
  expect(out.fidelity?.pens[0].missingUpper).toBe(0);
  expect(out.fidelity?.pens[0].addedUpper).toBe(0);
  expect(out.metrics.optimized.totalMs).toBeLessThan(
    out.metrics.original.totalMs,
  );
});
