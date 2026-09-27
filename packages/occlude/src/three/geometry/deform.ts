import { add3,mul3,sub3,finite3,type Vec3 } from '../math.js';
import type { Mesh3 } from './mesh3.js';
export interface DeformOptions3 { readonly iterations:number;readonly relaxation:number;readonly displacements?:readonly Vec3[];readonly pinned?:readonly number[];readonly signal?:AbortSignal }
/** What a deformation reads: the positions and the edge list of a value
 * (`mesh3(m)`, or the same arrays as plain data — what crosses to a worker). */
export type DeformInput3 = Pick<Mesh3,'x'|'y'|'z'|'edges'>;
/** Positions, one flat per axis. */
export interface Positions3 { readonly x:Float64Array;readonly y:Float64Array;readonly z:Float64Array }
export function adjacency3(mesh:DeformInput3):{offsets:Uint32Array<ArrayBuffer>;neighbors:Uint32Array<ArrayBuffer>} {
  const lists=Array.from({length:mesh.x.length},()=>new Set<number>());
  for(let e=0;e+1<mesh.edges.length;e+=2){const a=mesh.edges[e],b=mesh.edges[e+1];lists[a].add(b);lists[b].add(a);}
  const offsets=new Uint32Array(lists.length+1),neighbors:number[]=[];
  lists.forEach((list,i)=>{offsets[i]=neighbors.length;neighbors.push(...[...list].sort((a,b)=>a-b));});offsets[lists.length]=neighbors.length;
  return {offsets,neighbors:Uint32Array.from(neighbors)};
}
export function captureDeform3(mesh:DeformInput3,options:DeformOptions3) {
  const count=mesh.x.length;
  if(!Number.isSafeInteger(options.iterations)||options.iterations<0||options.iterations>10000||!Number.isFinite(options.relaxation)||options.relaxation<0||options.relaxation>1)throw new Error('deformation requires 0–10000 iterations and relaxation within [0,1]');
  if(options.displacements&&options.displacements.length!==count)throw new Error('deformation needs one displacement per point');
  const pinned=new Set(options.pinned??[]);if([...pinned].some(i=>!Number.isInteger(i)||i<0||i>=count))throw new Error('invalid pinned point');
  const displacements=Array.from({length:count},(_,i)=>{const d=options.displacements?.[i]??[0,0,0];finite3(d,'deform');return [...d] as Vec3;});
  // The positions and edges as they are now: a later write of the caller's
  // arrays does not reach a deformation already asked for.
  return {x:Float64Array.from(mesh.x),y:Float64Array.from(mesh.y),z:Float64Array.from(mesh.z),edges:Uint32Array.from(mesh.edges),displacements,pinned,iterations:options.iterations,relaxation:options.relaxation};
}
/** Frozen gather reference: relaxation and authored displacement both read the
 * previous pass. Point pins stay fixed; only original topology edges interact. */
export function deformCpu3(mesh:DeformInput3,options:DeformOptions3):Positions3 {
  options.signal?.throwIfAborted();
  const input=captureDeform3(mesh,options),csr=adjacency3(input);let points=Array.from(input.x,(x,i):Vec3=>[x,input.y[i],input.z[i]]);
  for(let step=0;step<input.iterations;step++){options.signal?.throwIfAborted();points=points.map((p,i)=>{if(input.pinned.has(i))return p;let mean:Vec3=[0,0,0];const count=csr.offsets[i+1]-csr.offsets[i];for(let j=csr.offsets[i];j<csr.offsets[i+1];j++)mean=add3(mean,points[csr.neighbors[j]]);return add3(add3(p,count?mul3(sub3(mul3(mean,1/count),p),input.relaxation):[0,0,0]),input.displacements[i]);});}
  return {x:Float64Array.from(points,p=>p[0]),y:Float64Array.from(points,p=>p[1]),z:Float64Array.from(points,p=>p[2])};
}
