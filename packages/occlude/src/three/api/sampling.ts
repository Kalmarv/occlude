/**
 * Points on a surface: `t.scatter` on a geometry with faces.
 *
 * The result is the one geometry — points in space, no edges — whose rows
 * answer, beside their columns (the face's columns and the point columns
 * read at the place), `source`: the face under the point, and `sample`: the
 * place itself (its normal, its chart coordinates, its barycentric weights,
 * the face row). A move keeps a point's sample, rather than silently
 * reprojecting; `rebind(edited)` puts the points back on the same places
 * of an edited revision of the surface that kept its topology.
 */

import {surfaceLocation3,rebindSurfaceLocation3,locationMesh3,type SurfaceLocation3} from '../geometry/location.js';
import {mesh3,sameAttachment3,kernelColumn,checkMade3,type Mesh3,type Columns3} from '../geometry/mesh3.js';
import {kinds,kindOf,type AnyColumn} from '../../column.js';
import {Material} from '../../material.js';
import type {Face} from '../../faces.js';
import {madeGeometry3,pointsMade3,derived,type GeometryOptions} from './mesh.js';
import {evaluate,type Field} from './columns.js';
import type {Provenance3} from '../geometry/surface.js';
import {sub3,mul3,cross3,type Vec3} from '../math.js';
import {emptySize,sampleValue} from '../degenerate.js';

/** A place on a surface, as a sampled point answers it (`p.sample`): the
 * place's position, normals, weights and chart coordinates, and the face
 * row under it. */
export interface SurfaceSample extends Omit<SurfaceLocation3,'face'|'faceId'|'vertexIds'|'exact'> {
  readonly face:Face;
}
/** @internal What a scatter tried and what it kept, and why it stopped. */
export interface SamplingGeneration {readonly attempts:number;readonly accepted:number;readonly reason:'count'|'attempt-limit'|'point-limit'|'empty'}
const generations=new WeakMap<SurfaceSample,SamplingGeneration>();
/** @internal The generation a scatter's points came from (read on any state
 * that holds its samples), or undefined for points no scatter made. */
export function generationOf(m:Material):SamplingGeneration|undefined {
  const first=samplesOf(m)?.[0];
  return first===undefined?undefined:generations.get(first);
}
/** The place each sample was captured from, kept beside the record a row
 * answers: a rebind reads it. */
const sampleLocations=new WeakMap<SurfaceSample,SurfaceLocation3>();
function captureSample(location:SurfaceLocation3,face:Face):SurfaceSample {
  const {faceId:_faceId,vertexIds:_vertexIds,exact:_exact,face:_face,...place}=location;
  const sample=Object.freeze({...place,face}) as unknown as SurfaceSample;
  sampleLocations.set(sample,location);return sample;
}
/** @internal The place a value is on a surface: a location, or the place a
 * surface sample was captured at; undefined for anything else. */
export function placeOf3(value:unknown):SurfaceLocation3|undefined {
  if(!value||typeof value!=='object')return undefined;
  return sampleLocations.get(value as SurfaceSample)??(locationMesh3(value)!==undefined?value as SurfaceLocation3:undefined);
}
export interface SurfaceCoordinateOptions {
  readonly uvAttribute?:string;
  readonly chartAttribute?:string;
}
interface SurfaceScatterBase extends GeometryOptions,SurfaceCoordinateOptions {
  readonly maxPoints?:number;
  /** Nonnegative per-face candidate weight, captured once; zero excludes a face. */
  readonly weight?:Field<Face,number>;
}
/** `t.scatter` on a geometry with faces: `count` points placed
 * independently, weighted by area, or points kept at least `spacing` apart.
 * One of the two, as a 2D `t.sample` takes a count or a spacing. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export type SurfaceScatterOptions<F=any>=SurfaceScatterBase&(
  |{readonly count:number;readonly spacing?:undefined;readonly maxAttempts?:undefined}
  |{
    /** Minimum Euclidean separation in world units, not paper or geodesic units. */
    readonly spacing:number;readonly count?:undefined;
    /** Candidates to try before giving up (100 000 by default). */
    readonly maxAttempts?:number;
  });
