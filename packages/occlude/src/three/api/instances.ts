import {rotation3,alignAxis,type RotationInput} from '../rotation.js';
import {Mesh,attributeName,attributeValue,evaluate,type EdgeAttributes,type Field,type GeometryOptions,type PointRow,type FaceRow} from './mesh.js';
import {Collection} from './collection.js';
import {identity} from './identity.js';
import {assembleSurface3,type Attribute3,type Attributes3,type SurfacePoint3,type SurfaceFace3,type SurfaceEdge3,type SurfaceTriangle3} from '../geometry/surface.js';
import {transformSurface3} from '../geometry/model.js';
import {add3,mul3,finite3,type Vec3} from '../math.js';
import {captureSurfacePlacement3,type SurfacePlacement3} from '../geometry/location.js';
import {surfaceBinding3,type SurfaceBinding3} from '../curves/network.js';

export interface InstanceTransform {readonly translate:Vec3;readonly rotate:RotationInput;readonly scale:Vec3}
export interface InstanceTransformInput {readonly translate?:Vec3;readonly rotate?:RotationInput;readonly scale?:number|Vec3}
/** A source row an instance came from: a point row, or a face row for instanceOnFaces. */
export type InstanceSource={readonly id:string;readonly index:number;readonly attributes:Readonly<Attributes3>};
interface InstanceData<A extends Attributes3,S extends Attributes3,R extends InstanceSource=PointRow<S>> {readonly id:string;readonly source:R;readonly attributes:Readonly<A>;readonly transform:InstanceTransform}
// Selection and attribute edits retain actual placement ownership. Labels and
// numerically equal transforms never establish identity between unrelated rows.
const placements=new WeakMap<object,SurfacePlacement3>();
function retainPlacement<T extends object>(source:object,target:T):T {
  const placement=placements.get(source);if(placement)placements.set(target,placement);return target;
}
export type InstanceRow<A extends Attributes3={},S extends Attributes3={},R extends InstanceSource=PointRow<S>> = Readonly<Omit<A,'id'|'index'|'source'|'attributes'|'transform'> & InstanceData<A,S,R> & {index:number}>;
export interface InstanceOnPointsOptions<S extends Attributes3,R extends InstanceSource=PointRow<S>> extends GeometryOptions {
  readonly scale?:Field<R,number|Vec3>;
  readonly rotate?:Field<R,RotationInput>;
  /** World-space offset from each source point. */
  readonly offset?:Field<R,Vec3>;
}
export interface RealizeOptions {readonly maxPoints?:number;readonly maxFaces?:number}
type Combined<A,B> = Omit<A,keyof B>&B;
function key(value?:string):string|undefined{if(value!==undefined&&(typeof value!=='string'||!value))throw new Error('instance key must be a nonempty string');return value;}
function vector(value:Vec3):Vec3{finite3(value);return Object.freeze([...value]) as Vec3;}
function transform(input:InstanceTransformInput):InstanceTransform {
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('instance transform must be an object');
  const s=input.scale??1,scale=vector(typeof s==='number'?[s,s,s]:s);
  if(scale.some(v=>v===0))throw new Error('instance scale must be nonsingular');
  return Object.freeze({translate:vector(input.translate??[0,0,0]),rotate:Array.isArray(input.rotate??[0,0,0])?vector((input.rotate??[0,0,0]) as Vec3):rotation3(input.rotate!),scale});
}
function ownAttributes<A extends Attributes3>(attributes:A):Readonly<A>{
  const out:Attributes3={};for(const [name,value] of Object.entries(attributes)){
    attributeName(name);if(name==='transform')throw new Error('reserved instance attribute name: transform');out[name]=attributeValue(value);
  }return Object.freeze(out) as Readonly<A>;
}
function budget(n:number,limit:number,label:string):void{if(!(limit===Infinity||Number.isSafeInteger(limit))||limit<0)throw new Error(`realize ${label} budget must be a nonnegative integer`);if(!Number.isSafeInteger(n)||n>limit)throw new Error(`instance realization exceeds ${label} budget (${limit})`);}

/** One shared mesh prototype plus owned per-instance data. Rendering may expand
 * transformed coordinates, but authoring topology is duplicated only by realize. */
