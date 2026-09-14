import {orient2d} from 'robust-predicates';
import {snapshotSurface3,transformSurface3} from './model.js';
import {triangleCorners3} from './corners.js';
import {sameAttachmentTopology3} from './topology.js';
import type {Attribute3,Attributes3,Surface3,SurfacePoint3} from './surface.js';
import {add3,sub3,mul3,cross3,finite3,unit3,type Vec3} from '../math.js';
import {rotateVector3} from '../rotation.js';
import type {PointTransfers} from '../api/subdivide.js';

export type SurfaceTransform3=Parameters<typeof transformSurface3>[1];
export interface SurfacePlacement3 {readonly id:string;readonly transform:SurfaceTransform3}
export interface SurfaceLocationOptions3 {
  readonly placement?:SurfacePlacement3;
  readonly pointTransfers?:PointTransfers;
  readonly cornerTransfers?:PointTransfers;
  readonly uvAttribute?:string;
  readonly chartAttribute?:string;
  /** Explicit current model-space shading normal; never used for support. */
  readonly shadingNormal?:Vec3;
}
export interface SurfaceTangentFrame3 {
  /** Derivatives are model/world units per chart unit; they are not normalized. */
  readonly du:Vec3;readonly dv:Vec3;
  readonly tangent:Vec3;readonly bitangent:Vec3;
  readonly orientation:1|-1;
}
export interface SurfaceLocation3 {
  readonly source:Surface3;
  readonly placement?:SurfacePlacement3;
  readonly triangle:number;readonly face:number;readonly faceId:string;
  readonly vertices:readonly [number,number,number];
  readonly vertexIds:readonly [string,string,string];
  readonly corners:readonly [number,number,number];
  readonly barycentric:Vec3;
  readonly space:'model'|'world';
  readonly modelPosition:Vec3;readonly position:Vec3;
  readonly modelNormal:Vec3;readonly normal:Vec3;
  readonly modelShadingNormal?:Vec3;readonly shadingNormal?:Vec3;
  readonly pointAttributes:Readonly<Attributes3>;
  readonly faceAttributes:Readonly<Attributes3>;
  readonly cornerAttributes:Readonly<Attributes3>;
  readonly uv?:readonly [number,number];readonly chart?:string|number;
  readonly modelFrame?:SurfaceTangentFrame3;readonly frame?:SurfaceTangentFrame3;
  readonly chartStatus:'missing'|'regular'|'degenerate';
}
interface State {readonly options:SurfaceLocationOptions3}
const owned=new WeakMap<SurfaceLocation3,State>();
const triangleIndices=new WeakMap<Surface3,ReadonlyMap<string,number>>();
const triangleKey=(face:string,vertices:readonly string[])=>JSON.stringify([face,[...vertices].sort()]);
function triangleIndex(source:Surface3):ReadonlyMap<string,number> {
  const cached=triangleIndices.get(source);if(cached)return cached;
  const result=new Map<string,number>();
  source.triangles.forEach((t,i)=>result.set(triangleKey(source.faces[t.face].id,t.vertices.map(v=>source.points[v].id)),i));
  triangleIndices.set(source,result);return result;
}
function isUV(value:Attribute3|undefined):value is readonly [number,number] {
  return Array.isArray(value)&&value.length===2&&value.every(Number.isFinite);
}
function freeze<T>(value:T):T {
  if(value&&typeof value==='object'&&!Object.isFrozen(value)){
    for(const v of Object.values(value))freeze(v);Object.freeze(value);
  }return value;
}
function unit(v:Vec3):Vec3 {
  finite3(v);const scale=Math.max(...v.map(Math.abs));if(!scale)throw new Error('surface direction is degenerate');
  const scaled=v.map(n=>n/scale) as unknown as Vec3;return freeze(mul3(scaled,1/Math.hypot(...scaled)));
}
/** Same weighted transfer rule as surface sampling: numeric columns interpolate,
 * categorical/nearest columns choose greatest weight, then canonical source ID. */
