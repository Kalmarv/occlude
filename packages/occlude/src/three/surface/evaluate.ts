import type {Surface3} from '../geometry/surface.js';
import {snapshotSurface3,transformPosition3} from '../geometry/model.js';
import {captureSurfacePlacement3,type SurfacePlacement3} from '../geometry/location.js';
import {triangleCorners3} from '../geometry/corners.js';
import {PhaseClock3,type PhaseTimings3} from '../timing.js';
import {cross3,mul3,sub3,unit3,type Vec3} from '../math.js';
import {lightTone3,imageValue3,decideTone3,type ToneRecipe3} from './tone.js';

/** Batched evaluation of many surface locations at once. The CPU path below is
 * the reference for the GPU kernel; both read the same packed target data. */
export interface SurfaceEvaluationTarget3 {
  readonly surface:Surface3;
  readonly placement?:SurfacePlacement3;
  readonly uvAttribute?:string;
  readonly chartAttribute?:string;
}
export interface SurfaceEvaluationBatch3 {
  readonly triangle:Uint32Array;
  /** Three nonnegative weights per location, summing to one. */
  readonly weights:Float32Array;
}
export interface SurfaceEvaluationStats3 {
  readonly backend:'cpu'|'gpu';readonly dispatches:number;readonly transferBytes:number;
  readonly cacheHit:boolean;readonly targetUploadBytes:number;
  /** Locations the GPU could not represent and the CPU reference evaluated. */
  readonly refinements:number;readonly timings:PhaseTimings3;
}
export interface SurfaceEvaluationResult3 {
  readonly position:Float32Array;readonly normal:Float32Array;
  readonly uv?:Float32Array;readonly tone?:Float32Array;
  readonly stats:SurfaceEvaluationStats3;
}
/** Packed represented geometry shared by the CPU reference and GPU upload:
 * placed vertices, the same geometric normal rule as surface locations, and
 * per-corner chart coordinates when every corner carries a finite pair. */
export interface PackedSurfaceTarget3 {
  readonly source:Surface3;readonly placement?:SurfacePlacement3;
  readonly triangles:number;
  /** 9 floats per triangle: placed a, b, c. */
  readonly vertices:Float64Array;
  /** 3 unit floats per triangle, already flipped for mirrored placements. */
  readonly normals:Float64Array;
  /** 6 floats per triangle (a, b, c UV), or undefined when the chart is absent. */
  readonly uv?:Float64Array;
  readonly uvAttribute:string;
}
const packedTargets=new WeakMap<Surface3,Map<string,PackedSurfaceTarget3>>();
function geometricNormal(ab:Vec3,ac:Vec3):Vec3 {
  const edgeScale=Math.max(Math.hypot(...ab),Math.hypot(...ac));
  const scaledCross=cross3(mul3(ab,1/edgeScale),mul3(ac,1/edgeScale)),normalLength=Math.hypot(...scaledCross);
  if(normalLength>0&&Number.isFinite(1/normalLength))return unit3(scaledCross);
  // A triangle with no plane has no normal: zero, the "no direction here" the
  // tracer and the face measures already read.
  const scaled=(v:Vec3)=>{const s=Math.max(...v.map(Math.abs));return s?unit3(v.map(n=>n/s) as unknown as Vec3):undefined;};
  const u=scaled(ab),w=scaled(ac);if(!u||!w)return [0,0,0];
  return scaled(cross3(u,w))??[0,0,0];
}
/** Pack once per surface, placement and coordinate column; results are weakly
 * held by the source snapshot, so retaining geometry retains its packing. */
