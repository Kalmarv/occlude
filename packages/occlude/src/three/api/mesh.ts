import type {RotationInput} from '../rotation.js';
import {inheritTopology3} from '../geometry/topology.js';
import {meshPoints,meshEdges,meshFaces,type MeshPoints,type MeshEdges,type MeshFaces,type MeshPointRow,type MeshEdgeRow,type MeshFaceRow} from './topology.js';
import {assembleSurface3,surface3,box3,type Surface3,type SurfacePoint3,type Attributes3,type Attribute3,type Provenance3} from '../geometry/surface.js';
import {snapshotSurface3,cloneSurface3,transformSurface3,measureFaces3} from '../geometry/model.js';
import {add3,sub3,finite3,type Vec3} from '../math.js';
import {Collection} from './collection.js';
import {subdivideSurface,type SubdivisionOptions,type PointTransfers} from './subdivide.js';
export type Field<Row,Value> = Value | ((row:Row)=>Value);
export type AttributeFields<Row,A extends Attributes3> = {readonly [K in keyof A]:Field<Row,A[K]>};
type StepValue<V> = V extends number ? number : V extends string ? string : V extends boolean ? boolean : V extends readonly number[] ? {readonly [I in keyof V]:number} : V;
/** A frozen pass may change values, so literal columns widen to their value kind. */
export type StepAttributes<A> = {[K in keyof A]:StepValue<A[K]>};
export interface AttributeOptions {readonly transfer?:PointTransfers}
export type EdgeAttributes = Record<string,Attribute3|undefined>;
export interface GeometryOptions {readonly key?:string}
export type PointRow<A extends Attributes3={}> = Readonly<A & {id:string;index:number;x:number;y:number;z:number;attributes:Readonly<A>;provenance?:Provenance3}>;
export type EdgeRow<A extends EdgeAttributes={},P extends Attributes3={}> = Readonly<A & {id:string;index:number;vertices:readonly [number,number];a:PointRow<P>; b:PointRow<P>;length:number;attributes:Readonly<A>;provenance?:Provenance3}>;
export type FaceRow<A extends Attributes3={}> = Readonly<A & {id:string;index:number;vertices:readonly number[];normal:Vec3;center:Vec3;area:number;attributes:Readonly<A>;provenance?:Provenance3}>;
const reserved=new Set(['id','index','x','y','z','attributes','provenance','vertices','normal','center','area','a','b','length','source','sample','points','edges','faces','adjacent']);
export function attributeName(name:string):void {if(!name||reserved.has(name)||name==='__proto__'||name==='constructor'||name==='prototype')throw new Error(`reserved or empty geometry attribute name: ${name}`);}
export function attributeValue(value:Attribute3):Attribute3 {
  if(typeof value==='string'||typeof value==='boolean')return value;
  if(typeof value==='number'&&Number.isFinite(value))return value;
  if(Array.isArray(value)&&value.every(Number.isFinite))return Object.freeze([...value]);
  throw new Error('geometry attribute must be a string, boolean, finite number or finite numeric array');
}
function attributeRecord(value:unknown):asserts value is Record<string,Attribute3> {
  if(value&&typeof (value as PromiseLike<unknown>).then==='function'){
    void Promise.resolve(value).catch(()=>{});
    throw new Error('attribute fields must be synchronous');
  }
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('attribute edit requires a record');
}
export function evaluate<R,V>(field:Field<R,V>,row:R):V{return typeof field==='function'?(field as (row:R)=>V)(row):field;}
const pointCache=new WeakMap<Surface3,readonly PointRow[]>();
function pointRows<P extends Attributes3>(surface:Surface3):readonly PointRow<P>[] {
  let rows=pointCache.get(surface);
  if(!rows){rows=Object.freeze(surface.points.map((p,index)=>Object.freeze({...p.attributes,id:p.id,index,x:p.position[0],y:p.position[1],z:p.position[2],attributes:p.attributes,provenance:p.provenance})));pointCache.set(surface,rows);}
  return rows as unknown as readonly PointRow<P>[];
}
function checkOptions(options:GeometryOptions):void{if(!options||typeof options!=='object'||Array.isArray(options))throw new Error('geometry options must be an object; plane subdivisions use .subdivide(levels)');}
function checkedKey(key?:string):string|undefined {if(key!==undefined&&(typeof key!=='string'||!key))throw new Error('geometry key must be a nonempty string');return key;}
function validateAttributes(surface:Surface3):void {for(const rows of [surface.points,surface.edges,surface.faces])for(const row of rows)for(const [name,value] of Object.entries(row.attributes)){attributeName(name);attributeValue(value);}}
function pointsOnly(surface:Surface3,indices:readonly number[]):Surface3{return assembleSurface3(indices.map(i=>surface.points[i]),[],[]);}
function setPoints<R extends PointRow<any>>(surface:Surface3,name:string,field:Field<R,Attribute3>,rows:readonly R[]=pointRows(surface) as readonly R[]):Surface3 {
  attributeName(name);const values=rows.map(row=>attributeValue(evaluate(field,row)));
  return assembleSurface3(surface.points.map((p,i)=>({...p,attributes:{...p.attributes,[name]:values[i]}})),surface.faces,surface.triangles,surface);
}
/** All initializers observe the same incoming rows, never newly written columns. */
export function captureAttributeFields<R,A extends Attributes3>(rows:readonly R[],fields:AttributeFields<R,A>):readonly Attributes3[] {
  if(!fields||typeof fields!=='object'||Array.isArray(fields))throw new Error('attributes requires a map of named fields');
  attributeRecord(fields);
  const entries=Object.entries(fields);entries.forEach(([name])=>attributeName(name));
  return rows.map(row=>Object.fromEntries(entries.map(([name,field])=>[name,attributeValue(evaluate(field,row))])));
}
function setPointFields<R extends PointRow<any>,A extends Attributes3>(surface:Surface3,fields:AttributeFields<R,A>,rows:readonly R[]=pointRows(surface) as readonly R[]):Surface3 {
  const values=captureAttributeFields(rows,fields);
  return assembleSurface3(surface.points.map((p,i)=>({...p,attributes:{...p.attributes,...values[i]}})),surface.faces,surface.triangles,surface);
}
function pointTransfers(previous:PointTransfers,fields:object,options:AttributeOptions):PointTransfers {
  const result={...previous};
  for(const [name,policy] of Object.entries(options.transfer??{})){
    if(!Object.hasOwn(fields,name))throw new Error(`attribute transfer names '${name}', which is not being set`);
    if(policy!=='nearest'&&policy!=='interpolate')throw new Error('attribute transfer must be nearest or interpolate');
    result[name]=policy;
  }
  return result;
}
function displaced<R extends PointRow<any>>(surface:Surface3,field:Field<R,Vec3>,rows:readonly R[]=pointRows(surface) as readonly R[]):Surface3 {
  const points=rows.map((row,i)=>{const delta=evaluate(field,row);finite3(delta);return {...surface.points[i],position:add3(surface.points[i].position,delta)};});
  return assembleSurface3(points,surface.faces,surface.triangles,surface);
}

