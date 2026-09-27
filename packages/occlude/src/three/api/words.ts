/**
 * @internal The 3D words of the one geometry.
 *
 * A value in space is a `Material` with a `z` column (geometry/value.ts).
 * The words it shares with a value in the plane are told apart by what they
 * take — `extrude` of a face selection, `translate` by a 3-vector (or by
 * a pair on a value with a `z`), `rotate` by anything but a number of
 * degrees (or by a number on a value with a `z`), `scale` by three factors
 * (or by one or two on a value with a `z`),
 * `transform` by a placement of space, `smooth` of a face or corner column —
 * and the words only a value in space has (`subdivide`, the booleans,
 * `dual`, `displace`) refuse by name on a value with no faces where they
 * need faces. The core declares every one of them on `Material` and calls
 * the one here.
 *
 * A motion of space (`translate`, `rotate`, `scale`, `transform`,
 * `displace`) is a map over the x, y and z columns (`mapPositions3`): every
 * row and column is kept. A derivation (subdivide, extrude, dual, a boolean, the curve
 * walks) reads the value through its kernels' reader (`mesh3`) and answers
 * columns (`Made3`), which `made3` makes the next value of: a row the kernel
 * kept keeps its id, and each row it made is linked to the rows it came
 * from, which `row.source` answers.
 */

import type {Material,Vertex} from '../../material.js';
import {selectionIn,type Selection} from '../../selection.js';
import {inSpace3} from '../../material.js';
import type {Face} from '../../faces.js';
import {carryLinks} from '../../derivation.js';
import {isSpacePlacement,type Placement as Isometry} from '../../placement.js';
import {Column} from '../../column.js';
import {rotation3,axisAngle,rotateVector3,vector3,type Rotation,type RotationInput,type RotationData,type Axis3} from '../rotation.js';
import {transformPosition3,type Attribute3} from '../geometry/model.js';
import {triangulate,mesh3,made3,kernelColumn,sourceOfMade3,NO_ROWS3,type Made3,type MadeCarry3,type Mesh3,type Columns3} from '../geometry/mesh3.js';
import {add3,sub3,mul3,dot3,cross3,finite3,unit3,type Vec3} from '../math.js';
import {sampleValue} from '../degenerate.js';
import {subdivideMesh3,type SubdivisionOptions} from './subdivide.js';
import {extrudeRegion3,regionDirection3} from '../geometry/extrude.js';
import {dualMesh3,type DualOptions} from '../geometry/dual.js';
import {booleanMesh3,type BooleanOperation3} from '../geometry/boolean.js';
import {evaluate,describe3,type Field} from './columns.js';
import {frameOf,hasFaces,mapPositions3,type Frame3} from '../geometry/value.js';
import {alongSurface,resampledSurface} from './curveWalk.js';
import {samplesOf,rebindSamples} from './sampling.js';
import {curveSamplesOf,rebindCurveSamples} from './curveSampling.js';

// ─── the value's own state ───────────────────────────────────────────

const ORIGIN:Vec3=Object.freeze([0,0,0]) as unknown as Vec3;
const IDENTITY=rotation3([0,0,0]);
/** The state a value carries into a result that keeps its rows: its
 * origin, orientation, radial centre, transfer policies and key. */
function kept(m:Material,more:Partial<MadeCarry3>={}):MadeCarry3 {
  return {
    from:m,
    ...(m.origin!==undefined?{origin:m.origin}:{}),
    ...(m.orientation!==undefined?{orientation:m.orientation}:{}),
    ...(m.radialCentre!==undefined?{radialCentre:m.radialCentre}:{}),
    transfers:m.transfers,
    ...(m.key!==undefined?{key:m.key}:{}),
    // The same faces answer the same source (points and edges carry theirs
    // through the links).
    ...(m.stated?.source!==undefined?{source:{faces:m.stated.source}}:{}),
    ...more,
  };
}
/** A result with every row of `m`: its links carry, as a write's do. */
const sameRows=(m:Material,out:Material):Material=>carryLinks(m,out);
function refuseNoFaces(m:Material,who:string):void {
  if(!hasFaces(m))throw new Error(`${who}: this value has no faces — ${who} works on a geometry with faces (plane, box, sphere, a mesh); a value of points or curves has none`);
}

