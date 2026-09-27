/**
 * @internal The 3D words of the one geometry.
 *
 * A value in space is a `Material` with a `z` column (geometry/value.ts).
 * The words it shares with a value in the plane are told apart by what they
 * take — `extrude` of a face selection, `translate` by a 3-vector, `rotate`
 * by anything but a number of degrees, `scale` by three factors,
 * `transform` by a placement of space, `smooth` of a face or corner column —
 * and the words only a value in space has (`subdivide`, the booleans,
 * `dual`, `displace`) refuse by name on a value with no faces where they
 * need faces. The core declares every one of them on `Material` and
 * delegates through its registry; these are the implementations the 3D
 * layer fills it with (`WORDS3`).
 *
 * Every word reads the value's working view (`surfaceOf`), runs the kernel
 * it always ran, and hands the kernel's surface back through `value3`: a
 * row the kernel kept keeps its id, and a derivation (subdivide, extrude, a
 * boolean, dual) links each row it made to the rows it came from, which
 * `row.source` answers.
 */

import {WORDS_3D,type Material,type Words3,type Vertex} from '../../material.js';
import {selectionIn,type Selection} from '../../selection.js';
import type {Face} from '../../faces.js';
import {carryLinks,type DomainSpec,type SourceSpec} from '../../derivation.js';
import {isSpacePlacement,type Placement as Isometry} from '../../placement.js';
import {rotation3,axisAngle,rotateVector3,vector3,type Rotation,type RotationInput,type RotationData,type Axis3} from '../rotation.js';
import {assembleSurface3,surface3,type Attribute3,type Surface3} from '../geometry/surface.js';
import {ownSurface3,transformSurface3,transformPosition3,faceGeometry3} from '../geometry/model.js';
import {add3,sub3,mul3,dot3,cross3,finite3,type Vec3} from '../math.js';
import {sampleValue} from '../degenerate.js';
import {subdivideSurface,type SubdivisionOptions} from './subdivide.js';
import {extrudeRegion3,regionDirection3} from '../geometry/extrude.js';
import {dualSurface3,type DualOptions} from '../geometry/dual.js';
import {booleanSurface3,type BooleanOperation3} from '../geometry/boolean.js';
import {evaluate,type Field} from './columns.js';
import {value3,surfaceOf,kernelOf,type Carry3,type Kernel3} from '../geometry/value.js';
import {partsOfView} from '../geometry/parts.js';
import {topology3} from '../geometry/topology.js';
import {curveLength,alongSurface,resampledSurface} from './curveWalk.js';
import {samplesOf,rebindSamples} from './sampling.js';
import {curveSamplesOf,rebindCurveSamples} from './curveSampling.js';

// ─── the value's own state ───────────────────────────────────────────

const ORIGIN:Vec3=Object.freeze([0,0,0]) as unknown as Vec3;
const IDENTITY=rotation3([0,0,0]);
/** The state a value carries into a result that keeps its rows: its pivot,
 * orientation, radial centre, transfer policies and key. */
function kept(m:Material,more:Partial<Carry3>={}):Carry3 {
  const k=kernelOf(m);
  return {
    from:m,origin:k.origin,orientation:k.orientation,
    ...(k.radialCentre!==undefined?{radialCentre:k.radialCentre}:{}),
    transfers:m.transfers,
    ...(k.key!==undefined?{key:k.key}:{}),
    // The same faces answer the same source (points and edges carry theirs
    // through the links).
    ...(m.stated?.source!==undefined?{source:{faces:m.stated.source}}:{}),
    ...more,
  };
}
/** A result with every row of `m`: its links carry, as a write's do. */
const sameRows=(m:Material,out:Material):Material=>carryLinks(m,out);
const hasFaces=(m:Material):boolean=>surfaceOf(m).faces.length>0;
function refuseNoFaces(m:Material,who:string):void {
  if(!hasFaces(m))throw new Error(`${who}: this value has no faces — ${who} works on a geometry with faces (plane, box, sphere, a mesh); a value of points or curves has none`);
}

// ─── source: the rows a derivation read ──────────────────────────────

type Domain='points'|'edges'|'faces'|'corners';
const DOMAINS:readonly Domain[]=['points','edges','faces','corners'];
/** What a derivation may read besides a geometry: a set of instances,
 * whose rows are named by their own ids. */
