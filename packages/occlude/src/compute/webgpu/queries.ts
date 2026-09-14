/// <reference types="@webgpu/types" />
import {SurfaceQueries3,nearestTriangle3,rayTriangle3,validateNearest3,validateRay3,type SurfaceHit3,type RayQuery3,type NearestQuery3} from '../../three/queries/surface.js';
import {PhaseClock3,type PhaseTimings3} from '../../three/timing.js';
import type {Vec3} from '../../three/math.js';
const shader=/*wgsl*/`
struct Triangle { a:vec4f,b:vec4f,c:vec4f }
struct Query { p:vec4f,d:vec4f }
@group(0) @binding(0) var<storage,read> triangles:array<Triangle>;
@group(0) @binding(1) var<storage,read> queries:array<Query>;
@group(0) @binding(2) var<storage,read_write> results:array<vec4f>;
fn bary(t:Triangle,p:vec3f,n:vec3f,nn:f32)->vec3f {
  let a=dot(cross(t.b.xyz-p,t.c.xyz-p),n)/nn;
  let b=dot(cross(t.c.xyz-p,t.a.xyz-p),n)/nn;
  return vec3f(a,b,1.0-a-b);
}
fn edge(a:vec3f,b:vec3f,p:vec3f)->vec3f {let d=b-a;return a+d*clamp(dot(p-a,d)/dot(d,d),0.0,1.0);}
@compute @workgroup_size(64)
fn nearest(@builtin(global_invocation_id) id:vec3u){
  let k=id.x;if(k>=arrayLength(&queries)){return;}let q=queries[k];var best=q.p.w;var chosen=0.0;var uncertain=0.0;
  for(var i=0u;i<arrayLength(&triangles);i++){
    let t=triangles[i];let n=cross(t.b.xyz-t.a.xyz,t.c.xyz-t.a.xyz);let nn=dot(n,n);
    if(nn<1e-20){uncertain=1.0;continue;}
    let projected=q.p.xyz-n*(dot(n,q.p.xyz-t.a.xyz)/nn);let weights=bary(t,projected,n,nn);
    var metric=distance(projected,q.p.xyz);
    if(any(weights<vec3f(0.0))){metric=min(distance(edge(t.a.xyz,t.b.xyz,q.p.xyz),q.p.xyz),min(distance(edge(t.b.xyz,t.c.xyz,q.p.xyz),q.p.xyz),distance(edge(t.c.xyz,t.a.xyz,q.p.xyz),q.p.xyz)));}
    if(any(abs(weights)<vec3f(1e-5))||abs(metric-best)<1e-5){uncertain=1.0;}
    if(metric<=best&&(chosen==0.0||metric<best)){best=metric;chosen=f32(i+1u);}
  }
  results[k]=vec4f(chosen,best,uncertain,0.0);
}
@compute @workgroup_size(64)
fn rays(@builtin(global_invocation_id) id:vec3u){
  let k=id.x;if(k>=arrayLength(&queries)){return;}let q=queries[k];var best=q.d.w;var chosen=0.0;var uncertain=0.0;
  for(var i=0u;i<arrayLength(&triangles);i++){
    let t=triangles[i];let n=cross(t.b.xyz-t.a.xyz,t.c.xyz-t.a.xyz);let nn=dot(n,n);
    if(nn<1e-20){uncertain=1.0;continue;}
    let den=dot(n,q.d.xyz);let numerator=dot(n,t.a.xyz-q.p.xyz);
    let error=1e-6*length(n)*length(q.d.xyz);
    if(abs(den)<=error){uncertain=1.0;continue;}
    let metric=numerator/den;let weights=bary(t,q.p.xyz+metric*q.d.xyz,n,nn);
    if(any(abs(weights)<vec3f(1e-5))||abs(metric-q.p.w)<1e-5||abs(metric-best)<1e-5){uncertain=1.0;}
    if(metric>=q.p.w&&metric<=best&&all(weights>=vec3f(0.0))&&(chosen==0.0||metric<best)){best=metric;chosen=f32(i+1u);}
  }
  results[k]=vec4f(chosen,best,uncertain,0.0);
}`;
export interface QueryBatch3 {readonly hits:readonly(SurfaceHit3|null)[];readonly stats:{queries:number;dispatches:number;refinements:number;transferBytes:number;wallMs:number;timings?:PhaseTimings3}}
/** Prepared geometry uploaded once. GPU scans triangles per query without an
 * all-pairs allocation. Explicit work cap bounds this initial batch kernel;
 * the CPU BVH refines uncertain results and handles extreme f32 ranges. */
