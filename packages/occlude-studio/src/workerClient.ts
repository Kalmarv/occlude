/**
 * Main-thread side of the render worker. Render requests coalesce: while one
 * is in flight, only the newest queued scene survives — a typing burst never
 * builds a backlog, and superseded calls resolve to null.
 */

import {
  decodeRender, sceneTransferables,
  type EncodedScene, type RenderResult,
} from 'occlude';

interface Pending {
  resolve(value: unknown): void;
  reject(err: Error): void;
  scene?: EncodedScene;
}

/** A render that takes this long is a runaway (sub-mm spacings, huge
 * counts): kill the worker rather than let it eat the tab's memory. */
const RENDER_TIMEOUT_MS = 20_000;

export class RenderClient {
  private worker!: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private inFlightRender = false;
  private queuedRender: { scene: EncodedScene; p: Pending } | null = null;
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

  /** Watchdog fired: the worker is wedged (or allocating without end).
   * Terminate it — wasm state and all — and start fresh. */
  private respawnStuckWorker(): void {
    this.worker.terminate();
    const err = new Error(
      `render timed out after ${RENDER_TIMEOUT_MS / 1000}s — likely a runaway ` +
        'parameter (tiny spacing/step or a huge count); the renderer was restarted',
    );
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    this.inFlightRender = false;
    this.queuedRender?.p.resolve(null as never);
    this.queuedRender = null;
    this.spawn();
  }

  private onMessage(msg: {
    type: string;
    id: number;
    [k: string]: unknown;
  }): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.type === 'render' || (msg.type === 'error' && p.scene)) {
      if (this.watchdog) {
        clearTimeout(this.watchdog);
        this.watchdog = null;
      }
      this.inFlightRender = false;
      if (this.queuedRender) {
        const { scene, p: qp } = this.queuedRender;
        this.queuedRender = null;
        this.sendRender(scene, qp);
      }
    }
    if (msg.type === 'error') {
      p.reject(new Error(String(msg.message)));
      return;
    }
    p.resolve(msg);
  }

  private sendRender(scene: EncodedScene, p: Pending): void {
    const id = this.nextId++;
    p.scene = scene;
    this.pending.set(id, p);
    this.inFlightRender = true;
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => this.respawnStuckWorker(), RENDER_TIMEOUT_MS);
    // Only the wasm-call arguments transfer; decode metadata (pens, frame)
    // stays on this side inside `scene`.
    this.worker.postMessage(
      { type: 'render', id, scene },
      { transfer: sceneTransferables(scene) },
    );
  }

  /** Render a scene. Resolves null when superseded by a newer request. */
  render(scene: EncodedScene): Promise<RenderResult | null> {
    return new Promise((resolve, reject) => {
      const p: Pending = {
        resolve: (msg) => {
          const m = msg as {
            prims: Float64Array;
            frags: Float64Array;
            stats: Float64Array;
            renderMs: number;
          };
          resolve(decodeRender(scene, m));
        },
        reject,
      };
      if (this.inFlightRender) {
        this.queuedRender?.p.resolve(null as never);
        this.queuedRender = { scene, p };
        return;
      }
      this.sendRender(scene, p);
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

  /** Tour + bridge an externally-built plan (SVG import). */
  optimizePlan(plan: Float64Array, pensJson: string, budget: number): Promise<Float64Array> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, {
        resolve: (msg) => resolve((msg as { plan: Float64Array }).plan),
        reject,
      });
      this.worker.postMessage(
        { type: 'optimizeplan', id, plan, pensJson, budget },
        { transfer: [plan.buffer] },
      );
    });
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
