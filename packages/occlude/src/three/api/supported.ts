import {Collection} from './collection.js';
import type {Attributes3} from '../geometry/surface.js';
import {Mesh,type GeometryOptions,type PointRow} from './mesh.js';
import {surfaceBinding3,rebindSurfaceCurveNetwork3,selectSurfaceCurveNetwork3,validateSurfaceCurveNetwork3,surfaceCurveNetwork3,bindingTriangle3,type SurfaceCurveNetwork3,type SurfaceCurveNode3,type SupportedCurveSegment3,type SurfaceCurveRecipe3} from '../curves/network.js';
import {Instances,instanceSurfaceBinding3} from './instances.js';
import {identity} from './identity.js';
import {weightedPoint} from '../geometry/exact.js';
/** Multiple support contexts remain distinct at seams and intersections. */
export interface SurfaceCurvePoint extends PointRow<{}> {
 readonly exact:SurfaceCurveNode3['exact'];readonly supports:SurfaceCurveNode3['supports'];
 readonly attributes:SurfaceCurveNode3['attributes'];
}
export type SurfaceCurveEdge<A extends Attributes3={}> = Readonly<Omit<A,keyof SupportedCurveSegment3|'index'> & Omit<SupportedCurveSegment3,'a'|'b'> & {
 readonly index:number;readonly a:SurfaceCurvePoint;readonly b:SurfaceCurvePoint;
}>;
const rows=new WeakMap<SurfaceCurveNetwork3,{points:readonly SurfaceCurvePoint[];edges:readonly SurfaceCurveEdge[]}>();
/** Supported construction geometry, before camera interpretation. Generators
 * create these values; edge extraction retains attachments and full source phase. */
