/**
 * The 3D factories: a plane, a box, a formula surface, an imported mesh,
 * points in space. Each answers the one geometry — a `Material` with a `z`
 * column, stated polygon faces and their corners where it has them — and
 * the 3D words on it (`subdivide`, `extrude` of faces, the booleans, `dual`,
 * `displace`, 3D `translate`/`rotate`/`scale`) are its own methods
 * (words.ts). An empty domain is empty: points have no edges, a curve has
 * no faces, and a word that needs faces refuses a value with none by name.
 */

import {chartSurface3} from '../geometry/coordinates.js';
import {surface3,box3,assembleSurface3,type Surface3,type Attributes3,type Attribute3} from '../geometry/surface.js';
import {ownSurface3} from '../geometry/model.js';
import {add3,mul3,sub3,type Vec3} from '../math.js';
import {emptyCount,emptySize} from '../degenerate.js';
import {attributeValue} from './columns.js';
import {refuseStroke,refuseDisplay} from './recipes.js';
import {points2} from './lift.js';
import {value3,type Carry3} from '../geometry/value.js';
import {sourceOf3,type Input3} from './words.js';
import {Material} from '../../material.js';
import {Selection} from '../../selection.js';
import type {Rotation} from '../rotation.js';
import './words.js';

export type {DisplaceOptions,RotateOptions3 as RotateOptions,ScaleOptions3 as ScaleOptions,Origin3,ExtrudeRegion,ExtrudeOffset,ExtrudeOptions} from './words.js';
/** The columns of an edge, by name. */
export type EdgeAttributes = Record<string,Attribute3|undefined>;

export interface GeometryOptions {
  /** The name a scatter on this value draws its stream under, and the
   * value's identity in a view. */
  readonly key?:string;
}
/** @internal The inputs of the derivation that made a value: its name and
 * the values it read, which its rows' `source` answers rows of. */
export interface Derived3 {readonly operation:string;readonly inputs:readonly object[]}
export const derived=(operation:string,...inputs:object[]):Derived3=>Object.freeze({operation,inputs:Object.freeze(inputs)});
/** @internal What a factory hands `geometry3` besides the surface. */
export interface Geometry3Options extends GeometryOptions {
  readonly radialCentre?:Vec3;
  readonly origin?:Vec3;
  readonly orientation?:Rotation;
  readonly transfers?:Carry3['transfers'];
  readonly derived?:Derived3;
  /** The value the surface was made from: a row it kept keeps its id. */
  readonly from?:Material;
  /** Point columns a kernel never sees (a sample's placement). */
  readonly pointCols?:Carry3['pointCols'];
  /** Where the rows came from, said outright (the core's `source`). */
  readonly source?:Carry3['source'];
  /** The prototype the points place (instances.ts). */
  readonly prototype?:Material;
}
function checkOptions(options:GeometryOptions&{readonly prototype?:unknown}):void{if(!options||typeof options!=='object'||Array.isArray(options))throw new Error('geometry options must be an object; plane subdivisions use .subdivide(levels)');refuseStroke(options,'geometry options');refuseDisplay(options,'geometry options');}
function checkedKey(key?:string):string|undefined {if(key!==undefined&&(typeof key!=='string'||!key))throw new Error('geometry key must be a nonempty string');return key;}
/** The values a kernel's surface carries are ones a geometry column may
 * hold; the names are the core's to judge, domain by domain. */
function validateAttributes(surface:Surface3):void {
  for(const rows of [surface.points,surface.edges,surface.faces,surface.faces.flatMap(f=>f.corners??[])])for(const row of rows){
    for(const value of Object.values(row.attributes))if(value!==undefined)attributeValue(value);
  }
}
/** The value a derivation read, as a geometry: a selection is read on the
 * geometry it selects from. */
const inputOf=(v:object):Input3|undefined=>v instanceof Selection?(v.source as Material):v instanceof Material?v:undefined;

/** @internal A kernel's surface as a value in space. */
export function geometry3(surface:Surface3,options:Geometry3Options={}):Material {
  checkOptions(options);validateAttributes(surface);
  const key=checkedKey(options.key);
  const inputs=options.derived?.inputs.map(inputOf).filter((m):m is Input3=>m!==undefined);
  return value3(surface,{
    ...(key!==undefined?{key}:{}),
    ...(options.origin!==undefined?{origin:options.origin}:{}),
    ...(options.orientation!==undefined?{orientation:options.orientation}:{}),
    ...(options.radialCentre!==undefined?{radialCentre:options.radialCentre}:{}),
    ...(options.transfers!==undefined?{transfers:options.transfers}:{}),
    ...(options.from!==undefined?{from:options.from}:{}),
    ...(options.pointCols!==undefined?{pointCols:options.pointCols}:{}),
    ...(options.prototype!==undefined?{prototype:options.prototype}:{}),
    ...(options.source!==undefined?{source:options.source}:options.derived&&inputs&&inputs.length?{source:sourceOf3(options.derived.operation,surface,inputs)}:{}),
  });
}
/** @internal The edges `indices` of a surface, with the points they join,
 * as a curve in space: no faces. */
