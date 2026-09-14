import type {Surface3} from './surface.js';
import {topologyRevision3} from './topology.js';
export interface SurfaceTriangulation3 {
 /** Neighbor across each oriented triangle edge; -1 is an open boundary. */
 readonly neighbors:readonly (readonly [number,number,number])[];
 readonly faceTriangles:readonly (readonly number[])[];
 /** Edge-connected represented components; vertex-only contact stays distinct. */
 readonly components:readonly number[];
 readonly componentCount:number;
}
const cache=new WeakMap<object,SurfaceTriangulation3>();
const key=(a:number,b:number)=>a<b?`${a}:${b}`:`${b}:${a}`;
/** Validate fixed polygon triangulation and construct actual triangle adjacency.
 * Generator boundaries let large construction jobs receive worker cancellation.
 * Only a complete validated result is cached, by immutable topology revision. */
export function* triangulationJob3(source:Surface3):Generator<void,SurfaceTriangulation3>{
 const revision=topologyRevision3(source),cached=cache.get(revision);if(cached)return cached;
 const faceTriangles=source.faces.map(()=>[] as number[]),neighbors=source.triangles.map(()=>[-1,-1,-1] as [number,number,number]);
 const vertices=source.faces.map(f=>new Set(f.vertices));
 const edges=new Map<string,{triangle:number;edge:number;a:number;b:number}[]>(),faceEdges=source.faces.map(()=>new Map<string,{a:number;b:number;count:number}>());
 for(let i=0;i<source.triangles.length;i++){
  const t=source.triangles[i],face=source.faces[t.face];
  if(!Number.isSafeInteger(t.face)||!face||t.vertices.length!==3||new Set(t.vertices).size!==3||t.vertices.some(v=>!Number.isSafeInteger(v)||!source.points[v]||!vertices[t.face].has(v)))throw new Error('invalid fixed triangle in surface topology');
  faceTriangles[t.face].push(i);
  for(let edge=0;edge<3;edge++){
   const a=t.vertices[edge],b=t.vertices[(edge+1)%3],k=key(a,b),list=edges.get(k)??[];
   if(list.length>=2||list.some(p=>p.a===a))throw new Error('non-manifold or inconsistent render triangle winding');
   list.push({triangle:i,edge,a,b});edges.set(k,list);
   const previous=faceEdges[t.face].get(k);
   if(previous)previous.count++;else faceEdges[t.face].set(k,{a,b,count:1});
  }
  if((i&1023)===1023)yield;
 }
 for(let f=0;f<source.faces.length;f++){
  const face=source.faces[f],remaining=faceEdges[f];
  if(faceTriangles[f].length!==face.vertices.length-2)throw new Error('fixed triangles do not cover their polygon topology');
  for(let i=0;i<face.vertices.length;i++){
   const a=face.vertices[i],b=face.vertices[(i+1)%face.vertices.length],k=key(a,b),edge=remaining.get(k);
   if(!edge||edge.count!==1||edge.a!==a||edge.b!==b)throw new Error('fixed triangulation does not preserve its polygon boundary');remaining.delete(k);
  }
  if([...remaining.values()].some(e=>e.count!==2))throw new Error('fixed triangulation has an internal boundary');
  if((f&1023)===1023)yield;
 }
 let count=0;for(const list of edges.values()){
  if(list.length===2){const [a,b]=list;neighbors[a.triangle][a.edge]=b.triangle;neighbors[b.triangle][b.edge]=a.triangle;}
  if((++count&1023)===0)yield;
 }
 const components=source.triangles.map(()=>-1);let componentCount=0;
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
 cache.set(revision,result);return result;
}
export function triangulation3(source:Surface3):SurfaceTriangulation3 {
 const job=triangulationJob3(source);let next=job.next();while(!next.done)next=job.next();return next.value;
}
