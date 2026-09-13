import { add3,mul3,sub3,finite3,type Vec3 } from '../math.js';
import { cloneSurface3 } from './model.js';
import type { Surface3 } from './surface.js';
export interface DeformOptions3 { readonly iterations:number;readonly relaxation:number;readonly displacements?:readonly Vec3[];readonly pinned?:readonly number[];readonly signal?:AbortSignal }
export function adjacency3(surface:Surface3):{offsets:Uint32Array<ArrayBuffer>;neighbors:Uint32Array<ArrayBuffer>} {
  const lists=surface.points.map(()=>new Set<number>());
  for(const e of surface.edges){const [a,b]=e.vertices;lists[a].add(b);lists[b].add(a);}
  const offsets=new Uint32Array(lists.length+1),neighbors:number[]=[];
  lists.forEach((list,i)=>{offsets[i]=neighbors.length;neighbors.push(...[...list].sort((a,b)=>a-b));});offsets[lists.length]=neighbors.length;
  return {offsets,neighbors:Uint32Array.from(neighbors)};
}
export function captureDeform3(surface:Surface3,options:DeformOptions3) {
  if(!Number.isSafeInteger(options.iterations)||options.iterations<0||options.iterations>10000||!Number.isFinite(options.relaxation)||options.relaxation<0||options.relaxation>1)throw new Error('deformation requires 0–10000 iterations and relaxation within [0,1]');
  if(options.displacements&&options.displacements.length!==surface.points.length)throw new Error('deformation needs one displacement per point');
  const pinned=new Set(options.pinned??[]);if([...pinned].some(i=>!Number.isInteger(i)||i<0||i>=surface.points.length))throw new Error('invalid pinned point');
  const displacements=surface.points.map((_,i)=>{const d=options.displacements?.[i]??[0,0,0];finite3(d);return [...d] as Vec3;});
  return {surface:cloneSurface3(surface),displacements,pinned,iterations:options.iterations,relaxation:options.relaxation};
}
/** Frozen gather reference: relaxation and authored displacement both read the
 * previous pass. Point pins stay fixed; only original topology edges interact. */
export function deformSurfaceCpu3(surface:Surface3,options:DeformOptions3):Surface3 {
  options.signal?.throwIfAborted();
  const input=captureDeform3(surface,options),csr=adjacency3(input.surface);let points=input.surface.points.map(p=>p.position);
  for(let step=0;step<input.iterations;step++){options.signal?.throwIfAborted();points=points.map((p,i)=>{if(input.pinned.has(i))return p;let mean:Vec3=[0,0,0];const count=csr.offsets[i+1]-csr.offsets[i];for(let j=csr.offsets[i];j<csr.offsets[i+1];j++)mean=add3(mean,points[csr.neighbors[j]]);return add3(add3(p,count?mul3(sub3(mul3(mean,1/count),p),input.relaxation):[0,0,0]),input.displacements[i]);});}
  input.surface.points.forEach((p,i)=>p.position=points[i]);return input.surface;
}
