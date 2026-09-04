/**
 * Main-thread side of the render worker. The worker owns the whole sketch
 * runtime, so a render request is just source + config — no scene ever
 * exists on this thread. Render requests coalesce: while one is in flight,
 * only the newest queued request survives — a typing burst never builds a
 * backlog, and superseded calls resolve to null. A render is atomic from
 * the worker's perspective; the watchdog is the only hard interruption.
 */

import { decodeRender, type EncodedScene, type ProbeSummary, type RenderResult } from 'occlude';
import type { RunConfig } from './runner.js';

export interface RenderRequest {
  js: string;
  cfg: RunConfig;
}

/** A render carrying its worker-side seed (the main thread has no sketch
 * state to read it from anymore). */
export interface RenderReply {
  result: RenderResult;
  seedUsed: string;
  /** `t.probe()` readouts from this run. */
  probes: Record<string, ProbeSummary>;
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

export class RenderClient {
  private worker!: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private inFlightRender = false;
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
    this.queuedRender?.p.resolve(null);
    this.queuedRender = null;
    this.spawn();
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

  private sendRender(req: RenderRequest, p: Pending): void {
    const id = this.nextId++;
    p.isRender = true;
    this.pending.set(id, p);
    this.inFlightRender = true;
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
            probes: Record<string, ProbeSummary>;
          };
          // decodeRender reads only pens/frame/paper from the scene half.
          const meta = { pens: m.pens, frame: m.frame, paper: m.paper } as EncodedScene;
          resolve({ result: decodeRender(meta, m), seedUsed: m.seedUsed, probes: m.probes ?? {} });
        },
        reject,
      };
      if (this.inFlightRender) {
        this.queuedRender?.p.resolve(null);
        this.queuedRender = { req, p };
        return;
      }
      this.sendRender(req, p);
    });
  }

  exportGcode(profileJson: string, budget: number): Promise<string> {
    return this.request({ type: 'gcode', profileJson, budget }, 'json');
  }

  exportSvg(
    width: number,
    height: number,
    background: string | undefined,
    onlyPen: number,
  ): Promise<string> {
    return this.request({ type: 'svg', width, height, background, onlyPen }, 'svg');
  }

  exportToolpath(budget: number, tolerance: number): Promise<Float64Array> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, {
        resolve: (msg) => resolve((msg as { plan: Float64Array }).plan),
        reject,
      });
      this.worker.postMessage({ type: 'toolpath', id, budget, tolerance });
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
