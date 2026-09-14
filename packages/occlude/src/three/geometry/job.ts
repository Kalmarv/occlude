import {PhaseClock3,type PhaseTimings3} from '../timing.js';
export interface GeometryJobResult3<T>{readonly value:T;readonly yields:number;readonly timings:PhaseTimings3}
/** Small synchronous geometry path; expensive public work uses the task-yielding
 * runner below so worker messages can cancel it before adoption. */
export function runGeometryJob3<T>(job:Generator<void,T>,signal?:AbortSignal):GeometryJobResult3<T>{
 const timing=new PhaseClock3();let finished=false;
 try{
  const value=timing.measure('cpuMs',()=>{let next;do{signal?.throwIfAborted();next=job.next();}while(!next.done);finished=true;return next.value;});
  return {value,yields:0,timings:timing.finish()};
 }finally{if(!finished)job.return(undefined as T);}
}
/** A real task boundary, not a microtask-only Promise.resolve loop. Each slice
 * is at most 1024 generator checkpoints or about 8ms of measured JS work;
 * individual bounded sort/primitive operations are not preemptible. */
export async function runGeometryJobAsync3<T>(job:Generator<void,T>,signal?:AbortSignal):Promise<GeometryJobResult3<T>>{
 const timing=new PhaseClock3();let yields=0,finished=false;
 try{
  while(true){
   signal?.throwIfAborted();await timing.wait('queueMs',()=>new Promise<void>(resolve=>setTimeout(resolve,0)));yields++;
   const start=performance.now();
   for(let steps=0;steps<1024&&performance.now()-start<8;steps++){
    signal?.throwIfAborted();const next=timing.measure('cpuMs',()=>job.next());
    if(next.done){signal?.throwIfAborted();finished=true;return {value:next.value,yields,timings:timing.finish()};}
   }
  }
 }finally{if(!finished)job.return(undefined as T);}
}
