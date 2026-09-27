import {pairKey,type Mesh3} from './mesh3.js';
export interface SurfaceTriangulation3 {
 /** Neighbor across each oriented triangle edge; -1 is an open boundary. */
 readonly neighbors:readonly (readonly [number,number,number])[];
 readonly faceTriangles:readonly (readonly number[])[];
 /** Edge-connected represented components; vertex-only contact stays distinct. */
 readonly components:readonly number[];
 readonly componentCount:number;
}
const cache=new WeakMap<object,WeakMap<object,SurfaceTriangulation3>>();
/** What a triangulation is kept by: the faces (`topology`) and their fixed
 * triangles when every face holds its own (the triangles are then the same
 * whatever the positions), else this reader alone (an ear-clipped face
 * follows its points). */
function keysOf(mesh:Mesh3):readonly [object,object] {
 const held=mesh.value?.stated?.triangles;
 return held!==undefined&&mesh.loops.every((loop,f)=>held[f]!==undefined||loop.length===0)?[mesh.topology,held]:[mesh,mesh];
}
/** Validate fixed polygon triangulation and construct actual triangle adjacency.
 * Generator boundaries let large construction jobs receive worker cancellation.
 * Only a complete validated result is cached. */
export function* triangulationJob3(source:Mesh3):Generator<void,SurfaceTriangulation3>{
 const [faces,held]=keysOf(source),cached=cache.get(faces)?.get(held);if(cached)return cached;
 const triangleCount=source.triangleCount,slot=source.triangles,faceOf=source.triangleFace,faceCount=source.faceCount;
 const faceTriangles=source.loops.map(()=>[] as number[]),neighbors:[number,number,number][]=[];
 for(let i=0;i<triangleCount;i++)neighbors.push([-1,-1,-1]);
 const vertices=source.loops.map(loop=>new Set(loop));
 const edges=new Map<number,{triangle:number;edge:number;a:number;b:number}[]>(),faceEdges=source.loops.map(()=>new Map<number,{a:number;b:number;count:number}>());
 for(let i=0;i<triangleCount;i++){
  const f=faceOf[i],t=[slot[3*i],slot[3*i+1],slot[3*i+2]];
  if(!(f<faceCount)||new Set(t).size!==3||t.some(v=>!(v<source.n)||!vertices[f].has(v)))throw new Error('invalid fixed triangle in surface topology');
  faceTriangles[f].push(i);
  for(let edge=0;edge<3;edge++){
   const a=t[edge],b=t[(edge+1)%3],k=pairKey(a,b),list=edges.get(k)??[];
   if(list.length>=2||list.some(p=>p.a===a))throw new Error('non-manifold or inconsistent render triangle winding');
   list.push({triangle:i,edge,a,b});edges.set(k,list);
   const previous=faceEdges[f].get(k);
   if(previous)previous.count++;else faceEdges[f].set(k,{a,b,count:1});
  }
  if((i&1023)===1023)yield;
 }
 for(let f=0;f<faceCount;f++){
  const loop=source.loops[f],remaining=faceEdges[f];
  if(faceTriangles[f].length!==loop.length-2)throw new Error('fixed triangles do not cover their polygon topology');
  for(let i=0;i<loop.length;i++){
   const a=loop[i],b=loop[(i+1)%loop.length],k=pairKey(a,b),edge=remaining.get(k);
   if(!edge||edge.count!==1||edge.a!==a||edge.b!==b)throw new Error('fixed triangulation does not preserve its polygon boundary');remaining.delete(k);
  }
  if([...remaining.values()].some(e=>e.count!==2))throw new Error('fixed triangulation has an internal boundary');
  if((f&1023)===1023)yield;
 }
 let count=0;for(const list of edges.values()){
  if(list.length===2){const [a,b]=list;neighbors[a.triangle][a.edge]=b.triangle;neighbors[b.triangle][b.edge]=a.triangle;}
  if((++count&1023)===0)yield;
 }
 const components=faceOf.length?Array.from(faceOf,()=>-1):[];let componentCount=0;
 for(let i=0;i<components.length;i++){
  if(components[i]>=0)continue;
  const queue=[i];components[i]=componentCount;
  for(let j=0;j<queue.length;j++){
   for(const neighbor of neighbors[queue[j]])if(neighbor>=0&&components[neighbor]<0){components[neighbor]=componentCount;queue.push(neighbor);}
   if((j&1023)===1023)yield;
  }
  componentCount++;
 }
 const result=Object.freeze({neighbors:Object.freeze(neighbors.map(row=>Object.freeze(row))),faceTriangles:Object.freeze(faceTriangles.map(row=>Object.freeze(row))),components:Object.freeze(components),componentCount});
 let byHeld=cache.get(faces);if(!byHeld){byHeld=new WeakMap();cache.set(faces,byHeld);}byHeld.set(held,result);return result;
}
export function triangulation3(source:Mesh3):SurfaceTriangulation3 {
 const job=triangulationJob3(source);let next=job.next();while(!next.done)next=job.next();return next.value;
}
