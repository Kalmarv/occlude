import {Collection} from './collection.js';
import {Mesh,PointGeometry,captureAttributeFields,evaluate,pointSteps,type PointRow,type Field,type AttributeFields,type GeometryOptions,type PointRule,type StepAttributes,type StepsOptions,type PointSnapshot,type StepShorthand} from './mesh.js';
import type {DisplaceOptions,RotateOptions,ScaleOptions} from './mesh.js';
import {Instances,instanceSurfaceBinding3} from './instances.js';
import {SurfaceCurves} from './supported.js';
import {identity} from './identity.js';
import {assembleSurface3,type Attributes3,type Attribute3,type SurfacePoint3} from '../geometry/surface.js';
import {surfaceLocation3,type SurfaceLocation3} from '../geometry/location.js';
import {decodePoint,encodePoint,mixPoint,pointNumber,triangleWeights,integerWeights,ratioNumber,difference,abs,type Ratio,type EncodedPoint3} from '../geometry/exact.js';
import {bindingTriangle3,sameSurfaceCurveLineage3,type SurfaceCurveNetwork3,type SupportedCurveSegment3} from '../curves/network.js';
import type {Vec3} from '../math.js';
import type {RotationInput,Axis3} from '../rotation.js';

export interface CurveSamplingOptions extends GeometryOptions {
 readonly count?:number;
 /** Model/world units, per contiguous source chain. No paper conversion. */
 readonly spacing?:number;
 readonly maxPoints?:number;readonly maxSupports?:number;
}
export interface CurveSample {
 readonly chainId:string;readonly edgeId:string;readonly parameter:number;
 readonly exact:EncodedPoint3;readonly position:Vec3;readonly tangent:Vec3;
 /** All incident triangle contexts remain distinct at creases and UV seams. */
 readonly locations:readonly SurfaceLocation3[];
 /** Select actual mesh/placement ownership; multiple face contexts stay explicit. */
 on(target:Mesh<any,any,any,any>|Instances<any,any,any,any,any,any,any>):readonly SurfaceLocation3[];
}
export type CurveSampleRow<P extends Attributes3={}> = PointRow<P>&{readonly sample:CurveSample};
interface Attachment {readonly edgeId:string;readonly fraction:Ratio}
interface SampleState {readonly target:SurfaceCurves<any>;readonly attachments:ReadonlyMap<string,Attachment>;readonly rows:readonly CurveSampleRow<any>[]}
const states=new WeakMap<object,SampleState>();
function context(network:SurfaceCurveNetwork3,segment:SupportedCurveSegment3,fraction:Ratio):CurveSample {
 const a=decodePoint(network.nodes[segment.a].exact),b=decodePoint(network.nodes[segment.b].exact),p=mixPoint(a,b,fraction),position=pointNumber(p);
 const direction=difference(b,a),scale=direction.reduce((n,v)=>abs(v)>n?abs(v):n,0n),d=direction.map(n=>ratioNumber([n,scale])) as unknown as Vec3,length=Math.hypot(...d);
 const tangent=Object.freeze(d.map(v=>v/length)) as unknown as Vec3;
 let locations:readonly SurfaceLocation3[]|undefined;
 const supports=fraction[0]===0n?network.nodes[segment.a].supports:fraction[0]===fraction[1]?network.nodes[segment.b].supports:segment.supports;
 const rows=()=>locations??=(Object.freeze(supports.map(s=>{
  const binding=network.sources[s.source].binding,weights=triangleWeights(bindingTriangle3(binding,s.triangle),p);
  if(!weights)throw new Error('curve sample lost its source attachment');
  const total=weights.reduce((a,b)=>a+b,0n),barycentric=weights.map(n=>ratioNumber([n,total])) as unknown as Vec3;
  return surfaceLocation3(binding.source,s.triangle,barycentric,{placement:binding.placement,exactWeights:weights});
 })));
 return Object.freeze({chainId:segment.chainId,edgeId:segment.id,parameter:segment.range[0]+ratioNumber(fraction)*(segment.range[1]-segment.range[0]),exact:encodePoint(p),position,tangent,
  get locations(){return rows();},
  on(target:Mesh<any,any,any,any>|Instances<any,any,any,any,any,any,any>){
   if(target instanceof Mesh)return Object.freeze(rows().filter(row=>row.source===target.surface&&!row.placement));
   if(!(target instanceof Instances))throw new Error('curve sample source requires a mesh or instance set');
   const bindings=target.rows.map(row=>instanceSurfaceBinding3(target,row));
   return Object.freeze(rows().filter(row=>bindings.some(b=>b.source===row.source&&b.placement===row.placement)));
  },
 });
}
/** Ordinary editable point geometry retaining its original curve interpretation.
 * Moving points edits their positions; explicit rebind refreshes attachments. */
