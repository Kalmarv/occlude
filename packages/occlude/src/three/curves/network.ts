import {snapshotSurface3,transformSurface3,transformPosition3} from '../geometry/model.js';
import {rebindTriangle3,captureSurfacePlacement3,type SurfacePlacement3} from '../geometry/location.js';
import type {Surface3,Attributes3,Attribute3} from '../geometry/surface.js';
import {point,encodePoint,decodePoint,pointNumber,canonicalPoint,triangleWeights,ratioNumber,integerWeights,weightedPoint,type H,type EncodedPoint3,type V} from '../geometry/exact.js';
import {sameAttachmentTopology3} from '../geometry/topology.js';
import type {Vec3} from '../math.js';
import {validateSurfaceCurves3,type SurfaceCurves3} from './surface.js';

/** Captured prototype plus optional placement. Labels never grant incidence. */
export interface SurfaceBinding3 {readonly source:Surface3;readonly placement?:SurfacePlacement3}
const bindings=new WeakSet<SurfaceBinding3>();
const bindingCache=new WeakMap<Surface3,{plain?:SurfaceBinding3;placed:WeakMap<SurfacePlacement3,SurfaceBinding3>}>();
const worlds=new WeakMap<SurfaceBinding3,Surface3>();
const triangles=new WeakMap<SurfaceBinding3,Map<number,readonly [H,H,H]>>();
export function surfaceBinding3(source:Surface3,placement?:SurfacePlacement3):SurfaceBinding3 {
  source=snapshotSurface3(source);placement=captureSurfacePlacement3(placement);
  let cache=bindingCache.get(source);if(!cache){cache={placed:new WeakMap()};bindingCache.set(source,cache);}
  const previous=placement?cache.placed.get(placement):cache.plain;if(previous)return previous;
  const value=Object.freeze({source,placement});bindings.add(value);
  if(placement)cache.placed.set(placement,value);else cache.plain=value;return value;
}
export function validateSurfaceBinding3(binding:SurfaceBinding3):void {
  if(!bindings.has(binding))throw new Error('surface curves require an owned surface binding');
}
/** Construction queries can request a world mesh explicitly; ordinary attached
 * marks need only individual transformed support triangles. */
export function bindingWorld3(binding:SurfaceBinding3):Surface3 {
  validateSurfaceBinding3(binding);const found=worlds.get(binding);if(found)return found;
  const world=binding.placement?snapshotSurface3(transformSurface3(binding.source,binding.placement.transform)):binding.source;
  worlds.set(binding,world);return world;
}
function worldPoint(binding:SurfaceBinding3,index:number):Vec3 {
  const position=binding.source.points[index].position,t=binding.placement?.transform;if(!t)return position;
  return transformPosition3(position,t);
}
export function bindingTriangle3(binding:SurfaceBinding3,index:number):readonly [H,H,H] {
  validateSurfaceBinding3(binding);
  if(!Number.isSafeInteger(index)||!binding.source.triangles[index])throw new Error('curve support requires a valid source triangle');
  let cache=triangles.get(binding);if(!cache){cache=new Map();triangles.set(binding,cache);}
  const previous=cache.get(index);if(previous)return previous;
  const value=Object.freeze(binding.source.triangles[index].vertices.map(v=>canonicalPoint(point(worldPoint(binding,v))))) as unknown as readonly [H,H,H];
  cache.set(index,value);return value;
}
export function bindingPoint3(binding:SurfaceBinding3,triangle:number,weights:Vec3):H {
  if(weights.length!==3||weights.some(w=>!Number.isFinite(w)||w<0)||!weights.some(w=>w>0))throw new Error('curve source requires nonnegative affine weights');
  return weightedPoint(bindingTriangle3(binding,triangle),integerWeights(weights));
}
export type SurfaceCurveKind3='section'|'hatch'|'intersection'|'mapped'|'trace'|'isoline';
export interface SurfaceCurveSource3 {readonly id:string;readonly binding:SurfaceBinding3;readonly attributes:Readonly<Attributes3>}
export interface SurfaceCurveNode3 {readonly id:string;readonly position:Vec3;readonly exact:EncodedPoint3;readonly supports:readonly SurfacePointSupport3[];readonly attributes:Readonly<Attributes3>}
export interface SurfacePointSupport3 {readonly source:number;readonly triangle:number;readonly weights:ExactWeights3}
export type ExactWeights3=readonly [string,string,string];
export interface SurfaceCurveSupport3 {
  readonly source:number;readonly triangle:number;
  readonly a:ExactWeights3;readonly b:ExactWeights3;
}
export interface SupportedCurveSegment3 {
  readonly id:string;readonly kind:SurfaceCurveKind3;
  readonly a:number;readonly b:number;
  readonly supports:readonly SurfaceCurveSupport3[];
  readonly chainId:string;readonly range:readonly [number,number];
  /** Floating metric only. Exact node identity never depends on this value. */
  readonly length:number;readonly attributes:Readonly<Attributes3>;
}
/** One canonical graph for single- and multi-source marks. A shared graph node
 * does not merge its incident segments' chart-specific support coordinates. */