type CountOptions=Extract<SurfaceScatterOptions,{readonly count:number}>;
export interface SurfaceSamplingEnv {readonly rnd:()=>number;readonly signal?:AbortSignal}
interface Prepared{readonly mesh:Mesh3;readonly faces:readonly Face[];readonly triangles:readonly number[];readonly cumulative:readonly number[];readonly total:number;readonly extent:number;readonly origin:Vec3}
function nonnegativeInteger(value:number,name:string):void{if(!(value===Infinity||Number.isSafeInteger(value))||value<0)throw new Error(`${name} must be a nonnegative integer or Infinity`);}
function optionsObject(value:unknown):void{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('surface sampling options must be an object');}
function requireGeometry(target:unknown,who:string):asserts target is Material{if(!(target instanceof Material))throw new Error(`${who} requires a geometry with faces`);}
function prepare(target:Material,weight:Field<Face,number>|undefined):Prepared{
  const mesh=mesh3(target),positions=mesh.positions,origin=positions[0]??[0,0,0];
  const extent=positions.reduce((m,p)=>Math.max(m,...sub3(p,origin).map(Math.abs)),0);
  if(!Number.isFinite(extent))throw new Error('surface sampling extent is not representable');
  // A face the weight field could not answer, or answered negatively, is never
  // sampled. The other faces still are.
  const faces=mesh.faceCount?[...target.faces]:[],weights=faces.map(f=>Math.max(0,sampleValue(evaluate(weight??1,f),0)));
  const maxWeight=weights.reduce((a,b)=>Math.max(a,b),0),triangles:number[]=[],cumulative:number[]=[];let total=0;
  if(extent&&maxWeight)for(let i=0;i<mesh.triangleCount;i++){
    const face=mesh.triangleFace[i];if(!weights[face])continue;
    const [a,b,c]=mesh.triangle(i).map(v=>positions[v]);
    const area=Math.hypot(...cross3(mul3(sub3(b,a),1/extent),mul3(sub3(c,a),1/extent)))/2;
    const mass=area*(weights[face]/maxWeight);if(!(mass>0))continue;
    total+=mass;triangles.push(i);cumulative.push(total);
  }
  return {mesh,faces,triangles,cumulative,total,extent,origin};
}
function random(env:SurfaceSamplingEnv):number{const r=env.rnd();if(!Number.isFinite(r)||r<0||r>=1)throw new Error('surface sampling random source must return values in [0,1)');return r;}
/** The points a scatter keeps, row by row: each one's name, position,
 * face row and sample. */
class Drawn {
  readonly names:string[]=[];readonly positions:Vec3[]=[];readonly faces:number[]=[];readonly samples:SurfaceSample[]=[];
  get length():number{return this.names.length;}
  push(point:{readonly name:string;readonly position:Vec3;readonly face:number;readonly sample:SurfaceSample}):void{this.names.push(point.name);this.positions.push(point.position);this.faces.push(point.face);this.samples.push(point.sample);}
}
function draw(target:Material,prepared:Prepared,env:SurfaceSamplingEnv,index:number,coordinates:SurfaceCoordinateOptions){
  const q=random(env)*prepared.total;let lo=0,hi=prepared.cumulative.length-1;
  while(lo<hi){const mid=(lo+hi)>>>1;if(q<prepared.cumulative[mid])hi=mid;else lo=mid+1;}
  const triangle=prepared.triangles[lo],face=prepared.mesh.triangleFace[triangle];
  const root=Math.sqrt(random(env)),v=random(env),barycentric=Object.freeze([1-root,root*(1-v),root*v]) as Vec3;
  const location=surfaceLocation3(prepared.mesh,triangle,barycentric,{pointTransfers:target.transfers,uvAttribute:coordinates.uvAttribute,chartAttribute:coordinates.chartAttribute});
  return {name:JSON.stringify(['sample',index]),position:location.position,face,sample:captureSample(location,prepared.faces[face])};
}
/** The columns of sampled points: the kernel columns of the face under each,
 * then the point columns read at its place — a point column wins over a
 * face column of its name, where the face column stands. */