export class GpuSurfaceQueries3 {
  /** Bytes actually uploaded when this target was prepared (zero for CPU-only normalization). */
  get uploadBytes():number{return this.triangles&&!this.forceCpu?this.source.triangles.length*48:0;}
  private tail:Promise<unknown>=Promise.resolve();private closed=false;
  private constructor(private device:GPUDevice,readonly source:SurfaceQueries3,private triangles:GPUBuffer|null,private pipelines:{rays:GPUComputePipeline;nearest:GPUComputePipeline},private origin:Vec3,private scale:number,private capacity:number,private forceCpu:boolean,readonly preparationTimings:PhaseTimings3){}
  static async create(device:GPUDevice,source:SurfaceQueries3,options:{memoryBudgetBytes?:number;batchSize?:number}={}):Promise<GpuSurfaceQueries3>{
    const timing=new PhaseClock3(),packingStarted=performance.now();
    const size=source.triangles.length*48,budget=options.memoryBudgetBytes??128*1024*1024,capacity=Math.min(options.batchSize??4096,Math.floor((budget-size)/64),Math.floor(device.limits.maxStorageBufferBindingSize/32),device.limits.maxComputeWorkgroupsPerDimension*64);
    if(!Number.isSafeInteger(capacity)||capacity<1||size>device.limits.maxStorageBufferBindingSize||!Number.isFinite(budget)||source.triangles.length>16_777_215)throw new Error('surface queries exceed memory or device capacity');
    const origin=source.triangles[0]?.[0]??[0,0,0];let scale=0;for(const t of source.triangles)for(const p of t)for(let k=0;k<3;k++)scale=Math.max(scale,Math.abs(p[k]-origin[k]));scale=scale||1;
    const packed=new Float32Array(source.triangles.length*12);source.triangles.forEach((t,i)=>t.forEach((p,j)=>p.forEach((v,k)=>packed[i*12+j*4+k]=(v-origin[k])/scale)));
    const forceCpu=!packed.every(Number.isFinite)||!Number.isFinite(scale);
    timing.since('packingMs',packingStarted);
    const setupStarted=performance.now();
    const module=device.createShaderModule({label:'Batched surface nearest and ray queries',code:shader}),messages=await module.getCompilationInfo();if(messages.messages.some(m=>m.type==='error'))throw new Error(messages.messages.map(m=>m.message).join('\n'));
    const rays=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'rays'}}),nearest=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'nearest'}});
    const triangles=size?device.createBuffer({size,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST}):null;timing.since('setupMs',setupStarted);if(triangles&&!forceCpu)timing.measure('uploadSubmitMs',()=>device.queue.writeBuffer(triangles,0,packed));
    return new GpuSurfaceQueries3(device,source,triangles,{rays,nearest},origin,scale,capacity,forceCpu,timing.finish());
  }
  rays(queries:readonly RayQuery3[],options:{signal?:AbortSignal;maxTests?:number}={}):Promise<QueryBatch3>{const timing=new PhaseClock3();const owned=timing.measure('captureMs',()=>{queries.forEach(validateRay3);return structuredClone(queries);});return this.submit('rays',owned,options,timing);}
  segments(segments:readonly(readonly[Vec3,Vec3])[],options:{signal?:AbortSignal;maxTests?:number}={}):Promise<QueryBatch3>{const timing=new PhaseClock3();const owned=timing.measure('captureMs',()=>{const rows=segments.map(([a,b])=>({origin:a,direction:[b[0]-a[0],b[1]-a[1],b[2]-a[2]] as Vec3,near:0,far:1}));rows.forEach(validateRay3);return structuredClone(rows);});return this.submit('rays',owned,options,timing);}
  nearest(queries:readonly NearestQuery3[],options:{signal?:AbortSignal;maxTests?:number}={}):Promise<QueryBatch3>{const timing=new PhaseClock3();const owned=timing.measure('captureMs',()=>{queries.forEach(validateNearest3);return structuredClone(queries);});return this.submit('nearest',owned,options,timing);}
  private submit(kind:'rays'|'nearest',queries:readonly(RayQuery3|NearestQuery3)[],options:{signal?:AbortSignal;maxTests?:number},timing:PhaseClock3){
    const limit=options.maxTests??Infinity;if(!(limit===Infinity||Number.isSafeInteger(limit))||limit<0)return Promise.reject(new Error('query work limit must be a nonnegative integer'));
    if(queries.length*this.source.triangles.length>limit)return Promise.reject(new Error(`surface query batch exceeds ${limit} triangle tests; reduce the batch or explicitly raise maxTests`));
    const queued=performance.now();
    const job=this.tail.then(()=>{timing.since('queueMs',queued);return this.run(kind,queries,timing,options.signal);});this.tail=job.catch(()=>{});return job;
  }
  private async run(kind:'rays'|'nearest',queries:readonly(RayQuery3|NearestQuery3)[],timing:PhaseClock3,signal?:AbortSignal):Promise<QueryBatch3>{
    const check=()=>{signal?.throwIfAborted();if(this.closed)throw new Error('surface query session is disposed');};check();const start=performance.now(),hits:(SurfaceHit3|null)[]=[],stats={queries:queries.length,dispatches:0,refinements:0,transferBytes:0,wallMs:0};
    const cpu=(q:RayQuery3|NearestQuery3)=>'point'in q?this.source.nearest([q])[0]:this.source.rays([q])[0];
    if(!this.triangles||this.forceCpu){timing.measure('refinementMs',()=>{for(const q of queries){check();hits.push(cpu(q));stats.refinements++;}});stats.wallMs=performance.now()-start;return {hits,stats:{...stats,timings:timing.finish()}};}
    const capacity=Math.min(this.capacity,queries.length);if(!capacity)return {hits,stats:{...stats,timings:timing.finish()}};
    const setupStarted=performance.now();
    const input=this.device.createBuffer({size:capacity*32,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST}),output=this.device.createBuffer({size:capacity*16,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC}),staging=this.device.createBuffer({size:capacity*16,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});
    timing.since('setupMs',setupStarted);
    this.device.pushErrorScope('validation');
    try {
      for(let offset=0;offset<queries.length;offset+=capacity){check();const packingStarted=performance.now();const batch=queries.slice(offset,offset+capacity),packed=new Float32Array(batch.length*8),fallback=new Set<number>();
        batch.forEach((q,i)=>{const p='point'in q?q.point:q.origin;for(let k=0;k<3;k++)packed[i*8+k]=(p[k]-this.origin[k])/this.scale;
          if('point'in q)packed[i*8+3]=Math.min((q.maxDistance??Infinity)/this.scale,3.402823e38);
          else{packed[i*8+3]=q.near??0;for(let k=0;k<3;k++)packed[i*8+4+k]=q.direction[k]/this.scale;packed[i*8+7]=Math.min(q.far??Infinity,3.402823e38);if(packed.slice(i*8+4,i*8+7).every(v=>v===0))fallback.add(i);}
          if(!packed.slice(i*8,i*8+8).every(Number.isFinite)||packed.slice(i*8,i*8+3).some(v=>Math.abs(v)>1e6))fallback.add(i);
          if(!('point'in q)){const magnitude=Math.hypot(...packed.slice(i*8+4,i*8+7));if(magnitude<1e-6||magnitude>1e6||Math.abs(q.near??0)>1e6)fallback.add(i);}
        });
        timing.since('packingMs',packingStarted);timing.measure('uploadSubmitMs',()=>this.device.queue.writeBuffer(input,0,packed));const dispatchStarted=performance.now();const pipeline=this.pipelines[kind],bind=this.device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.triangles}},{binding:1,resource:{buffer:input,size:batch.length*32}},{binding:2,resource:{buffer:output,size:batch.length*16}}]});
        const encoder=this.device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,bind);pass.dispatchWorkgroups(Math.ceil(batch.length/64));pass.end();encoder.copyBufferToBuffer(output,0,staging,0,batch.length*16);this.device.queue.submit([encoder.finish()]);stats.dispatches++;
        timing.since('dispatchSubmitMs',dispatchStarted);await timing.wait('readbackWaitMs',()=>staging.mapAsync(GPUMapMode.READ,0,batch.length*16));const copyStarted=performance.now();let result:Float32Array;try{result=new Float32Array(staging.getMappedRange(0,batch.length*16).slice(0));}finally{staging.unmap();timing.since('readbackCopyMs',copyStarted);}check();stats.transferBytes+=batch.length*48;
        const refineStarted=performance.now();
        batch.forEach((q,i)=>{const triangle=result[i*4]-1;if(result[i*4+2]!==0||fallback.has(i)||!Number.isFinite(result[i*4+1])){hits.push(cpu(q));stats.refinements++;return;}if(triangle<0){hits.push(null);return;}const data='point'in q?nearestTriangle3(this.source.triangles[triangle],q.point):rayTriangle3(this.source.triangles[triangle],q);if(!data||('point'in q&&data.distance>(q.maxDistance??Infinity))){hits.push(cpu(q));stats.refinements++;}else hits.push(this.source.hit(triangle,data));});timing.since('refinementMs',refineStarted);
      }
    }finally{input.destroy();output.destroy();staging.destroy();const error=await timing.wait('validationWaitMs',()=>this.device.popErrorScope());if(error)throw new Error(`WebGPU surface queries: ${error.message}`);}
    stats.wallMs=performance.now()-start;return {hits,stats:{...stats,timings:timing.finish()}};
  }
  async dispose():Promise<void>{this.closed=true;await this.tail;this.triangles?.destroy();}
}
