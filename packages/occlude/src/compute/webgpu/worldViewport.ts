/// <reference types="@webgpu/types" />
import { cameraShift3, type CameraFrame3 } from '../../three/camera.js';
import { finite3, type Triangle3, type Vec3 } from '../../three/math.js';

const shader = /* wgsl */ `
struct View { right:vec4f, up:vec4f, back:vec4f, eye:vec4f, viewport:vec4f, shift:vec4f }
@group(0) @binding(0) var<uniform> view:View;
struct Vertex { @builtin(position) p:vec4f, @location(0) color:vec3f }
fn camera(p:vec3f)->vec3f { let d=p-view.eye.xyz;return vec3f(dot(d,view.right.xyz),dot(d,view.up.xyz),dot(d,view.back.xyz)); }
fn project(p:vec3f)->vec4f {
  let near=view.back.w;let far=view.eye.w;
  if(view.viewport.z>0.5){return vec4f(p.x*view.right.w-view.shift.x*p.z,p.y*view.up.w-view.shift.y*p.z,far/(near-far)*p.z+far/(near-far)*near,-p.z);}
  return vec4f(p.x*view.right.w+view.shift.x,p.y*view.up.w+view.shift.y,(-p.z-near)/(far-near),1.0);
}
@vertex fn surface(@location(0) p:vec3f)->Vertex { return Vertex(project(camera(p)),vec3f(0.72,0.78,0.82)); }
@vertex fn wire(@location(0) aWorld:vec3f,@location(1) bWorld:vec3f,@builtin(vertex_index) i:u32)->Vertex {
  let a=camera(aWorld);let b=camera(bWorld);var lo=0.0;var hi=1.0;
  let da=-a.z-view.back.w;let db=-b.z-view.back.w;
  let fa=view.eye.w+a.z;let fb=view.eye.w+b.z;
  if((da<0.0&&db<0.0)||(fa<0.0&&fb<0.0)){return Vertex(vec4f(2.0,2.0,2.0,1.0),vec3f(0.0));}
  if(da<0.0){lo=max(lo,da/(da-db));}if(db<0.0){hi=min(hi,da/(da-db));}
  if(fa<0.0){lo=max(lo,fa/(fa-fb));}if(fb<0.0){hi=min(hi,fa/(fa-fb));}
  if(lo>=hi){return Vertex(vec4f(2.0,2.0,2.0,1.0),vec3f(0.0));}
  let p=project(mix(a,b,lo));let q=project(mix(a,b,hi));
  let delta=(q.xy/q.w-p.xy/p.w)*view.viewport.xy;
  let distance=length(delta);
  if(distance==0.0){return Vertex(vec4f(2.0,2.0,2.0,1.0),vec3f(0.0));}
  let offset=vec2f(-delta.y,delta.x)/distance*2.0/view.viewport.xy;
  let corners=array<vec2f,6>(vec2f(0.0,1.0),vec2f(0.0,-1.0),vec2f(1.0,1.0),vec2f(1.0,1.0),vec2f(0.0,-1.0),vec2f(1.0,-1.0));
  let corner=corners[i];var clip=mix(p,q,corner.x);clip=vec4f(clip.xy+offset*corner.y*clip.w,clip.zw);
  return Vertex(clip,vec3f(0.07,0.12,0.18));
}
@fragment fn fragment(v:Vertex)->@location(0) vec4f {return vec4f(v.color,1.0);}
`;

/** Construction raster only. Retains immutable world geometry on the GPU;
 * orbit updates one 96-byte camera uniform. Final vectors use the geometric
 * visibility pipeline, never these depth pixels or raster depth bias. */
