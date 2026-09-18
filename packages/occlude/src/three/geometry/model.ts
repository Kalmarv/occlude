import {rotateVector3,rotation3,type RotationInput} from '../rotation.js';
import {sealAssembledTopology3,shareTopology3,topology3} from './topology.js';
import { groupRows } from '../../groupRows.js';
import { add3,cross3,finite3,mul3,sub3,unit3,type Vec3 } from '../math.js';
import { assembleSurface3,surface3,type Surface3,type SurfaceFace3,type SurfacePoint3,type SurfaceTriangle3,type Attributes3 } from './surface.js';
import {emptyCount,emptySize,sampleValue} from '../degenerate.js';

export function grid3(columns:number,rows:number,size:readonly[number,number]=[1,1]):Surface3 {
  // No cells or no extent is nothing to draw, not a fault; the face cap is a
  // real budget and still throws.
  if(emptyCount(columns,1,'grid columns')||emptyCount(rows,1,'grid rows')||emptySize(...size))return surface3([],[]);
  if(columns*rows>1_000_000)throw new Error('grid needs positive cell counts and dimensions (at most one million faces)');
  const positions:Vec3[]=[],faces:number[][]=[];
  for(let y=0;y<=rows;y++)for(let x=0;x<=columns;x++)positions.push([(x/columns-.5)*size[0],(y/rows-.5)*size[1],0]);
  for(let y=0;y<rows;y++)for(let x=0;x<columns;x++){const p=y*(columns+1)+x;faces.push([p,p+1,p+columns+2,p+columns+1]);}
  return surface3(positions,faces);
}
export interface FaceMeasure3 { readonly source:Surface3;readonly index:number;readonly id:string;readonly normal:Vec3;readonly center:Vec3;readonly area:number;readonly attributes:Readonly<Attributes3>;readonly adjacent:readonly number[] }
export interface FaceGeometry3 {readonly normals:readonly Vec3[];readonly centers:readonly Vec3[];readonly areas:readonly number[]}
// Captured surfaces freeze their positions, so the identity of the points and
// triangles arrays fixes the geometry; attribute edits share both arrays.
const faceGeometries=new WeakMap<readonly SurfacePoint3[],WeakMap<readonly SurfaceTriangle3[],FaceGeometry3>>();
/** Per-face normals, centers and areas, following the represented triangles
 * (deformed polygons included). Cached for captured surfaces. */
