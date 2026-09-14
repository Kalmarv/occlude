/// <reference types="@webgpu/types" />
import { hiddenInterval3, type Interval3, type SegmentBasis3, type OcclusionVolume3 } from '../../three/visibility/interval.js';
import { type Vec3 } from '../../three/math.js';
import { PhaseClock3, type PhaseTimings3 } from '../../three/timing.js';
import { intervalShader } from './intervalShader.js';

export interface VisibilityPair3 { readonly a: Vec3; readonly b: Vec3; readonly volume: OcclusionVolume3; readonly basis?: SegmentBasis3 }
export interface GpuIntervalResult3 {
  readonly intervals: readonly (Interval3 | null)[];
  readonly dispatches: number;
  readonly refinements: number;
  readonly transferBytes: number;
  readonly residentBytes: number;
  /** Sum of compute-pass timestamps in milliseconds; absent when unsupported/disabled. */
  readonly gpuMs?: number;
  readonly wallMs: number;
  readonly timings: PhaseTimings3;
}
export interface GpuIntervalOptions3 { readonly signal?: AbortSignal; readonly parameterTolerance?: number }

/** Explicit host resource. Serial bounded leases prevent buffer races between
 * interleaved runs. No adapter request happens on module import. */
export class GpuIntervals3 {
  readonly device: GPUDevice;
  readonly adapterInfo: GPUAdapterInfo;
  private pipeline: GPUComputePipeline;
  private input: GPUBuffer;
  private output: GPUBuffer;
  private staging: GPUBuffer;
  private capacity: number;
  private timestamps?: GPUQuerySet;
  private timestampResolve?: GPUBuffer;
  get timestampsEnabled(): boolean { return this.timestamps !== undefined; }
  private lost: string | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private constructor(device: GPUDevice, info: GPUAdapterInfo, pipeline: GPUComputePipeline, capacity: number) {
    this.device = device; this.adapterInfo = info; this.pipeline = pipeline; this.capacity = capacity;
    this.input = device.createBuffer({ label: '3D interval pairs', size: capacity * 96, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.output = device.createBuffer({ label: '3D intervals', size: capacity * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    this.staging = device.createBuffer({ label: '3D interval readback', size: capacity * 16 + (device.features.has('timestamp-query') ? 16 : 0), usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    if (device.features.has('timestamp-query')) {
      this.timestamps = device.createQuerySet({ label: '3D interval timing', type: 'timestamp', count: 2 });
      this.timestampResolve = device.createBuffer({ label: '3D timestamp resolve', size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
    }
    void device.lost.then(info => { this.lost = info.message || info.reason; });
  }
  /** False after device loss or explicit disposal; a host may create a fresh session. */
  get available(): boolean { return this.lost === null; }
  static async create(gpu: GPU, options: { memoryBudgetBytes?: number; requireHardware?: boolean; timestamps?: boolean } = {}): Promise<GpuIntervals3> {
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('WebGPU adapter unavailable');
    if (options.requireHardware && adapter.info.isFallbackAdapter) throw new Error('hardware WebGPU adapter required; fallback adapter reported');
    const budget = options.memoryBudgetBytes ?? 8 * 1024 * 1024;
    if (!(budget >= 128) || !Number.isFinite(budget)) throw new Error('WebGPU interval budget must be at least 128 bytes');
    const timing = options.timestamps !== false && budget >= 160 && adapter.features.has('timestamp-query');
    const device = await adapter.requestDevice({ requiredFeatures: timing ? ['timestamp-query'] : [] });
    try {
      const capacity = Math.min(Math.floor((budget - (timing ? 32 : 0)) / 128), Math.floor(device.limits.maxStorageBufferBindingSize / 96), Math.floor(device.limits.maxBufferSize / 96), device.limits.maxComputeWorkgroupsPerDimension * 64);
      const module = device.createShaderModule({ label: 'Geometric segment/triangle visibility', code: intervalShader });
      const pipeline = await device.createComputePipelineAsync({ label: '3D hidden intervals', layout: 'auto', compute: { module, entryPoint: 'classify' } });
      return new GpuIntervals3(device, adapter.info, pipeline, capacity);
    } catch (error) { device.destroy(); throw error; }
  }
  /** Snapshots inputs at submission; callers can mutate their modeling arrays. */
  classify(pairs: readonly VisibilityPair3[], options: GpuIntervalOptions3 = {}): Promise<GpuIntervalResult3> {
    const tolerance = options.parameterTolerance ?? 1e-5;
    if (!(tolerance > 0) || !Number.isFinite(tolerance)) return Promise.reject(new Error('parameter tolerance must be positive and finite'));
    const timing = new PhaseClock3();
    const owned = timing.measure('captureMs', () => {
      // A scene reuses each source basis/occluder across many candidate pairs.
      // Own each once per submission, preserving exact-refinement cache keys
      // while still isolating later caller mutations before the queued work.
      const volumes=new Map<OcclusionVolume3,OcclusionVolume3>(),bases=new Map<SegmentBasis3,SegmentBasis3>();
      return pairs.map(p=>{
        let volume=volumes.get(p.volume);if(!volume){volume=structuredClone(p.volume);volumes.set(p.volume,volume);}
        let basis=p.basis&&bases.get(p.basis);if(p.basis&&!basis){basis=structuredClone(p.basis);bases.set(p.basis,basis);}
        return {a:[...p.a] as Vec3,b:[...p.b] as Vec3,volume,basis};
      });
    });
    const queued = performance.now();
    const job = this.tail.then(() => { timing.since('queueMs', queued); return this.run(owned, { ...options, parameterTolerance: tolerance }, timing); });
    this.tail = job.catch(() => {});
    return job;
  }
  private check(signal?: AbortSignal): void {
    signal?.throwIfAborted();
    if (this.lost !== null) throw new Error(`WebGPU session unavailable: ${this.lost}`);
  }
  private async run(pairs: readonly VisibilityPair3[], options: GpuIntervalOptions3, timing: PhaseClock3): Promise<GpuIntervalResult3> {
    this.check(options.signal);
    const started = performance.now(), intervals: (Interval3 | null)[] = [];
    let dispatches = 0, refinements = 0, transferBytes = 0, gpuMs = 0;
    for (let start = 0; start < pairs.length; start += this.capacity) {
      this.check(options.signal);
      const packingStarted = performance.now();
      const batch = pairs.slice(start, start + this.capacity), packed = new Float32Array(batch.length * 24);
      for (let i = 0; i < batch.length; i++) {
        const p = batch[i];
        if (p.volume.planes.length !== 4 || ![...p.a, ...p.b, ...p.volume.planes.flat()].every(Number.isFinite)) throw new Error('visibility pair requires finite endpoints and four planes');
        const scale = Math.max(...p.a.map(Math.abs), ...p.b.map(Math.abs), ...p.volume.planes.map(v => Math.abs(v[3])), Number.MIN_VALUE);
        packed.set(p.a.map(v => v / scale), i * 24);
        packed[i * 24 + 3] = options.parameterTolerance!;
        packed.set(p.b.map(v => v / scale), i * 24 + 4);
        for (let j = 0; j < 4; j++) {
          const plane = p.volume.planes[j];
          packed.set([plane[0], plane[1], plane[2], plane[3] / scale], i * 24 + 8 + j * 4);
        }
      }
      timing.since('packingMs', packingStarted);
      this.device.pushErrorScope('validation');
      let read: Float32Array;
      try {
        timing.measure('uploadSubmitMs', () => this.device.queue.writeBuffer(this.input, 0, packed));
        this.check(options.signal);
        const dispatchStarted = performance.now();
        const bindGroup = this.device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: [
          { binding: 0, resource: { buffer: this.input, size: packed.byteLength } },
          { binding: 1, resource: { buffer: this.output, size: batch.length * 16 } },
        ] });
        const encoder = this.device.createCommandEncoder();
        const pass = encoder.beginComputePass(this.timestamps ? { timestampWrites: { querySet: this.timestamps, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } } : {});
        pass.setPipeline(this.pipeline); pass.setBindGroup(0, bindGroup); pass.dispatchWorkgroups(Math.ceil(batch.length / 64)); pass.end();
        encoder.copyBufferToBuffer(this.output, 0, this.staging, 0, batch.length * 16);
        if (this.timestamps && this.timestampResolve) {
          encoder.resolveQuerySet(this.timestamps, 0, 2, this.timestampResolve, 0);
          encoder.copyBufferToBuffer(this.timestampResolve, 0, this.staging, batch.length * 16, 16);
        }
        this.device.queue.submit([encoder.finish()]); dispatches++;
        timing.since('dispatchSubmitMs', dispatchStarted);
        await timing.wait('readbackWaitMs', () => this.staging.mapAsync(GPUMapMode.READ, 0, batch.length * 16 + (this.timestamps ? 16 : 0)));
        const copyStarted = performance.now();
        try {
          read = new Float32Array(this.staging.getMappedRange(0, batch.length * 16).slice(0));
          if (this.timestamps) {
            const times = new BigUint64Array(this.staging.getMappedRange(batch.length * 16, 16));
            if (times[1] < times[0]) throw new Error('WebGPU timestamps are nonmonotonic');
            gpuMs += Number(times[1] - times[0]) / 1e6;
          }
        }
        finally { this.staging.unmap(); timing.since('readbackCopyMs', copyStarted); }
      } finally {
        const error = await timing.wait('validationWaitMs', () => this.device.popErrorScope());
        if (error) throw new Error(`WebGPU visibility: ${error.message}`);
      }
      this.check(options.signal);
      transferBytes += packed.byteLength + read.byteLength + (this.timestamps ? 16 : 0);
      const refineStarted = performance.now();
      for (let i = 0; i < batch.length; i++) {
        // The WGSL certificate covers 32 f32 unit roundoffs of the binary
        // coordinates it receives. A rational construction's evaluated f64
        // position sits within half an f64 ulp of the exact point, far inside
        // that envelope, so its pairs take the same uncertainty flag as any
        // other; near-incidence with a neighbouring triangle is flagged by the
        // shader and refined exactly here.
        if (read[i * 4 + 2] !== 0 || !Number.isFinite(read[i * 4]) || !Number.isFinite(read[i * 4 + 1])) {
          refinements++; const p = batch[i]; intervals.push(hiddenInterval3(p.a, p.b, p.volume, p.basis));
        } else intervals.push(read[i * 4 + 3] === 0 ? null : [read[i * 4], read[i * 4 + 1]]);
      }
      timing.since('refinementMs', refineStarted);
    }
    return { intervals, dispatches, refinements, transferBytes, residentBytes: this.capacity * 128 + (this.timestamps ? 32 : 0), ...(this.timestamps ? { gpuMs } : {}), wallMs: performance.now() - started, timings: timing.finish() };
  }
  /** Prevent queued adoption immediately, then wait for in-flight leases. */
  async dispose(): Promise<void> {
    this.lost = 'disposed';
    await this.tail;
    await this.device.queue.onSubmittedWorkDone().catch(() => {});
    this.input.destroy(); this.output.destroy(); this.staging.destroy(); this.timestamps?.destroy(); this.timestampResolve?.destroy(); this.device.destroy();
  }
}
