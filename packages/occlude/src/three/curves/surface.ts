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
/** Two endpoints that share an ID must name the same source position. The
 * comparison is field by field rather than through a rendered key: `finite3`
 * above has already refused anything but finite triples, and `-0` compares
 * equal to `0` under `===` exactly as it does through `JSON.stringify`, so
 * the decision is the same one with no string per endpoint. */
function sameSourcePoint3(a:SurfaceCurvePoint3,b:SurfaceCurvePoint3):boolean {
  for(let i=0;i<3;i++)if(a.vertices[i]!==b.vertices[i]||a.weights[i]!==b.weights[i]||a.position[i]!==b.position[i])return false;
  return true;
}
export function validateSurfaceCurves3(curves:SurfaceCurves3,surface:Surface3):void {
  if(curves.surface!==surface)throw new Error('surface curves belong to a different captured surface; draw curves.surface or regenerate the curves');
  if(validated.get(curves)===surface)return;
  const ids=new Set<string>(),points=new Map<string,SurfaceCurvePoint3>();
  const vertexCount=surface.points.length,triangleCount=surface.triangles.length;
  for(const segment of curves.segments) {
    if(!segment.id||ids.has(segment.id)||!['section','hatch'].includes(segment.kind))throw new Error('surface curves need unique segment IDs and a supported kind');
    ids.add(segment.id);
    if(!segment.triangles.length||segment.triangles.some(i=>!Number.isSafeInteger(i)||i<0||i>=triangleCount))throw new Error('surface curve has invalid triangle support');
    for(const p of [segment.a,segment.b]) {
      finite3(p.position);finite3(p.weights);
      const [v0,v1,v2]=p.vertices,[w0,w1,w2]=p.weights;
      if(!p.id||p.vertices.length!==3
        ||!Number.isSafeInteger(v0)||v0<0||v0>=vertexCount||!Number.isSafeInteger(v1)||v1<0||v1>=vertexCount||!Number.isSafeInteger(v2)||v2<0||v2>=vertexCount
        ||w0<0||w0>1||w1<0||w1>1||w2<0||w2>1
        ||Math.abs(0+w0+w1+w2-1)>32*Number.EPSILON)throw new Error('surface curve has invalid barycentric source point');
      const a0=surface.points[v0].position,a1=surface.points[v1].position,a2=surface.points[v2].position;
      // `scale` is the max over the nine support coordinates and the three of
      // `position`; every term is an absolute value, so a running max is the
      // number `Math.max(...)` gave, without the flatMap and the two spreads.
      let scale=0;
      for(let j=0;j<3;j++) {
        const m0=Math.abs(a0[j]);if(m0>scale)scale=m0;
        const m1=Math.abs(a1[j]);if(m1>scale)scale=m1;
        const m2=Math.abs(a2[j]);if(m2>scale)scale=m2;
        const mp=Math.abs(p.position[j]);if(mp>scale)scale=mp;
      }
      const slack=64*Number.EPSILON*scale;
      // The same sums the reduce/map pair made, in the same order, without
      // the three intermediate arrays each endpoint used to allocate.
      for(let k=0;k<3;k++)if(Math.abs(0+a0[k]*w0+a1[k]*w1+a2[k]*w2-p.position[k])>slack)throw new Error('surface curve position disagrees with its captured source weights');
      const previous=points.get(p.id);
      if(previous!==undefined&&!sameSourcePoint3(previous,p))throw new Error('surface curve endpoint ID refers to different source positions');
      points.set(p.id,p);
      for(const index of segment.triangles) {
        const t=surface.triangles[index].vertices;
        if((w0>0&&!t.includes(v0))||(w1>0&&!t.includes(v1))||(w2>0&&!t.includes(v2)))throw new Error('surface curve point is outside its declared triangle support');
      }
    }
  }
  if(Object.isFrozen(curves)&&Object.isFrozen(curves.segments)&&curves.segments.every(seg=>Object.isFrozen(seg)&&Object.isFrozen(seg.a)&&Object.isFrozen(seg.b)&&Object.isFrozen(seg.triangles)))validated.set(curves,surface);
}
