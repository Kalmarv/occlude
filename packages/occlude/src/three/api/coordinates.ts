import {Mesh,type EdgeAttributes} from './mesh.js';
import type {Attributes3} from '../geometry/surface.js';
import {chartSurface3,type SurfaceUV} from '../geometry/coordinates.js';
import {dot3,cross3,sub3,mul3,unit3,finite3,type Vec3} from '../math.js';

interface CoordinateOptions {
  /** In the mesh's current coordinates. Stored results follow later deformation. */
  readonly origin?:Vec3;
  readonly chart?:string;
}
export interface PlanarUVOptions extends CoordinateOptions {
  /** Model vectors spanning one chart unit. They may be oblique. Default +X/+Y. */
  readonly u?:Vec3;
  readonly v?:Vec3;
}
export interface CylindricalUVOptions extends CoordinateOptions {
  /** Cylinder axis, default +Z. */
  readonly axis?:Vec3;
  /** Radial zero-angle direction, projected off the axis. Default +X (or +Y). */
  readonly seam?:Vec3;
  /** Model distance for one v unit, measured from origin. Default 1. */
  readonly height?:number;
}
type Coordinates<C>=Omit<C,keyof SurfaceUV>&SurfaceUV;
function options(value:CoordinateOptions,fallback:string):{origin:Vec3;chart:string} {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('UV projection options must be an object');
  const origin=value.origin??[0,0,0],chart=value.chart??fallback;finite3(origin);
  if(typeof chart!=='string'||!chart)throw new Error('UV projection chart must be a nonempty string');
  return {origin,chart};
}
function capture<P extends Attributes3,E extends EdgeAttributes,F extends Attributes3,C extends Attributes3>(mesh:Mesh<P,E,F,C>,values:readonly (readonly (readonly [number,number])[])[],chart:string):Mesh<P,E,F,Coordinates<C>> {
  return new Mesh(chartSurface3(mesh.surface,(f,c)=>({uv:values[f][c],chart})),{...mesh,history:[],cornerTransfers:{...mesh.cornerTransfers,uv:'interpolate',chart:'nearest'}});
}
/** Store a planar projection in ordinary uv/chart corner columns. Re-evaluate
 * explicitly after moving the mesh for a world-fixed projection instead. */
export function planarUV<P extends Attributes3,E extends EdgeAttributes,F extends Attributes3,C extends Attributes3>(mesh:Mesh<P,E,F,C>,settings:PlanarUVOptions={}):Mesh<P,E,F,Coordinates<C>> {
  if(!(mesh instanceof Mesh))throw new Error('planarUV requires a mesh');
  const {origin,chart}=options(settings,'planar'),u=settings.u??[1,0,0],v=settings.v??[0,1,0];finite3(u);finite3(v);
  // Cross-product duals avoid subtracting almost equal Gram products.
  const un=unit3(u),vn=unit3(v),n=cross3(un,vn),nn=dot3(n,n);
  if(!(nn>0)||!Number.isFinite(1/nn))throw new Error('planarUV axes must be independent and representable');
  const du=mul3(cross3(vn,n),1/nn),dv=mul3(cross3(n,un),1/nn),ul=Math.hypot(...u),vl=Math.hypot(...v);
  const values=mesh.surface.faces.map(f=>f.vertices.map(i=>{
    const p=sub3(mesh.surface.points[i].position,origin);
    return [dot3(p,du)/ul,dot3(p,dv)/vl] as const;
  }));
  return capture(mesh,values,chart);
}

/** Store angular u (one turn) and axial v. Unwrap each polygon across the
 * radial seam without duplicating geometry. Faces spanning half a turn or
 * surrounding the axis require subdivision or separate planar cap charts. */
export function cylindricalUV<P extends Attributes3,E extends EdgeAttributes,F extends Attributes3,C extends Attributes3>(mesh:Mesh<P,E,F,C>,settings:CylindricalUVOptions={}):Mesh<P,E,F,Coordinates<C>> {
  if(!(mesh instanceof Mesh))throw new Error('cylindricalUV requires a mesh');
  const {origin,chart}=options(settings,'cylindrical'),direction=settings.axis??[0,0,1],height=settings.height??1;finite3(direction);
  const axis=unit3(direction);
  if(!(height>0)||!Number.isFinite(height))throw new Error('cylindricalUV height must be positive and finite');
  const reference=settings.seam??(Math.abs(axis[0])<.9?[1,0,0]:[0,1,0]);finite3(reference);
  const radial=unit3(sub3(reference,mul3(axis,dot3(reference,axis)))),around=cross3(axis,radial);
  const positions=mesh.surface.points.map(p=>{
    const q=sub3(p.position,origin),x=dot3(q,radial),y=dot3(q,around),v=dot3(q,axis)/height;
    let u=Math.atan2(y,x)/(2*Math.PI);if(u<0)u+=1;
    return {u,v,pole:x===0&&y===0};
  });
  const values=mesh.surface.faces.map(face=>{
    const rows=face.vertices.map(i=>positions[i]),angles=[...new Set(rows.filter(p=>!p.pole).map(p=>p.u))].sort((a,b)=>a-b);
    if(!angles.length)throw new Error('cylindricalUV face lies on the projection axis');
    let start=angles[0];
    if(angles.at(-1)!-angles[0]>.5){
      let gap=-1;
      for(let i=0;i<angles.length;i++){
        const next=angles[(i+1)%angles.length],width=next+(i+1===angles.length?1:0)-angles[i];
        if(width>gap){gap=width;start=next;}
      }
    }
    const unwrap=(u:number)=>u<start?u+1:u;let low=Infinity,high=-Infinity;
    for(const angle of angles){const u=unwrap(angle);low=Math.min(low,u);high=Math.max(high,u);}
    if(high-low>=.5)throw new Error('cylindricalUV face spans half a turn or surrounds the axis; subdivide it or use a separate planar cap chart');
    return rows.map(p=>[p.pole?(low+high)/2:unwrap(p.u),p.v] as const);
  });
  return capture(mesh,values,chart);
}
