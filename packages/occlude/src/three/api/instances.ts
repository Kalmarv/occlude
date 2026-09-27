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
import {pointCloud,madeGeometry3,pointsMade3,kernelRows3,rowsOfColumn3,derived,type GeometryOptions} from './mesh.js';
import {points2} from './lift.js';
import {refuseDisplay} from './recipes.js';
import {evaluate,type Field} from './columns.js';
import {hasFaces} from '../geometry/value.js';
import {Material,inSpace3,type Vertex} from '../../material.js';
import {Selection} from '../../selection.js';
import {identity} from './identity.js';
import type {Attributes3,Provenance3} from '../geometry/surface.js';
import {rowColumns3,transformPosition3} from '../geometry/model.js';
import {add3,mul3,type Vec3} from '../math.js';
import {captureSurfacePlacement3} from '../geometry/location.js';
import {surfaceBinding3,type SurfaceBinding3} from '../curves/network.js';
import {mesh3,faceEdges3,checkMade3,kernelColumn,type Mesh3,type Columns3,type Domain3} from '../geometry/mesh3.js';
import {kinds,type AnyColumn} from '../../column.js';
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
  const surface=mesh3(prototype),own=mesh3(m),rows=[...m.points] as unknown as readonly (Vertex&{readonly z:number;readonly rotate:readonly number[];readonly scale:readonly number[];readonly source:unknown})[];
  out=Object.freeze(rows.map((row,index)=>{
    const id=own.names.points[index];
    const turn=row.rotate.length===3?Object.freeze([row.rotate[0],row.rotate[1],row.rotate[2]]) as Vec3:storedRotation(row.rotate);
    const transform:InstanceTransform=Object.freeze({translate:Object.freeze([row.x,row.y,row.z]) as Vec3,rotate:turn,scale:Object.freeze([row.scale[0],row.scale[1],row.scale[2]]) as Vec3});
    const {rotate:_r,scale:_s,...attributes}=rowColumns3(own,'points',index);
    for(const name in attributes){const v=attributes[name];if(Array.isArray(v))Object.freeze(v);}
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
 * a point a copy, its rows named for the prototype and the row placed at.
 * Each keeps the columns of its row, then says how it is turned and sized. */
function instances(prototype:Material,copies:readonly {readonly name:string;readonly translate:Vec3;readonly rotate:Vec3|Rotation;readonly scale:Vec3}[],source:{of:Material;domain:'points'|'faces';rows:Int32Array},options:GeometryOptions,who:string):Material {
  refuseDisplay(options,who);
  const key=checkedKey(options.key,who);
  const cols:Record<string,AnyColumn>={};
  if(copies.length){
    Object.assign(cols,kernelRows3(mesh3(source.of).cols[source.domain],source.rows));
    const rotate=turns(copies.map(c=>c.rotate)),width=rotate[0].length,turn=new Float64Array(copies.length*width),scale=new Float64Array(copies.length*3);
    copies.forEach((c,i)=>{for(let k=0;k<width;k++)turn[i*width+k]=rotate[i][k];for(let k=0;k<3;k++)scale[i*3+k]=c.scale[k];});
    cols.rotate=kinds.vector(width).of(turn);cols.scale=kinds.vector(3).of(scale);
  }
  const made=pointsMade3(copies.map(c=>c.translate),copies.map(c=>c.name),cols);checkMade3(made);
  return madeGeometry3(made,{...(key!==undefined?{key}:{}),prototype,source:{points:{source:source}}});
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
  const owner=prototype.key??'prototype',names=mesh3(points.owner as Material).names.points;
  const copies=points.map(row=>{
    const offset=evaluate(options.offset??([0,0,0] as Vec3),row);
    if(!finiteTriple(offset))throw new Error(`${who}: offset is a vector [x, y, z] — got ${JSON.stringify(offset)}`);
    const turn=placement(who,evaluate(options.rotate??([0,0,0] as Vec3),row),evaluate(options.scale??1,row));
    const r=row as unknown as Vertex&{z:number};
    return {name:identity('instance',owner,names[row.index]),translate:add3([r.x,r.y,r.z],offset),...turn};
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
  const owner=prototype.key??'prototype',names=mesh3(faces.owner as Material).names.faces;
  const copies=faces.map(face=>{
    const along=evaluate(options.offset??0,face),offset=typeof along==='number'?mul3(face.normal as Vec3,along):along;
    if(!finiteTriple(offset))throw new Error(`${who}: offset is a distance along the normal or a vector [x, y, z] — got ${JSON.stringify(along)}`);
    const aligned=alignAxis('z',face.normal as Vec3),extra=options.rotate?rotation3(evaluate(options.rotate,face)):undefined;
    const turn=placement(who,extra?aligned.then(extra):aligned,evaluate(options.scale??1,face));
    return {name:identity('instance',owner,names[face.index]),translate:add3(face.centroid as Vec3,offset),...turn};
  });
  return instances(prototype,copies,{of:faces.owner as Material,domain:'faces',rows:Int32Array.from(faces.indices)},options,who);
}

/** How a copy lays the prototype's faces: its loops — turned over by a
 * mirror, as a mirrored value's faces are — each face's triangles round its
 * loop, the prototype corner at each corner, and the edges the loops make,
 * each with the prototype edge it is: the sides first, then the loose ones. */
interface Laid3 {
  readonly loops:readonly (readonly number[])[];readonly triangles:readonly (readonly number[])[];readonly corners:readonly number[];
  readonly edges:Uint32Array;readonly names:readonly string[];readonly kept:Int32Array;readonly sides:number;
}
function laid(proto:Mesh3,turned:boolean):Laid3 {
  const loops:(readonly number[])[]=[],triangles:(readonly number[])[]=[],corners:number[]=[],start=proto.cornerStart;
  proto.loops.forEach((loop,f)=>{
    const own=proto.localTriangles(f),last=loop.length-1;
    if(!turned){loops.push(loop);triangles.push(own);for(let k=0;k<=last;k++)corners.push(start[f]+k);return;}
    const flipped:number[]=[];
    for(let k=0;k+2<own.length;k+=3)flipped.push(last-own[k],last-own[k+2],last-own[k+1]);
    loops.push(Object.freeze([...loop].reverse()));triangles.push(Object.freeze(flipped));
    for(let k=last;k>=0;k--)corners.push(start[f]+k);
  });
  const sides=faceEdges3(loops,proto.names.points).names.length,{edges,names,kept}=faceEdges3(loops,proto.names.points,proto);
  return {loops,triangles,corners,edges,names,kept,sides};
}
/** The columns of realized rows: the copy's (its instance row's, but not
 * `rotate` and `scale`), then the prototype row's — a prototype column wins
 * over a copy column of its name, where the copy column stands. A prototype
 * row of -1 reads the kind's default. */
function realizedColumns(copyCols:Columns3,protoCols:Columns3,copyRows:readonly number[],protoRows:readonly number[]):Columns3 {
  const out:Record<string,AnyColumn>={};if(!copyRows.length)return out;
  for(const name in copyCols)out[name]=copyCols[name].keep(copyRows);
  for(const name in protoCols)if(kernelColumn(protoCols[name]))out[name]=rowsOfColumn3(protoCols[name],protoRows);
  return out;
}
/** One ordinary value from every copy: the prototype's topology repeated,
 * placed as each copy is. Each row's `source` is a list of two: the
 * prototype row it copies, then its instance. */
export function realize(m:Material,options:RealizeOptions={}):Material {
  const prototype=prototypeOf(m);
  if(prototype===undefined)throw new Error('realize: this value places nothing — instanceOnPoints or instanceOnFaces makes instances to realize');
  const placed=placedOf(m),proto=mesh3(prototype),n=proto.n;
  budget(placed.length*n,options.maxPoints??Infinity,'points');budget(placed.length*proto.faceCount,options.maxFaces??Infinity,'faces');
  let plain:Laid3|undefined,turned:Laid3|undefined;
  const lays=placed.map(copy=>copy.transform.scale.filter(v=>v<0).length%2===1?(turned??=laid(proto,true)):(plain??=laid(proto,false)));
  const x=new Float64Array(placed.length*n),y=new Float64Array(placed.length*n),z=new Float64Array(placed.length*n);
  const names:Record<Domain3,string[]>={points:[],edges:[],faces:[],corners:[]},rows:Record<Domain3,number[]>={points:[],edges:[],faces:[],corners:[]},copies:Record<Domain3,number[]>={points:[],edges:[],faces:[],corners:[]};
  const lineage:Record<'points'|'edges'|'faces',Provenance3[]>={points:[],edges:[],faces:[]},loops:(readonly number[])[]=[],triangles:(readonly number[])[]=[],edges:number[]=[];
  const row=(d:Domain3,copy:Placed3,name:string,at:number):void=>{
    names[d].push(identity(d==='points'?'p':d==='edges'?'e':d==='faces'?'f':'corner',copy.id,name));rows[d].push(at);copies[d].push(copy.index);
    if(d!=='corners')lineage[d].push({operation:'realize',parents:[name,copy.id],inputs:[0,1]});
  };
  const edge=(copy:Placed3,lay:Laid3,e:number,offset:number):void=>{edges.push(lay.edges[2*e]+offset,lay.edges[2*e+1]+offset);row('edges',copy,lay.names[e],lay.kept[e]);};
  placed.forEach((copy,c)=>{
    const lay=lays[c],offset=c*n;
    for(let i=0;i<n;i++){const p=transformPosition3(proto.position(i),copy.transform);x[offset+i]=p[0];y[offset+i]=p[1];z[offset+i]=p[2];row('points',copy,proto.names.points[i],i);}
    lay.loops.forEach((loop,f)=>{loops.push(loop.map(v=>v+offset));triangles.push(lay.triangles[f]);row('faces',copy,proto.names.faces[f],f);});
    for(const at of lay.corners)row('corners',copy,proto.names.corners[at],at);
    for(let e=0;e<lay.sides;e++)edge(copy,lay,e,offset);
  });
  // The loose edges follow every copy's sides, as a surface lists them.
  placed.forEach((copy,c)=>{const lay=lays[c];for(let e=lay.sides;e<lay.names.length;e++)edge(copy,lay,e,c*n);});
  const own=mesh3(m),copyCols:Record<string,AnyColumn>={};
  for(const name in own.cols.points)if(name!=='rotate'&&name!=='scale'&&kernelColumn(own.cols.points[name]))copyCols[name]=own.cols.points[name];
  const cols={} as Record<Domain3,Columns3>;
  for(const d of ['points','edges','faces','corners'] as const)cols[d]=realizedColumns(copyCols,proto.cols[d],copies[d],rows[d]);
  const made={x,y,z,names,loops,triangles,edges:Uint32Array.from(edges),cols,lineage};checkMade3(made);
  const key=m.key;
  return madeGeometry3(made,{...(key!==undefined?{key}:{}),transfers:prototype.transfers,derived:derived('realize',prototype,m)});
}