export interface PointSnapshot<P extends Attributes3,G extends PointGeometry<P>=PointGeometry<P>> {readonly iteration:number;readonly geometry:G}
export type PointRule<P extends Attributes3,R extends PointRow<P>=PointRow<P>,G extends PointGeometry<P>=PointGeometry<P>>=(current:G,next:PointEdit<P,R>,k:number)=>void;
const pointHistory=new WeakMap<object,readonly PointSnapshot<any>[]>();

/** Point geometry has a point domain; it never claims editable mesh faces. */
export class PointGeometry<P extends Attributes3={}> {
  readonly surface:Surface3;readonly key?:string;readonly iteration:number;
  constructor(surface:Surface3,options:GeometryOptions&{iteration?:number;history?:readonly PointSnapshot<P>[]}={}){
    checkOptions(options);validateAttributes(surface);this.surface=snapshotSurface3(surface);this.key=checkedKey(options.key);this.iteration=options.iteration??0;
    pointHistory.set(this,Object.freeze([...(options.history??[])]));Object.freeze(this);
  }
  get history():readonly PointSnapshot<P>[]{return pointHistory.get(this)!;}
  get points():Collection<PointRow<P>,PointGeometry<P>>{return new Collection(this.surface,'point',pointRows<P>(this.surface),indices=>new PointGeometry(pointsOnly(this.surface,indices)));}
  attribute<Name extends string,Value extends Attribute3>(name:Name,field:Field<PointRow<P>,Value>):PointGeometry<Omit<P,Name>&Record<Name,Value>>{return new PointGeometry<Omit<P,Name>&Record<Name,Value>>(setPoints(this.surface,name,field),{...this,history:[]});}
  attributes<A extends Attributes3>(fields:AttributeFields<PointRow<P>,A>):PointGeometry<Omit<P,keyof A>&A>{return new PointGeometry<Omit<P,keyof A>&A>(setPointFields(this.surface,fields),{...this,history:[]});}
  displace(field:Field<PointRow<P>,Vec3>):PointGeometry<P>{return new PointGeometry(displaced(this.surface,field),{...this,history:[]});}
  translate(offset:Vec3):PointGeometry<P>{return new PointGeometry(transformSurface3(this.surface,{translate:offset}),{...this,history:[]});}
  rotate(angles:RotationInput,origin:Vec3=[0,0,0]):PointGeometry<P>{return new PointGeometry(transformSurface3(this.surface,{rotate:angles,origin}),{...this,history:[]});}
  scale(scale:number|Vec3,origin:Vec3=[0,0,0]):PointGeometry<P>{return new PointGeometry(transformSurface3(this.surface,{scale:typeof scale==='number'?[scale,scale,scale]:scale,origin}),{...this,history:[]});}
  withKey(key:string):PointGeometry<P>{return new PointGeometry(this.surface,{key,iteration:this.iteration,history:this.history});}
  steps(count:number,rule:PointRule<StepAttributes<P>>,...passesAndOptions:(PointRule<StepAttributes<P>>|StepsOptions)[]):PointGeometry<StepAttributes<P>>{
    return pointSteps(this,count,rule,passesAndOptions,(surface,iteration,history)=>new PointGeometry<StepAttributes<P>>(surface,{key:this.key,iteration,history}));
  }
}

