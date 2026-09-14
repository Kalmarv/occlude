import type {SurfaceLocation3} from '../geometry/location.js';
import type {Surface3} from '../geometry/surface.js';
import {surfaceLocation3} from '../geometry/location.js';
import {estimateCurvature3,curvatureAt3,type CurvatureOptions3} from '../geometry/curvature.js';
import {rotateVector3} from '../rotation.js';
import {add3,sub3,mul3,dot3,cross3,type Vec3} from '../math.js';
import {lightRecipe3,lightTone3,registerToneRecipe3} from './tone.js';

/** A direction over the surface. The tracer projects the result onto the
 * actual tangent plane; `null` means "no direction here" (stop or fall back).
 * `previous` is the direction the trace arrived with, so unoriented fields can
 * choose their sign consistently. */
export type DirectionField=(s:SurfaceLocation3,previous?:Vec3)=>Vec3|null|undefined;
/** A constant world vector is projected onto each tangent plane. */
export type DirectionInput=Vec3|DirectionField;
export type ToneField=(s:SurfaceLocation3)=>number;
export type ToneInput=number|ToneField;

export function directionField(input:DirectionInput):DirectionField {
  if(typeof input==='function')return input;
  if(!Array.isArray(input)||input.length!==3||!input.every(Number.isFinite)||!input.some(n=>n!==0))throw new Error('direction must be a nonzero finite vector or a surface field');
  const constant=Object.freeze([...input]) as unknown as Vec3;return ()=>constant;
}
export function toneField(input:ToneInput):ToneField {
  if(typeof input==='function')return input;
  if(!Number.isFinite(input)||input<0||input>1)throw new Error('tone must be a number in [0,1] or a surface field');
  return ()=>input;
}
/** Explicit directional light as a tone field: 0 facing the light, up to
 * 1 - ambient facing away. `direction` points toward the light. There is no
 * hidden camera light; a view-dependent light is an explicit input. */
export function light(options:{direction:Vec3;ambient?:number;ramp?:'linear'|'smooth';space?:'world'|'model'}):ToneField {
  const recipe=lightRecipe3(options);
  return registerToneRecipe3((s:SurfaceLocation3)=>lightTone3(recipe.space==='model'?s.modelNormal:s.normal,recipe),recipe);
}
const gradients=new WeakMap<(s:SurfaceLocation3)=>number,WeakMap<Surface3,Map<string,Map<number,Vec3|null>>>>();
/** Gradient of a scalar field, taken from its values at the three vertices of
 * the current triangle: exact for the linear interpolant, a per-triangle
 * estimate for anything else. Zero where the field is constant. */
export function gradient(scalar:(s:SurfaceLocation3)=>number):DirectionField {
  if(typeof scalar!=='function')throw new Error('gradient requires a scalar surface field');
  let bySurface=gradients.get(scalar);if(!bySurface){bySurface=new WeakMap();gradients.set(scalar,bySurface);}
  return s=>{
    let byPlacement=bySurface!.get(s.source);if(!byPlacement){byPlacement=new Map();bySurface!.set(s.source,byPlacement);}
    const key=s.placement?.id??'';let cache=byPlacement.get(key);if(!cache){cache=new Map();byPlacement.set(key,cache);}
    const found=cache.get(s.triangle);if(found!==undefined)return found;
    const corners=[[1,0,0],[0,1,0],[0,0,1]].map(w=>surfaceLocation3(s.source,s.triangle,w as unknown as Vec3,{placement:s.placement}));
    const values=corners.map(c=>{const v=scalar(c);if(!Number.isFinite(v))throw new Error('gradient scalar field must return finite numbers');return v;});
    const [a,b,c]=corners.map(c=>c.position),e1=sub3(b,a),e2=sub3(c,a),f1=values[1]-values[0],f2=values[2]-values[0];
    const g11=dot3(e1,e1),g12=dot3(e1,e2),g22=dot3(e2,e2),det=g11*g22-g12*g12;
    let value:Vec3|null=null;
    if(det>0&&Number.isFinite(det)){
      const alpha=(f1*g22-f2*g12)/det,beta=(f2*g11-f1*g12)/det,g=add3(mul3(e1,alpha),mul3(e2,beta));
      value=g.some(n=>n!==0)&&g.every(Number.isFinite)?Object.freeze(g) as Vec3:null;
    }
    cache.set(s.triangle,value);return value;
  };
}
/** Estimated principal curvature direction as an unoriented line field. The
 * sign follows the arriving direction; below `minConfidence` (umbilic or flat
 * regions, default 0.15) the field reports no direction so the caller's
 * fallback or termination policy applies. Directions are estimated on the
 * represented mesh and expressed in the location's space. */
export function curvature(which:'min'|'max',options:CurvatureOptions3&{minConfidence?:number}={}):DirectionField {
  if(which!=='min'&&which!=='max')throw new Error("curvature direction must be 'min' or 'max'");
  const minConfidence=options.minConfidence??0.15;
  if(!Number.isFinite(minConfidence)||minConfidence<0||minConfidence>1)throw new Error('curvature minConfidence must lie in [0,1]');
  const settings={smoothing:options.smoothing,creaseDegrees:options.creaseDegrees};
  return (s,previous)=>{
    const sample=curvatureAt3(estimateCurvature3(s.source,settings),s.triangle,s.barycentric);
    if(sample.confidence<minConfidence)return null;
    let d:Vec3=sample[which];
    if(s.placement){
      const t=s.placement.transform,scale=t.scale??[1,1,1];
      d=rotateVector3(d.map((n,i)=>n*scale[i]) as unknown as Vec3,t.rotate??[0,0,0]);
      d=sub3(d,mul3(s.normal,dot3(d,s.normal)));
      const length=Math.hypot(...d);if(!(length>0))return null;d=mul3(d,1/length);
    }
    if(previous&&dot3(d,previous)<0)d=mul3(d,-1);
    return d;
  };
}
/** Perpendicular to another direction field within the tangent plane: the
 * natural second crosshatch family. */
export function across(input:DirectionInput):DirectionField {
  const field=directionField(input);
  return (s,previous)=>{
    const d=field(s,previous&&cross3(previous,s.normal));if(!d)return d;
    const p=cross3(s.normal,d);return p.some(n=>n!==0)?p:null;
  };
}
