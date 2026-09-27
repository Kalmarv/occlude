import {emptySize} from '../degenerate.js';
import {madeGeometry3,pointsMade3,type GeometryOptions} from './mesh.js';
import {Column,kinds,kindWords,type AnyColumn,type AnyKind} from '../../column.js';
import {kindOfValue} from '../../tables.js';
import {Material} from '../../material.js';
import {isInstances,placedOf} from './instances.js';
import {SurfaceCurves} from './supported.js';
import {identity} from './identity.js';
import type {Attribute3,Attributes3} from '../geometry/surface.js';
import {surfaceLocation3,locationMesh3,type SurfaceLocation3} from '../geometry/location.js';
import {mesh3,kernelColumn,checkMade3,type Columns3} from '../geometry/mesh3.js';
import {decodePoint,encodePoint,mixPoint,pointNumber,triangleWeights,integerWeights,ratioNumber,difference,abs,type Ratio,type EncodedPoint3} from '../geometry/exact.js';
import {bindingTriangle3,sameSurfaceCurveLineage3,type SurfaceCurveNetwork3,type SupportedCurveSegment3} from '../curves/network.js';
import type {Vec3} from '../math.js';

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
 on(target:Material):readonly SurfaceLocation3[];
}
interface Attachment {readonly network:SurfaceCurveNetwork3;readonly edgeId:string;readonly fraction:Ratio}
/** Where each curve sample sits on its network, kept beside the record a
 * row answers: a rebind reads it. */
const attachments=new WeakMap<CurveSample,Attachment>();
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
 const sample=Object.freeze({chainId:segment.chainId,edgeId:segment.id,parameter:segment.range[0]+ratioNumber(fraction)*(segment.range[1]-segment.range[0]),exact:encodePoint(p),position,tangent,
  get locations(){return rows();},
  on(target:Material){
   if(isInstances(target)){
    const bindings=placedOf(target).map(copy=>copy.binding);
    return Object.freeze(rows().filter(row=>bindings.some(b=>b.source===locationMesh3(row)&&b.placement===row.placement)));
   }
   if(!(target instanceof Material))throw new Error('sample.on: expected a mesh or instances');
   return Object.freeze(rows().filter(row=>locationMesh3(row)===mesh3(target)&&!row.placement));
  },

 });
 attachments.set(sample,{network,edgeId:segment.id,fraction});
 return sample;
}
/** The curve samples a value's points carry, or undefined when it carries none. */
export function curveSamplesOf(m:Material):readonly CurveSample[]|undefined {
 const column=m.store.attrs.sample as {get(i:number):unknown}|undefined;
 if(column===undefined)return undefined;
 const out:CurveSample[]=[];
 for(let i=0;i<m.n;i++){const s=column.get(i) as CurveSample;if(!attachments.has(s))return undefined;out.push(s);}
 return out;
}
/** The columns of the segment records under the points: one per name any
 * record holds, in the order the names are first met, of the kind its
 * values are; a point whose segment has none reads the kind's default. A
 * column holds one kind. */
function segmentColumns(records:readonly Readonly<Attributes3>[]):Columns3 {
 const found=new Map<string,AnyKind>();
 for(const record of records)for(const name in record){
  const value=record[name];if(value===undefined)continue;
  const kind=kindOfValue(value);
  if(kind===null||kind===undefined||kind===kinds.reference)throw new Error(`a geometry column holds numbers, booleans, strings or numeric vectors — got ${typeof value}`);
  const known=found.get(name);
  if(known===undefined)found.set(name,kind);
  else if(known!==kind)throw new Error(`the column '${name}' holds ${kindWords(known)} on one row and ${kindWords(kind)} on another: a column holds one kind`);
 }
 const out:Record<string,AnyColumn>={},cell=(i:number,name:string):Attribute3|undefined=>records[i][name];
 for(const [name,kind] of found){
  if(kind===kinds.number)out[name]=Column.of(Float64Array.from(records,(_,i)=>(cell(i,name) as number|undefined)??0));
  else if(kind===kinds.boolean)out[name]=kinds.boolean.of(Uint8Array.from(records,(_,i)=>cell(i,name)===true?1:0));
  else if(kind===kinds.string)out[name]=kinds.string.of(records.map((_,i)=>(cell(i,name) as string|undefined)??''));
  else {
   const k=kind.width,flat=new Float64Array(records.length*k);
   records.forEach((_,i)=>{const v=cell(i,name) as readonly number[]|undefined;if(v!==undefined)for(let c=0;c<k;c++)flat[i*k+c]=v[c];});
   out[name]=kinds.vector(k).of(flat);
  }
 }
 return out;
}
/** Points on surface curves as the one geometry: the segment's columns,
 * `sample` each point's place on the curves, `source` the edge under it. */
function curvePoints(target:SurfaceCurves<any>,names:readonly string[],samples:readonly CurveSample[],cols:Columns3,key:string|undefined,from?:Material):Material {
 const edges=[...target.edges] as readonly {readonly id:string}[];
 const at=new Map(edges.map((e,i)=>[e.id,i]));
 const under=samples.map(s=>at.get(attachments.get(s)!.edgeId));
 const made=pointsMade3(samples.map(s=>s.position),names,cols);checkMade3(made);
 return madeGeometry3(made,{key,...(from?{from}:{}),pointCols:{sample:kinds.placement.from(samples)},source:{points:(i:number)=>{const e=under[i];return e===undefined?undefined:target.edges.at(e);}}});
}
/** `samples.rebind(curves)`: every point back on its place along curves
 * rebuilt from the same construction (an explicitly rebound curve set). */