export function faceGeometry3(surface:Surface3):FaceGeometry3 {
  const captured=capturedSurfaces3.has(surface);
  if(captured){const hit=faceGeometries.get(surface.points)?.get(surface.triangles);if(hit)return hit;}
  const normals=surface.faces.map(()=>[0,0,0] as Vec3),centers=surface.faces.map(()=>[0,0,0] as Vec3),areas=surface.faces.map(()=>0);
  for(const t of surface.triangles){const [a,b,c]=t.vertices.map(v=>surface.points[v].position),n=cross3(sub3(b,a),sub3(c,a)),area=Math.hypot(...n)/2;normals[t.face]=add3(normals[t.face],n);areas[t.face]+=area;centers[t.face]=add3(centers[t.face],mul3(add3(add3(a,b),c),area/3));}
  // A face with no represented triangles (a degenerate polygon) has no normal:
  // zero, the same "no direction here" the tracer already reads, and the mean
  // of its own vertices for a center.
  const polygonCenter=(i:number):Vec3=>{const vs=surface.faces[i].vertices;return vs.length?mul3(vs.reduce((sum,v)=>add3(sum,surface.points[v].position),[0,0,0] as Vec3),1/vs.length):[0,0,0];};
  const finiteLength=(n:Vec3)=>{const l=Math.hypot(...n);return l>0&&Number.isFinite(l)?l:0;};
  const result:FaceGeometry3=Object.freeze({normals:Object.freeze(normals.map(n=>Object.freeze(finiteLength(n)?unit3(n):[0,0,0] as Vec3))),centers:Object.freeze(centers.map((c,i)=>Object.freeze(areas[i]>0?mul3(c,1/areas[i]):polygonCenter(i)))),areas:Object.freeze(areas)});
  if(captured){let byTriangles=faceGeometries.get(surface.points);if(!byTriangles){byTriangles=new WeakMap();faceGeometries.set(surface.points,byTriangles);}byTriangles.set(surface.triangles,result);}
  return result;
}
/** Measures follow the represented triangles, including deformed polygons. */
export function measureFaces3(surface:Surface3):readonly FaceMeasure3[] {
  const neighbors=topology3(surface).faceNeighbors,{normals,centers,areas}=faceGeometry3(surface);
  return Object.freeze(surface.faces.map((f,i)=>Object.freeze({source:surface,index:i,id:f.id,normal:normals[i],center:centers[i],area:areas[i],attributes:Object.freeze(structuredClone(f.attributes)),adjacent:neighbors[i]})));
}
export class FaceSelection3 implements Iterable<FaceMeasure3> {
  private readonly measures:readonly FaceMeasure3[];
  readonly indices:readonly number[];
  constructor(readonly source:Surface3,indices:readonly number[]=source.faces.map((_,i)=>i)) {
    if(indices.some(i=>!Number.isInteger(i)||i<0||i>=source.faces.length))throw new Error('invalid face selection index');
    this.indices=Object.freeze([...new Set(indices)].sort((a,b)=>a-b));this.measures=measureFaces3(source);Object.freeze(this);
  }
  *[Symbol.iterator](){for(const i of this.indices)yield this.measures[i];}
  get length(){return this.indices.length;}
  filter(fn:(f:FaceMeasure3)=>boolean){return new FaceSelection3(this.source,this.indices.filter(i=>fn(this.measures[i])));}
  map<T>(fn:(f:FaceMeasure3)=>T):T[]{return this.indices.map(i=>fn(this.measures[i]));}
  groupBy<K>(fn:(f:FaceMeasure3)=>K){return groupRows(this.indices,i=>i,i=>fn(this.measures[i])).map(g=>({key:g.key,selection:new FaceSelection3(this.source,g.rows)}));}
  adjacent(){return new FaceSelection3(this.source,this.indices.flatMap(i=>this.measures[i].adjacent));}
}
export function cloneSurface3(surface:Surface3):Surface3 {return assembleSurface3(surface.points,surface.faces,surface.triangles,surface);}

/** Independent extrusion replaces each selected cap, retaining its old boundary
 * through side faces. Neighboring selected faces are rejected in the MVP so no
 * coincident side walls are silently discarded. Negative distances recess.
 * Zero distances create no topology. Fixed cap triangulations survive folds. */
