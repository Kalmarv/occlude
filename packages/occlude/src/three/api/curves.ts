import type {Curve as Curve2} from '../../curves.js';
import {finite3,sub3,type Vec3} from '../math.js';
import {surface3,type Surface3} from '../geometry/surface.js';
import {curveGeometry3,emptyMesh,derived,type GeometryOptions,type Geometry3Options} from './mesh.js';
import {inSpace3} from '../../material.js';
import {emptyCount} from '../degenerate.js';
import {chain2,isChain2,type Lifted2} from './lift.js';
import {Material} from '../../material.js';
export interface PolylineOptions extends GeometryOptions {readonly closed?:boolean;readonly maxPoints?:number}
export interface CurveOptions extends PolylineOptions {readonly segments?:number}
/** True when there is no path to build. The point budget is a real limit and
 * still throws; too few points for a path (or for a closed one) is an empty
 * curve, the same nothing-to-draw an empty mesh is. */
function count(points:number,options:PolylineOptions):boolean {
  const budget=options.maxPoints??Infinity;
  if(!(budget===Infinity||Number.isSafeInteger(budget))||budget<2||!Number.isSafeInteger(points)||points>budget)throw new Error('curve point count exceeds its positive integer budget');
  if(options.closed!==undefined&&typeof options.closed!=='boolean')throw new Error('curve closed must be boolean');
  return points<(options.closed?3:2);
}
function path(positions:readonly Vec3[],options:PolylineOptions&Geometry3Options,rows?:readonly Lifted2[]):Material {
  if(count(positions.length,options))return emptyMesh(options);
  positions.forEach(p=>finite3(p,'curve'));
  const segments=positions.length-(options.closed?0:1);
  // A repeated point is no segment: drop that edge and keep the rest of the
  // path, the same rule extrusion already uses for a zero distance.
  const edges=Array.from({length:segments},(_,i)=>{
    const j=(i+1)%positions.length;
    if(Math.hypot(...sub3(positions[i],positions[j]))===0)return undefined;
    return {id:`e:p${i}:p${j}`,vertices:[i,j] as [number,number],faces:[],attributes:{}};
  }).filter(e=>e!==undefined);
  const base=surface3(positions,[]);
  // A lifted 2D chain keeps who each vertex is and its columns.
  const points=rows?base.points.map((p,i)=>({...p,id:rows[i].id,attributes:Object.freeze({...rows[i].attributes})})):base.points;
  const surface:Surface3={...base,points,edges};
  const {closed:_closed,maxPoints:_max,...geometry}=options as PolylineOptions&Geometry3Options&{segments?:number};
  return curveGeometry3(surface,edges.map((_,i)=>i),geometry);
}
/** Sample a parameterized path once, at uniformly spaced t in [0,1].
 * Closed paths omit t=1 and connect the final sample to t=0. */
export function parametricCurve(position:(t:number)=>Vec3,options:CurveOptions={}):Material {
  if(typeof position!=='function')throw new Error('parametricCurve takes a function of t; a list of positions is curve(points)');
  const segments=options.segments??64,points=segments+(options.closed?0:1);
  if(emptyCount(segments,1,'curve segments'))return emptyMesh(options);
  if(count(points,options))return emptyMesh(options);
  // A formula that cannot answer somewhere draws nothing, as `parametric`'s
  // does.
  const sampled:Vec3[]=[];
  for(let i=0;i<points;i++){const p=position(i/segments);if(!Array.isArray(p)||p.length!==3||!p.every(Number.isFinite))return emptyMesh(options);sampled.push([p[0],p[1],p[2]]);}
  return path(sampled,options);
}
/** A profile as the construction verbs take it: a 3D curve as it is, or
 * the one chain of a 2D value — laid in XY at z = 0 for `sweep`, or in the
 * XZ meridian (x is the radius, y the height) for `revolve`. */
export function profileCurve<T extends Material>(profile:T|{readonly curves:unknown}|Curve2,plane:'xy'|'xz',who:string):T|Material {
  if((profile instanceof Material)&&inSpace3(profile))return profile as T;
  if(!isChain2(profile))throw new Error(`${who}: the profile is a curve — a 3D curve, or a 2D chain such as a material`);
  const chain=chain2(profile,who);
  return path(chain.points.map(p=>(plane==='xy'?[p.x,p.y,0]:[p.x,0,p.y]) as Vec3),{closed:chain.closed,derived:derived('lift',profile)},chain.points);
}
