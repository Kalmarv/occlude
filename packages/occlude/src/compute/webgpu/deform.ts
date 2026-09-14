/// <reference types="@webgpu/types" />
import { adjacency3,captureDeform3,type DeformOptions3 } from '../../three/geometry/deform.js';
import type {Surface3} from '../../three/geometry/surface.js';
import {PhaseClock3,type PhaseTimings3} from '../../three/timing.js';
import type {Vec3} from '../../three/math.js';
const shader=/*wgsl*/`
struct Params { count:u32, relaxation:f32, padding:vec2u }
@group(0) @binding(0) var<storage,read> source:array<vec4f>;
@group(0) @binding(1) var<storage,read_write> destination:array<vec4f>;
@group(0) @binding(2) var<storage,read> offsets:array<u32>;
@group(0) @binding(3) var<storage,read> neighbors:array<u32>;
@group(0) @binding(4) var<storage,read> displacements:array<vec4f>;
@group(0) @binding(5) var<uniform> params:Params;
@compute @workgroup_size(64)
fn step(@builtin(global_invocation_id) id:vec3u){
  let i=id.x;if(i>=params.count){return;}
  let p=source[i].xyz;let force=displacements[i];
  if(force.w==0.0){destination[i]=vec4f(p,1.0);return;}
  let start=offsets[i];let end=offsets[i+1u];var delta=vec3f(0.0);
  if(end>start){var mean=vec3f(0.0);for(var j=start;j<end;j++){mean+=source[neighbors[j]].xyz;}delta=(mean/f32(end-start)-p)*params.relaxation;}
  destination[i]=vec4f(p+delta+force.xyz,1.0);
}`;
/** Persistent host pipeline, per-execution bounded buffers. One upload/readback
 * boundary for any number of fixed-topology passes; no scalar GPU calls. */
