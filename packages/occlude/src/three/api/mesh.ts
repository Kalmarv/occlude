/**
 * The 3D factories: a plane, a box, a formula surface, an imported mesh,
 * points in space. Each answers the one geometry — a `Material` with a `z`
 * column, stated polygon faces and their corners where it has them — and
 * the 3D words on it (`subdivide`, `extrude` of faces, the booleans, `dual`,
 * `displace`, 3D `translate`/`rotate`/`scale`) are its own methods
 * (words.ts). An empty domain is empty: points have no edges, a curve has
 * no faces, and a word that needs faces refuses a value with none by name.
 *
 * A factory builds its answer as columns (`Made3`: `polygons3`,
 * `facesMade3`, `pointsMade3`, `curveMade3`, `charted3`) and makes the
 * value through `geometry3`, which checks the options and the columns
 * and links each row to what it came from.
 */

import {chartColumns3,type SurfaceUV} from '../geometry/coordinates.js';
import {columnsOfRecords3,type Attribute3} from '../geometry/model.js';
import {triangulate,DOMAINS3,made3,faceEdges3,cornerNames3,checkMade3,sourceOfMade3,kernelColumn,type Made3,type MadeCarry3,type Columns3,type Lineage3} from '../geometry/mesh3.js';
import {finite3,add3,mul3,sub3,type Vec3} from '../math.js';
import {emptyCount,emptySize} from '../degenerate.js';
import {attributeValue} from './columns.js';
import {refuseStroke,refuseDisplay} from './recipes.js';
import {points2} from './lift.js';
import {kindOf,type AnyColumn} from '../../column.js';
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
/** @internal What a factory hands its door (`geometry3`) besides the
 * rows. */
export interface Geometry3Options extends GeometryOptions {
  readonly radialCentre?:Vec3;
  readonly origin?:Vec3;
  readonly orientation?:Rotation;
  /** The policies of the columns, said outright (a realized prototype's). */
  readonly policies?:MadeCarry3['policies'];
  readonly derived?:Derived3;
  /** The value the surface was made from: a row it kept keeps its id. */
  readonly from?:Material;
  /** Point columns a kernel never sees (a sample's placement). */
  readonly pointCols?:Columns3;
  /** Where the rows came from, said outright (the core's `source`). */
  readonly source?:MadeCarry3['source'];
  /** The prototype the points place (instances.ts). */
  readonly prototype?:Material;
}
function checkOptions(options:GeometryOptions&{readonly prototype?:unknown}):void{if(!options||typeof options!=='object'||Array.isArray(options))throw new Error('geometry options must be an object; plane subdivisions use .subdivide(levels)');refuseStroke(options,'geometry options');refuseDisplay(options,'geometry options');}
function checkedKey(key?:string):string|undefined {if(key!==undefined&&(typeof key!=='string'||!key))throw new Error('geometry key must be a nonempty string');return key;}
/** The value a derivation read, as a geometry: a selection is read on the
 * geometry it selects from. */
const inputOf=(v:object):Material|undefined=>v instanceof Selection?(v.owner as Material):v instanceof Material?v:undefined;

// ─── the door: a kernel's columns as a value in space ────────────────────

/** The numbers a kernel's columns hold are ones a geometry column may hold:
 * finite, alone or in a vector (`attributeValue`'s rule, a column at a
 * time); strings and booleans always are. */
function checkColumns(made:Made3):void {
  for(const d of DOMAINS3){
    const cols=made.cols?.[d];if(cols===undefined)continue;
    for(const name in cols){
      const column=cols[name],kind=kindOf(column).name;
      if(kind!=='number'&&kind!=='vector')continue;
      const flat=column.flat() as Float64Array;
      for(let i=0;i<flat.length;i++)if(!Number.isFinite(flat[i]))attributeValue(flat[i]);
    }
  }
}
/** @internal A kernel's answer as a value in space: the options checked,
 * the columns checked, and each row's `source` from the derivation's
 * lineage (`derived`) or said outright (`source`). */
export function geometry3(made:Made3,options:Geometry3Options={}):Material {
  checkOptions(options);checkColumns(made);
  const key=checkedKey(options.key);
  const inputs=options.derived?.inputs.map(inputOf).filter((m):m is Material=>m!==undefined);
  return made3(made,{
    ...(key!==undefined?{key}:{}),
    ...(options.origin!==undefined?{origin:options.origin}:{}),
    ...(options.orientation!==undefined?{orientation:options.orientation}:{}),
    ...(options.radialCentre!==undefined?{radialCentre:options.radialCentre}:{}),
    ...(options.policies!==undefined?{policies:options.policies}:{}),
    ...(options.from!==undefined?{from:options.from}:{}),
    ...(options.pointCols!==undefined?{pointCols:options.pointCols}:{}),
    ...(options.prototype!==undefined?{prototype:options.prototype}:{}),
    ...(options.source!==undefined?{source:options.source}:options.derived&&inputs&&inputs.length?{source:sourceOfMade3(options.derived.operation,made,inputs)}:{}),
  });
}

