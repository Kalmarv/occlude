import {Mesh} from './mesh.js';
import {Instances,instanceSurfaceBinding3} from './instances.js';
import {SurfaceCurves,type SurfaceCurveOptions} from './supported.js';
import {identity} from './identity.js';
import {decodePoint} from '../geometry/exact.js';
import {runGeometryJob3} from '../geometry/job.js';
import {intersectionsJob3,type IntersectionBudget3} from '../curves/intersections.js';
import {surfaceBinding3,surfaceCurveNetworkJob3,type SurfaceBinding3,type SurfaceCurveNetworkInput3} from '../curves/network.js';
import type {IntersectionClass3} from '../curves/intersectionAtoms.js';
export type IntersectionAttributes={contact:IntersectionClass3};

export type IntersectionInput=Mesh<any,any,any,any>|Instances<any,any,any,any,any,any,any>;
export interface IntersectionOptions extends SurfaceCurveOptions {
 readonly maxPairs?:number;
 /** Optional advanced capacity controls; defaults cover ordinary sketches. */
 readonly budget?:IntersectionBudget3;
}
interface Source {id:string;binding:SurfaceBinding3}
/** `(a, b)` pairs every source of a with every source of b; `([...objects])`
 * pairs every two different objects of the list. Sources within one
 * Instances value never pair with each other in either form. */
export type IntersectionArguments=[a:IntersectionInput,b:IntersectionInput,options?:IntersectionOptions]|[objects:readonly IntersectionInput[],options?:IntersectionOptions];
export function captureIntersections(...args:IntersectionArguments) {
 const [inputs,groups,options]=Array.isArray(args[0])
  // Fewer than two objects cross nowhere: no pairs, an empty curve set.
  ?(()=>{const list=args[0] as readonly IntersectionInput[];return [list,list.map((_,i)=>i),(args[1] as IntersectionOptions|undefined)??{}] as const;})()
  :[[args[0] as IntersectionInput,args[1] as IntersectionInput],[0,1],(args[2] as IntersectionOptions|undefined)??{}] as const;
 if(!options||typeof options!=='object'||Array.isArray(options))throw new Error('intersection options must be an object');
 const settings=structuredClone(options),maxPairs=settings.maxPairs??Infinity;
 if(!(maxPairs===Infinity||Number.isSafeInteger(maxPairs))||maxPairs<0)throw new Error('intersection pair budget must be a nonnegative integer');
 const count=(value:IntersectionInput)=>value instanceof Mesh?1:value instanceof Instances?value.length:(()=>{throw new Error('intersections require meshes or mesh instances');})();
 inputs.forEach(count);const budget=settings.budget??{};
 const size=(value:IntersectionInput,kind:'points'|'triangles')=>value instanceof Mesh?value.surface[kind].length:value.length*value.prototype.surface[kind].length;
 const total=(kind:'points'|'triangles')=>inputs.reduce((n,v)=>n+size(v,kind),0);
 const sources:Source[]=[],owner:number[]=[];
 inputs.forEach((value,i)=>{for(const s of value instanceof Mesh?[{id:value.key??'mesh',binding:surfaceBinding3(value.surface)}]:value.rows.map(row=>({id:row.id,binding:instanceSurfaceBinding3(value,row)}))){sources.push(s);owner.push(groups[i]);}});
 // Pair sources whose objects differ: left × right for two arguments, every
 // unordered pair of distinct list members for a list.
 const pairs:[number,number][]=[];
 if(groups.length===2)for(let i=0;i<sources.length;i++)for(let j=0;j<sources.length;j++){if(owner[i]===0&&owner[j]===1)pairs.push([i,j]);}
 else for(let i=0;i<sources.length;i++)for(let j=i+1;j<sources.length;j++){if(owner[i]!==owner[j])pairs.push([i,j]);}
 if(pairs.length>maxPairs)throw new Error('intersections exceed placement pair budget');
 if(sources.length>(budget.graph?.maxSources??Infinity))throw new Error('intersections exceed source budget');
 if(total('points')>(budget.contacts?.maxInputPoints??Infinity)||total('triangles')>(budget.contacts?.maxInputTriangles??Infinity))throw new Error('intersection input exceeds triangle/point budget');
 return {sources,pairs,settings};
}
/** Owned input capture precedes the async boundary; pair outputs are adopted
 * together after all capacities and actual triangle attachments validate. */
