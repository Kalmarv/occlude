import {finite3,sub3,type Vec3} from '../math.js';
import {surface3,type Surface3} from '../geometry/surface.js';
import {CurveGeometry,type GeometryOptions} from './mesh.js';
export interface PolylineOptions extends GeometryOptions {readonly closed?:boolean;readonly maxPoints?:number}
export interface CurveOptions extends PolylineOptions {readonly segments?:number}
function count(points:number,options:PolylineOptions):void {
  const budget=options.maxPoints??Infinity;
  if(!(budget===Infinity||Number.isSafeInteger(budget))||budget<2||!Number.isSafeInteger(points)||points<2||points>budget)throw new Error('curve point count exceeds its positive integer budget');
  if(options.closed!==undefined&&typeof options.closed!=='boolean')throw new Error('curve closed must be boolean');
  if(options.closed&&points<3)throw new Error('closed curve requires at least three points');
}
/** A piecewise-linear 3D path. Closed paths share the first point at the seam;
 * do not repeat it in the input. No face or implicit fill is constructed. */
export function polyline(positions:readonly Vec3[],options:PolylineOptions={}):CurveGeometry {
  count(positions.length,options);positions.forEach(finite3);
  const segments=positions.length-(options.closed?0:1);
  const edges=Array.from({length:segments},(_,i)=>{
    const j=(i+1)%positions.length;
    if(Math.hypot(...sub3(positions[i],positions[j]))===0)throw new Error('curve has a zero-length segment; closed paths must not repeat their first point');
    return {id:`e:p${i}:p${j}`,vertices:[i,j] as [number,number],faces:[],attributes:{}};
  });
  const surface:Surface3={...surface3(positions,[]),edges};
  return new CurveGeometry(surface,edges.map((_,i)=>i),options);
}
/** Sample a parameterized path once, at uniformly spaced t in [0,1].
 * Closed paths omit t=1 and connect the final sample to t=0. */
export function curve(position:(t:number)=>Vec3,options:CurveOptions={}):CurveGeometry {
  const segments=options.segments??64,points=segments+(options.closed?0:1);
  if(!Number.isSafeInteger(segments)||segments<1)throw new Error('curve segments must be a positive integer');
  count(points,options);
  return polyline(Array.from({length:points},(_,i)=>{const p=position(i/segments);finite3(p);return [...p] as Vec3;}),options);
}
/** Counterclockwise polygonal circle profile in XY, centered at the origin. */
export function circle(radius=1,options:Omit<CurveOptions,'closed'>={}):CurveGeometry {
  if(!Number.isFinite(radius)||radius<=0)throw new Error('circle radius must be positive and finite');
  return curve(t=>[radius*Math.cos(2*Math.PI*t),radius*Math.sin(2*Math.PI*t),0],{...options,closed:true});
}
