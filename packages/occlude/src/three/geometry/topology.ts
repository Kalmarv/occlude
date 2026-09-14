import type {Surface3} from './surface.js';

/** Positions and attributes do not participate in topology identity. Tokens and
 * adjacency are weakly owned: retaining a revision retains its own topology,
 * without an unbounded global string-keyed cache. */
interface TopologyRevision {readonly signature:string}
export interface SurfaceTopology3 {
  readonly pointEdges:readonly (readonly number[])[];
  readonly pointFaces:readonly (readonly number[])[];
  readonly pointNeighbors:readonly (readonly number[])[];
  readonly faceEdges:readonly (readonly number[])[];
  readonly faceNeighbors:readonly (readonly number[])[];
}
const immutable=new WeakSet<Surface3>();
export function sealTopology3(surface:Surface3):void{revision(surface);immutable.add(surface);}
const revisions=new WeakMap<Surface3,TopologyRevision>();
const adjacency=new WeakMap<TopologyRevision,SurfaceTopology3>();
function signature(surface:Surface3):string {
  return JSON.stringify([surface.points.map(p=>p.id),surface.faces.map(f=>[f.id,f.vertices]),surface.edges.map(e=>[e.id,e.vertices,e.faces]),surface.triangles.map(t=>[t.face,t.vertices])]);
}
function revision(surface:Surface3):TopologyRevision {
  const old=revisions.get(surface);
  // Mutable advanced inputs may have changed since the last lookup.
  if(old&&immutable.has(surface))return old;
  const key=signature(surface),next=old?.signature===key?old:Object.freeze({signature:key});
  revisions.set(surface,next);return next;
}
export function inheritTopology3(surface:Surface3,previous?:Surface3):void {
  const key=signature(surface),old=previous?revision(previous):undefined;
  revisions.set(surface,old?.signature===key?old:Object.freeze({signature:key}));
}
const frozen=(rows:readonly Set<number>[])=>Object.freeze(rows.map(row=>Object.freeze([...row].sort((a,b)=>a-b))));
export function topology3(surface:Surface3):SurfaceTopology3 {
  const key=revision(surface),cached=adjacency.get(key);if(cached)return cached;
  const pointEdges=surface.points.map(()=>new Set<number>()),pointFaces=surface.points.map(()=>new Set<number>()),pointNeighbors=surface.points.map(()=>new Set<number>());
  const faceEdges=surface.faces.map(()=>new Set<number>()),faceNeighbors=surface.faces.map(()=>new Set<number>());
  surface.faces.forEach((face,i)=>face.vertices.forEach(v=>pointFaces[v].add(i)));
  surface.edges.forEach((edge,i)=>{
    const [a,b]=edge.vertices;pointEdges[a].add(i);pointEdges[b].add(i);pointNeighbors[a].add(b);pointNeighbors[b].add(a);
    for(const face of edge.faces){faceEdges[face].add(i);for(const other of edge.faces)if(face!==other)faceNeighbors[face].add(other);}
  });
  const result=Object.freeze({pointEdges:frozen(pointEdges),pointFaces:frozen(pointFaces),pointNeighbors:frozen(pointNeighbors),faceEdges:frozen(faceEdges),faceNeighbors:frozen(faceNeighbors)});
  adjacency.set(key,result);return result;
}
/** Components of the induced selection, in deterministic source order. */
export function topologyComponents(indices:readonly number[],neighbors:readonly (readonly number[])[]):readonly (readonly number[])[] {
  const remaining=new Set(indices),result:number[][]=[];
  for(const root of indices){
    if(!remaining.delete(root))continue;
    const component=[root];
    for(let i=0;i<component.length;i++)for(const neighbor of neighbors[component[i]])if(remaining.delete(neighbor))component.push(neighbor);
    result.push(component.sort((a,b)=>a-b));
  }
  return Object.freeze(result.map(row=>Object.freeze(row)));
}
export function topologyConnected(indices:readonly number[],neighbors:readonly (readonly number[])[]):readonly number[] {
  const seen=new Set(indices),queue=[...indices];
  for(let i=0;i<queue.length;i++)for(const neighbor of neighbors[queue[i]])if(!seen.has(neighbor)){seen.add(neighbor);queue.push(neighbor);}
  return [...seen].sort((a,b)=>a-b);
}
