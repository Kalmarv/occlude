import { abandonedThreeJob, type ThreeQueryInput, type ThreeQueryResult, type ThreeDeformInput, type ThreeDeformResult, type ThreeRenderInput, type ThreeRenderResult, type ThreeJobInput, type ThreeJobResult, type ThreeSceneInput, type ThreeSceneResult, type ThreeWorkerRequest, type ThreeWorkerResponse } from './protocol.js';

type Pending = { id: number; resolve: (value: ThreeJobResult) => void; reject: (error: unknown) => void; cleanup: () => void };
/** Latest-view client. postMessage captures inputs synchronously; the host never
 * transfers GPU objects. Restart creates a new client and a fresh HTML canvas. */
export class ThreeWorkerClient {
  private worker: Worker;
  private serial = 0;
  private pending: Pending | null = null;
  private closed = false;
  private disposal: Promise<void> | null = null;
  private finishDisposal: (() => void) | null = null;
  constructor(canvas: HTMLCanvasElement, options: { requireHardware?: boolean } = {}) {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'occlude-3d' });
    this.worker.onmessage = (event: MessageEvent<ThreeWorkerResponse>) => {
      const message = event.data;
      if (message.type === 'disposed') { this.finishDisposal?.(); return; }
      if (this.pending?.id !== message.id) return;
      const pending = this.pending; this.pending = null; pending.cleanup();
      if (message.type === 'result') pending.resolve(message.result);
      else { const error = new Error(message.message); error.name = message.name; pending.reject(error); }
    };
    this.worker.onerror = event => {
      const error = new Error(`3D worker failed: ${event.message}`);
      this.rejectPending(error); this.closed = true; this.worker.terminate(); this.finishDisposal?.();
    };
    try {
      const offscreen = canvas.transferControlToOffscreen();
      this.post({ type: 'init', canvas: offscreen, requireHardware: options.requireHardware ?? false }, [offscreen]);
    } catch (error) { this.worker.terminate(); throw error; }
  }
  private post(message: ThreeWorkerRequest, transfer: Transferable[] = []): void { this.worker.postMessage(message, transfer); }
  private rejectPending(error: unknown): void {
    const pending = this.pending; this.pending = null;
    if (pending) { pending.cleanup(); pending.reject(error); }
  }
  async render(input: ThreeRenderInput, signal?: AbortSignal): Promise<ThreeRenderResult> {
    const result = await this.submit(input, signal);
    if (!('gpu' in result)) throw new Error('unexpected scene response for interval request');
    return result;
  }
  async renderScene(input: ThreeSceneInput, signal?: AbortSignal): Promise<ThreeSceneResult> {
    const result = await this.submit(input, signal);
    if (!('drawing' in result)) throw new Error('unexpected interval response for scene request');
    return result;
  }
  async deform(input:ThreeDeformInput,signal?:AbortSignal):Promise<ThreeDeformResult> {
    const result=await this.submit(input,signal);if(!('deformation' in result))throw new Error('unexpected response for deformation request');return result;
  }
  async query(input:ThreeQueryInput,signal?:AbortSignal):Promise<ThreeQueryResult> {
    const result=await this.submit(input,signal);if(!('queries' in result))throw new Error('unexpected response for surface query');return result;
  }
  private submit(input: ThreeJobInput, signal?: AbortSignal): Promise<ThreeJobResult> {
    if (this.closed) return Promise.reject(new Error('3D worker is closed; restart with a fresh canvas'));
    if (signal?.aborted) return Promise.reject(signal.reason ?? abandonedThreeJob());
    this.cancel();
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const abort = () => { if (this.pending?.id === id) this.cancel(); };
      this.pending = { id, resolve, reject, cleanup: () => signal?.removeEventListener('abort', abort) };
      signal?.addEventListener('abort', abort, { once: true });
      try { this.post({ type: 'render', id, input }); }
      catch (error) { this.rejectPending(error); }
    });
  }
  cancel(): void {
    if (!this.pending) return;
    this.post({ type: 'cancel', id: this.pending.id });
    this.rejectPending(abandonedThreeJob());
  }
  /** Graceful teardown waits for submitted work, with termination as a bounded
   * recovery for a dead/hung worker. Previously committed vectors stay on host. */
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    if (this.closed) return Promise.resolve();
    this.cancel(); this.closed = true;
    this.disposal = new Promise(resolve => {
      const timer = setTimeout(() => finish(), 3000);
      const finish = () => { clearTimeout(timer); this.worker.terminate(); resolve(); };
      this.finishDisposal = finish;
      this.post({ type: 'dispose' });
    });
    return this.disposal;
  }
}
