import {Mesh,type GeometryOptions} from './mesh.js';
import {Instances,instanceSurfaceBinding3} from './instances.js';
import {SurfaceCurves,type SurfaceCurveOptions} from './supported.js';
import {identity} from './identity.js';
import type {SurfaceLocation3} from '../geometry/location.js';
import type {Attributes3} from '../geometry/surface.js';
import {integerWeights,weightedPoint} from '../geometry/exact.js';
import {runGeometryJob3} from '../geometry/job.js';
import {surfaceBinding3,bindingTriangle3,surfaceCurveNetworkJob3,type SurfaceBinding3,type SurfaceCurveBudget3,type SurfaceCurveNetworkInput3} from '../curves/network.js';
import {traceEnvironment3,traceBoth3,traceSurface3,traceLocation3,type Trace3,type TraceEnvironment3,type TraceNode3,type TraceOptions3,type TraceStop3} from '../surface/trace.js';
import {directionField,toneField,type DirectionInput,type ToneInput,type DirectionField,type ToneField} from '../surface/fields.js';
import {toneRecipe3,decideTone3,type ToneRecipe3} from '../surface/tone.js';
import {evaluateSurfaceCpu3,type SurfaceEvaluationResult3,type SurfaceEvaluationStats3} from '../surface/evaluate.js';
import type {SceneCompute3} from '../scene.js';
import {add3,sub3,mul3,dot3,cross3,type Vec3} from '../math.js';

/** One direction family of a hatch. Several families over the same surface
 * are crosshatch; each keeps its identity and may name its own pen. */
export interface HatchFamily {
  readonly id?:string;
  readonly direction:DirectionInput;
  /** 0 light (no lines) to 1 dark (every lane). Constant or surface field. */
  readonly tone?:ToneInput;
  /** Named pen for `view`'s default drawing; attribute `stroke` on the lines. */
  readonly stroke?:string;
  /** Surface spacing between neighbouring lanes, model/world units. */
  readonly spacing?:number;
}
export interface HatchOptions extends GeometryOptions {
  readonly direction?:DirectionInput;
  readonly spacing?:number;
  readonly tone?:ToneInput;
  readonly stroke?:string;
  /** Straight advance between direction reads; default spacing / 2. */
  readonly step?:number;
  /** Per-trace limits in each direction from a seed; default 200 spacings, unlimited steps. */
  readonly maxLength?:number;readonly maxSteps?:number;
  /** Random restart seeds per surface after side seeding runs dry; default 16. */
  readonly seeds?:number;
  readonly maxTraces?:number;readonly maxSegments?:number;readonly maxTotalSteps?:number;
  /** Fold angle that stops a trace; default 60, 180 never stops. */
  readonly creaseDegrees?:number;
  /** Direction where the field reports none (an umbilic, a flat region):
   * default chart u, then world +X projected onto the surface. */
  readonly fallback?:DirectionInput;
  readonly uv?:string;readonly chartAttribute?:string;
  readonly budget?:SurfaceCurveBudget3;
}
export type HatchInput=Mesh<any,any,any,any>|Instances<any,any,any,any,any,any,any>;
export type HatchAttributes={family:string;lane:number;threshold:number;seed:number}&Partial<{stroke:string}>;
export interface HatchStats {
  readonly families:number;readonly surfaces:number;
  readonly traces:number;readonly accepted:number;readonly segments:number;readonly steps:number;
  readonly seedsQueued:number;readonly randomSeeds:number;readonly occupancyRejections:number;
  readonly stops:Readonly<Partial<Record<TraceStop3,number>>>;
  readonly tone:{readonly locations:number;readonly backend:'cpu'|'gpu'|'constant'|'mixed';readonly dispatches:number;readonly transferBytes:number;readonly refinements:number;readonly ambiguous:number};
}
/** Chart u where a chart exists, else world +X (the tracer projects it). */
const defaultFallback:DirectionField=s=>s.tangentU??[1,0,0];
interface Family {readonly id:string;readonly direction:DirectionField;readonly tone:ToneField;readonly constantTone?:number;readonly recipe?:ToneRecipe3;readonly stroke?:string;readonly spacing:number}
interface Settings {
  readonly families:readonly Family[];readonly step?:number;readonly maxLength?:number;readonly maxSteps:number;readonly seeds:number;
  readonly maxTraces:number;readonly maxSegments:number;readonly maxTotalSteps:number;readonly creaseDegrees:number;readonly fallback?:DirectionField;
  readonly uv?:string;readonly chartAttribute?:string;readonly budget:SurfaceCurveBudget3;readonly key?:string;
}
function positive(value:number|undefined,fallback:number,name:string):number {
  const n=value??fallback;if(!Number.isFinite(n)||n<=0)throw new Error(`hatch ${name} must be positive and finite`);return n;
}
function count(value:number|undefined,fallback:number,name:string):number {
  const n=value??fallback;if(!(n===Infinity||Number.isSafeInteger(n))||n<0)throw new Error(`hatch ${name} must be a nonnegative integer or Infinity`);return n;
}
/** Validate and capture everything before an asynchronous boundary. Field
 * callbacks are retained by reference; scalar options are copied. */
