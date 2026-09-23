import {finite3,sub3,type Vec3} from '../math.js';
import {surface3,type Surface3} from '../geometry/surface.js';
import {CurveGeometry,emptyCurve,type GeometryOptions} from './mesh.js';
import {emptyCount,emptySize} from '../degenerate.js';
import {chain2,isChain2,type Lifted2} from './lift.js';
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
function path(positions:readonly Vec3[],options:PolylineOptions,rows?:readonly Lifted2[]):CurveGeometry {
  if(count(positions.length,options))return emptyCurve(options);
  positions.forEach(finite3);
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
  return new CurveGeometry(surface,edges.map((_,i)=>i),options);
}
/** A piecewise-linear 3D chain from positions, in the order given — the 2D
 * `curve`: open unless `closed: true`, and a closed chain shares its first
 * point at the seam (do not repeat it). A 2D chain (a material, anything
 * that answers `curves()`) is read as an XY profile at z = 0, and says
 * itself whether it is closed; its ids and columns are kept. No face or
 * implicit fill is constructed. */
export function curve(positions:readonly Vec3[]|{curves():unknown},options:PolylineOptions={}):CurveGeometry {
  if(typeof positions==='function')throw new Error('curve takes positions, as in 2D; a function of t is parametricCurve(t => [x, y, z], { segments })');
  if(isChain2(positions)){
    if(options.closed!==undefined)throw new Error('curve: a 2D chain says whether it is closed — leave out closed');
    const chain=chain2(positions,'curve');
    return path(chain.points.map(p=>[p.x,p.y,0] as Vec3),{...options,closed:chain.closed},chain.points);
  }
  if(!Array.isArray(positions))throw new Error('curve takes a list of [x, y, z] positions or a 2D chain');
  return path(positions,options);
}
/** Sample a parameterized path once, at uniformly spaced t in [0,1].
 * Closed paths omit t=1 and connect the final sample to t=0. */
export function parametricCurve(position:(t:number)=>Vec3,options:CurveOptions={}):CurveGeometry {
  if(typeof position!=='function')throw new Error('parametricCurve takes a function of t; a list of positions is curve(points)');
  const segments=options.segments??64,points=segments+(options.closed?0:1);
  if(emptyCount(segments,1,'curve segments'))return emptyCurve(options);
  if(count(points,options))return emptyCurve(options);
  return path(Array.from({length:points},(_,i)=>{const p=position(i/segments);finite3(p);return [...p] as Vec3;}),options);
}
/** Counterclockwise polygonal circle profile in XY, centered at the origin. */
export function circle(radius=1,options:Omit<CurveOptions,'closed'>={}):CurveGeometry {
  if(emptySize(radius))return emptyCurve(options);
  return parametricCurve(t=>[radius*Math.cos(2*Math.PI*t),radius*Math.sin(2*Math.PI*t),0],{...options,closed:true});
}
/** A profile as the construction verbs take it: a 3D curve as it is, or
 * the one chain of a 2D value — laid in XY at z = 0 for `sweep`, or in the
 * XZ meridian (x is the radius, y the height) for `revolve`. */
export function profileCurve<T extends CurveGeometry<any,any>>(profile:T|{curves():unknown},plane:'xy'|'xz',who:string):T|CurveGeometry {
  if(profile instanceof CurveGeometry)return profile;
  if(!isChain2(profile))throw new Error(`${who}: the profile is a curve — a 3D curve, or a 2D chain such as a material`);
  const chain=chain2(profile,who);
  return path(chain.points.map(p=>(plane==='xy'?[p.x,p.y,0]:[p.x,0,p.y]) as Vec3),{closed:chain.closed},chain.points);
}