export class GpuWorldViewport3 {
  readonly ready: Promise<void>;
  private readonly context: GPUCanvasContext;
  private readonly surfacePipeline: GPURenderPipeline;
  private readonly wirePipeline: GPURenderPipeline;
  private readonly uniform: GPUBuffer;
  private readonly bindings: GPUBindGroup;
  private depth?: GPUTexture;
  private vertices?: GPUBuffer;
  private edges?: GPUBuffer;
  private triangles?: readonly Triangle3[];
  private wires?: readonly (readonly [Vec3,Vec3])[];
  private center:Vec3=[0,0,0];
  private scale=1;
  private width=0;
  private height=0;
  private bytes=96;
  private uploads=0;
  private uploadBytes=0;
  private frames=0;
  private disposed=false;
  constructor(private readonly device:GPUDevice,private readonly canvas:HTMLCanvasElement|OffscreenCanvas,format:GPUTextureFormat){
    const context=canvas.getContext('webgpu') as GPUCanvasContext|null;
    if(!context)throw new Error('WebGPU canvas context unavailable');
    this.context=context;context.configure({device,format,alphaMode:'opaque'});
    device.pushErrorScope('validation');
    const module=device.createShaderModule({label:'Retained construction camera',code:shader});
    const layout=device.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.VERTEX,buffer:{type:'uniform'}}]});
    const pipelineLayout=device.createPipelineLayout({bindGroupLayouts:[layout]});
    this.uniform=device.createBuffer({label:'Construction camera',size:96,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    this.bindings=device.createBindGroup({layout,entries:[{binding:0,resource:{buffer:this.uniform}}]});
    const fragment={module,entryPoint:'fragment',targets:[{format}]};
    this.surfacePipeline=device.createRenderPipeline({layout:pipelineLayout,vertex:{module,entryPoint:'surface',buffers:[{arrayStride:12,attributes:[{shaderLocation:0,offset:0,format:'float32x3'}]}]},fragment,primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:'depth24plus',depthWriteEnabled:true,depthCompare:'less-equal',depthBias:1,depthBiasSlopeScale:1}});
    this.wirePipeline=device.createRenderPipeline({layout:pipelineLayout,vertex:{module,entryPoint:'wire',buffers:[{arrayStride:24,stepMode:'instance',attributes:[{shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x3'}]}]},fragment,primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:'depth24plus',depthWriteEnabled:true,depthCompare:'less-equal'}});
    this.ready=device.popErrorScope().then(error=>{if(error)throw new Error(error.message);});
  }
  get stats(){return {geometryUploads:this.uploads,geometryUploadBytes:this.uploadBytes,uniformUploadBytes:this.frames*96,residentBufferBytes:this.bytes};}
  private upload(triangles:readonly Triangle3[],wires:readonly(readonly[Vec3,Vec3])[]):void{
    if(this.triangles===triangles&&this.wires===wires)return;
    let low=[Infinity,Infinity,Infinity],high=[-Infinity,-Infinity,-Infinity];
    for(const rows of [triangles,wires])for(const row of rows)for(const p of row){finite3(p);for(let k=0;k<3;k++){low[k]=Math.min(low[k],p[k]);high[k]=Math.max(high[k],p[k]);}}
    this.center=low.map((v,k)=>Number.isFinite(v)?v/2+high[k]/2:0) as unknown as Vec3;
    this.scale=Math.max(0,...high.map((v,k)=>Number.isFinite(v)?Math.max(Math.abs(v-this.center[k]),Math.abs(low[k]-this.center[k])):0))||1;
    const pack=(rows:readonly(readonly Vec3[])[],count:number)=>{
      const data=new Float32Array(count*3);let at=0;
      for(const row of rows)for(const p of row)for(let k=0;k<3;k++)data[at++]=(p[k]-this.center[k])/this.scale;
      if(!data.length)return;
      const buffer=this.device.createBuffer({size:data.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST});
      this.device.queue.writeBuffer(buffer,0,data);this.bytes+=data.byteLength;this.uploadBytes+=data.byteLength;return buffer;
    };
    this.vertices?.destroy();this.edges?.destroy();this.bytes=96;
    this.vertices=pack(triangles,triangles.length*3);this.edges=pack(wires,wires.length*2);
    this.triangles=triangles;this.wires=wires;this.uploads++;
  }
  draw(frame:CameraFrame3,triangles:readonly Triangle3[],wires:readonly(readonly[Vec3,Vec3])[]):void{
    if(this.disposed)throw new Error('construction viewport disposed');
    this.upload(triangles,wires);
    const c=frame.camera,aspect=frame.paper.width/frame.paper.height;
    const y=c.kind==='orthographic'?2*this.scale/c.span:1/Math.tan(c.fovDegrees*Math.PI/360),shift=cameraShift3(c);
    const uniform=new Float32Array([...frame.right,y/aspect,...frame.up,y,...frame.back,c.near/this.scale,...c.eye.map((v,k)=>(v-this.center[k])/this.scale),c.far/this.scale,this.canvas.width,this.canvas.height,c.kind==='orthographic'?0:1,0,...shift,0,0]);
    if(!uniform.every(Number.isFinite)||!(uniform[3]>0&&uniform[7]>0&&uniform[11]>0&&uniform[15]>uniform[11]))throw new Error('construction camera exceeds normalized GPU coordinate range');
    this.device.queue.writeBuffer(this.uniform,0,uniform);this.frames++;
    if(!this.depth||this.width!==this.canvas.width||this.height!==this.canvas.height){this.depth?.destroy();this.width=this.canvas.width;this.height=this.canvas.height;this.depth=this.device.createTexture({size:[this.width,this.height],format:'depth24plus',usage:GPUTextureUsage.RENDER_ATTACHMENT});}
    const encoder=this.device.createCommandEncoder();
    const pass=encoder.beginRenderPass({colorAttachments:[{view:this.context.getCurrentTexture().createView(),clearValue:[.96,.95,.92,1],loadOp:'clear',storeOp:'store'}],depthStencilAttachment:{view:this.depth.createView(),depthClearValue:1,depthLoadOp:'clear',depthStoreOp:'store'}});
    pass.setBindGroup(0,this.bindings);
    if(this.vertices){pass.setPipeline(this.surfacePipeline);pass.setVertexBuffer(0,this.vertices);pass.draw(triangles.length*3);}
    if(this.edges){pass.setPipeline(this.wirePipeline);pass.setVertexBuffer(0,this.edges);pass.draw(6,wires.length);}
    pass.end();this.device.queue.submit([encoder.finish()]);
  }
  dispose():void{if(this.disposed)return;this.disposed=true;this.vertices?.destroy();this.edges?.destroy();this.uniform.destroy();this.depth?.destroy();this.context.unconfigure();this.bytes=0;}
}
