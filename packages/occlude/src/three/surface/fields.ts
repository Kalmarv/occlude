import type {SurfaceLocation3} from '../geometry/location.js';
import type {Surface3} from '../geometry/surface.js';
import {surfaceLocation3,captureSurfacePlacement3} from '../geometry/location.js';
import {estimateCurvature3,curvatureAt3,type CurvatureOptions3} from '../geometry/curvature.js';
import {rotateVector3,rotation3,vector3,type RotationInput,type Vector3} from '../rotation.js';
import {add3,sub3,mul3,dot3,cross3,type Vec3} from '../math.js';
import {clampSetting,sampleValue} from '../degenerate.js';
import {lightRecipe3,lightTone3,imageValue3,registerToneRecipe3,toneRecipe3} from './tone.js';
import {falloff} from '../api/vec.js';

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
  if(!Array.isArray(input)||input.length!==3||!input.every(n=>typeof n==='number'))throw new Error('direction must be a nonzero finite vector or a surface field');
  // A vector with no direction points nowhere: the field reports no direction,
  // which every consumer already reads as "stop or fall back".
  if(!input.every(Number.isFinite)||!input.some(n=>n!==0))return ()=>null;
  const constant=Object.freeze([...input]) as unknown as Vec3;return ()=>constant;
}
export function toneField(input:ToneInput):ToneField {
  if(typeof input==='function')return input;
  const tone=clampSetting(input,0,1,0,'tone');return ()=>tone;
}
/** Explicit directional light as a tone field: 0 facing the light, up to
 * 1 - ambient facing away. `direction` points toward the light. There is no
 * hidden camera light; a view-dependent light is an explicit input. */
export function light(options:Parameters<typeof lightRecipe3>[0]):ToneField {
  const recipe=lightRecipe3(options);
  return registerToneRecipe3((s:SurfaceLocation3)=>lightTone3(recipe.space==='model'?s.modelNormal:s.normal,recipe),recipe);
}
export interface LampFalloff {
  /** Distance at which the lamp gives nothing. */
  readonly radius:number;
  /** Shape of the fade between the lamp and its radius; linear by default. */
  readonly ease?:(t:number)=>number;
}
export interface LampOptions {
  readonly position:Vector3;
  /** Light on a surface turned away from the lamp, 0..1 (0.15 by default). */
  readonly ambient?:number;
  /** Distance fade. Without it the lamp reaches everywhere. */
  readonly falloff?:LampFalloff;
}
/** A lamp at a place, as a tone field: the `light` formula with a direction
 * that changes over the surface, times a distance fade. A face turned toward
 * the lamp is 0 (light, no hatch) and one turned away reaches 1 - ambient, so
 * two objects either side of a lamp turn away from each other.
 *
 * Evaluated on the CPU: its direction is per point, so it is not one of the
 * batched recipes `light` and surface images are. */
export function lamp(options:LampOptions):ToneField {
  if(!options||typeof options!=='object'||Array.isArray(options))throw new Error('lamp requires its options');
  const position=vector3(options.position);
  const ambient=clampSetting(options.ambient,0,1,0.15,'lamp ambient');
  const reach=options.falloff;
  if(reach!==undefined&&(!reach||typeof reach!=='object'||Array.isArray(reach)))throw new Error('lamp falloff requires { radius, ease? }');
  if(reach?.ease!==undefined&&typeof reach.ease!=='function')throw new Error('lamp falloff ease must be a function');
  return (s:SurfaceLocation3)=>{
    const to=sub3(position,s.position),distance=Math.hypot(...to);
    // A lamp sitting exactly on the surface lights that point fully: there is
    // no direction left to measure an angle against.
    const cosine=distance>0?Math.max(0,dot3(s.normal,mul3(to,1/distance))):1;
    const fade=reach?falloff(s.position,{center:position,radius:reach.radius,ease:reach.ease}):1;
    const illumination=ambient+(1-ambient)*cosine*sampleValue(fade,0);
    return Math.min(1,Math.max(0,1-illumination));
  };
}
/** What an environment is read with: a direction, or the sampler
 * `t.image(name).surface(...)` gives, which is read by the same directions
 * mapped to its chart. */
