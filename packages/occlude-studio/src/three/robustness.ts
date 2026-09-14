import { initOcclude, compileSketchAsync, exportSvg, sketchAsync, lineArt3, box3, pen, mm, type Camera3, type ExecutionInputs, type SceneCompute3 } from 'occlude';
import { GpuIntervals3 } from 'occlude/src/compute/webgpu/interval.js';
import { GpuSceneCompute3 } from 'occlude/src/compute/webgpu/scene.js';
import { candidatePairs3 } from 'occlude/src/three/visibility/scene.js';
import { precisionFixtures3 } from '../../../occlude/tools/precision-fixtures3.js';

const check=(value:unknown,message:string)=>{if(!value)throw new Error(message);};
const deferred=()=>{let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};};

const barrier=()=>({...deferred(),entered:deferred()});

/** Real GPU boundary injection lives only in this verification worker. */
export async function robustness3(){
  const restores:(()=>void)[]=[],buffers=new Set<GPUBuffer>();
  // WebIDL methods are replaced temporarily to observe real resource lifetime
  // and request cancellation at actual API boundaries, without host test hooks.
  const patch=(target:object,key:string,wrap:(original:(...args:any[])=>any)=>(...args:any[])=>any)=>{
    const record=target as Record<string,any>,original=record[key];
    record[key]=wrap(original);restores.push(()=>{record[key]=original;});
  };
  patch(GPUDevice.prototype,'createBuffer',original=>function(this:GPUDevice,...args:any[]){const buffer=original.apply(this,args) as GPUBuffer;buffers.add(buffer);return buffer;});
  patch(GPUBuffer.prototype,'destroy',original=>function(this:GPUBuffer,...args:any[]){buffers.delete(this);return original.apply(this,args);});
  let gpu:GpuIntervals3|undefined,host:GpuSceneCompute3|undefined;
  try{
    gpu=await GpuIntervals3.create(navigator.gpu!,{requireHardware:true,memoryBudgetBytes:16384,timestamps:false});
    const adapter={vendor:gpu.adapterInfo.vendor,architecture:gpu.adapterInfo.architecture,isFallbackAdapter:gpu.adapterInfo.isFallbackAdapter};
    const initialBuffers=buffers.size;
    const fixture=precisionFixtures3().find(f=>f.id==='orthographic/scale-1')!;
    const pair=[...candidatePairs3(fixture.snapshot)][0].pair;
    const pairs=Array.from({length:513},()=>pair);
    const control=async()=>{
      const result=await gpu!.classify(pairs,{parameterTolerance:1e-12});
      check(result.intervals.length===513 && result.intervals.every(r=>r?.[0]===.375&&r[1]===.625),'reused GPU lease produced different intervals');
      check(result.refinements===513,'control did not exercise CPU refinement');
      check([...buffers].every(b=>b.mapState==='unmapped'),'mapped buffer survived a completed lease');
      check(buffers.size===initialBuffers,'resident allocation grew between leases');
      return {dispatches:result.dispatches,refinements:result.refinements,residentBytes:result.residentBytes};
    };
    const controlBefore=await control(),boundaries=[];
    for(const boundary of ['upload','dispatch','readback','before-refinement'] as const){
      const controller=new AbortController(),reason=new Error(`cancel at ${boundary}`);
      const restoreAt=restores.length;let hits=0,submitted=0,mapped=0;
      const cancel=()=>{if(hits++===0)controller.abort(reason);};
      patch(GPUQueue.prototype,'writeBuffer',original=>function(this:GPUQueue,...args:any[]){const r=original.apply(this,args);if(boundary==='upload')cancel();return r;});
      patch(GPUQueue.prototype,'submit',original=>function(this:GPUQueue,...args:any[]){const r=original.apply(this,args);submitted++;if(boundary==='dispatch')cancel();return r;});
      patch(GPUBuffer.prototype,'mapAsync',original=>async function(this:GPUBuffer,...args:any[]){await original.apply(this,args);mapped++;if(boundary==='readback')cancel();});
      patch(GPUDevice.prototype,'popErrorScope',original=>async function(this:GPUDevice,...args:any[]){const r=await original.apply(this,args);if(boundary==='before-refinement')cancel();return r;});
      let rejection:unknown;
      try{await gpu.classify(pairs,{signal:controller.signal,parameterTolerance:1e-12});}catch(error){rejection=error;}
      finally{while(restores.length>restoreAt)restores.pop()!();}
      check(hits===1&&rejection===reason,`${boundary}: cancellation did not reject with original reason`);
      check(submitted===(boundary==='upload'?0:1),`${boundary}: unexpected submission count`);
      check(mapped===submitted,`${boundary}: submitted work did not drain its mapping`);
      const reused=await control();boundaries.push({boundary,hits,submitted,mapped,rejected:true,reused});
    }
    const queuedAbort=new AbortController();
    const first=gpu.classify(pairs,{parameterTolerance:1e-12});
    const abandoned=gpu.classify(pairs,{signal:queuedAbort.signal});
    queuedAbort.abort();
    const last=gpu.classify(pairs,{parameterTolerance:1e-12});
    const queued=await Promise.allSettled([first,abandoned,last]);
    check(queued[0].status==='fulfilled'&&queued[1].status==='rejected'&&queued[2].status==='fulfilled','queued abort affected another lease');
    await gpu.dispose();gpu=undefined;
    check(buffers.size===0,'interval disposal leaked explicit buffers');

    await initOcclude();
    host=new GpuSceneCompute3(navigator.gpu,{requireHardware:true,memoryBudgetBytes:16384});
    const cases:Record<string,unknown>[]=[];
    const make=(index:number,gate?:ReturnType<typeof barrier>)=>{
      const camera:Camera3={...(index%2?{kind:'perspective' as const,fovDegrees:48+index}:{kind:'orthographic' as const,span:4+index}),eye:[4+index,6,5],target:[0,0,0],near:.1,far:40};
      const inputs:ExecutionInputs={paper:{w:140+index*17,h:180-index*11},seed:42+index,library:[{...pen({width:mm(.2+index*.03),color:['#18202A','#A84932','#267652','#553388'][index]}),name:'ink'}],assets:new Map([['offset.txt',{kind:'text' as const,text:String(.2+index*.15)}]])};
      const definition=sketchAsync({margin:0},async t=>{
        const height=t.rnd(.4,1.4),offset=Number(t.asset('offset.txt'));
        const scene=lineArt3({id:'shared-name',camera,objects:[{id:'model',surface:box3([1+index*.1,1,height],[offset,0,0])}],lineSets:[{id:'edges',stroke:'ink'}]});
        gate?.entered.release();
        await gate?.promise;
        return scene;
      });
      return {definition,inputs};
    };
    const run=async(index:number,compute3?:SceneCompute3,gate?:ReturnType<typeof barrier>)=>{
      const {definition,inputs}=make(index,gate);
      const execution=await compileSketchAsync(definition,inputs,{compute3});
      const drawing=[...execution.scenes3.values()][0];
      return {svg:exportSvg(execution),seed:execution.seedUsed,paper:execution.paper,pen:execution.pens.get('ink'),asset:execution.inputs.assets?.get('offset.txt'),frame:drawing.frame,features:drawing.features,backend:drawing.stats.dispatches?'gpu':'cpu',paperToleranceMm:drawing.stats.paperToleranceMm};
    };
    const baselines:{index:number;backend:'cpu'|'gpu';result:Awaited<ReturnType<typeof run>>}[]=[];
    for(let index=0;index<4;index++)for(const backend of ['cpu','gpu'] as const)baselines.push({index,backend,result:await run(index,backend==='gpu'?host:undefined)});
    const originalSource=make(0);
    const original=await compileSketchAsync(originalSource.definition,originalSource.inputs,{compute3:host});
    const originalSvg=exportSvg(original);
    const failedReason=new Error('generation failed after GPU work');
    const failed=compileSketchAsync(sketchAsync({},async t=>{
      await t.classify3(lineArt3({camera:{kind:'orthographic',span:4,eye:[4,6,5],target:[0,0,0],near:.1,far:30},objects:[{id:'failed',surface:box3([1,1,1])}],lineSets:[{id:'edges',stroke:'ink'}]}));
      throw failedReason;
    }),originalSource.inputs,{compute3:host}).then(()=>false,error=>error===failedReason);
    const controller=new AbortController(),cancelReason=new Error('cancel execution after GPU completion');
    const cancelSource=make(1);
    const cancelled=compileSketchAsync(cancelSource.definition,cancelSource.inputs,{signal:controller.signal,compute3:{async classify(snapshot,options){
      const result=await host!.classify(snapshot,options);controller.abort(cancelReason);return result;
    }}}).then(()=>false,error=>error===cancelReason);
    const unaffected=run(2,host);
    const failures=await Promise.all([failed,cancelled,unaffected]);
    check(failures[0]&&failures[1],'failed or cancelled execution published a result');
    check(JSON.stringify(failures[2])===JSON.stringify(baselines.find(b=>b.index===2&&b.backend==='gpu')!.result),'failed generation affected another execution');
    check(exportSvg(original)===originalSvg,'abandoned execution corrupted prior export');
    const gates=baselines.map(()=>barrier());
    const pending=baselines.map((entry,i)=>run(entry.index,entry.backend==='gpu'?host:undefined,gates[i]));
    await Promise.all(gates.map(gate=>gate.entered.promise));
    // Release in a deliberately different order; all executions already own
    // their paper, library, assets, seed, camera and generated source geometry.
    for(const i of [7,2,5,0,3,6,1,4])gates[i].release();
    const results=await Promise.all(pending);
    results.forEach((result,i)=>{
      check(JSON.stringify(result)===JSON.stringify(baselines[i].result),`interleaved ${baselines[i].index}/${baselines[i].backend} changed captured output`);
      cases.push({index:baselines[i].index,backend:result.backend,seed:result.seed,paper:result.paper,pen:result.pen,asset:result.asset,camera:result.frame.camera,features:result.features.length,svgBytes:result.svg.length,paperToleranceMm:result.paperToleranceMm,exactStandaloneMatch:true});
    });
    check(new Set(results.map(r=>r.svg)).size>=4,'varied inputs did not produce distinct output');
    await host.dispose();host=undefined;
    check(buffers.size===0,'host disposal leaked explicit buffers');
    return {passed:true,adapter,controlBefore,boundaries,queuedStatuses:queued.map(r=>r.status),interleaved:cases,failedGenerationRejected:failures[0],cancelledExecutionRejected:failures[1],priorExportUnchanged:true,remainingExplicitBuffers:buffers.size,limitation:'Cancellation is cooperative at asynchronous boundaries. Synchronous CPU refinement cannot process a new worker message until it yields; main Studio publication revisions separately reject superseded results. Device loss and worker restart recovery are deferred.'};
  }finally{
    await host?.dispose();await gpu?.dispose();
    while(restores.length)restores.pop()!();
  }
}
