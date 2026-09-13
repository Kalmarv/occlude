/// <reference types="@webgpu/types" />
import { hiddenInterval3, type Interval3, type OcclusionVolume3 } from '../../three/visibility/interval.js';
import { type Vec3 } from '../../three/math.js';
import { intervalShader } from './intervalShader.js';

export interface VisibilityPair3 { readonly a: Vec3; readonly b: Vec3; readonly volume: OcclusionVolume3 }
export interface GpuIntervalResult3 {
  readonly intervals: readonly (Interval3 | null)[];
  readonly dispatches: number;
  readonly refinements: number;
  readonly transferBytes: number;
  readonly residentBytes: number;
  readonly wallMs: number;
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
  private lost: string | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private constructor(device: GPUDevice, info: GPUAdapterInfo, pipeline: GPUComputePipeline, capacity: number) {
    this.device = device; this.adapterInfo = info; this.pipeline = pipeline; this.capacity = capacity;
    this.input = device.createBuffer({ label: '3D interval pairs', size: capacity * 96, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.output = device.createBuffer({ label: '3D intervals', size: capacity * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    this.staging = device.createBuffer({ label: '3D interval readback', size: capacity * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    void device.lost.then(info => { this.lost = info.message || info.reason; });
  }
  static async create(gpu: GPU, options: { memoryBudgetBytes?: number; requireHardware?: boolean } = {}): Promise<GpuIntervals3> {
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('WebGPU adapter unavailable');
    if (options.requireHardware && adapter.info.isFallbackAdapter) throw new Error('hardware WebGPU adapter required; fallback adapter reported');
    const budget = options.memoryBudgetBytes ?? 8 * 1024 * 1024;
    if (!(budget >= 128) || !Number.isFinite(budget)) throw new Error('WebGPU interval budget must be at least 128 bytes');
    const device = await adapter.requestDevice();
    try {
      const capacity = Math.min(Math.floor(budget / 128), Math.floor(device.limits.maxStorageBufferBindingSize / 96), Math.floor(device.limits.maxBufferSize / 96), device.limits.maxComputeWorkgroupsPerDimension * 64);
      const module = device.createShaderModule({ label: 'Geometric segment/triangle visibility', code: intervalShader });
      const pipeline = await device.createComputePipelineAsync({ label: '3D hidden intervals', layout: 'auto', compute: { module, entryPoint: 'classify' } });
      return new GpuIntervals3(device, adapter.info, pipeline, capacity);
    } catch (error) { device.destroy(); throw error; }
  }
  /** Snapshots inputs at submission; callers can mutate their modeling arrays. */
  classify(pairs: readonly VisibilityPair3[], options: GpuIntervalOptions3 = {}): Promise<GpuIntervalResult3> {
    const tolerance = options.parameterTolerance ?? 1e-5;
    if (!(tolerance > 0) || !Number.isFinite(tolerance)) return Promise.reject(new Error('parameter tolerance must be positive and finite'));
    const owned = pairs.map(p => ({ a: [...p.a] as Vec3, b: [...p.b] as Vec3, volume: { planes: p.volume.planes.map(v => [...v] as typeof v) } }));
    const job = this.tail.then(() => this.run(owned, { ...options, parameterTolerance: tolerance }));
    this.tail = job.catch(() => {});
    return job;
  }
  private check(signal?: AbortSignal): void {
    signal?.throwIfAborted();
    if (this.lost !== null) throw new Error(`WebGPU session unavailable: ${this.lost}`);
  }
  private async run(pairs: readonly VisibilityPair3[], options: GpuIntervalOptions3): Promise<GpuIntervalResult3> {
    this.check(options.signal);
    const started = performance.now(), intervals: (Interval3 | null)[] = [];
    let dispatches = 0, refinements = 0, transferBytes = 0;
    for (let start = 0; start < pairs.length; start += this.capacity) {
      this.check(options.signal);
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
      this.device.pushErrorScope('validation');
      let read: Float32Array;
      try {
        this.device.queue.writeBuffer(this.input, 0, packed);
        this.check(options.signal);
        const bindGroup = this.device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: [
          { binding: 0, resource: { buffer: this.input, size: packed.byteLength } },
          { binding: 1, resource: { buffer: this.output, size: batch.length * 16 } },
        ] });
        const encoder = this.device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(this.pipeline); pass.setBindGroup(0, bindGroup); pass.dispatchWorkgroups(Math.ceil(batch.length / 64)); pass.end();
        encoder.copyBufferToBuffer(this.output, 0, this.staging, 0, batch.length * 16);
        this.device.queue.submit([encoder.finish()]); dispatches++;
        await this.staging.mapAsync(GPUMapMode.READ, 0, batch.length * 16);
        try { read = new Float32Array(this.staging.getMappedRange(0, batch.length * 16).slice(0)); }
        finally { this.staging.unmap(); }
      } finally {
        const error = await this.device.popErrorScope();
        if (error) throw new Error(`WebGPU visibility: ${error.message}`);
      }
      this.check(options.signal);
      transferBytes += packed.byteLength + read.byteLength;
      for (let i = 0; i < batch.length; i++) {
        if (read[i * 4 + 2] !== 0 || !Number.isFinite(read[i * 4]) || !Number.isFinite(read[i * 4 + 1])) {
          refinements++; const p = batch[i]; intervals.push(hiddenInterval3(p.a, p.b, p.volume));
        } else intervals.push(read[i * 4 + 3] === 0 ? null : [read[i * 4], read[i * 4 + 1]]);
      }
    }
    return { intervals, dispatches, refinements, transferBytes, residentBytes: this.capacity * 128, wallMs: performance.now() - started };
  }
  /** Prevent queued adoption immediately, then wait for in-flight leases. */
  async dispose(): Promise<void> {
    this.lost = 'disposed';
    await this.tail;
    await this.device.queue.onSubmittedWorkDone().catch(() => {});
    this.input.destroy(); this.output.destroy(); this.staging.destroy(); this.device.destroy();
  }
}
