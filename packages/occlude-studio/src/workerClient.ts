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

export class RenderClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private inFlightRender = false;
  private queuedRender: { scene: EncodedScene; p: Pending } | null = null;

  constructor() {
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

  private onMessage(msg: {
    type: string;
    id: number;
    [k: string]: unknown;
  }): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.type === 'render' || (msg.type === 'error' && p.scene)) {
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