interface Rows3 {readonly rows:readonly {readonly id:string}[]}
/** @internal An input a derivation read: a geometry, or instances. */
export type Input3=Material|Rows3;
const isRows=(input:Input3):input is Rows3=>!('store' in input);
/** name → row, per domain, of an input's working view. */
const nameIndex=new WeakMap<object,Map<string,{domain:Domain|'instances';row:number}>>();
function rowsByName(input:Input3):Map<string,{domain:Domain|'instances';row:number}> {
  let index=nameIndex.get(input);
  if(index)return index;
  index=new Map();
  if(isRows(input))input.rows.forEach((r,row)=>index!.set(r.id,{domain:'instances',row}));
  else{
    const names=partsOfView(surfaceOf(input))!.names;
    for(const d of DOMAINS)names[d].forEach((name,row)=>{if(!index!.has(name))index!.set(name,{domain:d,row});});
  }
  nameIndex.set(input,index);
  return index;
}
/** A row of an input, as a sketch reads it. */
function rowOf(input:Input3,domain:Domain|'instances',row:number):unknown {
  if(isRows(input))return input.rows[row];
  return (input as unknown as Record<Domain,Selection<unknown>>)[domain as Domain].at(row);
}
function rowsOf(input:Input3,domain:Domain|'instances',rows:readonly number[]):unknown {
  if(rows.length===1||isRows(input))return rowOf(input,domain,rows[0]);
  return (input as unknown as Record<Domain,Selection<unknown>>)[domain as Domain].rows(rows);
}
/** Where one row came from: per input it read, the rows of one domain. */
interface Found {readonly input:number;readonly domain:Domain|'instances';readonly rows:number[]}
/**
 * What each row of a derivation's surface came from, in the inputs it read:
 * a row the derivation made names its parents (its lineage record for this
 * operation); a row it kept as it was is its own row in the first input.
 */
function foundOf(operation:string,inputs:readonly Input3[],id:string,provenance:{operation:string;parents:readonly string[];inputs?:readonly number[]}|undefined):readonly Found[] {
  const own=provenance!==undefined&&provenance.operation===operation;
  const parents=own?provenance!.parents:[id],where=own?provenance!.inputs:undefined;
  const groups:Found[]=[];
  parents.forEach((name,k)=>{
    const tried=where!==undefined?[where[k]]:inputs.map((_,i)=>i);
    for(const i of tried){
      const input=inputs[i];if(input===undefined)continue;
      const found=rowsByName(input).get(name);if(found===undefined)continue;
      let g=groups.find(x=>x.input===i&&x.domain===found.domain);
      if(!g)groups.push(g={input:i,domain:found.domain,rows:[]});
      if(!g.rows.includes(found.row))g.rows.push(found.row);
      break;
    }
  });
  return groups;
}
/** One answer: a row, a selection of one domain of one input, or a list
 * with one of those per input. */
function answerOf(inputs:readonly Input3[],groups:readonly Found[]):unknown {
  if(groups.length===0)return undefined;
  const one=(g:Found)=>rowsOf(inputs[g.input],g.domain,g.rows);
  return groups.length===1?one(groups[0]):Object.freeze(groups.map(one));
}
/** The core's spec for one domain: one spec when every row with an answer
 * names one domain of one input, a list when every row names the same
 * inputs in the same order (a sweep point: a profile point and a path
 * point); corners have no link and are left out. */