export function rebindCurveSamples(m:Material,target:SurfaceCurves<any>):Material {
 if(!(target instanceof SurfaceCurves))throw new Error('curve samples rebind to regenerated or rebound source curves');
 const samples=curveSamplesOf(m);
 if(samples===undefined)throw new Error('rebind: these points carry no curve samples');
 const next=target.network.reference??target.network,segments=new Map(next.segments.map(s=>[s.id,s]));
 const own=mesh3(m),fresh:CurveSample[]=[];
 for(const s of samples){
  const a=attachments.get(s)!;
  // Matching string IDs alone never authorize moving to an unrelated graph.
  if(!sameSurfaceCurveLineage3(a.network,next))throw new Error('curve construction changed; regenerate samples');
  const segment=segments.get(a.edgeId);if(!segment)throw new Error('curve edge was not retained; regenerate samples');
  fresh.push(context(next,segment,a.fraction));
 }
 // The points keep their names and kernel columns; the reference and
 // placement columns ride across from `m`, the samples over them.
 const cols:Record<string,AnyColumn>={};
 if(m.n)for(const name in own.cols.points)if(kernelColumn(own.cols.points[name]))cols[name]=own.cols.points[name];
 return curvePoints(target,own.names.points,fresh,cols,m.key,m);
}
export function sampleSurfaceCurves<A extends Attributes3>(target:SurfaceCurves<A>,options:CurveSamplingOptions={}):Material {
 const {count,spacing}=options,maxPoints=options.maxPoints??Infinity,maxSupports=options.maxSupports??Infinity;
 if(count!==undefined&&spacing!==undefined)throw new Error('curve sample chooses count or spacing');
 // A non-integer count, a spacing that is not a number and an invalid budget
 // are mistakes; a count below one or a spacing with no length simply asks for
 // no samples.
 if(count!==undefined&&!Number.isSafeInteger(count)||spacing!==undefined&&typeof spacing!=='number'||[maxPoints,maxSupports].some(n=>!(n===Infinity||Number.isSafeInteger(n))||n<0))throw new Error('invalid curve sampling count, spacing or budget');
 if(count!==undefined&&count<1||spacing!==undefined&&emptySize(spacing))return curvePoints(target,[],[],{},options.key);
 const network=target.network,groups=new Map<string,SupportedCurveSegment3[]>(),chains:SupportedCurveSegment3[][]=[];
 const degree=new Map<number,number>();for(const segment of network.reference?.segments??network.segments)for(const node of [segment.a,segment.b])degree.set(node,(degree.get(node)??0)+1);
 for(const segment of network.segments){const rows=groups.get(segment.chainId)??[];rows.push(segment);groups.set(segment.chainId,rows);}
 for(const rows of groups.values()){
  rows.sort((a,b)=>a.range[0]-b.range[0]||a.range[1]-b.range[1]);let chain:SupportedCurveSegment3[]=[];
  for(const row of rows){const last=chain.at(-1);if(last&&(last.b!==row.a||last.range[1]!==row.range[0]||degree.get(row.a)!==2)){chains.push(chain);chain=[];}chain.push(row);}if(chain.length)chains.push(chain);
 }
 const names:string[]=[],records:Readonly<Attributes3>[]=[],samples:CurveSample[]=[];let supports=0;
 for(const chain of chains){
  const closed=chain[0].a===chain.at(-1)!.b,length=chain.reduce((sum,s)=>sum+s.length,0);
  // A chain with no length has nowhere to place a sample: skip it and sample
  // the chains that do.
  if(!(length>0)||!Number.isFinite(length))continue;
  const n=count??(spacing===undefined?32:Math.max(closed?1:2,Math.ceil(length/spacing)+(closed?0:1)));
  if(!Number.isSafeInteger(n)||names.length+n>maxPoints)throw new Error('curve sampling exceeds point budget');
  let edge=0,offset=0;
  for(let i=0;i<n;i++){
   const distance=length*(closed?i/n:n===1?.5:i/(n-1));
   while(edge<chain.length-1&&(chain[edge].length===0||distance>offset+chain[edge].length)){offset+=chain[edge].length;edge++;}
   const start=i===0&&(closed||n>1),end=!closed&&n>1&&i===n-1,segment=start?chain[0]:end?chain.at(-1)!:chain[edge];
   const t=start?0:end?1:Math.max(0,Math.min(1,(distance-offset)/segment.length)),weights=integerWeights([1-t,t]),fraction=Object.freeze([weights[1],weights[0]+weights[1]]) as Ratio;
   supports+=t===0?network.nodes[segment.a].supports.length:t===1?network.nodes[segment.b].supports.length:segment.supports.length;
   if(supports>maxSupports)throw new Error('curve sampling exceeds support budget');
   const id=identity('curve-sample',segment.chainId,chain[0].id,i,n,options.key??target.key??'default'),sample=context(network,segment,fraction);
   names.push(id);records.push(segment.attributes);samples.push(sample);
  }
 }
 return curvePoints(target,names,samples,segmentColumns(records),options.key);
}