export function interpolateAttributes3(rows:readonly Pick<SurfacePoint3,'id'|'attributes'>[],weights:Vec3,transfers:PointTransfers={}):Attributes3 {
  if(rows.length!==3)throw new Error('surface interpolation requires three source rows');
  const nearest=rows.map((p,i)=>({id:p.id,i,w:weights[i]})).sort((a,b)=>b.w-a.w||(a.id<b.id?-1:a.id>b.id?1:0))[0].i,out:Attributes3={};
  for(const name of Object.keys(rows[0].attributes)){
    if(!rows.every(p=>Object.hasOwn(p.attributes,name)))continue;
    const values=rows.map(p=>p.attributes[name]);
    if(transfers[name]!=='nearest'&&values.every(v=>typeof v==='number'))out[name]=(values as number[]).reduce((sum,v,i)=>sum+v*weights[i],0);
    else if(transfers[name]!=='nearest'&&values.every(v=>Array.isArray(v)&&v.length===(values[0] as number[]).length))out[name]=(values[0] as number[]).map((_,k)=>values.reduce<number>((sum,v,i)=>sum+(v as number[])[k]*weights[i],0));
    else out[name]=structuredClone(values[nearest]);
  }return out;
}
function direction(v:Vec3,transform?:SurfaceTransform3):Vec3 {
  if(!transform)return v;const s=transform.scale??[1,1,1];
  return freeze(rotateVector3(v.map((n,i)=>n*s[i]) as unknown as Vec3,transform.rotate??[0,0,0]));
}
function normal(v:Vec3,transform?:SurfaceTransform3):Vec3 {
  if(!transform)return v;const s=transform.scale??[1,1,1];
  // Normalize before rotating. The inverse-transpose applies to normals; the
  // winding reversal in mirrored mesh placement preserves this orientation.
  const exponent=Math.max(...s.map((n,i)=>v[i]===0?-Infinity:Math.log2(Math.abs(v[i]))-Math.log2(Math.abs(n))));
  const inverse=v.map((n,i)=>n===0?0:Math.sign(n)*Math.sign(s[i])*2**(Math.log2(Math.abs(n))-Math.log2(Math.abs(s[i]))-exponent)) as unknown as Vec3;
  return unit(rotateVector3(unit(inverse),transform.rotate??[0,0,0]));
}
function placedPosition(p:Vec3,transform?:SurfaceTransform3):Vec3 {
  if(!transform)return p;const origin=transform.origin??[0,0,0];
  const result=add3(add3(direction(sub3(p,origin),transform),origin),transform.translate??[0,0,0]);finite3(result);return freeze(result);
}
function frame(du:Vec3,dv:Vec3,n:Vec3,orientation:1|-1):SurfaceTangentFrame3 {
  finite3(du);finite3(dv);const tangent=unit(du);unit(dv);
  return freeze({du,dv,tangent,bitangent:mul3(unit(cross3(n,tangent)),orientation),orientation});
}
const capturedPlacements=new WeakSet<SurfacePlacement3>();
const placementRevisions=new WeakMap<SurfacePlacement3,{signature:string;captured:SurfacePlacement3}>();
function placement(value?:SurfacePlacement3):SurfacePlacement3|undefined {
  if(!value)return;
  if(capturedPlacements.has(value))return value;
  if(typeof value.id!=='string'||!value.id)throw new Error('surface placement requires a nonempty identity');
  const copy={id:value.id,transform:structuredClone(value.transform)};
  // Reuse the modeling boundary for validation, without transforming a mesh.
  transformSurface3({points:[],faces:[],triangles:[],edges:[]},copy.transform);
  const signature=JSON.stringify(copy),previous=placementRevisions.get(value);
  if(previous?.signature===signature)return previous.captured;
  const captured=freeze(copy);capturedPlacements.add(captured);
  placementRevisions.set(value,{signature,captured});return captured;
}
/** Internal constructor. Ordinary artists receive these through sampling,
 * queries, mappings and traces rather than constructing triangle indices. */
