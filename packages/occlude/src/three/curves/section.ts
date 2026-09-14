import { snapshotSurface3 } from '../geometry/model.js';
import type { Attributes3, Surface3 } from '../geometry/surface.js';
import type { Vec3 } from '../math.js';
import { intersectPlane3 } from './plane.js';
import type { SurfaceCurves3, SurfaceCurveSegment3 } from './surface.js';
export type { SurfaceCurves3, SurfaceCurveSegment3, SurfaceCurvePoint3 } from './surface.js';
const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;

export interface SectionPlane3 { readonly id:string; readonly origin:Vec3; readonly normal:Vec3; readonly attributes?:Attributes3 }
/** Mesh-plane sections in model coordinates. Coplanar patches contribute their
 * boundary, not triangulation diagonals; isolated tangent vertices emit no line.
 * Topological endpoint IDs connect pieces, never a screen-space proximity test. */
export function section3(input:Surface3,planes:readonly SectionPlane3[],options:{tolerance?:number;maxSegments?:number}={}):SurfaceCurves3 {
  const surface=snapshotSurface3(input),segments:SurfaceCurveSegment3[]=[];
  const max=options.maxSegments??Infinity;
  if(!(max===Infinity||Number.isSafeInteger(max))||max<1)throw new Error('section maxSegments must be a positive integer or Infinity');
  if(options.tolerance!==undefined&&(!Number.isFinite(options.tolerance)||options.tolerance<0))throw new Error('section tolerance must be finite and nonnegative');
  if(new Set(planes.map(p=>p.id)).size!==planes.length||planes.some(p=>!p.id))throw new Error('section planes require unique nonempty IDs');
  for(const plane of [...planes].sort((a,b)=>compare(a.id,b.id))) {
    for(const segment of intersectPlane3(surface,{...plane,attributes:{...plane.attributes,sectionPlane:plane.id}},surface.triangles.map((_,i)=>i),{...options,kind:'section',maxSegments:max-segments.length}))segments.push(segment);
  }
  return Object.freeze({surface,segments:Object.freeze(segments)});
}