function sampledColumns(mesh:Mesh3,faces:readonly number[],samples:readonly SurfaceSample[]):Columns3{
  const out:Record<string,AnyColumn>={};if(!samples.length)return out;
  const faceCols=mesh.cols.faces,pointCols=mesh.cols.points;
  for(const name in faceCols)if(kernelColumn(faceCols[name]))out[name]=faceCols[name].keep(faces);
  for(const name in pointCols){
    const column=pointCols[name];if(!kernelColumn(column))continue;
    out[name]=(kindOf(column) as {from(values:readonly unknown[]):AnyColumn}).from(samples.map(s=>s.pointColumns[name]));
  }
  return out;
}
/** The samples as the one geometry: points with the face's and the place's
 * columns, `source` the face, and the `sample` each answers. */
function result(target:Material,points:Drawn,generation:SamplingGeneration,options:GeometryOptions):Material{
  const stats=Object.freeze({...generation});
  for(const sample of points.samples)generations.set(sample,stats);
  const mesh=mesh3(target),faceNames=mesh.names.faces;
  const lineage=points.faces.map((f):Provenance3=>({operation:'sample',parents:[faceNames[f]]}));
  return madeGeometry3(pointsMade3(points.positions,points.names,sampledColumns(mesh,points.faces,points.samples),lineage),{key:options.key,derived:derived('sample',target),pointCols:{sample:kinds.placement.from(points.samples)}});
}
/** `count` independent area-weighted points. */
function samplePoints(target:Material,options:CountOptions,env:SurfaceSamplingEnv):Material{
  optionsObject(options);env.signal?.throwIfAborted();requireGeometry(target,'surface sampling');
  const count=options.count,limit=options.maxPoints??Infinity;nonnegativeInteger(count,'surface sample count');nonnegativeInteger(limit,'surface sample point budget');
  if(count>limit)throw new Error('surface sampling exceeds point budget');
  const points=new Drawn();
  // A value with no faces, or with no weighted area, yields no samples rather
  // than failing: the sketch keeps drawing whatever else it holds.
  if(count){const prepared=prepare(target,options.weight);
    if(prepared.total)for(let i=0;i<count;i++){env.signal?.throwIfAborted();points.push(draw(target,prepared,env,i,options));}
  }
  return result(target,points,{attempts:count,accepted:points.length,reason:points.length===count?'count':'empty'},options);
}
/** Global dart rejection with a bounded sparse world-space neighbor grid. */
function spacedPoints(target:Material,options:SurfaceScatterOptions,env:SurfaceSamplingEnv):Material{
  optionsObject(options);env.signal?.throwIfAborted();requireGeometry(target,'surface scatter');
  const spacing=options.spacing,limit=options.maxPoints??Infinity,budget=options.maxAttempts??100_000;
  if(typeof spacing!=='number')throw new Error('surface scatter spacing must be positive finite world units');
  nonnegativeInteger(limit,'surface scatter point limit');nonnegativeInteger(budget,'surface scatter attempt limit');
  const points=new Drawn(),buckets=new Map<string,number[]>();let attempts=0,reason:SamplingGeneration['reason']='point-limit';
  // No spacing is no lattice to keep points apart: no points, and the sketch
  // keeps rendering.
  if(limit&&budget&&!emptySize(spacing)){
    const prepared=prepare(target,options.weight);
    if(prepared.extent/spacing>2**48)throw new Error('surface scatter spacing is too small relative to the mesh extent for its neighbor grid');
    reason=prepared.total?'attempt-limit':'empty';
    if(prepared.total)for(;attempts<budget&&points.length<limit;attempts++){
      env.signal?.throwIfAborted();const next=draw(target,prepared,env,attempts,options),p=next.position;
      const cell=sub3(p,prepared.origin).map(v=>Math.floor(v/spacing));let fits=true;
      for(let x=-2;x<=2&&fits;x++)for(let y=-2;y<=2&&fits;y++)for(let z=-2;z<=2&&fits;z++)for(const i of buckets.get(`${cell[0]+x},${cell[1]+y},${cell[2]+z}`)??[]){if(Math.hypot(...sub3(p,points.positions[i]))<spacing){fits=false;break;}}
      if(!fits)continue;
      const key=cell.join(','),bucket=buckets.get(key)??[];bucket.push(points.length);buckets.set(key,bucket);points.push(next);
    }
    if(points.length===limit)reason='point-limit';
  }else if(!budget&&limit)reason='attempt-limit';
  return result(target,points,{attempts,accepted:points.length,reason},options);
}
/** @internal The toolkit's `t.scatter` on a geometry with faces, with the
 * execution's seeded stream in `env`: `{ count }` places that many points
 * independently, weighted by area; `{ spacing }` keeps them at least that
 * far apart. */