export function captureHatch(input:HatchInput,options:HatchOptions) {
  if(!options||typeof options!=='object'||Array.isArray(options))throw new Error('hatch requires an options object');
  if(!(input instanceof Mesh)&&!(input instanceof Instances))throw new Error('hatch requires a mesh or mesh instances');
  const rows:readonly HatchFamily[]=[{id:'hatch',direction:options.direction as DirectionInput,tone:options.tone,stroke:options.stroke,spacing:options.spacing}];
  if(options.direction===undefined)throw new Error('families' in (options as object)?'hatch traces one family per call: give a direction, and call hatch again for a crosshatch family':'hatch requires a direction');
  const families=rows.map((row,i):Family=>{
    if(!row||typeof row!=='object')throw new Error('hatch family must be an object');
    const id=row.id??(rows.length===1?'hatch':`hatch:${i}`);if(typeof id!=='string'||!id)throw new Error('hatch family id must be a nonempty string');
    const direction=row.direction??options.direction;if(direction===undefined)throw new Error(`hatch family ${id} requires a direction`);
    const toneInput=row.tone??options.tone??1,tone=toneField(toneInput);
    const stroke=row.stroke??options.stroke;if(stroke!==undefined&&(typeof stroke!=='string'||!stroke))throw new Error('hatch stroke must be a pen name');
    return {id,direction:directionField(direction),tone,constantTone:typeof toneInput==='number'?toneInput:undefined,recipe:toneRecipe3(toneInput),stroke,spacing:positive(row.spacing??options.spacing,NaN,'spacing')};
  });
  if(new Set(families.map(f=>f.id)).size!==families.length)throw new Error('hatch family ids must be unique');
  const settings:Settings={
    families,step:options.step===undefined?undefined:positive(options.step,NaN,'step'),maxLength:options.maxLength===undefined?undefined:positive(options.maxLength,NaN,'maxLength'),
    maxSteps:count(options.maxSteps,Infinity,'maxSteps'),seeds:count(options.seeds,16,'seeds'),maxTraces:count(options.maxTraces,Infinity,'maxTraces'),maxSegments:count(options.maxSegments,Infinity,'maxSegments'),maxTotalSteps:count(options.maxTotalSteps,Infinity,'maxTotalSteps'),
    creaseDegrees:options.creaseDegrees??60,fallback:directionField(options.fallback??defaultFallback),uv:options.uv,chartAttribute:options.chartAttribute,budget:structuredClone(options.budget??{}),key:options.key,
  };
  if(!Number.isFinite(settings.creaseDegrees)||settings.creaseDegrees<0||settings.creaseDegrees>180)throw new Error('hatch creaseDegrees must lie in [0,180]');
  for(const name of [settings.uv,settings.chartAttribute])if(name!==undefined&&(typeof name!=='string'||!name))throw new Error('hatch coordinate columns must be nonempty strings');
  const bindings:{id:string;binding:SurfaceBinding3}[]=input instanceof Mesh?[{id:input.key??'mesh',binding:surfaceBinding3(input.surface)}]:input.rows.map(row=>({id:row.id,binding:instanceSurfaceBinding3(input,row)}));
  return {bindings,settings};
}
/** Lane thresholds nest: lane 0 draws wherever tone is positive, odd lanes
 * need tone above 1/2, lanes divisible by 2 but not 4 need 1/4, and so on.
 * Halving the tone removes every other remaining lane, so density changes
 * in even octaves without regenerating the pattern. */