function specOf(inputs:readonly Input3[],rows:readonly (readonly Found[])[]):DomainSpec|undefined {
  let shape:string|undefined;
  for(const groups of rows){
    if(groups.length===0)continue;
    const s=groups.map(g=>`${g.input}:${g.domain}`).join(',');
    if(shape===undefined)shape=s;
    else if(shape!==s)return undefined;
  }
  if(shape===undefined)return undefined;
  const shapes=shape.split(',').map(x=>{const [i,d]=x.split(':');return {input:Number(i),domain:d as Domain|'instances'};});
  if(shapes.some(x=>x.domain==='corners'||x.domain==='instances'||isRows(inputs[x.input])))return undefined;
  // One parent answers a row and several a selection: rows of both kinds in
  // one domain are read row by row.
  const counts=new Set(rows.flatMap(groups=>groups.map(g=>g.rows.length===1)));
  if(counts.size>1)return undefined;
  const specs=shapes.map((x,k):SourceSpec=>{
    const many=rows.map(groups=>groups.length===0?undefined:groups[k].rows);
    const of=inputs[x.input] as Material,domain=x.domain as 'points'|'edges'|'faces';
    return many.every(r=>r===undefined||r.length===1)?{of,domain,rows:Int32Array.from(many,r=>r===undefined?-1:r[0])}:{of,domain,many};
  });
  return {source:specs.length===1?specs[0]:specs};
}
export function sourceOf3(operation:string,surface:Surface3,inputs:readonly Input3[]):NonNullable<Carry3['source']> {
  const found=(rows:readonly {id:string;provenance?:{operation:string;parents:readonly string[];inputs?:readonly number[]}}[])=>rows.map(r=>foundOf(operation,inputs,r.id,r.provenance));
  // One shape for the whole domain goes to the core as rows; a shape that
  // varies row by row (a boolean's point from either solid) is read per row.
  const spec=(rows:readonly (readonly Found[])[]):DomainSpec|undefined=>specOf(inputs,rows)??(rows.some(g=>g.length>0)?{source:{read:(i:number)=>answerOf(inputs,rows[i])}}:undefined);
  const points=spec(found(surface.points)),edges=spec(found(surface.edges));
  // A face answers what its record says, read the first time it is asked.
  const faceMemo=new Map<number,unknown>();
  const faces=(f:number):unknown=>{
    if(!faceMemo.has(f)){const row=surface.faces[f];faceMemo.set(f,answerOf(inputs,foundOf(operation,inputs,row.id,row.provenance)));}
    return faceMemo.get(f);
  };
  return {...(points?{points}:{}),...(edges?{edges}:{}),faces};
}
/** A derivation's surface as the one geometry, its rows linked to its inputs. */
function derivedValue(operation:string,m:Material,surface:Surface3,inputs:readonly Input3[],more:Partial<Carry3>={}):Material {
  // A derivation drops a recorded radial centre unless it says it keeps one.
  return value3(surface,{...kept(m,{radialCentre:undefined,...more}),source:sourceOf3(operation,surface,inputs)});
}

// ─── pivots and placements ───────────────────────────────────────────

/** A pivot in 3D: a point, `'center'` for the middle of the value's own
 * bounds, or `'centroid'` for its area centroid (the mean of its points
 * when it has no triangles). */
export type Origin3='center'|'centroid'|Vec3;
export interface RotateOptions3 {
  /** Pivot (see `Origin3`); the object's own origin when unset. */
  readonly origin?:Origin3;
  /** Read the axis in the object's current frame instead of world axes. */
  readonly local?:boolean;
}
export interface ScaleOptions3 {readonly origin?:Origin3}
interface Pivoted {readonly surface:Surface3;readonly origin:Vec3;readonly orientation:Rotation}
const pivoted=(m:Material):Pivoted=>{const k=kernelOf(m);return {surface:surfaceOf(m),origin:k.origin,orientation:k.orientation};};

function pivotOf(verb:string,options:RotateOptions3|ScaleOptions3|undefined,self:Pivoted):Vec3 {
  if(options&&(options as {about?:unknown}).about!==undefined)throw new Error(`${verb}: 'about' is spelled origin — { origin: [x, y, z] | 'center' | 'centroid' }; the object's own origin is the default and the world's is [0, 0, 0]`);
  const o=options?.origin;
  if(o===undefined)return self.origin;
  if(Array.isArray(o)){finite3(o as Vec3);return o as Vec3;}
  if(o!=='center'&&o!=='centroid')throw new Error(`${verb}: origin is a point [x, y, z], 'center' or 'centroid' — got ${typeof o==='string'?`'${o}'`:JSON.stringify(o)}`);
  const pts=self.surface.points;
  if(pts.length===0)return self.origin;
  if(o==='center'){
    const lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];
    for(const p of pts)for(let k=0;k<3;k++){lo[k]=Math.min(lo[k],p.position[k]);hi[k]=Math.max(hi[k],p.position[k]);}
    return [(lo[0]+hi[0])/2,(lo[1]+hi[1])/2,(lo[2]+hi[2])/2];
  }
  // Area-weighted triangle centroids: the centroid of the surface itself.
  let area=0;const c=[0,0,0];
  for(const t of self.surface.triangles){
    const [a,b,d]=t.vertices.map(i=>pts[i].position);
    const u=sub3(b,a),v=sub3(d,a);
    const n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
    const w=Math.hypot(n[0],n[1],n[2])/2;
    area+=w;for(let k=0;k<3;k++)c[k]+=w*(a[k]+b[k]+d[k])/3;
  }
  if(area>0)return [c[0]/area,c[1]/area,c[2]/area];
  for(const p of pts)for(let k=0;k<3;k++)c[k]+=p.position[k];
  return [c[0]/pts.length,c[1]/pts.length,c[2]/pts.length];
}
function isRotationInput(value:unknown):value is RotationInput {
  return Array.isArray(value)||(typeof value==='object'&&value!==null&&(value as RotationData).kind==='rotation');
}
/** The object's origin after turning about a pivot: it rides along like every
 * other point, so a later default rotation still turns in place. */
