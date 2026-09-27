import {ROW_TYPES,Selection,select,domainKind,rowRange,type Domain,type DomainKind,type Types} from '../../selection.js';
import {describe} from '../../views.js';
import type {Attributes3} from '../geometry/model.js';
import {type GeometryOptions} from './mesh.js';
import {mesh3} from '../geometry/mesh3.js';
import {surfaceBinding3,rebindSurfaceCurveNetwork3,selectSurfaceCurveNetwork3,validateSurfaceCurveNetwork3,surfaceCurveNetwork3,bindingTriangle3,type SurfaceCurveNetwork3,type SurfaceCurveNode3,type SupportedCurveSegment3,type SurfaceCurveRecipe3} from '../curves/network.js';
import {prototypeOf,placedOf} from './instances.js';
import {identity} from './identity.js';
import {weightedPoint} from '../geometry/exact.js';
import {refuseStroke,refuseDisplay} from './recipes.js';
import {Material} from '../../material.js';
/** A point of supported curves: where it is, how it is attached, and its
 * columns read as properties. Multiple support contexts remain distinct at
 * seams and intersections. */
export type SurfaceCurvePoint = Readonly<Record<string,unknown>&{
 readonly id:string;readonly index:number;readonly x:number;readonly y:number;readonly z:number;
 readonly exact:SurfaceCurveNode3['exact'];readonly supports:SurfaceCurveNode3['supports'];
 readonly [ROW_TYPES]?:SurfaceCurvePointTypes;
}>;
/** @internal What a selection of supported-curve points answers: derived
 * rows, so no write; `extract()` is the rows themselves. */
export type SurfaceCurvePointTypes=Types<{source:SurfaceCurveNetwork3;points:Selection<SurfaceCurvePoint>;extract:()=>readonly SurfaceCurvePoint[]}>;
/** @internal What a selection of supported-curve edges answers: `extract()`
 * is the curves those edges make. */
export type SurfaceCurveEdgeTypes<A extends Attributes3>=Types<{source:SurfaceCurveNetwork3;edges:Selection<SurfaceCurveEdge<A>>;extract:()=>SurfaceCurves<A>}>;
/** An edge of supported curves: its columns read as properties, as on every
 * other row. */
export type SurfaceCurveEdge<A extends Attributes3={}> = Readonly<Omit<A,keyof SupportedCurveSegment3|'index'> & Omit<SupportedCurveSegment3,'a'|'b'|'attributes'> & {
 readonly index:number;readonly a:SurfaceCurvePoint;readonly b:SurfaceCurvePoint;
 readonly [ROW_TYPES]?:SurfaceCurveEdgeTypes<A>;
}>;
const rows=new WeakMap<SurfaceCurveNetwork3,{points:readonly SurfaceCurvePoint[];edges:readonly SurfaceCurveEdge[]}>();
/** One chain of supported curves: its points in walking order, whether it
 * comes back to its start, its edges, and the columns every one of its
 * edges agrees on (`c.level` on an isoline ring), read as properties like
 * every other row. */
export type SurfaceChain<A extends Attributes3={}> = Readonly<Partial<A>&{
 id:string;index:number;points:Selection<SurfaceCurvePoint>;closed:boolean;
 edges:Selection<SurfaceCurveEdge<A>>;
 readonly [ROW_TYPES]?:SurfaceChainTypes<A>;
}>;
/** @internal What a selection of supported-curve chains answers: derived
 * rows, so no write; `extract()` is the curves they make. */
export type SurfaceChainTypes<A extends Attributes3>=Types<{source:SurfaceCurveNetwork3;points:Selection<SurfaceCurvePoint>;edges:Selection<SurfaceCurveEdge<A>>;curves:Selection<SurfaceChain<A>>;extract:()=>SurfaceCurves<A>}>;

// ─── the rows as a selection domain ───────────────────────────────────