/** Point editors expose only operations meaningful to point geometry. */
export class PointEdit<P extends Attributes3,R extends PointRow<P>=PointRow<P>> {
  private active=true;
  constructor(private readonly rows:Collection<R,unknown>,private readonly input:Mesh<P,{},{}>,private readonly edit:MeshEdit<P,{},{}>){}
  private bind(selection:Collection<R,unknown>){
    if(!this.active)throw new Error('point editor is closed');
    if(!(selection instanceof Collection)||selection.domain!=='point'||selection.source!==this.rows.source)throw new Error('point selection belongs to another point revision');
    const indices=new Set(selection.indices),rows=new Map(selection.map(p=>[p.index,p]));
    return {selection:this.input.points.filter(p=>indices.has(p.index)),rows};
  }
  move(selection:Collection<R,unknown>,field:Field<R,Vec3>):void{
    const bound=this.bind(selection);this.edit.move(bound.selection,p=>evaluate(field,bound.rows.get(p.index)!));
  }
  set(target:Collection<R,unknown>|R,field:Field<R,Partial<P>>):void{
    if(!this.active)throw new Error('point editor is closed');
    let selected:Collection<R,unknown>;
    if(target instanceof Collection)selected=target;
    else {if(!this.rows.has(target))throw new Error('edit row belongs to another point revision');selected=this.rows.filter(p=>p.index===target.index);}
    const bound=this.bind(selected);this.edit.set(bound.selection,p=>evaluate(field,bound.rows.get(p.index)!));
  }
  close():void{this.active=false;}
}
/** Shared point-pass driver lets rich point geometry retain its own row context. */
export function pointSteps<P extends Attributes3,R extends PointRow<StepAttributes<P>>,G extends PointGeometry<StepAttributes<P>> & {readonly points:Collection<R,unknown>}>(
  initial:PointGeometry<P>,count:number,rule:PointRule<StepAttributes<P>,R,G>,passesAndOptions:readonly (PointRule<StepAttributes<P>,R,G>|StepsOptions)[],
  create:(surface:Surface3,iteration:number,history?:readonly PointSnapshot<StepAttributes<P>,G>[])=>G,
):G {
  const pass=(rule:PointRule<StepAttributes<P>,R,G>):MeshRule<StepAttributes<P>,{},{}>=>(input,next,k)=>{
    const current=create(input.surface,input.iteration),edit=new PointEdit<StepAttributes<P>,R>(current.points,input,next);
    try{return rule(current,edit,k);}finally{edit.close();}
  };
  const passes=passesAndOptions.map(p=>typeof p==='function'?pass(p):p);
  const result=new Mesh<P,{},{}>(initial.surface,{key:initial.key,iteration:initial.iteration}).steps(count,pass(rule),...passes);
  const history=result.history.map(row=>Object.freeze({iteration:row.iteration,geometry:create(row.geometry.surface,row.iteration)}));
  return create(result.surface,result.iteration,history);
}