function movedOrigin(self:Pivoted,pivot:Vec3,move:(v:Vec3)=>Vec3):Vec3{return Object.freeze(add3(pivot,move(sub3(self.origin,pivot)))) as unknown as Vec3;}
function rotationArguments(self:Pivoted,a:RotationInput|Axis3,b?:number|Vec3|RotateOptions3,c?:RotateOptions3):{rotate:Rotation;origin:Vec3;orientation:Rotation;moved:Vec3} {
  let rotate:Rotation,options:RotateOptions3={};
  if(typeof b==='number'){
    if(!Number.isFinite(b))throw new Error('rotate degrees must be finite');
    options=c??{};
    const axis:Axis3=options.local?rotateVector3(typeof a==='string'?(a==='x'?[1,0,0]:a==='y'?[0,1,0]:[0,0,1]):vector3(a as Vec3),self.orientation):a as Axis3;
    rotate=axisAngle(axis,b);
  }else{
    if(!isRotationInput(a))throw new Error('rotate takes degrees about z, Euler degrees [x, y, z], a rotation value, or an axis with degrees');
    rotate=rotation3(a);
    if(Array.isArray(b)){finite3(b as Vec3);return {rotate,origin:b as Vec3,orientation:self.orientation.then(rotate),moved:movedOrigin(self,b as Vec3,v=>rotate.apply(v))};}
    options=(b as RotateOptions3|undefined)??{};
  }
  const origin=pivotOf('rotate',options,self);
  return {rotate,origin,orientation:self.orientation.then(rotate),moved:movedOrigin(self,origin,v=>rotate.apply(v))};
}
/** The image of a recorded centre under the same affine edit the points took. */
const movedCentre=(centre:Vec3|undefined,options:Parameters<typeof transformSurface3>[1]):Vec3|undefined=>centre&&transformPosition3(centre,options);
const transformed=(surface:Surface3,options:Parameters<typeof transformSurface3>[1]):Surface3=>ownSurface3(transformSurface3(surface,options));

// ─── the words a value in the plane shares ───────────────────────────

/** `translate([x, y, z])`: every point moved, the object's origin with it. */
export function translate3(m:Material,by:unknown):Material {
  const offset=Array.isArray(by)?by as unknown as Vec3:[(by as {x:number}).x,(by as {y:number}).y,(by as {z:number}).z] as Vec3;
  finite3(offset);
  const k=kernelOf(m),origin=k.origin;
  return sameRows(m,value3(transformed(surfaceOf(m),{translate:offset}),kept(m,{origin:add3(origin,offset),radialCentre:movedCentre(k.radialCentre,{translate:offset})})));
}
/** `rotate(angles | rotation, pivot?)` or `rotate(axis, degrees, { origin, local })`. */
export function rotate3(m:Material,a:unknown,b?:unknown,c?:unknown):Material {
  const self=pivoted(m),r=rotationArguments(self,a as RotationInput|Axis3,b as number|Vec3|RotateOptions3|undefined,c as RotateOptions3|undefined);
  return sameRows(m,value3(transformed(self.surface,{rotate:r.rotate,origin:r.origin}),kept(m,{orientation:r.orientation,origin:r.moved,radialCentre:movedCentre(kernelOf(m).radialCentre,{rotate:r.rotate,origin:r.origin})})));
}
/** `scale(k | [x, y, z], pivot?)`. A zero factor is allowed: a value
 * scaled to nothing keeps its points on the pivot and has no faces or
 * edges left to draw. */
