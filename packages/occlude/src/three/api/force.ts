import {position3,PreparedQuery,type PointLike3,type Position3} from './query.js';
import {add3,sub3,mul3,dot3,unit3,type Vec3} from '../math.js';
export type Force<Row extends Position3=Position3>=(point:Row,iteration?:number)=>Vec3;
function strength(value:number):number{if(!Number.isFinite(value))throw new Error('force strength must be finite');return value;}
function attract(target:PointLike3,options:{strength?:number}={}):Force{const goal=position3(target),gain=strength(options.strength??1);return p=>mul3(sub3(goal,position3(p)),gain);}
function plane(options:{origin:PointLike3;normal:Vec3;side:'below'|'above';strength?:number}):Force{
  const origin=position3(options.origin),normal=unit3(position3(options.normal)),gain=strength(options.strength??1),side=options.side;
  if(side!=='below'&&side!=='above')throw new Error('plane force side must be below or above');if(gain<0||gain>1)throw new Error('plane constraint strength must be between 0 and 1');
  return p=>{const distance=dot3(sub3(position3(p),origin),normal),violates=side==='below'?distance>0:distance<0;return violates?mul3(normal,-distance*gain):[0,0,0];};
}
function project(target:PreparedQuery<any>,options:{strength?:number;within?:number}={}):Force{
  if(!(target instanceof PreparedQuery))throw new Error('projection force requires a prepared query');
  const gain=strength(options.strength??1),within=options.within;
  if(within!==undefined&&(Number.isNaN(within)||within<0))throw new Error('projection force within must be nonnegative');
  return p=>{const point=position3(p),hit=target.nearest(point,{within});return hit?mul3(sub3(hit.position,point),gain):[0,0,0];};
}
function sum<Row extends Position3>(...forces:readonly Force<Row>[]):Force<Row>{const captured=[...forces];if(captured.some(f=>typeof f!=='function'))throw new Error('force sum requires force functions');return (p,k=0)=>captured.reduce<Vec3>((value,f)=>add3(value,position3(f(p,k))),[0,0,0]);}
/** Reusable CPU fields; evaluate against each frozen pass's current point rows. */
export const force=Object.freeze({attract,plane,project,sum});