export interface SurfaceCurveNetwork3 {
  readonly sources:readonly SurfaceCurveSource3[];
  readonly nodes:readonly SurfaceCurveNode3[];
  readonly segments:readonly SupportedCurveSegment3[];
  /** Filtering retains the full original graph for source phase. */
  readonly reference?:SurfaceCurveNetwork3;
}
export interface SurfaceCurveNetworkInput3 {
  readonly sources:readonly {readonly id:string;readonly binding:SurfaceBinding3;readonly attributes?:Attributes3}[];
  readonly nodes:readonly {readonly id:string;readonly point:H;readonly supports?:readonly {readonly source:number;readonly triangle:number}[];readonly attributes?:Attributes3}[];
  readonly segments:readonly {
    readonly id:string;readonly kind:SurfaceCurveKind3;readonly a:string;readonly b:string;
    readonly supports:readonly {readonly source:number;readonly triangle:number}[];
    readonly chainId?:string;readonly range?:readonly [number,number];readonly attributes?:Attributes3;
  }[];
}
export interface SurfaceCurveBudget3 {readonly maxSources?:number;readonly maxCoordinateBits?:number;readonly maxNodes?:number;readonly maxSegments?:number;readonly maxSupports?:number;readonly maxExactBytes?:number}
const networks=new WeakSet<SurfaceCurveNetwork3>();
const kinds:readonly SurfaceCurveKind3[]=['section','hatch','intersection','mapped','trace','isoline'];
function attrs(input:Attributes3={}):Readonly<Attributes3> {
  const out:Attributes3={};for(const [name,value] of Object.entries(input)){
    if(!name)throw new Error('curve attribute names must be nonempty');
    const valid=(v:Attribute3)=>typeof v==='string'||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v)||Array.isArray(v)&&v.every(Number.isFinite);
    if(!valid(value))throw new Error('curve attributes require finite numeric, string, boolean or vector values');
    Object.defineProperty(out,name,{value:Array.isArray(value)?Object.freeze([...value]):value,enumerable:true});
  }return Object.freeze(out);
}
function identity(value:string,used:Set<string>,domain:string):void {
  if(typeof value!=='string'||!value||used.has(value))throw new Error(`curve ${domain} IDs must be nonempty and unique`);used.add(value);
}
const encodeWeights=(weights:V):ExactWeights3=>Object.freeze(weights.map(n=>n.toString())) as unknown as ExactWeights3;
function metric(a:H,b:H):number {
  const w=a[3]*b[3];return Math.hypot(...[0,1,2].map(k=>ratioNumber([b[k]*a[3]-a[k]*b[3],w])));
}
export function surfaceCurveNetwork3(input:SurfaceCurveNetworkInput3,budget:SurfaceCurveBudget3={}):SurfaceCurveNetwork3 {
  const maxSources=budget.maxSources??100000,maxCoordinateBits=budget.maxCoordinateBits??32768,maxNodes=budget.maxNodes??250000,maxSegments=budget.maxSegments??250000,maxSupports=budget.maxSupports??1000000,maxExactBytes=budget.maxExactBytes??64000000;
  if([maxSources,maxCoordinateBits,maxNodes,maxSegments,maxSupports,maxExactBytes].some(n=>!Number.isSafeInteger(n)||n<0))throw new Error('curve budgets must be nonnegative integers');
  if(input.sources.length>maxSources)throw new Error('surface curve graph exceeds source budget');
  if(input.nodes.length>maxNodes||input.segments.length>maxSegments)throw new Error('surface curve graph exceeds node/segment budget');
  let supports=input.nodes.reduce((n,p)=>n+(p.supports?.length??0),0);if(supports>maxSupports)throw new Error('surface curve graph exceeds support budget');
  for(const segment of input.segments){supports+=3*segment.supports.length;if(supports>maxSupports)throw new Error('surface curve graph exceeds support budget');}
  const sourceIds=new Set<string>(),nodeIds=new Set<string>(),segmentIds=new Set<string>();let bytes=0;
  const account=(values:readonly string[])=>{for(const value of values)bytes+=value.length*2;if(bytes>maxExactBytes)throw new Error('surface curve graph exceeds exact-coordinate byte budget');};
  const sources=Object.freeze(input.sources.map(s=>{identity(s.id,sourceIds,'source');validateSurfaceBinding3(s.binding);return Object.freeze({...s,attributes:attrs(s.attributes)});}));
  const exact:H[]=[],nodeIndex=new Map<string,number>(),nodeSupports:Map<string,SurfacePointSupport3>[]=[];
  const drafts=input.nodes.map((node,index)=>{
    identity(node.id,nodeIds,'node');
    if(node.point.length!==4||node.point.some(n=>typeof n!=='bigint'||n.toString(2).length>maxCoordinateBits))throw new Error('surface curve graph exceeds coordinate bit budget');
    const p=canonicalPoint(node.point),encoded=encodePoint(p);account(encoded);exact.push(p);nodeIndex.set(node.id,index);
    const attached=new Map<string,SurfacePointSupport3>();nodeSupports.push(attached);
    for(const s of node.supports??[]){
      const source=sources[s.source];if(!Number.isSafeInteger(s.source)||!source)throw new Error('point support refers to a missing source');
      const weights=triangleWeights(bindingTriangle3(source.binding,s.triangle),p);if(!weights)throw new Error('contact point is not incident to its declared triangle');
      const encoded=encodeWeights(weights);account(encoded);attached.set(`${s.source}:${s.triangle}`,Object.freeze({...s,weights:encoded}));
    }
    return {id:node.id,position:pointNumber(p),exact:encoded,attributes:attrs(node.attributes)};
  });
  const segments=Object.freeze(input.segments.map(segment=>{
    identity(segment.id,segmentIds,'segment');if(!kinds.includes(segment.kind))throw new Error('unsupported surface curve kind');
    const a=nodeIndex.get(segment.a),b=nodeIndex.get(segment.b);
    if(a===undefined||b===undefined)throw new Error('curve segment refers to a missing graph node');
    if(exact[a].every((n,i)=>n===exact[b][i]))throw new Error('isolated contacts belong to point data, not zero-length curve segments');
    const range=segment.range??[0,1],chainId=segment.chainId??segment.id;
    if(!chainId||range.length!==2||!range.every(Number.isFinite)||range[0]<0||range[1]>1||range[0]>=range[1])throw new Error('curve source ranges must increase within [0,1]');
    if(!segment.supports.length)throw new Error('a surface curve segment requires actual triangle support');
    const seen=new Set<string>();
    const supports=Object.freeze(segment.supports.map(s=>{
      const source=sources[s.source];if(!Number.isSafeInteger(s.source)||!source)throw new Error('curve support refers to a missing source');
      const key=`${s.source}:${s.triangle}`;if(seen.has(key))throw new Error('duplicate curve triangle support');seen.add(key);
      const triangle=bindingTriangle3(source.binding,s.triangle),wa=triangleWeights(triangle,exact[a]),wb=triangleWeights(triangle,exact[b]);
      if(!wa||!wb)throw new Error('curve segment is not incident to its declared supporting triangle');
      const encodedA=encodeWeights(wa),encodedB=encodeWeights(wb);account(encodedA);account(encodedB);
      nodeSupports[a].set(key,Object.freeze({...s,weights:encodedA}));nodeSupports[b].set(key,Object.freeze({...s,weights:encodedB}));
      return Object.freeze({...s,a:encodedA,b:encodedB});
    }));
    const length=metric(exact[a],exact[b]);if(!Number.isFinite(length))throw new Error('curve metric exceeds finite range');
    return Object.freeze({id:segment.id,kind:segment.kind,a,b,supports,chainId,range:Object.freeze([...range]) as readonly [number,number],length,attributes:attrs(segment.attributes)});
  }));
  const ranges=new Map<string,SupportedCurveSegment3[]>();for(const segment of segments){const rows=ranges.get(segment.chainId)??[];rows.push(segment);ranges.set(segment.chainId,rows);}
  for(const rows of ranges.values()){
    rows.sort((a,b)=>a.range[0]-b.range[0]);for(let i=1;i<rows.length;i++)if(rows[i].range[0]<rows[i-1].range[1])throw new Error('a source chain cannot have overlapping parameter intervals');
  }
  const nodes=Object.freeze(drafts.map((node,i)=>{if(!nodeSupports[i].size)throw new Error('isolated surface contacts require declared support');return Object.freeze({...node,supports:Object.freeze([...nodeSupports[i].values()])});}));
  const network=Object.freeze({sources,nodes,segments});networks.add(network);return network;
}
export function validateSurfaceCurveNetwork3(network:SurfaceCurveNetwork3):void {
  if(!networks.has(network))throw new Error('surface curves require an owned validated graph');
}
/** Selection changes neither source parameters nor the complete reference. */
export function selectSurfaceCurveNetwork3(network:SurfaceCurveNetwork3,indices:readonly number[]):SurfaceCurveNetwork3 {
  validateSurfaceCurveNetwork3(network);
  if(indices.some(i=>!Number.isSafeInteger(i)||!network.segments[i]))throw new Error('invalid surface curve selection');
  const wanted=new Set(indices),segments=Object.freeze(network.segments.filter((_,i)=>wanted.has(i)));
  const result=Object.freeze({...network,segments,reference:network.reference??network});networks.add(result);return result;
}
/** Decode only one endpoint when a construction consumer needs exact weights. */
export function curveSupportPoint3(network:SurfaceCurveNetwork3,segment:number,end:'a'|'b',support=0):H {
  validateSurfaceCurveNetwork3(network);const row=network.segments[segment];if(!row?.supports[support])throw new Error('invalid curve support selection');
  return decodePoint(network.nodes[row[end]].exact);
}