export function scale3(m:Material,k:unknown,b?:unknown):Material {
  const self=pivoted(m),factors:Vec3=typeof k==='number'?[k,k,k]:k as unknown as Vec3;finite3(factors);
  const origin=Array.isArray(b)?b as unknown as Vec3:pivotOf('scale',b as ScaleOptions3|undefined,self);if(Array.isArray(b))finite3(origin);
  const moved=movedOrigin(self,origin,v=>[v[0]*factors[0],v[1]*factors[1],v[2]*factors[2]]);
  if(factors.some(f=>f===0)){
    const s=self.surface,faceless=s.faces.length===0&&s.edges.length===0;
    // Points alone collapse onto the pivot; anything with edges or faces
    // is nothing to draw.
    const surface=faceless?ownSurface3(assembleSurface3(s.points.map(p=>({...p,position:add3(origin,sub3(p.position,origin).map((v,i)=>v*factors[i]) as unknown as Vec3)})),[],[])):ownSurface3(surface3([],[]));
    return value3(surface,kept(m,{origin:moved,radialCentre:undefined}));
  }
  return sameRows(m,value3(transformed(self.surface,{scale:factors,origin}),kept(m,{origin:moved,radialCentre:movedCentre(kernelOf(m).radialCentre,{scale:factors,origin})})));
}
/** `transform(placement)` with a placement of space (`observer`, a
 * honeycomb's placements): every point through it, every row and column
 * kept. A Lorentz isometry moves the Klein ball projectively, so a flat
 * face stays flat; one that turns space over rewinds every face. */
export function transform3(m:Material,placement:Isometry<Vec3>):Material {
  if(!isSpacePlacement(placement))throw new Error('transform takes a placement of 3D space — an observer, or one of a honeycomb\'s placements; a placement of the plane moves sketch points');
  const surface=surfaceOf(m),points=surface.points.map(p=>({...p,position:placement.point(p.position)}));
  let out:Surface3;
  if(placement.orientation>0)out=ownSurface3(assembleSurface3(points,surface.faces,surface.triangles,surface));
  else{
    const faces=surface.faces.map(f=>({...f,vertices:[...f.vertices].reverse(),corners:f.corners&&[...f.corners].reverse()}));
    const triangles=surface.triangles.map(t=>({...t,vertices:[t.vertices[0],t.vertices[2],t.vertices[1]] as [number,number,number]}));
    out=ownSurface3(assembleSurface3(points,faces,triangles,surface));
  }
  const k=kernelOf(m);
  return sameRows(m,value3(out,kept(m,{origin:placement.point(k.origin),radialCentre:undefined})));
}

/** One connected component of an extrusion selection, measured on the input. */
export interface ExtrudeRegion {
  readonly index:number;readonly faces:Selection<Face>;
  /** Unit area-weighted mean normal; undefined when the region's faces cancel. */
  readonly normal?:Vec3;readonly centroid:Vec3;readonly area:number;
}
export type ExtrudeOffset=number|Vec3|((region:ExtrudeRegion)=>Vec3)|{readonly distance:Field<ExtrudeRegion,number>};
export interface ExtrudeOptions {
  /** The name generated points, walls and corners are made under; default 'extrude'. */
  readonly key?:string;
}
const regionCenterRefused=():never=>{throw new Error('an extrude region\'s middle is `centroid` (the 2D face word)');};
/** `extrude(faces, offset, options?)`: one vector per connected component
 * of the selection, a translated cap that keeps its faces, and one wall per
 * region boundary edge (holes and open sheet edges included). Faces that
 * touch no other selected face are each their own region. */