export function laneThreshold(lane:number):number {
  if(!Number.isSafeInteger(lane))throw new Error('hatch lane must be an integer');
  if(lane===0)return 0;let n=Math.abs(lane),zeros=0;while((n&1)===0){n>>=1;zeros++;}return 2**-(zeros+1);
}
interface Seed {readonly triangle:number;readonly weights:Vec3;readonly lane:number;readonly random:boolean}
export interface HatchTrace {readonly lane:number;readonly seed:number;readonly trace:Trace3}
export interface HatchTraced {
  readonly settings:Settings;readonly bindings:readonly {id:string;binding:SurfaceBinding3}[];
  readonly families:readonly {readonly family:Family;readonly surfaces:readonly {readonly binding:number;readonly env:TraceEnvironment3;readonly traces:readonly HatchTrace[]}[]}[];
  readonly stats:{traces:number;accepted:number;steps:number;seedsQueued:number;randomSeeds:number;occupancyRejections:number;stops:Partial<Record<TraceStop3,number>>};
}
/** Surface-aware occupancy: a candidate is blocked by an accepted sample of the
 * same connected component within `radius`, whose normal agrees within 60°
 * and whose position lies within the candidate's tangent slab. Disconnected
 * sheets and the far side of a thin fold never suppress each other. This is
 * Euclidean distance with topology and orientation guards, not geodesic
 * distance. */
class Occupancy {
  private readonly cells=new Map<number,{p:Vec3;n:Vec3;component:number}[]>();
  constructor(private readonly cell:number,private readonly components:readonly number[]){}
  /** Hashed cell key; a collision only adds candidates that the exact
   * distance test below rejects, never a false block. */
  private static hash(x:number,y:number,z:number):number{return (Math.imul(x,73856093)^Math.imul(y,19349663)^Math.imul(z,83492791))>>>0;}
  add(node:TraceNode3):void{const p=node.position,k=Occupancy.hash(Math.floor(p[0]/this.cell),Math.floor(p[1]/this.cell),Math.floor(p[2]/this.cell)),list=this.cells.get(k)??[];list.push({p,n:node.normal,component:this.components[node.triangle]});this.cells.set(k,list);}
  blocked(p:Vec3,n:Vec3,triangle:number,radius:number):boolean {
    const component=this.components[triangle],x=Math.floor(p[0]/this.cell),y=Math.floor(p[1]/this.cell),z=Math.floor(p[2]/this.cell),r2=radius*radius;
    const px=p[0],py=p[1],pz=p[2],nx=n[0],ny=n[1],nz=n[2];
    for(let i=-1;i<=1;i++)for(let j=-1;j<=1;j++)for(let k=-1;k<=1;k++){
      const list=this.cells.get(Occupancy.hash(x+i,y+j,z+k));if(!list)continue;
      for(let m=0;m<list.length;m++){
        const s=list[m];if(s.component!==component)continue;
        const dx=px-s.p[0],dy=py-s.p[1],dz=pz-s.p[2];
        if(dx*dx+dy*dy+dz*dz>=r2)continue;
        if(nx*s.n[0]+ny*s.n[1]+nz*s.n[2]<=0.5)continue;
        const slab=dx*nx+dy*ny+dz*nz;if(slab>=radius||slab<=-radius)continue;
        return true;
      }
    }
    return false;
  }
}
const unit=(v:Vec3):Vec3|null=>{const l=Math.hypot(...v);return l>0&&Number.isFinite(l)?mul3(v,1/l):null;};
function areaTable(env:TraceEnvironment3):{cumulative:Float64Array;total:number} {
  const cumulative=new Float64Array(env.surface.triangles.length);let total=0;
  env.surface.triangles.forEach((t,i)=>{const [a,b,c]=t.vertices.map(v=>env.world[v]);total+=Math.hypot(...cross3(sub3(b,a),sub3(c,a)))/2;cumulative[i]=total;});
  return {cumulative,total};
}
function randomSeed(env:TraceEnvironment3,table:{cumulative:Float64Array;total:number},rnd:()=>number,lane:number):Seed|null {
  if(!(table.total>0))return null;
  const q=rnd()*table.total;let lo=0,hi=table.cumulative.length-1;
  while(lo<hi){const mid=(lo+hi)>>>1;if(q<table.cumulative[mid])hi=mid;else lo=mid+1;}
  const root=Math.sqrt(rnd()),v=rnd();
  return {triangle:lo,weights:[1-root,root*(1-v),root*v],lane,random:true};
}
/** Stage one: geometry only. Every family traces its lanes at full spacing;
 * tone selects among them later, so a camera or tone change never reseeds. */
