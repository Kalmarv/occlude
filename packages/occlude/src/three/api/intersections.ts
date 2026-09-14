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
export function captureIntersections(a:IntersectionInput,b:IntersectionInput,options:IntersectionOptions={}) {
 const settings=structuredClone(options),maxPairs=settings.maxPairs??Infinity;
 if(!(maxPairs===Infinity||Number.isSafeInteger(maxPairs))||maxPairs<0)throw new Error('intersection pair budget must be a nonnegative integer');
 const count=(value:IntersectionInput)=>value instanceof Mesh?1:value instanceof Instances?value.length:(()=>{throw new Error('intersections require meshes or mesh instances');})();
 const na=count(a),nb=count(b),budget=settings.budget??{};
 if(na*nb>maxPairs)throw new Error('intersections exceed placement pair budget');
 if(na+nb>(budget.graph?.maxSources??Infinity))throw new Error('intersections exceed source budget');
 const size=(value:IntersectionInput,kind:'points'|'triangles')=>value instanceof Mesh?value.surface[kind].length:value.length*value.prototype.surface[kind].length;
 if(size(a,'points')+size(b,'points')>(budget.contacts?.maxInputPoints??Infinity)||size(a,'triangles')+size(b,'triangles')>(budget.contacts?.maxInputTriangles??Infinity))throw new Error('intersection input exceeds triangle/point budget');
 const sources=(value:IntersectionInput):Source[]=>value instanceof Mesh?[{id:value.key??'mesh',binding:surfaceBinding3(value.surface)}]:value.rows.map(row=>({id:row.id,binding:instanceSurfaceBinding3(value,row)}));
 return {left:sources(a),right:sources(b),settings};
}
/** Owned input capture precedes the async boundary; pair outputs are adopted
 * together after all capacities and actual triangle attachments validate. */
export function* intersectionConstructionJob(captured:ReturnType<typeof captureIntersections>,onProgress?:(event:{operation:'intersections';done:number;total?:number})=>void) {
 const {left,right,settings}=captured,budget=settings.budget??{};
 const nodes:SurfaceCurveNetworkInput3['nodes'][number][]=[],segments:SurfaceCurveNetworkInput3['segments'][number][]=[];
 const stats={pairs:0,candidates:0,arrangementCandidates:0,supportCandidates:0,contacts:0,contactPoints:0,exactBytes:0,sourceCacheHits:0,outputNodes:0,outputSegments:0};
 const graphBudget=budget.graph??{},contactsBudget=budget.contacts??{},arrangementBudget=budget.arrangement??{};
 let supportCount=0,graphBytes=0;
 for(let ai=0;ai<left.length;ai++)for(let bi=0;bi<right.length;bi++){
  const a=left[ai],b=right[bi],prefix=identity('intersection-pair',a.id,b.id);
  const result=yield*intersectionsJob3(a.binding,b.binding,{
   contacts:{...contactsBudget,maxCandidates:(contactsBudget.maxCandidates??Infinity)-stats.candidates,maxContacts:(contactsBudget.maxContacts??Infinity)-stats.contacts,maxContactPoints:(contactsBudget.maxContactPoints??Infinity)-stats.contactPoints,maxExactBytes:(contactsBudget.maxExactBytes??Infinity)-stats.exactBytes},
   arrangement:{...arrangementBudget,maxCandidates:(arrangementBudget.maxCandidates??Infinity)-stats.arrangementCandidates,maxSupportCandidates:(arrangementBudget.maxSupportCandidates??Infinity)-stats.supportCandidates},
   graph:{...graphBudget,maxNodes:(graphBudget.maxNodes??Infinity)-nodes.length,maxSegments:(graphBudget.maxSegments??Infinity)-segments.length},
  });
  stats.pairs++;onProgress?.({operation:'intersections',done:stats.pairs,total:left.length*right.length});stats.candidates+=result.stats.candidates;stats.arrangementCandidates+=result.stats.arrangementCandidates;stats.supportCandidates+=result.stats.supportCandidates;
  stats.contacts+=result.stats.contacts;stats.contactPoints+=result.stats.points;stats.exactBytes+=result.stats.exactBytes;stats.sourceCacheHits+=result.stats.sourceCacheHits;
  const network=result.network,used=new Set<number>(),nodeId=(index:number)=>identity('intersection-node',prefix,network.nodes[index].id);
  const source=(index:number)=>index===0?ai:left.length+bi;
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
 const network=yield*surfaceCurveNetworkJob3({sources:[...left,...right].map((s,i)=>({id:`source:${i}`,binding:s.binding})),nodes,segments},graphBudget);
 stats.outputNodes=network.nodes.length;stats.outputSegments=network.segments.length;
 return {curves:new SurfaceCurves<IntersectionAttributes>(network,{key:settings.key,stroke:settings.stroke}),stats:Object.freeze(stats)};
}
/** Synchronous construction for bounded sketches. Use t.intersections in
 * sketchAsync for substantial work that should yield and accept cancellation. */
export function intersections(a:IntersectionInput,b:IntersectionInput,options:IntersectionOptions={}):SurfaceCurves<IntersectionAttributes> {
 return runGeometryJob3(intersectionConstructionJob(captureIntersections(a,b,options))).value.curves;
}
