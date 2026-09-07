/**
 * The studio's ordered-drawing state: ONE plan per successful render and
 * the sketch's own `t.draw({...})` request resolved against it, with the
 * sampled toolpath cached per tolerance. Every asynchronous answer is
 * bound to the plan hash it was asked for, so a reply for an old render
 * can never dress a new plan. Nothing here reruns the sketch, the solver
 * or the tour: a selection slices the plan the worker already holds.
 */

import {
  openPlan, parseToolpath, resolveDraw, selectAll,
  type DrawRequest, type DrawingPlan, type EstimateOpts, type FlatChain, type PenTiming, type PlanSelection, type PlanSettings, type PlanSchedule, type PenDef, type ResolvedDraw,
  planSchedule,
} from 'occlude';
import type { RenderClient } from './workerClient.js';
import type { MachineProfile } from './store.js';

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
  /** The render's pens (plan pen indices refer to these). */
  pens: PenDef[] = [];
  /** The sketch's request, as rendered. */
  request: DrawRequest = {};
  /** Preview aid only: ghost the omitted ink. Never enters exports. */
  showOmitted = true;
  private flat = new Map<string, Promise<FlatChain[]>>();
  private listeners: (() => void)[] = [];
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
    const plan = await openPlan(reply.buffer, reply.settings, reply.planHash);
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
      p.catch(() => this.flat.delete(key));
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
    this.resolved = resolveDraw(plan, this.request, { flat, penOf: t.penOf, opts: t.opts });
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
