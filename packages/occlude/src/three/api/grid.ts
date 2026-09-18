import {PointGeometry,type GeometryOptions} from './mesh.js';
import {assembleSurface3,type SurfacePoint3} from '../geometry/surface.js';
import {finite3,type Vec3} from '../math.js';
import {emptySize} from '../degenerate.js';
export interface GridOptions extends GeometryOptions {
  readonly cols:number;readonly rows:number;
  /** Number of Z layers; one produces an XY point grid. */
  readonly layers?:number;
  /** Positive model-space separation, scalar or XYZ triple. Default one. */
  readonly spacing?:number|Vec3;
  readonly maxPoints?:number;
}
/** Centered regular point grid. X varies fastest, then Y, then Z. */
export function grid(options:GridOptions):PointGeometry<{i:number;j:number;k:number}> {
  if(!options||typeof options!=='object'||Array.isArray(options))throw new Error('grid requires dimensions');
  const {cols,rows,layers=1,maxPoints=Infinity}=options;
  for(const [name,value] of Object.entries({cols,rows,layers,maxPoints}))if(!(name==='maxPoints'&&value===Infinity||Number.isSafeInteger(value))||value<0)throw new Error(`grid ${name} must be a nonnegative integer`);
  const count=cols*rows*layers;if(!Number.isSafeInteger(count)||count>maxPoints)throw new Error(`grid exceeds point budget (${maxPoints})`);
  const input=options.spacing??1,spacing:Vec3=typeof input==='number'?[input,input,input]:input;
  finite3(spacing);
  const points:SurfacePoint3[]=[];
  // A grid with no separation has no extent to lay points out in: empty, the
  // same nothing-to-draw a zero size gives every other primitive.
  if(count&&!emptySize(...spacing))for(let k=0;k<layers;k++)for(let j=0;j<rows;j++)for(let i=0;i<cols;i++){
    const position:Vec3=[(i-(cols-1)/2)*spacing[0],(j-(rows-1)/2)*spacing[1],(k-(layers-1)/2)*spacing[2]];
    finite3(position);points.push({id:`p${points.length}`,position,attributes:{i,j,k}});
  }
  return new PointGeometry<{i:number;j:number;k:number}>(assembleSurface3(points,[],[]),options);
}
