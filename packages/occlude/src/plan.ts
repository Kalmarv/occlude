/**
 * The ordered drawing plan as a value, and selections of it.
 *
 * The engine resolves the drawing once — visibility, finishing, merge,
 * tour, bridge — and encodes the result as one plan buffer with native
 * primitives (`wasm_plan`; layout in crates/occlude-core/src/plan.rs). This
 * module reads that buffer, gives it a content identity, and selects
 * contiguous chain ranges of it. Selection never re-plans: it neither
 * reorders, reverses, merges nor bridges, and it never reruns visibility —
 * dropping later ink does not reveal what it hid.
 *
 * Two questions about time are two operations: `selectTime` cuts an
 * interval of the FULL drawing's timeline (quantized to whole chains);
 * `fitDuration` finds the longest prefix of a selection whose STANDALONE
 * estimate fits a budget — a middle interval pays its own travel-in and
 * final lift, so it is not a difference of two timestamps.
 */

import { schedulePlan, type EstimateOpts, type PenTiming, type PlanEstimate, type PlanSchedule } from './motion.js';
import type { Prim } from './prims.js';

export const PLAN_SCHEMA = 1;

/** One pen-down run of the plan: native primitives, plan order. */
export interface PlanChain {
  /** Row in the FULL plan — the identity every consumer shares. */
  index: number;
  pen: number;
  dot: boolean;
  prims: Prim[];
}

/** What is needed to interpret and identify a plan besides its geometry. */
export interface PlanSettings {
  tourBudget: number;
  pens: { name: string; width: number }[];
  paper: { w: number; h: number };
  /** Sub-nib gap per pen that was drawn through instead of lifted. */
  bridgeGapMm: number[];
  /** Engine identity (build stamp or wasm digest) when the caller has one. */
  engine?: string;
}

export interface DrawingPlan {
  schemaVersion: number;
  /** SHA-256 over the canonical settings and the exact plan bytes. */
  planHash: string;
  chains: PlanChain[];
  settings: PlanSettings;
  /** The exact bytes the engine produced — what exports and saves use. */
  buffer: Float64Array;
}

/** A contiguous, half-open range `[fromChain, toChain)` of ONE exact plan. */
export interface PlanSelection {
  sourcePlanHash: string;
  fromChain: number;
  toChain: number;
  /** `${planHash}:${from}-${to}` — exact, readable, collision-free. */
  selectionHash: string;
  /** Chains selected — so nearby slider values that pick the same range are visible. */
  count: number;
}

// ---- buffer ---------------------------------------------------------------------

export function decodePlanBuffer(buf: Float64Array | number[]): PlanChain[] {
  let i = 0;
  const need = (n: number) => {
    if (i + n > buf.length) throw new Error('plan buffer truncated');
  };
  need(2);
  const schema = buf[i++];
  if (schema !== PLAN_SCHEMA) throw new Error(`plan schema ${schema} is not ${PLAN_SCHEMA}`);
  const n = buf[i++];
  const chains: PlanChain[] = [];
  for (let c = 0; c < n; c++) {
    need(3);
    const pen = buf[i++];
    const dot = buf[i++] !== 0;
    const np = buf[i++];
    const prims: Prim[] = [];
    for (let k = 0; k < np; k++) {
      need(1);
      const kind = buf[i++];
      if (kind === 0) {
        need(4);
        prims.push({ t: 'line', x0: buf[i], y0: buf[i + 1], x1: buf[i + 2], y1: buf[i + 3] });
        i += 4;
      } else if (kind === 1) {
        need(5);
        prims.push({ t: 'arc', cx: buf[i], cy: buf[i + 1], r: buf[i + 2], start: buf[i + 3], sweep: buf[i + 4] });
        i += 5;
      } else if (kind === 2) {
        need(8);
        prims.push({ t: 'cubic', x0: buf[i], y0: buf[i + 1], c0x: buf[i + 2], c0y: buf[i + 3], c1x: buf[i + 4], c1y: buf[i + 5], x1: buf[i + 6], y1: buf[i + 7] });
        i += 8;
      } else throw new Error(`plan buffer: unknown primitive kind ${kind}`);
    }
    if (prims.length === 0) throw new Error('plan buffer: a chain with no primitives');
    chains.push({ index: c, pen, dot, prims });
  }
  if (i !== buf.length) throw new Error('plan buffer: trailing data');
  return chains;
}

/** The inverse of `decodePlanBuffer` — the same bytes the engine writes, so
 * a saved selection is a plan buffer in its own right. */
export function encodePlanBuffer(chains: readonly PlanChain[]): Float64Array {
  const out: number[] = [PLAN_SCHEMA, chains.length];
  for (const c of chains) {
    out.push(c.pen, c.dot ? 1 : 0, c.prims.length);
    for (const p of c.prims) {
      if (p.t === 'line') out.push(0, p.x0, p.y0, p.x1, p.y1);
      else if (p.t === 'arc') out.push(1, p.cx, p.cy, p.r, p.start, p.sweep);
      else out.push(2, p.x0, p.y0, p.c0x, p.c0y, p.c1x, p.c1y, p.x1, p.y1);
    }
  }
  return Float64Array.from(out);
}

