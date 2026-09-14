/// <reference types="@webgpu/types" />
import { GpuWorldViewport3 } from './worldViewport.js';
import type { CameraFrame3 } from '../../three/camera.js';
import type { Triangle3, Vec3 } from '../../three/math.js';
import type { SceneCompute3 } from '../../three/scene.js';
import type { FeatureSnapshot3 } from '../../three/features/snapshot.js';
import { classifySceneGpu3 } from '../../three/visibility/scene.js';
import { GpuIntervals3 } from './interval.js';
import { GpuDeform3 } from './deform.js';
import { GpuSurfaceQueries3 } from './queries.js';
import { captureDeform3, type DeformOptions3 } from '../../three/geometry/deform.js';
import { prepareSurfaceQueries3, type SurfaceQueries3 } from '../../three/queries/surface.js';
import type { Surface3 } from '../../three/geometry/surface.js';
import type { SurfaceQueryInput3 } from '../../three/modeling.js';

/** Host-owned, lazy device resource shared explicitly with executions. A lost
 * device is recreated for the next request; failed jobs are never replayed. */
export class GpuSceneCompute3 implements SceneCompute3 {
  private session?: GpuIntervals3;
  private creating?: Promise<GpuIntervals3>;
  private closed = false;
  private deformation?: GpuDeform3;
  private readonly queryTargets=new Map<SurfaceQueries3,GpuSurfaceQueries3>();
  private queryTargetBytes=0;
  private async clearQueryTargets():Promise<void>{for(const target of this.queryTargets.values())await target.dispose();this.queryTargets.clear();this.queryTargetBytes=0;}
  private async queryTarget(device:GPUDevice,source:SurfaceQueries3){
    const cached=this.queryTargets.get(source);
    if(cached){this.queryTargets.delete(source);this.queryTargets.set(source,cached);return {prepared:cached,cacheHit:true,uploadBytes:0};}
    const bytes=source.triangles.length*48,budget=this.options.memoryBudgetBytes??128*1024*1024,retainedBudget=Math.max(bytes,budget/2);
    // Reserve half the query buffer budget for batch scratch. A target larger
    // than that occupies the cache alone and uses the remaining budget.
    while(this.queryTargets.size&&(this.queryTargets.size>=4||this.queryTargetBytes+bytes>retainedBudget)){
      const [old,target]=this.queryTargets.entries().next().value!;await target.dispose();this.queryTargets.delete(old);this.queryTargetBytes-=old.triangles.length*48;
    }
    const prepared=await GpuSurfaceQueries3.create(device,source,{memoryBudgetBytes:bytes>budget/2?budget:bytes+budget/2});
    this.queryTargets.set(source,prepared);this.queryTargetBytes+=bytes;return {prepared,cacheHit:false,uploadBytes:prepared.uploadBytes};
  }
  private preview?: { canvas: OffscreenCanvas; viewport: GpuWorldViewport3 };
  private tail: Promise<unknown> = Promise.resolve();
  private submit<T>(job: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('3D GPU host disposed'));
    const result = this.tail.then(job);
    this.tail = result.catch(() => undefined);
    return result;
  }
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
        this.deformation = undefined;
        await this.clearQueryTargets();
        this.preview?.viewport.dispose(); this.preview = undefined;
        await this.session?.dispose();
        const session = await GpuIntervals3.create(this.gpu!, this.options);
        if (this.closed) { await session.dispose(); throw new Error('3D GPU host disposed'); }
        this.session = session;
        return session;
      })().finally(() => { this.creating = undefined; });
    }
    return this.creating;
  }
  classify(snapshot: FeatureSnapshot3, options: { signal?: AbortSignal; paperToleranceMm?: number } = {}) {
    const signal = options.signal, paperToleranceMm = options.paperToleranceMm;
    return this.submit(async () => {
      signal?.throwIfAborted();
      const session = await this.acquire();
      signal?.throwIfAborted();
      return classifySceneGpu3(snapshot, session, { signal, paperToleranceMm });
    });
  }
  /** Raster-only construction view of retained WORLD geometry, sharing this host's worker-owned device. */
  preview3(frame: CameraFrame3, triangles: readonly Triangle3[], wires: readonly (readonly [Vec3, Vec3])[], width: number, height: number): Promise<ImageBitmap> {
    if (![width,height].every(n => Number.isInteger(n) && n > 0 && n <= 4096)) return Promise.reject(new Error('construction dimensions must be integers from 1 to 4096'));
    return this.submit(async () => {
      const session = await this.acquire();
      if (!this.preview) {
        const canvas = new OffscreenCanvas(width,height);
        this.preview = { canvas, viewport: new GpuWorldViewport3(session.device,canvas,this.gpu!.getPreferredCanvasFormat()) };
      }
      const { canvas, viewport } = this.preview;
      await viewport.ready;
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      viewport.draw(frame,triangles,wires);
      return canvas.transferToImageBitmap();
    });
  }
  deform(surface: Surface3, options: DeformOptions3) {
    const input = captureDeform3(surface, options), signal = options.signal;
    return this.submit(async () => {
      signal?.throwIfAborted();
      const session = await this.acquire();
      this.deformation ??= await GpuDeform3.create(session.device);
      signal?.throwIfAborted();
      return this.deformation.deform(input.surface, { iterations: input.iterations, relaxation: input.relaxation, displacements: input.displacements, pinned: [...input.pinned], signal });
    });
  }
  query(surface: Surface3, queries: SurfaceQueryInput3, options: { signal?: AbortSignal } = {}) {
    const source = prepareSurfaceQueries3(surface), captured = structuredClone(queries), signal = options.signal;
    return this.submit(async () => {
      signal?.throwIfAborted();
      const session = await this.acquire();
      const {prepared,cacheHit,uploadBytes}=await this.queryTarget(session.device,source);
      const rays = await prepared.rays(captured.rays ?? [], { signal });
      const segments = await prepared.segments(captured.segments ?? [], { signal });
      const nearest = await prepared.nearest(captured.nearest ?? [], { signal });
      signal?.throwIfAborted();
      return { result: { rays: rays.hits, segments: segments.hits, nearest: nearest.hits }, stats: {
        dispatches: rays.stats.dispatches + segments.stats.dispatches + nearest.stats.dispatches,
        transferBytes: uploadBytes + rays.stats.transferBytes + segments.stats.transferBytes + nearest.stats.transferBytes,
        targetCacheHit:cacheHit,targetUploadBytes:uploadBytes,
      } };
    });
  }
  async dispose(): Promise<void> {
    this.closed = true;
    await this.tail;
    await this.creating?.catch(() => undefined);
    this.preview?.viewport.dispose(); this.preview = undefined;
    await this.clearQueryTargets();
    await this.session?.dispose();
    this.session = undefined;
  }
}