/** A derivation's answer as the one geometry, its rows linked to its inputs. */
function derivedValue(operation:string,m:Material,made:Made3,inputs:readonly Material[],more:Partial<MadeCarry3>={}):Material {
  // A derivation drops a recorded radial centre unless it says it keeps one.
  return made3(made,{...kept(m,{radialCentre:undefined,...more}),inputs,source:sourceOfMade3(operation,made,inputs)});
}
/** The columns a kernel reads (no references or placements, which `made3`
 * carries). */
const kernelColumns=(cols:Columns3):Columns3=>Object.fromEntries(Object.entries(cols).filter(([,c])=>kernelColumn(c)));
/** `mesh` answered as it is: a derivation that changed nothing still makes
 * a value whose rows are its input's. */
function unchanged(mesh:Mesh3):Made3 {
  const cols=mesh.cols;
  return {
    x:mesh.x,y:mesh.y,z:mesh.z,names:mesh.names,loops:mesh.loops,
    triangles:mesh.loops.map((_,f)=>mesh.localTriangles(f)),edges:mesh.edges,
    cols:{points:kernelColumns(cols.points),edges:kernelColumns(cols.edges),faces:kernelColumns(cols.faces),corners:kernelColumns(cols.corners)},
  };
}

// ─── pivots and placements ───────────────────────────────────────────

/** A pivot in 3D: a point, `'center'` for the middle of the value's own
 * bounds, or `'centroid'` for its area centroid (the mean of its points
 * when it has no triangles). */
export type Origin3='center'|'centroid'|Vec3;
export interface RotateOptions3 {
  /** Pivot (see `Origin3`; a pair `[x, y]` is the place at z = 0); the
   * object's own origin when unset. */
  readonly origin?:Origin3;
  /** Read the axis in the object's current frame instead of world axes. */
  readonly local?:boolean;
}
export interface ScaleOptions3 {readonly origin?:Origin3}

/** Three finite numbers. */
const finiteTriple=(v:unknown):v is Vec3=>Array.isArray(v)&&v.length===3&&v.every(Number.isFinite);
/** The pivot a word turns or scales about; undefined for a pivot that is
 * no place (not finite): the word then moves nothing, as `move` does. */
function pivotOf(verb:string,options:RotateOptions3|ScaleOptions3|undefined,m:Material,own:Vec3):Vec3|undefined {
  if(options&&(options as {about?:unknown}).about!==undefined)throw new Error(`${verb}: 'about' is spelled origin — { origin: [x, y, z] | 'center' | 'centroid' }; the object's own origin is the default and the world's is [0, 0, 0]`);
  const o=options?.origin as unknown;
  if(o===undefined)return own;
  // A place of the plane is the place at z = 0, as a 2D point is.
  if(Array.isArray(o)){const q=o.length===2?[o[0],o[1],0]:o;return finiteTriple(q)?q:undefined;}
  if(typeof o==='object'&&o!==null&&typeof (o as {x?:unknown}).x==='number'){const p=o as {x:number;y:number;z?:number},q=[p.x,p.y,p.z??0];return finiteTriple(q)?q:undefined;}
  if(o!=='center'&&o!=='centroid')throw new Error(`${verb}: origin is a point [x, y, z], 'center' or 'centroid' — got ${typeof o==='string'?`'${o}'`:JSON.stringify(o)}`);
  if(m.n===0)return own;
  if(o==='center'){
    const s=m.store,z=s.attrs.z,xs=s.x.flat(),ys=s.y.flat(),zs=z instanceof Column?z.flat():undefined;
    const lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];
    for(let i=0;i<m.n;i++){const p=[xs[i],ys[i],zs===undefined?0:zs[i]];for(let k=0;k<3;k++){lo[k]=Math.min(lo[k],p[k]);hi[k]=Math.max(hi[k],p[k]);}}
    return [(lo[0]+hi[0])/2,(lo[1]+hi[1])/2,(lo[2]+hi[2])/2];
  }
  // Area-weighted triangle centroids: the centroid of the surface itself.
  const mesh=mesh3(m),pts=mesh.positions;
  let area=0;const c=[0,0,0];
  for(let t=0;t<mesh.triangleCount;t++){
    const [a,b,d]=mesh.triangle(t).map(i=>pts[i]);
    const u=sub3(b,a),v=sub3(d,a);
    const n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
    const w=Math.hypot(n[0],n[1],n[2])/2;
    area+=w;for(let k=0;k<3;k++)c[k]+=w*(a[k]+b[k]+d[k])/3;
  }
  if(area>0)return [c[0]/area,c[1]/area,c[2]/area];
  for(const p of pts)for(let k=0;k<3;k++)c[k]+=p[k];
  return [c[0]/pts.length,c[1]/pts.length,c[2]/pts.length];
}
function isRotationInput(value:unknown):value is RotationInput {
  return Array.isArray(value)||(typeof value==='object'&&value!==null&&(value as RotationData).kind==='rotation');
}
/** The object's origin after turning about a pivot: it rides along like every
 * other point, so a later default rotation still turns in place. */
