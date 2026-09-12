/**
 * Main-thread side of the render worker. The worker owns the whole sketch
 * runtime, so a render request is just source + config — no scene ever
 * exists on this thread. Render requests coalesce: while one is in flight,
 * only the newest queued request survives — a typing burst never builds a
 * backlog, and superseded calls resolve to null. A render is atomic from
 * the worker's perspective; the watchdog is the only hard interruption.
 */

import { decodeRender, pensToJson, type DrawRequest, type EncodedScene, type InspectionEntry, type InspectionPayload, type PenDef, type PlanSettings, type ProbeSummary, type RenderResult } from 'occlude';
import type { RunConfig } from './runner.js';

/** A run's addressed draws: address, unit float, and what the call made of it. */
export interface RenderDraws {
  addrs: string[];
  f: Float64Array;
  values: (number | boolean | null)[];
}

export interface RenderRequest {
  js: string;
  cfg: RunConfig;
}

/** A render carrying its worker-side seed (the main thread has no sketch
 * state to read it from anymore). */
export interface RenderReply {
  result: RenderResult;
  /** The seed as used: base plus the overrides that landed, one string. */
  seedUsed: string;
  /** Overrides the run used, and those naming addresses the source no longer has. */
  overrides: { hit: string[]; dropped: string[] };
  /** The run's addressed draws, when asked for (`cfg.draws`). */
  draws?: RenderDraws;
  /** `t.probe()` readouts from this run. */
  probes: Record<string, ProbeSummary>;
  /** The ordered plan of this render: exact bytes, settings, identity. */
  plan: { buffer: Float64Array; settings: PlanSettings; planHash: string };
  /** The sketch's `t.draw({...})`, if it made one. */
  draw?: DrawRequest;
  /** Identity of this execution in the worker: what an inspection request names. */
  executionId: number;
  /** `t.inspect()` registrations (names and sizes), when inspection was on. */
  inspections: InspectionEntry[];
}

/** A contiguous range of one plan, named by the plan's hash. */
export interface PlanRange {
  planHash: string;
  from: number;
  to: number;
}

/** Worker errors carry the sketch flag when execution (not geometry)
 * failed, plus the stack the editor's runtime marker parses. */
export interface WorkerError extends Error {
  sketch?: boolean;
}

interface Pending {
  resolve(value: unknown): void;
  reject(err: Error): void;
  isRender?: boolean;
}

/** A render that takes this long is a runaway (a wedged sketch loop,
 * sub-mm spacings, huge counts): kill the worker rather than let it eat
 * memory. Sketch execution lives in the worker too now, so this watchdog
 * replaces the old main-thread crash sentinel. */
const RENDER_TIMEOUT_MS = 20_000;
/** A newer request arriving while a render has already run this long
 * pre-empts it: the worker is respawned and the new request runs at once.
 * That is what makes ctrl+z a cancel — undo the change, the previous code
 * renders now, not after the runaway's 20 s. Short renders are left to
 * finish, so ordinary typing never pays the respawn. */
const PREEMPT_AFTER_MS = 1_500;

