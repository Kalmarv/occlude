import {Table3,select3,kind3,POINTS3,EDGES3} from './collection.js';
import {ROW_TYPES,type Selection,type Types} from '../../selection.js';
import type {Attributes3} from '../geometry/surface.js';
import {Mesh,type GeometryOptions,type PointRow} from './mesh.js';
import {surfaceBinding3,rebindSurfaceCurveNetwork3,selectSurfaceCurveNetwork3,validateSurfaceCurveNetwork3,surfaceCurveNetwork3,bindingTriangle3,type SurfaceCurveNetwork3,type SurfaceCurveNode3,type SupportedCurveSegment3,type SurfaceCurveRecipe3} from '../curves/network.js';
import {Instances,instanceSurfaceBinding3} from './instances.js';
import {identity} from './identity.js';
import {weightedPoint} from '../geometry/exact.js';
import {refuseStroke,refuseDisplay} from './recipes.js';
/** Multiple support contexts remain distinct at seams and intersections. */
export interface SurfaceCurvePoint extends PointRow<{}> {
 readonly exact:SurfaceCurveNode3['exact'];readonly supports:SurfaceCurveNode3['supports'];
 readonly attributes:SurfaceCurveNode3['attributes'];
 readonly [ROW_TYPES]?:SurfaceCurvePointTypes;
}
/** @internal What a selection of supported-curve points answers: derived
 * rows, so no write; `extract()` is the rows themselves. */
export type SurfaceCurvePointTypes=Types<{source:SurfaceCurveNetwork3;points:Selection<SurfaceCurvePoint>;extract:()=>readonly SurfaceCurvePoint[]}>;
/** @internal What a selection of supported-curve edges answers: `extract()`
 * is the curves those edges make. */
export type SurfaceCurveEdgeTypes<A extends Attributes3>=Types<{source:SurfaceCurveNetwork3;edges:Selection<SurfaceCurveEdge<A>>;extract:()=>SurfaceCurves<A>}>;
export type SurfaceCurveEdge<A extends Attributes3={}> = Readonly<Omit<A,keyof SupportedCurveSegment3|'index'> & Omit<SupportedCurveSegment3,'a'|'b'> & {
 readonly index:number;readonly a:SurfaceCurvePoint;readonly b:SurfaceCurvePoint;
 readonly [ROW_TYPES]?:SurfaceCurveEdgeTypes<A>;
}>;
const rows=new WeakMap<SurfaceCurveNetwork3,{points:readonly SurfaceCurvePoint[];edges:readonly SurfaceCurveEdge[]}>();
/** One chain of supported curves: its points in walking order, whether it
 * comes back to its start, its edges, and the columns every one of its
 * edges agrees on (`c.level` on an isoline ring), read as properties like
 * every other row; `attributes` is the same record. */
export type SurfaceChain<A extends Attributes3={}> = Readonly<Partial<A>&{
 id:string;index:number;points:Selection<SurfaceCurvePoint>;closed:boolean;
 edges:Selection<SurfaceCurveEdge<A>>;attributes:Readonly<Partial<A>>;
 readonly [ROW_TYPES]?:SurfaceChainTypes<A>;
}>;
/** @internal What a selection of supported-curve chains answers: derived
 * rows, so no write; `extract()` is the curves they make. */
export type SurfaceChainTypes<A extends Attributes3>=Types<{source:SurfaceCurveNetwork3;points:Selection<SurfaceCurvePoint>;edges:Selection<SurfaceCurveEdge<A>>;curves:Selection<SurfaceChain<A>>;extract:()=>SurfaceCurves<A>}>;
type ChainSel=Selection<SurfaceChain<any>>;
/** The words of a selection of supported-curve chains: its points and its
 * edges, chain by chain in walking order, and itself as its curves. */