const movedOrigin=(origin:Vec3,pivot:Vec3,move:(v:Vec3)=>Vec3):Vec3=>Object.freeze(add3(pivot,move(sub3(origin,pivot)))) as unknown as Vec3;
/** A rotation's arguments read: the turn, its pivot, and where it leaves the
 * object's origin and orientation; undefined for a turn by an angle, an
 * axis or a pivot that is not finite, which turns nothing. */
function rotationArguments(m:Material,k:Frame3,a:RotationInput|Axis3,b?:number|Vec3|RotateOptions3,c?:RotateOptions3):{rotate:Rotation;origin:Vec3;orientation:Rotation;moved:Vec3}|undefined {
  let rotate:Rotation,options:RotateOptions3={};
  if(typeof b==='number'){
    if(!Number.isFinite(b))return undefined;
    if(Array.isArray(a)&&!a.every(Number.isFinite))return undefined;
    options=c??{};
    const axis:Axis3=options.local?rotateVector3(typeof a==='string'?(a==='x'?[1,0,0]:a==='y'?[0,1,0]:[0,0,1]):vector3(a as Vec3),k.orientation):a as Axis3;
    rotate=axisAngle(axis,b);
  }else{
    if(!isRotationInput(a))throw new Error('rotate takes degrees about z, Euler degrees [x, y, z], a rotation value, or an axis with degrees');
    if(Array.isArray(a)&&!finiteTriple(a))return undefined;
    rotate=rotation3(a);
    options=Array.isArray(b)?{origin:b as Vec3}:(b as RotateOptions3|undefined)??{};
  }
  const origin=pivotOf('rotate',options,m,k.origin);
  if(origin===undefined)return undefined;
  return {rotate,origin,orientation:k.orientation.then(rotate),moved:movedOrigin(k.origin,origin,v=>rotate.apply(v))};
}
/** The frame of a moved value: `k` with these in place, a centre that is
 * no longer known left out. */
function movedFrame(k:Frame3,more:{origin?:Vec3;orientation?:Rotation;radialCentre?:Vec3|undefined}):Frame3 {
  const radialCentre='radialCentre' in more?more.radialCentre:k.radialCentre;
  return Object.freeze({origin:more.origin??k.origin,orientation:more.orientation??k.orientation,...(radialCentre!==undefined?{radialCentre}:{})});
}
/** Settings of one affine motion, in the order `transformPosition3` applies
 * them. */
interface Affine3 {readonly translate:Vec3;readonly rotate:RotationInput;readonly scale:Vec3;readonly origin:Vec3}
const affine=(o:Partial<Affine3>):Affine3=>({translate:o.translate??[0,0,0],rotate:o.rotate??[0,0,0],scale:o.scale??[1,1,1],origin:o.origin??[0,0,0]});
/** An affine motion that turns space over (an odd number of negative factors). */
const mirrors=(scale:Vec3):boolean=>scale.filter(n=>n<0).length%2===1;

// ─── the words a value in the plane shares ───────────────────────────
//
// A motion of space is a map over the x, y and z columns: every row, id,
// column and face is kept, and no working view is read. An argument that
// is not finite moves nothing, as `move` does.

