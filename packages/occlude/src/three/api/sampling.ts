import {surfaceLocation3,rebindSurfaceLocation3,type SurfaceLocation3} from '../geometry/location.js';
import {sameAttachmentTopology3} from '../geometry/topology.js';
import type {RotationInput,Axis3} from '../rotation.js';
import {Mesh,PointGeometry,evaluate,captureAttributeFields,pointSteps,type PointSnapshot,type PointRule,type StepsOptions,type StepAttributes,type AttributeFields,type EdgeAttributes,type FaceRow,type Field,type PointRow,type GeometryOptions,type StepShorthand} from './mesh.js';
import type {DisplaceOptions,RotateOptions,ScaleOptions} from './mesh.js';
import {Collection} from './collection.js';
import {surface3,assembleSurface3,type Attributes3,type Surface3,type SurfacePoint3,type Attribute3} from '../geometry/surface.js';
import {sub3,mul3,cross3,type Vec3} from '../math.js';
type Combined<A,B>=Omit<A,keyof B>&B;
export interface SurfaceSample<F extends Attributes3,C extends Attributes3={},Q extends Attributes3={}> extends Omit<SurfaceLocation3,'face'|'faceAttributes'|'pointAttributes'|'cornerAttributes'> {
  readonly face:FaceRow<F>;
  readonly faceAttributes:Readonly<F>;readonly pointAttributes:Readonly<Q>;readonly cornerAttributes:Readonly<C>;
}
export type SurfaceSampleRow<P extends Attributes3,F extends Attributes3,C extends Attributes3={},Q extends Attributes3={}>=PointRow<P>&{readonly sample:SurfaceSample<F,C,Q>};
const sampleLocations=new WeakMap<SurfaceSample<any,any,any>,SurfaceLocation3>();
function captureSample<F extends Attributes3,C extends Attributes3,Q extends Attributes3>(location:SurfaceLocation3,face:FaceRow<F>):SurfaceSample<F,C,Q> {
  const sample=Object.freeze({...location,face}) as unknown as SurfaceSample<F,C,Q>;
  sampleLocations.set(sample,location);return sample;
}
export interface SamplingGeneration {readonly attempts:number;readonly accepted:number;readonly reason:'count'|'attempt-limit'|'point-limit'|'empty'}
interface SampleState<P extends Attributes3,F extends Attributes3,C extends Attributes3,Q extends Attributes3> {
  readonly target:Mesh<Q,any,F,C>;readonly samples:ReadonlyMap<string,SurfaceSample<F,C,Q>>;readonly generation:SamplingGeneration;
  readonly rows:readonly SurfaceSampleRow<P,F,C,Q>[];
}
const states=new WeakMap<object,SampleState<any,any,any,any>>();
/** Ordinary point geometry plus captured surface interpretation. Moving a point
 * preserves its original sample reference, rather than silently reprojecting. */