export function* hatchTraceJob(captured:ReturnType<typeof captureHatch>,rnd:()=>number,onProgress?:(event:{operation:'hatch';done:number;total?:number;detail?:string})=>void):Generator<void,HatchTraced> {
  const {settings,bindings}=captured;
  const stats:HatchTraced['stats']={traces:0,accepted:0,steps:0,seedsQueued:0,randomSeeds:0,occupancyRejections:0,stops:{}};
  let totalSteps=0;const budget=()=>totalSteps++<settings.maxTotalSteps;
  const envs=bindings.map(b=>traceEnvironment3(b.binding.source,b.binding));yield;
  const families:HatchTraced['families'][number][]=[];
  for(const family of settings.families){
    const surfaces:HatchTraced['families'][number]['surfaces'][number][]=[];
    const field:DirectionField=settings.fallback?(s,previous)=>family.direction(s,previous)??settings.fallback!(s,previous):family.direction;
    for(let bi=0;bi<envs.length;bi++){
      const env=envs[bi],spacing=family.spacing,step=settings.step??spacing/2,dtest=spacing*0.5;
      const options:TraceOptions3={step,maxLength:settings.maxLength??spacing*200,maxSteps:settings.maxSteps,creaseDegrees:settings.creaseDegrees,loopDistance:Math.min(step,dtest),uvAttribute:settings.uv,chartAttribute:settings.chartAttribute};
      const walk:TraceOptions3={...options,step:spacing/4,maxLength:spacing,maxSteps:Math.max(8,Math.ceil(spacing/(spacing/4))*8),loopDistance:0};
      const occupancy=new Occupancy(spacing,env.topology.components),table=areaTable(env),queue:Seed[]=[];
      const traces:HatchTrace[]=[];let randomUsed=0,seedCounter=0;
      while(traces.length<settings.maxTraces){
        let seed=queue.shift();
        if(!seed){if(randomUsed>=settings.seeds)break;randomUsed++;stats.randomSeeds++;const s=randomSeed(env,table,rnd,0);if(!s)break;seed=s;}
        const start={triangle:seed.triangle,weights:seed.weights},startNode=traceLocation3(env,seed.triangle,seed.weights,options);
        if(occupancy.blocked(startNode.position,startNode.normal,seed.triangle,dtest)){stats.occupancyRejections++;continue;}
        const trace=traceBoth3(env,start,field,options,{occupied:node=>occupancy.blocked(node.position,node.normal,node.triangle,dtest),budget});
        stats.traces++;stats.steps+=trace.steps;stats.stops[trace.stop]=(stats.stops[trace.stop]??0)+1;
        onProgress?.({operation:'hatch',done:stats.accepted,detail:`${family.id} · ${stats.traces} traces`});
        yield;
        if(trace.stop==='budget')break;
        if(trace.nodes.length<2||trace.length<dtest)continue;
        stats.accepted++;traces.push({lane:seed.lane,seed:seedCounter++,trace});
        for(const node of trace.nodes)occupancy.add(node);
        // Side seeds one spacing away on both sides, reached by walking across
        // the actual surface with a transported direction, never by projection.
        let nextAt=0;
        for(let i=0;i<trace.nodes.length;i++){
          const node=trace.nodes[i];if(node.distance<nextAt)continue;nextAt=node.distance+spacing;
          const before=trace.nodes[Math.max(0,i-1)],after=trace.nodes[Math.min(trace.nodes.length-1,i+1)],tangent=unit(sub3(after.position,before.position));
          if(!tangent)continue;
          for(const sign of [1,-1]){
            const side=mul3(cross3(node.normal,tangent),sign);
            const reached=traceSurface3(env,{triangle:node.triangle,weights:node.weights},(_,previous)=>previous??side,walk,{budget,blind:true});
            if(reached.length<spacing*0.9)continue;
            const end=reached.nodes[reached.nodes.length-1];
            if(occupancy.blocked(end.position,end.normal,end.triangle,dtest)){stats.occupancyRejections++;continue;}
            queue.push({triangle:end.triangle,weights:end.weights,lane:seed.lane+sign,random:false});stats.seedsQueued++;
          }
          if((i&63)===63)yield;
        }
      }
      surfaces.push({binding:bi,env,traces});yield;
    }
    families.push({family,surfaces});
  }
  return {settings,bindings,families,stats};
}
export interface HatchTone {readonly values:readonly (Float32Array|undefined)[][];readonly stats:HatchStats['tone']}
interface ToneWork {readonly family:Family;readonly surface:HatchTraced['families'][number]['surfaces'][number];readonly nodes:readonly TraceNode3[];readonly thresholds:Float32Array;readonly target:{surface:HatchTraced['families'][number]['surfaces'][number]['env']['surface'];placement?:HatchTraced['families'][number]['surfaces'][number]['env']['placement'];uvAttribute?:string;chartAttribute?:string}}
function toneWork(traced:HatchTraced):ToneWork[][] {
  return traced.families.map(({family,surfaces})=>surfaces.map(surface=>{
    const nodes=surface.traces.flatMap(t=>t.trace.nodes),thresholds=new Float32Array(nodes.length);let k=0;
    for(const t of surface.traces)for(let i=0;i<t.trace.nodes.length;i++)thresholds[k++]=laneThreshold(t.lane);
    return {family,surface,nodes,thresholds,target:{surface:surface.env.surface,placement:surface.env.placement,uvAttribute:traced.settings.uv,chartAttribute:traced.settings.chartAttribute}};
  }));
}
function cpuTone(work:ToneWork,settings:Settings,i:number):number {
  const node=work.nodes[i],v=work.family.tone(traceLocation3(work.surface.env,node.triangle,node.weights,settings));
  if(!Number.isFinite(v))throw new Error('hatch tone must be finite');return v;
}
function batchOf(work:ToneWork){const n=work.nodes.length,batch={triangle:Uint32Array.from(work.nodes,node=>node.triangle),weights:new Float32Array(n*3)};work.nodes.forEach((node,i)=>batch.weights.set(node.weights,i*3));return batch;}
function settle(work:ToneWork,settings:Settings,tone:Float32Array,stats:{ambiguous:number}):void {
  for(let i=0;i<tone.length;i++)if(decideTone3(tone[i],work.thresholds[i])==='ambiguous'){stats.ambiguous++;tone[i]=cpuTone(work,settings,i);}
}
function finishTone(values:(Float32Array|undefined)[][],stats:{locations:number;dispatches:number;transferBytes:number;refinements:number;ambiguous:number},backends:Set<'cpu'|'gpu'|'constant'>):HatchTone {
  const backend=backends.size===1?[...backends][0]:backends.size?'mixed':'constant';
  return {values,stats:{...stats,backend}};
}
/** Stage two, CPU reference: tone at every traced node. Constant tones need
 * no evaluation; recipes and user callbacks evaluate on the CPU. */