export function curveGeometry3(surface:Surface3,indices:readonly number[],options:Geometry3Options={}):Material {
  if(indices.some(i=>!Number.isSafeInteger(i)||!surface.edges[i]))throw new Error('invalid curve edge index');
  const selected=[...new Set(indices)],used=[...new Set(selected.flatMap(i=>surface.edges[i].vertices))].sort((a,b)=>a-b);
  const mapping=new Map(used.map((v,i)=>[v,i]));
  const source:Surface3={points:used.map(i=>surface.points[i]),faces:[],triangles:[],edges:selected.map(i=>({...surface.edges[i],vertices:surface.edges[i].vertices.map(v=>mapping.get(v)!) as [number,number],faces:[]}))};
  return geometry3(source,options);
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
/** A geometry with faces from positions and polygon index lists, or from a
 * `Surface3` of the explicit stage (its ids, columns and fixed triangles
 * kept). */
export function mesh(source:Surface3,options?:GeometryOptions):Material;
export function mesh(positions:readonly Vec3[],faces:readonly (readonly number[])[],options?:GeometryOptions):Material;
export function mesh(source:Surface3|readonly Vec3[],facesOrOptions:readonly (readonly number[])[]|GeometryOptions={},options:GeometryOptions={}):Material{
  if(Array.isArray(source)){
    if(!Array.isArray(facesOrOptions))throw new Error('mesh positions require polygon index arrays');
    return geometry3(ownSurface3(surface3(source,facesOrOptions)),options);
  }
  validateImportedSurface(source as Surface3);
  // An advanced input may be written after this: its rows are read now.
  const s=source as Surface3;
  return geometry3(assembleSurface3(s.points,s.faces,s.triangles,s),facesOrOptions as GeometryOptions);
}
/** One quad with a stored unit-square XY chart. Subdivision preserves this chart. */
export function plane(width=1,height=width,options:GeometryOptions={}):Material{
  if(emptySize(width,height))return emptyMesh(options);
  const source=surface3([[-width/2,-height/2,0],[width/2,-height/2,0],[width/2,height/2,0],[-width/2,height/2,0]],[[0,1,2,3]]);
  const uv:readonly (readonly [number,number])[]=[[0,0],[1,0],[1,1],[0,1]];
  return geometry3(ownSurface3(chartSurface3(source,(_,c)=>({uv:uv[c],chart:'plane'}))),options);
}
export interface ParametricOptions extends GeometryOptions {
  /** Samples across u and down v. A closed direction needs at least three. */
  readonly cols:number;readonly rows:number;
  /** Weld the last ring of samples to the first, so the seam is one set of
   * shared vertices and the surface closes around that direction. */
  readonly closeU?:boolean;readonly closeV?:boolean;
}
/** A formula as a quad grid, carrying the unit square as its chart exactly as
 * `plane` does, so `hatch({uv})`, `isolines` and `mapSurface` read it.
 *
 * `point(u, v)` is read over the unit square: u runs 0..1 across `cols`
 * samples and v runs 0..1 down `rows`. A closed direction spaces its samples
 * at i / count and welds the seam, the way `torus` does, so a formula torus is
 * as manifold as `torus()`. A ring of samples that all land on one place — a
 * pole — becomes one shared vertex, and its quads become triangles.
 *
 * Winding: each quad is wound (u, v), (u+, v), (u+, v+), (u, v+), so the face
 * normal is ∂p/∂u × ∂p/∂v. A formula whose cross product points out of the
 * solid draws as an outward surface; swap u and v to turn it inside out.
 *
 * Too few samples, or a point the formula could not answer, is an empty value. */
export function parametric(point:(u:number,v:number)=>Vec3,options:ParametricOptions):Material{
  checkOptions(options);
  if(typeof point!=='function')throw new Error('parametric requires a point formula (u, v) => [x, y, z]');
  for(const [name,value] of [['closeU',options.closeU],['closeV',options.closeV]] as const)if(value!==undefined&&typeof value!=='boolean')throw new Error(`parametric ${name} must be boolean`);
  const closeU=options.closeU===true,closeV=options.closeV===true;
  const cols=options.cols,rows=options.rows;
  if(emptyCount(cols,closeU?3:2,'parametric cols')||emptyCount(rows,closeV?3:2,'parametric rows'))return emptyMesh(options);
  const uSpan=closeU?cols:cols-1,vSpan=closeV?rows:rows-1;
  if(cols*rows>500000||uSpan*vSpan>250000)throw new Error('parametric exceeds budget (500000 points / 250000 faces)');
  const sampled:Vec3[]=[];
  for(let i=0;i<cols;i++)for(let j=0;j<rows;j++){
    const p=point(i/uSpan,j/vSpan);
    // A formula that cannot answer somewhere draws nothing, the same
    // nothing-to-draw a zero-sized primitive gives.
    if(!Array.isArray(p)||p.length!==3||!p.every(Number.isFinite))return emptyMesh(options);
    sampled.push([p[0],p[1],p[2]]);
  }
  // A ring of coincident samples is one vertex. Union-find, so a pole that is
  // both a degenerate row and a degenerate column still ends up as one.
  const parent=sampled.map((_,k)=>k);
  const find=(k:number):number=>{while(parent[k]!==k){parent[k]=parent[parent[k]];k=parent[k];}return k;};
  const join=(a:number,b:number):void=>{const x=find(a),y=find(b);if(x!==y)parent[Math.max(x,y)]=Math.min(x,y);};
  let extent=0;for(const p of sampled)for(const n of p)extent=Math.max(extent,Math.abs(n));
  const tolerance=Math.max(1,extent)*1e-9;
  const coincident=(indices:readonly number[]):boolean=>indices.every(k=>indices.every(l=>Math.hypot(...sub3(sampled[k],sampled[l]))<=tolerance));
  for(let j=0;j<rows;j++){const ring=Array.from({length:cols},(_,i)=>i*rows+j);if(coincident(ring))for(const k of ring)join(ring[0],k);}
  for(let i=0;i<cols;i++){const ring=Array.from({length:rows},(_,j)=>i*rows+j);if(coincident(ring))for(const k of ring)join(ring[0],k);}
  const index=new Map<number,number>(),positions:Vec3[]=[],members=new Map<number,number[]>();
  for(let k=0;k<sampled.length;k++){
    const root=find(k);let at=index.get(root);
    if(at===undefined){at=positions.length;index.set(root,at);positions.push(sampled[k]);members.set(at,[]);}
    members.get(at)!.push(k);
  }
  // A welded ring takes the middle of its samples, so a pole a formula only
  // reaches to rounding sits exactly where the ring says it does.
  for(const [at,group] of members)if(group.length>1)positions[at]=mul3(group.reduce((sum,k)=>add3(sum,sampled[k]),[0,0,0] as Vec3),1/group.length);
  const at=(i:number,j:number):number=>index.get(find((i%cols)*rows+(j%rows)))!;
  const faces:number[][]=[],charts:(readonly [number,number])[][]=[];
  for(let i=0;i<uSpan;i++)for(let j=0;j<vSpan;j++){
    const corners=[[i,j],[i+1,j],[i+1,j+1],[i,j+1]] as const;
    const kept:number[]=[],uv:(readonly [number,number])[]=[];
    for(const [ci,cj] of corners){
      const vertex=at(ci,cj);
      if(kept.length&&kept.at(-1)===vertex)continue;
      kept.push(vertex);uv.push([ci/uSpan,cj/vSpan]);
    }
    if(kept.length>2&&kept[0]===kept.at(-1)){kept.pop();uv.pop();}
    if(kept.length<3)continue;
    faces.push(kept);charts.push(uv);
  }
  if(!faces.length)return emptyMesh(options);
  return geometry3(ownSurface3(chartSurface3(surface3(positions,faces),(f,c)=>({uv:charts[f][c],chart:'parametric'}))),options);
}
/** Each outward-wound face has its own unit-square chart; vertices stay shared. */
export function box(size:number|Vec3=1,options:GeometryOptions={}):Material{
  const source=box3(typeof size==='number'?[size,size,size]:size),uv:readonly (readonly [number,number])[]=[[0,0],[1,0],[1,1],[0,1]];
  return geometry3(ownSurface3(chartSurface3(source,(f,c)=>({uv:uv[c],chart:source.faces[f].id}))),options);
}
/** Nothing to draw, as a value. A degenerate construction returns one of these
 * rather than failing, and it flows through view, hatch, sampling and the plan
 * like any other geometry. */
export function emptyMesh(options:GeometryOptions={}):Material{return geometry3(ownSurface3(surface3([],[])),options);}
/** Points from positions, or 2D points (a point collection or selection, a
 * material, `[x, y]` pairs) at z = 0 with their columns kept; each lifted
 * point's `source` is the 2D row it stands for. */
export function pointCloud(positions:readonly Vec3[]|Iterable<unknown>|{readonly points:unknown},options:GeometryOptions={}):Material{
  const lifted=points2(positions,'pointCloud');
  if(lifted){
    const base=surface3(lifted.map(p=>[p.x,p.y,0] as Vec3),[]);
    return geometry3(ownSurface3({...base,points:base.points.map((p,i)=>({...p,id:lifted[i].id,attributes:Object.freeze({...lifted[i].attributes})}))}),{...options,...(Array.isArray(positions)?{}:{derived:derived('lift',positions as object)})});
  }
  if(!Array.isArray(positions))throw new Error('pointCloud takes [x, y, z] positions or 2D points');
  return geometry3(ownSurface3(surface3(positions as readonly Vec3[],[])),options);
}