const whole=new WeakMap<object,{readonly points:Selection<SurfaceCurvePoint>;readonly edges:Selection<SurfaceCurveEdge<any>>}>();
const CURVES3=kind3('curve',{
 points:{get(this:ChainSel){return whole.get(this.domain)!.points.rows([...new Set(this.map(c=>c.points.indices).flat())]);}},
 edges:{get(this:ChainSel){return whole.get(this.domain)!.edges.rows([...new Set(this.map(c=>c.edges.indices).flat())]);}},
 curves:{get(this:ChainSel){return this;}},
});
/** Chains of a network, each a run of segments sharing a `chainId`, walked
 * end to end from an end (or from its first segment when it is a ring). */
function chainsOf(network:SurfaceCurveNetwork3):{id:string;segments:number[];points:number[];closed:boolean}[] {
 const byChain=new Map<string,number[]>();
 network.segments.forEach((s,i)=>{const list=byChain.get(s.chainId);if(list)list.push(i);else byChain.set(s.chainId,[i]);});
 return [...byChain].map(([id,segments])=>{
  const at=new Map<number,number[]>();
  for(const i of segments)for(const n of [network.segments[i].a,network.segments[i].b]){const l=at.get(n);if(l)l.push(i);else at.set(n,[i]);}
  const first=network.segments[segments[0]],start=[...at].find(([,l])=>l.length===1)?.[0]??first.a;
  const used=new Set<number>(),points=[start];let node=start;
  for(;;){
   const next=(at.get(node)??[]).find(i=>!used.has(i));if(next===undefined)break;
   used.add(next);const s=network.segments[next];node=s.a===node?s.b:s.a;
   if(node===start)break;points.push(node);
  }
  return {id,segments,points,closed:node===start&&used.size>0&&at.get(start)!.length===2};
 });
}
/** Supported construction geometry, before camera interpretation. Generators
 * create these values; edge extraction retains attachments and full source phase. */
