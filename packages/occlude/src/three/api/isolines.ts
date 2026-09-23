import {Mesh} from './mesh.js';
import type {IsoLevels} from '../../isolines.js';
import {refuseStroke} from './recipes.js';
import type {MeshCornerRow} from './topology.js';
import {SurfaceCurves,type SurfaceCurveOptions} from './supported.js';
import {isolines3} from '../curves/isolines.js';
import {snapshotSurface3} from '../geometry/model.js';
import {surfaceBinding3,type SurfaceBinding3,type SurfaceCurveBudget3,type SurfaceCurveNetwork3,type SurfaceCurveRecipe3,type SurfaceCurveView3} from '../curves/network.js';

/** Which levels to trace: the 2D `t.isolines` `at` — one level, a list,
 * `{ count }` levels spread inside the field's range (`min`/`max` pin it),
 * or every multiple of `{ spacing }` (shifted by `offset`) inside it. */
export type IsolineLevels=IsoLevels;
export interface IsolineOptions extends SurfaceCurveOptions {
  readonly maxSegments?:number;readonly maxNodes?:number;readonly budget?:SurfaceCurveBudget3;
}
/** `levelIndex` rather than `index`: edge rows already carry their row index. */
export type IsolineAttributes={level:number;levelIndex:number};
/** The field's row: the corner (uv, chart, `.point`, `.face`) with its point's
 * `x`, `y`, `z` and point attributes merged in, so `p => p.z` and
 * `c => c.uv[1]` both read naturally. */
export type IsolineRow=MeshCornerRow<any,any,any,any>&{readonly x:number;readonly y:number;readonly z:number};
export type IsolineField=string|((row:IsolineRow)=>number);
/** No levels is no contours. A level list, a flat field, a spacing of zero and
 * a field with no finite values all resolve to nothing to draw; the level
 * count, which is a repetition count, still rejects a non-integer. */
function resolveLevels(spec:IsolineLevels,values:ArrayLike<number>):number[] {
  let min=Infinity,max=-Infinity;for(let i=0;i<values.length;i++)if(Number.isFinite(values[i])){min=Math.min(min,values[i]);max=Math.max(max,values[i]);}
  if(typeof spec==='number')return Number.isFinite(spec)?[spec]:[];
  if(Array.isArray(spec))return spec.filter(l=>Number.isFinite(l));
  if('count'in spec){
    const count=spec.count,lo=spec.min??min,hi=spec.max??max;
    if(!Number.isSafeInteger(count))throw new Error('isolines count must be a positive integer');
    if(count<1||!Number.isFinite(lo)||!Number.isFinite(hi)||!(hi>lo))return [];
    return Array.from({length:count},(_,i)=>lo+(hi-lo)*(i+1)/(count+1));
  }
  const spacing=(spec as {spacing:number}).spacing,offset=(spec as {offset?:number}).offset??0;
  if(!Number.isFinite(spacing)||spacing<=0||!Number.isFinite(offset))return [];
  if(!Number.isFinite(min)||!Number.isFinite(max))return [];
  const first=Math.ceil((min-offset)/spacing),last=Math.floor((max-offset)/spacing);
  if(last-first>1_000_000)throw new Error('isolines spacing produces too many levels');
  const out:number[]=[];for(let k=first;k<=last;k++)out.push(k*spacing+offset);
  return out;
}
/** Everything the network is a function of, owned before the async boundary:
 * the captured surface, its per-corner values and the resolved levels. The
 * field is read exactly once, here, so a view never re-runs the sketch's
 * lambda and a level list cannot drift between two resolutions. */
