import {rotateVector3,rotation3,type RotationInput} from '../rotation.js';
import {sealAssembledTopology3} from './topology.js';
import { add3,cross3,finite3,mul3,sub3,unit3,type Vec3 } from '../math.js';
import { assembleSurface3,type Surface3,type Attributes3,type Attribute3 } from './surface.js';
import {kernelColumn,type Domain3,type Mesh3} from './mesh3.js';

export interface FaceMeasure3 {readonly index:number;readonly id:string;readonly normal:Vec3;readonly center:Vec3;readonly area:number;readonly attributes:Readonly<Attributes3>;readonly adjacent:readonly number[]}
export interface FaceGeometry3 {readonly normals:readonly Vec3[];readonly centers:readonly Vec3[];readonly areas:readonly number[]}
/** Row `row` of one domain's kernel columns as a fresh record, in column
 * order: numbers, booleans, strings and vectors (a fresh array). Reference
 * and placement columns are not what a kernel reads. */
export function rowColumns3(mesh:Mesh3,domain:Domain3,row:number):Attributes3 {
  const out:Attributes3={},cols=mesh.cols[domain];
  for(const name in cols){const column=cols[name];if(kernelColumn(column))out[name]=(column as {get(i:number):Attribute3}).get(row);}
  return out;
}
// A statement of faces fixes the triangles and three position flats fix
// where they are, so states that differ only in their columns share this.
const faceGeometries=new WeakMap<object,WeakMap<Float64Array,{readonly y:Float64Array;readonly z:Float64Array;readonly result:FaceGeometry3}[]>>();
/** Per-face normals, centers and areas, following the represented triangles
 * (deformed polygons included). */
export function faceGeometry3(mesh:Mesh3):FaceGeometry3 {
  let byX=faceGeometries.get(mesh.topology);if(!byX){byX=new WeakMap();faceGeometries.set(mesh.topology,byX);}
  let kept=byX.get(mesh.x);if(!kept){kept=[];byX.set(mesh.x,kept);}
  const hit=kept.find(k=>k.y===mesh.y&&k.z===mesh.z);if(hit)return hit.result;
  const positions=mesh.positions,triangles=mesh.triangles,faceOf=mesh.triangleFace;
  const normals=mesh.loops.map(()=>[0,0,0] as Vec3),centers=mesh.loops.map(()=>[0,0,0] as Vec3),areas=mesh.loops.map(()=>0);
  for(let t=0;t<mesh.triangleCount;t++){const f=faceOf[t],a=positions[triangles[3*t]],b=positions[triangles[3*t+1]],c=positions[triangles[3*t+2]],n=cross3(sub3(b,a),sub3(c,a)),area=Math.hypot(...n)/2;normals[f]=add3(normals[f],n);areas[f]+=area;centers[f]=add3(centers[f],mul3(add3(add3(a,b),c),area/3));}
  // A face with no represented triangles (a degenerate polygon) has no normal:
  // zero, the same "no direction here" the tracer already reads, and the mean
  // of its own vertices for a center.
  const polygonCenter=(i:number):Vec3=>{const vs=mesh.loops[i];return vs.length?mul3(vs.reduce((sum,v)=>add3(sum,positions[v]),[0,0,0] as Vec3),1/vs.length):[0,0,0];};
  const finiteLength=(n:Vec3)=>{const l=Math.hypot(...n);return l>0&&Number.isFinite(l)?l:0;};
  const result:FaceGeometry3=Object.freeze({normals:Object.freeze(normals.map(n=>Object.freeze(finiteLength(n)?unit3(n):[0,0,0] as Vec3))),centers:Object.freeze(centers.map((c,i)=>Object.freeze(areas[i]>0?mul3(c,1/areas[i]):polygonCenter(i)))),areas:Object.freeze(areas)});
  kept.push({y:mesh.y,z:mesh.z,result});
  return result;
}
/** Measures follow the represented triangles, including deformed polygons. */
export function measureFaces3(mesh:Mesh3):readonly FaceMeasure3[] {
  const neighbors=mesh.faceNeighbors,{normals,centers,areas}=faceGeometry3(mesh),names=mesh.names.faces;
  return Object.freeze(mesh.loops.map((_,i)=>Object.freeze({index:i,id:names[i],normal:normals[i],center:centers[i],area:areas[i],attributes:Object.freeze(rowColumns3(mesh,'faces',i)),adjacent:neighbors[i]})));
}
export function cloneSurface3(surface:Surface3):Surface3 {return assembleSurface3(surface.points,surface.faces,surface.triangles,surface);}

/** An affine placement: translate, rotate and scale about `origin`. */
export interface SurfaceTransform3 {translate?:Vec3;rotate?:RotationInput;scale?:Vec3;origin?:Vec3}
/** Refuse a placement that is not one: every vector finite, the rotation a rotation. */
export function validateTransform3(options:SurfaceTransform3):void {
  const translate=options.translate??[0,0,0],rotate=options.rotate??[0,0,0],scale=options.scale??[1,1,1],origin=options.origin??[0,0,0];[translate,scale,origin].forEach(v=>finite3(v,'transform'));rotation3(rotate);
}
/** Apply already validated affine settings with the same operation order used
 * for represented mesh vertices and surface bindings. */
export function transformPosition3(position:Vec3,options:SurfaceTransform3):Vec3 {
  const origin=options.origin??[0,0,0],scale=options.scale??[1,1,1];
  const v=rotateVector3(sub3(position,origin).map((n,i)=>n*scale[i]) as unknown as Vec3,options.rotate??[0,0,0]);
  return add3(add3(v,origin),options.translate??[0,0,0]);
}
/** Affine modeling edit with an explicit pivot and Euler or rotation values.
 * Negative determinant reverses polygon and triangle winding consistently. */
export function transformSurface3(surface:Surface3,options:SurfaceTransform3):Surface3 {
  validateTransform3(options);
  const settings={translate:options.translate??[0,0,0],rotate:options.rotate??[0,0,0],scale:options.scale??[1,1,1],origin:options.origin??[0,0,0]};
  const points=surface.points.map(p=>({...p,position:transformPosition3(p.position,settings)}));
  const mirrored=settings.scale.filter(n=>n<0).length%2===1;
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