/** Owned polyline/edge-graph data with point and edge domains, never faces. */
export class CurveGeometry<P extends Attributes3={},E extends EdgeAttributes={}> {
  readonly surface:Surface3;readonly key?:string;readonly iteration:number;
  readonly history:readonly CurveSnapshot<P,E>[];
  readonly segments:readonly {readonly id:string;readonly vertices:readonly [number,number];readonly attributes:Readonly<Partial<E>>;readonly provenance?:Provenance3}[];
  constructor(surface:Surface3,indices:readonly number[],options:GeometryOptions&{iteration?:number;history?:readonly CurveSnapshot<P,E>[]}={}) {
    checkOptions(options);validateAttributes(surface);
    if(indices.some(i=>!Number.isSafeInteger(i)||!surface.edges[i]))throw new Error('invalid curve edge index');
    const selected=[...new Set(indices)],used=[...new Set(selected.flatMap(i=>surface.edges[i].vertices))].sort((a,b)=>a-b);
    const mapping=new Map(used.map((v,i)=>[v,i]));
    const source:Surface3={points:used.map(i=>surface.points[i]),faces:[],triangles:[],edges:selected.map(i=>({...surface.edges[i],vertices:surface.edges[i].vertices.map(v=>mapping.get(v)!) as [number,number],faces:[]}))};
    this.surface=snapshotSurface3(source);this.key=checkedKey(options.key);
    this.iteration=options.iteration??0;this.history=Object.freeze([...(options.history??[])]);
    this.segments=this.surface.edges as unknown as typeof this.segments;Object.freeze(this);
  }
  get points():Collection<PointRow<P>,PointGeometry<P>>{return new Collection(this.surface,'point',pointRows<P>(this.surface),ids=>new PointGeometry(pointsOnly(this.surface,ids)));}
  get edges():Collection<EdgeRow<E,P>,CurveGeometry<P,E>>{
    const points=pointRows<P>(this.surface);
    const rows=this.surface.edges.map((e,index)=>Object.freeze({...e.attributes,id:e.id,index,vertices:e.vertices,a:points[e.vertices[0]],b:points[e.vertices[1]],length:Math.hypot(...sub3(this.surface.points[e.vertices[0]].position,this.surface.points[e.vertices[1]].position)),attributes:e.attributes,provenance:e.provenance})) as unknown as readonly EdgeRow<E,P>[];
    return new Collection(this.surface,'edge',rows,indices=>new CurveGeometry<P,E>(this.surface,indices));
  }
  attribute<Name extends string,Value extends Attribute3>(name:Name,field:Field<PointRow<P>,Value>):CurveGeometry<Omit<P,Name>&Record<Name,Value>,E>{return new CurveGeometry<Omit<P,Name>&Record<Name,Value>,E>(setPoints(this.surface,name,field),this.surface.edges.map((_,i)=>i),{...this,history:[]});}
  attributes<A extends Attributes3>(fields:AttributeFields<PointRow<P>,A>):CurveGeometry<Omit<P,keyof A>&A,E>{return new CurveGeometry<Omit<P,keyof A>&A,E>(setPointFields(this.surface,fields),this.surface.edges.map((_,i)=>i),{...this,history:[]});}
  edgeAttributes<A extends Attributes3>(fields:AttributeFields<EdgeRow<E,P>,A>):CurveGeometry<P,Omit<E,keyof A>&A>{
    const values=captureAttributeFields([...this.edges],fields),surface=cloneSurface3(this.surface);
    surface.edges.forEach((edge,i)=>Object.assign(edge.attributes,values[i]));
    return new CurveGeometry<P,Omit<E,keyof A>&A>(surface,surface.edges.map((_,i)=>i),{...this,history:[]});
  }
  edgeAttribute<Name extends string,Value extends Attribute3>(name:Name,field:Field<EdgeRow<E,P>,Value>):CurveGeometry<P,Omit<E,Name>&Record<Name,Value>>{
    attributeName(name);const values=this.edges.map(row=>attributeValue(evaluate(field,row))),surface=cloneSurface3(this.surface);
    surface.edges.forEach((e,i)=>e.attributes[name]=values[i]);return new CurveGeometry<P,Omit<E,Name>&Record<Name,Value>>(surface,surface.edges.map((_,i)=>i),{...this,history:[]});
  }
  private changed(surface:Surface3):CurveGeometry<P,E>{return new CurveGeometry(surface,surface.edges.map((_,i)=>i),{...this,history:[]});}
  displace(field:Field<PointRow<P>,Vec3>):CurveGeometry<P,E>{return this.changed(displaced(this.surface,field));}
  translate(offset:Vec3):CurveGeometry<P,E>{return this.changed(transformSurface3(this.surface,{translate:offset}));}
  rotate(angles:RotationInput,origin:Vec3=[0,0,0]):CurveGeometry<P,E>{return this.changed(transformSurface3(this.surface,{rotate:angles,origin}));}
  scale(scale:number|Vec3,origin:Vec3=[0,0,0]):CurveGeometry<P,E>{return this.changed(transformSurface3(this.surface,{scale:typeof scale==='number'?[scale,scale,scale]:scale,origin}));}
  withKey(key:string):CurveGeometry<P,E>{return new CurveGeometry(this.surface,this.surface.edges.map((_,i)=>i),{...this,key});}
  steps(count:number,rule:CurveRule<StepAttributes<P>,StepAttributes<E>>,...passesAndOptions:(CurveRule<StepAttributes<P>,StepAttributes<E>>|StepsOptions)[]):CurveGeometry<StepAttributes<P>,StepAttributes<E>>{
    const pass=(rule:CurveRule<StepAttributes<P>,StepAttributes<E>>):MeshRule<StepAttributes<P>,StepAttributes<E>,{}>=>(input,next,k)=>{
      const current=new CurveGeometry<StepAttributes<P>,StepAttributes<E>>(input.surface,input.surface.edges.map((_,i)=>i),{key:this.key,iteration:input.iteration});
      // Bind the public curve selection to the underlying frozen point pass.
      const edit=new CurveEdit(current,input,next);
      try{return rule(current,edit,k);}finally{edit.close();}
    };
    const options=passesAndOptions.map(p=>typeof p==='function'?pass(p):p);
    const result=new Mesh<P,E,{}>(this.surface,{key:this.key,iteration:this.iteration}).steps(count,pass(rule),...options);
    const convert=(value:Mesh<StepAttributes<P>,StepAttributes<E>,{}>)=>new CurveGeometry<StepAttributes<P>,StepAttributes<E>>(value.surface,value.surface.edges.map((_,i)=>i),{key:this.key,iteration:value.iteration});
    return new CurveGeometry<StepAttributes<P>,StepAttributes<E>>(result.surface,result.surface.edges.map((_,i)=>i),{key:this.key,iteration:result.iteration,history:result.history.map(row=>Object.freeze({iteration:row.iteration,geometry:convert(row.geometry)}))});
  }

}