export interface CapturedIsolines {
  readonly surface:ReturnType<typeof snapshotSurface3>;readonly binding:SurfaceBinding3;
  readonly values:Float64Array;readonly levels:readonly number[];
  readonly key?:string;readonly maxSegments?:number;readonly maxNodes?:number;readonly budget?:SurfaceCurveBudget3;
}
const levelWords=['levels','count','spacing','offset','min','max'] as const;
/** `at` is the levels and nothing else; the options are everything else. */
function checkedLevels(at:unknown):IsoLevels {
  if(typeof at==='number'||Array.isArray(at))return at as IsoLevels;
  if(!at||typeof at!=='object')throw new Error('isolines: at is a level, a list of levels, { count } or { spacing } — isolines(mesh, field, [0, 0.5])');
  if('levels' in at)throw new Error('isolines: `levels` is gone — the levels are the third argument, as in 2D: isolines(mesh, field, [0, 0.5])');
  const other=Object.keys(at).filter(k=>!(levelWords as readonly string[]).includes(k));
  if(other.length)throw new Error(`isolines: '${other[0]}' is an option, not a level — isolines(mesh, field, at, { ${other[0]} })`);
  if(('count' in at)===('spacing' in at))throw new Error('isolines: at takes one of { count } or { spacing }');
  return at as IsoLevels;
}
export function captureIsolines(mesh:Mesh<any,any,any,any>,field:IsolineField,at:IsoLevels,options:IsolineOptions={}):CapturedIsolines {
  if(!(mesh instanceof Mesh))throw new Error('isolines require a mesh');
  if(!options||typeof options!=='object'||Array.isArray(options))throw new Error('isolines options must be an object');
  const moved=(levelWords as readonly string[]).find(k=>k in options);
  if(moved)throw new Error(`isolines: '${moved}' is a level, not an option — the levels are the third argument, as in 2D: isolines(mesh, field, ${moved==='levels'?'[0, 0.5]':`{ ${moved}: … }`})`);
  refuseStroke(options,'isolines');
  const spec=checkedLevels(at);
  const corners=[...mesh.corners];
  const values=Float64Array.from(corners,c=>{
    const row:IsolineRow=Object.freeze(Object.assign(Object.create(c) as IsolineRow,{...c.point.attributes,x:c.point.x,y:c.point.y,z:c.point.z}));
    // A named column that is not numeric is the wrong column and still throws;
    // a value the field could not answer leaves that corner out, so only the
    // triangles touching it are skipped.
    const v=typeof field==='string'?(c.point.attributes[field]??c.attributes[field]):field(row);
    if(typeof v!=='number')throw new Error(typeof field==='string'?`isolines require a finite numeric point attribute '${field}'`:'isolines field must return finite numbers');
    return v;
  });
  const levels=resolveLevels(spec,values);
  const surface=snapshotSurface3(mesh.surface);
  return {surface,binding:surfaceBinding3(surface),values,levels:Object.freeze([...levels]),key:options.key??mesh.key,maxSegments:options.maxSegments,maxNodes:options.maxNodes,budget:options.budget};
}
/** The contours as a description a view resolves once it knows its camera.
 *
 * `resolve()` alone — a sketch reading `curves.network`, or an object the view
 * cannot certify — builds every crossing, exactly as an eager run did, and the
 * result is memoised. `resolve(keep, view)` hands the kernel the view's
 * per-triangle verdicts as its `hidden` predicate: a face the certificate
 * proves hidden as a closed set hides every level on it, so those crossings
 * keep their topology — the same ports, chains and order — and skip their
 * coordinates. The visible network is the same either way, which is the
 * kernel's own contract (`isolines3({ hidden })`).
 *
 * `keep` names the sources the view draws. These contours have one source and
 * one network; dropping it would leave the view with no placement for the
 * marks it asked for, so the recipe resolves whether or not its mesh is kept
 * and the snapshot refuses a missing placement by name, as it always did. */
export function isolineRecipe(captured:CapturedIsolines):SurfaceCurveRecipe3 {
  const {surface,values,levels,key,maxSegments,maxNodes,budget}=captured;
  const build=(hidden?:(level:number,triangle:number)=>boolean):SurfaceCurveNetwork3=>
    isolines3(surface,values,levels,{key,maxSegments,maxNodes,budget,...(hidden?{hidden}:{})}).network;
  let full:SurfaceCurveNetwork3|undefined;
  return Object.freeze({
    bindings:Object.freeze([captured.binding]),
    resolve(_keep?:(binding:SurfaceBinding3)=>boolean,view?:SurfaceCurveView3):SurfaceCurveNetwork3 {
      const certified=view?.hiddenTriangles(captured.binding);
      // Nothing certified is the eager run, and the memoised one: a predicate
      // that never answers true would build the same rows for more work.
      if(!certified||!certified.some(flag=>flag===1))return full??=build();
      return build((_level,triangle)=>certified[triangle]===1);
    },
  });
}
/** Isolines of a per-corner scalar at the levels `at` (the 2D `t.isolines`
 * spelling): a numeric point attribute by name, or a
 * callback over mesh corner rows (`c => c.uv[1]` for cross-contours). Values
 * are interpolated linearly inside each represented triangle; a nonlinear
 * field is approximated by its corner samples, so refine the mesh for
 * accuracy. Reusable supported construction geometry, not a view feature. */
export function isolines(mesh:Mesh<any,any,any,any>,field:IsolineField,at:IsoLevels,options:IsolineOptions={}):SurfaceCurves<IsolineAttributes> {
  const captured=captureIsolines(mesh,field,at,options);
  return new SurfaceCurves<IsolineAttributes>(isolineRecipe(captured),{key:options.key,pen:options.pen});
}
