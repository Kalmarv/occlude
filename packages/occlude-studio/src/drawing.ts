/**
 * The studio's ordered-drawing state: ONE plan per successful render and
 * the sketch's own `t.draw({...})` request resolved against it, with the
 * sampled toolpath cached per tolerance. Every asynchronous answer is
 * bound to the plan hash it was asked for, so a reply for an old render
 * can never dress a new plan. Nothing here reruns the sketch, the solver
 * or the tour: a selection slices the plan the worker already holds.
 */

import {
  openPlan, parseToolpath, resolveDraw, selectAll, selectChains,
  type DrawRequest, type DrawingPlan, type EstimateOpts, type FlatChain, type PenTiming, type PlanSelection, type PlanSettings, type PlanSchedule, type PenDef, type ResolvedDraw,
  planSchedule,
} from 'occlude';
import type { RenderClient } from './workerClient.js';
import type { MachineProfile } from './store.js';

/** One brush dab of a region repair, paper mm. */
export interface RegionBlob {
  x: number;
  y: number;
  r: number;
}

/** A stable fingerprint of an executed chain list: what a resume must match. */
export function chainsFingerprint(indices: readonly number[]): string {
  let h = 2166136261;
  for (const i of indices) {
    h ^= i;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return `${indices.length}:${h.toString(16)}`;
}

/** Chains whose centerline (or tap center) touches any brush disc. */
export function chainsUnder(flat: readonly FlatChain[], blobs: readonly RegionBlob[], from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i < to; i++) {
    const c = flat[i];
    if (!c) continue;
    const pts = c.pts;
    let hit = false;
    for (let k = 0; k < pts.length && !hit; k += 2) {
      const x = pts[k];
      const y = pts[k + 1];
      const ax = k > 0 && !c.dot ? pts[k - 2] : x;
      const ay = k > 0 && !c.dot ? pts[k - 1] : y;
      const sx = x - ax;
      const sy = y - ay;
      const length2 = sx * sx + sy * sy;
      for (const b of blobs) {
        const t = length2 > 0 ? Math.max(0, Math.min(1, ((b.x - ax) * sx + (b.y - ay) * sy) / length2)) : 0;
        const dx = ax + t * sx - b.x;
        const dy = ay + t * sy - b.y;
        if (dx * dx + dy * dy <= b.r * b.r) { hit = true; break; }
      }
    }
    if (hit) out.push(i);
  }
  return out;
}

/** THE timing model inputs for a machine profile — one spelling for the
 * export table, the simulation, the plot driver and the drawing readout. */
export function machineTiming(prof: MachineProfile): EstimateOpts {
  return {
    travelFeed: prof.machine.travelFeed,
    acceleration: prof.ebb.acceleration,
    travelAcceleration: prof.ebb.travelAcceleration,
    junctionDeviation: prof.ebb.junctionDeviation,
    minimumCruiseRatio: prof.ebb.minimumCruiseRatio,
    lift: {
      penUpPulse: prof.ebb.penUpPulse,
      map: prof.ebb.liftMap,
      marginPulses: prof.ebb.liftMarginPulses,
      settleCurve: prof.ebb.settleCurve,
    },
  };
}

/** Pen timing by plan pen index: the render's pens, overridden by the
 * library's current definition of the same name (feed edits apply). */
export function penTimingOf(renderPens: readonly PenDef[], library: readonly PenDef[]): (pen: number) => PenTiming | undefined {
  return (i) => {
    const base = renderPens[i];
    const pen = (base && library.find((p) => p.name === base.name)) ?? base;
    return pen ? { feed: pen.feed, penDelay: pen.penDelay } : undefined;
  };
}

/** Flattening tolerance for machine work: the profile's resolution, never
 * coarser than a quarter nib of the finest pen in play. */
export function machineTolerance(prof: MachineProfile, pens: readonly PenDef[]): number {
  const penTol = pens.reduce((t, p) => Math.min(t, p.width / 4), Infinity);
  return Math.max(0.0001, Math.min(prof.machine.resolution, penTol));
}

export class Drawing {
  plan: DrawingPlan | null = null;
  /** Immutable render result; an accepted optimization never replaces it. */
  sourcePlan: DrawingPlan | null = null;
  sourceRequest: DrawRequest = {};
  sourceRevision = 0;
  get isVariant(): boolean { return this.plan !== this.sourcePlan; }
  /** The render's pens (plan pen indices refer to these). */
  pens: PenDef[] = [];
  /** The sketch's request, as rendered. */
  request: DrawRequest = {};
  /** Preview aid only: ghost the omitted ink. Never enters exports. */
  showOmitted = true;
  /** The repair: plot only this interval of the plan's timeline, in minutes,
   * on top of the sketch's own request — studio state for redoing part of
   * one sheet, never written to the source. Kept across re-renders and
   * re-resolved against each new plan. */
  repair: [number, number] | null = null;
  private repaired: PlanSelection | null = null;
  /** The region repair: blobs painted over the preview, paper mm. A chain
   * is in when any of its ink lies under a blob. Combines with the
   * interval: both narrow. */
  region: RegionBlob[] | null = null;
  private flat = new Map<string, Promise<FlatChain[]>>();
  private listeners: (() => void)[] = [];
  private repairListeners: (() => void)[] = [];
  private resolved: ResolvedDraw | null = null;
  /** The resolution in flight for the current plan, if any. */
  private pending: Promise<ResolvedDraw | null> | null = null;