export function evaluateHatchToneCpu(traced:HatchTraced):HatchTone {
  const stats={locations:0,dispatches:0,transferBytes:0,refinements:0,ambiguous:0},backends=new Set<'cpu'|'gpu'|'constant'>();
  const values=toneWork(traced).map(row=>row.map(work=>{
    stats.locations+=work.nodes.length;
    if(work.family.constantTone!==undefined){backends.add('constant');return undefined;}
    backends.add('cpu');
    if(work.family.recipe&&work.nodes.length){const tone=new Float32Array(evaluateSurfaceCpu3(work.target,batchOf(work),work.family.recipe).tone!);settle(work,traced.settings,tone,stats);return tone;}
    const tone=new Float32Array(work.nodes.length);for(let i=0;i<tone.length;i++)tone[i]=cpuTone(work,traced.settings,i);return tone;
  }));
  return finishTone(values,stats,backends);
}
/** Stage two, host path: built-in recipes evaluate as one batch per surface
 * on the host's GPU; anything within the shared quantum of a lane threshold
 * is settled by the CPU reference. User callbacks stay on the CPU. */
export async function evaluateHatchTone(traced:HatchTraced,compute?:SceneCompute3,signal?:AbortSignal):Promise<HatchTone> {
  if(!compute?.evaluateSurface)return evaluateHatchToneCpu(traced);
  const stats={locations:0,dispatches:0,transferBytes:0,refinements:0,ambiguous:0},backends=new Set<'cpu'|'gpu'|'constant'>();
  const values:(Float32Array|undefined)[][]=[];
  for(const row of toneWork(traced)){
    const out:(Float32Array|undefined)[]=[];
    for(const work of row){
      signal?.throwIfAborted();stats.locations+=work.nodes.length;
      if(work.family.constantTone!==undefined){backends.add('constant');out.push(undefined);continue;}
      if(work.family.recipe&&work.nodes.length){
        const result:SurfaceEvaluationResult3=await compute.evaluateSurface(work.target,batchOf(work),work.family.recipe,{signal});signal?.throwIfAborted();
        const s:SurfaceEvaluationStats3=result.stats;stats.dispatches+=s.dispatches;stats.transferBytes+=s.transferBytes;stats.refinements+=s.refinements;backends.add(s.backend);
        const tone=new Float32Array(result.tone!);settle(work,traced.settings,tone,stats);out.push(tone);continue;
      }
      backends.add('cpu');const tone=new Float32Array(work.nodes.length);for(let i=0;i<tone.length;i++)tone[i]=cpuTone(work,traced.settings,i);out.push(tone);
    }
    values.push(out);
  }
  return finishTone(values,stats,backends);
}
/** Stage three: exact graph assembly. A segment is drawn where the tone at
 * both of its ends exceeds its lane's threshold; every drawn piece keeps the
 * full trace as its phase reference. */