export function extrudeFaces3(surface:Surface3,selection:FaceSelection3,distance:number|((face:FaceMeasure3)=>number),options:{operation:string;extensiveFaceAttributes?:readonly string[]}):Surface3 {
  if(selection.source!==surface)throw new Error('face selection belongs to another surface state');
  if(!options.operation)throw new Error('extrusion requires a stable operation ID');
  surface=snapshotSurface3(surface);
  const measures=measureFaces3(surface),distances=new Map<number,number>();
  for(const i of selection.indices){const d=sampleValue(typeof distance==='function'?distance(measures[i]):distance,0);if(d!==0)distances.set(i,d);}
  for(const e of surface.edges)if(e.faces.filter(f=>distances.has(f)).length>1)throw new Error('independent extrusion requires nonadjacent selected faces; select a separated set per pass');
  const points=surface.points.map(p=>({...p,position:[...p.position] as Vec3,attributes:structuredClone(p.attributes)})),faces:SurfaceFace3[]=[],triangles:SurfaceTriangle3[]=[];
  const capPoints=new Map<number,Map<number,number>>(),parents=new Map<number,number>();
  const id=(...parts:(string|number)[])=>JSON.stringify(['extrude',options.operation,...parts]);
  const byFace=surface.faces.map(()=>[] as SurfaceTriangle3[]);surface.triangles.forEach(t=>byFace[t.face].push(t));
  const add=(face:SurfaceFace3,parts:readonly(readonly[number,number,number])[],parent:number)=>{const i=faces.length;faces.push(face);parents.set(i,parent);for(const vertices of parts)triangles.push({face:i,vertices});};
  surface.faces.forEach((f,i)=>{
    const d=distances.get(i);
    if(d===undefined){add({...f},byFace[i].map(t=>t.vertices),i);return;}
    const mapping=new Map<number,number>();capPoints.set(i,mapping);
    for(const v of f.vertices){mapping.set(v,points.length);const p=surface.points[v];points.push({id:id(f.id,'point',p.id),position:add3(p.position,mul3(measures[i].normal,d)),attributes:{...structuredClone(p.attributes),parentPoint:p.id}});}
    add({id:id(f.id,'cap'),vertices:f.vertices.map(v=>mapping.get(v)!),corners:f.corners?.map(c=>({...c,id:id(f.id,'corner',c.id),provenance:{operation:'extrude',parents:[c.id]}})),attributes:{...structuredClone(f.attributes),parentFace:f.id,role:'cap'}},byFace[i].map(t=>t.vertices.map(v=>mapping.get(v)!) as [number,number,number]),i);
    f.vertices.forEach((a,j)=>{const b=f.vertices[(j+1)%f.vertices.length],c=mapping.get(b)!,e=mapping.get(a)!;add({id:id(f.id,'side',j),vertices:[a,b,c,e],attributes:{...structuredClone(f.attributes),parentFace:f.id,role:'side'}},[[a,b,c],[a,c,e]],i);});
  });
  const result=assembleSurface3(points,faces,triangles,surface);
  // Copied labels/scalars are intensive by default. Explicit extensive face
  // quantities are distributed by resulting area, conserving each parent's sum.
  if(options.extensiveFaceAttributes?.length){const measured=measureFaces3(result),totals=new Map<number,number>();measured.forEach((f,i)=>{const p=parents.get(i)!;totals.set(p,(totals.get(p)??0)+f.area);});result.faces.forEach((f,i)=>{const p=parents.get(i)!;for(const name of options.extensiveFaceAttributes!){const value=surface.faces[p].attributes[name];if(typeof value!=='number'||!Number.isFinite(value))throw new Error(`extensive face attribute ${name} must be finite numeric`);f.attributes[name]=value*measured[i].area/totals.get(p)!;}});}
  const edgeKey=(a:number,b:number)=>a<b?`${a}:${b}`:`${b}:${a}`,capEdges=new Map(result.edges.map(e=>[edgeKey(...e.vertices),e]));
  for(const edge of surface.edges)for(const f of edge.faces){const mapping=capPoints.get(f);if(!mapping)continue;const cap=capEdges.get(edgeKey(mapping.get(edge.vertices[0])!,mapping.get(edge.vertices[1])!));if(cap)cap.attributes={...structuredClone(edge.attributes),parentEdge:edge.id};}
  return result;
}

/** Apply already validated affine settings with the same operation order used
 * for represented mesh vertices and surface bindings. */
export function transformPosition3(position:Vec3,options:Parameters<typeof transformSurface3>[1]):Vec3 {
  const origin=options.origin??[0,0,0],scale=options.scale??[1,1,1];
  const v=rotateVector3(sub3(position,origin).map((n,i)=>n*scale[i]) as unknown as Vec3,options.rotate??[0,0,0]);
  return add3(add3(v,origin),options.translate??[0,0,0]);
}
/** Affine modeling edit with an explicit pivot and Euler or rotation values.
 * Negative determinant reverses polygon and triangle winding consistently. */
export function transformSurface3(surface:Surface3,options:{translate?:Vec3;rotate?:RotationInput;scale?:Vec3;origin?:Vec3}):Surface3 {
  const translate=options.translate??[0,0,0],rotate=options.rotate??[0,0,0],scale=options.scale??[1,1,1],origin=options.origin??[0,0,0];[translate,scale,origin].forEach(finite3);rotation3(rotate);
  const settings={translate,rotate,scale,origin};
  const points=surface.points.map(p=>({...p,position:transformPosition3(p.position,settings)}));
  const mirrored=scale.filter(n=>n<0).length%2===1;
  return assembleSurface3(points,surface.faces.map(f=>({...f,vertices:mirrored?[...f.vertices].reverse():f.vertices,corners:mirrored?f.corners&&[...f.corners].reverse():f.corners})),surface.triangles.map(t=>({...t,vertices:mirrored?[t.vertices[0],t.vertices[2],t.vertices[1]]:t.vertices})),surface);
}

const capturedSurfaces3=new WeakSet<Surface3>();

/** Owned frozen input for one procedural pass; editable results are explicit.
 * Trusted immutable snapshots are reusable across dependent generators. */
export function snapshotSurface3(surface:Surface3):Surface3 {
  if(capturedSurfaces3.has(surface))return surface;
  return captureAssembled(cloneSurface3(surface));
}
/** Surfaces the API's own geometry paths build and hand straight to a
 * constructor: nobody else holds them, so capture freezes them in place
 * instead of cloning first. Advanced Surface3 inputs are always copied. */