/** `translate([x, y, z])`: every point moved, the object's origin with it. */
export function translate3(m:Material,by:unknown):Material {
  const offset:unknown=Array.isArray(by)?by:[(by as {x:number}).x,(by as {y:number}).y,(by as {z:number}).z];
  if(!finiteTriple(offset))return m;
  const k=frameOf(m),settings=affine({translate:offset});
  return mapPositions3(m,p=>transformPosition3(p,settings),'translate',{frame:movedFrame(k,{origin:add3(k.origin,offset),radialCentre:k.radialCentre&&transformPosition3(k.radialCentre,settings)})});
}
/** `rotate(angles | rotation, pivot?)` or `rotate(axis, degrees, { origin, local })`. */
export function rotate3(m:Material,a:unknown,b?:unknown,c?:unknown):Material {
  const k=frameOf(m),r=rotationArguments(m,k,a as RotationInput|Axis3,b as number|Vec3|RotateOptions3|undefined,c as RotateOptions3|undefined);
  if(r===undefined)return m;
  const settings=affine({rotate:r.rotate,origin:r.origin});
  return mapPositions3(m,p=>transformPosition3(p,settings),'rotate',{frame:movedFrame(k,{orientation:r.orientation,origin:r.moved,radialCentre:k.radialCentre&&transformPosition3(k.radialCentre,settings)})});
}
/** `scale(k | [x, y, z], pivot?)`. A zero factor is allowed: a value
 * scaled to nothing keeps its points on the pivot and has no faces or
 * edges left to draw. */
export function scale3(m:Material,by:unknown,b?:unknown):Material {
  const factors=(typeof by==='number'?[by,by,by]:by) as Vec3;
  if(!finiteTriple(factors))return m;
  const k=frameOf(m);
  const origin=pivotOf('scale',Array.isArray(b)?{origin:b as unknown as Vec3}:b as ScaleOptions3|undefined,m,k.origin);
  if(origin===undefined)return m;
  const moved=movedOrigin(k.origin,origin,v=>[v[0]*factors[0],v[1]*factors[1],v[2]*factors[2]]);
  if(factors.some(f=>f===0)){
    // Points alone collapse onto the pivot; anything with edges or faces
    // is nothing to draw.
    if(m.edgeCount===0&&!hasFaces(m))return mapPositions3(m,p=>add3(origin,sub3(p,origin).map((v,i)=>v*factors[i]) as unknown as Vec3),'scale',{frame:movedFrame(k,{origin:moved,radialCentre:undefined})});
    return made3(NO_ROWS3,kept(m,{origin:moved,radialCentre:undefined}));
  }
  const settings=affine({scale:factors,origin});
  return mapPositions3(m,p=>transformPosition3(p,settings),'scale',{mirror:mirrors(factors),frame:movedFrame(k,{origin:moved,radialCentre:k.radialCentre&&transformPosition3(k.radialCentre,settings)})});
}
/** `transform(placement)` with a placement of space (`observer`, a
 * honeycomb's placements): every point through it, every row and column
 * kept. A Lorentz isometry moves the Klein ball projectively, so a flat
 * face stays flat; one that turns space over turns every face over. */
export function transform3(m:Material,placement:Isometry<Vec3>):Material {
  if(!isSpacePlacement(placement))throw new Error('transform takes a placement of 3D space — an observer, or one of a honeycomb\'s placements; a placement of the plane moves sketch points');
  const k=frameOf(m);
  return mapPositions3(m,p=>placement.point(p),'transform',{mirror:placement.orientation<0,frame:movedFrame(k,{origin:placement.point(k.origin),radialCentre:undefined})});
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
  if(!inSpace3(m))throw new Error('extrude: faces extrude in space — a value with z; in the plane, extrude(point, offset) adds a point and its edge');
  const opts=(options??{}) as ExtrudeOptions;
  if(typeof opts!=='object'||Array.isArray(opts))throw new Error('extrude options must be an object');
  // A selection from an earlier state is read on this one; faces that are
  // gone are skipped.
  const sel=selectionIn(faces,m);
  let off=offset as ExtrudeOffset;
  if(typeof off==='number')off={distance:off};
  if(off===undefined||off===null||typeof off!=='function'&&!Array.isArray(off)&&(typeof off!=='object'||!('distance'in off)))throw new Error('extrude offset must be a distance, a vector, a region callback or { distance }');
  const key=opts.key??'extrude';if(typeof key!=='string'||!key)throw new Error('extrude key must be a nonempty string');
  const mesh=mesh3(m);
  const components=sel.components().map((component,index)=>{
    const measure=regionDirection3(mesh,component.indices);
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
    if(!Array.isArray(vector)||vector.length!==3)throw new Error(`extrude: the offset of region ${index} is ${describe3(vector)} — a 3-vector [x, y, z]`);
    // An offset that is not finite is no offset: that region stays where it
    // is, as one whose distance the field could not answer does.
    return {index,faces:component.indices,vector:(finiteTriple(vector)?[vector[0],vector[1],vector[2]]:[0,0,0]) as Vec3};
  });
  return derivedValue('extrude',m,extrudeRegion3(mesh,components,key)??unchanged(mesh),[m]);
}