/** JSON with keys sorted at every level: one spelling per value. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

const hex = (bytes: ArrayBuffer): string => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');

/** Content identity: SHA-256 of `schema | canonical settings | plan bytes`
 * (little-endian float64). No timestamps, no object identities. */
export async function hashPlan(buffer: Float64Array, settings: PlanSettings): Promise<string> {
  const head = new TextEncoder().encode(`occlude-plan/${PLAN_SCHEMA}\n${canonicalJson(settings)}\n`);
  const body = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const all = new Uint8Array(head.length + body.length);
  all.set(head);
  all.set(body, head.length);
  return hex(await crypto.subtle.digest('SHA-256', all));
}

/** A plan value from the engine's buffer and the settings that made it. */
export async function makePlan(buffer: Float64Array, settings: PlanSettings): Promise<DrawingPlan> {
  const chains = decodePlanBuffer(buffer);
  const planHash = await hashPlan(buffer, settings);
  return { schemaVersion: PLAN_SCHEMA, planHash, chains, settings, buffer };
}

/** Rebuild a plan from saved bytes and verify its identity. */
export async function openPlan(buffer: Float64Array, settings: PlanSettings, expectedHash: string): Promise<DrawingPlan> {
  const plan = await makePlan(buffer, settings);
  if (plan.planHash !== expectedHash) throw new Error(`plan hash mismatch: saved ${expectedHash.slice(0, 12)}…, content ${plan.planHash.slice(0, 12)}…`);
  return plan;
}

// ---- sampled representation ---------------------------------------------------------

/** A chain flattened for machine execution and timing: `[pen, dot, n, x0, y0, …]`
 * per chain is the toolpath layout (`wasm_plan_toolpath`). */
export interface FlatChain {
  index: number;
  pen: number;
  dot: boolean;
  pts: Float64Array;
}

/** The ONE parser of the toolpath layout. `firstIndex` is the full-plan row
 * of the first chain, so a range's chains keep their source indices. */
export function parseToolpath(plan: Float64Array, firstIndex = 0): FlatChain[] {
  const chains: FlatChain[] = [];
  for (let i = 0; i < plan.length; ) {
    const pen = plan[i++];
    const dot = plan[i++] === 1;
    const n = plan[i++];
    chains.push({ index: firstIndex + chains.length, pen, dot, pts: plan.subarray(i, i + n * 2) });
    i += n * 2;
  }
  return chains;
}

/** Back to the toolpath layout — for drivers that take the buffer. */
export function encodeToolpath(chains: readonly FlatChain[]): Float64Array {
  let size = 0;
  for (const c of chains) size += 3 + c.pts.length;
  const out = new Float64Array(size);
  let i = 0;
  for (const c of chains) {
    out[i++] = c.pen;
    out[i++] = c.dot ? 1 : 0;
    out[i++] = c.pts.length / 2;
    out.set(c.pts, i);
    i += c.pts.length;
  }
  return out;
}

// ---- selections -------------------------------------------------------------------

function selection(plan: DrawingPlan, from: number, to: number): PlanSelection {
  return { sourcePlanHash: plan.planHash, fromChain: from, toChain: to, selectionHash: `${plan.planHash}:${from}-${to}`, count: to - from };
}

