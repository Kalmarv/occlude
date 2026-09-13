/// <reference types="@webgpu/types" />
import type { SceneCompute3 } from '../../three/scene.js';
import type { FeatureSnapshot3 } from '../../three/features/snapshot.js';
import { classifySceneGpu3 } from '../../three/visibility/scene.js';
import { GpuIntervals3 } from './interval.js';

/** Host-owned, lazy device resource shared explicitly with executions. A lost
 * device is recreated for the next request; failed jobs are never replayed. */
export class GpuSceneCompute3 implements SceneCompute3 {
  private session?: GpuIntervals3;
  private creating?: Promise<GpuIntervals3>;
  private closed = false;
  private readonly options: { requireHardware?: boolean; memoryBudgetBytes?: number };
  constructor(private readonly gpu: GPU | undefined, options: { requireHardware?: boolean; memoryBudgetBytes?: number } = {}) {
    this.options = { ...options };
  }
  get adapterInfo() {
    const info = this.session?.adapterInfo;
    return info && { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description, isFallbackAdapter: info.isFallbackAdapter };
  }
  private async acquire(): Promise<GpuIntervals3> {
    if (this.closed) throw new Error('3D GPU host disposed');
    if (!this.gpu) throw new Error('WebGPU unavailable; use HTTPS or localhost with a supported browser');
    if (this.session?.available) return this.session;
    if (!this.creating) {
      this.creating = (async () => {
        await this.session?.dispose();
        const session = await GpuIntervals3.create(this.gpu!, this.options);
        if (this.closed) { await session.dispose(); throw new Error('3D GPU host disposed'); }
        this.session = session;
        return session;
      })().finally(() => { this.creating = undefined; });
    }
    return this.creating;
  }
  async classify(snapshot: FeatureSnapshot3, options: { signal?: AbortSignal } = {}) {
    options.signal?.throwIfAborted();
    const session = await this.acquire();
    options.signal?.throwIfAborted();
    return classifySceneGpu3(snapshot, session, options);
  }
  async dispose(): Promise<void> {
    this.closed = true;
    await this.creating?.catch(() => undefined);
    await this.session?.dispose();
    this.session = undefined;
  }
}
