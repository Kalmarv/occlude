import {Mesh,PointGeometry,evaluate,captureAttributeFields,pointSteps,type PointSnapshot,type PointRule,type StepsOptions,type StepAttributes,type AttributeFields,type EdgeAttributes,type FaceRow,type Field,type PointRow,type GeometryOptions} from './mesh.js';
import {Collection} from './collection.js';
import {surface3,assembleSurface3,type Attributes3,type Surface3,type SurfacePoint3,type Attribute3} from '../geometry/surface.js';
import {add3,sub3,mul3,cross3,unit3,type Vec3} from '../math.js';
type Combined<A,B>=Omit<A,keyof B>&B;
export interface SurfaceSample<F extends Attributes3> {
  readonly source:Surface3;readonly face:FaceRow<F>;readonly triangle:number;readonly vertices:readonly [number,number,number];
  readonly barycentric:Vec3;readonly position:Vec3;readonly normal:Vec3;
}
export type SurfaceSampleRow<P extends Attributes3,F extends Attributes3>=PointRow<P>&{readonly sample:SurfaceSample<F>};
export interface SamplingGeneration {readonly attempts:number;readonly accepted:number;readonly reason:'count'|'attempt-limit'|'point-limit'|'empty'}
interface SampleState<P extends Attributes3,F extends Attributes3> {
  readonly target:Mesh<any,any,F>;readonly samples:ReadonlyMap<string,SurfaceSample<F>>;readonly generation:SamplingGeneration;
  readonly rows:readonly SurfaceSampleRow<P,F>[];
}
const states=new WeakMap<object,SampleState<any,any>>();
/** Ordinary point geometry plus captured surface interpretation. Moving a point
 * preserves its original sample reference, rather than silently reprojecting. */