export function* intersectionConstructionJob(captured:ReturnType<typeof captureIntersections>,onProgress?:(event:{operation:'intersections';done:number;total?:number})=>void) {
 const {sources,pairs,settings}=captured,budget=settings.budget??{};
 const nodes:SurfaceCurveNetworkInput3['nodes'][number][]=[],segments:SurfaceCurveNetworkInput3['segments'][number][]=[];
 const stats={pairs:0,candidates:0,arrangementCandidates:0,supportCandidates:0,contacts:0,contactPoints:0,exactBytes:0,sourceCacheHits:0,outputNodes:0,outputSegments:0};
 const graphBudget=budget.graph??{},contactsBudget=budget.contacts??{},arrangementBudget=budget.arrangement??{};
 let supportCount=0,graphBytes=0;
 for(const [ai,bi] of pairs){
  // Prefix by source position: ids repeat across unkeyed meshes ('mesh') and
  // across list members, and node identity must be unique per pair.
  const a=sources[ai],b=sources[bi],prefix=identity('intersection-pair',`${ai}:${a.id}`,`${bi}:${b.id}`);
  const result=yield*intersectionsJob3(a.binding,b.binding,{
   contacts:{...contactsBudget,maxCandidates:(contactsBudget.maxCandidates??Infinity)-stats.candidates,maxContacts:(contactsBudget.maxContacts??Infinity)-stats.contacts,maxContactPoints:(contactsBudget.maxContactPoints??Infinity)-stats.contactPoints,maxExactBytes:(contactsBudget.maxExactBytes??Infinity)-stats.exactBytes},
   arrangement:{...arrangementBudget,maxCandidates:(arrangementBudget.maxCandidates??Infinity)-stats.arrangementCandidates,maxSupportCandidates:(arrangementBudget.maxSupportCandidates??Infinity)-stats.supportCandidates},
   graph:{...graphBudget,maxNodes:(graphBudget.maxNodes??Infinity)-nodes.length,maxSegments:(graphBudget.maxSegments??Infinity)-segments.length},
  });
  stats.pairs++;onProgress?.({operation:'intersections',done:stats.pairs,total:pairs.length});stats.candidates+=result.stats.candidates;stats.arrangementCandidates+=result.stats.arrangementCandidates;stats.supportCandidates+=result.stats.supportCandidates;
  stats.contacts+=result.stats.contacts;stats.contactPoints+=result.stats.points;stats.exactBytes+=result.stats.exactBytes;stats.sourceCacheHits+=result.stats.sourceCacheHits;
  const network=result.network,used=new Set<number>(),nodeId=(index:number)=>identity('intersection-node',prefix,network.nodes[index].id);
  const source=(index:number)=>index===0?ai:bi;
  for(let i=0;i<network.segments.length;i++){
   const row=network.segments[i];used.add(row.a);used.add(row.b);supportCount+=3*row.supports.length;
   if(supportCount>(graphBudget.maxSupports??Infinity))throw new Error('surface curve graph exceeds support budget');
   segments.push({...row,id:identity('intersection-edge',prefix,row.id),a:nodeId(row.a),b:nodeId(row.b),chainId:identity('intersection-chain',prefix,row.chainId),supports:row.supports.map(s=>({source:source(s.source),triangle:s.triangle}))});
   if((i&127)===127)yield;
  }
  for(let i=0;i<network.nodes.length;i++){
   const row=network.nodes[i],supports=used.has(i)?undefined:row.supports.map(s=>({source:source(s.source),triangle:s.triangle}));
   supportCount+=supports?.length??0;if(supportCount>(graphBudget.maxSupports??Infinity))throw new Error('surface curve graph exceeds support budget');
   graphBytes+=row.exact.reduce((n,s)=>n+s.length*2,0)+row.supports.reduce((n,s)=>n+s.weights.reduce((n,v)=>n+v.length*2,0),0);
   if(graphBytes>(graphBudget.maxExactBytes??Infinity))throw new Error('surface curve graph exceeds exact-coordinate byte budget');
   nodes.push({id:nodeId(i),point:decodePoint(row.exact),supports,attributes:row.attributes});if((i&127)===127)yield;
  }
  yield;
 }
 const network=yield*surfaceCurveNetworkJob3({sources:sources.map((s,i)=>({id:`source:${i}`,binding:s.binding})),nodes,segments},graphBudget);
 stats.outputNodes=network.nodes.length;stats.outputSegments=network.segments.length;
 return {curves:new SurfaceCurves<IntersectionAttributes>(network,{key:settings.key,stroke:settings.stroke}),stats:Object.freeze(stats)};
}
/** The curves where meshes cross: two meshes, or every pair of a list. */
export function intersections(a:IntersectionInput,b:IntersectionInput,options?:IntersectionOptions):SurfaceCurves<IntersectionAttributes>;
export function intersections(objects:readonly IntersectionInput[],options?:IntersectionOptions):SurfaceCurves<IntersectionAttributes>;
export function intersections(...args:IntersectionArguments):SurfaceCurves<IntersectionAttributes> {
 return runGeometryJob3(intersectionConstructionJob(captureIntersections(...args))).value.curves;
}
