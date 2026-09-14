/** Observable host phases, measured on one monotonic performance clock.
 * Submission timings are CPU call costs, not device transfer durations.
 * Readback wait includes queued GPU work, transfers and promise scheduling.
 * Shader timestamps (gpuMs) use a separate clock and are never added here. */
export const phaseKeys3 = ['captureMs','queueMs','setupMs','packingMs','uploadSubmitMs','dispatchSubmitMs','readbackWaitMs','readbackCopyMs','refinementMs','candidateMs','finalizeMs','validationWaitMs','cpuMs'] as const;
export type Phase3 = typeof phaseKeys3[number];
export type PhaseTimings3 = Readonly<Record<Phase3,number> & {wallMs:number;unattributedMs:number}>;
/** Internal accumulator. Parents merge child phases, never time the same child
 * call as another phase. Unattributed time includes orchestration and cleanup. */
export class PhaseClock3 {
  private readonly started=performance.now();
  private readonly phases=Object.fromEntries(phaseKeys3.map(key=>[key,0])) as Record<Phase3,number>;
  since(phase:Phase3,start:number):void{this.phases[phase]+=performance.now()-start;}
  measure<T>(phase:Phase3,fn:()=>T):T{const start=performance.now();try{return fn();}finally{this.since(phase,start);}}
  async wait<T>(phase:Phase3,fn:()=>Promise<T>):Promise<T>{const start=performance.now();try{return await fn();}finally{this.since(phase,start);}}
  merge(timing:PhaseTimings3|undefined):void{if(timing)for(const key of phaseKeys3)this.phases[key]+=timing[key];}
  finish():PhaseTimings3{const wallMs=performance.now()-this.started;return Object.freeze({...this.phases,wallMs,unattributedMs:wallMs-phaseKeys3.reduce((sum,key)=>sum+this.phases[key],0)});}
}
