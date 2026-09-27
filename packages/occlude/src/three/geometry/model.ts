import {rotateVector3,rotation3,type RotationInput} from '../rotation.js';
import { add3,cross3,finite3,mul3,sub3,unit3,type Vec3 } from '../math.js';
import {Column,kinds,kindWords,type AnyColumn,type AnyKind} from '../../column.js';
import {kindOfValue} from '../../tables.js';
import {kernelColumn,type Columns3,type Domain3,type Mesh3} from './mesh3.js';

/** One value of a row's kernel column, as a record holds it: a number, a
 * string, a boolean or a vector. */
export type Attribute3 = number | string | boolean | readonly number[];
/** A row's kernel columns as a record, by name (`rowColumns3`): what a
 * feature, a location or a curve point carries. */
export type Attributes3 = Record<string, Attribute3>;

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
/** Records as columns, the inverse of `rowColumns3`: one column per name a
 * record holds, in the order the names are first met, of the kind its
 * values are (a number, a boolean, a string or a numeric vector); a record
 * with no value reads the kind's default. A column holds one kind. */
export function columnsOfRecords3(records:readonly Readonly<Record<string,Attribute3|undefined>>[]):Columns3 {
  const found=new Map<string,AnyKind>();
  for(const record of records)for(const name in record){
    const value=record[name];if(value===undefined)continue;
    const kind=kindOfValue(value);
    if(kind===null||kind===undefined||kind===kinds.reference)throw new Error(`a geometry column holds numbers, booleans, strings or numeric vectors — got ${typeof value}`);
    const known=found.get(name);
    if(known===undefined)found.set(name,kind);
    else if(known!==kind)throw new Error(`the column '${name}' holds ${kindWords(known)} on one row and ${kindWords(kind)} on another: a column holds one kind`);
  }
  const out:Record<string,AnyColumn>={};
  for(const [name,kind] of found){
    if(kind===kinds.number)out[name]=Column.of(Float64Array.from(records,r=>(r[name] as number|undefined)??0));
    else if(kind===kinds.boolean)out[name]=kinds.boolean.of(Uint8Array.from(records,r=>r[name]===true?1:0));
    else if(kind===kinds.string)out[name]=kinds.string.of(records.map(r=>(r[name] as string|undefined)??''));
    else{
      const k=kind.width,flat=new Float64Array(records.length*k);
      records.forEach((r,i)=>{const v=r[name] as readonly number[]|undefined;if(v!==undefined)for(let c=0;c<k;c++)flat[i*k+c]=v[c];});
      out[name]=kinds.vector(k).of(flat);
    }
  }
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