export function extrude3(m:Material,faces:Selection<Face>,offset:unknown,options:unknown={}):Material {
  const opts=(options??{}) as ExtrudeOptions;
  if(typeof opts!=='object'||Array.isArray(opts))throw new Error('extrude options must be an object');
  // A selection from an earlier state is read on this one; faces that are
  // gone are skipped.
  const sel=selectionIn(faces,m);
  let off=offset as ExtrudeOffset;
  if(typeof off==='number')off={distance:off};
  if(off===undefined||off===null||typeof off!=='function'&&!Array.isArray(off)&&(typeof off!=='object'||!('distance'in off)))throw new Error('extrude offset must be a distance, a vector, a region callback or { distance }');
  const key=opts.key??'extrude';if(typeof key!=='string'||!key)throw new Error('extrude key must be a nonempty string');
  const surface=surfaceOf(m);
  const components=sel.components().map((component,index)=>{
    const measure=regionDirection3(surface,component.indices);
    const region:ExtrudeRegion=Object.freeze(Object.defineProperty({index,faces:component,normal:measure.normal&&Object.freeze(measure.normal) as Vec3,centroid:Object.freeze(measure.center) as Vec3,area:measure.area},'center',{get:regionCenterRefused,enumerable:false}));
    let vector:Vec3;
    if(Array.isArray(off))vector=off as Vec3;
    else if(typeof off==='function')vector=off(region);
    else{
      // A region whose faces cancel has no direction to follow, and a
      // distance the field could not answer is no distance: that region
      // stays where it is and the others still extrude.
      const distance=sampleValue(evaluate((off as {distance:Field<ExtrudeRegion,number>}).distance,region),0);
      vector=region.normal?[region.normal[0]*distance,region.normal[1]*distance,region.normal[2]*distance]:[0,0,0];
    }
    if(!Array.isArray(vector)||vector.length!==3)throw new Error(`extrude offset must produce a 3-vector for region ${index}`);
    finite3(vector);
    return {index,faces:component.indices,vector:[vector[0],vector[1],vector[2]] as Vec3};
  });
  return derivedValue('extrude',m,extrudeRegion3(surface,components,key),[m]);
}

/** `smooth(name, { steps })` of a face or a corner column: each row the
 * mean of itself and its neighbours, `steps` times — faces over shared
 * edges, corners over the corners of their point and face. Numbers and
 * numeric vectors only. */
export function smooth3(m:Material,name:string,options:{readonly steps?:number}={}):Material {
  const steps=options.steps??1;if(!Number.isSafeInteger(steps)||steps<0)throw new Error('smooth steps must be a nonnegative integer');
  const surface=surfaceOf(m);
  const domain=Object.hasOwn(surface.faces[0]?.attributes??{},name)?'faces':Object.hasOwn(surface.faces[0]?.corners?.[0]?.attributes??{},name)?'corners':undefined;
  if(!domain)throw new Error(`smooth: no point, edge, face or corner column '${name}' to smooth`);
  const mean=(values:readonly (Attribute3|undefined)[]):Attribute3=>{
    if(values.every(v=>typeof v==='number'))return (values as number[]).reduce((a,b)=>a+b,0)/values.length;
    if(values.every(v=>Array.isArray(v)&&v.length===(values[0] as number[]).length))return (values[0] as number[]).map((_,k)=>values.reduce<number>((a,v)=>a+(v as number[])[k],0)/values.length);
    throw new Error(`smooth needs numeric values in '${name}'`);
  };
  type Row=Record<string,unknown>&{readonly adjacent:Selection<Row>;readonly point:{readonly corners:Selection<Row>};readonly face:{readonly corners:Selection<Row>}};
  let current=m;
  for(let i=0;i<steps;i++){
    const sel=(current as unknown as Record<string,Selection<Row>&{set(n:string,f:(r:Row)=>unknown):Material}>)[domain];
    current=domain==='faces'
      ?sel.set(name,f=>mean([f[name] as Attribute3,...f.adjacent.map(g=>g[name] as Attribute3)]))
      :sel.set(name,c=>mean([c[name] as Attribute3,...c.point.corners.map(d=>d[name] as Attribute3),...c.face.corners.map(d=>d[name] as Attribute3)]));
  }
  return current;
}

// ─── the words only a value in space has ─────────────────────────────

/** `subdivide(levels, options?)`: every face split round its middle,
 * `levels` times; point and corner columns refine by their transfer policy,
 * face and edge columns pass to the children. */
export function subdivide3(m:Material,levels=1,options:SubdivisionOptions={}):Material {
  refuseNoFaces(m,'subdivide');
  return derivedValue('subdivide',m,subdivideSurface(surfaceOf(m),levels,options,m.transfers,{}),[m]);
}
/** The booleans: both values closed solids; the seam is exact, and the
 * faces along it answer `cut`. An uncut face of the first keeps its row
 * identity and columns; a face of the other keeps its columns. */
