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

/** The path-optimization inputs of a plan — the only knobs planning has.
 * `optimize`: the 2-opt tour budget (`false` = nearest-neighbour order
 * only, a number overrides, default 200 000). `bridge`: draw through
 * sub-nib gaps instead of lifting — `false` never, a number is the gap
 * in mm for every pen, default half the nib per pen. A sketch states
 * them with `t.plan({...})`; `plan(result, opts)` takes them directly. */
export interface PlanOptions {
  optimize?: boolean | number;
  bridge?: boolean | number;
}

/** What part of the ordered plan a sketch asks to be drawn — code, so
 * the same program and seed give the same ink. Exactly one range form:
 * `chains` (whole chains, half-open), `progress` (a FRACTION OF CHAINS,
 * not ink or time), or `minutes` (an interval of the full plan's
 * estimated timeline, quantized to completed chains — needs a machine's
 * timing). `budget` (minutes) then keeps the longest prefix of that
 * range whose standalone estimate fits. Empty = the whole plan. */
export interface DrawRequest {
  chains?: [number, number];
  progress?: [number, number];
  minutes?: [number, number];
  budget?: number;
}

const pair = (v: unknown, what: string): [number, number] => {
  if (!Array.isArray(v) || v.length !== 2 || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) throw new Error(`draw: ${what} must be [from, to] finite numbers`);
  if (v[0] > v[1]) throw new Error(`draw: ${what} from ${v[0]} exceeds to ${v[1]}`);
  return [v[0], v[1]];
};

/** Validate a sketch's request; the same object comes back normalized. */
export function checkDrawRequest(req: DrawRequest): DrawRequest {
  if (typeof req !== 'object' || req === null) throw new Error('draw: expected { chains | progress | minutes, budget? }');
  const forms = (['chains', 'progress', 'minutes'] as const).filter((k) => req[k] !== undefined);
  if (forms.length > 1) throw new Error(`draw: give one of chains, progress or minutes, not ${forms.join(' and ')}`);
  const out: DrawRequest = {};
  if (req.chains) {
    const c = pair(req.chains, 'chains');
    if (!Number.isInteger(c[0]) || !Number.isInteger(c[1]) || c[0] < 0) throw new Error('draw: chains must be non-negative integers');
    out.chains = c;
  }
  if (req.progress) {
    const p = pair(req.progress, 'progress');
    if (p[0] < 0 || p[1] > 1) throw new Error('draw: progress must lie within [0, 1]');
    out.progress = p;
  }
  if (req.minutes) {
    const m = pair(req.minutes, 'minutes');
    if (m[0] < 0) throw new Error('draw: minutes must be non-negative');
    out.minutes = m;
  }
  if (req.budget !== undefined) {
    if (typeof req.budget !== 'number' || !Number.isFinite(req.budget) || req.budget < 0) throw new Error('draw: budget must be a non-negative number of minutes');
    out.budget = req.budget;
  }
  for (const k of Object.keys(req)) if (!['chains', 'progress', 'minutes', 'budget'].includes(k)) throw new Error(`draw: unknown option '${k}'`);
  return out;
}

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

/** Timing a request by minutes or budget needs: the plan's sampled
 * chains and the machine's estimator inputs. */
export interface DrawTiming {
  flat: readonly FlatChain[];
  penOf: (pen: number) => PenTiming | undefined;
  opts: EstimateOpts;
}

export interface ResolvedDraw {
  request: DrawRequest;
  /** Before any budget fitting. */
  selection: PlanSelection;
  effective?: { fromMs: number; toMs: number };
  fit?: FitResult & { budgetMs: number };
  /** The selection every consumer uses: fitted when a budget was given. */
  final: PlanSelection;
  /** Standalone estimate of `final` and the whole plan's, when timed. */
  estimate?: PlanEstimate;
  fullMs?: number;
}

/** Resolve a sketch's `draw` request against a plan. Chain and progress
 * forms need nothing else; minutes and budget need `timing`, and throw
 * without it (the machine's clock is not the sketch's to know). A chain
 * range past the plan's end clamps; the plan is never changed. */
export function resolveDraw(plan: DrawingPlan, req: DrawRequest | undefined, timing?: DrawTiming): ResolvedDraw {
  const r = checkDrawRequest(req ?? {});
  const n = plan.chains.length;
  const needsTime = r.minutes !== undefined || r.budget !== undefined;
  if (needsTime && !timing) throw new Error('draw: a range in minutes or a budget needs the machine timing (pass timing, or choose chains / progress)');
  if (timing && timing.flat.length !== n) throw new Error('draw: the toolpath does not cover the whole plan');
  let selection: PlanSelection;
  let effective: ResolvedDraw['effective'];
  let schedule: PlanSchedule | undefined;
  const scheduled = () => (schedule ??= schedulePlan(timing!.flat, timing!.penOf, timing!.opts));
  if (r.chains) selection = selectChains(plan, { from: Math.min(r.chains[0], n), to: Math.min(r.chains[1], n) });
  else if (r.progress) selection = selectProgress(plan, { from: r.progress[0], to: r.progress[1] });
  else if (r.minutes) {
    const total = scheduled().estimate.totalMs;
    const t = selectTime(plan, timing!.flat, { fromMs: Math.min(r.minutes[0] * 60_000, total), toMs: Math.min(r.minutes[1] * 60_000, total) }, scheduled());
    selection = t.selection;
    effective = t.effective;
  } else selection = selectAll(plan);
  let fit: ResolvedDraw['fit'];
  if (r.budget !== undefined) {
    const budgetMs = r.budget * 60_000;
    fit = { ...fitDuration(plan, timing!.flat, selection, { budgetMs }, timing!.penOf, timing!.opts), budgetMs };
  }
  const final = fit?.selection ?? selection;
  const out: ResolvedDraw = { request: r, selection, effective, fit, final };
  if (timing) {
    out.estimate = standaloneEstimate(timing.flat, final, timing.penOf, timing.opts);
    out.fullMs = scheduled().estimate.totalMs;
  }
  return out;
}

/** A plan value from bytes whose identity is already known or not needed
 * (an export inside one process): the sync half of `makePlan`. */
export function planValue(buffer: Float64Array, settings: PlanSettings, planHash: string): DrawingPlan {
  return { schemaVersion: PLAN_SCHEMA, planHash, chains: decodePlanBuffer(buffer), settings, buffer };
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