export class Instances<P extends Attributes3={},E extends EdgeAttributes={},F extends Attributes3={},A extends Attributes3={},S extends Attributes3={},R extends InstanceSource=PointRow<S>,C extends Attributes3={}> {
  readonly key?:string;
  readonly rows:readonly InstanceRow<A,S,R>[];
  constructor(readonly prototype:Mesh<P,E,F,C>,rows:readonly InstanceData<A,S,R>[],options:GeometryOptions={}) {
    if(!(prototype instanceof Mesh))throw new Error('mesh instances require a mesh prototype');
    this.key=key(options.key);
    if(new Set(rows.map(r=>r.id)).size!==rows.length)throw new Error('instance IDs must be unique');
    this.rows=Object.freeze(rows.map((row,index)=>{
      const attributes=ownAttributes(row.attributes as A),captured=transform(row.transform);
      const value=Object.freeze({...attributes,id:row.id,index,source:row.source,attributes,transform:captured}) as InstanceRow<A,S,R>;
      placements.set(value,placements.get(row)??captureSurfacePlacement3({id:row.id,transform:captured})!);
      return value;
    }));
    Object.freeze(this);
  }
  get length():number{return this.rows.length;}
  get instances():Collection<InstanceRow<A,S,R>,Instances<P,E,F,A,S,R,C>>{return new Collection(this,'instance',this.rows,ids=>new Instances<P,E,F,A,S,R,C>(this.prototype,ids.map(i=>this.rows[i]),this));}
  withKey(value:string):Instances<P,E,F,A,S,R,C>{return new Instances<P,E,F,A,S,R,C>(this.prototype,this.rows,{key:value});}
  attribute<Name extends string,Value extends Attribute3>(name:Name,field:Field<InstanceRow<A,S,R>,Value>):Instances<P,E,F,Omit<A,Name>&Record<Name,Value>,S,R,C>{
    attributeName(name);if(name==='transform')throw new Error('reserved instance attribute name: transform');
    const rows=this.rows.map(row=>retainPlacement(row,{...row,attributes:{...(row.attributes as Readonly<A>),[name]:attributeValue(evaluate(field,row))}}));
    return new Instances<P,E,F,Omit<A,Name>&Record<Name,Value>,S,R,C>(this.prototype,rows as unknown as InstanceData<Omit<A,Name>&Record<Name,Value>,S,R>[],this);
  }
  /** Replace supplied S/R/T components; omitted components retain their values.
   * Rotation accepts XYZ Euler degrees or a rotation value about the prototype origin. */
  transform(field:Field<InstanceRow<A,S,R>,InstanceTransformInput>):Instances<P,E,F,A,S,R,C>{
    return new Instances<P,E,F,A,S,R,C>(this.prototype,this.rows.map(row=>({...row,transform:transform({...(row.transform as InstanceTransform),...evaluate(field,row)})})),this);
  }
  /** Add a world-space displacement to each placement without touching topology. */
  translate(field:Field<InstanceRow<A,S,R>,Vec3>):Instances<P,E,F,A,S,R,C>{
    return this.transform(row=>{const delta=evaluate(field,row);finite3(delta);return {translate:add3(row.transform.translate,delta)};});
  }
  realize(options:RealizeOptions={}):Mesh<Combined<A,P>,Combined<A,E>,Combined<A,F>,Combined<A,C>> {
    const prototype=this.prototype.surface;
    budget(this.length*prototype.points.length,options.maxPoints??Infinity,'points');budget(this.length*prototype.faces.length,options.maxFaces??Infinity,'faces');
    const points:SurfacePoint3[]=[],faces:SurfaceFace3[]=[],edges:SurfaceEdge3[]=[],triangles:SurfaceTriangle3[]=[];
    for(const row of this.rows){
      const surface=transformSurface3(prototype,row.transform),pointOffset=points.length,faceOffset=faces.length;
      const metadata=(domain:string,id:string,attrs:Attributes3)=>({id:identity(domain,row.id,id),attributes:{...(row.attributes as Readonly<A>),...attrs},provenance:{operation:'realize',parents:[id,row.id,row.source.id]}});
      for(const p of surface.points)points.push({...p,...metadata('p',p.id,p.attributes)});
      for(const f of surface.faces)faces.push({...f,...metadata('f',f.id,f.attributes),vertices:f.vertices.map(v=>v+pointOffset),corners:f.corners?.map(c=>({...c,...metadata('corner',c.id,c.attributes)}))});
      for(const t of surface.triangles)triangles.push({face:t.face+faceOffset,vertices:t.vertices.map(v=>v+pointOffset) as [number,number,number]});
      for(const e of surface.edges)edges.push({...e,...metadata('e',e.id,e.attributes),vertices:e.vertices.map(v=>v+pointOffset) as [number,number],faces:e.faces.map(f=>f+faceOffset)});
    }
    return new Mesh(assembleSurface3(points,faces,triangles,{points,faces,edges,triangles}),{key:this.key,transfers:this.prototype.transfers,cornerTransfers:this.prototype.cornerTransfers});
  }
}
/** Internal bridge shared by surface generators and ordinary view capture. */
export function instanceSurfaceBinding3(instances:Instances<any,any,any,any,any,any,any>,row:InstanceRow<any,any,any>):SurfaceBinding3 {
  if(instances.rows[row.index]!==row)throw new Error('instance placement belongs to another collection');
  const placement=placements.get(row);if(!placement)throw new Error('instance requires an owned placement');
  return surfaceBinding3(instances.prototype.surface,placement);
}

