/**
 * Instances: one prototype with faces, placed at every point of a points
 * value. The instances ARE that points value — the one geometry, a point a
 * copy: its position is where the copy stands, and two columns say how it
 * is turned and sized: `rotate` and `scale`, three factors. `rotate` keeps
 * the turn as it was given: Euler degrees `[x, y, z]` when every copy was
 * turned that way, else a unit quaternion `[x, y, z, w]` (a rotation value's
 * `quaternion`). Scale, then rotation, then the position apply to the
 * prototype. Every word of a value of points works on them (`set`,
 * `move`, `filter`, `t.steps`), and a view draws each copy; no prototype
 * topology is copied until `realize` asks for it.
 *
 * A point's `source` is the row it was placed at — a point, or a face for
 * `instanceOnFaces` — and it keeps that row's columns.
 */
import {rotation3,alignAxis,storedRotation,type Rotation,type RotationInput} from '../rotation.js';
import {pointCloud,geometry3,derived,type GeometryOptions} from './mesh.js';
import {points2} from './lift.js';
import {refuseDisplay} from './recipes.js';
import {evaluate,type Field} from './columns.js';
import {rowName,rowAttributes,hasFaces,surfaceOf} from '../geometry/value.js';
import {Material,inSpace3,type Vertex} from '../../material.js';
import {Selection} from '../../selection.js';
import {identity} from './identity.js';
import {assembleSurface3,surface3,type Attributes3,type SurfacePoint3,type SurfaceFace3,type SurfaceEdge3,type SurfaceTriangle3} from '../geometry/surface.js';
import {ownSurface3,transformSurface3} from '../geometry/model.js';
import {add3,mul3,type Vec3} from '../math.js';
import {captureSurfacePlacement3} from '../geometry/location.js';
import {surfaceBinding3,type SurfaceBinding3} from '../curves/network.js';
import {mesh3} from '../geometry/mesh3.js';
import type {Face} from '../../faces.js';

/** How one copy is placed: scale, then rotation, then translation, applied
 * to the prototype. */
export interface InstanceTransform {readonly translate:Vec3;readonly rotate:RotationInput;readonly scale:Vec3}
export interface InstanceOnPointsOptions<R=Vertex> extends GeometryOptions {
  readonly scale?:Field<R,number|Vec3>;
  readonly rotate?:Field<R,RotationInput>;
  /** World-space offset from each source point. */
  readonly offset?:Field<R,Vec3>;
}
export interface InstanceOnFacesOptions<R extends Face=Face> extends GeometryOptions {
  readonly scale?:Field<R,number|Vec3>;
  /** Extra rotation applied after the prototype's +Z is aligned to the face normal. */
  readonly rotate?:Field<R,RotationInput>;
  /** Offset along the face normal (a number) or in world space (a triple). */
  readonly offset?:Field<R,number|Vec3>;
}
export interface RealizeOptions {readonly maxPoints?:number;readonly maxFaces?:number}

const checkedKey=(value:unknown,who:string):string|undefined=>{if(value!==undefined&&(typeof value!=='string'||!value))throw new Error(`${who}: key must be a nonempty string`);return value as string|undefined;};
function budget(n:number,limit:number,label:string):void{if(!(limit===Infinity||Number.isSafeInteger(limit))||limit<0)throw new Error(`realize ${label} budget must be a nonnegative integer`);if(!Number.isSafeInteger(n)||n>limit)throw new Error(`instance realization exceeds ${label} budget (${limit})`);}
const finiteTriple=(v:unknown):v is Vec3=>Array.isArray(v)&&v.length===3&&v.every(Number.isFinite);

/** @internal The prototype a value places at its points, or undefined for a
 * value that places nothing. */
export function prototypeOf(value:unknown):Material|undefined {
  return value instanceof Material?value.prototype:undefined;
}
/** Does this value place a prototype at its points? */
export const isInstances=(value:unknown):boolean=>prototypeOf(value)!==undefined;

