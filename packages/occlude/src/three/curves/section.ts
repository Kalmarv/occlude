import { mesh3 } from '../geometry/mesh3.js';
import type { Material } from '../../material.js';
import type { Attributes3 } from '../geometry/surface.js';
import type { Vec3 } from '../math.js';
import { intersectPlane3 } from './plane.js';
import { stageGeometry3, type SurfaceCurves3, type SurfaceCurveSegment3 } from './surface.js';
export type { SurfaceCurves3, SurfaceCurveSegment3, SurfaceCurvePoint3 } from './surface.js';
const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;

export interface SectionPlane3 { readonly id:string; readonly origin:Vec3; readonly normal:Vec3; readonly attributes?:Attributes3 }
/** Mesh-plane sections in model coordinates. Coplanar patches contribute their
 * boundary, not triangulation diagonals; isolated tangent vertices emit no line.
 * Topological endpoint IDs connect pieces, never a screen-space proximity test. */
export function section3(input:Material,planes:readonly SectionPlane3[],options:{tolerance?:number;maxSegments?:number}={}):SurfaceCurves3 {
  const surface=stageGeometry3(input,'section3'),mesh=mesh3(surface),segments:SurfaceCurveSegment3[]=[];
  const max=options.maxSegments??Infinity;
  if(!(max===Infinity||Number.isSafeInteger(max))||max<1)throw new Error('section maxSegments must be a positive integer or Infinity');
  if(options.tolerance!==undefined&&(!Number.isFinite(options.tolerance)||options.tolerance<0))throw new Error('section tolerance must be finite and nonnegative');
  if(new Set(planes.map(p=>p.id)).size!==planes.length||planes.some(p=>!p.id))throw new Error('section planes require unique nonempty IDs');
  const source={positions:mesh.positions,names:mesh.names.points,triangles:mesh.triangles},all=Array.from({length:mesh.triangleCount},(_,i)=>i);
  for(const plane of [...planes].sort((a,b)=>compare(a.id,b.id))) {
    for(const [name,v] of [['origin',plane.origin],['normal',plane.normal]] as const)if(!Array.isArray(v)||v.length!==3||!v.every(n=>typeof n==='number'))throw new Error(`view section: ${name} is a place in space [x, y, z] — got ${JSON.stringify(v)}`);
    // A plane with no direction, or not finite, cuts nothing: that section
    // draws nothing and the others still draw.
    const length=Math.hypot(...plane.normal);
    if(!(length>0)||!Number.isFinite(length)||!plane.origin.every(Number.isFinite))continue;
    for(const segment of intersectPlane3(source,{...plane,attributes:{...plane.attributes,sectionPlane:plane.id}},all,{...options,kind:'section',maxSegments:max-segments.length}))segments.push(segment);
  }
  return Object.freeze({surface,segments:Object.freeze(segments)});
}