// ─── building an answer ──────────────────────────────────────────────────

const NO_ROWS:readonly string[]=Object.freeze([]);
/** Where each point of a triangle is round its face's loop. */
function localOf(loop:readonly number[],triangles:readonly (readonly number[])[]):number[] {
  const out:number[]=[];
  if(loop.length<=16){for(const t of triangles)for(let k=0;k<3;k++)out.push(loop.indexOf(t[k]));return out;}
  const at=new Map<number,number>();loop.forEach((v,k)=>{if(!at.has(v))at.set(v,k);});
  for(const t of triangles)for(let k=0;k<3;k++)out.push(at.get(t[k])!);
  return out;
}
/** @internal Each loop checked and ear clipped from the positions, as a new
 * surface's faces always were: its triangles as positions round the loop. */
export function earClip3(positions:readonly Vec3[],loops:readonly (readonly number[])[]):number[][] {
  return loops.map(loop=>{
    if(loop.length<3||new Set(loop).size!==loop.length||loop.some(v=>!Number.isInteger(v)||v<0||v>=positions.length))throw new Error('surface face requires at least three distinct valid point indices');
    return localOf(loop,triangulate(positions,loop));
  });
}
/** @internal Points in space: positions, their names and columns, and
 * what each came from. No edges, no faces. */
export function pointsMade3(positions:readonly Vec3[],names:readonly string[],cols:Columns3={},lineage?:Lineage3['points']):Made3 {
  return {
    x:Float64Array.from(positions,p=>p[0]),y:Float64Array.from(positions,p=>p[1]),z:Float64Array.from(positions,p=>p[2]),
    names:{points:names,edges:NO_ROWS,faces:NO_ROWS,corners:NO_ROWS},
    loops:[],triangles:[],edges:new Uint32Array(0),cols:{points:cols},
    ...(lineage!==undefined?{lineage:{points:lineage}}:{}),
  };
}
/** @internal Faces in space as a kernel's answer: the edges derived from the
 * loops and the corners named as a surface always named them, checked as a
 * surface was. `triangles` are each face's, as positions round its loop. */
export function facesMade3(positions:readonly Vec3[],names:readonly string[],loops:readonly (readonly number[])[],faceNames:readonly string[],triangles:readonly (readonly number[])[],cols:Partial<Record<'points'|'faces'|'corners',Columns3>>={},lineage?:Lineage3):Made3 {
  const edges=faceEdges3(loops,names);
  const made:Made3={
    ...pointsMade3(positions,names),
    names:{points:names,edges:edges.names,faces:faceNames,corners:cornerNames3(loops,faceNames,names)},
    loops,triangles,edges:edges.edges,
    cols,
    ...(lineage!==undefined?{lineage}:{}),
  };
  checkMade3(made);
  return made;
}
/** @internal Positions and polygons as a kernel's answer, as a new surface
 * always was: point `p${i}`, face `f${i}`, each face ear clipped. */
export function polygons3(positions:readonly Vec3[],polygons:readonly (readonly number[])[]):Made3 {
  positions.forEach(p=>finite3(p,'mesh'));
  return facesMade3(positions,positions.map((_,i)=>`p${i}`),polygons,polygons.map((_,i)=>`f${i}`),earClip3(positions,polygons));
}
/** @internal `made` with the chart columns `field` gives its loops (see
 * `chartColumns3`): a column it already holds under one of those names is
 * replaced where it stands. */
export function charted3(made:Made3,field:(face:number,corner:number,vertex:number)=>SurfaceUV):Made3 {
  const chart=chartColumns3(made.loops,field);
  return {...made,cols:{...made.cols,faces:{...made.cols?.faces,...chart.faces},corners:{...made.cols?.corners,...chart.corners}}};
}
/** @internal Points joined by edges, as a curve in space: only the points
 * an edge uses, in row order, and each edge as given, its points in its own
 * order. `pointCols` answers the columns of the points kept. */
export function curveMade3(positions:readonly Vec3[],names:readonly string[],edges:readonly (readonly [number,number])[],edgeNames:readonly string[],pointCols:(kept:readonly number[])=>Columns3=()=>({}),edgeCols:Columns3={}):Made3 {
  const kept=[...new Set(edges.flatMap(e=>e))].sort((a,b)=>a-b),row=new Map(kept.map((v,i)=>[v,i])),cols=pointCols(kept),pointNames=kept.map(i=>names[i]);
  const pairs=new Uint32Array(2*edges.length);
  edges.forEach((e,i)=>{pairs[2*i]=row.get(e[0])!;pairs[2*i+1]=row.get(e[1])!;});
  return {...pointsMade3(kept.map(i=>positions[i]),pointNames,cols),names:{points:pointNames,edges:edgeNames,faces:NO_ROWS,corners:NO_ROWS},edges:pairs,cols:{points:cols,edges:edgeCols}};
}
/** @internal A column's rows in a new order; a row of -1 takes the kind's
 * default (a row the source had nothing for). */