export function* hatchAssembleJob(traced:HatchTraced,tone:HatchTone):Generator<void,{curves:SurfaceCurves<HatchAttributes>;stats:HatchStats}> {
  const {settings,bindings}=traced;
  const nodes:SurfaceCurveNetworkInput3['nodes'][number][]=[],segments:SurfaceCurveNetworkInput3['segments'][number][]=[];
  let segmentCount=0;
  for(let fi=0;fi<traced.families.length;fi++){
    const {family,surfaces}=traced.families[fi];
    for(let si=0;si<surfaces.length;si++){
      const surface=surfaces[si],values=tone.values[fi][si],binding=bindings[surface.binding].binding;let offset=0;
      for(const {lane,seed,trace} of surface.traces){
        const threshold=laneThreshold(lane),chain=identity('hatch-chain',settings.key??'default',family.id,bindings[surface.binding].id,seed);
        const accept=(i:number)=>{const value=values?values[offset+i]:family.constantTone!;return value>threshold;};
        const ids:(string|undefined)[]=[];
        const nodeId=(index:number)=>{
          const i=trace.closed&&index===trace.nodes.length-1?0:index;
          if(ids[i])return ids[i]!;
          const node=trace.nodes[i],id=identity('hatch-node',chain,i);
          nodes.push({id,point:weightedPoint(bindingTriangle3(binding,node.triangle),integerWeights(node.weights))});
          ids[i]=id;return id;
        };
        // The tracer's own barycentric weights on the segment's triangle, so
        // the network verifies them instead of recomputing them exactly.
        const weightsOn=(index:number,triangle:number):readonly bigint[]|undefined=>{
          const i=trace.closed&&index===trace.nodes.length-1?0:index,node=trace.nodes[i];
          if(node.triangle===triangle)return integerWeights(node.weights);
          if(node.left?.triangle===triangle)return integerWeights(node.left.weights);
          return undefined;
        };
        const total=trace.length;
        for(let i=0;i+1<trace.nodes.length;i++){
          if(!accept(i)||!accept(i+1))continue;
          const a=trace.nodes[i],b=trace.nodes[i+1];
          if(a.distance===b.distance)continue;
          if(++segmentCount>settings.maxSegments)throw new Error('hatch exceeds segment budget');
          const attributes:Attributes3={family:family.id,lane,threshold,seed,...(family.stroke?{stroke:family.stroke}:{})};
          segments.push({id:identity('hatch-segment',chain,i),kind:'trace',a:nodeId(i),b:nodeId(i+1),chainId:chain,range:[a.distance/total,b.distance/total],supports:[{source:surface.binding,triangle:trace.supports[i],a:weightsOn(i,trace.supports[i]),b:weightsOn(i+1,trace.supports[i])}],attributes});
        }
        offset+=trace.nodes.length;
        yield;
      }
    }
  }
  const network=yield*surfaceCurveNetworkJob3({sources:bindings.map(b=>({id:b.id,binding:b.binding})),nodes,segments},settings.budget);
  const stats:HatchStats={families:traced.families.length,surfaces:bindings.length,traces:traced.stats.traces,accepted:traced.stats.accepted,segments:network.segments.length,steps:traced.stats.steps,seedsQueued:traced.stats.seedsQueued,randomSeeds:traced.stats.randomSeeds,occupancyRejections:traced.stats.occupancyRejections,stops:traced.stats.stops,tone:tone.stats};
  return {curves:new SurfaceCurves<HatchAttributes>(network,{key:settings.key}),stats};
}
/** Synchronous hatch with an explicit random source and CPU tone, for headless
 * tools and tests. Ordinary sketches use `await t.hatch(...)`. */