export class CurveSamples<P extends Attributes3={},A extends Attributes3={}> extends PointGeometry<P> {
 constructor(geometry:PointGeometry<P>,target:SurfaceCurves<A>,attachments:ReadonlyMap<string,Attachment>){
  super(geometry.surface,geometry);
  const network=target.network.reference??target.network,segments=new Map(network.segments.map(s=>[s.id,s])),owned=new Map<string,Attachment>();
  const rows=Object.freeze(geometry.points.map(p=>{
   const attachment=attachments.get(p.id),segment=attachment&&segments.get(attachment.edgeId);
   if(!attachment||!segment)throw new Error('curve sample provenance is missing');
   owned.set(p.id,attachment);return Object.freeze({...p,sample:context(network,segment,attachment.fraction)});
  }));
  states.set(this,{target,attachments:owned,rows});
 }
 private get state(){return states.get(this)!;}
 get target():SurfaceCurves<A>{return this.state.target;}
 get points():Collection<CurveSampleRow<P>,CurveSamples<P,A>> {
  return new Collection(this.surface,'point',this.state.rows as readonly CurveSampleRow<P>[],indices=>{
   const selected=new Set(indices);return this.changed(super.points.filter(p=>selected.has(p.index)).extract());
  });
 }
 private changed<Q extends Attributes3>(geometry:PointGeometry<Q>):CurveSamples<Q,A>{return new CurveSamples(geometry,this.target,this.state.attachments);}
 attribute<Name extends string,Value extends Attribute3>(name:Name,field:Field<CurveSampleRow<P>,Value>):CurveSamples<Omit<P,Name>&Record<Name,Value>,A>{return this.changed(super.attribute(name,p=>evaluate(field,this.state.rows[p.index])));}
 attributes<Q extends Attributes3>(fields:AttributeFields<CurveSampleRow<P>,Q>):CurveSamples<Omit<P,keyof Q>&Q,A>{
  const values=captureAttributeFields(this.state.rows,fields);
  return this.changed(new PointGeometry<Omit<P,keyof Q>&Q>(assembleSurface3(this.surface.points.map((p,i)=>({...p,attributes:{...p.attributes,...values[i]}})),[],[]),{key:this.key}));
 }
 displace(field:Field<CurveSampleRow<P>,Vec3|number>,options:DisplaceOptions={}):CurveSamples<P,A>{return this.changed(super.displace(p=>evaluate(field,this.state.rows[p.index]),options));}
 translate(offset:Vec3):CurveSamples<P,A>{return this.changed(super.translate(offset));}
 rotate(angles:RotationInput,pivot?:Vec3|RotateOptions):CurveSamples<P,A>;
 rotate(axis:Axis3,degrees:number,options?:RotateOptions):CurveSamples<P,A>;
 rotate(a:RotationInput|Axis3,b?:number|Vec3|RotateOptions,c?:RotateOptions):CurveSamples<P,A>{return this.changed((super.rotate as (...args:unknown[])=>PointGeometry<P>)(a,b,c));}
 scale(scale:number|Vec3,pivot?:Vec3|ScaleOptions):CurveSamples<P,A>{return this.changed(super.scale(scale,pivot));}
 withKey(key:string):CurveSamples<P,A>{return this.changed(super.withKey(key));}
 get history():readonly PointSnapshot<P,CurveSamples<P,A>>[]{return super.history as readonly PointSnapshot<P,CurveSamples<P,A>>[];}
 steps(count:number,rule:PointRule<StepAttributes<P>,CurveSampleRow<StepAttributes<P>>,CurveSamples<StepAttributes<P>,A>>|StepShorthand<CurveSampleRow<StepAttributes<P>>,StepAttributes<P>>,...passesAndOptions:(PointRule<StepAttributes<P>,CurveSampleRow<StepAttributes<P>>,CurveSamples<StepAttributes<P>,A>>|StepsOptions)[]):CurveSamples<StepAttributes<P>,A>{
  return pointSteps(this,count,rule,passesAndOptions,(surface,iteration,history)=>this.changed(new PointGeometry<StepAttributes<P>>(surface,{key:this.key,iteration,history})));
 }
 rebind(target:SurfaceCurves<A>):CurveSamples<P,A>{
  if(!(target instanceof SurfaceCurves))throw new Error('curve samples rebind to regenerated or rebound source curves');
  const previous=this.target.network.reference??this.target.network,next=target.network.reference??target.network;
  // Matching string IDs alone never authorize moving to an unrelated graph.
  if(!sameSurfaceCurveLineage3(previous,next))throw new Error('curve construction changed; regenerate samples');
  const segments=new Map(next.segments.map(s=>[s.id,s]));
  const points=this.surface.points.map(p=>{const a=this.state.attachments.get(p.id)!,segment=segments.get(a.edgeId);if(!segment)throw new Error('curve edge was not retained; regenerate samples');return {...p,position:context(next,segment,a.fraction).position};});
  return new CurveSamples(new PointGeometry<P>(assembleSurface3(points,[],[]),{key:this.key}),target,this.state.attachments);
 }
}
export function sampleSurfaceCurves<A extends Attributes3>(target:SurfaceCurves<A>,options:CurveSamplingOptions={}):CurveSamples<A,A> {
 const {count,spacing}=options,maxPoints=options.maxPoints??Infinity,maxSupports=options.maxSupports??Infinity;
 if(count!==undefined&&spacing!==undefined)throw new Error('curve sample chooses count or spacing');
 if(count!==undefined&&(!Number.isSafeInteger(count)||count<1)||spacing!==undefined&&(!Number.isFinite(spacing)||spacing<=0)||[maxPoints,maxSupports].some(n=>!(n===Infinity||Number.isSafeInteger(n))||n<0))throw new Error('invalid curve sampling count, spacing or budget');
 const network=target.network,groups=new Map<string,SupportedCurveSegment3[]>(),chains:SupportedCurveSegment3[][]=[];
 const degree=new Map<number,number>();for(const segment of network.reference?.segments??network.segments)for(const node of [segment.a,segment.b])degree.set(node,(degree.get(node)??0)+1);
 for(const segment of network.segments){const rows=groups.get(segment.chainId)??[];rows.push(segment);groups.set(segment.chainId,rows);}
 for(const rows of groups.values()){
  rows.sort((a,b)=>a.range[0]-b.range[0]||a.range[1]-b.range[1]);let chain:SupportedCurveSegment3[]=[];
  for(const row of rows){const last=chain.at(-1);if(last&&(last.b!==row.a||last.range[1]!==row.range[0]||degree.get(row.a)!==2)){chains.push(chain);chain=[];}chain.push(row);}if(chain.length)chains.push(chain);
 }
 const points:SurfacePoint3[]=[],attachments=new Map<string,Attachment>();let supports=0;
 for(const chain of chains){
  const closed=chain[0].a===chain.at(-1)!.b,length=chain.reduce((sum,s)=>sum+s.length,0);
  if(!(length>0)||!Number.isFinite(length))throw new Error('curve sampling requires a representable positive chain length');
  const n=count??(spacing===undefined?32:Math.max(closed?1:2,Math.ceil(length/spacing)+(closed?0:1)));
  if(!Number.isSafeInteger(n)||points.length+n>maxPoints)throw new Error('curve sampling exceeds point budget');
  let edge=0,offset=0;
  for(let i=0;i<n;i++){
   const distance=length*(closed?i/n:n===1?.5:i/(n-1));
   while(edge<chain.length-1&&(chain[edge].length===0||distance>offset+chain[edge].length)){offset+=chain[edge].length;edge++;}
   const start=i===0&&(closed||n>1),end=!closed&&n>1&&i===n-1,segment=start?chain[0]:end?chain.at(-1)!:chain[edge];
   const t=start?0:end?1:Math.max(0,Math.min(1,(distance-offset)/segment.length)),weights=integerWeights([1-t,t]),fraction=Object.freeze([weights[1],weights[0]+weights[1]]) as Ratio;
   supports+=t===0?network.nodes[segment.a].supports.length:t===1?network.nodes[segment.b].supports.length:segment.supports.length;
   if(supports>maxSupports)throw new Error('curve sampling exceeds support budget');
   const id=identity('curve-sample',segment.chainId,chain[0].id,i,n,options.key??target.key??'default'),sample=context(network,segment,fraction);
   points.push({id,position:sample.position,attributes:{...segment.attributes},provenance:{operation:'sample',parents:[segment.id,segment.chainId]}});attachments.set(id,{edgeId:segment.id,fraction});
  }
 }
 return new CurveSamples(new PointGeometry<A>(assembleSurface3(points,[],[]),{key:options.key}),target,attachments);
}
