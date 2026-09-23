import {snapshotSurface3,transformSurface3,transformPosition3} from '../geometry/model.js';
import {rebindTriangle3,captureSurfacePlacement3,type SurfacePlacement3} from '../geometry/location.js';
import type {SurfaceCurvePoint3} from './surface.js';
import type {Surface3,Attributes3,Attribute3} from '../geometry/surface.js';
import {point,encodePoint,decodePoint,pointNumber,canonicalPoint,triangleWeights,verifiedTriangleWeights,ratioNumber,integerWeights,weightedPoint,type H,type EncodedPoint3,type V} from '../geometry/exact.js';
import {sameAttachmentTopology3} from '../geometry/topology.js';
import {finite3,type Vec3} from '../math.js';
import {validateSurfaceCurves3,type SurfaceCurves3} from './surface.js';

/** Captured prototype plus optional placement. Labels never grant incidence. */
export interface SurfaceBinding3 {readonly source:Surface3;readonly placement?:SurfacePlacement3}
const bindings=new WeakSet<SurfaceBinding3>();
const bindingCache=new WeakMap<Surface3,{plain?:SurfaceBinding3;placed:WeakMap<SurfacePlacement3,SurfaceBinding3>}>();
const worlds=new WeakMap<SurfaceBinding3,Surface3>();
const triangles=new WeakMap<SurfaceBinding3,Map<number,readonly [H,H,H]>>();
const bindingVertices=new WeakMap<SurfaceBinding3,Map<number,H>>();
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
const positions=new WeakMap<SurfaceBinding3,Map<number,Vec3>>();
export function bindingPosition3(binding:SurfaceBinding3,index:number):Vec3 {
  validateSurfaceBinding3(binding);
  if(!Number.isSafeInteger(index)||!binding.source.points[index])throw new Error('invalid surface binding point');
  const position=binding.source.points[index].position,t=binding.placement?.transform;if(!t)return position;
  let cache=positions.get(binding);if(!cache){cache=new Map();positions.set(binding,cache);}
  const previous=cache.get(index);if(previous)return previous;
  const value=transformPosition3(position,t);finite3(value);const result=Object.freeze(value);cache.set(index,result);return result;
}
export function bindingTriangle3(binding:SurfaceBinding3,index:number):readonly [H,H,H] {
  validateSurfaceBinding3(binding);
  if(!Number.isSafeInteger(index)||!binding.source.triangles[index])throw new Error('curve support requires a valid source triangle');
  let cache=triangles.get(binding);if(!cache){cache=new Map();triangles.set(binding,cache);}
  const previous=cache.get(index);if(previous)return previous;
  // A vertex belongs to about six triangles; its exact point is built once.
  let vertices=bindingVertices.get(binding);if(!vertices){vertices=new Map();bindingVertices.set(binding,vertices);}
  const vertex=(v:number):H=>{let q=vertices!.get(v);if(!q){q=canonicalPoint(point(bindingPosition3(binding,v)));vertices!.set(v,q);}return q;};
  const value=Object.freeze(binding.source.triangles[index].vertices.map(vertex)) as unknown as readonly [H,H,H];
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
  readonly chainId:string;
  /** Rounded projection of the exact source interval, for phase. Equal
   * endpoints mean the exact interval is narrower than binary64 resolution;
   * consumers scale by the width and never divide by it. */
  readonly range:readonly [number,number];
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
    /** `a`/`b`: the endpoints' integer barycentric weights on this triangle when the
     * producer built the points from them; verified, and spared the exact recomputation. */
    readonly supports:readonly {readonly source:number;readonly triangle:number;readonly a?:readonly bigint[];readonly b?:readonly bigint[]}[];
    readonly chainId?:string;readonly range?:readonly [number,number];readonly attributes?:Attributes3;
  }[];
}
export interface SurfaceCurveBudget3 {readonly maxSources?:number;readonly maxCoordinateBits?:number;readonly maxNodes?:number;readonly maxSegments?:number;readonly maxSupports?:number;readonly maxExactBytes?:number}
const networks=new WeakSet<SurfaceCurveNetwork3>();
const curveLineages=new WeakMap<SurfaceCurveNetwork3,object>();
export function sameSurfaceCurveLineage3(a:SurfaceCurveNetwork3,b:SurfaceCurveNetwork3):boolean {
  validateSurfaceCurveNetwork3(a);validateSurfaceCurveNetwork3(b);return curveLineages.get(a)===curveLineages.get(b);
}
const kinds:readonly SurfaceCurveKind3[]=['section','hatch','intersection','mapped','trace','isoline'];
function attrs(input:Attributes3={}):Readonly<Attributes3> {
  const out:Attributes3={};for(const [name,value] of Object.entries(input)){
    if(!name)throw new Error('curve attribute names must be nonempty');
    const valid=(v:Attribute3)=>typeof v==='string'||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v)||Array.isArray(v)&&v.every(Number.isFinite);
    if(!valid(value))throw new Error('curve attributes require finite numeric, string, boolean or vector values');
    out[name]=Array.isArray(value)?Object.freeze([...value]) as unknown as Attribute3:value;
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
  const job=surfaceCurveNetworkJob3(input,budget);let next=job.next();while(!next.done)next=job.next();return next.value;
}
/** Shared validator with checkpoints for generated graphs. Async callers own
 * their input draft until this job completes; only a complete graph is owned. */
