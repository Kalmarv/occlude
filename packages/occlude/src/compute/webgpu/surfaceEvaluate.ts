/// <reference types="@webgpu/types" />
import {PhaseClock3,type PhaseTimings3} from '../../three/timing.js';
import {packSurfaceTarget3,validateEvaluationBatch3,evaluateLocation3,type PackedSurfaceTarget3,type SurfaceEvaluationTarget3,type SurfaceEvaluationBatch3,type SurfaceEvaluationResult3} from '../../three/surface/evaluate.js';
import type {ToneRecipe3,ImageRecipe3} from '../../three/surface/tone.js';
const shader=/*wgsl*/`
struct Triangle { a:vec4f, b:vec4f, c:vec4f, n:vec4f, uvab:vec4f, uvc:vec4f }
struct Location { tri:u32, w0:f32, w1:f32, w2:f32 }
struct Params { direction:vec4f, image:vec4u, flags:vec4u }
@group(0) @binding(0) var<storage,read> triangles:array<Triangle>;
@group(0) @binding(1) var<storage,read> locations:array<Location>;
@group(0) @binding(2) var<storage,read_write> results:array<vec4f>;
@group(0) @binding(3) var<uniform> params:Params;
@group(0) @binding(4) var<storage,read> pixels:array<u32>;
fn channel(p:u32)->f32 {
  let r=f32(p&255u);let g=f32((p>>8u)&255u);let b=f32((p>>16u)&255u);let a=f32((p>>24u)&255u);
  if((params.flags.y&3u)==2u){return a;}
  return 0.2126*r+0.7152*g+0.0722*b;
}
fn wrapped(v:f32)->f32 {
  if((params.flags.y&8u)!=0u){return v-floor(v);}
  return clamp(v,0.0,1.0);
}
fn image(uv:vec2f)->f32 {
  let w=f32(params.image.x);let h=f32(params.image.y);
  let u=wrapped(uv.x);var row=wrapped(uv.y);
  if((params.flags.y&4u)==0u){row=1.0-row;}
  let fx=clamp(u*w-0.5,0.0,w-1.0);let fy=clamp(row*h-0.5,0.0,h-1.0);
  let x0=u32(floor(fx));let y0=u32(floor(fy));
  let x1=min(params.image.x-1u,x0+1u);let y1=min(params.image.y-1u,y0+1u);
  let tx=fx-floor(fx);let ty=fy-floor(fy);
  let raw=(channel(pixels[y0*params.image.x+x0])*(1.0-tx)*(1.0-ty)+channel(pixels[y0*params.image.x+x1])*tx*(1.0-ty)+channel(pixels[y1*params.image.x+x0])*(1.0-tx)*ty+channel(pixels[y1*params.image.x+x1])*tx*ty)/255.0;
  if((params.flags.y&3u)==1u){return 1.0-raw;}
  return raw;
}
@compute @workgroup_size(64)
fn evaluate(@builtin(global_invocation_id) id:vec3u){
  let k=id.x;if(k>=arrayLength(&locations)){return;}
  let l=locations[k];let t=triangles[l.tri];
  let p=t.a.xyz+(t.b.xyz-t.a.xyz)*l.w1+(t.c.xyz-t.a.xyz)*l.w2;
  let uv=t.uvab.xy*l.w0+t.uvab.zw*l.w1+t.uvc.xy*l.w2;
  var tone=0.0;
  if(params.flags.x==1u){
    let cosine=max(0.0,dot(t.n.xyz,params.direction.xyz));
    var response=cosine;
    if((params.flags.y&16u)!=0u){response=cosine*cosine*(3.0-2.0*cosine);}
    let ambient=params.direction.w;
    tone=clamp(1.0-(ambient+(1.0-ambient)*response),0.0,1.0);
  } else if(params.flags.x==2u){tone=image(uv);}
  results[k*3u]=vec4f(p,0.0);results[k*3u+1u]=t.n;results[k*3u+2u]=vec4f(uv,tone,0.0);
}`;
const TRIANGLE_BYTES=96,LOCATION_BYTES=16,RESULT_BYTES=48;
/** Prepared target uploaded once; batches evaluate many locations per dispatch.
 * Model-space light recipes need the prototype normal, which is not packed on
 * the device, so they fall through to the CPU reference and are counted. */