export type EnvironmentSampler=((direction:Vec3)=>number)|ToneField;
export interface EnvironmentOptions {
  /** Turn the surroundings: the sampler is read through the inverse, so
   * rotating the environment moves what each face sees. */
  readonly orientation?:RotationInput;
}
/** The light a surface sees from the world around it, by the direction its
 * normal points. The sampler gives the light arriving from a direction and the
 * tone is its complement, so a bright sky above makes up-facing surfaces pale
 * and leaves the undersides dark.
 *
 * An image sampler is read equirectangularly: u is the longitude around Z from
 * +X, v the latitude, 0 at -Z and 1 at +Z. Any other function is called with
 * the unit direction itself. Evaluated on the CPU. */
export function environment(sampler:(direction:Vec3)=>number,options?:EnvironmentOptions):ToneField;
export function environment(sampler:ToneField,options?:EnvironmentOptions):ToneField;
export function environment(sampler:EnvironmentSampler,options:EnvironmentOptions={}):ToneField {
  if(typeof sampler!=='function')throw new Error('environment requires an image surface sampler or a function of a direction');
  if(!options||typeof options!=='object'||Array.isArray(options))throw new Error('environment requires its options');
  const turn=options.orientation===undefined?undefined:rotation3(options.orientation).inverse();
  const recipe=toneRecipe3(sampler);
  const image=recipe?.kind==='image'?recipe:undefined;
  return (s:SurfaceLocation3)=>{
    const normal=s.normal,length=Math.hypot(...normal);
    if(!(length>0))return 1;
    const raw=mul3(normal,1/length),direction=turn?turn.apply(raw):raw;
    const value=image
      ? imageValue3([((Math.atan2(direction[1],direction[0])/(2*Math.PI))%1+1)%1,.5+Math.asin(Math.max(-1,Math.min(1,direction[2])))/Math.PI],image)
      : (sampler as (d:Vec3)=>number)(direction);
    return 1-Math.min(1,Math.max(0,sampleValue(value,0)));
  };
}
// Keyed by the captured placement object, whose identity changes with its
// transform revision (captureSurfacePlacement3), never by its string id: an
// instance that turns keeps its id but not its gradients.
const gradients=new WeakMap<(s:SurfaceLocation3)=>number,WeakMap<Surface3,WeakMap<object,Map<number,Vec3|null>>>>();
/** Gradient of a scalar field, taken from its values at the three vertices of
 * the current triangle: exact for the linear interpolant, a per-triangle
 * estimate for anything else. Zero where the field is constant. */
export function gradient(scalar:(s:SurfaceLocation3)=>number):DirectionField {
  if(typeof scalar!=='function')throw new Error('gradient requires a scalar surface field');
  let bySurface=gradients.get(scalar);if(!bySurface){bySurface=new WeakMap();gradients.set(scalar,bySurface);}
  return s=>{
    let byPlacement=bySurface!.get(s.source);if(!byPlacement){byPlacement=new WeakMap();bySurface!.set(s.source,byPlacement);}
    const key:object=captureSurfacePlacement3(s.placement)??s.source;let cache=byPlacement.get(key);if(!cache){cache=new Map();byPlacement.set(key,cache);}
    const found=cache.get(s.triangle);if(found!==undefined)return found;
    const corners=[[1,0,0],[0,1,0],[0,0,1]].map(w=>surfaceLocation3(s.source,s.triangle,w as unknown as Vec3,{placement:s.placement}));
    // A triangle the field could not answer has no gradient there, the same
    // "no direction" a constant field gives.
    const values=corners.map(c=>sampleValue(scalar(c),NaN));
    if(!values.every(Number.isFinite)){cache.set(s.triangle,null);return null;}
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
  const minConfidence=clampSetting(options.minConfidence,0,1,0.15,'curvature minConfidence');
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
