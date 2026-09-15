import type { Attributes3, Surface3 } from '../geometry/surface.js';
import { finite3, type Vec3 } from '../math.js';

/** Barycentric source position; original vertex indices survive instance transforms. */
export interface SurfaceCurvePoint3 { readonly id:string; readonly position:Vec3; readonly vertices:readonly [number,number,number]; readonly weights:Vec3 }
export interface SurfaceCurveSegment3 {
  readonly id:string;
  readonly kind:'section'|'hatch';
  readonly a:SurfaceCurvePoint3;
  readonly b:SurfaceCurvePoint3;
  readonly triangles:readonly number[];
  readonly attributes:Readonly<Attributes3>;
  /** Segments of one chain join into one stroke where they share nodes; `range`
   * is the segment's increasing parameter interval along that chain. */
  readonly chainId?:string;
  readonly range?:readonly [number,number];
}
/** Draw against this exact owned surface; a new model needs newly generated curves. */
export interface SurfaceCurves3 { readonly surface:Surface3; readonly segments:readonly SurfaceCurveSegment3[] }
export const freezeCurves3=<T>(value:T):T=>{if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const v of Object.values(value))freezeCurves3(v);Object.freeze(value);}return value;};

/** Validate source ownership before any support IDs can bypass self-occlusion. */
// Frozen curve sets are validated once per surface: the snapshot and the
// network builder both check the same object.
const validated=new WeakMap<SurfaceCurves3,Surface3>();
export function validateSurfaceCurves3(curves:SurfaceCurves3,surface:Surface3):void {
  if(curves.surface!==surface)throw new Error('surface curves belong to a different captured surface; draw curves.surface or regenerate the curves');
  if(validated.get(curves)===surface)return;
  const ids=new Set<string>(),points=new Map<string,string>();
  for(const segment of curves.segments) {
    if(!segment.id||ids.has(segment.id)||!['section','hatch'].includes(segment.kind))throw new Error('surface curves need unique segment IDs and a supported kind');
    ids.add(segment.id);
    if(!segment.triangles.length||segment.triangles.some(i=>!Number.isSafeInteger(i)||i<0||i>=surface.triangles.length))throw new Error('surface curve has invalid triangle support');
    for(const p of [segment.a,segment.b]) {
      finite3(p.position);finite3(p.weights);
      if(!p.id||p.vertices.length!==3||p.vertices.some(i=>!Number.isSafeInteger(i)||i<0||i>=surface.points.length)||p.weights.some(w=>w<0||w>1)||Math.abs(p.weights.reduce((a,b)=>a+b,0)-1)>32*Number.EPSILON)throw new Error('surface curve has invalid barycentric source point');
      const expected=p.vertices.reduce((sum,v,i)=>sum.map((n,k)=>n+surface.points[v].position[k]*p.weights[i]),[0,0,0]);
      const scale=Math.max(...p.vertices.flatMap(v=>surface.points[v].position.map(Math.abs)),...p.position.map(Math.abs));
      if(expected.some((n,k)=>Math.abs(n-p.position[k])>64*Number.EPSILON*scale))throw new Error('surface curve position disagrees with its captured source weights');
      const identity=JSON.stringify([p.vertices,p.weights,p.position]),previous=points.get(p.id);
      if(previous!==undefined&&previous!==identity)throw new Error('surface curve endpoint ID refers to different source positions');
      points.set(p.id,identity);
      for(const index of segment.triangles)if(p.vertices.some((v,i)=>p.weights[i]>0&&!surface.triangles[index].vertices.includes(v)))throw new Error('surface curve point is outside its declared triangle support');
    }
  }
  if(Object.isFrozen(curves)&&Object.isFrozen(curves.segments)&&curves.segments.every(seg=>Object.isFrozen(seg)&&Object.isFrozen(seg.a)&&Object.isFrozen(seg.b)&&Object.isFrozen(seg.triangles)))validated.set(curves,surface);
}