export interface CurveSnapshot<P extends Attributes3,E extends EdgeAttributes>{readonly iteration:number;readonly geometry:CurveGeometry<P,E>}
export type CurveRule<P extends Attributes3,E extends EdgeAttributes>=(current:CurveGeometry<P,E>,next:CurveEdit<P,E>,k:number)=>void;
/** Curve edits reuse the same frozen point-edit machinery as mesh steps. */
export class CurveEdit<P extends Attributes3,E extends EdgeAttributes> {
  private active=true;
  constructor(private readonly curve:CurveGeometry<P,E>,private readonly input:Mesh<P,E,{}>,private readonly edit:MeshEdit<P,E,{}>){}
  move(selection:Collection<PointRow<P>,unknown>,field:Field<PointRow<P>,Vec3>):void{
    if(!this.active)throw new Error('curve editor is closed');
    if(selection.domain!=='point'||selection.source!==this.curve.surface)throw new Error('point selection belongs to another curve revision; select from current.points');
    const indices=new Set(selection.indices),rows=new Map(selection.map(p=>[p.index,p]));
    this.edit.move(this.input.points.filter(p=>indices.has(p.index)),p=>evaluate(field,rows.get(p.index)!));
  }
  set(target:Collection<PointRow<P>,unknown>|PointRow<P>,field:Field<PointRow<P>,Partial<P>>):void{
    if(!this.active)throw new Error('curve editor is closed');
    const selection=target instanceof Collection?target:this.single(this.curve.points,target);
    if(selection.domain!=='point'||selection.source!==this.curve.surface)throw new Error('point selection belongs to another curve revision');
    const indices=new Set(selection.indices),rows=new Map(selection.map(p=>[p.index,p]));
    this.edit.set(this.input.points.filter(p=>indices.has(p.index)),p=>evaluate(field,rows.get(p.index)!));
  }
  private single<R extends {id:string;index:number}>(rows:Collection<R,unknown>,row:R):Collection<R,unknown>{
    if(!this.active)throw new Error('curve editor is closed');
    if(!rows.has(row))throw new Error('edit row belongs to another curve revision');
    return rows.filter(r=>r.index===row.index);
  }
  setEdge(row:EdgeRow<E,P>,attributes:Partial<E>):void{this.setEdges(this.single(this.curve.edges,row),attributes);}
  setEdges(selection:Collection<EdgeRow<E,P>,unknown>,field:Field<EdgeRow<E,P>,Partial<E>>):void{
    if(!this.active)throw new Error('curve editor is closed');
    if(selection.domain!=='edge'||selection.source!==this.curve.surface)throw new Error('edge selection belongs to another curve revision');
    const indices=new Set(selection.indices),rows=new Map(selection.map(e=>[e.index,e]));
    this.edit.setEdges(this.input.edges.filter(e=>indices.has(e.index)),e=>evaluate(field,rows.get(e.index)!));
  }
  close():void{this.active=false;}
}

export interface StepsOptions {readonly every?:number}
export interface MeshSnapshot<P extends Attributes3,E extends EdgeAttributes,F extends Attributes3>{readonly iteration:number;readonly geometry:Mesh<P,E,F>}
export type MeshRule<P extends Attributes3,E extends EdgeAttributes,F extends Attributes3>=(current:Mesh<P,E,F>,next:MeshEdit<P,E,F>,k:number)=>void;