export function* surfaceCurveNetworkJob3(input:SurfaceCurveNetworkInput3,budget:SurfaceCurveBudget3={}):Generator<void,SurfaceCurveNetwork3> {
  // Capacities are unlimited unless the caller sets one; the coordinate bit
  // guard stays because exact arithmetic must not grow without bound.
  const maxSources=budget.maxSources??Infinity,maxCoordinateBits=budget.maxCoordinateBits??32768,maxNodes=budget.maxNodes??Infinity,maxSegments=budget.maxSegments??Infinity,maxSupports=budget.maxSupports??Infinity,maxExactBytes=budget.maxExactBytes??Infinity;
  if([maxSources,maxCoordinateBits,maxNodes,maxSegments,maxSupports,maxExactBytes].some(n=>!(n===Infinity||Number.isSafeInteger(n))||n<0))throw new Error('curve budgets must be nonnegative integers or Infinity');
  if(input.sources.length>maxSources)throw new Error('surface curve graph exceeds source budget');
  if(input.nodes.length>maxNodes||input.segments.length>maxSegments)throw new Error('surface curve graph exceeds node/segment budget');
  let supports=0,work=0;
  for(const node of input.nodes){supports+=node.supports?.length??0;if(supports>maxSupports)throw new Error('surface curve graph exceeds support budget');if((++work&127)===0)yield;}
  for(const segment of input.segments){supports+=3*segment.supports.length;if(supports>maxSupports)throw new Error('surface curve graph exceeds support budget');if((++work&127)===0)yield;}
  const sourceIds=new Set<string>(),nodeIds=new Set<string>(),segmentIds=new Set<string>();let bytes=0;
  const account=(values:readonly string[])=>{for(const value of values)bytes+=value.length*2;if(bytes>maxExactBytes)throw new Error('surface curve graph exceeds exact-coordinate byte budget');};
  const sourceRows:SurfaceCurveSource3[]=[];
  for(const s of input.sources){identity(s.id,sourceIds,'source');validateSurfaceBinding3(s.binding);sourceRows.push(Object.freeze({...s,attributes:attrs(s.attributes)}));if((++work&127)===0)yield;}
  const sources=Object.freeze(sourceRows);
  const exact:H[]=[],nodeIndex=new Map<string,number>(),nodeSupports:Map<string,SurfacePointSupport3>[]=[];
  const drafts:Omit<SurfaceCurveNode3,'supports'>[]=[];
  for(let index=0;index<input.nodes.length;index++){
    const node=input.nodes[index];
    identity(node.id,nodeIds,'node');
    if(node.point.length!==4||node.point.some(n=>typeof n!=='bigint'||n.toString(2).length>maxCoordinateBits))throw new Error('surface curve graph exceeds coordinate bit budget');
    const p=canonicalPoint(node.point),encoded=encodePoint(p);account(encoded);exact.push(p);nodeIndex.set(node.id,index);
    const attached=new Map<string,SurfacePointSupport3>();nodeSupports.push(attached);
    for(const s of node.supports??[]){
      const source=sources[s.source];if(!Number.isSafeInteger(s.source)||!source)throw new Error('point support refers to a missing source');
      const weights=triangleWeights(bindingTriangle3(source.binding,s.triangle),p);if(!weights)throw new Error('contact point is not incident to its declared triangle');
      const encoded=encodeWeights(weights);account(encoded);attached.set(`${s.source}:${s.triangle}`,Object.freeze({...s,weights:encoded}));
      if((++work&127)===0)yield;
    }
    drafts.push({id:node.id,position:pointNumber(p),exact:encoded,attributes:attrs(node.attributes)});
    if((++work&127)===0)yield;
  }
  const segmentRows:SupportedCurveSegment3[]=[];
  const aliases=new Map<number,number[]>();
  for(const segment of input.segments){
    identity(segment.id,segmentIds,'segment');if(!kinds.includes(segment.kind))throw new Error('unsupported surface curve kind');
    const a=nodeIndex.get(segment.a),b=nodeIndex.get(segment.b);
    if(a===undefined||b===undefined)throw new Error('curve segment refers to a missing graph node');
    if(exact[a].every((n,i)=>n===exact[b][i])){
      // A traced chain (hatch, streamline) can land two consecutive nodes on
      // one exact point without their float positions agreeing: the exact
      // weights come from the projected coordinates, and two positions an
      // ulp apart along the dropped axis are one point here. That is a
      // zero-length piece of a chain, not a contact: it draws nothing and is
      // dropped. Every other kind means it — an isolated contact is point
      // data — and is refused.
      if(segment.kind==='trace'){
        // The two nodes are one point: every later segment that names the
        // second now reaches the first, and the second shares the first's
        // supports so it is not left an isolated contact without support.
        nodeIndex.set(segment.b,a);nodeSupports[b]=nodeSupports[a];(aliases.get(a)??aliases.set(a,[]).get(a)!).push(b);
        continue;
      }
      throw new Error(`isolated contacts belong to point data, not zero-length curve segments (segment ${segment.id} kind ${segment.kind}: nodes ${segment.a} and ${segment.b} are one exact point ${JSON.stringify(drafts[a].position)}; supports ${JSON.stringify(segment.supports.map(s=>[s.source,s.triangle]))}; range ${JSON.stringify(segment.range??null)})`);
    }
    const range=segment.range??[0,1],chainId=segment.chainId??segment.id;
    if(!chainId||range.length!==2||!range.every(Number.isFinite)||range[0]<0||range[1]>1||range[0]>range[1])throw new Error('curve source ranges must not decrease within [0,1]');
    if(!segment.supports.length)throw new Error('a surface curve segment requires actual triangle support');
    const seen=new Set<string>();
    const supportRows:SurfaceCurveSupport3[]=[];
    for(const s of segment.supports){
      const source=sources[s.source];if(!Number.isSafeInteger(s.source)||!source)throw new Error('curve support refers to a missing source');
      const key=`${s.source}:${s.triangle}`;if(seen.has(key))throw new Error('duplicate curve triangle support');seen.add(key);
      const triangle=bindingTriangle3(source.binding,s.triangle);
      // A node's weights on a triangle are one value: reuse them from the
      // previous segment; take the producer's when given; compute exactly last.
      const known=(node:number,given:readonly bigint[]|undefined):ExactWeights3|null=>{
        const have=nodeSupports[node].get(key);if(have)return have.weights;
        let w=(given&&verifiedTriangleWeights(triangle,given,exact[node]))||triangleWeights(triangle,exact[node]);
        // A traced node (hatch, streamline) names itself by barycentric
        // weights on the triangle it was walked in; its float position is a
        // rounding of that point and can fall an ulp outside the triangle,
        // which the exact projection rightly refuses. When the producer gave
        // the weights and nothing else has yet pinned this node, the node IS
        // the point the weights name: take that exact point as its position.
        // A node another support already fixed keeps its point.
        if(!w&&given&&segment.kind==='trace'&&nodeSupports[node].size===0){
          const p=canonicalPoint(weightedPoint(triangle,given)),encodedPoint=encodePoint(p);account(encodedPoint);
          for(const j of [node,...(aliases.get(node)??[])]){exact[j]=p;drafts[j]={...drafts[j],position:pointNumber(p),exact:encodedPoint};}
          w=verifiedTriangleWeights(triangle,given,p)||triangleWeights(triangle,p);
        }
        if(!w)return null;const encoded=encodeWeights(w);account(encoded);return encoded;
      };
      const encodedA=known(a,s.a),encodedB=known(b,s.b);
      if(!encodedA||!encodedB)throw new Error(`curve segment is not incident to its declared supporting triangle (segment ${segment.id} kind ${segment.kind}; node ${encodedA?segment.b:segment.a} at ${JSON.stringify(drafts[encodedA?b:a].position)} is off triangle ${s.triangle} of source ${s.source}; producer weights ${JSON.stringify((encodedA?s.b:s.a)?.map(String)??null)})`);
      const {a:_a,b:_b,...support}=s;
      nodeSupports[a].set(key,Object.freeze({...support,weights:encodedA}));nodeSupports[b].set(key,Object.freeze({...support,weights:encodedB}));
      supportRows.push(Object.freeze({...support,a:encodedA,b:encodedB}));
      if((++work&127)===0)yield;
    }
    const supports=Object.freeze(supportRows);
    const length=metric(exact[a],exact[b]);if(!Number.isFinite(length))throw new Error('curve metric exceeds finite range');
    segmentRows.push(Object.freeze({id:segment.id,kind:segment.kind,a,b,supports,chainId,range:Object.freeze([...range]) as readonly [number,number],length,attributes:attrs(segment.attributes)}));
    if((++work&127)===0)yield;
  }
  const segments=Object.freeze(segmentRows);
  const ranges=new Map<string,SupportedCurveSegment3[]>();for(const segment of segments){const rows=ranges.get(segment.chainId)??[];rows.push(segment);ranges.set(segment.chainId,rows);if((++work&127)===0)yield;}
  for(const rows of ranges.values()){
    // Equal starts order by end, so a zero-width interval sits before the
    // interval that begins where it lies.
    rows.sort((a,b)=>a.range[0]-b.range[0]||a.range[1]-b.range[1]);yield;
    for(let i=1;i<rows.length;i++){if(rows[i].range[0]<rows[i-1].range[1])throw new Error('a source chain cannot have overlapping parameter intervals');if((++work&127)===0)yield;}
  }
  const nodeRows:SurfaceCurveNode3[]=[];
  for(let i=0;i<drafts.length;i++){
    if(!nodeSupports[i].size)throw new Error(`isolated surface contacts require declared support (node ${drafts[i].id} at ${JSON.stringify(drafts[i].position)})`);
    nodeRows.push(Object.freeze({...drafts[i],supports:Object.freeze([...nodeSupports[i].values()])}));if((++work&127)===0)yield;
  }
  const nodes=Object.freeze(nodeRows);
  const network=Object.freeze({sources,nodes,segments});networks.add(network);curveLineages.set(network,{});return network;
}
export function validateSurfaceCurveNetwork3(network:SurfaceCurveNetwork3):void {
  if(!networks.has(network))throw new Error('surface curves require an owned validated graph');
}
/** Selection changes neither source parameters nor the complete reference. */
export function selectSurfaceCurveNetwork3(network:SurfaceCurveNetwork3,indices:readonly number[]):SurfaceCurveNetwork3 {
  validateSurfaceCurveNetwork3(network);
  if(indices.some(i=>!Number.isSafeInteger(i)||!network.segments[i]))throw new Error('invalid surface curve selection');
  const wanted=new Set(indices),segments=Object.freeze(network.segments.filter((_,i)=>wanted.has(i)));
  const result=Object.freeze({...network,segments,reference:network.reference??network});networks.add(result);curveLineages.set(result,curveLineages.get(network)!);return result;
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
  // Exact vertex points once per vertex, not once per node that touches it.
  const exactVertex=new Map<number,H>();
  const vertexPoint=(v:number):H=>{let q=exactVertex.get(v);if(!q){q=point(bindingPosition3(binding,v));exactVertex.set(v,q);}return q;};
  const integer=new Map<SurfaceCurvePoint3,readonly bigint[]>();
  const integerOf=(p:SurfaceCurvePoint3):readonly bigint[]=>{let w=integer.get(p);if(!w){w=integerWeights(p.weights);integer.set(p,w);}return w;};
  for(const segment of curves.segments)for(const p of [segment.a,segment.b])if(!nodes.has(p.id)){
    nodes.set(p.id,{id:p.id,point:weightedPoint(p.vertices.map(vertexPoint),integerOf(p))});
  }
  // A piece's own weights re-expressed in its triangle's vertex order, so the
  // intake verifies them instead of recomputing them exactly.
  const weightsOn=(p:SurfaceCurvePoint3,triangle:number):readonly bigint[]|undefined=>{
    const tri=binding.source.triangles[triangle]?.vertices;if(!tri)return undefined;
    const w=integerOf(p),out=[0n,0n,0n];
    for(let m=0;m<3;m++){if(w[m]===0n)continue;const k=tri.indexOf(p.vertices[m]);if(k<0)return undefined;out[k]+=w[m];}
    return out;
  };
  return surfaceCurveNetwork3({sources:[{id:'surface',binding}],nodes:[...nodes.values()],segments:curves.segments.map(s=>({
    id:s.id,kind:s.kind,a:s.a.id,b:s.b.id,supports:s.triangles.map(triangle=>({source:0,triangle,a:weightsOn(s.a,triangle),b:weightsOn(s.b,triangle)})),attributes:s.attributes,...(s.chainId!==undefined?{chainId:s.chainId}:{}),...(s.range!==undefined?{range:s.range}:{}),
  }))});
}
/** What a camera-aware recipe may read about the view that is resolving it.
 * Today that is the certificate pre-pass's verdicts: one byte per triangle of
 * a source binding's surface, 1 where the closed triangle — its edges and
 * vertices included — is proved hidden before any curve is built. `undefined`
 * means that binding certifies nothing, which is the pairwise answer.
 *
 * A recipe handed no view resolves eagerly and completely: the artist's value
 * is whole, and only a view's own classification is lazy. */