export class SurfaceSamples<P extends Attributes3={},F extends Attributes3={},C extends Attributes3={},Q extends Attributes3={}> extends PointGeometry<P> {
  constructor(geometry:PointGeometry<P>,target:Mesh<Q,any,F,C>,samples:ReadonlyMap<string,SurfaceSample<F,C,Q>>,generation:SamplingGeneration){
    super(geometry.surface,geometry);
    const owned=new Map<string,SurfaceSample<F,C,Q>>(),rows=Object.freeze(geometry.points.map(p=>{const sample=samples.get(p.id);if(!sample)throw new Error('surface sample provenance is missing');owned.set(p.id,sample);return Object.freeze({...p,sample});}));
    states.set(this,{target,samples:owned,generation:Object.freeze({...generation}),rows});
  }
  private get state():SampleState<P,F,C,Q>{return states.get(this)!;}
  get target():Mesh<Q,any,F,C>{return this.state.target;}
  /** Statistics of the original generation, also retained after selection/edit. */
  get generation():SamplingGeneration{return this.state.generation;}
  get points():Collection<SurfaceSampleRow<P,F,C,Q>,SurfaceSamples<P,F,C,Q>>{
    return new Collection(this.surface,'point',this.state.rows,indices=>{
      const selected=new Set(indices),geometry=super.points.filter(p=>selected.has(p.index)).extract();
      return this.changed(geometry);
    });
  }
  private changed<A extends Attributes3>(geometry:PointGeometry<A>):SurfaceSamples<A,F,C,Q>{return new SurfaceSamples(geometry,this.target,this.state.samples,this.generation);}
  attribute<Name extends string,Value extends Attribute3>(name:Name,field:Field<SurfaceSampleRow<P,F,C,Q>,Value>):SurfaceSamples<Omit<P,Name>&Record<Name,Value>,F,C,Q>{return this.changed(super.attribute(name,p=>evaluate(field,this.state.rows[p.index])));}
  attributes<A extends Attributes3>(fields:AttributeFields<SurfaceSampleRow<P,F,C,Q>,A>):SurfaceSamples<Omit<P,keyof A>&A,F,C,Q>{
    const values=captureAttributeFields(this.state.rows,fields);
    const surface=assembleSurface3(this.surface.points.map((p,i)=>({...p,attributes:{...p.attributes,...values[i]}})),[],[]);
    return this.changed(new PointGeometry<Omit<P,keyof A>&A>(surface,{key:this.key,iteration:this.iteration,history:[]}));
  }
  displace(field:Field<SurfaceSampleRow<P,F,C,Q>,Vec3|number>,options:DisplaceOptions={}):SurfaceSamples<P,F,C,Q>{return this.changed(super.displace(p=>evaluate(field,this.state.rows[p.index]),options));}
  translate(offset:Vec3):SurfaceSamples<P,F,C,Q>{return this.changed(super.translate(offset));}
  rotate(angles:RotationInput,pivot?:Vec3|RotateOptions):SurfaceSamples<P,F,C,Q>;
  rotate(axis:Axis3,degrees:number,options?:RotateOptions):SurfaceSamples<P,F,C,Q>;
  rotate(a:RotationInput|Axis3,b?:number|Vec3|RotateOptions,c?:RotateOptions):SurfaceSamples<P,F,C,Q>{return this.changed((super.rotate as (...args:unknown[])=>PointGeometry<P>)(a,b,c));}
  scale(scale:number|Vec3,pivot?:Vec3|ScaleOptions):SurfaceSamples<P,F,C,Q>{return this.changed(super.scale(scale,pivot));}
  get history():readonly PointSnapshot<P,SurfaceSamples<P,F,C,Q>>[]{return super.history as readonly PointSnapshot<P,SurfaceSamples<P,F,C,Q>>[];}
  steps(count:number,rule:PointRule<StepAttributes<P>,SurfaceSampleRow<StepAttributes<P>,F,C,Q>,SurfaceSamples<StepAttributes<P>,F,C,Q>>|StepShorthand<SurfaceSampleRow<StepAttributes<P>,F,C,Q>,StepAttributes<P>>,...passesAndOptions:(PointRule<StepAttributes<P>,SurfaceSampleRow<StepAttributes<P>,F,C,Q>,SurfaceSamples<StepAttributes<P>,F,C,Q>>|StepsOptions)[]):SurfaceSamples<StepAttributes<P>,F,C,Q>{
    return pointSteps(this,count,rule,passesAndOptions,(surface,iteration,history)=>this.changed(new PointGeometry<StepAttributes<P>>(surface,{key:this.key,iteration,history})));
  }
  /** Put points back on their retained source attachments on a new revision.
   * Point columns remain captured state; sample domain fields refresh. */
  rebind<Q2 extends Attributes3,E2 extends EdgeAttributes,F2 extends Attributes3,C2 extends Attributes3>(target:Mesh<Q2,E2,F2,C2>,options:SurfaceCoordinateOptions={}):SurfaceSamples<P,F2,C2,Q2>{
    if(!(target instanceof Mesh))throw new Error('surface rebind requires a mesh');
    if(!sameAttachmentTopology3(this.target.surface,target.surface))throw new Error('surface topology or authoring lineage changed; regenerate samples');
    const faces=target.faces.map(f=>f),samples=new Map<string,SurfaceSample<F2,C2,Q2>>();
    const points=this.surface.points.map(point=>{
      const sample=this.state.samples.get(point.id)!,location=sampleLocations.get(sample);
      if(!location)throw new Error('surface sample has no owned attachment');
      const rebound=rebindSurfaceLocation3(location,target.surface,{pointTransfers:target.transfers,cornerTransfers:target.cornerTransfers,...options});
      samples.set(point.id,captureSample<F2,C2,Q2>(rebound,faces[rebound.face]));
      return {...point,position:rebound.position,provenance:{operation:'rebind',parents:[point.id,rebound.faceId,...rebound.vertexIds]}};
    });
    return new SurfaceSamples<P,F2,C2,Q2>(new PointGeometry<P>(assembleSurface3(points,[],[]),{key:this.key}),target,samples,this.generation);
  }
  withKey(key:string):SurfaceSamples<P,F,C,Q>{return this.changed(super.withKey(key));}
}
export interface SurfaceCoordinateOptions {
  readonly uvAttribute?:string;
  readonly chartAttribute?:string;
}
export interface SurfaceSamplingOptions<F extends Attributes3={}> extends GeometryOptions,SurfaceCoordinateOptions {
  readonly count:number;readonly maxPoints?:number;
  /** Nonnegative per-face candidate weight, captured once; zero excludes a face. */
  readonly weight?:Field<FaceRow<F>,number>;
}
export interface SurfaceScatterOptions<F extends Attributes3={}> extends GeometryOptions,SurfaceCoordinateOptions {
  /** Minimum Euclidean separation in world units, not paper or geodesic units. */
  readonly spacing:number;readonly maxPoints?:number;readonly maxAttempts?:number;
  readonly weight?:Field<FaceRow<F>,number>;
}
export interface SurfaceSamplingEnv {readonly rnd:()=>number;readonly signal?:AbortSignal}
interface Prepared<F extends Attributes3>{readonly faces:readonly FaceRow<F>[];readonly triangles:readonly number[];readonly cumulative:readonly number[];readonly total:number;readonly extent:number;readonly origin:Vec3}
function nonnegativeInteger(value:number,name:string):void{if(!(value===Infinity||Number.isSafeInteger(value))||value<0)throw new Error(`${name} must be a nonnegative integer or Infinity`);}
function optionsObject(value:unknown):void{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('surface sampling options must be an object');}
function prepare<P extends Attributes3,E extends EdgeAttributes,F extends Attributes3,C extends Attributes3>(target:Mesh<P,E,F,C>,weight:Field<FaceRow<F>,number>|undefined):Prepared<F>{
  if(!(target instanceof Mesh))throw new Error('surface sampling requires a mesh');
  const source=target.surface,origin=source.points[0]?.position??[0,0,0];
  const extent=source.points.reduce((m,p)=>Math.max(m,...sub3(p.position,origin).map(Math.abs)),0);
  if(!Number.isFinite(extent))throw new Error('surface sampling extent is not representable');
  const faces=target.faces.map(f=>f),weights=faces.map(f=>evaluate(weight??1,f));
  if(weights.some(w=>!Number.isFinite(w)||w<0))throw new Error('surface sampling face weights must be nonnegative and finite');
  const maxWeight=weights.reduce((a,b)=>Math.max(a,b),0),triangles:number[]=[],cumulative:number[]=[];let total=0;
  if(extent&&maxWeight)source.triangles.forEach((t,i)=>{
    if(!weights[t.face])return;
    const [a,b,c]=t.vertices.map(v=>source.points[v].position);
    const area=Math.hypot(...cross3(mul3(sub3(b,a),1/extent),mul3(sub3(c,a),1/extent)))/2;
    const mass=area*(weights[t.face]/maxWeight);if(!(mass>0))return;
    total+=mass;triangles.push(i);cumulative.push(total);
  });
  return {faces,triangles,cumulative,total,extent,origin};
}
function random(env:SurfaceSamplingEnv):number{const r=env.rnd();if(!Number.isFinite(r)||r<0||r>=1)throw new Error('surface sampling random source must return values in [0,1)');return r;}
function draw<P extends Attributes3,E extends EdgeAttributes,F extends Attributes3,C extends Attributes3>(target:Mesh<P,E,F,C>,prepared:Prepared<F>,env:SurfaceSamplingEnv,index:number,coordinates:SurfaceCoordinateOptions){
  const q=random(env)*prepared.total;let lo=0,hi=prepared.cumulative.length-1;
  while(lo<hi){const mid=(lo+hi)>>>1;if(q<prepared.cumulative[mid])hi=mid;else lo=mid+1;}
  const triangle=prepared.triangles[lo],t=target.surface.triangles[triangle],points=t.vertices.map(v=>target.surface.points[v]);
  const root=Math.sqrt(random(env)),v=random(env),barycentric=Object.freeze([1-root,root*(1-v),root*v]) as Vec3;
  const face=prepared.faces[t.face],location=surfaceLocation3(target.surface,triangle,barycentric,{pointTransfers:target.transfers,cornerTransfers:target.cornerTransfers,uvAttribute:coordinates.uvAttribute,chartAttribute:coordinates.chartAttribute});
  const sample=captureSample<F,C,P>(location,face);
  const point:SurfacePoint3={id:JSON.stringify(['sample',index]),position:location.position,attributes:{...target.surface.faces[t.face].attributes,...location.pointAttributes},provenance:{operation:'sample',parents:[face.id,...points.map(p=>p.id)]}};
  return {point,sample};
}
function result<P extends Attributes3,E extends EdgeAttributes,F extends Attributes3,C extends Attributes3>(target:Mesh<P,E,F,C>,points:readonly SurfacePoint3[],samples:ReadonlyMap<string,SurfaceSample<F,C,P>>,generation:SamplingGeneration,options:GeometryOptions):SurfaceSamples<Combined<F,P>,F,C,P>{
  const surface:Surface3={...surface3([],[]),points};
  return new SurfaceSamples(new PointGeometry<Combined<F,P>>(surface,{key:options.key}),target,samples,generation);
}
/** Advanced explicit random-source entry; normal sketches call t.sample(mesh). */
export function sampleSurfacePoints<P extends Attributes3,E extends EdgeAttributes,F extends Attributes3,C extends Attributes3>(target:Mesh<P,E,F,C>,options:SurfaceSamplingOptions<F>,env:SurfaceSamplingEnv):SurfaceSamples<Combined<F,P>,F,C,P>{
  optionsObject(options);env.signal?.throwIfAborted();if(!(target instanceof Mesh))throw new Error('surface sampling requires a mesh');
  const count=options.count,limit=options.maxPoints??Infinity;nonnegativeInteger(count,'surface sample count');nonnegativeInteger(limit,'surface sample point budget');
  if(count>limit)throw new Error('surface sampling exceeds point budget');
  const points:SurfacePoint3[]=[],samples=new Map<string,SurfaceSample<F,C,P>>();
  if(count){const prepared=prepare(target,options.weight);if(!prepared.total)throw new Error('surface sampling requires positive weighted surface area');
    for(let i=0;i<count;i++){env.signal?.throwIfAborted();const next=draw(target,prepared,env,i,options);points.push(next.point);samples.set(next.point.id,next.sample);}
  }
  return result(target,points,samples,{attempts:count,accepted:count,reason:'count'},options);
}
/** Global dart rejection with a bounded sparse world-space neighbor grid. */
export function scatterSurfacePoints<P extends Attributes3,E extends EdgeAttributes,F extends Attributes3,C extends Attributes3>(target:Mesh<P,E,F,C>,options:SurfaceScatterOptions<F>,env:SurfaceSamplingEnv):SurfaceSamples<Combined<F,P>,F,C,P>{
  optionsObject(options);env.signal?.throwIfAborted();if(!(target instanceof Mesh))throw new Error('surface scatter requires a mesh');
  const spacing=options.spacing,limit=options.maxPoints??Infinity,budget=options.maxAttempts??100_000;
  if(!Number.isFinite(spacing)||spacing<=0)throw new Error('surface scatter spacing must be positive finite world units');
  nonnegativeInteger(limit,'surface scatter point limit');nonnegativeInteger(budget,'surface scatter attempt limit');
  const points:SurfacePoint3[]=[],samples=new Map<string,SurfaceSample<F,C,P>>(),buckets=new Map<string,number[]>();let attempts=0,reason:SamplingGeneration['reason']='point-limit';
  if(limit&&budget){
    const prepared=prepare(target,options.weight);
    if(prepared.extent/spacing>2**48)throw new Error('surface scatter spacing is too small relative to the mesh extent for its neighbor grid');
    reason=prepared.total?'attempt-limit':'empty';
    if(prepared.total)for(;attempts<budget&&points.length<limit;attempts++){
      env.signal?.throwIfAborted();const next=draw(target,prepared,env,attempts,options),p=next.point.position;
      const cell=sub3(p,prepared.origin).map(v=>Math.floor(v/spacing));let fits=true;
      for(let x=-2;x<=2&&fits;x++)for(let y=-2;y<=2&&fits;y++)for(let z=-2;z<=2&&fits;z++)for(const i of buckets.get(`${cell[0]+x},${cell[1]+y},${cell[2]+z}`)??[]){if(Math.hypot(...sub3(p,points[i].position))<spacing){fits=false;break;}}
      if(!fits)continue;
      const key=cell.join(','),bucket=buckets.get(key)??[];bucket.push(points.length);buckets.set(key,bucket);points.push(next.point);samples.set(next.point.id,next.sample);
    }
    if(points.length===limit)reason='point-limit';
  }else if(!budget&&limit)reason='attempt-limit';
  return result(target,points,samples,{attempts,accepted:points.length,reason},options);
}
