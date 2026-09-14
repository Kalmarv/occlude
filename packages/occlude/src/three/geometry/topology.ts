import type {Surface3} from './surface.js';

/** Positions and attributes do not participate in topology identity. Tokens and
 * adjacency are weakly owned: retaining a revision retains its own topology,
 * without an unbounded global string-keyed cache. */
interface TopologyRevision {readonly signature:string}
export interface SurfaceTopology3 {
  readonly pointCorners:readonly (readonly number[])[];
  readonly faceCorners:readonly (readonly number[])[];
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
  return JSON.stringify([surface.points.map(p=>p.id),surface.faces.map(f=>[f.id,f.vertices,f.corners?.map(c=>c.id)??f.vertices.map(v=>JSON.stringify(['corner',f.id,surface.points[v].id]))]),surface.edges.map(e=>[e.id,e.vertices,e.faces]),surface.triangles.map(t=>[t.face,t.vertices])]);
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
  const next=old?.signature===key?old:Object.freeze({signature:key});
  revisions.set(surface,next);
  // A mirror or index reorder changes oriented adjacency, but attachment can
  // retain the same face/vertex/corner incidence. Independently built meshes
  // never share this lineage merely because their generated IDs match.
  if(previous&&old!==next&&surface.points.length===previous.points.length&&surface.faces.length===previous.faces.length&&surface.edges.length===previous.edges.length&&surface.triangles.length===previous.triangles.length){
    const before=attachmentRevision(previous),after=attachmentRevision(surface);
    if(before.signature===after.signature)attachments.set(next,{signature:after.signature,token:before.token});
  }
}
interface AttachmentRevision {readonly signature:string;readonly token:object}
const attachments=new WeakMap<TopologyRevision,AttachmentRevision>();
function attachmentRevision(surface:Surface3):AttachmentRevision {
  const key=revision(surface),cached=attachments.get(key);if(cached)return cached;
  const point=(index:number)=>surface.points[index].id;
  const signature=JSON.stringify([
    surface.points.map(p=>p.id).sort(),
    surface.faces.map(f=>JSON.stringify([f.id,f.vertices.map((v,i)=>[point(v),f.corners?.[i].id??JSON.stringify(['corner',f.id,point(v)])]).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0)])).sort(),
    surface.triangles.map(t=>JSON.stringify([surface.faces[t.face].id,t.vertices.map(point).sort()])).sort(),
    surface.edges.map(e=>JSON.stringify([e.id,e.vertices.map(point).sort()])).sort(),
  ]);
  const value=Object.freeze({signature,token:Object.freeze({})});attachments.set(key,value);return value;
}
/** Explicit rebind requires shared authoring lineage and unchanged incidence,
 * not just equal labels or a nearest-point guess. Winding may reverse. */
export function sameAttachmentTopology3(a:Surface3,b:Surface3):boolean {
  return attachmentRevision(a).token===attachmentRevision(b).token;
}
const frozen=(rows:readonly Set<number>[])=>Object.freeze(rows.map(row=>Object.freeze([...row].sort((a,b)=>a-b))));
export function topology3(surface:Surface3):SurfaceTopology3 {
  const key=revision(surface),cached=adjacency.get(key);if(cached)return cached;
  const pointEdges=surface.points.map(()=>new Set<number>()),pointFaces=surface.points.map(()=>new Set<number>()),pointNeighbors=surface.points.map(()=>new Set<number>());
  const faceEdges=surface.faces.map(()=>new Set<number>()),faceNeighbors=surface.faces.map(()=>new Set<number>());
  const pointCorners=surface.points.map(()=>new Set<number>()),faceCorners=surface.faces.map(()=>new Set<number>());let corner=0;
  surface.faces.forEach((face,i)=>face.vertices.forEach(v=>{pointFaces[v].add(i);pointCorners[v].add(corner);faceCorners[i].add(corner++);}));
  surface.edges.forEach((edge,i)=>{
    const [a,b]=edge.vertices;pointEdges[a].add(i);pointEdges[b].add(i);pointNeighbors[a].add(b);pointNeighbors[b].add(a);
    for(const face of edge.faces){faceEdges[face].add(i);for(const other of edge.faces)if(face!==other)faceNeighbors[face].add(other);}
  });
  const result=Object.freeze({pointCorners:frozen(pointCorners),faceCorners:frozen(faceCorners),pointEdges:frozen(pointEdges),pointFaces:frozen(pointFaces),pointNeighbors:frozen(pointNeighbors),faceEdges:frozen(faceEdges),faceNeighbors:frozen(faceNeighbors)});
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