  constructor(
    private client: RenderClient,
    /** Timing inputs of the active machine profile, read when needed. */
    private timing: () => { opts: EstimateOpts; penOf: (pen: number) => PenTiming | undefined; tolerance: number },
  ) {}

  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  /** A render landed: adopt its plan (verified) and the sketch's request. */
  async setPlan(reply: { buffer: Float64Array; settings: PlanSettings; planHash: string }, pens: PenDef[], request: DrawRequest = {}): Promise<void> {
    const revision = ++this.sourceRevision;
    const plan = await openPlan(reply.buffer, reply.settings, reply.planHash);
    if (revision !== this.sourceRevision) return;
    this.sourcePlan = plan;
    this.sourceRequest = request;
    await this.installPlan(plan, pens, request);
  }

  /** Atomically adopt a candidate in the export worker and every consumer.
   * Chain-index repairs cannot be carried through joins/reordering. */
  async useVariant(plan: DrawingPlan, revision: number): Promise<void> {
    if (revision !== this.sourceRevision || !this.plan) throw new Error('The drawing changed. Run optimization again.');
    const expected = this.plan.planHash;
    await this.client.loadPlan(plan.buffer, plan.settings, plan.planHash, this.pens, expected);
    if (revision !== this.sourceRevision) throw new Error('The drawing changed. Run optimization again.');
    this.repair = null; this.repaired = null; this.region = null;
    await this.installPlan(plan, this.pens, plan === this.sourcePlan ? this.sourceRequest : {});
    for (const fn of this.repairListeners) fn();
  }

  private async installPlan(plan: DrawingPlan, pens: PenDef[], request: DrawRequest): Promise<void> {
    // Only the current drawing owns cached toolpaths. Repeating an identical
    // plan can share them, but editing must not retain every prior drawing.
    if (this.plan?.planHash !== plan.planHash) this.flat.clear();
    this.flatNow = null;
    this.plan = plan;
    this.pens = pens;
    this.request = request;
    this.resolved = null;
    this.pending = this.resolve();
    await this.pending;
  }

  /** The selection once the current plan's request has resolved. Never
   * a stand-in: while resolution is pending this waits, and with no plan
   * it throws. */
  async settled(): Promise<PlanSelection> {
    if (!this.plan) throw new Error('nothing rendered yet');
    if (this.pending) await this.pending;
    const sel = this.selection;
    if (!sel) throw new Error('the drawing selection is not resolved yet');
    return sel;
  }

  get current(): ResolvedDraw | null {
    return this.resolved;
  }

  /** The selection every consumer draws, exports and plots — null until
   * the request has resolved against the current plan (never "everything"
   * as a stand-in: an export during that window would take all chains). */
  get selection(): PlanSelection | null {
    if (!this.plan || !this.resolved) return null;
    return this.resolved.final;
  }

  /** What the machine plots: the sketch's selection narrowed by the repair
   * when one is set. Exports keep drawing the sketch's selection. */
  get plotSelection(): PlanSelection | null {
    return this.repaired ?? this.selection;
  }

  onRepairChange(fn: () => void): void {
    this.repairListeners.push(fn);
  }

  /** Set (or clear) the repair interval, minutes of the plan's timeline. */
  setRepair(minutes: [number, number] | null): void {
    this.repair = minutes;
    this.applyRepair();
    for (const fn of this.repairListeners) fn();
  }

  /** Set (or clear) the region repair. */
  setRegion(blobs: RegionBlob[] | null): void {
    this.region = blobs && blobs.length ? blobs : null;
    for (const fn of this.repairListeners) fn();
  }

  /** Both repairs at once (a resume restoring a record). */
  setRepairs(minutes: [number, number] | null, blobs: RegionBlob[] | null): void {
    this.repair = minutes;
    this.region = blobs && blobs.length ? blobs : null;
    this.applyRepair();
    for (const fn of this.repairListeners) fn();
  }

  /** Source indices of the chains the machine plots: the selection, narrowed
   * by the interval and by the region. Null until resolved. */
  plotIndices(): number[] | null {
    const base = this.plotSelection;
    if (!base || !this.flatNow) return null;
    if (this.region) return chainsUnder(this.flatNow, this.region, base.fromChain, base.toChain);
    const out: number[] = [];
    for (let i = base.fromChain; i < base.toChain; i++) out.push(i);
    return out;
  }

  /** What a plot record stores and a resume checks: the executed set's identity. */
  plotFingerprint(): string | null {
    const idx = this.plotIndices();
    return idx ? chainsFingerprint(idx) : null;
  }

  /** Whether any repair narrows the plot right now. */
  get repairing(): boolean {
    return this.repaired !== null || this.region !== null;
  }