export function packSurfaceTarget3(target:SurfaceEvaluationTarget3):PackedSurfaceTarget3 {
  const source=snapshotSurface3(target.surface),placement=captureSurfacePlacement3(target.placement),uvAttribute=target.uvAttribute??'uv';
  if(typeof uvAttribute!=='string'||!uvAttribute)throw new Error('surface evaluation uvAttribute must be a nonempty string');
  const key=JSON.stringify([placement?JSON.stringify(placement):null,uvAttribute]);
  let byKey=packedTargets.get(source);if(!byKey){byKey=new Map();packedTargets.set(source,byKey);}
  const cached=byKey.get(key);if(cached)return cached;
  const n=source.triangles.length,vertices=new Float64Array(n*9),normals=new Float64Array(n*3),uv=new Float64Array(n*6);
  const transform=placement?.transform,mirrored=(transform?.scale??[1,1,1]).filter(s=>s<0).length%2===1;
  const placed=source.points.map(p=>transform?transformPosition3(p.position,transform):p.position);
  let chart=true;
  for(let i=0;i<n;i++){
    const t=source.triangles[i],[a,b,c]=t.vertices.map(v=>placed[v]);
    for(let k=0;k<3;k++){vertices[i*9+k]=a[k];vertices[i*9+3+k]=b[k];vertices[i*9+6+k]=c[k];}
    const normal=geometricNormal(sub3(b,a),sub3(c,a));
    for(let k=0;k<3;k++)normals[i*3+k]=normal[k]===0?0:mirrored?-normal[k]:normal[k];
    if(chart){
      const face=source.faces[t.face],corners=triangleCorners3(source,i).map(ci=>face.corners?.[ci]?.attributes[uvAttribute]);
      if(corners.every(v=>Array.isArray(v)&&v.length===2&&v.every(Number.isFinite)))corners.forEach((v,j)=>{uv[i*6+j*2]=(v as number[])[0];uv[i*6+j*2+1]=(v as number[])[1];});
      else chart=false;
    }
  }
  const packed=Object.freeze({source,placement,triangles:n,vertices,normals,uv:chart&&n?uv:undefined,uvAttribute});
  if(byKey.size>=4)byKey.delete(byKey.keys().next().value!);
  byKey.set(key,packed);return packed;
}
export function validateEvaluationBatch3(packed:PackedSurfaceTarget3,batch:SurfaceEvaluationBatch3):number {
  const n=batch.triangle.length;
  if(!(batch.triangle instanceof Uint32Array)||!(batch.weights instanceof Float32Array)||batch.weights.length!==n*3)throw new Error('surface evaluation batch requires one triangle index and three weights per location');
  for(let i=0;i<n;i++){
    if(batch.triangle[i]>=packed.triangles)throw new Error('surface evaluation location names a missing triangle');
    const w0=batch.weights[i*3],w1=batch.weights[i*3+1],w2=batch.weights[i*3+2];
    if(!(w0>=0&&w1>=0&&w2>=0)||Math.abs(w0+w1+w2-1)>1e-5)throw new Error('surface evaluation weights must be nonnegative and sum to one');
  }
  return n;
}
/** Evaluate one location directly from the packed arrays into typed outputs. */
export function evaluateLocation3(packed:PackedSurfaceTarget3,batch:SurfaceEvaluationBatch3,i:number,recipe:ToneRecipe3|undefined,out:{position:Float32Array;normal:Float32Array;uv?:Float32Array;tone?:Float32Array}):void {
  const t=batch.triangle[i],w1=batch.weights[i*3+1],w2=batch.weights[i*3+2],v=packed.vertices,o=t*9;
  for(let k=0;k<3;k++){
    const a=v[o+k];
    out.position[i*3+k]=a+(v[o+3+k]-a)*w1+(v[o+6+k]-a)*w2;
    out.normal[i*3+k]=packed.normals[t*3+k];
  }
  let uv:readonly [number,number]|undefined;
  if(packed.uv){
    const w0=batch.weights[i*3],u=packed.uv,q=t*6;
    uv=[u[q]*w0+u[q+2]*w1+u[q+4]*w2,u[q+1]*w0+u[q+3]*w1+u[q+5]*w2];
    if(out.uv){out.uv[i*2]=uv[0];out.uv[i*2+1]=uv[1];}
  }
  if(recipe&&out.tone){
    if(recipe.kind==='light'){
      const normal=recipe.space==='model'?modelNormal(packed,t):[packed.normals[t*3],packed.normals[t*3+1],packed.normals[t*3+2]] as Vec3;
      out.tone[i]=lightTone3(normal,recipe);
    }else{
      // A location with no chart coordinates reads as unpainted.
      out.tone[i]=uv?imageValue3(uv,recipe):0;
    }
  }
}
const modelNormals=new WeakMap<PackedSurfaceTarget3,Float64Array>();
function modelNormal(packed:PackedSurfaceTarget3,t:number):Vec3 {
  let cache=modelNormals.get(packed);
  if(!cache){
    if(!packed.placement)cache=packed.normals;
    else{
      const s=packed.source;cache=new Float64Array(packed.triangles*3);
      s.triangles.forEach((tri,i)=>{const [a,b,c]=tri.vertices.map(v=>s.points[v].position),n=geometricNormal(sub3(b,a),sub3(c,a));for(let k=0;k<3;k++)cache![i*3+k]=n[k];});
    }
    modelNormals.set(packed,cache);
  }
  return [cache[t*3],cache[t*3+1],cache[t*3+2]];
}
/** Reference implementation: identical formulas to surface locations and the
 * tone module, evaluated as plain arrays without per-location objects. */
export function evaluateSurfaceCpu3(target:SurfaceEvaluationTarget3,batch:SurfaceEvaluationBatch3,recipe?:ToneRecipe3):SurfaceEvaluationResult3 {
  const timing=new PhaseClock3(),packed=timing.measure('packingMs',()=>packSurfaceTarget3(target));
  const n=validateEvaluationBatch3(packed,batch);
  const out={position:new Float32Array(n*3),normal:new Float32Array(n*3),uv:packed.uv?new Float32Array(n*2):undefined,tone:recipe?new Float32Array(n):undefined};
  timing.measure('cpuMs',()=>{for(let i=0;i<n;i++)evaluateLocation3(packed,batch,i,recipe,out);});
  return {position:out.position,normal:out.normal,uv:out.uv,tone:out.tone,stats:{backend:'cpu',dispatches:0,transferBytes:0,cacheHit:false,targetUploadBytes:0,refinements:0,timings:timing.finish()}};
}
/** Indices whose accept/reject decision lies within the shared quantum of its
 * threshold; the caller re-evaluates exactly those with the CPU reference. */
export function ambiguousTone3(tone:Float32Array,thresholds:Float32Array):Uint32Array {
  if(tone.length!==thresholds.length)throw new Error('tone and threshold arrays must have equal length');
  const found:number[]=[];
  for(let i=0;i<tone.length;i++)if(decideTone3(tone[i],thresholds[i])==='ambiguous')found.push(i);
  return Uint32Array.from(found);
}
