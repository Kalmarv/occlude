import {rotateVector3,rotation3,type RotationInput} from '../rotation.js';
import {sealAssembledTopology3,shareTopology3,topology3} from './topology.js';
import { groupRows } from '../../groupRows.js';
import { add3,cross3,finite3,mul3,sub3,unit3,type Vec3 } from '../math.js';
import { assembleSurface3,surface3,type Surface3,type SurfaceFace3,type SurfacePoint3,type SurfaceTriangle3,type Attributes3 } from './surface.js';
import {emptyCount,emptySize,sampleValue} from '../degenerate.js';

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
/** What the explicit stage reads: a surface, or a mesh value from
 * `occlude/3d`, whose surface is read — as a scene object's `surface` is. */
export type StageSurface3=Surface3|{readonly surfaceBox:{surface:unknown}};
/** A geometry's working view, as the 3D layer installs the reader of it
 * (value.ts): the stage reads a geometry the way a view does. */
export const STAGE_VIEW:{surfaceOf?:(m:never)=>Surface3}={};
export function stageSurface3(input:StageSurface3):Surface3 {
  if(Array.isArray((input as Surface3).points))return input as Surface3;
  if(STAGE_VIEW.surfaceOf===undefined||!('surfaceBox' in input))throw new Error('expected a surface or a geometry with faces');
  return STAGE_VIEW.surfaceOf(input as never);
}
export function cloneSurface3(surface:Surface3):Surface3 {return assembleSurface3(surface.points,surface.faces,surface.triangles,surface);}

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
