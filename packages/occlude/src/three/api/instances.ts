import {rotation3,type RotationInput} from '../rotation.js';
import {Mesh,attributeName,attributeValue,evaluate,type EdgeAttributes,type Field,type GeometryOptions,type PointRow} from './mesh.js';
import {Collection} from './collection.js';
import {identity} from './identity.js';
import {assembleSurface3,type Attribute3,type Attributes3,type SurfacePoint3,type SurfaceFace3,type SurfaceEdge3,type SurfaceTriangle3} from '../geometry/surface.js';
import {transformSurface3} from '../geometry/model.js';
import {add3,finite3,type Vec3} from '../math.js';

export interface InstanceTransform {readonly translate:Vec3;readonly rotate:RotationInput;readonly scale:Vec3}
export interface InstanceTransformInput {readonly translate?:Vec3;readonly rotate?:RotationInput;readonly scale?:number|Vec3}
interface InstanceData<A extends Attributes3,S extends Attributes3,R extends PointRow<{}>=PointRow<S>> {readonly id:string;readonly source:R;readonly attributes:Readonly<A>;readonly transform:InstanceTransform}
export type InstanceRow<A extends Attributes3={},S extends Attributes3={},R extends PointRow<{}>=PointRow<S>> = Readonly<Omit<A,'id'|'index'|'source'|'attributes'|'transform'> & InstanceData<A,S,R> & {index:number}>;
export interface InstanceOnPointsOptions<S extends Attributes3,R extends PointRow<{}>=PointRow<S>> extends GeometryOptions {
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
function budget(n:number,limit:number,label:string):void{if(!Number.isSafeInteger(limit)||limit<0)throw new Error(`realize ${label} budget must be a nonnegative integer`);if(!Number.isSafeInteger(n)||n>limit)throw new Error(`instance realization exceeds ${label} budget (${limit})`);}

/** One shared mesh prototype plus owned per-instance data. Rendering may expand
 * transformed coordinates, but authoring topology is duplicated only by realize. */
export class Instances<P extends Attributes3={},E extends EdgeAttributes={},F extends Attributes3={},A extends Attributes3={},S extends Attributes3={},R extends PointRow<{}>=PointRow<S>,C extends Attributes3={}> {
  readonly key?:string;
  readonly rows:readonly InstanceRow<A,S,R>[];
  constructor(readonly prototype:Mesh<P,E,F,C>,rows:readonly InstanceData<A,S,R>[],options:GeometryOptions={}) {
    if(!(prototype instanceof Mesh))throw new Error('mesh instances require a mesh prototype');
    this.key=key(options.key);
    if(new Set(rows.map(r=>r.id)).size!==rows.length)throw new Error('instance IDs must be unique');
    this.rows=Object.freeze(rows.map((row,index)=>{const attributes=ownAttributes(row.attributes as A);return Object.freeze({...attributes,id:row.id,index,source:row.source,attributes,transform:transform(row.transform)}) as InstanceRow<A,S,R>;}));
    Object.freeze(this);
  }
  get length():number{return this.rows.length;}
  get instances():Collection<InstanceRow<A,S,R>,Instances<P,E,F,A,S,R,C>>{return new Collection(this,'instance',this.rows,ids=>new Instances<P,E,F,A,S,R,C>(this.prototype,ids.map(i=>this.rows[i]),this));}
  withKey(value:string):Instances<P,E,F,A,S,R,C>{return new Instances<P,E,F,A,S,R,C>(this.prototype,this.rows,{key:value});}
  attribute<Name extends string,Value extends Attribute3>(name:Name,field:Field<InstanceRow<A,S,R>,Value>):Instances<P,E,F,Omit<A,Name>&Record<Name,Value>,S,R,C>{
    attributeName(name);if(name==='transform')throw new Error('reserved instance attribute name: transform');
    const rows=this.rows.map(row=>({...row,attributes:{...(row.attributes as Readonly<A>),[name]:attributeValue(evaluate(field,row))}}));
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
    budget(this.length*prototype.points.length,options.maxPoints??500000,'points');budget(this.length*prototype.faces.length,options.maxFaces??250000,'faces');
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

export function instanceOnPoints<P extends Attributes3,E extends EdgeAttributes,F extends Attributes3,C extends Attributes3,R extends PointRow<{}>>(
  prototype:Mesh<P,E,F,C>,points:Collection<R,unknown>,options:InstanceOnPointsOptions<R['attributes'],R>={},
):Instances<P,E,F,R['attributes'],R['attributes'],R,C>{
  if(!(prototype instanceof Mesh))throw new Error('instanceOnPoints requires a mesh prototype');
  if(!(points instanceof Collection)||points.domain!=='point')throw new Error('instanceOnPoints requires a point collection');
  if(!options||typeof options!=='object'||Array.isArray(options))throw new Error('instance options must be an object');
  key(options.key);if(points.length>100000)throw new Error('instance count exceeds budget (100000)');
  return new Instances<P,E,F,R['attributes'],R['attributes'],R,C>(prototype,points.map(source=>{
    const offset=evaluate(options.offset??([0,0,0] as Vec3),source);finite3(offset);
    return {id:identity('instance',prototype.key??'prototype',source.id),source,attributes:source.attributes,
      transform:transform({translate:add3([source.x,source.y,source.z],offset),rotate:evaluate(options.rotate??([0,0,0] as Vec3),source),scale:evaluate(options.scale??1,source)})};
  }),options);
}