const ownedSurfaces3=new WeakSet<Surface3>();
export function ownSurface3<S extends Surface3>(surface:S):S {ownedSurfaces3.add(surface);return surface;}
export function captureSurface3(surface:Surface3):Surface3 {
  if(capturedSurfaces3.has(surface))return surface;
  return ownedSurfaces3.has(surface)?captureAssembled(surface):snapshotSurface3(surface);
}
function captureAssembled(snapshot:Surface3):Surface3 {
  const freeze=(value:unknown):void=>{if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value))freeze(child);Object.freeze(value);}};
  // Array containers are already frozen by assembly; recurse through rows.
  for(const p of snapshot.points){freeze(p.position);freeze(p.attributes);freeze(p);}for(const f of snapshot.faces){freeze(f.attributes);for(const c of f.corners??[]){freeze(c.attributes);freeze(c);}freeze(f);}for(const e of snapshot.edges){freeze(e.attributes);freeze(e);}
  capturedSurfaces3.add(snapshot);sealAssembledTopology3(snapshot);
  return Object.freeze(snapshot);
}
/** Attribute patches per domain, one optional record per row; corners run in
 * face order, then polygon winding order. A patch merges over the row's record. */
export interface AttributePatches3 {
  readonly points?:readonly (Attributes3|undefined)[];readonly edges?:readonly (Attributes3|undefined)[];
  readonly faces?:readonly (Attributes3|undefined)[];readonly corners?:readonly (Attributes3|undefined)[];
}
const deepFreeze=(value:unknown):void=>{if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value))deepFreeze(child);Object.freeze(value);}};
/** An attribute-only edit of a captured surface. Rows keep their identity,
 * positions, incidence and triangulation by reference; only rows with a patch
 * get a fresh frozen record. The result is captured too, sharing the source's
 * topology revision, so nothing about the surface is re-read or re-verified. */
export function editAttributes3(source:Surface3,patches:AttributePatches3):Surface3 {
  const surface=snapshotSurface3(source);
  for(const [domain,count] of [['points',surface.points.length],['edges',surface.edges.length],['faces',surface.faces.length],['corners',surface.faces.reduce((n,f)=>n+f.vertices.length,0)]] as const){
    const rows=patches[domain];if(rows&&rows.length!==count)throw new Error(`${domain} attribute patch must cover every row`);
  }
  const merge=<R extends {attributes:Attributes3}>(row:R,patch:Attributes3|undefined):R=>{
    if(!patch)return row;
    const attributes=Object.freeze({...row.attributes,...patch});deepFreeze(attributes);
    return Object.freeze({...row,attributes});
  };
  const points=patches.points?Object.freeze(surface.points.map((p,i)=>merge(p,patches.points![i]))):surface.points;
  const edges=patches.edges?Object.freeze(surface.edges.map((e,i)=>merge(e,patches.edges![i]))):surface.edges;
  let corner=0;
  const faces=patches.faces||patches.corners?Object.freeze(surface.faces.map((f,i)=>{
    const corners=patches.corners?Object.freeze(f.corners!.map(c=>merge(c,patches.corners![corner++]))):f.corners;
    const row=merge(f,patches.faces?.[i]);
    return corners===f.corners?row:Object.freeze({...row,corners});
  })):surface.faces;
  const result:Surface3=Object.freeze({points,faces,edges,triangles:surface.triangles});
  capturedSurfaces3.add(result);shareTopology3(result,surface);
  return result;
}
export function stepsSurface3(initial:Surface3,count:number,pass:(input:Surface3,iteration:number)=>Surface3,options:{history?:number}={}):{surface:Surface3;history:readonly Surface3[]} {
  const keep=options.history??0;
  if(!Number.isSafeInteger(count)||count<0||!Number.isSafeInteger(keep)||keep<0)throw new Error('step and history counts must be nonnegative integers');
  let current=cloneSurface3(initial);const history:Surface3[]=[];
  for(let i=0;i<count;i++){const input=snapshotSurface3(current);current=cloneSurface3(pass(input,i));if(keep){history.push(snapshotSurface3(current));if(history.length>keep)history.shift();}}
  return {surface:current,history:Object.freeze(history)};
}
