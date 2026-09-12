/** Auto selects by shared ETA, subject to per-pen vector footprint limits. */
import init, * as core from 'occlude-core';
import {
  PLAN_SCHEMA,
  canonicalJson,
  decodePlanBuffer,
  parseToolpath,
  estimatePlanMs,
  hashPlan,
} from 'occlude';
import type {
  OptimizationRequest,
  OptimizationReply,
  InkDifference,
} from './optimization.js';
export async function optimizeAutoRequest(
  r: OptimizationRequest,
  progress: (s: string) => void,
): Promise<OptimizationReply> {
  const started = performance.now(),
    a = r.auto!;
  await init();
  if (
    ![a.localNib, a.missingPercent, a.addedPercent].every(
      (x) => Number.isFinite(x) && x >= 0,
    ) ||
    !Number.isInteger(a.alternatives) ||
    a.alternatives < 1
  )
    throw Error(
      'Auto needs non-negative finite fidelity allowances and a positive whole number of alternatives.',
    );
  const measure = (buffer: Float64Array) => {
    const cs = decodePlanBuffer(buffer);
    return {
      estimate: estimatePlanMs(
        parseToolpath(
          core.wasm_plan_toolpath(buffer, r.machineTolerance, 0, cs.length),
        ),
        (i) => r.pens[i],
        r.timing,
      ),
      primitives: cs.reduce((n, c) => n + c.prims.length, 0),
    };
  };
  progress('Auto: measuring the original path…');
  const original = measure(r.buffer);
  let best = original;
  let buffer: Float64Array = r.buffer.slice(),
    before: Float64Array = Float64Array.of(PLAN_SCHEMA, 0),
    after: Float64Array = Float64Array.of(PLAN_SCHEMA, 0),
    stats: Float64Array = new Float64Array(4);
  let chosen = r.options;
  let strategy = 'Original retained',
    fidelity: InkDifference | undefined;
  const skipped: string[] = [];
  const width = Math.min(...r.pens.map((p) => p.width));
  const join = a.connections && !!r.context;
  const fitting = [0.25, 0.5, 1, 2].map((k) => ({
    eps: Math.max(width * a.localNib * k, 0.000001),
    gap: 0,
    label: `Fit at ${(width * a.localNib * k).toFixed(4)} mm`,
  }));
  const routing = { eps: 0, gap: 0, label: 'Order paths' };
  const joining = [0.125, 0.25, 0.5, 1, 2, 4].map((k) => ({
    eps: 0,
    gap: width * k,
    label: `Join up to ${(width * k).toFixed(3)} mm`,
  }));
  const proposals = (
    join
      ? [
          joining[0],
          fitting[0],
          ...joining.slice(1),
          routing,
          ...fitting.slice(1),
        ]
      : [routing, ...fitting]
  ).slice(0, a.alternatives);
  let prepared: ReturnType<typeof core.wasm_prepare> | undefined,
    ink: InstanceType<typeof core.WasmInkSession> | undefined;
  try {
    if (join) {
      progress('Auto: preparing visibility checks…');
      const s = r.context!.scene;
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
    for (let i = 0; i < proposals.length; i++) {
      const p = proposals[i];
      progress(`Auto ${i + 1}/${proposals.length}: ${p.label}…`);
      let result: ReturnType<typeof core.wasm_optimize_plan> | undefined;
      try {
        result =
          prepared && r.context
            ? prepared.optimize_plan(
                r.buffer,
                r.context.prims,
                r.context.frags,
                p.eps,
                10,
                30,
                p.gap,
                p.gap > 0 ? 0 : 1000000,
              )
            : core.wasm_optimize_plan(r.buffer, p.eps, 10, 30, 1000000);
        const candidate = result.plan,
          measured = measure(candidate);
        if (measured.estimate.totalMs >= best.estimate.totalMs) continue;
        progress(
          `Auto ${i + 1}/${proposals.length}: comparing vector ink (${p.label})…`,
        );
        ink ??= new core.WasmInkSession(
          r.buffer,
          Float64Array.from(r.pens.map((p) => p.width)),
          r.machineTolerance,
          a.localNib,
          a.missingPercent / 100,
          a.addedPercent / 100,
        );
        const comparison: InkDifference = JSON.parse(ink.compare(candidate));
        if (comparison.status !== 'passed' || !comparison.complete) {
          skipped.push(
            `${p.label}: ${comparison.status === 'rejected' ? 'ink allowance exceeded' : comparison.pens.some((p) => !p.localPass) ? 'local ink allowance could not be verified' : 'area measurement uncertainty exceeds allowance'}`,
          );
          continue;
        }
        best = measured;
        buffer = candidate;
        before = result.before;
        after = result.after;
        stats = result.stats;
        strategy = `Auto · ${p.label}`;
        fidelity = comparison;
        chosen = {
          tolerance: p.eps,
          maxSegment: 10,
          cornerDegrees: 30,
          gap: p.gap,
          tourBudget: p.gap > 0 ? 0 : 1000000,
        };
      } catch (e) {
        skipped.push(
          `${p.label}: ${e instanceof Error ? e.message : String(e)}`,
        );
      } finally {
        result?.free();
      }
    }
    const settings = {
      ...r.settings,
      optimization: {
        version: 3,
        sourcePlanHash: r.sourcePlanHash,
        sourceRange: r.sourceRange,
        ...chosen,
        auto: {
          ...a,
          model: 'round-nib-machine-polyline-v1',
          machineTolerance: r.machineTolerance,
          executionKey: canonicalJson({ timing: r.timing, pens: r.pens }),
          ...(fidelity
            ? {
                fidelity: fidelity.pens.map((p) => ({
                  pen: p.pen,
                  missingUpper: p.missingUpper,
                  addedUpper: p.addedUpper,
                  localLimitMm: p.localLimitMm,
                })),
              }
            : {}),
        },
      },
    };
    return {
      buffer,
      before,
      after,
      stats,
      settings,
      planHash: await hashPlan(buffer, settings),
      strategy,
      fidelity,
      skipped,
      attempts: proposals.length,
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
    ink?.free();
    prepared?.free();
  }
}