/** An explicit binding must describe the same captured source and transform as
 * the rendered object. A label or a matching prototype is not enough. */
export function objectSurfaceBinding3(object:{readonly id:string;readonly surface:Surface3;readonly transform?:SurfacePlacement3['transform'];readonly binding?:SurfaceBinding3}):SurfaceBinding3 {
  if(object.binding){
    validateSurfaceBinding3(object.binding);
    if(object.binding.source!==object.surface)throw new Error('scene binding belongs to a different captured surface');
    const expected=object.binding.placement?.transform;
    if(JSON.stringify(expected)!==JSON.stringify(object.transform))throw new Error('scene transform disagrees with its surface binding');
    return object.binding;
  }
  return surfaceBinding3(object.surface,object.transform?{id:object.id,transform:object.transform}:undefined);
}
/** Compatibility boundary only: all generated marks enter the same graph.
 * Source vertices/weights remain the authority, not evaluated positions. */
export function legacySurfaceCurveNetwork3(curves:SurfaceCurves3,binding:SurfaceBinding3):SurfaceCurveNetwork3 {
  validateSurfaceBinding3(binding);validateSurfaceCurves3(curves,binding.source);
  const nodes=new Map<string,SurfaceCurveNetworkInput3['nodes'][number]>();
  for(const segment of curves.segments)for(const p of [segment.a,segment.b])if(!nodes.has(p.id)){
    const vertices=p.vertices.map(v=>point(worldPoint(binding,v)));
    nodes.set(p.id,{id:p.id,point:weightedPoint(vertices,integerWeights(p.weights))});
  }
  return surfaceCurveNetwork3({sources:[{id:'surface',binding}],nodes:[...nodes.values()],segments:curves.segments.map(s=>({
    id:s.id,kind:s.kind,a:s.a.id,b:s.b.id,supports:s.triangles.map(triangle=>({source:0,triangle})),attributes:s.attributes,
  }))});
}
/** One named graph in a scene; its source bindings identify supporting objects. */
export interface SurfaceCurveObject3 {readonly id:string;readonly network:SurfaceCurveNetwork3;readonly attributes?:Attributes3}

