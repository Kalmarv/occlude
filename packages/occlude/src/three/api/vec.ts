import type {Vec3} from '../math.js';
import {surfaceGradient,type DirectionField,type ToneField} from '../surface/fields.js';
/** A number at every point of space, `(x, y, z) => …`: the 2D field
 * `(x, y) => …` with a third coordinate, and what `sdf3` makes. */
export type ScalarField3=(x:number,y:number,z:number)=>number;
/** A vector at every point of space, `(x, y, z) => [vx, vy, vz]`: what
 * `t.streamlines` follows when it takes (x, y, z). */
export type VectorField3=(x:number,y:number,z:number)=>Vec3;
/** A field of space takes its coordinates, as `sdf3` and every 2D field do.
 * A function of one point is the other spelling, refused by name; one that
 * declares no parameters (`() => [0, 0, 1]`) is a constant field. */
export function checkedField3(field:unknown,who:string):void {
  if(typeof field!=='function')throw new Error(`${who} requires a field of space, (x, y, z) => …`);
  if(field.length===1)throw new Error(`${who}: a field of space takes (x, y, z), as sdf3 and the 2D fields do — write (x, y, z) => …, not (p) => …`);
}
const sample=(value:unknown):number=>typeof value==='number'&&Number.isFinite(value)?value:Number.NaN;
/** A field's own answer, read without judgement: a sample it could not give
 * comes back as NaN and the caller decides what that means. */
const read=(value:unknown):Vec3=>{
  const p=Array.isArray(value)?value:[(value as {x?:unknown})?.x,(value as {y?:unknown})?.y,(value as {z?:unknown})?.z];
  return [sample(p[0]),sample(p[1]),sample(p[2])];
};
const spacing=(step:number|undefined):number=>Number.isFinite(step)&&(step as number)>0?step as number:1e-3;
/**
 * The gradient of a scalar field: the direction it rises fastest, as long as
 * its rise. One word for both 3D domains, read from the field's own
 * parameters, as a field says what it is by what it takes:
 *
 * - a field of space, `(x, y, z) => …`, by central differences; `step` is
 *   the distance the difference is taken over (1e-3 by default). Where the
 *   field has no value the gradient is zero, so a tracer stops there rather
 *   than following a NaN.
 * - a field of the surface, `(s) => …`, from its values at the three
 *   vertices of the current triangle: exact for the linear interpolant, a
 *   per-triangle estimate for anything else, and no direction where the
 *   field is constant. It has no step to choose.
 *
 * The 2D `grad` from `occlude` is the same word for a field of the plane.
 */
export function grad(scalar:ToneField):DirectionField;
export function grad(scalar:ScalarField3,options?:{step?:number}):VectorField3;
export function grad(scalar:ScalarField3|ToneField,options?:{step?:number}):VectorField3|DirectionField {
  if(typeof scalar==='function'&&scalar.length===1){
    if(options?.step!==undefined)throw new Error('grad: a surface field\'s gradient is exact on each triangle and takes no step; step is for a field of space, (x, y, z) => …');
    return surfaceGradient(scalar as ToneField);
  }
  checkedField3(scalar,'grad');
  const field=scalar as ScalarField3,h=spacing(options?.step);
  return (x,y,z)=>{
    const p:Vec3=[x,y,z],out=[0,0,0] as [number,number,number];
    for(let k=0;k<3;k++){
      const a=[...p] as [number,number,number],b=[...p] as [number,number,number];
      a[k]+=h;b[k]-=h;
      out[k]=(sample(field(...a))-sample(field(...b)))/(2*h);
    }
    return out.every(Number.isFinite)?out:[0,0,0];
  };
}
/** The curl of a vector field, by central differences: the axis it turns
 * about, as long as how fast. The curl of any field is divergence free, so
 * `curl3` of a vector potential is the flow word — streamlines of it neither
 * pile up nor thin out. */
export function curl3(field:VectorField3,options:{step?:number}={}):VectorField3 {
  checkedField3(field,'curl3');
  const h=spacing(options.step);
  return (x,y,z)=>{
    const p:Vec3=[x,y,z],d:Vec3[]=[];
    for(let k=0;k<3;k++){
      const a=[...p] as [number,number,number],b=[...p] as [number,number,number];
      a[k]+=h;b[k]-=h;
      const high=read(field(...a)),low=read(field(...b));
      d.push([(high[0]-low[0])/(2*h),(high[1]-low[1])/(2*h),(high[2]-low[2])/(2*h)]);
    }
    const out:Vec3=[d[1][2]-d[2][1],d[2][0]-d[0][2],d[0][1]-d[1][0]];
    return out.every(Number.isFinite)?out:[0,0,0];
  };
}
