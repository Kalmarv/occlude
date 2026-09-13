import { verifyWorldViewport3 } from './viewportCheck.js';
import { initOcclude, exportSvg, sketch, paper, pen, mm } from 'occlude';
import { grid3 } from 'occlude/src/three/geometry/model.js';
import { box3 } from 'occlude/src/three/geometry/surface.js';
import { cameraFrame3, type Camera3 } from 'occlude/src/three/camera.js';
import { featureSnapshot3, type SurfaceObject3 } from 'occlude/src/three/features/snapshot.js';
import { classifySceneCpu3, classifySceneGpu3, type ClassifiedScene3 } from 'occlude/src/three/visibility/scene.js';
import { constructStrokes3 } from 'occlude/src/three/strokes/construct.js';
import { paperStrokes3 } from 'occlude/src/three/strokes/paper.js';
import { GpuIntervals3 } from 'occlude/src/compute/webgpu/interval.js';
import { GpuWorldViewport3 } from 'occlude/src/compute/webgpu/worldViewport.js';
import { GpuViewport3 } from 'occlude/src/compute/webgpu/viewport.js';
import { ConstructionScene3 } from './construction.js';
import { orbitCamera3 } from './orbit.js';
import { lineArt3 } from 'occlude/src/three/scene.js';

const camera:Camera3={kind:'orthographic',span:16,eye:[8,-10,12],target:[0,0,0],near:.1,far:50};
const frame=cameraFrame3(camera,{x:0,y:0,width:200,height:200});
const sets=[{id:'all',stroke:'ink'}];
const median=(values:number[])=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
function compare(cpu:ClassifiedScene3,gpu:ClassifiedScene3):number {
  let error=0;
  if(cpu.features.length!==gpu.features.length)throw new Error('feature count mismatch');
  cpu.features.forEach((a,i)=>{
    const b=gpu.features[i];
    for(const key of ['hidden','visible'] as const){
      if(a[key].length!==b[key].length)throw new Error(`interval topology mismatch: feature ${i}, ${key}`);
      a[key].forEach((range,j)=>range.forEach((v,k)=>{error=Math.max(error,Math.abs(v-b[key][j][k]));}));
    }
  });
  if(error>1e-5)throw new Error(`CPU/GPU parameter error ${error}`);
  return error;
}
function grid(n:number):SurfaceObject3[]{
  const surface=grid3(n,n,[12,12]);
  for(const point of surface.points){const [x,y]=point.position;point.position=[x,y,.15*Math.sin(x*2)*Math.cos(y*2)];}
  return [{id:'grid',surface}];
}
function city(n:number):SurfaceObject3[]{
  return Array.from({length:n*n},(_,i)=>{const x=i%n,y=Math.floor(i/n),height=.3+((x*17+y*31)%23)/20;return {id:`box-${i}`,surface:box3([.28,.28,height],[(x-(n-1)/2)*.4,(y-(n-1)/2)*.4,height/2])};});
}
self.onmessage=async()=>{
  let gpu:GpuIntervals3|undefined,viewport:GpuViewport3|undefined;
  try{
    const start=performance.now();await initOcclude();const wasmStartupMs=performance.now()-start;
    const deviceStart=performance.now();gpu=await GpuIntervals3.create(navigator.gpu!,{requireHardware:true});const gpuStartupMs=performance.now()-deviceStart;
    const resident=(await gpu.classify([])).residentBytes;
    let activeBytes=resident,peakBytes=resident,phasePeak=resident;
    const create=gpu.device.createBuffer.bind(gpu.device);
    gpu.device.createBuffer=descriptor=>{const buffer=create(descriptor);activeBytes+=descriptor.size;peakBytes=Math.max(peakBytes,activeBytes);phasePeak=Math.max(phasePeak,activeBytes);const destroy=buffer.destroy.bind(buffer);let live=true;buffer.destroy=()=>{if(live){activeBytes-=descriptor.size;live=false;}destroy();};return buffer;};
    const info=gpu.adapterInfo;
    const report:{[key:string]:unknown}={adapter:{vendor:info.vendor,architecture:info.architecture,device:info.device,description:info.description,isFallbackAdapter:info.isFallbackAdapter},wasmStartupMs,gpuStartupMs,viewport:[1120,840],pairCapacity:8192,intervalBufferBytes:resident,kernelTimestamps:'not collected; timings are end-to-end wall time',cases:[]};
    report.viewportConformance=await verifyWorldViewport3(gpu.device,navigator.gpu!.getPreferredCanvasFormat());
    postMessage({type:'progress',message:'retained viewport conformance passed'});
    const cases:unknown[]=[];
    for(const [name,make] of [['grid-4',()=>grid(4)],['grid-16',()=>grid(16)],['grid-40',()=>grid(40)],['grid-80',()=>grid(80)],['grid-100',()=>grid(100)],['city-30',()=>city(30)]] as const){
      postMessage({type:'progress',message:`${name}: construct and classify`});
      const modelStart=performance.now(),objects=make(),modelMs=performance.now()-modelStart;
      const snapshotStart=performance.now(),snapshot=featureSnapshot3(objects,[],frame),snapshotMs=performance.now()-snapshotStart;
      const cpuTimes:number[]=[],gpuTimes:number[]=[];let drawing:ClassifiedScene3|undefined,maxError=0,cpuDrawing:ClassifiedScene3|undefined;
      for(let iteration=0;iteration<3;iteration++){
        const cpu=()=>{const t=performance.now();cpuDrawing=classifySceneCpu3(snapshot);cpuTimes.push(performance.now()-t);};
        const compute=async()=>{const t=performance.now();drawing=await classifySceneGpu3(snapshot,gpu!,{maxCandidates:2_000_000});gpuTimes.push(performance.now()-t);};
        if(iteration%2){await compute();cpu();}else{cpu();await compute();}
        maxError=Math.max(maxError,compare(cpuDrawing!,drawing!));
      }
      const finishStart=performance.now(),strokes=constructStrokes3(drawing!,sets),strokeMs=performance.now()-finishStart;
      const exportStart=performance.now();
      const svg=exportSvg(sketch({paper:paper({width:mm(200),height:mm(200)}),margin:0,seed:42,pens:{ink:pen({width:mm(.2),color:'#18202A'})}},()=>paperStrokes3(strokes)));
      const exportMs=performance.now()-exportStart;
      const entry={name,objects:objects.length,faces:objects.reduce((n,o)=>n+o.surface.faces.length,0),triangles:snapshot.triangles.length,features:snapshot.features.length,modelMs,snapshotMs,cpuMs:cpuTimes,gpuMs:gpuTimes,cpuMedianMs:median(cpuTimes),gpuMedianMs:median(gpuTimes),candidates:drawing!.stats.candidates,dispatches:drawing!.stats.dispatches,refinements:drawing!.stats.refinements,transferBytes:drawing!.stats.transferBytes,intervals:drawing!.features.reduce((n,f)=>n+f.visible.length+f.hidden.length,0),maxParameterError:maxError,strokeMs,strokes:strokes.length,exportMs,svgBytes:svg.length,committedMedianMs:snapshotMs+median(gpuTimes)+strokeMs+exportMs};
      cases.push(entry);postMessage({type:'case',entry});
      if(name==='grid-100'){
        const prepStart=performance.now(),source=new ConstructionScene3(lineArt3({objects,camera,lineSets:sets})),prepareMs=performance.now()-prepStart;
        const canvas=new OffscreenCanvas(1120,840);viewport=new GpuViewport3(gpu.device,canvas,navigator.gpu!.getPreferredCanvasFormat());
        const times:number[]=[];
        for(let i=0;i<13;i++){
          const t=performance.now(),view=cameraFrame3(orbitCamera3(camera,i*.01,0),{x:0,y:0,width:1120,height:840}),geometry=source.project(view);
          viewport.draw(view,geometry.triangles,geometry.wires);canvas.transferToImageBitmap().close();await gpu.device.queue.onSubmittedWorkDone();
          times.push(performance.now()-t);
        }
        report.orbit={prepareMs,coldFrameMs:times[0],warmFrameMs:times.slice(1),warmMedianMs:median(times.slice(1)),warmFps:1000/median(times.slice(1)),peakExplicitBufferBytes:peakBytes,depthTextureBytes:1120*840*4,includes:'world-to-camera projection, raster submission, bitmap creation and GPU queue completion; excludes main-thread presentation'};
        viewport.dispose();viewport=undefined;
        phasePeak=activeBytes;
        const retainedCanvas=new OffscreenCanvas(1120,840),retained=new GpuWorldViewport3(gpu.device,retainedCanvas,navigator.gpu!.getPreferredCanvasFormat());
        await retained.ready;
        const retainedTimes:number[]=[];
        try{
          for(let i=0;i<13;i++){
            const t=performance.now(),view=cameraFrame3(orbitCamera3(camera,i*.01,0),{x:0,y:0,width:1120,height:840});
            retained.draw(view,source.triangles,source.wires);retainedCanvas.transferToImageBitmap().close();await gpu.device.queue.onSubmittedWorkDone();retainedTimes.push(performance.now()-t);
          }
          if(retained.stats.geometryUploads!==1)throw new Error('orbit re-uploaded unchanged geometry');
          report.retainedOrbit={coldFrameMs:retainedTimes[0],warmFrameMs:retainedTimes.slice(1),warmMedianMs:median(retainedTimes.slice(1)),warmFps:1000/median(retainedTimes.slice(1)),...retained.stats,peakExplicitBufferBytes:phasePeak,depthTextureBytes:1120*840*4,includes:'camera uniforms, raster submission, bitmap creation and GPU queue completion; excludes main-thread presentation'};
        }finally{retained.dispose();}
        postMessage({type:'progress',message:'large orbit measured'});
      }
      if(name==='city-30')postMessage({type:'svg',name,svg});
    }
    postMessage({type:'progress',message:'pathological overlap capacity check'});
    const overlap=featureSnapshot3(Array.from({length:100},(_,i)=>({id:`overlap-${i}`,surface:box3([2,2,2],[0,0,i*.0001])})),[],frame);
    const t=performance.now();let capacityError='';
    try{await classifySceneGpu3(overlap,gpu,{maxCandidates:10000,pairCapacity:1024});}catch(error){capacityError=String(error);}
    if(!capacityError.includes('candidate pairs'))throw new Error('pathological overlap did not report capacity');
    report.overlap={triangles:overlap.triangles.length,features:overlap.features.length,maxCandidates:10000,wallMs:performance.now()-t,error:capacityError};
    report.cases=cases;report.peakExplicitBufferBytes=peakBytes;report.passed=true;
    postMessage({type:'result',report});
  }catch(error){postMessage({type:'error',message:String(error),stack:error instanceof Error?error.stack:undefined});}
  finally{viewport?.dispose();await gpu?.dispose();close();}
};