/** One copy the instances place: its kernel name, its placement and the
 * surface binding of the prototype there, and its columns. */
export interface Placed3 {
  readonly id:string;readonly index:number;readonly transform:InstanceTransform;
  readonly binding:SurfaceBinding3;
  /** The copy's columns, as a view feature reads them: not `rotate` and
   * `scale`, which place it. */
  readonly attributes:Attributes3;
  /** The row it was placed at. */
  readonly source:unknown;
}
const placedCache=new WeakMap<Material,readonly Placed3[]>();
/** A copy placed the same way, in any state of its instances, is one
 * placement of the prototype, so what was attached to it stays attached: a
 * placement is the copy's row (its identity, which a write and an
 * extraction keep and another construction never shares) and its transform.
 * Kept per prototype surface. */
const placements=new WeakMap<object,Map<string,ReturnType<typeof captureSurfacePlacement3>>>();
function placementOf(surface:object,row:number,id:string,transform:InstanceTransform):NonNullable<ReturnType<typeof captureSurfacePlacement3>> {
  let known=placements.get(surface);
  if(known===undefined)placements.set(surface,known=new Map());
  const signature=JSON.stringify([row,id,transform.translate,Array.isArray(transform.rotate)?transform.rotate:(transform.rotate as Rotation).quaternion,transform.scale]);
  let placement=known.get(signature);
  if(placement===undefined)known.set(signature,placement=captureSurfacePlacement3({id,transform}));
  return placement!;
}
/** @internal Every copy a value of instances places, in row order. */
export function placedOf(m:Material):readonly Placed3[] {
  let out=placedCache.get(m);
  if(out!==undefined)return out;
  const prototype=prototypeOf(m);
  if(prototype===undefined)throw new Error('expected instances — a value that places a prototype: instanceOnPoints or instanceOnFaces');
  const surface=mesh3(prototype),rows=[...m.points] as unknown as readonly (Vertex&{readonly z:number;readonly rotate:readonly number[];readonly scale:readonly number[];readonly source:unknown})[];
  out=Object.freeze(rows.map((row,index)=>{
    const id=rowName(row,'points');
    const turn=row.rotate.length===3?Object.freeze([row.rotate[0],row.rotate[1],row.rotate[2]]) as Vec3:storedRotation(row.rotate);
    const transform:InstanceTransform=Object.freeze({translate:Object.freeze([row.x,row.y,row.z]) as Vec3,rotate:turn,scale:Object.freeze([row.scale[0],row.scale[1],row.scale[2]]) as Vec3});
    const {rotate:_r,scale:_s,...attributes}=rowAttributes(row,'points') as Attributes3;
    return Object.freeze({id,index,transform,binding:surfaceBinding3(surface,placementOf(surface,m.store.pointIds.get(index),id,transform)),attributes:Object.freeze(attributes),source:row.source});
  }));
  placedCache.set(m,out);
  return out;
}

/** One copy's placement, read from its source row: its turn as given (Euler
 * degrees, or a rotation value), and its three factors. */
function placement(who:string,rotate:RotationInput,scale:number|Vec3):{rotate:Vec3|Rotation;scale:Vec3} {
  const factors=typeof scale==='number'?[scale,scale,scale]:scale;
  // A zero scale collapses that copy to nothing to draw, the same way a
  // zero size makes an empty mesh. It is not a fault in the placement.
  if(!finiteTriple(factors))throw new Error(`${who}: scale is a number or three factors [x, y, z] — got ${JSON.stringify(scale)}`);
  if(Array.isArray(rotate)&&!finiteTriple(rotate))throw new Error(`${who}: rotate is Euler degrees [x, y, z] or a rotation value — got ${JSON.stringify(rotate)}`);
  return {rotate:Array.isArray(rotate)?Object.freeze([rotate[0],rotate[1],rotate[2]]) as Vec3:rotation3(rotate),scale:Object.freeze([factors[0],factors[1],factors[2]]) as Vec3};
}
/** The turns of every copy as one column's values: Euler degrees when every
 * copy was turned that way, else unit quaternions. */
