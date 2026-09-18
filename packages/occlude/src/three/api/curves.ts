import {finite3,sub3,type Vec3} from '../math.js';
import {surface3,type Surface3} from '../geometry/surface.js';
import {CurveGeometry,emptyCurve,type GeometryOptions} from './mesh.js';
import {emptyCount,emptySize} from '../degenerate.js';
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
/** A piecewise-linear 3D path. Closed paths share the first point at the seam;
 * do not repeat it in the input. No face or implicit fill is constructed. */
export function polyline(positions:readonly Vec3[],options:PolylineOptions={}):CurveGeometry {
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
  const surface:Surface3={...surface3(positions,[]),edges};
  return new CurveGeometry(surface,edges.map((_,i)=>i),options);
}
/** Sample a parameterized path once, at uniformly spaced t in [0,1].
 * Closed paths omit t=1 and connect the final sample to t=0. */
export function curve(position:(t:number)=>Vec3,options:CurveOptions={}):CurveGeometry {
  const segments=options.segments??64,points=segments+(options.closed?0:1);
  if(emptyCount(segments,1,'curve segments'))return emptyCurve(options);
  if(count(points,options))return emptyCurve(options);
  return polyline(Array.from({length:points},(_,i)=>{const p=position(i/segments);finite3(p);return [...p] as Vec3;}),options);
}
/** Counterclockwise polygonal circle profile in XY, centered at the origin. */
export function circle(radius=1,options:Omit<CurveOptions,'closed'>={}):CurveGeometry {
  if(emptySize(radius))return emptyCurve(options);
  return curve(t=>[radius*Math.cos(2*Math.PI*t),radius*Math.sin(2*Math.PI*t),0],{...options,closed:true});
}