export class GpuSurfaceEvaluation3 {
  get uploadBytes():number{return this.forceCpu?0:this.packed.triangles*TRIANGLE_BYTES;}
  private tail:Promise<unknown>=Promise.resolve();private closed=false;
  private image?:{recipe:ImageRecipe3;buffer:GPUBuffer;bytes:number};
  private constructor(private readonly device:GPUDevice,readonly packed:PackedSurfaceTarget3,private readonly triangles:GPUBuffer|null,private readonly pipeline:GPUComputePipeline,private readonly origin:readonly [number,number,number],private readonly scale:number,readonly capacity:number,private readonly forceCpu:boolean,readonly preparationTimings:PhaseTimings3){}
  static async create(device:GPUDevice,target:SurfaceEvaluationTarget3,options:{memoryBudgetBytes?:number;batchSize?:number}={}):Promise<GpuSurfaceEvaluation3>{
    const timing=new PhaseClock3(),packed=timing.measure('packingMs',()=>packSurfaceTarget3(target)),packingStarted=performance.now();
    const size=packed.triangles*TRIANGLE_BYTES,budget=options.memoryBudgetBytes??128*1024*1024;
    const capacity=Math.min(options.batchSize??16384,Math.floor((budget-size)/(LOCATION_BYTES+2*RESULT_BYTES)),Math.floor(device.limits.maxStorageBufferBindingSize/RESULT_BYTES),device.limits.maxComputeWorkgroupsPerDimension*64);
    if(!Number.isSafeInteger(capacity)||capacity<1||size>device.limits.maxStorageBufferBindingSize||!Number.isFinite(budget)||packed.triangles>16_777_215)throw new Error('surface evaluation exceeds memory or device capacity');
    const v=packed.vertices,origin=[v[0]??0,v[1]??0,v[2]??0] as const;let scale=0;
    for(let i=0;i<v.length;i++)scale=Math.max(scale,Math.abs(v[i]-origin[i%3]));scale=scale||1;
    const data=new Float32Array(packed.triangles*24);
    for(let i=0;i<packed.triangles;i++){
      for(let j=0;j<3;j++)for(let k=0;k<3;k++)data[i*24+j*4+k]=(v[i*9+j*3+k]-origin[k])/scale;
      for(let k=0;k<3;k++)data[i*24+12+k]=packed.normals[i*3+k];
      if(packed.uv)for(let k=0;k<6;k++)data[i*24+16+k]=packed.uv[i*6+k];
    }
    const forceCpu=!data.every(Number.isFinite)||!Number.isFinite(scale);
    timing.since('packingMs',packingStarted);
    const setupStarted=performance.now();
    const module=device.createShaderModule({label:'Batched surface location and tone evaluation',code:shader}),messages=await module.getCompilationInfo();
    if(messages.messages.some(m=>m.type==='error'))throw new Error(messages.messages.map(m=>m.message).join('\n'));
    const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'evaluate'}});
    const triangles=size?device.createBuffer({size,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST}):null;timing.since('setupMs',setupStarted);
    if(triangles&&!forceCpu)timing.measure('uploadSubmitMs',()=>device.queue.writeBuffer(triangles,0,data));
    return new GpuSurfaceEvaluation3(device,packed,triangles,pipeline,origin,scale,capacity,forceCpu,timing.finish());
  }
  evaluate(batch:SurfaceEvaluationBatch3,recipe?:ToneRecipe3,options:{signal?:AbortSignal}={}):Promise<SurfaceEvaluationResult3>{
    const timing=new PhaseClock3();
    let owned:SurfaceEvaluationBatch3;
    try{owned=timing.measure('captureMs',()=>{validateEvaluationBatch3(this.packed,batch);return {triangle:batch.triangle.slice(),weights:batch.weights.slice()};});}catch(e){return Promise.reject(e);}
    const queued=performance.now();
    const job=this.tail.then(()=>{timing.since('queueMs',queued);return this.run(owned,recipe,timing,options.signal);});this.tail=job.catch(()=>{});return job;
  }
  private imageBuffer(recipe:ImageRecipe3,timing:PhaseClock3):{buffer:GPUBuffer;uploaded:number}{
    if(this.image?.recipe===recipe)return {buffer:this.image.buffer,uploaded:0};
    this.image?.buffer.destroy();
    const px=recipe.pixels,packed=new Uint32Array(px.width*px.height);
    for(let i=0;i<packed.length;i++)packed[i]=px.data[i*4]|(px.data[i*4+1]<<8)|(px.data[i*4+2]<<16)|(px.data[i*4+3]<<24);
    const bytes=Math.max(4,packed.byteLength);
    if(bytes>this.device.limits.maxStorageBufferBindingSize)throw new Error('surface image exceeds device storage capacity');
    const buffer=this.device.createBuffer({size:bytes,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
    timing.measure('uploadSubmitMs',()=>this.device.queue.writeBuffer(buffer,0,packed));
    this.image={recipe,buffer,bytes};return {buffer,uploaded:bytes};
  }
  private async run(batch:SurfaceEvaluationBatch3,recipe:ToneRecipe3|undefined,timing:PhaseClock3,signal?:AbortSignal):Promise<SurfaceEvaluationResult3>{
    const check=()=>{signal?.throwIfAborted();if(this.closed)throw new Error('surface evaluation session is disposed');};check();
    const n=batch.triangle.length,out={position:new Float32Array(n*3),normal:new Float32Array(n*3),uv:this.packed.uv?new Float32Array(n*2):undefined,tone:recipe?new Float32Array(n):undefined};
    const stats={backend:'gpu' as const,dispatches:0,transferBytes:0,cacheHit:false,targetUploadBytes:0,refinements:0};
    const cpuOnly=!this.triangles||this.forceCpu||recipe?.kind==='light'&&recipe.space==='model'||recipe?.kind==='image'&&!this.packed.uv;
    if(cpuOnly){timing.measure('refinementMs',()=>{for(let i=0;i<n;i++){evaluateLocation3(this.packed,batch,i,recipe,out);stats.refinements++;}});return {...out,stats:{...stats,timings:timing.finish()}};}
    if(!n)return {...out,stats:{...stats,timings:timing.finish()}};
    const capacity=Math.min(this.capacity,n),setupStarted=performance.now();
    const input=this.device.createBuffer({size:capacity*LOCATION_BYTES,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST}),output=this.device.createBuffer({size:capacity*RESULT_BYTES,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC}),staging=this.device.createBuffer({size:capacity*RESULT_BYTES,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});
    const params=this.device.createBuffer({size:48,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    const uniform=new ArrayBuffer(48),f=new Float32Array(uniform),u=new Uint32Array(uniform);
    let pixels:GPUBuffer|undefined,dummy:GPUBuffer|undefined;
    if(recipe?.kind==='light'){f[0]=recipe.direction[0];f[1]=recipe.direction[1];f[2]=recipe.direction[2];f[3]=recipe.ambient;u[8]=1;u[9]=recipe.ramp==='smooth'?16:0;}
    else if(recipe?.kind==='image'){
      const {buffer,uploaded}=this.imageBuffer(recipe,timing);pixels=buffer;stats.transferBytes+=uploaded;
      u[4]=recipe.pixels.width;u[5]=recipe.pixels.height;u[8]=2;u[9]=(recipe.channel==='dark'?1:recipe.channel==='a'?2:0)|(recipe.origin==='top-left'?4:0)|(recipe.wrap==='repeat'?8:0);
    }
    if(!pixels){dummy=this.device.createBuffer({size:4,usage:GPUBufferUsage.STORAGE});pixels=dummy;}
    timing.since('setupMs',setupStarted);
    timing.measure('uploadSubmitMs',()=>this.device.queue.writeBuffer(params,0,uniform));stats.transferBytes+=48;
    this.device.pushErrorScope('validation');
    try{
      for(let offset=0;offset<n;offset+=capacity){
        check();const packingStarted=performance.now(),count=Math.min(capacity,n-offset),packed=new ArrayBuffer(count*LOCATION_BYTES),pu=new Uint32Array(packed),pf=new Float32Array(packed),fallback=new Set<number>();
        for(let i=0;i<count;i++){
          const j=offset+i,t=batch.triangle[j];pu[i*4]=t;pf[i*4+1]=batch.weights[j*3];pf[i*4+2]=batch.weights[j*3+1];pf[i*4+3]=batch.weights[j*3+2];
          const v=this.packed.vertices;for(let k=0;k<9;k++)if(Math.abs((v[t*9+k]-this.origin[k%3])/this.scale)>1e6)fallback.add(i);
        }
        timing.since('packingMs',packingStarted);timing.measure('uploadSubmitMs',()=>this.device.queue.writeBuffer(input,0,packed));
        const dispatchStarted=performance.now();
        const bind=this.device.createBindGroup({layout:this.pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.triangles!}},{binding:1,resource:{buffer:input,size:count*LOCATION_BYTES}},{binding:2,resource:{buffer:output,size:count*RESULT_BYTES}},{binding:3,resource:{buffer:params}},{binding:4,resource:{buffer:pixels}}]});
        const encoder=this.device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(this.pipeline);pass.setBindGroup(0,bind);pass.dispatchWorkgroups(Math.ceil(count/64));pass.end();
        encoder.copyBufferToBuffer(output,0,staging,0,count*RESULT_BYTES);this.device.queue.submit([encoder.finish()]);stats.dispatches++;timing.since('dispatchSubmitMs',dispatchStarted);
        await timing.wait('readbackWaitMs',()=>staging.mapAsync(GPUMapMode.READ,0,count*RESULT_BYTES));
        const copyStarted=performance.now();let result:Float32Array;try{result=new Float32Array(staging.getMappedRange(0,count*RESULT_BYTES).slice(0));}finally{staging.unmap();timing.since('readbackCopyMs',copyStarted);}
        check();stats.transferBytes+=count*(LOCATION_BYTES+RESULT_BYTES);
        const refineStarted=performance.now();
        for(let i=0;i<count;i++){
          const j=offset+i,r=i*12;
          if(fallback.has(i)||!Number.isFinite(result[r+10])){evaluateLocation3(this.packed,batch,j,recipe,out);stats.refinements++;continue;}
          for(let k=0;k<3;k++){out.position[j*3+k]=result[r+k]*this.scale+this.origin[k];out.normal[j*3+k]=result[r+4+k];}
          if(out.uv){out.uv[j*2]=result[r+8];out.uv[j*2+1]=result[r+9];}
          if(out.tone)out.tone[j]=result[r+10];
        }
        timing.since('refinementMs',refineStarted);
      }
    }finally{
      input.destroy();output.destroy();staging.destroy();params.destroy();dummy?.destroy();
      const error=await timing.wait('validationWaitMs',()=>this.device.popErrorScope());if(error)throw new Error(`WebGPU surface evaluation: ${error.message}`);
    }
    return {...out,stats:{...stats,timings:timing.finish()}};
  }
  async dispose():Promise<void>{this.closed=true;await this.tail;this.triangles?.destroy();this.image?.buffer.destroy();this.image=undefined;}
}