export function hatchSurface(input:HatchInput,options:HatchOptions,rnd:()=>number):{curves:SurfaceCurves<HatchAttributes>;stats:HatchStats} {
  const traced=runGeometryJob3(hatchTraceJob(captureHatch(input,options),rnd)).value;
  return runGeometryJob3(hatchAssembleJob(traced,evaluateHatchToneCpu(traced))).value;
}

export interface TraceOptions extends SurfaceCurveOptions {
  readonly step:number;readonly maxLength?:number;readonly maxSteps?:number;readonly creaseDegrees?:number;
  readonly uv?:string;readonly chartAttribute?:string;readonly budget?:SurfaceCurveBudget3;
}
type SeedLocation=Pick<SurfaceLocation3,'triangle'|'barycentric'>&Partial<Pick<SurfaceLocation3,'source'>>;
export type TraceSeed={readonly sample:SeedLocation}|SeedLocation;
export type TraceAttributes={trace:number};
/** Pure tracing from explicit seeds: sampled points, scattered points or
 * surface locations. Both directions from each seed; no spacing control, no
 * tone, no randomness. */
export function trace(mesh:Mesh<any,any,any,any>,seeds:Iterable<TraceSeed>,direction:DirectionInput,options:TraceOptions):SurfaceCurves<TraceAttributes> {
  if(!(mesh instanceof Mesh))throw new Error('trace requires a mesh');
  if(!options||typeof options!=='object')throw new Error('trace requires options with a step');
  const step=positive(options.step,NaN,'step'),field=directionField(direction);
  const settings:TraceOptions3={step,maxLength:positive(options.maxLength,step*1000,'maxLength'),maxSteps:count(options.maxSteps,Infinity,'maxSteps'),creaseDegrees:options.creaseDegrees??60,loopDistance:step*0.5,uvAttribute:options.uv,chartAttribute:options.chartAttribute};
  const binding=surfaceBinding3(mesh.surface),env=traceEnvironment3(binding.source,binding);
  const nodes:SurfaceCurveNetworkInput3['nodes'][number][]=[],segments:SurfaceCurveNetworkInput3['segments'][number][]=[];
  let index=0;
  for(const seed of seeds){
    const location='sample' in seed?seed.sample:seed;
    if(!location||!Number.isSafeInteger(location.triangle)||!mesh.surface.triangles[location.triangle]||location.barycentric.length!==3)throw new Error('trace seeds require a surface sample or location on this mesh');
    // A location knows its surface; a seed sampled on another mesh would be
    // read as a triangle index on this one and land somewhere else entirely.
    if(location.source!==undefined&&location.source!==mesh.surface)throw new Error('trace seed belongs to another mesh: sample or locate it on this mesh (rebind a sampling after an edit)');
    const result=traceBoth3(env,{triangle:location.triangle,weights:location.barycentric},field,settings),chain=identity('trace-chain',options.key??mesh.key??'default',index);
    const ids:(string|undefined)[]=[],last=result.nodes.length-1;
    const nodeId=(index:number)=>{
      const i=result.closed&&index===last?0:index;
      if(ids[i])return ids[i]!;
      const node=result.nodes[i],id=identity('trace-node',chain,i);ids[i]=id;
      nodes.push({id,point:weightedPoint(bindingTriangle3(binding,node.triangle),integerWeights(node.weights))});return id;
    };
    const total=result.length;
    for(let i=0;i+1<result.nodes.length;i++){
      const a=result.nodes[i],b=result.nodes[i+1];if(a.distance===b.distance)continue;
      segments.push({id:identity('trace-segment',chain,i),kind:'trace',a:nodeId(i),b:nodeId(i+1),chainId:chain,range:[a.distance/total,b.distance/total],supports:[{source:0,triangle:result.supports[i]}],attributes:{trace:index}});
    }
    index++;
  }
  const network=runGeometryJob3(surfaceCurveNetworkJob3({sources:[{id:'surface',binding}],nodes,segments},options.budget)).value;
  return new SurfaceCurves<TraceAttributes>(network,{key:options.key,stroke:options.stroke});
}
