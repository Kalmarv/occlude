import {kinds} from '../../column.js';
import type {Columns3} from './mesh3.js';
import type {Vec3} from '../math.js';

/** Ordinary corner columns; chart identity is categorical, UV is interpolated. */
export type SurfaceUV = {readonly uv:readonly [number,number];readonly chart:string};
/** The face column a charted surface writes: the chart the face was built with. */
export type SurfaceChart = {readonly chart:string};

/** The chart columns of a set of loops: each corner's `uv` and `chart` from
 * `field` (face, corner round the loop, point row), and the face column
 * `chart`, the chart the face was built with — its first corner's, which
 * every generator gives all of the face's corners — so a face selects by
 * chart without reading its corners. No loops, no columns. */
export function chartColumns3(loops:readonly (readonly number[])[],field:(face:number,corner:number,vertex:number)=>SurfaceUV):{readonly corners:Columns3;readonly faces:Columns3} {
  if(loops.length===0)return {corners:{},faces:{}};
  let count=0;for(const loop of loops)count+=loop.length;
  const uv=new Float64Array(2*count),charts:string[]=[],faceCharts:string[]=[];
  let at=0;
  loops.forEach((loop,f)=>{for(let c=0;c<loop.length;c++,at++){
    const value=field(f,c,loop[c]);
    if(value.uv.length!==2||!value.uv.every(Number.isFinite)||typeof value.chart!=='string'||!value.chart)throw new Error('surface chart requires finite UV pairs and a nonempty chart identity');
    uv[2*at]=value.uv[0];uv[2*at+1]=value.uv[1];charts.push(value.chart);
    if(c===0)faceCharts.push(value.chart);
  }});
  return {corners:{uv:kinds.vector(2).of(uv),chart:kinds.string.of(charts)},faces:{chart:kinds.string.of(faceCharts)}};
}

/** Parameters on the represented polyline, including the closing edge. */
export function arcParameters3(points:readonly Vec3[],closed:boolean):readonly number[] {
  const distances=[0],edges=points.length-(closed?0:1);
  for(let i=0;i<edges;i++){
    const p=points[i],q=points[(i+1)%points.length];
    distances.push(distances[i]+Math.hypot(q[0]-p[0],q[1]-p[1],q[2]-p[2]));
  }
  // A path with no length has no parameter to spread: every sample sits at 0.
  const total=distances.at(-1)!;
  return total>0&&Number.isFinite(total)?distances.map(d=>d/total):distances.map(()=>0);
}

/** Cap coordinates in the original profile, unaffected by transport or scale. */
export function profileCoordinates3(points:readonly Vec3[],axes:readonly [number,number]):readonly (readonly [number,number])[] {
  const low=[Infinity,Infinity],high=[-Infinity,-Infinity];
  for(const p of points)for(let k=0;k<2;k++){low[k]=Math.min(low[k],p[axes[k]]);high[k]=Math.max(high[k],p[axes[k]]);}
  // A cap with no extent on an axis has no chart to spread across it: 0 there.
  const span=high.map((h,k)=>h-low[k]),usable=span.map(s=>s>0&&Number.isFinite(s)?1/s:0);
  return points.map(p=>[(p[axes[0]]-low[0])*usable[0],(p[axes[1]]-low[1])*usable[1]] as const);
}