export class GpuDeform3 {
  private tail:Promise<unknown>=Promise.resolve();
  private constructor(private device:GPUDevice,private pipeline:GPUComputePipeline,private budget:number){}
  static async create(device:GPUDevice,memoryBudgetBytes=128*1024*1024):Promise<GpuDeform3>{
    if(!Number.isFinite(memoryBudgetBytes)||memoryBudgetBytes<128)throw new Error('invalid deformation memory budget');
    const module=device.createShaderModule({label:'3D frozen gather displacement and relaxation',code:shader});
    const compilation=await module.getCompilationInfo();const errors=compilation.messages.filter(m=>m.type==='error');if(errors.length)throw new Error(errors.map(m=>`${m.lineNum}:${m.linePos} ${m.message}`).join('\n'));
    const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'step'}});
    return new GpuDeform3(device,pipeline,memoryBudgetBytes);
  }
  deform(surface:Surface3,options:DeformOptions3):Promise<{surface:Surface3;stats:{iterations:number;dispatches:number;transferBytes:number;residentBytes:number;wallMs:number;timings:PhaseTimings3}}> {
    const timing=new PhaseClock3(),captured=timing.measure('captureMs',()=>captureDeform3(surface,options)),signal=options.signal;
    const queued=performance.now();
    const job=this.tail.then(async()=>{timing.since('queueMs',queued);const out=await this.run(captured,timing,signal);return {...out,stats:{...out.stats,timings:timing.finish()}};});this.tail=job.catch(()=>{});return job;
  }
  private async run(input:ReturnType<typeof captureDeform3>,timing:PhaseClock3,signal?:AbortSignal){
    const started=performance.now(),surface=input.surface,count=surface.points.length;signal?.throwIfAborted();
    if(count===0||input.iterations===0)return {surface,stats:{iterations:input.iterations,dispatches:0,transferBytes:0,residentBytes:0,wallMs:performance.now()-started}};
    const packingStarted=performance.now();
    const csr=adjacency3(surface),bytes=count*16,neighborBytes=Math.max(4,csr.neighbors.byteLength),residentBytes=bytes*4+csr.offsets.byteLength+neighborBytes+16;
    if(residentBytes>this.budget||bytes>this.device.limits.maxStorageBufferBindingSize||neighborBytes>this.device.limits.maxStorageBufferBindingSize||csr.offsets.byteLength>this.device.limits.maxStorageBufferBindingSize||Math.ceil(count/64)>this.device.limits.maxComputeWorkgroupsPerDimension)throw new Error(`deformation needs ${residentBytes} bytes or exceeds device limits; reduce mesh size or raise the memory budget`);
    const origin=[...surface.points[0].position];let scale=0;
    for(const p of surface.points)for(let k=0;k<3;k++)scale=Math.max(scale,Math.abs(p.position[k]-origin[k]));scale=scale||1;
    const packed=new Float32Array(count*4),forces=new Float32Array(count*4);
    surface.points.forEach((p,i)=>{for(let k=0;k<3;k++){packed[i*4+k]=(p.position[k]-origin[k])/scale;forces[i*4+k]=input.displacements[i][k]/scale;}packed[i*4+3]=1;forces[i*4+3]=input.pinned.has(i)?0:1;});
    if(!packed.every(Number.isFinite)||!forces.every(Number.isFinite))throw new Error('deformation cannot represent this coordinate/displacement range in f32');
    timing.since('packingMs',packingStarted);
    const buffers:GPUBuffer[]=[],make=(size:number,usage:GPUBufferUsageFlags)=>{const buffer=this.device.createBuffer({size,usage});buffers.push(buffer);return buffer;};
    this.device.pushErrorScope('validation');
    try {
      const setupStarted=performance.now();
      const a=make(bytes,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC),b=make(bytes,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC),offsets=make(csr.offsets.byteLength,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST),neighbors=make(neighborBytes,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST),force=make(bytes,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST),params=make(16,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST),staging=make(bytes,GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST);
      const uniform=new ArrayBuffer(16);new Uint32Array(uniform)[0]=count;new Float32Array(uniform)[1]=input.relaxation;
      timing.since('setupMs',setupStarted);const uploadStarted=performance.now();
      this.device.queue.writeBuffer(a,0,packed);this.device.queue.writeBuffer(offsets,0,csr.offsets);if(csr.neighbors.length)this.device.queue.writeBuffer(neighbors,0,csr.neighbors);this.device.queue.writeBuffer(force,0,forces);this.device.queue.writeBuffer(params,0,uniform);
      timing.since('uploadSubmitMs',uploadStarted);const dispatchStarted=performance.now();
      const bind=(src:GPUBuffer,dst:GPUBuffer)=>this.device.createBindGroup({layout:this.pipeline.getBindGroupLayout(0),entries:[src,dst,offsets,neighbors,force,params].map((buffer,binding)=>({binding,resource:{buffer}}))});
      const groups=[bind(a,b),bind(b,a)],encoder=this.device.createCommandEncoder();
      for(let step=0;step<input.iterations;step++){signal?.throwIfAborted();const pass=encoder.beginComputePass();pass.setPipeline(this.pipeline);pass.setBindGroup(0,groups[step%2]);pass.dispatchWorkgroups(Math.ceil(count/64));pass.end();}
      encoder.copyBufferToBuffer(input.iterations%2?b:a,0,staging,0,bytes);this.device.queue.submit([encoder.finish()]);
      timing.since('dispatchSubmitMs',dispatchStarted);await timing.wait('readbackWaitMs',()=>staging.mapAsync(GPUMapMode.READ));const copyStarted=performance.now();let result:Float32Array;try{result=new Float32Array(staging.getMappedRange().slice(0));}finally{staging.unmap();timing.since('readbackCopyMs',copyStarted);}
      signal?.throwIfAborted();if(!result.every(Number.isFinite))throw new Error('GPU deformation overflowed; reduce displacement or iteration count');
      timing.measure('finalizeMs',()=>surface.points.forEach((p,i)=>{if(!input.pinned.has(i))p.position=[0,1,2].map(k=>origin[k]+scale*result[i*4+k]) as unknown as Vec3;}));
      return {surface,stats:{iterations:input.iterations,dispatches:input.iterations,transferBytes:bytes*3+csr.offsets.byteLength+csr.neighbors.byteLength+16,residentBytes,wallMs:performance.now()-started}};
    } finally {for(const b of buffers)b.destroy();const error=await timing.wait('validationWaitMs',()=>this.device.popErrorScope());if(error)throw new Error(`WebGPU deformation: ${error.message}`);}
  }
}