/** Explicitly reevaluate retained affine attachments. Every support at a shared
 * node must still agree exactly; moving an intersection's inputs independently
 * requires regenerating that construction rather than projecting a loose seam. */
export function rebindSurfaceCurveNetwork3(network:SurfaceCurveNetwork3,targets:readonly SurfaceBinding3[],budget:SurfaceCurveBudget3={}):SurfaceCurveNetwork3 {
  validateSurfaceCurveNetwork3(network);
  const reference=network.reference??network;
  if(targets.length!==reference.sources.length)throw new Error('curve rebind requires one target per source');
  targets.forEach((target,i)=>{validateSurfaceBinding3(target);if(!sameAttachmentTopology3(reference.sources[i].binding.source,target.source))throw new Error('surface topology or authoring lineage changed; regenerate curves or use an explicit topology transfer');});
  const correspondence=reference.sources.map((source,i)=>{
    const triangles=new Map<number,ReturnType<typeof rebindTriangle3>>();
    return (triangle:number)=>{let value=triangles.get(triangle);if(!value){value=rebindTriangle3(source.binding.source,triangle,targets[i].source);triangles.set(triangle,value);}return value;};
  });
  const nodes=reference.nodes.map(node=>{
    let point:H|undefined;
    const supports=node.supports.map(s=>{
      const target=correspondence[s.source](s.triangle),weights=target.order.map(i=>BigInt(s.weights[i]));
      const value=weightedPoint(bindingTriangle3(targets[s.source],target.triangle),weights);
      if(point&&!point.every((n,i)=>n===value[i]))throw new Error('curve supports separated during rebind; regenerate the construction');
      point=value;return {source:s.source,triangle:target.triangle};
    });
    return {id:node.id,point:point!,supports,attributes:node.attributes};
  });
  const rebound=surfaceCurveNetwork3({sources:reference.sources.map((s,i)=>({...s,binding:targets[i]})),nodes,segments:reference.segments.map(s=>({
    ...s,a:reference.nodes[s.a].id,b:reference.nodes[s.b].id,supports:s.supports.map(t=>({source:t.source,triangle:correspondence[t.source](t.triangle).triangle})),
  }))},budget);
  if(!network.reference)return rebound;
  const selected=new Set(network.segments.map(s=>s.id));return selectSurfaceCurveNetwork3(rebound,rebound.segments.flatMap((s,i)=>selected.has(s.id)?[i]:[]));
}
