import {cloneSurface3} from './model.js';
import type {Surface3} from './surface.js';
import type {Vec3} from '../math.js';

/** Ordinary corner columns; chart identity is categorical, UV is interpolated. */
export type SurfaceUV = {readonly uv:readonly [number,number];readonly chart:string};

/** Attach charts without changing geometric topology, fixed triangles or IDs. */
export function chartSurface3(source:Surface3,field:(face:number,corner:number,vertex:number)=>SurfaceUV):Surface3 {
  const result=cloneSurface3(source);
  result.faces.forEach((face,f)=>face.corners!.forEach((corner,c)=>{
    const value=field(f,c,face.vertices[c]);
    if(value.uv.length!==2||!value.uv.every(Number.isFinite)||typeof value.chart!=='string'||!value.chart)throw new Error('surface chart requires finite UV pairs and a nonempty chart identity');
    Object.assign(corner.attributes,{uv:[...value.uv],chart:value.chart});
  }));
  return result;
}

/** Parameters on the represented polyline, including the closing edge. */
export function arcParameters3(points:readonly Vec3[],closed:boolean):readonly number[] {
  const distances=[0],edges=points.length-(closed?0:1);
  for(let i=0;i<edges;i++){
    const p=points[i],q=points[(i+1)%points.length];
    distances.push(distances[i]+Math.hypot(q[0]-p[0],q[1]-p[1],q[2]-p[2]));
  }
  const total=distances.at(-1)!;
  if(!(total>0)||!Number.isFinite(total))throw new Error('surface chart arc length is not representable');
  return distances.map(d=>d/total);
}

/** Cap coordinates in the original profile, unaffected by transport or scale. */
export function profileCoordinates3(points:readonly Vec3[],axes:readonly [number,number]):readonly (readonly [number,number])[] {
  const low=[Infinity,Infinity],high=[-Infinity,-Infinity];
  for(const p of points)for(let k=0;k<2;k++){low[k]=Math.min(low[k],p[axes[k]]);high[k]=Math.max(high[k],p[axes[k]]);}
  const span=high.map((h,k)=>h-low[k]);
  if(span.some(s=>!(s>0)||!Number.isFinite(s)))throw new Error('surface cap chart extent is not representable');
  return points.map(p=>[(p[axes[0]]-low[0])/span[0],(p[axes[1]]-low[1])/span[1]] as const);
}