export interface SurfaceCurveView3 {hiddenTriangles(binding:SurfaceBinding3):Uint8Array|undefined}
/** One named graph in a scene; its source bindings identify supporting objects. */
/** Curves described, not yet computed: a view resolves them once it knows
 * which of `bindings` it draws, so seams among culled objects are never made. */
export interface SurfaceCurveRecipe3 {readonly bindings:readonly SurfaceBinding3[];resolve(keep?:(binding:SurfaceBinding3)=>boolean,view?:SurfaceCurveView3):SurfaceCurveNetwork3}
/** Curves with their network in hand, as the snapshot holds them. */
export interface SurfaceCurveGraph3 {readonly id:string;readonly network:SurfaceCurveNetwork3;readonly attributes?:Attributes3}
export type SurfaceCurveObject3 = {readonly id:string;readonly attributes?:Attributes3}&({readonly network:SurfaceCurveNetwork3;readonly recipe?:undefined}|{readonly recipe:SurfaceCurveRecipe3;readonly network?:undefined});

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
  curveLineages.set(rebound,curveLineages.get(reference)!);
  if(!network.reference)return rebound;
  const selected=new Set(network.segments.map(s=>s.id));return selectSurfaceCurveNetwork3(rebound,rebound.segments.flatMap((s,i)=>selected.has(s.id)?[i]:[]));
}