/** `smooth(name, { steps })` of a face or a corner column (`domain`, as the
 * core found it): each row the mean of itself and its neighbours, `steps`
 * times — faces over shared edges, corners over the corners of their point
 * and face. Numbers and numeric vectors only. */
export function smooth3(m:Material,domain:'faces'|'corners',name:string,options:{readonly steps?:number}={}):Material {
  const steps=options.steps??1;if(!Number.isSafeInteger(steps)||steps<0)throw new Error('smooth steps must be a nonnegative integer');
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
  const mesh=mesh3(m);
  return derivedValue('subdivide',m,subdivideMesh3(mesh,levels,options,m.transfers,{})??unchanged(mesh),[m]);
}
/** The booleans: both values closed solids; the seam is exact, and the
 * faces along it answer `cut`. An uncut face of the first keeps its row
 * identity and columns; a face of the other keeps its columns. */
export function boolean3(operation:BooleanOperation3):(m:Material,other:Material)=>Material {
  return (m,other)=>{
    if(typeof other!=='object'||other===null||!('cache' in other))throw new Error(`${operation}: the second value is not a mesh — a geometry with faces`);
    refuseNoFaces(m,operation);refuseNoFaces(other,operation);
    const made=booleanMesh3(operation,mesh3(m),mesh3(other));
    // An edge column keeps the policy of the solid whose edges it came
    // from: the first's, where both hold it.
    const edgeTransfers=Object.fromEntries(Object.keys(made.cols?.edges??{}).flatMap(name=>{const t=(name in m.store.edgeAttrs?m:other).edgeTransfers[name];return t===undefined?[]:[[name,t]];}));
    return derivedValue(operation,m,made,[m,other],{transfers:{},edgeTransfers});
  };
}
/** `dual(options?)`: one point per face at its middle, one face per vertex
 * walking the faces around it. Numeric face columns become point columns
 * and point columns face columns; a rim vertex has no ring and no face. */
export function dual3(m:Material,options:DualOptions={}):Material {
  if(!options||typeof options!=='object'||Array.isArray(options))throw new Error('dual options must be an object');
  refuseNoFaces(m,'dual');
  // The dual of a shell star-shaped about a point is star-shaped about it.
  return derivedValue('dual',m,dualMesh3(mesh3(m),options),[m],{transfers:{},radialCentre:m.radialCentre});
}

export interface DisplaceOptions {
  /** Direction of a scalar displacement: the vertex normal (default), an axis, or a fixed vector. */
  readonly along?:'normal'|'x'|'y'|'z'|Vec3;
}
/** Angle-weighted vertex normals over the fixed triangles; a point with no
 * faces has no normal. */
function vertexNormals(mesh:Mesh3):(Vec3|null)[] {
  const pts=mesh.positions,sums=pts.map(()=>[0,0,0] as number[]);
  for(let t=0;t<mesh.triangleCount;t++){
    const vertices=mesh.triangle(t),p=vertices.map(v=>pts[v]),n=cross3(sub3(p[1],p[0]),sub3(p[2],p[0]));
    for(let k=0;k<3;k++){const a=sub3(p[(k+1)%3],p[k]),b=sub3(p[(k+2)%3],p[k]),la=Math.hypot(...a),lb=Math.hypot(...b);
      const angle=la&&lb?Math.acos(Math.max(-1,Math.min(1,dot3(a,b)/(la*lb)))):0;const s=sums[vertices[k]];s[0]+=n[0]*angle;s[1]+=n[1]*angle;s[2]+=n[2]*angle;}
  }
  return sums.map(s=>{const l=Math.hypot(s[0],s[1],s[2]);return l>0?[s[0]/l,s[1]/l,s[2]/l] as Vec3:null;});
}
/** `displace(field, options?)`: every point moved by a vector, or by a
 * number along its vertex normal (`along` chooses another direction). A
 * point the field cannot answer, or with no normal to follow, stays. */