export class RenderClient {
  private worker!: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private inFlightRender = false;
  private inFlightSince = 0;
  private queuedRender: { req: RenderRequest; p: Pending } | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.spawn();
  }

  private spawn(): void {
    this.worker = new Worker(new URL('./render-worker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker.onmessage = (e) => this.onMessage(e.data);
    this.worker.onerror = (e) => {
      for (const p of this.pending.values()) p.reject(new Error(e.message));
      this.pending.clear();
      this.inFlightRender = false;
    };
  }

  /** Watchdog fired: the worker is wedged (runaway sketch loop or a
   * runaway parameter). Terminate it — wasm state, sketch runtime, asset
   * cache and all — and start fresh; every render request carries the full
   * source + config, so a fresh worker self-heals on the next run. */
  private respawnStuckWorker(): void {
    this.worker.terminate();
    const err = new Error(
      `render timed out after ${RENDER_TIMEOUT_MS / 1000}s — likely a runaway ` +
        'loop or parameter (tiny spacing/step or a huge count); the renderer was restarted',
    );
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    this.inFlightRender = false;
    this.watchdog = null;
    this.spawn();
    // The change made while the runaway was rendering is not lost: it runs
    // on the fresh worker. The timed-out request itself is never retried.
    const queued = this.queuedRender;
    this.queuedRender = null;
    if (queued) this.sendRender(queued.req, queued.p);
  }

  /** Terminate the worker and settle anything outstanding. The Sketches
   * page spins up a client per lightbox; without this each one leaks a
   * worker (and its wasm instance) for the life of the page. */
  dispose(): void {
    if (this.watchdog) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
    this.worker.terminate();
    const err = new Error('render client disposed');
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    this.inFlightRender = false;
    this.queuedRender?.p.resolve(null);
    this.queuedRender = null;
  }

  private onMessage(msg: {
    type: string;
    id: number;
    [k: string]: unknown;
  }): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.type === 'render' || (msg.type === 'error' && p.isRender)) {
      if (this.watchdog) {
        clearTimeout(this.watchdog);
        this.watchdog = null;
      }
      this.inFlightRender = false;
      if (this.queuedRender) {
        const { req, p: qp } = this.queuedRender;
        this.queuedRender = null;
        this.sendRender(req, qp);
      }
    }
    if (msg.type === 'error') {
      const err = new Error(String(msg.message)) as WorkerError;
      if (typeof msg.stack === 'string') err.stack = msg.stack;
      if (msg.sketch === true) err.sketch = true;
      p.reject(err);
      return;
    }
    p.resolve(msg);
  }

  /** Abandon the render in flight (it is superseded, not failed): kill the
   * worker, settle everything outstanding, start fresh. */
  private preempt(): void {
    this.worker.terminate();
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
    const gone = new Error('render abandoned — the renderer was restarted for a newer request');
    for (const p of this.pending.values()) {
      if (p.isRender) p.resolve(null); // superseded, like a queued request
      else p.reject(gone);
    }
    this.pending.clear();
    this.inFlightRender = false;
    this.queuedRender?.p.resolve(null);
    this.queuedRender = null;
    this.spawn();
  }

  private sendRender(req: RenderRequest, p: Pending): void {
    const id = this.nextId++;
    p.isRender = true;
    this.pending.set(id, p);
    this.inFlightRender = true;
    this.inFlightSince = performance.now();
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => this.respawnStuckWorker(), RENDER_TIMEOUT_MS);
    this.worker.postMessage({ type: 'render', id, js: req.js, cfg: req.cfg });
  }

  /** Run + render a sketch. Resolves null when superseded by a newer request. */
  render(req: RenderRequest): Promise<RenderReply | null> {
    return new Promise((resolve, reject) => {
      const p: Pending = {
        resolve: (msg) => {
          if (msg === null) {
            resolve(null); // superseded by a newer request
            return;
          }
          const m = msg as {
            prims: Float64Array;
            frags: Float64Array;
            stats: Float64Array;
            renderMs: number;
            pens: EncodedScene['pens'];
            frame: EncodedScene['frame'];
            paper: EncodedScene['paper'];
            seedUsed: string;
            overrides?: { hit: string[]; dropped: string[] };
            draws?: RenderDraws;
            probes: Record<string, ProbeSummary>;
            plan: Float64Array;
            planSettings: PlanSettings;
            planHash: string;
            draw?: DrawRequest;
            executionId: number;
            inspections?: InspectionEntry[];
          };
          // decodeRender reads only pens/frame/paper from the scene half.
          const meta = { pens: m.pens, frame: m.frame, paper: m.paper } as EncodedScene;
          resolve({
            result: decodeRender(meta, m), seedUsed: m.seedUsed, overrides: m.overrides ?? { hit: [], dropped: [] }, draws: m.draws, probes: m.probes ?? {},
            plan: { buffer: m.plan, settings: m.planSettings, planHash: m.planHash },
            draw: m.draw,
            executionId: m.executionId,
            inspections: m.inspections ?? [],
          });
        },
        reject,
      };
      if (this.inFlightRender && performance.now() - this.inFlightSince > PREEMPT_AFTER_MS) {
        this.preempt();
      }
      if (this.inFlightRender) {
        this.queuedRender?.p.resolve(null);
        this.queuedRender = { req, p };
        return;
      }
      this.sendRender(req, p);
    });
  }

  /** G-code jobs (JSON) of a plan range — encoded from the worker's plan,
   * never planned again; rejects when the hash is not the current plan. */
  planGcode(range: PlanRange, profileJson: string): Promise<string> {
    return this.request({ type: 'plan-gcode', ...range, profileJson }, 'json');
  }

  planSvg(range: PlanRange, width: number, height: number, background: string | undefined, onlyPen = -1): Promise<string> {
    return this.request({ type: 'plan-svg', ...range, width, height, background, onlyPen }, 'svg');
  }

  /** Sampled chains of a plan range: the toolpath layout, from `range.from`. */
  planToolpath(range: PlanRange, tolerance: number): Promise<Float64Array> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, {
        resolve: (msg) => resolve((msg as { plan: Float64Array }).plan),
        reject,
      });
      this.worker.postMessage({ type: 'plan-toolpath', id, ...range, tolerance });
    });
  }

  /** One registered material of the named execution, as plain copies.
   * Rejects when that execution is no longer the worker's current one. */
  inspectMaterial(executionId: number, name: string): Promise<InspectionPayload> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, {
        resolve: (msg) => resolve((msg as { payload: InspectionPayload }).payload),
        reject,
      });
      this.worker.postMessage({ type: 'inspect', id, executionId, name });
    });
  }

  /** Make a saved plan the worker's current one (verified against its
   * hash), with the pens it was saved with. */
  loadPlan(buffer: Float64Array, settings: PlanSettings, planHash: string, pens: PenDef[], expectedPlanHash?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve: () => resolve(), reject });
      this.worker.postMessage({ type: 'plan-load', id, buffer, settings, planHash, pensJson: pensToJson(pens), expectedPlanHash });
    });
  }

  optimizationContext(planHash: string): Promise<import('./optimization.js').OptimizationContext> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve: (msg) => resolve((msg as { context: import('./optimization.js').OptimizationContext }).context), reject });
      this.worker.postMessage({ type: 'optimization-context', id, planHash });
    });
  }

  planPng(range: PlanRange, width: number, height: number, scale: number, background?: string): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve: (msg) => resolve((msg as { png: Uint8Array }).png), reject });
      this.worker.postMessage({ type: 'plan-png', id, ...range, width, height, scale, background });
    });
  }

  exportPng(
    width: number,
    height: number,
    scale: number,
    background: string | undefined,
  ): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, {
        resolve: (msg) => resolve((msg as { png: Uint8Array }).png),
        reject,
      });
      this.worker.postMessage({ type: 'png', id, width, height, scale, background });
    });
  }

  private request(body: Record<string, unknown>, field: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, {
        resolve: (msg) => resolve(String((msg as Record<string, unknown>)[field])),
        reject,
      });
      this.worker.postMessage({ ...body, id });
    });
  }
}