export function scatterSurface(target:Material,options:SurfaceScatterOptions,env:SurfaceSamplingEnv):Material{
  optionsObject(options);
  const {count,spacing}=options as {count?:unknown;spacing?:unknown};
  if(count!==undefined&&spacing!==undefined)throw new Error('t.scatter on a mesh takes { count } or { spacing }, not both');
  if(count===undefined&&spacing===undefined)throw new Error('t.scatter on a mesh requires { count } or { spacing }');
  return count!==undefined?samplePoints(target,options as CountOptions,env):spacedPoints(target,options,env);
}
/** The samples a value's points carry, or undefined when it carries none. */
export function samplesOf(m:Material):readonly SurfaceSample[]|undefined {
  const column=m.store.attrs.sample as {get(i:number):unknown}|undefined;
  if(column===undefined)return undefined;
  const out:SurfaceSample[]=[];
  for(let i=0;i<m.n;i++){const s=column.get(i) as SurfaceSample;if(!sampleLocations.has(s))return undefined;out.push(s);}
  return out;
}
/** `samples.rebind(edited)`: every point back on the place it was sampled
 * at, on a revision of the surface that kept its topology — the same
 * triangle, the same weights, no new sampling and no projection. Point
 * columns stay as they were; the sample and `source` are the edited
 * surface's. */
export function rebindSamples(m:Material,target:Material,options:SurfaceCoordinateOptions={}):Material{
  requireGeometry(target,'surface rebind');
  const samples=samplesOf(m);
  if(samples===undefined)throw new Error('rebind: these points carry no surface samples — t.scatter on a geometry with faces makes them');
  const surface=mesh3(target),faces=surface.faceCount?[...target.faces]:[],own=mesh3(m);
  const next:SurfaceSample[]=[],positions:Vec3[]=[],lineage:Provenance3[]=[];
  for(let i=0;i<m.n;i++){
    const location=sampleLocations.get(samples[i])!;
    if(!sameAttachment3(locationMesh3(location)!,surface))throw new Error('surface topology or authoring lineage changed; regenerate samples');
    const rebound=rebindSurfaceLocation3(location,surface,{pointTransfers:target.transfers,...options});
    const fresh=captureSample(rebound,faces[rebound.face]),stats=generations.get(samples[i]);if(stats)generations.set(fresh,stats);next.push(fresh);
    positions.push(rebound.position);lineage.push({operation:'rebind',parents:[rebound.faceId]});
  }
  // The points keep their names and kernel columns; the reference and
  // placement columns ride across from `m`, the samples over them.
  const cols:Record<string,AnyColumn>={};
  if(m.n)for(const name in own.cols.points)if(kernelColumn(own.cols.points[name]))cols[name]=own.cols.points[name];
  const made=pointsMade3(positions,own.names.points,cols,lineage);checkMade3(made);
  return madeGeometry3(made,{key:m.key,from:m,derived:derived('rebind',target),pointCols:{sample:kinds.placement.from(next)}});
}