export function boolean3(operation:BooleanOperation3):(m:Material,other:Material)=>Material {
  return (m,other)=>{
    if(typeof other!=='object'||other===null||!('surfaceBox' in other))throw new Error(`${operation}: the second value is not a mesh — a geometry with faces`);
    refuseNoFaces(m,operation);refuseNoFaces(other,operation);
    return derivedValue(operation,m,ownSurface3(booleanSurface3(operation,surfaceOf(m),surfaceOf(other))),[m,other],{transfers:{},radialCentre:undefined});
  };
}
/** `dual(options?)`: one point per face at its middle, one face per vertex
 * walking the faces around it. Numeric face columns become point columns
 * and point columns face columns; a rim vertex has no ring and no face. */
export function dual3(m:Material,options:DualOptions={}):Material {
  if(!options||typeof options!=='object'||Array.isArray(options))throw new Error('dual options must be an object');
  refuseNoFaces(m,'dual');
  // The dual of a shell star-shaped about a point is star-shaped about it.
  return derivedValue('dual',m,ownSurface3(dualSurface3(surfaceOf(m),options)),[m],{transfers:{},radialCentre:kernelOf(m).radialCentre});
}

export interface DisplaceOptions {
  /** Direction of a scalar displacement: the vertex normal (default), an axis, or a fixed vector. */
  readonly along?:'normal'|'x'|'y'|'z'|Vec3;
}
/** Angle-weighted vertex normals over the fixed triangles; a point with no
 * faces has no normal. */
function vertexNormals(surface:Surface3):(Vec3|null)[] {
  const sums=surface.points.map(()=>[0,0,0] as number[]);
  for(const t of surface.triangles){
    const p=t.vertices.map(v=>surface.points[v].position),n=cross3(sub3(p[1],p[0]),sub3(p[2],p[0]));
    for(let k=0;k<3;k++){const a=sub3(p[(k+1)%3],p[k]),b=sub3(p[(k+2)%3],p[k]),la=Math.hypot(...a),lb=Math.hypot(...b);
      const angle=la&&lb?Math.acos(Math.max(-1,Math.min(1,dot3(a,b)/(la*lb)))):0;const s=sums[t.vertices[k]];s[0]+=n[0]*angle;s[1]+=n[1]*angle;s[2]+=n[2]*angle;}
  }
  return sums.map(s=>{const l=Math.hypot(s[0],s[1],s[2]);return l>0?[s[0]/l,s[1]/l,s[2]/l] as Vec3:null;});
}
/** `displace(field, options?)`: every point moved by a vector, or by a
 * number along its vertex normal (`along` chooses another direction). A
 * point the field cannot answer, or with no normal to follow, stays. */
export function displace3(m:Material,field:Field<unknown,Vec3|number>,options:DisplaceOptions={}):Material {
  const surface=surfaceOf(m),along=options.along??'normal';
  const axis:Vec3|undefined=along==='x'?[1,0,0]:along==='y'?[0,1,0]:along==='z'?[0,0,1]:along==='normal'?undefined:along;
  if(axis)finite3(axis);
  let normals:(Vec3|null)[]|undefined;
  const rows=[...(m as unknown as {points:Iterable<unknown>}).points];
  const points=rows.map((row,i)=>{
    const value=evaluate(field,row);
    let delta:Vec3;
    if(typeof value==='number'){
      const amount=sampleValue(value,0),direction=axis??(normals??=vertexNormals(surface))[i];
      delta=direction?mul3(direction,amount):[0,0,0];
    }else{delta=value;finite3(delta);}
    return {...surface.points[i],position:add3(surface.points[i].position,delta)};
  });
  // Moved points keep a star-shaped solid's recorded centre: nothing trusts
  // it, every certificate re-proves it.
  return sameRows(m,value3(ownSurface3(assembleSurface3(points,surface.faces,surface.triangles,surface)),kept(m)));
}

// ─── curves in space ─────────────────────────────────────────────────

/** `length` of a value in space: every edge once, in world units. */
export function length3(m:Material):number {return curveLength(surfaceOf(m));}
/** `along({ count } | { spacing })` of a value in space: points by arc
 * length on its one unbranched curve, each with `s`, `u` and the unit
 * `tangent`, the curve's point columns carried, and `source` the edge
 * under it. A branched curve is refused by name. */