export interface SurfaceCurveOptions extends GeometryOptions {
 /** Named pen for `view`'s default drawing of these marks. */
 readonly stroke?:string;
}
const isRecipe=(source:SurfaceCurveNetwork3|SurfaceCurveRecipe3):source is SurfaceCurveRecipe3=>typeof (source as SurfaceCurveRecipe3).resolve==='function';
interface Built<A extends Attributes3> {readonly network:SurfaceCurveNetwork3;readonly points:Collection<SurfaceCurvePoint,readonly SurfaceCurvePoint[]>;readonly edges:Collection<SurfaceCurveEdge<A>,SurfaceCurves<A>>}
export class SurfaceCurves<A extends Attributes3={}> {
 readonly key?:string;
 readonly stroke?:string;
 readonly #source:SurfaceCurveNetwork3|SurfaceCurveRecipe3;
 #built?:Built<A>;
 /** A network is held as is. A recipe (`intersections`) is a description:
  * a view resolves it among the sources it draws, and a direct read of the
  * curves resolves every source, once. */
 constructor(source:SurfaceCurveNetwork3|SurfaceCurveRecipe3,options:SurfaceCurveOptions={}){
  if(!isRecipe(source))validateSurfaceCurveNetwork3(source);
  if(options.key!==undefined&&(typeof options.key!=='string'||!options.key))throw new Error('surface curve key must be nonempty');
  if(options.stroke!==undefined&&(typeof options.stroke!=='string'||!options.stroke))throw new Error('surface curve stroke must be a pen name');
  this.key=options.key;this.stroke=options.stroke;this.#source=source;
  Object.freeze(this);
 }
 #build():Built<A> {
  if(this.#built)return this.#built;
  const network=isRecipe(this.#source)?this.#source.resolve():this.#source;
  let cached=rows.get(network);
  if(!cached){
   const points=Object.freeze(network.nodes.map((node,index)=>Object.freeze({id:node.id,index,x:node.position[0],y:node.position[1],z:node.position[2],attributes:node.attributes,exact:node.exact,supports:node.supports})));
   const edges=Object.freeze(network.segments.map((segment,index)=>Object.freeze({...segment.attributes,...segment,index,a:points[segment.a],b:points[segment.b]})));
   cached={points,edges};rows.set(network,cached);
  }
  const {points,edges}=cached;
  const active=network.reference?[...new Set(network.segments.flatMap(s=>[s.a,s.b]))]:points.map(p=>p.index);
  return this.#built={
   network,
   points:new Collection(network,'point',points,indices=>Object.freeze(indices.map(i=>points[i])),active),
   edges:new Collection(network,'edge',edges as readonly SurfaceCurveEdge<A>[],indices=>new SurfaceCurves<A>(selectSurfaceCurveNetwork3(network,indices),this)),
  };
 }
 /** The description behind these curves, when they are not computed yet. */
 get recipe():SurfaceCurveRecipe3|undefined{return isRecipe(this.#source)?this.#source:undefined;}
 get network():SurfaceCurveNetwork3{return this.#build().network;}
 get points():Collection<SurfaceCurvePoint,readonly SurfaceCurvePoint[]>{return this.#build().points;}
 get edges():Collection<SurfaceCurveEdge<A>,SurfaceCurves<A>>{return this.#build().edges;}
 get sources():SurfaceCurveNetwork3['sources']{return this.network.sources;}
 rebind(target:Mesh<any,any,any,any>|readonly Mesh<any,any,any,any>[]):SurfaceCurves<A> {
  const targets=target instanceof Mesh?[target]:target;
  if(!Array.isArray(targets)||targets.length!==this.sources.length||targets.some(t=>!(t instanceof Mesh)))throw new Error('curve rebind requires one mesh per source');
  const bindings=targets.map((t,i)=>surfaceBinding3(t.surface,this.sources[i].binding.placement));
  return new SurfaceCurves<A>(rebindSurfaceCurveNetwork3(this.network,bindings),this);
 }
 withKey(key:string):SurfaceCurves<A>{return new SurfaceCurves<A>(this.#source,{key,stroke:this.stroke});}
 /** The same marks drawn with a named pen by `view`; curves carry only `stroke`. */
 style(style:{readonly stroke?:string}):SurfaceCurves<A>{return new SurfaceCurves<A>(this.#source,{key:this.key,stroke:style.stroke??this.stroke});}
 /** Repeat prototype-attached marks at every placement of an instance set.
  * Attachments are re-evaluated on each placed triangle from their retained
  * affine weights; the prototype mesh is not realized. Segment attributes gain
  * the instance ID; chains are per placement. Single-source marks only. */
 place(instances:Instances<any,any,any,any,any,any,any>):SurfaceCurves<A&{instance:string}> {
  if(!(instances instanceof Instances))throw new Error('curve placement requires an instance set');
  const network=this.network.reference??this.network;
  if(network.sources.length!==1||network.sources[0].binding.placement)throw new Error('curve placement requires marks attached to one unplaced prototype');
  if(network.sources[0].binding.source!==instances.prototype.surface)throw new Error('curves are attached to a different prototype than these instances');
  const selected=new Set(this.network.segments.map(s=>s.id));
  const sources=instances.rows.map(row=>({id:row.id,binding:instanceSurfaceBinding3(instances,row)}));
  const nodes=sources.flatMap((source,si)=>network.nodes.map(node=>{
   const support=node.supports[0],weights=support.weights.map(v=>BigInt(v));
   return {id:identity('placed-node',source.id,node.id),point:weightedPoint(bindingTriangle3(source.binding,support.triangle),weights),supports:node.supports.map(s=>({source:si,triangle:s.triangle})),attributes:node.attributes};
  }));
  const segments=sources.flatMap((source,si)=>network.segments.map(segment=>({
   id:identity('placed-segment',source.id,segment.id),kind:segment.kind,a:identity('placed-node',source.id,network.nodes[segment.a].id),b:identity('placed-node',source.id,network.nodes[segment.b].id),
   chainId:identity('placed-chain',source.id,segment.chainId),range:segment.range,supports:segment.supports.map(s=>({source:si,triangle:s.triangle})),attributes:{...segment.attributes,instance:source.id},
  })));
  const placed=surfaceCurveNetwork3({sources,nodes,segments}),curves=new SurfaceCurves<A&{instance:string}>(placed,{key:this.key,stroke:this.stroke});
  if(selected.size===network.segments.length)return curves;
  return curves.edges.filter(e=>selected.has(network.segments.find(s=>identity('placed-segment',e.instance,s.id)===e.id)?.id??'')).extract();
 }
}
