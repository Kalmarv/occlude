import {estimateCurvature3,type CurvatureOptions3} from '../geometry/curvature.js';
import type {Surface3} from '../geometry/surface.js';
import type {CameraFrame3} from '../camera.js';
import {clampSetting} from '../degenerate.js';
import {add3,dot3,mul3,sub3,type Vec3} from '../math.js';

/**
 * Suggestive contours (DeCarlo, Finkelstein, Rusinkiewicz and Santella, 2003,
 * "Suggestive Contours for Conveying Shape"; ideas and the reading of the test
 * only, no code from any implementation).
 *
 * With `v` the unit vector from a surface point toward the eye and `w` the unit
 * projection of `v` onto the tangent plane, the radial curvature κ_r is the
 * normal curvature in direction `w`. A suggestive contour is the zero set of
 * κ_r where the surface is about to turn away, that is where the directional
 * derivative `D_w κ_r` is positive: `n·v` reaches a positive local minimum
 * along `w` without reaching zero. They are the lines a silhouette would draw
 * from a nearby viewpoint, which is why a blob gains volume when they appear.
 *
 * Method. κ_r is evaluated at each corner of each represented triangle from the
 * estimated principal curvatures and directions (`estimateCurvature3`) by
 * Euler's formula, then the zero set of its linear interpolant is traced across
 * the triangle exactly as an isoline of level zero: a corner whose κ_r equals
 * zero counts as above it, so a triangle yields either nothing or one segment
 * between two edge crossings. `D_w κ_r` is the gradient of that same linear
 * interpolant over the triangle, taken as `gradient` in surface/fields.ts takes
 * one, dotted with `w` at the segment's middle.
 *
 * Thresholds. `threshold` is dimensionless: the measured `D_w κ_r` is
 * multiplied by the square of the surface's own bounding-box diagonal, so the
 * same number draws the same lines on a model of any size. A segment whose
 * `n·v` at its middle is below `FACING_FLOOR3` is dropped: it is the silhouette
 * itself (or, below zero, the far side of the surface, whose contours the
 * silhouette already states).
 *
 * This is a pure function of the surface, the camera and the threshold. A flat
 * mesh, a mesh with no curvature to estimate and an eye inside the mesh all
 * yield no segments rather than an error.
 */
export interface SuggestiveOptions3 {readonly threshold?:number}
/** A crossing on the mesh edge `vertices` (lower index first), at parameter
 * `t` from the first vertex to the second. */
export interface SuggestiveEnd3 {readonly vertices:readonly [number,number];readonly t:number}
export interface SuggestiveSegment3 {readonly triangle:number;readonly ends:readonly [SuggestiveEnd3,SuggestiveEnd3]}

/** The default `D_w κ_r · diagonal²`, calibrated on a displaced sphere, a torus
 * and a sphere: low enough that a blob's valleys all draw, high enough that
 * tessellation noise on a smooth sphere draws nothing. */
export const SUGGESTIVE_THRESHOLD3=12;
/** The smallest `n·v` a suggestive contour may keep. */
export const FACING_FLOOR3=0.06;
/** Curvature smoothing for this reading: one pass more than the estimator's own
 * default, because the zero set of a second derivative is noisier than the
 * directions the tracers ask it for. */
const CURVATURE3:CurvatureOptions3={smoothing:2};

const length3=(v:Vec3):number=>Math.hypot(v[0],v[1],v[2]);
const safeUnit3=(v:Vec3):Vec3|null=>{const n=length3(v);return n>0&&Number.isFinite(n)?mul3(v,1/n):null;};

