import {add3,sub3,mul3,dot3,cross3,lerp3,unit3,type Vec3} from '../math.js';
import type {Vector3} from '../rotation.js';
import {emptySize} from '../degenerate.js';
import {vector3} from '../rotation.js';
const v=(p:Vector3):Vec3=>vector3(p);
/** How long a vector is: a triple or an `{x, y, z}` row, so a mesh point row measures directly. The 3D twin of `length` from `occlude`. */
export const length=(v:Vector3):number=>Math.hypot(...vector3(v));
/** How far apart two points are: triples or `{x, y, z}` rows. The 3D twin of `distance` from `occlude`. */
export const distance=(a:Vector3,b:Vector3):number=>Math.hypot(...sub3(v(a),v(b)));
/** Small vector vocabulary for fields and placements: triples or `{x, y, z}` rows in, fresh triples out. */
export const v3={
  add:(a:Vector3,b:Vector3):Vec3=>add3(v(a),v(b)),
  sub:(a:Vector3,b:Vector3):Vec3=>sub3(v(a),v(b)),
  scale:(a:Vector3,k:number):Vec3=>mul3(v(a),k),
  dot:(a:Vector3,b:Vector3):number=>dot3(v(a),v(b)),
  cross:(a:Vector3,b:Vector3):Vec3=>cross3(v(a),v(b)),
  length,
  distance,
  normalize:(a:Vector3):Vec3=>unit3(v(a)),
  lerp:(a:Vector3,b:Vector3,t:number):Vec3=>lerp3(v(a),v(b),t),
  mix:(a:Vector3,b:Vector3,t:number):Vec3=>lerp3(v(a),v(b),t),
};
/** A vector at every point of space: what `t.streamlines3` follows. */
export type VectorField3=(point:Vec3)=>Vec3;
const sample=(value:unknown):number=>typeof value==='number'&&Number.isFinite(value)?value:Number.NaN;
/** A field's own answer, read without judgement: a sample it could not give
 * comes back as NaN and the caller decides what that means. */
const read=(value:unknown):Vec3=>{
  const p=Array.isArray(value)?value:[(value as {x?:unknown})?.x,(value as {y?:unknown})?.y,(value as {z?:unknown})?.z];
  return [sample(p[0]),sample(p[1]),sample(p[2])];
};
const spacing=(step:number|undefined):number=>Number.isFinite(step)&&(step as number)>0?step as number:1e-3;
/** The gradient of a scalar field, by central differences: the direction it
 * rises fastest, as long as its rise. `step` is the distance the difference is
 * taken over (1e-3 by default). Where the field has no value the gradient is
 * zero, so a tracer stops there rather than following a NaN. */
export function grad3(scalar:(point:Vec3)=>number,options:{step?:number}={}):VectorField3 {
  if(typeof scalar!=='function')throw new Error('grad3 requires a scalar field of a 3D point');
  const h=spacing(options.step);
  return point=>{
    const p=vector3(point),out=[0,0,0] as [number,number,number];
    for(let k=0;k<3;k++){
      const a=[...p] as [number,number,number],b=[...p] as [number,number,number];
      a[k]+=h;b[k]-=h;
      out[k]=(sample(scalar(a))-sample(scalar(b)))/(2*h);
    }
    return out.every(Number.isFinite)?out:[0,0,0];
  };
}
/** The curl of a vector field, by central differences: the axis it turns
 * about, as long as how fast. The curl of any field is divergence free, so
 * `curl3` of a vector potential is the flow word — streamlines of it neither
 * pile up nor thin out. */
export function curl3(field:VectorField3,options:{step?:number}={}):VectorField3 {
  if(typeof field!=='function')throw new Error('curl3 requires a vector field of a 3D point');
  const h=spacing(options.step);
  return point=>{
    const p=vector3(point),d:Vec3[]=[];
    for(let k=0;k<3;k++){
      const a=[...p] as [number,number,number],b=[...p] as [number,number,number];
      a[k]+=h;b[k]-=h;
      const high=read(field(a)),low=read(field(b));
      d.push([(high[0]-low[0])/(2*h),(high[1]-low[1])/(2*h),(high[2]-low[2])/(2*h)]);
    }
    const out:Vec3=[d[1][2]-d[2][1],d[2][0]-d[0][2],d[0][1]-d[1][0]];
    return out.every(Number.isFinite)?out:[0,0,0];
  };
}
/** 1 at `center`, 0 at `radius` and beyond, linear or eased in between. */
export function falloff(point:Vector3,options:{center?:Vector3;radius:number;ease?:(t:number)=>number}):number {
  // No radius is no reach: the falloff is zero everywhere rather than failing.
  const {radius}=options;
  const t=emptySize(radius)?0:Math.max(0,1-v3.distance(point,options.center??[0,0,0])/radius);
  return options.ease?options.ease(t):t;
}