/** One common immutable polygon-mesh contract, regardless of its factory. */
export class Mesh<P extends Attributes3={},E extends EdgeAttributes={},F extends Attributes3={}> {
  readonly surface:Surface3;readonly key?:string;readonly iteration:number;
  readonly history:readonly MeshSnapshot<P,E,F>[];
  readonly transfers:PointTransfers;
  constructor(surface:Surface3,options:GeometryOptions&{iteration?:number;history?:readonly MeshSnapshot<P,E,F>[];transfers?:PointTransfers}={}) {
    checkOptions(options);validateAttributes(surface);this.surface=snapshotSurface3(surface);this.key=checkedKey(options.key);this.iteration=options.iteration??0;
    this.history=Object.freeze([...(options.history??[])]);this.transfers=Object.freeze({...options.transfers});Object.freeze(this);
  }
  get points():MeshPoints<P,E,F>{return meshPoints(this);}
  get edges():MeshEdges<P,E,F>{return meshEdges(this);}
  faces():MeshFaces<P,E,F>{return meshFaces(this);}
  attributes<A extends Attributes3>(fields:AttributeFields<MeshPointRow<P,E,F>,A>,options:AttributeOptions={}):Mesh<Omit<P,keyof A>&A,E,F>{
    const transfers=pointTransfers(this.transfers,fields,options);
    return new Mesh<Omit<P,keyof A>&A,E,F>(setPointFields(this.surface,fields,[...this.points]),{...this,history:[],transfers});
  }
  edgeAttributes<A extends Attributes3>(fields:AttributeFields<MeshEdgeRow<E,P,F>,A>):Mesh<P,Omit<E,keyof A>&A,F>{
    const values=captureAttributeFields([...this.edges],fields),surface=cloneSurface3(this.surface);
    surface.edges.forEach((edge,i)=>Object.assign(edge.attributes,values[i]));
    return new Mesh<P,Omit<E,keyof A>&A,F>(surface,{...this,history:[]});
  }
  attribute<Name extends string,Value extends Attribute3>(name:Name,field:Field<MeshPointRow<P,E,F>,Value>,options:{transfer?:'interpolate'|'nearest'}={}):Mesh<Omit<P,Name>&Record<Name,Value>,E,F>{
    return new Mesh<Omit<P,Name>&Record<Name,Value>,E,F>(setPoints(this.surface,name,field,[...this.points]),{...this,history:[],transfers:{...this.transfers,[name]:options.transfer??this.transfers[name]??'interpolate'}});
  }
  edgeAttribute<Name extends string,Value extends Attribute3>(name:Name,field:Field<MeshEdgeRow<E,P,F>,Value>):Mesh<P,Omit<E,Name>&Record<Name,Value>,F>{
    attributeName(name);const values=this.edges.map(row=>attributeValue(evaluate(field,row))),surface=cloneSurface3(this.surface);
    surface.edges.forEach((e,i)=>e.attributes[name]=values[i]);return new Mesh<P,Omit<E,Name>&Record<Name,Value>,F>(surface,{...this,history:[]});
  }
  faceAttribute<Name extends string,Value extends Attribute3>(name:Name,field:Field<MeshFaceRow<F,P,E>,Value>):Mesh<P,E,Omit<F,Name>&Record<Name,Value>>{
    attributeName(name);const values=this.faces().map(row=>attributeValue(evaluate(field,row))),surface=cloneSurface3(this.surface);
    surface.faces.forEach((f,i)=>f.attributes[name]=values[i]);return new Mesh<P,E,Omit<F,Name>&Record<Name,Value>>(surface,{...this,history:[]});
  }
  faceAttributes<A extends Attributes3>(field:(row:MeshFaceRow<F,P,E>)=>A):Mesh<P,E,Omit<F,keyof A>&A>;
  faceAttributes<A extends Attributes3>(fields:AttributeFields<MeshFaceRow<F,P,E>,A>):Mesh<P,E,Omit<F,keyof A>&A>;
  faceAttributes<A extends Attributes3>(fields:AttributeFields<MeshFaceRow<F,P,E>,A>|((row:MeshFaceRow<F,P,E>)=>A)):Mesh<P,E,Omit<F,keyof A>&A>{
    const rows=[...this.faces()],values=typeof fields==='function'?rows.map(fields):captureAttributeFields(rows,fields),surface=cloneSurface3(this.surface);
    values.forEach((attrs,i)=>{attributeRecord(attrs);for(const [name,value] of Object.entries(attrs)){attributeName(name);surface.faces[i].attributes[name]=attributeValue(value);}});
    return new Mesh<P,E,Omit<F,keyof A>&A>(surface,{...this,history:[]});
  }
  subdivide(levels=1,options:SubdivisionOptions={}):Mesh<P,Partial<E>,F>{return new Mesh<P,Partial<E>,F>(subdivideSurface(this.surface,levels,options,this.transfers),{...this,history:[]});}
  displace(field:Field<MeshPointRow<P,E,F>,Vec3>):Mesh<P,E,F>{return new Mesh(displaced(this.surface,field,[...this.points]),{...this,history:[]});}
  translate(offset:Vec3):Mesh<P,E,F>{return new Mesh(transformSurface3(this.surface,{translate:offset}),{...this,history:[]});}
  rotate(angles:RotationInput,origin:Vec3=[0,0,0]):Mesh<P,E,F>{return new Mesh(transformSurface3(this.surface,{rotate:angles,origin}),{...this,history:[]});}
  scale(scale:number|Vec3,origin:Vec3=[0,0,0]):Mesh<P,E,F>{return new Mesh(transformSurface3(this.surface,{scale:typeof scale==='number'?[scale,scale,scale]:scale,origin}),{...this,history:[]});}
  withKey(key:string):Mesh<P,E,F>{return new Mesh(this.surface,{...this,key});}
  steps(count:number,rule:MeshRule<StepAttributes<P>,StepAttributes<E>,StepAttributes<F>>,...passesAndOptions:(MeshRule<StepAttributes<P>,StepAttributes<E>,StepAttributes<F>>|StepsOptions)[]):Mesh<StepAttributes<P>,StepAttributes<E>,StepAttributes<F>>{
    if(!Number.isSafeInteger(count)||count<0)throw new Error('steps count must be a nonnegative integer');
    const last=passesAndOptions.at(-1),options=typeof last==='object'?last:{},every=options.every??0;
    if(!Number.isSafeInteger(every)||every<0)throw new Error('steps history interval must be a nonnegative integer');
    const passes=[rule,...passesAndOptions.filter((p):p is MeshRule<StepAttributes<P>,StepAttributes<E>,StepAttributes<F>>=>typeof p==='function')];
    let current=new Mesh<StepAttributes<P>,StepAttributes<E>,StepAttributes<F>>(this.surface,{...this,history:[]});const history:MeshSnapshot<StepAttributes<P>,StepAttributes<E>,StepAttributes<F>>[]=[];
    if(every)history.push(Object.freeze({iteration:current.iteration,geometry:current}));
    for(let k=0;k<count;k++){
      for(const pass of passes){const edit=new MeshEdit(current);try{const result:unknown=pass(current,edit,k);if(result&&typeof (result as PromiseLike<unknown>).then==='function'){void Promise.resolve(result).catch(()=>{});throw new Error('mesh steps callbacks must be synchronous');}current=edit.finish(this.iteration+k+1);}finally{edit.close();}}
      if(every&&((k+1)%every===0||k+1===count))history.push(Object.freeze({iteration:current.iteration,geometry:current}));
    }
    return new Mesh(current.surface,{...current,history});
  }
}