export function rowsOfColumn3(column:AnyColumn,rows:ArrayLike<number>):AnyColumn {
  let whole=true;for(let i=0;i<rows.length;i++)if(rows[i]<0){whole=false;break;}
  if(whole)return column.keep(rows);
  const kind=kindOf(column) as {readonly default:unknown;from(values:ArrayLike<unknown>):AnyColumn};
  return kind.from(Array.from(rows,r=>r<0?kind.default:(column as {get(i:number):unknown}).get(r)));
}
/** @internal The columns a kernel reads of one domain (numbers, booleans,
 * strings, vectors), their rows in a new order (see `rowsOfColumn3`). */
export function kernelRows3(cols:Columns3,rows:ArrayLike<number>):Record<string,AnyColumn> {
  const out:Record<string,AnyColumn>={};
  for(const name in cols)if(kernelColumn(cols[name]))out[name]=rowsOfColumn3(cols[name],rows);
  return out;
}

/** A geometry with faces from positions and polygon index lists: each face
 * a loop of three or more point indices, wound counter-clockwise seen from
 * the side it faces. */
export function mesh(positions:readonly Vec3[],faces:readonly (readonly number[])[],options:GeometryOptions={}):Material{
  if(!Array.isArray(positions)||!Array.isArray(faces))throw new Error('mesh takes positions [x, y, z] and polygon index arrays — mesh(positions, faces)');
  return geometry3(polygons3(positions,faces),options);
}
/** One quad with a stored unit-square XY chart. Subdivision preserves this chart. */
export function plane(width=1,height=width,options:GeometryOptions={}):Material{
  if(emptySize(width,height))return emptyMesh(options);
  const source=polygons3([[-width/2,-height/2,0],[width/2,-height/2,0],[width/2,height/2,0],[-width/2,height/2,0]],[[0,1,2,3]]);
  const uv:readonly (readonly [number,number])[]=[[0,0],[1,0],[1,1],[0,1]];
  return geometry3(charted3(source,(_,c)=>({uv:uv[c],chart:'plane'})),options);
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
  return geometry3(charted3(polygons3(positions,faces),(f,c)=>({uv:charts[f][c],chart:'parametric'})),options);
}
/** The unit box's corners, and its faces wound outward. */
const BOX_CORNERS:readonly Vec3[]=[[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]];
const BOX_FACES:readonly (readonly number[])[]=[[3,2,1,0],[4,5,6,7],[0,1,5,4],[1,2,6,5],[2,3,7,6],[3,0,4,7]];
/** Each outward-wound face has its own unit-square chart; vertices stay shared. */
export function box(size:number|Vec3=1,options:GeometryOptions={}):Material{
  const extent:Vec3=typeof size==='number'?[size,size,size]:size,uv:readonly (readonly [number,number])[]=[[0,0],[1,0],[1,1],[0,1]];
  finite3(extent,'box size');
  // A box with no extent on some axis is nothing to draw, not a fault: the
  // sketch keeps rendering and this box contributes no faces.
  const source=extent.some(v=>v<=0)?polygons3([],[]):polygons3(BOX_CORNERS.map(p=>p.map((v,i)=>v*extent[i]/2) as unknown as Vec3),BOX_FACES);
  return geometry3(charted3(source,(f,c)=>({uv:uv[c],chart:source.names.faces[f]})),options);
}
/** Nothing to draw, as a value. A degenerate construction returns one of these
 * rather than failing, and it flows through view, hatch, sampling and the plan
 * like any other geometry. */
export function emptyMesh(options:GeometryOptions={}):Material{return geometry3(polygons3([],[]),options);}
/** Points from positions, or 2D points (a point collection or selection, a
 * material, `[x, y]` pairs) at z = 0 with their columns kept; each lifted
 * point's `source` is the 2D row it stands for. */
export function pointCloud(positions:readonly Vec3[]|Iterable<unknown>|{readonly points:unknown},options:GeometryOptions={}):Material{
  const lifted=points2(positions,'pointCloud');
  if(lifted){
    const at=lifted.map(p=>[p.x,p.y,0] as Vec3);at.forEach(p=>finite3(p,'mesh'));
    return geometry3(pointsMade3(at,lifted.map(p=>p.id),columnsOfRecords3(lifted.map(p=>p.attributes))),{...options,...(Array.isArray(positions)?{}:{derived:derived('lift',positions as object)})});
  }
  if(!Array.isArray(positions))throw new Error('pointCloud takes [x, y, z] positions or 2D points');
  return geometry3(polygons3(positions as readonly Vec3[],[]),options);
}