type Row3={readonly id:string;readonly index:number};
/** Which domain, and which network, each row is a row of. */
const owners=new WeakMap<object,{readonly network:object;readonly kind:DomainKind;readonly index:number}>();
/**
 * The rows of one domain of supported curves: points, edges or chains. They
 * are derived — a view resolves them, and nothing writes them — and a row
 * of another revision of the same curves (an extraction, a rebind) is found
 * here by the name its construction gave it.
 */
class CurveRows<Row extends Row3> implements Domain<Row> {
 readonly dense=true;
 #all:readonly number[]|null=null;
 #names:ReadonlyMap<string,number>|null=null;
 constructor(readonly kind:DomainKind,readonly owner:SurfaceCurveNetwork3,readonly table:readonly Row[],readonly extract:(rows:readonly number[])=>unknown){
  table.forEach((row,index)=>{if(!owners.has(row))owners.set(row,{network:owner,kind,index});});
 }
 get size():number{return this.table.length;}
 all():readonly number[]{return (this.#all??=rowRange(this.table.length));}
 valid(r:number):boolean{return Number.isInteger(r)&&r>=0&&r<this.table.length;}
 row(r:number):Row{return this.table[r];}
 #rowOfName(name:string):number{return (this.#names??=new Map(this.table.map((row,i)=>[row.id,i]))).get(name)??-1;}
 /** A row is who its construction named it: a row of another revision of
  * the same curves (an extraction, a rebind) is found here by that name. */
 keyOf(r:number):unknown{return this.table[r].id;}
 rowOfKey(key:unknown):number{return this.#rowOfName(key as string);}
 locate(v:unknown,who:string):{domain:Domain<Row>;row:number}|{key:unknown}|null{
  if(v===undefined||v===null)return null;
  const owner=typeof v==='object'?owners.get(v):undefined;
  if(owner===undefined||owner.kind!==this.kind)throw new Error(`${who}: expected a ${this.kind.name} of supported curves, got ${owner?`a ${owner.kind.name}`:describe(v)}`);
  return owner.network===this.owner&&this.table[owner.index]===v?{domain:this,row:owner.index}:{key:(v as Row).id};
 }
 shares():boolean{return true;}
}
/** A kind of supported-curve rows: its own words, `extract`, and a refused
 * write. */
function curveKind(name:string,words:Record<string,PropertyDescriptor&ThisType<Selection<any>>>={}):DomainKind {
 return domainKind(name,`${name}s`,{
  ...words,
  extract:{value(this:Selection<any>):unknown{return (this.domain as CurveRows<Row3>).extract(this.indices);}},
 },{set:'supported curves are derived by the construction that made them — they hold no columns to set'});
}
const POINTS3=curveKind('point',{points:{get(this:Selection<any>){return this;}}});
const EDGES3=curveKind('edge',{edges:{get(this:Selection<any>){return this;}}});
type ChainSel=Selection<SurfaceChain<any>>;
/** The words of a selection of supported-curve chains: its points and its
 * edges, chain by chain in walking order, and itself as its curves. */
const whole=new WeakMap<object,{readonly points:Selection<SurfaceCurvePoint>;readonly edges:Selection<SurfaceCurveEdge<any>>}>();
const CURVES3=curveKind('curve',{
 points:{get(this:ChainSel){const all=whole.get(this.domain)!.points;return select(all.domain,[...new Set(this.map(c=>c.points.indices).flat())]);}},
 edges:{get(this:ChainSel){const all=whole.get(this.domain)!.edges;return select(all.domain,[...new Set(this.map(c=>c.edges.indices).flat())]);}},
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
   const points=Object.freeze(network.nodes.map((node,index)=>Object.freeze({...node.attributes,id:node.id,index,x:node.position[0],y:node.position[1],z:node.position[2],exact:node.exact,supports:node.supports}) as SurfaceCurvePoint));
   const edges=Object.freeze(network.segments.map((segment,index)=>{const {attributes,...own}=segment;return Object.freeze({...attributes,...own,index,a:points[segment.a],b:points[segment.b]}) as unknown as SurfaceCurveEdge;}));
   cached={points,edges};rows.set(network,cached);
  }
  const {points,edges}=cached;
  const active=network.reference?[...new Set(network.segments.flatMap(s=>[s.a,s.b]))]:points.map(p=>p.index);
  return this.#built={
   network,
   points:select(new CurveRows(POINTS3,network,points,indices=>Object.freeze(indices.map(i=>points[i]))),active) as Selection<SurfaceCurvePoint>,
   edges:select(new CurveRows(EDGES3,network,edges as readonly SurfaceCurveEdge<A>[],indices=>new SurfaceCurves<A>(selectSurfaceCurveNetwork3(network,indices),this)),null) as unknown as Selection<SurfaceCurveEdge<A>>,
  };
 }
 /** The chains these curves are made of, in the order they were made: a
  * selection of chain rows, read on first ask and kept. `filter`, `map`,
  * `groupBy` and the other selection words read them; `extract()` is the
  * curves a view draws. */
 get curves():Selection<SurfaceChain<A>> {
  if(this.#curves)return this.#curves;
  const {network,points,edges}=this.#build();
  const chains=Object.freeze(chainsOf(network).map((chain,index)=>{
   const shared:Record<string,unknown>={},first=network.segments[chain.segments[0]].attributes;
   for(const [name,value] of Object.entries(first))if(chain.segments.every(i=>network.segments[i].attributes[name]===value))shared[name]=value;
   return Object.freeze({...shared,id:chain.id,index,points:select(points.domain,chain.points),closed:chain.closed,edges:select(edges.domain,chain.segments)}) as unknown as SurfaceChain<A>;
  }));
  const table=new CurveRows(CURVES3,network,chains,indices=>new SurfaceCurves<A>(selectSurfaceCurveNetwork3(network,indices.flatMap(i=>chains[i].edges.indices)),this));
  whole.set(table,{points,edges});
  return this.#curves=select(table,null) as Selection<SurfaceChain<A>>;
 }
 /** The description behind these curves, when they are not computed yet. */
 get recipe():SurfaceCurveRecipe3|undefined{return isRecipe(this.#source)?this.#source:undefined;}
 get network():SurfaceCurveNetwork3{return this.#build().network;}
 get points():Selection<SurfaceCurvePoint>{return this.#build().points;}
 get edges():Selection<SurfaceCurveEdge<A>>{return this.#build().edges;}
 get sources():SurfaceCurveNetwork3['sources']{return this.network.sources;}
 rebind(target:Material|readonly Material[]):SurfaceCurves<A> {
  const targets=(target instanceof Material)?[target]:target;
  if(!Array.isArray(targets)||targets.length!==this.sources.length||targets.some(t=>!(t instanceof Material)))throw new Error('curve rebind requires one mesh per source');
  const bindings=(targets as readonly Material[]).map((t,i)=>surfaceBinding3(mesh3(t),this.sources[i].binding.placement));
  return new SurfaceCurves<A>(rebindSurfaceCurveNetwork3(this.network,bindings),this);
 }
 /** Repeat prototype-attached marks at every copy of instances.
  * Attachments are re-evaluated on each placed triangle from their retained
  * affine weights; the prototype mesh is not realized. Each edge gains the
  * `instance` column, naming the copy; chains are per copy. Single-source
  * marks only. */
 place(instances:Material):SurfaceCurves<A&{instance:string}> {
  const prototype=prototypeOf(instances);
  if(prototype===undefined)throw new Error('place: expected instances — instanceOnPoints or instanceOnFaces places the prototype these curves are attached to');
  const network=this.network.reference??this.network;
  if(network.sources.length!==1||network.sources[0].binding.placement)throw new Error('place: these curves are attached to more than one surface, or placed already — place marks attached to one unplaced prototype');
  if(network.sources[0].binding.source!==mesh3(prototype))throw new Error('place: these curves are attached to another prototype than these instances place');
  const selected=new Set(this.network.segments.map(s=>s.id));
  const sources=placedOf(instances).map(copy=>({id:copy.id,binding:copy.binding}));
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