/** An editor is valid only during its frozen pass; all reads use its input. */
export class MeshEdit<P extends Attributes3,E extends EdgeAttributes,F extends Attributes3> {
  private active=true;
  private readonly points:SurfacePoint3[];
  private readonly edgeAttributes:Attributes3[];
  private readonly faceAttributes:Attributes3[];
  constructor(private readonly input:Mesh<P,E,F>){
    this.points=input.surface.points.map(p=>({...p,position:[...p.position] as Vec3,attributes:structuredClone(p.attributes)}));
    this.edgeAttributes=input.surface.edges.map(e=>structuredClone(e.attributes));
    this.faceAttributes=input.surface.faces.map(f=>structuredClone(f.attributes));
  }
  private check<R extends {id:string;index:number}>(selection:Collection<R,unknown>,domain:'point'|'edge'|'face'):void {
    if(!this.active)throw new Error('mesh editor is closed');
    if(!(selection instanceof Collection)||selection.domain!==domain||selection.source!==this.input.surface)throw new Error(`${domain} selection belongs to another mesh revision or domain; select from the current geometry`);
  }
  private single<R extends {id:string;index:number}>(rows:Collection<R,unknown>,row:R):Collection<R,unknown>{
    if(!this.active)throw new Error('mesh editor is closed');
    if(!rows.has(row))throw new Error('edit row belongs to another mesh revision');
    return rows.filter(r=>r.index===row.index);
  }
  private write<R extends {id:string;index:number;attributes:Readonly<Record<string,Attribute3|undefined>>}>(selection:Collection<R,unknown>,field:Field<R,object>,target:Attributes3[],domain:'point'|'edge'|'face'):void {
    this.check(selection,domain);
    // Capture/validate the whole operation before publishing any of its writes.
    const patches=selection.map(row=>{
      const patch=evaluate(field,row);
      attributeRecord(patch);
      return Object.fromEntries(Object.entries(patch).map(([name,value])=>{
        if(!Object.hasOwn(row.attributes,name))throw new Error(`no ${domain} attribute '${name}'; initialize it before stepping`);
        const checked=attributeValue(value),previous=row.attributes[name];
        if(typeof checked!==typeof previous||Array.isArray(checked)!==Array.isArray(previous)||(Array.isArray(checked)&&checked.length!==(previous as readonly number[]).length))throw new Error(`attribute '${name}' must retain its initialized type and vector dimension`);
        return [name,checked];
      }));
    });
    selection.indices.forEach((i,j)=>Object.assign(target[i],patches[j]));
  }
  move<R extends PointRow<P>>(selection:Collection<R,unknown>,field:Field<R,Vec3>):void{
    this.check(selection,'point');const deltas=selection.map(p=>{const delta=evaluate(field,p);finite3(delta);return delta;});
    selection.indices.forEach((i,j)=>this.points[i].position=add3(this.points[i].position,deltas[j]));
  }
  set<R extends PointRow<P>>(target:Collection<R,unknown>|R,field:Field<R,Partial<P>>):void{
    const selection=target instanceof Collection?target:this.single(this.input.points as unknown as Collection<R,unknown>,target);
    this.write(selection,field,this.points.map(p=>p.attributes),'point');
  }
  setEdge(row:EdgeRow<E,P>,attributes:Partial<E>):void{this.setEdges(this.single(this.input.edges,row),attributes);}
  setEdges<R extends EdgeRow<E,P>>(selection:Collection<R,unknown>,field:Field<R,Partial<E>>):void{this.write(selection,field,this.edgeAttributes,'edge');}
  setFace(row:FaceRow<F>,attributes:Partial<F>):void{this.setFaces(this.single(this.input.faces(),row),attributes);}
  setFaces<R extends FaceRow<F>>(selection:Collection<R,unknown>,field:Field<R,Partial<F>>):void{this.write(selection,field,this.faceAttributes,'face');}
  finish(iteration:number):Mesh<P,E,F>{
    if(!this.active)throw new Error('mesh editor is closed');this.active=false;
    const faces=this.input.surface.faces.map((face,i)=>({...face,attributes:this.faceAttributes[i]}));
    const previous={...this.input.surface,edges:this.input.surface.edges.map((edge,i)=>({...edge,attributes:this.edgeAttributes[i]}))};
    inheritTopology3(previous,this.input.surface);
    return new Mesh(assembleSurface3(this.points,faces,this.input.surface.triangles,previous),{...this.input,iteration,history:[]});
  }
  close():void{this.active=false;}
}
function validateImportedSurface(surface:Surface3):void {
  if(!surface||![surface.points,surface.edges,surface.faces,surface.triangles].every(Array.isArray))throw new Error('mesh import requires points, edges, faces and triangles');
  for(const edge of surface.edges)if(edge.vertices.length!==2||edge.vertices.some(v=>!Number.isSafeInteger(v)||v<0||v>=surface.points.length))throw new Error('mesh import has invalid edge vertices');
  const byFace=surface.faces.map(()=>[] as Surface3['triangles'][number][]);
  for(const triangle of surface.triangles){
    if(!Number.isSafeInteger(triangle.face)||!byFace[triangle.face]||triangle.vertices.length!==3||new Set(triangle.vertices).size!==3||triangle.vertices.some(v=>!Number.isSafeInteger(v)||!surface.faces[triangle.face].vertices.includes(v)))throw new Error('mesh import has invalid triangle ownership or vertices');
    byFace[triangle.face].push(triangle);
  }
  surface.faces.forEach((face,i)=>{
    if(byFace[i].length!==face.vertices.length-2)throw new Error('mesh import triangulation must cover each polygon with n-2 triangles');
    const edges=new Map<string,number>(),counts=new Map<string,number>();
    for(const triangle of byFace[i])for(let j=0;j<3;j++){
      const a=triangle.vertices[j],b=triangle.vertices[(j+1)%3],key=a<b?`${a}:${b}`:`${b}:${a}`;
      counts.set(key,(counts.get(key)??0)+1);if(counts.get(key)!>2)throw new Error('mesh import has a non-manifold triangulation edge');
      edges.set(key,(edges.get(key)??0)+(a<b?1:-1));
    }
    for(let j=0;j<face.vertices.length;j++){
      const a=face.vertices[j],b=face.vertices[(j+1)%face.vertices.length],key=a<b?`${a}:${b}`:`${b}:${a}`;
      edges.set(key,(edges.get(key)??0)-(a<b?1:-1));
    }
    if([...edges.values()].some(n=>n!==0))throw new Error('mesh import triangulation does not match its polygon boundary');
  });
}
export function mesh(source:Surface3,options?:GeometryOptions):Mesh<Attributes3,Attributes3,Attributes3>;
export function mesh(positions:readonly Vec3[],faces:readonly (readonly number[])[],options?:GeometryOptions):Mesh;
export function mesh(source:Surface3|readonly Vec3[],facesOrOptions:readonly (readonly number[])[]|GeometryOptions={},options:GeometryOptions={}):Mesh<any,any,any>{
  if(Array.isArray(source)){
    if(!Array.isArray(facesOrOptions))throw new Error('mesh positions require polygon index arrays');
    return new Mesh(surface3(source,facesOrOptions),options);
  }
  validateImportedSurface(source as Surface3);
  return new Mesh(source as Surface3,facesOrOptions as GeometryOptions);
}
export function plane(width=1,height=width,options:GeometryOptions={}):Mesh{if(![width,height].every(n=>Number.isFinite(n)&&n>0))throw new Error('plane dimensions must be positive and finite');return mesh([[-width/2,-height/2,0],[width/2,-height/2,0],[width/2,height/2,0],[-width/2,height/2,0]],[[0,1,2,3]],options);}
export function box(size:number|Vec3=1,options:GeometryOptions={}):Mesh{return new Mesh(box3(typeof size==='number'?[size,size,size]:size),options);}
export function pointCloud(positions:readonly Vec3[],options:GeometryOptions={}):PointGeometry{return new PointGeometry(surface3(positions,[]),options);}