const finite = (v: number, what: string) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${what} must be a finite number`);
};

/** Whole chains `[from, to)` of the full plan. */
export function selectChains(plan: DrawingPlan, range: { from: number; to: number }): PlanSelection {
  const n = plan.chains.length;
  finite(range.from, 'from');
  finite(range.to, 'to');
  if (!Number.isInteger(range.from) || !Number.isInteger(range.to)) throw new Error('chain indices must be integers');
  if (range.from < 0 || range.to > n || range.from > range.to) throw new Error(`chain range [${range.from}, ${range.to}) is not within 0..${n} in order`);
  return selection(plan, range.from, range.to);
}

/** The full plan `[0, N)`. */
export function selectAll(plan: DrawingPlan): PlanSelection {
  return selection(plan, 0, plan.chains.length);
}

/** By FRACTION OF CHAINS (not ink, area or time): boundaries resolve to
 * `floor(f · N)`, and 1 resolves to N. */
export function selectProgress(plan: DrawingPlan, range: { from: number; to: number }): PlanSelection {
  finite(range.from, 'from');
  finite(range.to, 'to');
  if (range.from < 0 || range.to > 1 || range.from > range.to) throw new Error(`progress range [${range.from}, ${range.to}) is not within 0..1 in order`);
  const n = plan.chains.length;
  const at = (f: number) => (f >= 1 ? n : Math.floor(f * n));
  return selection(plan, at(range.from), at(range.to));
}

/** The plan's timeline through the shared estimator. */
export function planSchedule(chains: readonly FlatChain[], penOf: (pen: number) => PenTiming | undefined, timing: EstimateOpts): PlanSchedule {
  return schedulePlan(chains, penOf, timing);
}

export interface TimeSelection {
  selection: PlanSelection;
  /** Requested interval, ms of the FULL plan's timeline. */
  requested: { fromMs: number; toMs: number };
  /** Where the boundaries actually fell: completion times of the last chain
   * before `from` and of the last chain in the range (0 / 0 when empty). */
  effective: { fromMs: number; toMs: number };
}

/** An interval of the FULL drawing's timeline, quantized to completed
 * chains: with B(t) = chains fully completed by time t, the range is
 * `[B(fromMs), B(toMs))`. Ties include every chain completing exactly at
 * t; `fromMs === 0` is special-cased to 0 so zero-duration chains at the
 * start are never lost. A chain the interval ends inside is excluded. The
 * start may resolve EARLIER than asked — quantization, not clipping. */
export function selectTime(
  plan: DrawingPlan,
  flat: readonly FlatChain[],
  range: { fromMs: number; toMs: number },
  schedule: PlanSchedule,
): TimeSelection {
  finite(range.fromMs, 'fromMs');
  finite(range.toMs, 'toMs');
  if (flat.length !== plan.chains.length) throw new Error('selectTime: the toolpath does not cover the whole plan');
  const total = schedule.estimate.totalMs;
  if (range.fromMs < 0 || range.toMs > total + 1e-9 || range.fromMs > range.toMs) {
    throw new Error(`time range [${range.fromMs}, ${range.toMs}) ms is not within 0..${Math.round(total)} in order`);
  }
  const done = schedule.chainStartMs.map((s, i) => s + schedule.chainDurMs[i]);
  const completedBy = (t: number) => {
    let k = 0;
    while (k < done.length && done[k] <= t + 1e-9) k++;
    return k;
  };
  const from = range.fromMs === 0 ? 0 : completedBy(range.fromMs);
  const to = completedBy(range.toMs);
  const sel = selection(plan, from, to);
  return {
    selection: sel,
    requested: { fromMs: range.fromMs, toMs: range.toMs },
    effective: { fromMs: from > 0 ? done[from - 1] : 0, toMs: to > 0 ? done[to - 1] : 0 },
  };
}

/** The flattened chains of a selection, source indices kept. */
export function selectedFlat(flat: readonly FlatChain[], sel: PlanSelection): FlatChain[] {
  return flat.slice(sel.fromChain, sel.toChain);
}

/** Estimated time to execute the selection ON ITS OWN: travel from the
 * origin to its first chain, the plan's travel between its chains, a
 * final rise to full lift. Not a difference of full-plan timestamps. */
export function standaloneEstimate(flat: readonly FlatChain[], sel: PlanSelection, penOf: (pen: number) => PenTiming | undefined, timing: EstimateOpts): PlanEstimate {
  return schedulePlan(selectedFlat(flat, sel), penOf, timing).estimate;
}

export interface FitResult {
  selection: PlanSelection;
  /** Standalone estimate of the fitted prefix, ms. */
  estimatedMs: number;
  unusedMs: number;
  /** Chains dropped from the end of the selection to fit. */
  dropped: number;
}

/** The longest prefix of `sel` (starting at its first chain, never
 * elsewhere) whose standalone estimate fits `budgetMs`. Priced from ONE
 * schedule of the selection: a prefix of k chains costs the schedule up to
 * chain k−1 with that chain's up-settle re-priced at full lift (the
 * terminal rule), which is exactly what a fresh estimate of the prefix
 * gives — verified against direct estimates in the tests. O(points) once
 * plus O(k) for the scan; no monotonicity assumed. Budget 0, or a first
 * chain that alone exceeds the budget, gives an empty selection. */
export function fitDuration(
  plan: DrawingPlan,
  flat: readonly FlatChain[],
  sel: PlanSelection,
  opts: { budgetMs: number },
  penOf: (pen: number) => PenTiming | undefined,
  timing: EstimateOpts,
): FitResult {
  finite(opts.budgetMs, 'budgetMs');
  if (opts.budgetMs < 0) throw new Error('budgetMs must be non-negative');
  if (sel.sourcePlanHash !== plan.planHash) throw new Error('fitDuration: the selection belongs to another plan');
  const mine = selectedFlat(flat, sel);
  const sched = schedulePlan(mine, penOf, timing);
  let best = 0;
  let bestMs = 0;
  for (let k = 1; k <= mine.length; k++) {
    const i = k - 1;
    const ms = sched.chainStartMs[i] + sched.chainDurMs[i] - sched.chainUpMs[i] + sched.chainUpFullMs[i];
    if (ms <= opts.budgetMs + 1e-9) {
      best = k;
      bestMs = ms;
    }
  }
  const fitted = selection(plan, sel.fromChain, sel.fromChain + best);
  return { selection: fitted, estimatedMs: bestMs, unusedMs: opts.budgetMs - bestMs, dropped: sel.count - best };
}

/** Full-plan bounds of a set of flattened chains (paper mm). */
export function chainsBounds(chains: readonly FlatChain[]): { x: number; y: number; w: number; h: number } {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const c of chains) {
    for (let k = 0; k < c.pts.length; k += 2) {
      const x = c.pts[k];
      const y = c.pts[k + 1];
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  if (!Number.isFinite(x0)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