export function suggestiveSegments3(surface:Surface3,frame:CameraFrame3,options:SuggestiveOptions3={}):readonly SuggestiveSegment3[] {
  const threshold=clampSetting(options.threshold,0,Infinity,SUGGESTIVE_THRESHOLD3,'suggestive threshold');
  const points=surface.points,triangles=surface.triangles;
  if(!triangles.length)return [];
  const lo:number[]=[Infinity,Infinity,Infinity],hi:number[]=[-Infinity,-Infinity,-Infinity];
  for(const p of points)for(let k=0;k<3;k++){lo[k]=Math.min(lo[k],p.position[k]);hi[k]=Math.max(hi[k],p.position[k]);}
  const diagonal=Math.hypot(hi[0]-lo[0],hi[1]-lo[1],hi[2]-lo[2]);
  if(!(diagonal>0)||!Number.isFinite(diagonal))return [];
  const estimate=estimateCurvature3(surface,CURVATURE3);
  // Every camera but the parallel one carries real view rays from its eye.
  const fromEye=frame.camera.kind!=='orthographic',eye=frame.camera.eye,back=frame.back;
  const scale=diagonal*diagonal;
  const out:SuggestiveSegment3[]=[];
  for(let ti=0;ti<triangles.length;ti++){
    const t=triangles[ti],rows=estimate.corners[ti];
    if(!rows)continue;
    const position=t.vertices.map(v=>points[v].position) as unknown as readonly [Vec3,Vec3,Vec3];
    const kr=[0,0,0],facing=[0,0,0],w:Vec3[]=[];
    let usable=true;
    for(let c=0;c<3&&usable;c++){
      const row=rows[c],toEye=fromEye?safeUnit3(sub3(eye,position[c])):back;
      if(!toEye){usable=false;break;}
      const nv=dot3(row.normal,toEye),tangent=safeUnit3(sub3(toEye,mul3(row.normal,nv)));
      // Dead-on: the tangent projection vanishes and no radial direction exists.
      if(!tangent){usable=false;break;}
      const u=dot3(tangent,row.max),q=dot3(tangent,row.min),square=u*u+q*q;
      if(!(square>0)){usable=false;break;}
      const value=(row.kMax*u*u+row.kMin*q*q)/square;
      if(!Number.isFinite(value)){usable=false;break;}
      kr[c]=value;facing[c]=nv;w.push(tangent);
    }
    if(!usable)continue;
    // Half-open, as isolines read a level: a corner exactly at zero is above it,
    // so a contour through a vertex yields that vertex and no zero-length piece.
    const above=kr.map(v=>v>=0);
    if(above.every(Boolean)||!above.some(Boolean))continue;
    const ends:SuggestiveEnd3[]=[],weights:Vec3[]=[];
    for(let e=0;e<3;e++){
      const i=e,j=(e+1)%3;
      if(above[i]===above[j])continue;
      // Canonical order by vertex index, so the two triangles sharing this edge
      // compute the same crossing bit for bit and their segments meet.
      const [first,second]=t.vertices[i]<t.vertices[j]?[i,j]:[j,i];
      const span=kr[second]-kr[first];
      if(!(span!==0)||!Number.isFinite(span))continue;
      const parameter=Math.min(1,Math.max(0,-kr[first]/span));
      ends.push({vertices:[t.vertices[first],t.vertices[second]] as const,t:parameter});
      const barycentric:number[]=[0,0,0];barycentric[first]=1-parameter;barycentric[second]=parameter;
      weights.push(barycentric as unknown as Vec3);
    }
    // Two crossings that land on the same vertex are one point, not a segment.
    if(ends.length!==2||[0,1,2].every(c=>weights[0][c]===weights[1][c]))continue;
    const middle=[0,1,2].map(c=>(weights[0][c]+weights[1][c])/2);
    if(middle.reduce((sum,b,c)=>sum+b*facing[c],0)<FACING_FLOOR3)continue;
    const direction=safeUnit3([0,1,2].reduce((sum,c)=>add3(sum,mul3(w[c],middle[c])),[0,0,0] as Vec3));
    if(!direction)continue;
    // The gradient of the linear interpolant on the triangle, the same least
    // squares in the tangent basis surface/fields.ts `gradient` uses.
    const e1=sub3(position[1],position[0]),e2=sub3(position[2],position[0]);
    const f1=kr[1]-kr[0],f2=kr[2]-kr[0];
    const g11=dot3(e1,e1),g12=dot3(e1,e2),g22=dot3(e2,e2),determinant=g11*g22-g12*g12;
    if(!(determinant>0)||!Number.isFinite(determinant))continue;
    const alpha=(f1*g22-f2*g12)/determinant,beta=(f2*g11-f1*g12)/determinant;
    const gradient=add3(mul3(e1,alpha),mul3(e2,beta));
    const derivative=dot3(gradient,direction)*scale;
    if(!Number.isFinite(derivative)||!(derivative>threshold))continue;
    out.push(Object.freeze({triangle:ti,ends:Object.freeze([Object.freeze(ends[0]),Object.freeze(ends[1])]) as readonly [SuggestiveEnd3,SuggestiveEnd3]}));
  }
  return Object.freeze(out);
}