export interface SurfaceCurveOptions extends GeometryOptions {}
const isRecipe=(source:SurfaceCurveNetwork3|SurfaceCurveRecipe3):source is SurfaceCurveRecipe3=>typeof (source as SurfaceCurveRecipe3).resolve==='function';
interface Built<A extends Attributes3> {readonly network:SurfaceCurveNetwork3;readonly points:Selection<SurfaceCurvePoint>;readonly edges:Selection<SurfaceCurveEdge<A>>}
export class SurfaceCurves<A extends Attributes3={}> {
 readonly key?:string;
 readonly #source:SurfaceCurveNetwork3|SurfaceCurveRecipe3;
 #built?:Built<A>;
 #curves?:Selection<SurfaceChain<A>>;
 /** A network is held as is. A recipe (`intersections`) is a description:
  * a view resolves it among the sources it draws, and a direct read of the
  * curves resolves every source, once. */
 constructor(source:SurfaceCurveNetwork3|SurfaceCurveRecipe3,options:SurfaceCurveOptions={}){
  if(!isRecipe(source))validateSurfaceCurveNetwork3(source);
  if(options.key!==undefined&&(typeof options.key!=='string'||!options.key))throw new Error('surface curve key must be nonempty');
  refuseStroke(options,'surface curves');refuseDisplay(options,'surface curves');
  this.key=options.key;this.#source=source;
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
   points:select3(new Table3(POINTS3,network,'point',points,{extract:indices=>Object.freeze(indices.map(i=>points[i]))}),active) as Selection<SurfaceCurvePoint>,
   edges:select3(new Table3(EDGES3,network,'edge',edges as readonly SurfaceCurveEdge<A>[],{extract:indices=>new SurfaceCurves<A>(selectSurfaceCurveNetwork3(network,indices),this)})) as unknown as Selection<SurfaceCurveEdge<A>>,
  };
 }
 /** The chains these curves are made of, in the order they were made: a
  * selection of chain rows, read on first ask and kept. */
 get curves():Selection<SurfaceChain<A>> {
  if(this.#curves)return this.#curves;
  const {network,points,edges}=this.#build();
  const chains=Object.freeze(chainsOf(network).map((chain,index)=>{
   const shared:Record<string,unknown>={},first=network.segments[chain.segments[0]].attributes;
   for(const [name,value] of Object.entries(first))if(chain.segments.every(i=>network.segments[i].attributes[name]===value))shared[name]=value;
   return Object.freeze({...shared,id:chain.id,index,points:points.rows(chain.points),closed:chain.closed,edges:edges.rows(chain.segments),attributes:Object.freeze(shared)}) as unknown as SurfaceChain<A>;
  }));
  const table=new Table3(CURVES3,network,'curve',chains,{extract:indices=>new SurfaceCurves<A>(selectSurfaceCurveNetwork3(network,indices.flatMap(i=>chains[i].edges.indices)),this)});
  whole.set(table,{points,edges});
  return this.#curves=select3(table) as Selection<SurfaceChain<A>>;
 }
 /** The chains a test keeps, as curves a view draws. */
 filter(test:(chain:SurfaceChain<A>,index:number)=>unknown):SurfaceCurves<A> {
  const kept=[...this.curves].filter(test);
  return new SurfaceCurves<A>(selectSurfaceCurveNetwork3(this.network,kept.flatMap(c=>c.edges.indices)),this);
 }
 map<T>(field:(chain:SurfaceChain<A>,index:number)=>T):T[]{return this.curves.map(field);}
 find(test:(chain:SurfaceChain<A>,index:number)=>unknown):SurfaceChain<A>|undefined{return this.curves.find(test);}
 some(test:(chain:SurfaceChain<A>,index:number)=>unknown):boolean{return this.curves.some(test);}
 every(test:(chain:SurfaceChain<A>,index:number)=>unknown):boolean{return this.curves.every(test);}
 /** The chains split by key, first-occurrence order: each group's key and
  * its curves, which a view draws. (`key` on the curves themselves is their
  * view identity, so the group key rides beside them.) */
 groupBy<K>(field:(chain:SurfaceChain<A>)=>K):readonly {readonly key:K;readonly curves:SurfaceCurves<A>}[] {
  const groups=new Map<K,number[]>();
  for(const chain of this.curves){const k=field(chain),list=groups.get(k)??[];list.push(...chain.edges.indices);groups.set(k,list);}
  return Object.freeze([...groups].map(([key,indices])=>Object.freeze({key,curves:new SurfaceCurves<A>(selectSurfaceCurveNetwork3(this.network,indices),this)})));
 }
 /** The description behind these curves, when they are not computed yet. */
 get recipe():SurfaceCurveRecipe3|undefined{return isRecipe(this.#source)?this.#source:undefined;}
 get network():SurfaceCurveNetwork3{return this.#build().network;}
 get points():Selection<SurfaceCurvePoint>{return this.#build().points;}
 get edges():Selection<SurfaceCurveEdge<A>>{return this.#build().edges;}
 get sources():SurfaceCurveNetwork3['sources']{return this.network.sources;}
 rebind(target:Mesh<any,any,any,any>|readonly Mesh<any,any,any,any>[]):SurfaceCurves<A> {
  const targets=target instanceof Mesh?[target]:target;
  if(!Array.isArray(targets)||targets.length!==this.sources.length||targets.some(t=>!(t instanceof Mesh)))throw new Error('curve rebind requires one mesh per source');
  const bindings=targets.map((t,i)=>surfaceBinding3(t.surface,this.sources[i].binding.placement));
  return new SurfaceCurves<A>(rebindSurfaceCurveNetwork3(this.network,bindings),this);
 }
 withKey(key:string):SurfaceCurves<A>{return new SurfaceCurves<A>(this.#source,{key});}
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
  const placed=surfaceCurveNetwork3({sources,nodes,segments}),curves=new SurfaceCurves<A&{instance:string}>(placed,{key:this.key});
  if(selected.size===network.segments.length)return curves;
  return curves.edges.filter(e=>selected.has(network.segments.find(s=>identity('placed-segment',e.instance,s.id)===e.id)?.id??'')).extract();
 }
}