/** Points as a collection, or anything that has one: sampled or scattered
 * points, a point cloud, a mesh (its vertices). */
export type PointsInput<R extends PointRow<{}>>=Collection<R,unknown>|{readonly points:Collection<R,unknown>};
export function instanceOnPoints<P extends Attributes3,E extends EdgeAttributes,F extends Attributes3,C extends Attributes3,R extends PointRow<{}>>(
  prototype:Mesh<P,E,F,C>,input:PointsInput<R>,options:InstanceOnPointsOptions<R['attributes'],R>={},
):Instances<P,E,F,R['attributes'],R['attributes'],R,C>{
  if(!(prototype instanceof Mesh))throw new Error('instanceOnPoints requires a mesh prototype');
  const points=input instanceof Collection?input:input&&typeof input==='object'&&'points'in input?input.points:undefined;
  if(!(points instanceof Collection)||points.domain!=='point')throw new Error('instanceOnPoints requires points: a point collection, sampled points or a mesh');
  if(!options||typeof options!=='object'||Array.isArray(options))throw new Error('instance options must be an object');
  key(options.key);if(points.length>100000)throw new Error('instance count exceeds budget (100000)');
  return new Instances<P,E,F,R['attributes'],R['attributes'],R,C>(prototype,points.map(source=>{
    const offset=evaluate(options.offset??([0,0,0] as Vec3),source);finite3(offset);
    return {id:identity('instance',prototype.key??'prototype',source.id),source,attributes:source.attributes,
      transform:transform({translate:add3([source.x,source.y,source.z],offset),rotate:evaluate(options.rotate??([0,0,0] as Vec3),source),scale:evaluate(options.scale??1,source)})};
  }),options);
}

export interface InstanceOnFacesOptions<F extends Attributes3,R extends FaceRow<F>=FaceRow<F>> extends GeometryOptions {
  readonly scale?:Field<R,number|Vec3>;
  /** Extra rotation applied after the prototype's +Z is aligned to the face normal. */
  readonly rotate?:Field<R,RotationInput>;
  /** Offset along the face normal (a number) or in world space (a triple). */
  readonly offset?:Field<R,number|Vec3>;
}
/** One prototype at every selected face: at the face center, its +Z along the
 * face normal (Blender's Instance on Points after Distribute on Faces, with
 * Align Rotation to Normal). Rows keep the face's attributes. */
export function instanceOnFaces<P extends Attributes3,E extends EdgeAttributes,F extends Attributes3,C extends Attributes3,R extends FaceRow<F>>(
  prototype:Mesh<P,E,F,C>,faces:Collection<R,unknown>,options:InstanceOnFacesOptions<F,R>={},
):Instances<P,E,F,R['attributes'],R['attributes'],R,C>{
  if(!(prototype instanceof Mesh))throw new Error('instanceOnFaces requires a mesh prototype');
  if(!(faces instanceof Collection)||faces.domain!=='face')throw new Error('instanceOnFaces requires a face collection, e.g. mesh.faces');
  if(!options||typeof options!=='object'||Array.isArray(options))throw new Error('instance options must be an object');
  key(options.key);
  return new Instances<P,E,F,R['attributes'],R['attributes'],R,C>(prototype,faces.map(face=>{
    const along=evaluate(options.offset??0,face),offset=typeof along==='number'?mul3(face.normal,along):along;finite3(offset);
    const aligned=alignAxis('z',face.normal),extra=options.rotate?rotation3(evaluate(options.rotate,face)):undefined;
    return {id:identity('instance',prototype.key??'prototype',face.id),source:face as unknown as R,attributes:face.attributes,
      transform:transform({translate:add3(face.center,offset),rotate:extra?aligned.then(extra):aligned,scale:evaluate(options.scale??1,face)})};
  }) as never,options);
}