const turns=(given:readonly (Vec3|Rotation)[]):readonly (readonly number[])[]=>
  given.every(r=>Array.isArray(r))?given as readonly Vec3[]:given.map(r=>Array.isArray(r)?rotation3(r).quaternion:(r as Rotation).quaternion);
/** The instances of `prototype` at these copies: a points value in space,
 * a point a copy, its rows named for the prototype and the row placed at. */
function instances(prototype:Material,copies:readonly {readonly name:string;readonly translate:Vec3;readonly rotate:Vec3|Rotation;readonly scale:Vec3;readonly attributes:Attributes3}[],source:{of:Material;domain:'points'|'faces';rows:Int32Array},options:GeometryOptions,who:string):Material {
  refuseDisplay(options,who);
  const key=checkedKey(options.key,who);
  const base=surface3(copies.map(c=>c.translate),[]),rotate=turns(copies.map(c=>c.rotate));
  const points:SurfacePoint3[]=base.points.map((p,i)=>({...p,id:copies[i].name,attributes:{...copies[i].attributes,rotate:rotate[i],scale:copies[i].scale}}));
  return geometry3(ownSurface3({...base,points}),{...(key!==undefined?{key}:{}),prototype,source:{points:{source:source}}});
}
function checkPrototype(prototype:unknown,who:string):asserts prototype is Material {
  if(!(prototype instanceof Material)||!hasFaces(prototype)&&prototype.n>0)throw new Error(`${who}: the prototype is a value with faces — a mesh, a box, a sphere`);
}

/** One prototype at every point of a point set: the point's position plus
 * `offset`, turned by `rotate` and sized by `scale`, each a constant or a
 * field of the point. 2D points stand on the ground plane, z = 0, with
 * their columns. */
export function instanceOnPoints<R extends Vertex>(prototype:Material,input:Selection<R>|{readonly points:Selection<R>}|Iterable<{readonly x:number;readonly y:number}>|readonly (readonly [number,number])[],options:InstanceOnPointsOptions<R>={}):Material {
  const who='instanceOnPoints';
  checkPrototype(prototype,who);
  const isPoints=(v:unknown):v is Selection<R>=>v instanceof Selection&&v.domain.kind.name==='point';
  const held=input instanceof Selection?input:input&&typeof input==='object'&&'points' in input?(input as {points:unknown}).points:undefined;
  // 2D points stand on the ground plane: z = 0, ids and columns kept.
  const points=isPoints(held)&&inSpace3(held.owner as Material)?held:points2(input,who)?pointCloud(input as Iterable<{x:number;y:number}>).points as unknown as Selection<R>:undefined;
  if(!isPoints(points))throw new Error(`${who}: expected points — a point selection, a value of points, or 2D points`);
  if(!options||typeof options!=='object'||Array.isArray(options))throw new Error(`${who}: options are a record { scale, rotate, offset, key }`);
  if(points.length>100000)throw new Error('instance count exceeds budget (100000)');
  const owner=prototype.key??'prototype';
  const copies=points.map(row=>{
    const offset=evaluate(options.offset??([0,0,0] as Vec3),row);
    if(!finiteTriple(offset))throw new Error(`${who}: offset is a vector [x, y, z] — got ${JSON.stringify(offset)}`);
    const turn=placement(who,evaluate(options.rotate??([0,0,0] as Vec3),row),evaluate(options.scale??1,row));
    const r=row as unknown as Vertex&{z:number};
    return {name:identity('instance',owner,rowName(row,'points')),translate:add3([r.x,r.y,r.z],offset),...turn,attributes:rowAttributes(row,'points') as Attributes3};
  });
  return instances(prototype,copies,{of:points.owner as Material,domain:'points',rows:Int32Array.from(points.indices)},options,who);
}