  private applyRepair(): void {
    const plan = this.plan;
    const sel = this.selection;
    if (!plan || !sel || !this.repair) {
      this.repaired = null;
      return;
    }
    // Resolve the interval like a `minutes` request, then intersect with the
    // sketch's own selection: the repair can only narrow what it would plot.
    this.repaired = this.repairFor(plan, sel, this.repair);
  }

  private repairFor(plan: DrawingPlan, sel: PlanSelection, minutes: [number, number]): PlanSelection {
    const flat = this.flatNow;
    if (!flat) return sel;
    const t = this.timing();
    const r = resolveDraw(plan, { minutes: [Math.max(0, minutes[0]), Math.max(minutes[0], minutes[1])] }, { flat, penOf: t.penOf, opts: t.opts }).final;
    const from = Math.max(sel.fromChain, r.fromChain);
    const to = Math.min(sel.toChain, r.toChain);
    return selectChains(plan, { from: Math.min(from, to), to });
  }

  /** The repair's resolved interval for a readout, or null. */
  repairInfo(): { fromChain: number; toChain: number; count: number; totalMs: number } | null {
    if (!this.repaired || !this.resolved) return null;
    return { fromChain: this.repaired.fromChain, toChain: this.repaired.toChain, count: this.repaired.count, totalMs: this.resolved.fullMs ?? 0 };
  }

  private flatNow: FlatChain[] | null = null;

  /** Sampled chains of the WHOLE plan at the machine tolerance, cached per
   * (plan, tolerance); the request carries the plan hash it is for. */
  toolpath(tolerance = this.timing().tolerance): Promise<FlatChain[]> {
    const plan = this.plan;
    if (!plan) return Promise.reject(new Error('nothing rendered yet'));
    const key = `${plan.planHash}:${tolerance}`;
    let p = this.flat.get(key);
    if (!p) {
      p = this.client
        .planToolpath({ planHash: plan.planHash, from: 0, to: plan.chains.length }, tolerance)
        .then((buf) => parseToolpath(buf, 0));
      this.flat.set(key, p);
      p.catch(() => {
        // A retime or plan replacement may already have installed a new
        // request under this key by the time the obsolete one fails.
        if (this.flat.get(key) === p) this.flat.delete(key);
      });
    }
    return p;
  }

  /** The selected chains, sampled, source indices kept. Waits for the
   * selection to resolve. */
  async selectedToolpath(tolerance?: number): Promise<FlatChain[]> {
    if (!this.plan) return [];
    const sel = await this.settled();
    const flat = await this.toolpath(tolerance);
    return flat.slice(sel.fromChain, sel.toChain);
  }

  /** The chains the machine plots: the selection narrowed by the repairs. */
  async plotToolpath(tolerance?: number): Promise<FlatChain[]> {
    if (!this.plan) return [];
    await this.settled();
    const flat = await this.toolpath(tolerance);
    const idx = this.plotIndices();
    if (!idx) return [];
    return idx.map((i) => flat[i]);
  }

  async schedule(): Promise<PlanSchedule> {
    const flat = await this.toolpath();
    const t = this.timing();
    return planSchedule(flat, t.penOf, t.opts);
  }

  private async resolve(): Promise<ResolvedDraw | null> {
    const plan = this.plan;
    if (!plan) return null;
    const flat = await this.toolpath();
    if (this.plan !== plan) return this.resolved; // a newer plan landed meanwhile
    const t = this.timing();
    this.flatNow = flat;
    this.resolved = resolveDraw(plan, this.request, { flat, penOf: t.penOf, opts: t.opts });
    this.applyRepair();
    this.pending = null;
    this.notify();
    return this.resolved;
  }

  /** Timing inputs changed (profile switch, pen edit): same request, new numbers. */
  async retime(): Promise<void> {
    this.flat.clear();
    this.resolved = null;
    this.pending = this.resolve();
    await this.pending;
  }

  /** The resolved range of the current plan; throws while unresolved. */
  range(): { planHash: string; from: number; to: number } {
    const plan = this.plan;
    if (!plan) throw new Error('nothing rendered yet');
    const sel = this.selection;
    if (!sel) throw new Error('the drawing selection is not resolved yet');
    return { planHash: plan.planHash, from: sel.fromChain, to: sel.toChain };
  }

  /** SVG of the resolved selection (waits for resolution). */
  async svg(background: string | undefined, onlyPen = -1): Promise<string> {
    await this.settled();
    return this.svgOf(this.range(), background, onlyPen);
  }

  /** SVG of an explicit range of an explicit plan — for a save that must
   * not drift to a newer render; the worker refuses a stale hash. */
  svgOf(range: { planHash: string; from: number; to: number }, background: string | undefined, onlyPen = -1): Promise<string> {
    const plan = this.plan;
    if (!plan) throw new Error('nothing rendered yet');
    return this.client.planSvg(range, plan.settings.paper.w, plan.settings.paper.h, background, onlyPen);
  }

  async gcode(profileJson: string): Promise<string> {
    await this.settled();
    return this.client.planGcode(this.range(), profileJson);
  }
}