export function along3(m:Material,opts:{readonly count?:number;readonly spacing?:number}={}):Material {
  return derivedValue('along',m,alongSurface(surfaceOf(m),opts),[m],{origin:ORIGIN,orientation:IDENTITY,radialCentre:undefined});
}
/** `resample({ count } | { spacing })` of a value in space: the same path
 * with its points redistributed by arc length; each point's `source` is
 * the edge under it. */
export function resample3(m:Material,opts:{readonly count?:number;readonly spacing?:number}={}):Material {
  return derivedValue('resample',m,resampledSurface(surfaceOf(m),opts),[m]);
}

// ─── row words ───────────────────────────────────────────────────────

/** A face of a value in space, measured on its fixed triangles: its unit
 * normal, its area and its area centroid. */
export function faceWords3(m:Material,f:number):{readonly normal:Vec3;readonly area:number;readonly centroid:Vec3} {
  const g=faceGeometry3(surfaceOf(m));
  return {normal:g.normals[f],area:g.areas[f],centroid:g.centers[f]};
}
/** The middle of an edge of a value in space. */
export function edgeCenter3(m:Material,e:number):Vec3 {
  const s=surfaceOf(m),edge=s.edges[e],a=s.points[edge.vertices[0]].position,b=s.points[edge.vertices[1]].position;
  return mul3(add3(a,b),0.5);
}
/** The faces and corners around a point of a value in space, in row order. */
export function pointFaces3(m:Material,p:number):readonly number[]{return topology3(surfaceOf(m)).pointFaces[p];}
export function pointCorners3(m:Material,p:number):readonly number[]{return topology3(surfaceOf(m)).pointCorners[p];}

/** The recorded radial centre of `m` (see `Kernel3`). */
export const radialCentreOf=(m:Material):Vec3|undefined=>kernelOf(m).radialCentre;
export type {Kernel3};

/** `rebind(target)`: points sampled on a surface back on the same places of
 * an edited revision of it; points sampled on surface curves back on the
 * same places of curves rebuilt from the same construction. */
export function rebind3(m:Material,target:unknown):Material {
  if(samplesOf(m)!==undefined)return rebindSamples(m,target as Material);
  if(curveSamplesOf(m)!==undefined)return rebindCurveSamples(m,target as never);
  throw new Error('rebind: this value carries no samples — t.scatter on a geometry with faces, or t.sample on surface curves, makes points that rebind');
}
/** `place(instances)` belongs to curves attached to a surface. */
export function place3(_m:Material,_instances:unknown):Material {
  throw new Error('place: only curves attached to a prototype surface (intersections, isolines, hatch, trace, mapSurface) are placed at instances');
}

/** The implementations, by the name the core's registry takes them under. */
export const WORDS3:Words3&{readonly length:(m:Material)=>number}=Object.freeze({
  translate:translate3,rotate:rotate3,scale:scale3,transform:transform3,extrude:extrude3,smooth:smooth3,
  subdivide:subdivide3,union:boolean3('union'),subtract:boolean3('subtract'),intersect:boolean3('intersect'),dual:dual3,displace:displace3,
  along:along3,resample:resample3,length:length3,rebind:rebind3,place:place3,
  faceWords:faceWords3,edgeCenter:edgeCenter3,
});

// The words a value in space answers, typed for a sketch: the core declares
// each as a method that delegates here; these are its 3D signatures.
declare module '../../material.js' {
  interface Material {
    /** Every point moved by a vector, or by a number along its vertex
     * normal (`along` chooses another direction). */
    displace(field:Vec3|number|((p:Vertex)=>Vec3|number),options?:DisplaceOptions):Material;
    /** Every face split round its middle, `levels` times. */
    subdivide(levels?:number,options?:SubdivisionOptions):Material;
    /** One point per face, one face per vertex. */
    dual(options?:DualOptions):Material;
    /** Connected regions of faces raised by an offset: a distance along the
     * region's normal, a vector, `{ distance }`, or a function of the region. */
    extrude(faces:Selection<Face>,offset:ExtrudeOffset,options?:ExtrudeOptions):Material;
  }
}

// The core's 3D words delegate here from the moment the 3D layer loads.
Object.assign(WORDS_3D,WORDS3);
