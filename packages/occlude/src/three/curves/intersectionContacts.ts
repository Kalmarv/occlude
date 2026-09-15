import {planeScale,pointNumber,type H} from '../geometry/exact.js';
import {WorldIndex3,worldBounds3,type WorldBounds3} from '../geometry/bounds.js';
import {triangulationJob3,type SurfaceTriangulation3} from '../geometry/triangulation.js';
import {runGeometryJob3,runGeometryJobAsync3} from '../geometry/job.js';
import {bindingTriangle3,validateSurfaceBinding3,type SurfaceBinding3} from './network.js';
import {canonicalPlane3,triangleContact3,type TriangleContact3} from './contact.js';
export interface IntersectionContactBudget3 {
 readonly maxInputTriangles?:number;readonly maxInputPoints?:number;
 readonly maxCandidates?:number;readonly maxContacts?:number;readonly maxContactPoints?:number;
 readonly maxExactBytes?:number;readonly maxCoordinateBits?:number;
}
export interface PreparedIntersectionSource3 {
 readonly binding:SurfaceBinding3;readonly topology:SurfaceTriangulation3;
 readonly bounds:readonly WorldBounds3[];readonly planes:readonly H[];readonly index:WorldIndex3;
}
export interface IntersectionContactRecord3 {readonly a:number;readonly b:number;readonly contact:TriangleContact3}
export interface IntersectionContacts3 {
 readonly sources:readonly [PreparedIntersectionSource3,PreparedIntersectionSource3];
 readonly contacts:readonly IntersectionContactRecord3[];
 readonly stats:{readonly inputTriangles:number;readonly candidates:number;readonly contacts:number;readonly points:number;readonly exactBytes:number;readonly sourceCacheHits:number;readonly pointContacts:number;readonly segmentContacts:number;readonly areaContacts:number};
}
const cache=new WeakMap<SurfaceBinding3,PreparedIntersectionSource3>();
function* prepare(binding:SurfaceBinding3):Generator<void,PreparedIntersectionSource3>{
 const previous=cache.get(binding);if(previous)return previous;
 const topology=yield*triangulationJob3(binding.source),bounds:WorldBounds3[]=[],planes:H[]=[];
 for(let i=0;i<binding.source.triangles.length;i++){
  const triangle=bindingTriangle3(binding,i);planes.push(canonicalPlane3(planeScale(...triangle)));
  bounds.push(worldBounds3(triangle.map(pointNumber)));
  if((i&127)===127)yield;
 }
 const index=yield*WorldIndex3.build(bounds);
 const result=Object.freeze({binding,topology,bounds:Object.freeze(bounds),planes:Object.freeze(planes),index});cache.set(binding,result);return result;
}
/** Broad phase streams only overlapping triangle bounds into exact contacts.
 * Budget intermediate contact coordinates before publishing each record. */
export function* intersectionContactsJob3(a:SurfaceBinding3,b:SurfaceBinding3,options:IntersectionContactBudget3={}):Generator<void,IntersectionContacts3>{
 validateSurfaceBinding3(a);validateSurfaceBinding3(b);
 const maxInputTriangles=options.maxInputTriangles??Infinity,maxInputPoints=options.maxInputPoints??Infinity,maxCandidates=options.maxCandidates??Infinity,maxContacts=options.maxContacts??Infinity,maxContactPoints=options.maxContactPoints??Infinity,maxExactBytes=options.maxExactBytes??Infinity,maxCoordinateBits=options.maxCoordinateBits??32768;
 if([maxInputTriangles,maxInputPoints,maxCandidates,maxContacts,maxContactPoints,maxExactBytes,maxCoordinateBits].some(v=>!(v===Infinity||Number.isSafeInteger(v))||v<0))throw new Error('intersection budgets must be nonnegative integers');
 const inputTriangles=a.source.triangles.length+b.source.triangles.length;
 if(inputTriangles>maxInputTriangles||a.source.points.length+b.source.points.length>maxInputPoints)throw new Error('intersection input exceeds triangle/point budget');
 for(const binding of [a,b])if(binding.source.faces.length>binding.source.triangles.length)throw new Error('surface faces require fixed triangulation');
 const sourceCacheHits=Number(cache.has(a))+Number(cache.has(b)),left=yield*prepare(a),right=yield*prepare(b),contacts:IntersectionContactRecord3[]=[];
 let candidates=0,points=0,exactBytes=0,pointContacts=0,segmentContacts=0,areaContacts=0;
 for(let i=0;i<left.bounds.length;i++){
  for(const j of right.index.query(left.bounds[i])){
   if(++candidates>maxCandidates)throw new Error('intersection exceeds candidate budget');
   const contact=triangleContact3(bindingTriangle3(a,i),bindingTriangle3(b,j));
   if(contact){
    if(contacts.length>=maxContacts||points+contact.points.length>maxContactPoints)throw new Error('intersection exceeds contact/point budget');
    for(const p of [...contact.points,...(contact.kind==='area'?[contact.plane]:[])])for(const n of p){if(n.toString(2).length>maxCoordinateBits)throw new Error('intersection exceeds coordinate bit budget');exactBytes+=n.toString().length*2;}
    if(exactBytes>maxExactBytes)throw new Error('intersection exceeds exact-coordinate byte budget');
    points+=contact.points.length;contacts.push(Object.freeze({a:i,b:j,contact}));
    if(contact.kind==='point')pointContacts++;else if(contact.kind==='segment')segmentContacts++;else areaContacts++;
   }
   if((candidates&127)===0)yield;
  }
  if((i&127)===127)yield;
 }
 return Object.freeze({sources:Object.freeze([left,right]) as readonly [PreparedIntersectionSource3,PreparedIntersectionSource3],contacts:Object.freeze(contacts),stats:Object.freeze({inputTriangles,candidates,contacts:contacts.length,points,exactBytes,sourceCacheHits,pointContacts,segmentContacts,areaContacts})});
}
export function intersectionContacts3(a:SurfaceBinding3,b:SurfaceBinding3,options:IntersectionContactBudget3={}){return runGeometryJob3(intersectionContactsJob3(a,b,options));}
export function intersectionContactsAsync3(a:SurfaceBinding3,b:SurfaceBinding3,options:IntersectionContactBudget3={},signal?:AbortSignal){return runGeometryJobAsync3(intersectionContactsJob3(a,b,structuredClone(options)),signal);}