export function displace3(m:Material,field:Field<unknown,Vec3|number>,options:DisplaceOptions={}):Material {
  const along=options.along??'normal';
  const axis:Vec3|undefined=along==='x'?[1,0,0]:along==='y'?[0,1,0]:along==='z'?[0,0,1]:along==='normal'?undefined:along;
  if(axis)finite3(axis,'displace along');
  let normals:(Vec3|null)[]|undefined;
  const rows=[...(m as unknown as {points:Iterable<unknown>}).points];
  const deltas=rows.map((row,i):Vec3=>{
    const value=evaluate(field,row) as unknown;
    if(typeof value==='number'){
      const amount=sampleValue(value,0),direction=axis??(normals??=vertexNormals(mesh3(m)))[i];
      return direction?mul3(direction,amount):[0,0,0];
    }
    if(!Array.isArray(value)||value.length!==3||!value.every(v=>typeof v==='number'))throw new Error(`displace: the field answered ${describe3(value)} — a number, or a vector [x, y, z]`);
    return finiteTriple(value)?value:[0,0,0];
  });
  // Moved points keep a star-shaped solid's recorded centre: nothing trusts
  // it, every certificate re-proves it.
  return mapPositions3(m,(p,i)=>add3(p,deltas[i]),'displace');
}

// ─── curves in space ─────────────────────────────────────────────────

/** `along({ count } | { spacing })` of a value in space: points by arc
 * length on its one unbranched curve, each with `s`, `u` and the unit
 * `tangent`, the curve's point columns carried, and `source` the edge
 * under it. A branched curve is refused by name. */
export function along3(m:Material,opts:{readonly count?:number;readonly spacing?:number}={}):Material {
  return derivedValue('along',m,alongSurface(mesh3(m),opts),[m],{origin:ORIGIN,orientation:IDENTITY,radialCentre:undefined});
}
/** `resample({ count } | { spacing })` of a value in space: the same path
 * with its points redistributed by arc length; each point's `source` is
 * the edge under it. */
export function resample3(m:Material,opts:{readonly count?:number;readonly spacing?:number}={}):Material {
  return derivedValue('resample',m,resampledSurface(mesh3(m),opts),[m]);
}

// ─── row words ───────────────────────────────────────────────────────

/** A face of a value in space, measured on its fixed triangles: its unit
 * normal, its area and its area centroid. */
export function faceWords3(m:Material,f:number):{readonly normal:Vec3;readonly area:number;readonly centroid:Vec3} {
  // The statement's loop and fixed triangles, read on the x, y and z
  // columns: no working view. The sums run in the order the view's
  // `faceGeometry3` takes them, so the answers are its answers.
  const stated=m.stated,runs=stated?.cycles[f],loop=runs===undefined||runs.length===0?[]:runs[0];
  const s=m.store,z=s.attrs.z;
  const at=(v:number):Vec3=>[s.x.get(v),s.y.get(v),z instanceof Column?z.get(v):0];
  const places=loop.map(at),held=stated?.triangles?.[f];
  const local:number[]=held!==undefined?[...held]:triangulate(places,places.map((_,k)=>k)).flat();
  let normal:Vec3=[0,0,0],center:Vec3=[0,0,0],area=0;
  for(let k=0;k+2<local.length;k+=3){
    const a=places[local[k]],b=places[local[k+1]],c=places[local[k+2]],n=cross3(sub3(b,a),sub3(c,a)),w=Math.hypot(...n)/2;
    normal=add3(normal,n);area+=w;center=add3(center,mul3(add3(add3(a,b),c),w/3));
  }
  // A face with no represented triangles (a degenerate polygon) has no
  // normal, and the mean of its own points for a centroid.
  const length=Math.hypot(...normal);
  return {
    normal:Object.freeze(length>0&&Number.isFinite(length)?unit3(normal):[0,0,0]) as Vec3,
    area,
    centroid:Object.freeze(area>0?mul3(center,1/area):places.length?mul3(places.reduce((sum,p)=>add3(sum,p),[0,0,0] as Vec3),1/places.length):[0,0,0]) as Vec3,
  };
}

/** `rebind(target)`: points sampled on a surface back on the same places of
 * an edited revision of it; points sampled on surface curves back on the
 * same places of curves rebuilt from the same construction. */
export function rebind3(m:Material,target:unknown):Material {
  if(samplesOf(m)!==undefined)return rebindSamples(m,target as Material);
  if(curveSamplesOf(m)!==undefined)return rebindCurveSamples(m,target as never);
  throw new Error('rebind: this value carries no samples — t.scatter on a geometry with faces, or t.sample on surface curves, makes points that rebind');
}

// The words a value in space answers, typed for a sketch: the core declares
// each as a method that calls the one here; these are its 3D signatures.
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

