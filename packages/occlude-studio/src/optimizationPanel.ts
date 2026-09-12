import {
  canonicalJson,
  decodePlanBuffer,
  encodePlanBuffer,
  openPlan,
  type DrawingPlan,
  type EstimateOpts,
} from "occlude";
import type { PanelHooks } from "./panels.js";
import type {
  OptimizationContext,
  OptimizationReply,
  OptimizationRequest,
} from "./optimization.js";
import {
  button,
  checkbox,
  el,
  hint,
  numberInput,
  row,
  segmented,
  subpanel,
} from "./widgets.js";

/** Candidate state is separate from the accepted Drawing. Comparing never
 * changes what exports or the machine consume. */
export function buildOptimizationPanel(
  body: HTMLElement,
  hooks: PanelHooks,
): void {
  const d = hooks.drawing;
  let worker: Worker | null = null,
    generation = 0,
    busy = false,
    adopting = false;
  let revision = d.sourceRevision,
    candidate: OptimizationReply | null = null,
    candidatePlan: DrawingPlan | null = null;
  let context: OptimizationContext | undefined;
  let sourceRange: [number, number] | null = null;
  let executionKey = "",
    capturedExecution = "";
  let fit = true,
    join = false,
    order = true;
  const status = hint("Runs only when requested.");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const comparison = el("div", "optimization-comparison");
  const metrics = el("div", "optimization-metrics");
  const choices = el("fieldset", "optimization-settings");
  const changed = (): void => {
    candidate = null;
    candidatePlan = null;
    comparison.hidden = true;
    metrics.replaceChildren();
    hooks.optimizationView(null);
    status.textContent =
      "Settings changed. Run to build a new candidate from the original.";
    refresh();
  };
  const input = (
    parent: HTMLElement,
    label: string,
    value: number,
  ): HTMLInputElement => {
    const control = numberInput(value, 1, changed);
    control.step = "any";
    const id = `opt-${label.toLowerCase().replace(/[^a-z]+/g, "-")}`;
    control.id = id;
    const r = row(label, control);
    r.querySelector("label")!.htmlFor = id;
    parent.append(r);
    return control;
  };
  const fitSettings = subpanel("Fitting settings");
  choices.append(
    checkbox("Fit short segments", fit, (v) => {
      fit = v;
      changed();
    }),
    fitSettings.root,
  );
  const tolerance = input(fitSettings.body, "Error mm", 0.02);
  const maxSegment = input(fitSettings.body, "Segment mm", 2);
  const corner = input(fitSettings.body, "Corner °", 30);
  fitSettings.body.append(
    hint("Maximum error, eligible segment length, and turns to preserve."),
  );
  const joinSettings = subpanel("Join settings");
  choices.append(
    checkbox("Join nearby ends", join, (v) => {
      join = v;
      changed();
    }),
    joinSettings.root,
  );
  const gap = input(joinSettings.body, "Gap mm", 0.2);
  joinSettings.body.append(
    hint(
      "Adds visible connections within one shape. Respects clips, holes and intentional breaks.",
    ),
  );
  const routeSettings = subpanel("Routing settings");
  choices.append(
    checkbox("Improve order", order, (v) => {
      order = v;
      changed();
    }),
    routeSettings.root,
  );
  const budget = input(routeSettings.body, "Effort", 1000000);
  routeSettings.body.append(
    hint("Extra search over whole paths. The original remains a candidate."),
  );

  const refresh = (): void => {
    run.disabled = busy || adopting || !d.sourcePlan || !d.selection;
    cancel.hidden = !busy;
    apply.disabled =
      busy ||
      adopting ||
      !candidate?.improved ||
      !candidatePlan ||
      d.plan?.planHash === candidatePlan.planHash;
    restore.disabled = busy || adopting || !d.isVariant;
    choices.disabled = busy || adopting;
    tolerance.disabled = !fit;
    maxSegment.disabled = !fit;
    corner.disabled = !fit;
    gap.disabled = !join || !!hooks.frozenResult();
    budget.disabled = !order;
  };
  const stop = (): void => {
    generation++;
    worker?.terminate();
    worker = null;
    busy = false;
  };
  const cancel = button("Cancel", () => {
    stop();
    status.textContent = "Cancelled. The active drawing is unchanged.";
    refresh();
  });
  cancel.hidden = true;
  const fmt = (n: number) =>
    n.toLocaleString(undefined, { maximumFractionDigits: 1 });
  const showMetrics = (r: OptimizationReply): void => {
    const a = r.metrics.original,
      b = r.metrics.optimized;
    const table = document.createElement("table");
    table.className = "export-table";
    const header = document.createElement("tr");
    for (const s of ["", "Original", "Optimized"]) {
      const th = document.createElement("th");
      th.textContent = s;
      header.append(th);
    }
    table.append(header);
    const rows: [string, number, number][] = [
      ["ETA min", a.totalMs / 60000, b.totalMs / 60000],
      ["Internal lifts", Math.max(0, a.chains - 1), Math.max(0, b.chains - 1)],
      ["Travel mm", a.travelMm, b.travelMm],
      ["Ink mm", a.drawMm, b.drawMm],
      ["Primitives", r.metrics.primitivesBefore, r.metrics.primitivesAfter],
      ["Motion commands", a.commands, b.commands],
    ];
    for (const [label, x, y] of rows) {
      const tr = document.createElement("tr");
      for (const s of [label, fmt(x), fmt(y)]) {
        const td = document.createElement("td");
        td.textContent = s;
        if (s !== label) td.className = "num";
        tr.append(td);
      }
      table.append(tr);
    }
    metrics.replaceChildren(
      table,
      hint(
        `${r.stats[0]} fitted spans · ${r.stats[2]} joins · ${(r.elapsedMs / 1000).toFixed(2)} s computation`,
      ),
    );
    const gain = a.totalMs - b.totalMs;
    metrics.append(
      hint(
        gain > 0
          ? `Saves ${gain < 100 ? "<0.1" : fmt(gain / 1000)} s (${(100 * gain) / a.totalMs < 0.1 ? "<0.1" : fmt((100 * gain) / a.totalMs)}%). ${r.strategy}.`
          : "No faster path found within these settings. Original retained.",
      ),
    );
    metrics.append(
      hint(
        `Compared ${r.attempts} alternatives against the original using the plot estimator.`,
      ),
    );
  };
  const run = button("Run optimization", async () => {
    if (hooks.isPlotting?.()) {
      status.textContent = "Stop the physical plot before optimizing.";
      return;
    }
    if (!d.sourcePlan || !d.selection) return;
    const source = d.sourcePlan;
    const myRevision = d.sourceRevision;
    if (!d.isVariant || !sourceRange)
      sourceRange = [d.selection.fromChain, d.selection.toChain];
    const range: [number, number] = [...sourceRange];
    const token = ++generation;
    busy = true;
    candidate = null;
    candidatePlan = null;
    comparison.hidden = true;
    metrics.replaceChildren();
    hooks.optimizationView(null);
    refresh();
    status.textContent = "Preparing the selected original paths…";
    capturedExecution = canonicalJson(hooks.execution());
    try {
      if (join) {
        if (hooks.frozenResult())
          throw new Error(
            "Joining requires a live render. Fitting and ordering work on saved results.",
          );
        context ??= await hooks.client.optimizationContext(source.planHash);
      }
      if (token !== generation || d.sourceRevision !== myRevision) return;
      const execution = hooks.execution();
      const request: OptimizationRequest = {
        buffer: encodePlanBuffer(source.chains.slice(...range)),
        settings: source.settings,
        sourcePlanHash: source.planHash,
        sourceRange: range,
        options: {
          tolerance: fit ? Number(tolerance.value) : 0,
          maxSegment: Number(maxSegment.value),
          cornerDegrees: Number(corner.value),
          gap: join ? Number(gap.value) : 0,
          tourBudget: order ? Number(budget.value) : 0,
        },
        context: join ? context : undefined,
        pens: d.pens.map((p) => ({
          ...p,
          ...execution.pens.find((q) => q.name === p.name),
        })),
        timing: execution.timing as EstimateOpts,
        machineTolerance: execution.tolerance,
      };
      worker = new Worker(
        new URL("./optimization-worker.ts", import.meta.url),
        { type: "module" },
      );
      const owned = worker;
      const fail = (message: string): void => {
        if (token !== generation) return;
        stop();
        status.textContent = message;
        refresh();
      };
      owned.onerror = (e) => fail(e.message);
      owned.onmessage = async ({
        data,
      }: {
        data: { stage?: string; error?: string; result?: OptimizationReply };
      }) => {
        if (token !== generation || d.sourceRevision !== myRevision) return;
        if (data.stage) {
          status.textContent = data.stage;
          return;
        }
        if (data.error) {
          fail(data.error);
          return;
        }
        if (!data.result) return;
        try {
          const result = data.result;
          const plan = await openPlan(
            result.buffer,
            result.settings,
            result.planHash,
          );
          if (token !== generation || d.sourceRevision !== myRevision) return;
          if (capturedExecution !== canonicalJson(hooks.execution())) {
            fail(
              "Machine or pen settings changed. Run again to compare current estimates.",
            );
            return;
          }
          owned.terminate();
          worker = null;
          busy = false;
          candidate = result;
          candidatePlan = plan;
          showMetrics(result);
          comparison.hidden = false;
          status.textContent = result.improved
            ? "Ready to compare. The active drawing is unchanged."
            : "Original retained — none of these alternatives was faster.";
          refresh();
        } catch (e) {
          fail(e instanceof Error ? e.message : String(e));
        }
      };
      const transfer = new Set<ArrayBuffer>([
        request.buffer.buffer as ArrayBuffer,
      ]);
      if (request.context) {
        for (const value of [
          ...Object.values(request.context.scene),
          request.context.prims,
          request.context.frags,
        ]) {
          if (ArrayBuffer.isView(value))
            transfer.add(value.buffer as ArrayBuffer);
        }
      }
      owned.postMessage(request, { transfer: [...transfer] });
      context = undefined;
    } catch (e) {
      if (token === generation) {
        stop();
        status.textContent = e instanceof Error ? e.message : String(e);
        refresh();
      }
    }
  });
  run.classList.add("primary");
  const preview = (mode: "original" | "optimized" | "difference"): void => {
    if (!candidate || !candidatePlan || !d.sourcePlan || !sourceRange) return;
    const chains =
      mode === "original"
        ? d.sourcePlan.chains.slice(...sourceRange)
        : candidatePlan.chains;
    hooks.optimizationView({
      chains,
      before:
        mode === "difference" ? decodePlanBuffer(candidate.before) : undefined,
      after:
        mode === "difference" ? decodePlanBuffer(candidate.after) : undefined,
    });
    status.textContent =
      mode === "difference"
        ? "Comparison only: rose = replaced ink; teal = fitted ink and new joins. Apply to change plotting."
        : `${mode === "original" ? "Original" : "Optimized"} comparison only. Apply to change plotting.`;
  };
  const compare = segmented(
    [
      { key: "original" as const, label: "Original" },
      { key: "optimized" as const, label: "Optimized" },
      { key: "difference" as const, label: "Difference" },
    ],
    "original",
    preview,
  );
  comparison.append(
    hint("Preview only · apply to change plotting"),
    compare.root,
  );

  comparison.hidden = true;
  const adopt = async (
    plan: DrawingPlan,
    restoring: boolean,
  ): Promise<void> => {
    if (hooks.isPlotting?.()) {
      status.textContent = "Stop the physical plot before changing its plan.";
      return;
    }
    if (!restoring && capturedExecution !== canonicalJson(hooks.execution())) {
      status.textContent =
        "Machine or pen settings changed. Run optimization again.";
      return;
    }
    adopting = true;
    refresh();
    try {
      await d.useVariant(plan, revision);
      hooks.optimizationView(null);
      status.textContent = restoring
        ? "Original restored."
        : "Optimized plan active for preview, simulation, export and plotting. Chain repairs cleared.";
    } catch (e) {
      status.textContent = e instanceof Error ? e.message : String(e);
    } finally {
      adopting = false;
      refresh();
    }
  };
  const apply = button("Use optimized", () =>
    candidatePlan ? adopt(candidatePlan, false) : undefined,
  );
  const restore = button("Restore original", () =>
    d.sourcePlan ? adopt(d.sourcePlan, true) : undefined,
  );
  const onChange = (): void => {
    const key = canonicalJson(hooks.execution());
    if (revision !== d.sourceRevision) {
      stop();
      revision = d.sourceRevision;
      candidate = null;
      candidatePlan = null;
      context = undefined;
      sourceRange = null;
      comparison.hidden = true;
      metrics.replaceChildren();
      hooks.optimizationView(null);
      status.textContent = "Runs only when requested.";
    } else if (executionKey && key !== executionKey && candidate) {
      candidate = null;
      candidatePlan = null;
      comparison.hidden = true;
      metrics.replaceChildren();
      hooks.optimizationView(null);
      status.textContent =
        "Machine or pen settings changed. Run again for a current comparison.";
    }
    executionKey = key;
    refresh();
  };
  d.onChange(onChange);
  window.addEventListener("pagehide", () => stop(), { once: true });
  body.append(
    hint(
      "Try changes on the finished drawing. Apply affects plotting and exports.",
    ),
    choices,
    el("div", "row", run, cancel),
    status,
    metrics,
    comparison,
    el("div", "row", apply, restore),
  );
  onChange();
}
