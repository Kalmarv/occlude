import {chartSurface3,type SurfaceUV} from '../geometry/coordinates.js';
import {rotation3,axisAngle,rotateVector3,vector3,type Rotation,type RotationInput,type RotationData,type Axis3} from '../rotation.js';
import {inheritTopology3} from '../geometry/topology.js';
import {meshPoints,meshEdges,meshFaces,meshCorners,type MeshCorners,type MeshCornerRow,type MeshPoints,type MeshEdges,type MeshFaces,type MeshPointRow,type MeshEdgeRow,type MeshFaceRow} from './topology.js';
import {assembleSurface3,surface3,box3,type Surface3,type SurfacePoint3,type Attributes3,type Attribute3,type Provenance3} from '../geometry/surface.js';
import {captureSurface3,ownSurface3,cloneSurface3,editAttributes3,transformSurface3,measureFaces3} from '../geometry/model.js';
import {add3,sub3,mul3,dot3,cross3,finite3,type Vec3} from '../math.js';
import {Collection} from './collection.js';
import {subdivideSurface,type SubdivisionOptions,type PointTransfers} from './subdivide.js';
import {extrudeRegion3,regionDirection3} from '../geometry/extrude.js';
/** One connected component of an extrusion selection, measured on the frozen input. */
export interface ExtrudeRegion<P extends Attributes3={},E extends EdgeAttributes={},F extends Attributes3={},C extends Attributes3={}> {
  readonly index:number;readonly faces:MeshFaces<P,E,F,C>;
  /** Unit area-weighted mean normal; undefined when the region's faces cancel. */
  readonly normal?:Vec3;readonly center:Vec3;readonly area:number;
}
export type ExtrudeOffset<R>=number|Vec3|((region:R)=>Vec3)|{readonly distance:Field<R,number>};
export interface ExtrudeOptions {
  /** Stable identity for generated points, walls and corners; default 'extrude'. */
  readonly key?:string;
}
export type Field<Row,Value> = Value | ((row:Row)=>Value);
export type AttributeFields<Row,A extends Attributes3> = {readonly [K in keyof A]:Field<Row,A[K]>};
type StepValue<V> = V extends number ? number : V extends string ? string : V extends boolean ? boolean : V extends readonly number[] ? {readonly [I in keyof V]:number} : V;
/** A frozen pass may change values, so literal columns widen to their value kind. */
export type StepAttributes<A> = {[K in keyof A]:StepValue<A[K]>};
export interface AttributeOptions {readonly transfer?:PointTransfers}
export type EdgeAttributes = Record<string,Attribute3|undefined>;
export interface GeometryOptions {
  readonly key?:string;
  /** The object's own crease threshold in degrees: a fold is drawn as a crease
   * when its angle reaches it. Unset objects use the view's `creaseAngle`
   * (30 by default); 180 never draws creases, the smooth-shaded look. */
  readonly creaseAngle?:number;
  /** The pen the default drawing uses for this object's lines; the view's
   * `stroke` applies when unset. A hatch recipe's own `stroke` still wins. */
  readonly stroke?:string;
  /** The pen for this object's hatch when the recipe names none (2D `fillPen`). */
  readonly fillPen?:string;
}
/** How an object is drawn by the default drawing: its pen, its hatch pen, its
 * crease threshold. `style` sets only the fields named and keeps the rest. */