export class SurfaceSamples<P extends Attributes3={},F extends Attributes3={}> extends PointGeometry<P> {
  constructor(geometry:PointGeometry<P>,target:Mesh<any,any,F>,samples:ReadonlyMap<string,SurfaceSample<F>>,generation:SamplingGeneration){
    super(geometry.surface,geometry);
    const owned=new Map<string,SurfaceSample<F>>(),rows=Object.freeze(geometry.points.map(p=>{const sample=samples.get(p.id);if(!sample)throw new Error('surface sample provenance is missing');owned.set(p.id,sample);return Object.freeze({...p,sample});}));
    states.set(this,{target,samples:owned,generation:Object.freeze({...generation}),rows});
  }
  private get state():SampleState<P,F>{return states.get(this)!;}
  get target():Mesh<any,any,F>{return this.state.target;}
  /** Statistics of the original generation, also retained after selection/edit. */
  get generation():SamplingGeneration{return this.state.generation;}
  get points():Collection<SurfaceSampleRow<P,F>,SurfaceSamples<P,F>>{
    return new Collection(this.surface,'point',this.state.rows,indices=>{
      const selected=new Set(indices),geometry=super.points.filter(p=>selected.has(p.index)).extract();
      return this.changed(geometry);
    });
  }
  private changed<A extends Attributes3>(geometry:PointGeometry<A>):SurfaceSamples<A,F>{return new SurfaceSamples(geometry,this.target,this.state.samples,this.generation);}
  attribute<Name extends string,Value extends Attribute3>(name:Name,field:Field<SurfaceSampleRow<P,F>,Value>):SurfaceSamples<Omit<P,Name>&Record<Name,Value>,F>{return this.changed(super.attribute(name,p=>evaluate(field,this.state.rows[p.index])));}
  attributes<A extends Attributes3>(fields:AttributeFields<SurfaceSampleRow<P,F>,A>):SurfaceSamples<Omit<P,keyof A>&A,F>{
    const values=captureAttributeFields(this.state.rows,fields);
    const surface=assembleSurface3(this.surface.points.map((p,i)=>({...p,attributes:{...p.attributes,...values[i]}})),[],[]);
    return this.changed(new PointGeometry<Omit<P,keyof A>&A>(surface,{key:this.key,iteration:this.iteration,history:[]}));
  }
  displace(field:Field<SurfaceSampleRow<P,F>,Vec3>):SurfaceSamples<P,F>{return this.changed(super.displace(p=>evaluate(field,this.state.rows[p.index])));}
  translate(offset:Vec3):SurfaceSamples<P,F>{return this.changed(super.translate(offset));}
  rotate(angles:Vec3,origin:Vec3=[0,0,0]):SurfaceSamples<P,F>{return this.changed(super.rotate(angles,origin));}
  scale(scale:number|Vec3,origin:Vec3=[0,0,0]):SurfaceSamples<P,F>{return this.changed(super.scale(scale,origin));}
  get history():readonly PointSnapshot<P,SurfaceSamples<P,F>>[]{return super.history as readonly PointSnapshot<P,SurfaceSamples<P,F>>[];}
  steps(count:number,rule:PointRule<StepAttributes<P>,SurfaceSampleRow<StepAttributes<P>,F>,SurfaceSamples<StepAttributes<P>,F>>,...passesAndOptions:(PointRule<StepAttributes<P>,SurfaceSampleRow<StepAttributes<P>,F>,SurfaceSamples<StepAttributes<P>,F>>|StepsOptions)[]):SurfaceSamples<StepAttributes<P>,F>{
    return pointSteps(this,count,rule,passesAndOptions,(surface,iteration,history)=>this.changed(new PointGeometry<StepAttributes<P>>(surface,{key:this.key,iteration,history})));
  }
  withKey(key:string):SurfaceSamples<P,F>{return this.changed(super.withKey(key));}
}
export interface SurfaceSamplingOptions<F extends Attributes3={}> extends GeometryOptions {
  readonly count:number;readonly maxPoints?:number;
  /** Nonnegative per-face candidate weight, captured once; zero excludes a face. */
  readonly weight?:Field<FaceRow<F>,number>;
}
export interface SurfaceScatterOptions<F extends Attributes3={}> extends GeometryOptions {
  /** Minimum Euclidean separation in world units, not paper or geodesic units. */
  readonly spacing:number;readonly maxPoints?:number;readonly maxAttempts?:number;
  readonly weight?:Field<FaceRow<F>,number>;
}
export interface SurfaceSamplingEnv {readonly rnd:()=>number;readonly signal?:AbortSignal}
interface Prepared<F extends Attributes3>{readonly faces:readonly FaceRow<F>[];readonly triangles:readonly number[];readonly cumulative:readonly number[];readonly total:number;readonly extent:number;readonly origin:Vec3}
function nonnegativeInteger(value:number,name:string):void{if(!Number.isSafeInteger(value)||value<0)throw new Error(`${name} must be a nonnegative integer`);}
function optionsObject(value:unknown):void{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('surface sampling options must be an object');}
function prepare<P extends Attributes3,E extends EdgeAttributes,F extends Attributes3>(target:Mesh<P,E,F>,weight:Field<FaceRow<F>,number>|undefined):Prepared<F>{
  if(!(target instanceof Mesh))throw new Error('surface sampling requires a mesh');
  const source=target.surface,origin=source.points[0]?.position??[0,0,0];
  const extent=source.points.reduce((m,p)=>Math.max(m,...sub3(p.position,origin).map(Math.abs)),0);
  if(!Number.isFinite(extent))throw new Error('surface sampling extent is not representable');
  const faces=target.faces().map(f=>f),weights=faces.map(f=>evaluate(weight??1,f));
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
function weightedAttributes(points:readonly SurfacePoint3[],weights:Vec3,transfers:Mesh<any,any,any>['transfers']):Attributes3 {
  const nearest=points.map((p,i)=>({id:p.id,i,w:weights[i]})).sort((a,b)=>b.w-a.w||(a.id<b.id?-1:a.id>b.id?1:0))[0].i,out:Attributes3={};
  for(const name of Object.keys(points[0].attributes)){
    if(!points.every(p=>Object.hasOwn(p.attributes,name)))continue;
    const values=points.map(p=>p.attributes[name]);
    if(transfers[name]!=='nearest'&&values.every(v=>typeof v==='number'))out[name]=(values as number[]).reduce((sum,v,i)=>sum+v*weights[i],0);
    else if(transfers[name]!=='nearest'&&values.every(v=>Array.isArray(v)&&v.length===(values[0] as number[]).length))out[name]=(values[0] as number[]).map((_,k)=>values.reduce<number>((sum,v,i)=>sum+(v as number[])[k]*weights[i],0));
    else out[name]=values[nearest];
  }
  return out;
}
function draw<P extends Attributes3,E extends EdgeAttributes,F extends Attributes3>(target:Mesh<P,E,F>,prepared:Prepared<F>,env:SurfaceSamplingEnv,index:number){
  const q=random(env)*prepared.total;let lo=0,hi=prepared.cumulative.length-1;
  while(lo<hi){const mid=(lo+hi)>>>1;if(q<prepared.cumulative[mid])hi=mid;else lo=mid+1;}
  const triangle=prepared.triangles[lo],t=target.surface.triangles[triangle],points=t.vertices.map(v=>target.surface.points[v]);
  const root=Math.sqrt(random(env)),v=random(env),barycentric=Object.freeze([1-root,root*(1-v),root*v]) as Vec3;
  const [a,b,c]=points.map(p=>p.position),ab=sub3(b,a),ac=sub3(c,a);
  const position=Object.freeze(add3(a,add3(mul3(ab,barycentric[1]),mul3(ac,barycentric[2]))));
  const scale=Math.max(Math.hypot(...ab),Math.hypot(...ac)),normal=Object.freeze(unit3(cross3(mul3(ab,1/scale),mul3(ac,1/scale))));
  const face=prepared.faces[t.face],sample:SurfaceSample<F>=Object.freeze({source:target.surface,face,triangle,vertices:t.vertices,barycentric,position,normal});
  const point:SurfacePoint3={id:JSON.stringify(['sample',index]),position,attributes:{...target.surface.faces[t.face].attributes,...weightedAttributes(points,barycentric,target.transfers)},provenance:{operation:'sample',parents:[face.id,...points.map(p=>p.id)]}};
  return {point,sample};
}
function result<P extends Attributes3,E extends EdgeAttributes,F extends Attributes3>(target:Mesh<P,E,F>,points:readonly SurfacePoint3[],samples:ReadonlyMap<string,SurfaceSample<F>>,generation:SamplingGeneration,options:GeometryOptions):SurfaceSamples<Combined<F,P>,F>{
  const surface:Surface3={...surface3([],[]),points};
  return new SurfaceSamples(new PointGeometry<Combined<F,P>>(surface,{key:options.key}),target,samples,generation);
}
/** Advanced explicit random-source entry; normal sketches call t.sample(mesh). */
export function sampleSurfacePoints<P extends Attributes3,E extends EdgeAttributes,F extends Attributes3>(target:Mesh<P,E,F>,options:SurfaceSamplingOptions<F>,env:SurfaceSamplingEnv):SurfaceSamples<Combined<F,P>,F>{
  optionsObject(options);env.signal?.throwIfAborted();if(!(target instanceof Mesh))throw new Error('surface sampling requires a mesh');
  const count=options.count,limit=options.maxPoints??100_000;nonnegativeInteger(count,'surface sample count');nonnegativeInteger(limit,'surface sample point budget');
  if(count>limit)throw new Error('surface sampling exceeds point budget');
  const points:SurfacePoint3[]=[],samples=new Map<string,SurfaceSample<F>>();
  if(count){const prepared=prepare(target,options.weight);if(!prepared.total)throw new Error('surface sampling requires positive weighted surface area');
    for(let i=0;i<count;i++){env.signal?.throwIfAborted();const next=draw(target,prepared,env,i);points.push(next.point);samples.set(next.point.id,next.sample);}
  }
  return result(target,points,samples,{attempts:count,accepted:count,reason:'count'},options);
}
/** Global dart rejection with a bounded sparse world-space neighbor grid. */
export function scatterSurfacePoints<P extends Attributes3,E extends EdgeAttributes,F extends Attributes3>(target:Mesh<P,E,F>,options:SurfaceScatterOptions<F>,env:SurfaceSamplingEnv):SurfaceSamples<Combined<F,P>,F>{
  optionsObject(options);env.signal?.throwIfAborted();if(!(target instanceof Mesh))throw new Error('surface scatter requires a mesh');
  const spacing=options.spacing,limit=options.maxPoints??10_000,budget=options.maxAttempts??100_000;
  if(!Number.isFinite(spacing)||spacing<=0)throw new Error('surface scatter spacing must be positive finite world units');
  nonnegativeInteger(limit,'surface scatter point limit');nonnegativeInteger(budget,'surface scatter attempt limit');
  const points:SurfacePoint3[]=[],samples=new Map<string,SurfaceSample<F>>(),buckets=new Map<string,number[]>();let attempts=0,reason:SamplingGeneration['reason']='point-limit';
  if(limit&&budget){
    const prepared=prepare(target,options.weight);
    if(prepared.extent/spacing>2**48)throw new Error('surface scatter spacing is too small relative to the mesh extent for its neighbor grid');
    reason=prepared.total?'attempt-limit':'empty';
    if(prepared.total)for(;attempts<budget&&points.length<limit;attempts++){
      env.signal?.throwIfAborted();const next=draw(target,prepared,env,attempts),p=next.point.position;
      const cell=sub3(p,prepared.origin).map(v=>Math.floor(v/spacing));let fits=true;
      for(let x=-2;x<=2&&fits;x++)for(let y=-2;y<=2&&fits;y++)for(let z=-2;z<=2&&fits;z++)for(const i of buckets.get(`${cell[0]+x},${cell[1]+y},${cell[2]+z}`)??[]){if(Math.hypot(...sub3(p,points[i].position))<spacing){fits=false;break;}}
      if(!fits)continue;
      const key=cell.join(','),bucket=buckets.get(key)??[];bucket.push(points.length);buckets.set(key,bucket);points.push(next.point);samples.set(next.point.id,next.sample);
    }
    if(points.length===limit)reason='point-limit';
  }else if(!budget&&limit)reason='attempt-limit';
  return result(target,points,samples,{attempts,accepted:points.length,reason},options);
}
