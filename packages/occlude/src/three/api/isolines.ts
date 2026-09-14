import {Mesh,type GeometryOptions} from './mesh.js';
import type {MeshCornerRow} from './topology.js';
import {SurfaceCurves} from './supported.js';
import {isolines3} from '../curves/isolines.js';
import type {SurfaceCurveBudget3} from '../curves/network.js';

export type IsolineLevels=readonly number[]|{readonly count:number;readonly min?:number;readonly max?:number}|{readonly spacing:number;readonly offset?:number};
export interface IsolineOptions extends GeometryOptions {
  readonly levels:IsolineLevels;
  readonly maxSegments?:number;readonly maxNodes?:number;readonly budget?:SurfaceCurveBudget3;
}
/** `levelIndex` rather than `index`: edge rows already carry their row index. */
export type IsolineAttributes={level:number;levelIndex:number};
export type IsolineField=string|((corner:MeshCornerRow<any,any,any,any>)=>number);
function resolveLevels(spec:IsolineLevels,values:ArrayLike<number>):number[] {
  let min=Infinity,max=-Infinity;for(let i=0;i<values.length;i++){min=Math.min(min,values[i]);max=Math.max(max,values[i]);}
  if(Array.isArray(spec)){if(!spec.length||spec.some(l=>!Number.isFinite(l)))throw new Error('isolines levels must be a nonempty finite array');return [...spec];}
  if('count'in spec){
    const count=spec.count,lo=spec.min??min,hi=spec.max??max;
    if(!Number.isSafeInteger(count)||count<1)throw new Error('isolines count must be a positive integer');
    if(!Number.isFinite(lo)||!Number.isFinite(hi)||!(hi>lo))throw new Error('isolines require a positive finite level range');
    return Array.from({length:count},(_,i)=>lo+(hi-lo)*(i+1)/(count+1));
  }
  const spacing=(spec as {spacing:number}).spacing,offset=(spec as {offset?:number}).offset??0;
  if(!Number.isFinite(spacing)||spacing<=0||!Number.isFinite(offset))throw new Error('isolines spacing must be positive and finite');
  if(!Number.isFinite(min)||!Number.isFinite(max))throw new Error('isolines require finite corner values');
  const first=Math.ceil((min-offset)/spacing),last=Math.floor((max-offset)/spacing);
  if(last-first>1_000_000)throw new Error('isolines spacing produces too many levels');
  const out:number[]=[];for(let k=first;k<=last;k++)out.push(k*spacing+offset);
  return out;
}
/** Isolines of a per-corner scalar: a numeric point attribute by name, or a
 * callback over mesh corner rows (`c => c.uv[1]` for cross-contours). Values
 * are interpolated linearly inside each represented triangle; a nonlinear
 * field is approximated by its corner samples, so refine the mesh for
 * accuracy. Reusable supported construction geometry, not a view feature. */
export function isolines(mesh:Mesh<any,any,any,any>,field:IsolineField,options:IsolineOptions):SurfaceCurves<IsolineAttributes> {
  if(!(mesh instanceof Mesh))throw new Error('isolines require a mesh');
  if(!options||typeof options!=='object'||Array.isArray(options)||options.levels===undefined)throw new Error('isolines require { levels }');
  const corners=[...mesh.corners];
  const values=Float64Array.from(corners,c=>{
    const v=typeof field==='string'?c.point.attributes[field]:field(c);
    if(typeof v!=='number'||!Number.isFinite(v))throw new Error(typeof field==='string'?`isolines require a finite numeric point attribute '${field}'`:'isolines field must return finite numbers');
    return v;
  });
  const levels=resolveLevels(options.levels,values);
  const result=isolines3(mesh.surface,values,levels,{key:options.key??mesh.key,maxSegments:options.maxSegments,maxNodes:options.maxNodes,budget:options.budget});
  return new SurfaceCurves<IsolineAttributes>(result.network,{key:options.key});
}