/** One prototype at every selected face: at the face's centroid, its +Z
 * along the face normal (Blender's Instance on Points after Distribute on
 * Faces, with Align Rotation to Normal). Each copy keeps the face's
 * columns. */
export function instanceOnFaces<R extends Face>(prototype:Material,faces:Selection<R>,options:InstanceOnFacesOptions<R>={}):Material {
  const who='instanceOnFaces';
  checkPrototype(prototype,who);
  if(!(faces instanceof Selection&&faces.domain.kind.name==='face'))throw new Error(`${who}: expected faces — a face selection, such as mesh.faces`);
  if(!options||typeof options!=='object'||Array.isArray(options))throw new Error(`${who}: options are a record { scale, rotate, offset, key }`);
  const owner=prototype.key??'prototype';
  const copies=faces.map(face=>{
    const along=evaluate(options.offset??0,face),offset=typeof along==='number'?mul3(face.normal as Vec3,along):along;
    if(!finiteTriple(offset))throw new Error(`${who}: offset is a distance along the normal or a vector [x, y, z] — got ${JSON.stringify(along)}`);
    const aligned=alignAxis('z',face.normal as Vec3),extra=options.rotate?rotation3(evaluate(options.rotate,face)):undefined;
    const turn=placement(who,extra?aligned.then(extra):aligned,evaluate(options.scale??1,face));
    return {name:identity('instance',owner,rowName(face,'faces')),translate:add3(face.centroid as Vec3,offset),...turn,attributes:rowAttributes(face,'faces') as Attributes3};
  });
  return instances(prototype,copies,{of:faces.owner as Material,domain:'faces',rows:Int32Array.from(faces.indices)},options,who);
}

/** One ordinary value from every copy: the prototype's topology repeated,
 * placed as each copy is. Each row's `source` is a list of two: the
 * prototype row it copies, then its instance. */
export function realize(m:Material,options:RealizeOptions={}):Material {
  const prototype=prototypeOf(m);
  if(prototype===undefined)throw new Error('realize: this value places nothing — instanceOnPoints or instanceOnFaces makes instances to realize');
  const placed=placedOf(m),surface=surfaceOf(prototype);
  budget(placed.length*surface.points.length,options.maxPoints??Infinity,'points');budget(placed.length*surface.faces.length,options.maxFaces??Infinity,'faces');
  const points:SurfacePoint3[]=[],faces:SurfaceFace3[]=[],edges:SurfaceEdge3[]=[],triangles:SurfaceTriangle3[]=[];
  for(const copy of placed){
    const moved=transformSurface3(surface,copy.transform),pointOffset=points.length,faceOffset=faces.length;
    const metadata=(domain:string,id:string,attrs:Attributes3)=>({id:identity(domain,copy.id,id),attributes:{...copy.attributes,...attrs},provenance:{operation:'realize',parents:[id,copy.id],inputs:[0,1]}});
    for(const p of moved.points)points.push({...p,...metadata('p',p.id,p.attributes)});
    for(const f of moved.faces)faces.push({...f,...metadata('f',f.id,f.attributes),vertices:f.vertices.map(v=>v+pointOffset),corners:f.corners?.map(c=>({...c,...metadata('corner',c.id,c.attributes)}))});
    for(const t of moved.triangles)triangles.push({face:t.face+faceOffset,vertices:t.vertices.map(v=>v+pointOffset) as [number,number,number]});
    for(const e of moved.edges)edges.push({...e,...metadata('e',e.id,e.attributes),vertices:e.vertices.map(v=>v+pointOffset) as [number,number],faces:e.faces.map(f=>f+faceOffset)});
  }
  const key=m.key;
  return geometry3(assembleSurface3(points,faces,triangles,{points,faces,edges,triangles}),{...(key!==undefined?{key}:{}),transfers:prototype.transfers,derived:derived('realize',prototype,m)});
}