export interface Style3 {readonly stroke?:string;readonly fillPen?:string;readonly creaseAngle?:number}
function checkedStroke(value:string|undefined):string|undefined {
  if(value!==undefined&&(typeof value!=='string'||!value))throw new Error('stroke must be a nonempty pen name');
  return value;
}
function checkedCreaseAngle(value:number|undefined):number|undefined {
  if(value!==undefined&&(!Number.isFinite(value)||value<0||value>180))throw new Error('creaseAngle must be between 0 and 180 degrees');
  return value;
}
export type PointRow<A extends Attributes3={}> = Readonly<A & {id:string;index:number;x:number;y:number;z:number;attributes:Readonly<A>;provenance?:Provenance3}>;
export type EdgeRow<A extends EdgeAttributes={},P extends Attributes3={}> = Readonly<A & {id:string;index:number;vertices:readonly [number,number];a:PointRow<P>; b:PointRow<P>;length:number;attributes:Readonly<A>;provenance?:Provenance3}>;
export type FaceRow<A extends Attributes3={}> = Readonly<A & {id:string;index:number;vertices:readonly number[];normal:Vec3;center:Vec3;area:number;attributes:Readonly<A>;provenance?:Provenance3}>;
export type CornerRow<A extends Attributes3={}> = Readonly<A&{id:string;index:number;localIndex:number;attributes:Readonly<A>;provenance?:Provenance3}>;
const reserved=new Set(['id','index','x','y','z','attributes','provenance','vertices','normal','center','area','a','b','length','source','sample','points','edges','faces','adjacent','corners','face','point','localIndex']);
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
// Attribute records are frozen and shared between a surface and every surface
// derived from it (transforms, subdivisions, further attribute edits), so a
// record validated once is valid wherever it appears: the check runs per new
// record, not per new mesh. (A torus with 40k faces edited three times used
// to validate 120k unchanged records.)
const validatedAttributes=new WeakSet<object>();
function validateAttributes(surface:Surface3):void {
  for(const rows of [surface.points,surface.edges,surface.faces,surface.faces.flatMap(f=>f.corners??[])])for(const row of rows){
    const record=row.attributes;
    if(validatedAttributes.has(record))continue;
    for(const [name,value] of Object.entries(record)){attributeName(name);attributeValue(value);}
    if(Object.isFrozen(record))validatedAttributes.add(record);
  }
}
function pointsOnly(surface:Surface3,indices:readonly number[]):Surface3{return ownSurface3(assembleSurface3(indices.map(i=>surface.points[i]),[],[]));}
const transformed=(surface:Surface3,options:Parameters<typeof transformSurface3>[1]):Surface3=>ownSurface3(transformSurface3(surface,options));
function setPoints<R extends PointRow<any>>(surface:Surface3,name:string,field:Field<R,Attribute3>,rows:readonly R[]=pointRows(surface) as readonly R[]):Surface3 {
  attributeName(name);
  return editAttributes3(surface,{points:rows.map(row=>({[name]:attributeValue(evaluate(field,row))}))});
}
/** All initializers observe the same incoming rows, never newly written columns. */
export function captureAttributeFields<R,A extends Attributes3>(rows:readonly R[],fields:AttributeFields<R,A>):readonly Attributes3[] {
  if(!fields||typeof fields!=='object'||Array.isArray(fields))throw new Error('attributes requires a map of named fields');
  attributeRecord(fields);
  const entries=Object.entries(fields);entries.forEach(([name])=>attributeName(name));
  return rows.map(row=>Object.fromEntries(entries.map(([name,field])=>[name,attributeValue(evaluate(field,row))])));
}
function setPointFields<R extends PointRow<any>,A extends Attributes3>(surface:Surface3,fields:AttributeFields<R,A>,rows:readonly R[]=pointRows(surface) as readonly R[]):Surface3 {
  return editAttributes3(surface,{points:captureAttributeFields(rows,fields)});
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
export interface DisplaceOptions {
  /** Direction of a scalar displacement: the vertex normal (default), an axis, or a fixed vector. */
  readonly along?:'normal'|'x'|'y'|'z'|Vec3;
}
/** Angle-weighted vertex normals over the represented triangles; a point with
 * no faces has no normal and a scalar displacement there is an error. */
function vertexNormals(surface:Surface3):(Vec3|null)[] {
  const sums=surface.points.map(()=>[0,0,0] as number[]);
  for(const t of surface.triangles){
    const p=t.vertices.map(v=>surface.points[v].position),n=cross3(sub3(p[1],p[0]),sub3(p[2],p[0]));
    for(let k=0;k<3;k++){const a=sub3(p[(k+1)%3],p[k]),b=sub3(p[(k+2)%3],p[k]),la=Math.hypot(...a),lb=Math.hypot(...b);
      const angle=la&&lb?Math.acos(Math.max(-1,Math.min(1,dot3(a,b)/(la*lb)))):0;const s=sums[t.vertices[k]];s[0]+=n[0]*angle;s[1]+=n[1]*angle;s[2]+=n[2]*angle;}
  }
  return sums.map(s=>{const l=Math.hypot(s[0],s[1],s[2]);return l>0?[s[0]/l,s[1]/l,s[2]/l] as Vec3:null;});
}
function displaced<R extends PointRow<any>>(surface:Surface3,field:Field<R,Vec3|number>,rows:readonly R[]=pointRows(surface) as readonly R[],options:DisplaceOptions={}):Surface3 {
  const along=options.along??'normal';
  const axis:Vec3|undefined=along==='x'?[1,0,0]:along==='y'?[0,1,0]:along==='z'?[0,0,1]:along==='normal'?undefined:along;
  if(axis)finite3(axis);
  let normals:(Vec3|null)[]|undefined;
  const points=rows.map((row,i)=>{
    const value=evaluate(field,row);
    let delta:Vec3;
    if(typeof value==='number'){
      if(!Number.isFinite(value))throw new Error('displace amount must be finite');
      const direction=axis??(normals??=vertexNormals(surface))[i];
      if(!direction)throw new Error('a scalar displacement needs a vertex normal or { along }: this point has no faces');
      delta=mul3(direction,value);
    }else{delta=value;finite3(delta);}
    return {...surface.points[i],position:add3(surface.points[i].position,delta)};
  });
  return ownSurface3(assembleSurface3(points,surface.faces,surface.triangles,surface));
}

export interface PointSnapshot<P extends Attributes3,G extends PointGeometry<P>=PointGeometry<P>> {readonly iteration:number;readonly geometry:G}
export type PointRule<P extends Attributes3,R extends PointRow<P>=PointRow<P>,G extends PointGeometry<P>=PointGeometry<P>>=(current:G,next:PointEdit<P,R>,k:number)=>void;
const pointHistory=new WeakMap<object,readonly PointSnapshot<any>[]>();


/** Where an object turns and scales: its own origin, which primitives are
 * born with at [0,0,0] and which `translate` carries along (Blender's
 * object origin). Rotations accumulate an orientation so `{ local: true }`
 * can turn about the object's own current axes. */
export interface PlacementOptions {readonly origin?:Vec3;readonly orientation?:RotationInput}
export interface RotateOptions {
  /** Pivot: the object's origin (default), the world origin, or a point. */
  readonly about?:'origin'|'world'|Vec3;
  /** Read the axis in the object's current frame instead of world axes. */
  readonly local?:boolean;
}
export interface ScaleOptions {readonly about?:'origin'|'world'|Vec3}
interface Placement {readonly origin:Vec3;readonly orientation:Rotation}
function placement(options:PlacementOptions):Placement {
  const origin=options.origin??[0,0,0];finite3(origin);
  return {origin:Object.freeze([origin[0],origin[1],origin[2]]) as unknown as Vec3,orientation:rotation3(options.orientation??[0,0,0])};
}
function pivotOf(about:'origin'|'world'|Vec3|undefined,origin:Vec3):Vec3 {
  if(about===undefined||about==='origin')return origin;
  if(about==='world')return [0,0,0];
  finite3(about);return about;
}
function isRotationInput(value:unknown):value is RotationInput {
  return Array.isArray(value)||(typeof value==='object'&&value!==null&&(value as RotationData).kind==='rotation');
}
/** `rotate(angles | rotation, pivot?)` or `rotate(axis, degrees, { about, local })`. */
/** The object's origin after turning about a pivot: it rides along like every
 * other point, so a later default rotation still turns in place. */
function movedOrigin(self:Placement,pivot:Vec3,move:(v:Vec3)=>Vec3):Vec3{return Object.freeze(add3(pivot,move(sub3(self.origin,pivot)))) as unknown as Vec3;}
function rotationArguments(self:Placement,a:RotationInput|Axis3,b?:number|Vec3|RotateOptions,c?:RotateOptions):{rotate:Rotation;origin:Vec3;orientation:Rotation;moved:Vec3} {
  let rotate:Rotation,options:RotateOptions={};
  if(typeof b==='number'){
    if(!Number.isFinite(b))throw new Error('rotate degrees must be finite');
    options=c??{};
    const axis:Axis3=options.local?rotateVector3(typeof a==='string'?(a==='x'?[1,0,0]:a==='y'?[0,1,0]:[0,0,1]):vector3(a as Vec3),self.orientation):a as Axis3;
    rotate=axisAngle(axis,b);
  }else{
    if(!isRotationInput(a))throw new Error('rotate takes Euler degrees, a rotation value, or an axis with degrees');
    rotate=rotation3(a);
    if(Array.isArray(b)){finite3(b as Vec3);return {rotate,origin:b as Vec3,orientation:self.orientation.then(rotate),moved:movedOrigin(self,b as Vec3,v=>rotate.apply(v))};}
    options=(b as RotateOptions|undefined)??{};
  }
  const origin=pivotOf(options.about,self.origin);
  return {rotate,origin,orientation:self.orientation.then(rotate),moved:movedOrigin(self,origin,v=>rotate.apply(v))};
}
/** A zero factor is allowed at this level: an object scaled to nothing is
 * nothing (`empty`), drawing and occluding nothing, so loops that pass through
 * zero carry on. The exact kernel below still refuses singular transforms. */
function scaleArguments(self:Placement,scale:number|Vec3,b?:Vec3|ScaleOptions):{scale:Vec3;origin:Vec3;moved:Vec3;empty:boolean} {
  const factors:Vec3=typeof scale==='number'?[scale,scale,scale]:scale;finite3(factors);
  const origin=Array.isArray(b)?b as Vec3:pivotOf((b as ScaleOptions|undefined)?.about,self.origin);if(Array.isArray(b))finite3(origin);
  return {scale:factors,origin,moved:movedOrigin(self,origin,v=>[v[0]*factors[0],v[1]*factors[1],v[2]*factors[2]]),empty:factors.some(f=>f===0)};
}
/** Points collapsed by a scale with a zero factor: no faces or edges to break, so the points simply move. */
function collapsedPoints(surface:Surface3,factors:Vec3,origin:Vec3):Surface3 {
  return ownSurface3(assembleSurface3(surface.points.map(p=>({...p,position:add3(origin,sub3(p.position,origin).map((v,i)=>v*factors[i]) as unknown as Vec3)})),[],[]));
}
const emptySurface=():Surface3=>ownSurface3(assembleSurface3([],[],[]));

/** Point geometry has a point domain; it never claims editable mesh faces. */
export class PointGeometry<P extends Attributes3={}> {
  readonly surface:Surface3;readonly key?:string;readonly iteration:number;
  /** The object's own pivot, carried along by `translate`. */
  readonly origin:Vec3;readonly orientation:Rotation;
  constructor(surface:Surface3,options:GeometryOptions&PlacementOptions&{iteration?:number;history?:readonly PointSnapshot<P>[]}={}){
    checkOptions(options);validateAttributes(surface);this.surface=captureSurface3(surface);this.key=checkedKey(options.key);this.iteration=options.iteration??0;
    const placed=placement(options);this.origin=placed.origin;this.orientation=placed.orientation;
    pointHistory.set(this,Object.freeze([...(options.history??[])]));Object.freeze(this);
  }
  get history():readonly PointSnapshot<P>[]{return pointHistory.get(this)!;}
  get points():Collection<PointRow<P>,PointGeometry<P>>{return new Collection(this.surface,'point',pointRows<P>(this.surface),indices=>new PointGeometry(pointsOnly(this.surface,indices)));}
  attribute<Name extends string,Value extends Attribute3>(name:Name,field:Field<PointRow<P>,Value>):PointGeometry<Omit<P,Name>&Record<Name,Value>>{return new PointGeometry<Omit<P,Name>&Record<Name,Value>>(setPoints(this.surface,name,field),{...this,history:[]});}
  attributes<A extends Attributes3>(fields:AttributeFields<PointRow<P>,A>):PointGeometry<Omit<P,keyof A>&A>{return new PointGeometry<Omit<P,keyof A>&A>(setPointFields(this.surface,fields),{...this,history:[]});}
  displace(field:Field<PointRow<P>,Vec3|number>,options:DisplaceOptions={}):PointGeometry<P>{return new PointGeometry(displaced(this.surface,field,undefined,options),{...this,history:[]});}
  translate(offset:Vec3):PointGeometry<P>{finite3(offset);return new PointGeometry(transformed(this.surface,{translate:offset}),{...this,history:[],origin:add3(this.origin,offset)});}
  rotate(angles:RotationInput,pivot?:Vec3|RotateOptions):PointGeometry<P>;
  rotate(axis:Axis3,degrees:number,options?:RotateOptions):PointGeometry<P>;
  rotate(a:RotationInput|Axis3,b?:number|Vec3|RotateOptions,c?:RotateOptions):PointGeometry<P>{const r=rotationArguments(this,a,b,c);return new PointGeometry(transformed(this.surface,{rotate:r.rotate,origin:r.origin}),{...this,history:[],orientation:r.orientation,origin:r.moved});}
  scale(scale:number|Vec3,pivot?:Vec3|ScaleOptions):PointGeometry<P>{const r=scaleArguments(this,scale,pivot);return new PointGeometry(r.empty?collapsedPoints(this.surface,r.scale,r.origin):transformed(this.surface,{scale:r.scale,origin:r.origin}),{...this,history:[],origin:r.moved});}
  withKey(key:string):PointGeometry<P>{return new PointGeometry(this.surface,{key,iteration:this.iteration,history:this.history});}
  steps(count:number,rule:PointRule<StepAttributes<P>>|StepShorthand<PointRow<StepAttributes<P>>,StepAttributes<P>>,...passesAndOptions:(PointRule<StepAttributes<P>>|StepsOptions)[]):PointGeometry<StepAttributes<P>>{
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
  initial:PointGeometry<P>,count:number,rule:PointRule<StepAttributes<P>,R,G>|StepShorthand<R,StepAttributes<P>>,passesAndOptions:readonly (PointRule<StepAttributes<P>,R,G>|StepsOptions)[],
  create:(surface:Surface3,iteration:number,history?:readonly PointSnapshot<StepAttributes<P>,G>[])=>G,
):G {
  if(stepRule<R,StepAttributes<P>>(rule))rule=pointShorthandRule(rule) as PointRule<StepAttributes<P>,R,G>;
  const pass=(rule:PointRule<StepAttributes<P>,R,G>):MeshRule<StepAttributes<P>,{},{}>=>(input,next,k)=>{
    const current=create(input.surface,input.iteration),edit=new PointEdit<StepAttributes<P>,R>(current.points,input,next);
    try{return rule(current,edit,k);}finally{edit.close();}
  };
  const passes=passesAndOptions.map(p=>typeof p==='function'?pass(p):p);
  const result=new Mesh<P,{},{}>(initial.surface,{key:initial.key,iteration:initial.iteration}).steps(count,pass(rule as PointRule<StepAttributes<P>,R,G>),...passes);
  const history=result.history.map(row=>Object.freeze({iteration:row.iteration,geometry:create(row.geometry.surface,row.iteration)}));
  return create(result.surface,result.iteration,history);
}

/** Owned polyline/edge-graph data with point and edge domains, never faces. */
export class CurveGeometry<P extends Attributes3={},E extends EdgeAttributes={}> {
  readonly surface:Surface3;readonly key?:string;readonly iteration:number;
  readonly origin:Vec3;readonly orientation:Rotation;
  readonly history:readonly CurveSnapshot<P,E>[];
  readonly segments:readonly {readonly id:string;readonly vertices:readonly [number,number];readonly attributes:Readonly<Partial<E>>;readonly provenance?:Provenance3}[];
  constructor(surface:Surface3,indices:readonly number[],options:GeometryOptions&PlacementOptions&{iteration?:number;history?:readonly CurveSnapshot<P,E>[]}={}) {
    checkOptions(options);validateAttributes(surface);
    const placed=placement(options);this.origin=placed.origin;this.orientation=placed.orientation;
    if(indices.some(i=>!Number.isSafeInteger(i)||!surface.edges[i]))throw new Error('invalid curve edge index');
    const selected=[...new Set(indices)],used=[...new Set(selected.flatMap(i=>surface.edges[i].vertices))].sort((a,b)=>a-b);
    const mapping=new Map(used.map((v,i)=>[v,i]));
    const source:Surface3={points:used.map(i=>surface.points[i]),faces:[],triangles:[],edges:selected.map(i=>({...surface.edges[i],vertices:surface.edges[i].vertices.map(v=>mapping.get(v)!) as [number,number],faces:[]}))};
    this.surface=captureSurface3(source);this.key=checkedKey(options.key);
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
    const surface=editAttributes3(this.surface,{edges:captureAttributeFields([...this.edges],fields)});
    return new CurveGeometry<P,Omit<E,keyof A>&A>(surface,surface.edges.map((_,i)=>i),{...this,history:[]});
  }
  edgeAttribute<Name extends string,Value extends Attribute3>(name:Name,field:Field<EdgeRow<E,P>,Value>):CurveGeometry<P,Omit<E,Name>&Record<Name,Value>>{
    attributeName(name);const surface=editAttributes3(this.surface,{edges:this.edges.map(row=>({[name]:attributeValue(evaluate(field,row))}))});
    return new CurveGeometry<P,Omit<E,Name>&Record<Name,Value>>(surface,surface.edges.map((_,i)=>i),{...this,history:[]});
  }
  private changed(surface:Surface3,placed:PlacementOptions={}):CurveGeometry<P,E>{return new CurveGeometry(surface,surface.edges.map((_,i)=>i),{...this,history:[],...placed});}
  displace(field:Field<PointRow<P>,Vec3|number>,options:DisplaceOptions={}):CurveGeometry<P,E>{return this.changed(displaced(this.surface,field,undefined,options));}
  translate(offset:Vec3):CurveGeometry<P,E>{finite3(offset);return this.changed(transformed(this.surface,{translate:offset}),{origin:add3(this.origin,offset)});}
  rotate(angles:RotationInput,pivot?:Vec3|RotateOptions):CurveGeometry<P,E>;
  rotate(axis:Axis3,degrees:number,options?:RotateOptions):CurveGeometry<P,E>;
  rotate(a:RotationInput|Axis3,b?:number|Vec3|RotateOptions,c?:RotateOptions):CurveGeometry<P,E>{const r=rotationArguments(this,a,b,c);return this.changed(transformed(this.surface,{rotate:r.rotate,origin:r.origin}),{orientation:r.orientation,origin:r.moved});}
  scale(scale:number|Vec3,pivot?:Vec3|ScaleOptions):CurveGeometry<P,E>{const r=scaleArguments(this,scale,pivot);return this.changed(r.empty?emptySurface():transformed(this.surface,{scale:r.scale,origin:r.origin}),{origin:r.moved});}
  withKey(key:string):CurveGeometry<P,E>{return new CurveGeometry(this.surface,this.surface.edges.map((_,i)=>i),{...this,key});}
  steps(count:number,rule:CurveRule<StepAttributes<P>,StepAttributes<E>>|StepShorthand<PointRow<StepAttributes<P>>,StepAttributes<P>>,...passesAndOptions:(CurveRule<StepAttributes<P>,StepAttributes<E>>|StepsOptions)[]):CurveGeometry<StepAttributes<P>,StepAttributes<E>>{
    if(stepRule<PointRow<StepAttributes<P>>,StepAttributes<P>>(rule))rule=pointShorthandRule(rule) as CurveRule<StepAttributes<P>,StepAttributes<E>>;
    const pass=(rule:CurveRule<StepAttributes<P>,StepAttributes<E>>):MeshRule<StepAttributes<P>,StepAttributes<E>,{}>=>(input,next,k)=>{
      const current=new CurveGeometry<StepAttributes<P>,StepAttributes<E>>(input.surface,input.surface.edges.map((_,i)=>i),{key:this.key,iteration:input.iteration});
      // Bind the public curve selection to the underlying frozen point pass.
      const edit=new CurveEdit(current,input,next);
      try{return rule(current,edit,k);}finally{edit.close();}
    };
    const options=passesAndOptions.map(p=>typeof p==='function'?pass(p):p);
    const result=new Mesh<P,E,{}>(this.surface,{key:this.key,iteration:this.iteration}).steps(count,pass(rule as CurveRule<StepAttributes<P>,StepAttributes<E>>),...options);
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
/** The two ordinary rules without the editor: a point field moves every
 * point; `{ move, set }` moves and writes every point. The explicit
 * `(current, next, k)` form remains for selections and other domains. */
/** The everyday step without the pass ceremony: `{ move, set }` fields over every point.
 * A move is a triple, or a number along the vertex normal. (A bare callback is not a
 * shorthand: TypeScript cannot tell a one-parameter point field from a rule.) */
export type StepShorthand<Row,P>={readonly move?:Field<Row,Vec3|number>;readonly set?:Field<Row,Partial<P>>};
export function stepRule<Row extends PointRow<any>,P>(rule:unknown):rule is StepShorthand<Row,P>{return typeof rule==='object'&&rule!==null;}
/** The shorthand as a rule over point and curve geometry, which have no
 * vertex normals: a scalar move is refused, a triple moves every point. */
function pointShorthandRule<Row extends PointRow<any>&{readonly id:string;readonly index:number},P>(shorthand:StepShorthand<Row,P>):(current:{readonly points:Collection<Row,unknown>},edit:{move(selection:Collection<Row,unknown>,field:Field<Row,Vec3>):void;set(selection:Collection<Row,unknown>,field:Field<Row,Partial<P>>):void})=>void {
  const {move,set}=shorthand;
  if(move===undefined&&set===undefined)throw new Error('a steps shorthand needs a move field, a set field, or both');
  return (current,edit)=>{
    if(set!==undefined)edit.set(current.points,set);
    if(move!==undefined)edit.move(current.points,p=>{const v=evaluate(move,p);if(typeof v==='number')throw new Error('a scalar step moves along the vertex normal, which point and curve geometry lack: return a triple');return v;});
  };
}
export interface MeshSnapshot<P extends Attributes3,E extends EdgeAttributes,F extends Attributes3,C extends Attributes3={}>{readonly iteration:number;readonly geometry:Mesh<P,E,F,C>}
export type MeshRule<P extends Attributes3,E extends EdgeAttributes,F extends Attributes3,C extends Attributes3={}>=(current:Mesh<P,E,F,C>,next:MeshEdit<P,E,F,C>,k:number)=>void;

/** One common immutable polygon-mesh contract, regardless of its factory. */
export class Mesh<P extends Attributes3={},E extends EdgeAttributes={},F extends Attributes3={},C extends Attributes3={}> {
  readonly surface:Surface3;readonly key?:string;readonly iteration:number;
  readonly history:readonly MeshSnapshot<P,E,F,C>[];
  readonly transfers:PointTransfers;readonly cornerTransfers:PointTransfers;
  /** The object's own pivot, carried along by `translate`; rotations and
   * scales turn about it unless told otherwise. */
  readonly origin:Vec3;readonly orientation:Rotation;
  /** Own crease threshold in degrees, or undefined for the view's. */
  readonly creaseAngle?:number;
  /** Own pen for the default drawing, or undefined for the view's. */
  readonly stroke?:string;
  /** Own pen for hatch recipes that name none. */
  readonly fillPen?:string;
  constructor(surface:Surface3,options:GeometryOptions&PlacementOptions&{iteration?:number;history?:readonly MeshSnapshot<P,E,F,C>[];transfers?:PointTransfers;cornerTransfers?:PointTransfers}={}) {
    checkOptions(options);validateAttributes(surface);this.surface=captureSurface3(surface);this.key=checkedKey(options.key);this.iteration=options.iteration??0;
    const placed=placement(options);this.origin=placed.origin;this.orientation=placed.orientation;this.creaseAngle=checkedCreaseAngle(options.creaseAngle);this.stroke=checkedStroke(options.stroke);this.fillPen=checkedStroke(options.fillPen);
    this.history=Object.freeze([...(options.history??[])]);this.transfers=Object.freeze({...options.transfers});this.cornerTransfers=Object.freeze({...options.cornerTransfers});Object.freeze(this);
  }
  get points():MeshPoints<P,E,F,C>{return meshPoints(this);}
  get edges():MeshEdges<P,E,F,C>{return meshEdges(this);}
  get corners():MeshCorners<P,E,F,C>{return meshCorners(this);}
  get faces():MeshFaces<P,E,F,C>{return meshFaces(this);}
  /** Replace an attribute by the mean of itself and its neighbours, `steps`
   * times: points over edges, faces over shared edges, corners over the
   * corners of their point and face. Numbers and numeric vectors only. */
  smooth(name:string,options:{readonly steps?:number}={}):Mesh<P,E,F,C>{
    const steps=options.steps??1;if(!Number.isSafeInteger(steps)||steps<0)throw new Error('smooth steps must be a nonnegative integer');
    const domain=Object.hasOwn(this.surface.points[0]?.attributes??{},name)?'point':Object.hasOwn(this.surface.faces[0]?.attributes??{},name)?'face':Object.hasOwn(this.surface.faces[0]?.corners?.[0]?.attributes??{},name)?'corner':undefined;
    if(!domain)throw new Error(`no point, face or corner attribute '${name}' to smooth`);
    let current:Mesh<P,E,F,C>=this;
    const mean=(values:readonly Attribute3[]):Attribute3=>{if(values.every(v=>typeof v==='number'))return (values as number[]).reduce((a,b)=>a+b,0)/values.length;if(values.every(v=>Array.isArray(v)&&v.length===(values[0] as number[]).length))return (values[0] as number[]).map((_,k)=>values.reduce<number>((a,v)=>a+(v as number[])[k],0)/values.length);throw new Error(`smooth needs numeric values in '${name}'`);};
    for(let i=0;i<steps;i++)current=current.steps(1,(now,next)=>{
      if(domain==='point')next.set(now.points,p=>({[name]:mean([p.attributes[name],...p.adjacent.map(q=>q.attributes[name])])} as never));
      else if(domain==='face')next.setFaces(now.faces,f=>({[name]:mean([f.attributes[name],...f.adjacent.map(g=>g.attributes[name])])} as never));
      else next.setCorners(now.corners,c=>({[name]:mean([c.attributes[name],...c.point.corners.map(d=>d.attributes[name]),...c.face.corners.map(d=>d.attributes[name])])} as never));
    }) as unknown as Mesh<P,E,F,C>;
    return current;
  }
  attributes<A extends Attributes3>(fields:AttributeFields<MeshPointRow<P,E,F,C>,A>,options:AttributeOptions={}):Mesh<Omit<P,keyof A>&A,E,F,C>{
    const transfers=pointTransfers(this.transfers,fields,options);
    return new Mesh<Omit<P,keyof A>&A,E,F,C>(setPointFields(this.surface,fields,[...this.points]),{...this,history:[],transfers});
  }
  edgeAttributes<A extends Attributes3>(fields:AttributeFields<MeshEdgeRow<E,P,F,C>,A>):Mesh<P,Omit<E,keyof A>&A,F,C>{
    return new Mesh<P,Omit<E,keyof A>&A,F,C>(editAttributes3(this.surface,{edges:captureAttributeFields([...this.edges],fields)}),{...this,history:[]});
  }
  attribute<Name extends string,Value extends Attribute3>(name:Name,field:Field<MeshPointRow<P,E,F,C>,Value>,options:{transfer?:'interpolate'|'nearest'}={}):Mesh<Omit<P,Name>&Record<Name,Value>,E,F,C>{
    return new Mesh<Omit<P,Name>&Record<Name,Value>,E,F,C>(setPoints(this.surface,name,field,[...this.points]),{...this,history:[],transfers:pointTransfers(this.transfers,{[name]:field},{transfer:{[name]:options.transfer??this.transfers[name]??'interpolate'}})});
  }
  edgeAttribute<Name extends string,Value extends Attribute3>(name:Name,field:Field<MeshEdgeRow<E,P,F,C>,Value>):Mesh<P,Omit<E,Name>&Record<Name,Value>,F,C>{
    attributeName(name);return new Mesh<P,Omit<E,Name>&Record<Name,Value>,F,C>(editAttributes3(this.surface,{edges:this.edges.map(row=>({[name]:attributeValue(evaluate(field,row))}))}),{...this,history:[]});
  }
  faceAttribute<Name extends string,Value extends Attribute3>(name:Name,field:Field<MeshFaceRow<F,P,E,C>,Value>):Mesh<P,E,Omit<F,Name>&Record<Name,Value>,C>{
    attributeName(name);return new Mesh<P,E,Omit<F,Name>&Record<Name,Value>,C>(editAttributes3(this.surface,{faces:this.faces.map(row=>({[name]:attributeValue(evaluate(field,row))}))}),{...this,history:[]});
  }
  faceAttributes<A extends Attributes3>(field:(row:MeshFaceRow<F,P,E,C>)=>A):Mesh<P,E,Omit<F,keyof A>&A,C>;
  faceAttributes<A extends Attributes3>(fields:AttributeFields<MeshFaceRow<F,P,E,C>,A>):Mesh<P,E,Omit<F,keyof A>&A,C>;
  faceAttributes<A extends Attributes3>(fields:AttributeFields<MeshFaceRow<F,P,E,C>,A>|((row:MeshFaceRow<F,P,E,C>)=>A)):Mesh<P,E,Omit<F,keyof A>&A,C>{
    const rows=[...this.faces],values=typeof fields==='function'?rows.map(fields):captureAttributeFields(rows,fields);
    const faces=values.map(attrs=>{attributeRecord(attrs);return Object.fromEntries(Object.entries(attrs).map(([name,value])=>{attributeName(name);return [name,attributeValue(value)];}));});
    return new Mesh<P,E,Omit<F,keyof A>&A,C>(editAttributes3(this.surface,{faces}),{...this,history:[]});
  }
  cornerAttributes<A extends Attributes3>(fields:AttributeFields<MeshCornerRow<C,P,E,F>,A>,options:AttributeOptions={}):Mesh<P,E,F,Omit<C,keyof A>&A>{
    const surface=editAttributes3(this.surface,{corners:captureAttributeFields([...this.corners],fields)});
    return new Mesh<P,E,F,Omit<C,keyof A>&A>(surface,{...this,history:[],cornerTransfers:pointTransfers(this.cornerTransfers,fields,options)});
  }
  cornerAttribute<Name extends string,Value extends Attribute3>(name:Name,field:Field<MeshCornerRow<C,P,E,F>,Value>,options:{transfer?:'interpolate'|'nearest'}={}):Mesh<P,E,F,Omit<C,Name>&Record<Name,Value>>{
    attributeName(name);const surface=editAttributes3(this.surface,{corners:this.corners.map(c=>({[name]:attributeValue(evaluate(field,c))}))});
    return new Mesh<P,E,F,Omit<C,Name>&Record<Name,Value>>(surface,{...this,history:[],cornerTransfers:pointTransfers(this.cornerTransfers,{[name]:field},{transfer:{[name]:options.transfer??this.cornerTransfers[name]??'interpolate'}})});
  }
  /** Connected-region extrusion: one vector per connected component of the
   * selection, a translated cap with retained IDs/corners, and one wall per
   * region boundary edge (holes and open sheet edges included). Independent
   * per-face extrusion remains the advanced `extrudeFaces3`. */
  extrude(faces:MeshFaces<P,E,F,C>,offset:ExtrudeOffset<ExtrudeRegion<P,E,F,C>>,options:ExtrudeOptions={}):Mesh<P,E,F,C>{
    checkOptions(options);
    if(!(faces instanceof Collection)||faces.domain!=='face'||faces.source!==this.surface)throw new Error('extrude requires a face selection of this mesh revision; select from mesh.faces()');
    if(typeof offset==='number')offset={distance:offset};
    if(offset===undefined||offset===null||typeof offset!=='function'&&!Array.isArray(offset)&&(typeof offset!=='object'||!('distance'in offset)))throw new Error('extrude offset must be a distance, a vector, a region callback or { distance }');
    const key=options.key??'extrude';if(typeof key!=='string'||!key)throw new Error('extrude key must be a nonempty string');
    const components=faces.components().map((component,index)=>{
      const measure=regionDirection3(this.surface,component.indices);
      const region:ExtrudeRegion<P,E,F,C>=Object.freeze({index,faces:component,normal:measure.normal&&Object.freeze(measure.normal) as Vec3,center:Object.freeze(measure.center) as Vec3,area:measure.area});
      let vector:Vec3;
      if(Array.isArray(offset))vector=offset as Vec3;
      else if(typeof offset==='function')vector=offset(region);
      else {
        const distance=evaluate(offset.distance,region);
        if(!Number.isFinite(distance))throw new Error(`extrude distance must be finite for region ${index}`);
        if(!region.normal)throw new Error(`extrude region ${index} has no well-defined direction; supply a vector instead of a distance`);
        vector=[region.normal[0]*distance,region.normal[1]*distance,region.normal[2]*distance];
      }
      if(!Array.isArray(vector)||vector.length!==3)throw new Error(`extrude offset must produce a 3-vector for region ${index}`);
      finite3(vector);
      return {index,faces:component.indices,vector:[vector[0],vector[1],vector[2]] as Vec3};
    });
    return new Mesh<P,E,F,C>(extrudeRegion3(this.surface,components,key),{...this,history:[]});
  }
  subdivide(levels=1,options:SubdivisionOptions={}):Mesh<P,Partial<E>,F,C>{return new Mesh<P,Partial<E>,F,C>(subdivideSurface(this.surface,levels,options,this.transfers,this.cornerTransfers),{...this,history:[]});}
  /** Move every point by a vector, or by a scalar along its vertex normal (`along` chooses another direction). */
  displace(field:Field<MeshPointRow<P,E,F,C>,Vec3|number>,options:DisplaceOptions={}):Mesh<P,E,F,C>{return new Mesh(displaced(this.surface,field,[...this.points],options),{...this,history:[]});}
  translate(offset:Vec3):Mesh<P,E,F,C>{finite3(offset);return new Mesh(transformed(this.surface,{translate:offset}),{...this,history:[],origin:add3(this.origin,offset)});}
  /** Turn about the object's origin: Euler degrees or a rotation value
   * (optionally with an explicit pivot), or an axis and degrees with
   * `{ about, local }`. */
  rotate(angles:RotationInput,pivot?:Vec3|RotateOptions):Mesh<P,E,F,C>;
  rotate(axis:Axis3,degrees:number,options?:RotateOptions):Mesh<P,E,F,C>;
  rotate(a:RotationInput|Axis3,b?:number|Vec3|RotateOptions,c?:RotateOptions):Mesh<P,E,F,C>{const r=rotationArguments(this,a,b,c);return new Mesh(transformed(this.surface,{rotate:r.rotate,origin:r.origin}),{...this,history:[],orientation:r.orientation,origin:r.moved});}
  scale(scale:number|Vec3,pivot?:Vec3|ScaleOptions):Mesh<P,E,F,C>{const r=scaleArguments(this,scale,pivot);return new Mesh(r.empty?emptySurface():transformed(this.surface,{scale:r.scale,origin:r.origin}),{...this,history:[],origin:r.moved});}
  withKey(key:string):Mesh<P,E,F,C>{return new Mesh(this.surface,{...this,key});}
  /** The same mesh drawn differently: `style({ stroke, fillPen, creaseAngle })`
   * sets the fields named and keeps the others. */
  style(style:Style3):Mesh<P,E,F,C>{return new Mesh(this.surface,{...this,...style});}
  steps(count:number,rule:MeshRule<StepAttributes<P>,StepAttributes<E>,StepAttributes<F>,StepAttributes<C>>|StepShorthand<MeshPointRow<StepAttributes<P>,StepAttributes<E>,StepAttributes<F>,StepAttributes<C>>,StepAttributes<P>>,...passesAndOptions:(MeshRule<StepAttributes<P>,StepAttributes<E>,StepAttributes<F>,StepAttributes<C>>|StepsOptions)[]):Mesh<StepAttributes<P>,StepAttributes<E>,StepAttributes<F>,StepAttributes<C>>{
    if(!Number.isSafeInteger(count)||count<0)throw new Error('steps count must be a nonnegative integer');
    if(stepRule(rule)){
      // Shorthand desugars to the ordinary frozen pass over every point.
      const shorthand=rule as StepShorthand<MeshPointRow<StepAttributes<P>,StepAttributes<E>,StepAttributes<F>,StepAttributes<C>>,StepAttributes<P>>;
      const {move,set}=shorthand;
      if(move===undefined&&set===undefined)throw new Error('a steps shorthand needs a move field, a set field, or both');
      rule=(current,next)=>{if(set)next.set(current.points,set);if(move)next.move(current.points,p=>{const v=evaluate(move,p);if(typeof v==='number'){const n=vertexNormals(current.surface)[p.index];if(!n)throw new Error('a scalar step needs a vertex normal: this point has no faces');return mul3(n,v);}return v;});};
    }
    const last=passesAndOptions.at(-1),options=typeof last==='object'?last:{},every=options.every??0;
    if(!Number.isSafeInteger(every)||every<0)throw new Error('steps history interval must be a nonnegative integer');
    const passes=[rule as MeshRule<StepAttributes<P>,StepAttributes<E>,StepAttributes<F>,StepAttributes<C>>,...passesAndOptions.filter((p):p is MeshRule<StepAttributes<P>,StepAttributes<E>,StepAttributes<F>,StepAttributes<C>>=>typeof p==='function')];
    let current=new Mesh<StepAttributes<P>,StepAttributes<E>,StepAttributes<F>,StepAttributes<C>>(this.surface,{...this,history:[]});const history:MeshSnapshot<StepAttributes<P>,StepAttributes<E>,StepAttributes<F>,StepAttributes<C>>[]=[];
    if(every)history.push(Object.freeze({iteration:current.iteration,geometry:current}));
    for(let k=0;k<count;k++){
      for(const pass of passes){const edit=new MeshEdit(current);try{const result:unknown=(pass as MeshRule<StepAttributes<P>,StepAttributes<E>,StepAttributes<F>,StepAttributes<C>>)(current,edit,k);if(result&&typeof (result as PromiseLike<unknown>).then==='function'){void Promise.resolve(result).catch(()=>{});throw new Error('mesh steps callbacks must be synchronous');}current=edit.finish(this.iteration+k+1);}finally{edit.close();}}
      if(every&&((k+1)%every===0||k+1===count))history.push(Object.freeze({iteration:current.iteration,geometry:current}));
    }
    return new Mesh(current.surface,{...current,history});
  }
}

/** An editor is valid only during its frozen pass; all reads use its input. */
export class MeshEdit<P extends Attributes3,E extends EdgeAttributes,F extends Attributes3,C extends Attributes3={}> {
  private active=true;
  private readonly points:SurfacePoint3[];
  private readonly edgeAttributes:Attributes3[];
  private readonly faceAttributes:Attributes3[];
  private readonly cornerAttributes:Attributes3[];
  constructor(private readonly input:Mesh<P,E,F,C>){
    this.points=input.surface.points.map(p=>({...p,position:[...p.position] as Vec3,attributes:structuredClone(p.attributes)}));
    this.edgeAttributes=input.surface.edges.map(e=>structuredClone(e.attributes));
    this.faceAttributes=input.surface.faces.map(f=>structuredClone(f.attributes));
    this.cornerAttributes=input.surface.faces.flatMap(f=>f.corners!.map(c=>structuredClone(c.attributes)));
  }
  private check<R extends {id:string;index:number}>(selection:Collection<R,unknown>,domain:'point'|'edge'|'face'|'corner'):void {
    if(!this.active)throw new Error('mesh editor is closed');
    if(!(selection instanceof Collection)||selection.domain!==domain||selection.source!==this.input.surface)throw new Error(`${domain} selection belongs to another mesh revision or domain; select from the current geometry`);
  }
  private single<R extends {id:string;index:number}>(rows:Collection<R,unknown>,row:R):Collection<R,unknown>{
    if(!this.active)throw new Error('mesh editor is closed');
    if(!rows.has(row))throw new Error('edit row belongs to another mesh revision');
    return rows.filter(r=>r.index===row.index);
  }
  private write<R extends {id:string;index:number;attributes:Readonly<Record<string,Attribute3|undefined>>}>(selection:Collection<R,unknown>,field:Field<R,object>,target:Attributes3[],domain:'point'|'edge'|'face'|'corner'):void {
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
  setFace(row:FaceRow<F>,attributes:Partial<F>):void{this.setFaces(this.single(this.input.faces,row),attributes);}
  setFaces<R extends FaceRow<F>>(selection:Collection<R,unknown>,field:Field<R,Partial<F>>):void{this.write(selection,field,this.faceAttributes,'face');}
  setCorner(row:CornerRow<C>,attributes:Partial<C>):void{this.setCorners(this.single(this.input.corners,row),attributes);}
  setCorners<R extends CornerRow<C>>(selection:Collection<R,unknown>,field:Field<R,Partial<C>>):void{this.write(selection,field,this.cornerAttributes,'corner');}
  finish(iteration:number):Mesh<P,E,F,C>{
    if(!this.active)throw new Error('mesh editor is closed');this.active=false;
    let corner=0;
    const faces=this.input.surface.faces.map((face,i)=>({...face,corners:face.corners!.map(c=>({...c,attributes:this.cornerAttributes[corner++]})),attributes:this.faceAttributes[i]}));
    const previous={...this.input.surface,edges:this.input.surface.edges.map((edge,i)=>({...edge,attributes:this.edgeAttributes[i]}))};
    inheritTopology3(previous,this.input.surface);
    return new Mesh(ownSurface3(assembleSurface3(this.points,faces,this.input.surface.triangles,previous)),{...this.input,iteration,history:[]});
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
export function mesh(source:Surface3,options?:GeometryOptions):Mesh<Attributes3,Attributes3,Attributes3,Attributes3>;
export function mesh(positions:readonly Vec3[],faces:readonly (readonly number[])[],options?:GeometryOptions):Mesh;
export function mesh(source:Surface3|readonly Vec3[],facesOrOptions:readonly (readonly number[])[]|GeometryOptions={},options:GeometryOptions={}):Mesh<any,any,any,any>{
  if(Array.isArray(source)){
    if(!Array.isArray(facesOrOptions))throw new Error('mesh positions require polygon index arrays');
    return new Mesh(ownSurface3(surface3(source,facesOrOptions)),options);
  }
  validateImportedSurface(source as Surface3);
  return new Mesh(source as Surface3,facesOrOptions as GeometryOptions);
}
/** One quad with a stored unit-square XY chart. Subdivision preserves this chart. */
export function plane(width=1,height=width,options:GeometryOptions={}):Mesh<{},{},{},SurfaceUV>{
  if(![width,height].every(n=>Number.isFinite(n)&&n>0))throw new Error('plane dimensions must be positive and finite');
  const source=surface3([[-width/2,-height/2,0],[width/2,-height/2,0],[width/2,height/2,0],[-width/2,height/2,0]],[[0,1,2,3]]);
  const uv:readonly (readonly [number,number])[]=[[0,0],[1,0],[1,1],[0,1]];
  return new Mesh(ownSurface3(chartSurface3(source,(_,c)=>({uv:uv[c],chart:'plane'}))),options);
}
/** Each outward-wound face has its own unit-square chart; vertices stay shared. */
export function box(size:number|Vec3=1,options:GeometryOptions={}):Mesh<{},{},{},SurfaceUV>{
  const source=box3(typeof size==='number'?[size,size,size]:size),uv:readonly (readonly [number,number])[]=[[0,0],[1,0],[1,1],[0,1]];
  return new Mesh(ownSurface3(chartSurface3(source,(f,c)=>({uv:uv[c],chart:source.faces[f].id}))),options);
}
export function pointCloud(positions:readonly Vec3[],options:GeometryOptions={}):PointGeometry{return new PointGeometry(ownSurface3(surface3(positions,[])),options);}