export function surfaceLocation3(source:Surface3,triangle:number,barycentric:Vec3,options:SurfaceLocationOptions3={}):SurfaceLocation3 {
  source=snapshotSurface3(source);
  const t=source.triangles[triangle];
  if(!Number.isSafeInteger(triangle)||!t)throw new Error('surface location requires a valid source triangle');
  finite3(barycentric);
  if(barycentric.some(w=>w<0||w>1)||Math.abs(barycentric.reduce((a,b)=>a+b,0)-1)>32*Number.EPSILON)throw new Error('surface location requires barycentric weights inside its triangle');
  const weights=freeze([...barycentric]) as Vec3,face=source.faces[t.face],corners=triangleCorners3(source,triangle);
  const rows=t.vertices.map(v=>source.points[v]),cornerRows=corners.map(i=>face.corners![i]);
  const [a,b,c]=rows.map(p=>p.position),ab=sub3(b,a),ac=sub3(c,a);
  const modelPosition=freeze(add3(a,add3(mul3(ab,weights[1]),mul3(ac,weights[2]))));finite3(modelPosition);
  // Keep the established sample-normal arithmetic in its representable range.
  const edgeScale=Math.max(Math.hypot(...ab),Math.hypot(...ac));
  const scaledCross=cross3(mul3(ab,1/edgeScale),mul3(ac,1/edgeScale));
  const normalLength=Math.hypot(...scaledCross);
  const modelNormal=freeze(normalLength>0&&Number.isFinite(1/normalLength)?unit3(scaledCross):unit(cross3(unit(ab),unit(ac))));
  const place=placement(options.placement);
  const worldNormal=normal(modelNormal,place?.transform);
  const pointAttributes=freeze(interpolateAttributes3(rows,weights,options.pointTransfers));
  const cornerAttributes=freeze(interpolateAttributes3(cornerRows,weights,options.cornerTransfers));
  const uvName=options.uvAttribute??'uv',chartName=options.chartAttribute??'chart';
  if([uvName,chartName].some(name=>typeof name!=='string'||!name))throw new Error('surface coordinate column names must be nonempty strings');
  const uvRows=cornerRows.map(c=>c.attributes[uvName]);
  const charts=cornerRows.map(c=>c.attributes[chartName]);
  if(charts.some(v=>v!==undefined)&&!charts.every(v=>v===charts[0]))throw new Error('a surface triangle cannot cross chart identities');
  const chart=charts[0];if(chart!==undefined&&typeof chart!=='number'&&typeof chart!=='string')throw new Error('chart identity must be a string or number');
  let uv:readonly [number,number]|undefined,modelFrame:SurfaceTangentFrame3|undefined,worldFrame:SurfaceTangentFrame3|undefined;
  let chartStatus:SurfaceLocation3['chartStatus']='missing';
  if(uvRows.some(v=>v!==undefined)){
    if(options.cornerTransfers?.[uvName]==='nearest')throw new Error('UV chart coordinates require interpolated corner values; select a different uvAttribute for discrete columns');
    if(!uvRows.every(isUV))throw new Error('surface UVs require a finite pair at every triangle corner');
    const coords=uvRows;
    uv=freeze([coords.reduce((sum,v,i)=>sum+v[0]*weights[i],0),coords.reduce((sum,v,i)=>sum+v[1]*weights[i],0)] as const);
    if(!uv.every(Number.isFinite))throw new Error('surface UV position is not representable');
    const u1=coords[1][0]-coords[0][0],v1=coords[1][1]-coords[0][1],u2=coords[2][0]-coords[0][0],v2=coords[2][1]-coords[0][1];
    const scale=Math.max(Math.abs(u1),Math.abs(v1),Math.abs(u2),Math.abs(v2));
    if(!Number.isFinite(scale))throw new Error('surface chart extent is not representable');
    const determinant=scale?-orient2d(0,0,u1/scale,v1/scale,u2/scale,v2/scale):0;
    chartStatus=determinant===0?'degenerate':'regular';
    if(determinant!==0){
      const du=ab.map((n,k)=>(n*(v2/scale)-ac[k]*(v1/scale))/determinant/scale) as unknown as Vec3;
      const dv=ab.map((n,k)=>(ac[k]*(u1/scale)-n*(u2/scale))/determinant/scale) as unknown as Vec3;
      const orientation=determinant>0?1:-1,mirrored=(place?.transform.scale??[1,1,1]).filter(n=>n<0).length%2===1;
      modelFrame=frame(du,dv,modelNormal,orientation);worldFrame=place?frame(direction(du,place.transform),direction(dv,place.transform),worldNormal,mirrored?(orientation===1?-1:1):orientation):modelFrame;
    }
  }
  const modelShadingNormal=options.shadingNormal?unit(options.shadingNormal):undefined;
  const location=freeze({source,placement:place,triangle,face:t.face,faceId:face.id,vertices:t.vertices,vertexIds:rows.map(p=>p.id) as [string,string,string],corners,barycentric:weights,space:place?'world' as const:'model' as const,modelPosition,position:placedPosition(modelPosition,place?.transform),modelNormal,normal:worldNormal,modelShadingNormal,shadingNormal:modelShadingNormal?normal(modelShadingNormal,place?.transform):undefined,pointAttributes,faceAttributes:face.attributes,cornerAttributes,uv,chart,modelFrame,frame:worldFrame,chartStatus});
  owned.set(location,{options:freeze({...structuredClone(options),placement:place})});return location;
}
/** Rebinding is explicit and never changes the old location. Supplied shading
 * normals must be evaluated again on the new model; they are not transported
 * implicitly through an arbitrary deformation. */
export function rebindSurfaceLocation3(location:SurfaceLocation3,target:Surface3,options:SurfaceLocationOptions3={}):SurfaceLocation3 {
  const state=owned.get(location);if(!state)throw new Error('rebind requires an owned surface location');
  target=snapshotSurface3(target);
  if(!sameAttachmentTopology3(location.source,target))throw new Error('surface topology or authoring lineage changed; regenerate locations or use an explicit topology transfer');
  const triangle=triangleIndex(target).get(triangleKey(location.faceId,location.vertexIds));
  if(triangle===undefined)throw new Error('source triangle was not retained by the target');
  const weights=target.triangles[triangle].vertices.map(v=>location.barycentric[location.vertexIds.indexOf(target.points[v].id)]) as unknown as Vec3;
  return surfaceLocation3(target,triangle,weights,{...state.options,shadingNormal:undefined,...options});
}
