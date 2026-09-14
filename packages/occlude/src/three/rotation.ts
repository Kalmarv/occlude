import {add3,sub3,mul3,dot3,cross3,finite3,type Vec3} from './math.js';
export type Vector3 = Vec3 | {readonly x:number;readonly y:number;readonly z:number};
export type Axis3 = 'x'|'y'|'z'|Vector3;
export type Quaternion3 = readonly [number,number,number,number];
/** Serializable rotation data; quaternion order is x,y,z,w. */
export interface RotationData {readonly kind:'rotation';readonly quaternion:Quaternion3}
export type RotationInput = Vec3|RotationData;
export function vector3(value:Vector3):Vec3 {
  const v=Array.isArray(value)?value:[(value as {x:number}).x,(value as {y:number}).y,(value as {z:number}).z];
  finite3(v as Vec3);return [...v] as unknown as Vec3;
}
function direction(value:Axis3):Vec3 {
  const v=typeof value==='string'?value==='x'?[1,0,0]:value==='y'?[0,1,0]:value==='z'?[0,0,1]:undefined:vector3(value);
  if(!v)throw new Error('rotation axis must be x, y, z or a nonzero direction');
  const scale=Math.max(...v.map(Math.abs));if(!(scale>0))throw new Error('rotation direction must be nonzero');
  const scaled=v.map(n=>n/scale) as unknown as Vec3;return mul3(scaled,1/Math.hypot(...scaled));
}
function degrees(value:number):number {if(!Number.isFinite(value))throw new Error('rotation angle must be finite degrees');return (value%360)*Math.PI/180;}
function multiply(a:Quaternion3,b:Quaternion3):Quaternion3 {
  const [x,y,z,w]=a,[u,v,s,t]=b;return [w*u+x*t+y*s-z*v,w*v-x*s+y*t+z*u,w*s+x*v-y*u+z*t,w*t-x*u-y*v-z*s];
}
/** Rotation values compose in application order: a.then(b) applies a, then b. */
export class Rotation implements RotationData {
  readonly kind='rotation' as const;
  readonly quaternion:Quaternion3;
  constructor(value:Quaternion3){
    if(!Array.isArray(value)||value.length!==4||!value.every(Number.isFinite))throw new Error('rotation quaternion must contain four finite numbers');
    const scale=Math.max(...value.map(Math.abs));if(!(scale>0))throw new Error('rotation quaternion must be nonzero');
    const q=value.map(v=>v/scale),length=Math.hypot(...q),sign=(q[3]||q[0]||q[1]||q[2])<0?-1:1;
    this.quaternion=Object.freeze(q.map(v=>v*sign/length)) as unknown as Quaternion3;Object.freeze(this);
  }
  apply(value:Vector3):Vec3 {
    const v=vector3(value),[x,y,z,w]=this.quaternion,u:Vec3=[x,y,z],t=mul3(cross3(u,v),2);
    return add3(v,add3(mul3(t,w),cross3(u,t)));
  }
  then(next:RotationInput):Rotation{return new Rotation(multiply(rotation3(next).quaternion,this.quaternion));}
  inverse():Rotation{const [x,y,z,w]=this.quaternion;return new Rotation([-x,-y,-z,w]);}
}
export function rotation3(value:RotationInput):Rotation {
  if(value instanceof Rotation)return value;
  if(Array.isArray(value)){
    finite3(value as Vec3);let result=new Rotation([0,0,0,1]);
    for(const [i,axis] of (['x','y','z'] as const).entries())result=result.then(axisAngle(axis,value[i]));
    return result;
  }
  if(!value||typeof value!=='object'||(value as RotationData).kind!=='rotation')throw new Error('rotation requires Euler degrees or rotation data');
  return new Rotation((value as RotationData).quaternion);
}
export function axisAngle(axis:Axis3,angle:number):Rotation {
  const unit=direction(axis),half=degrees(angle)/2,s=Math.sin(half);
  return new Rotation([unit[0]*s,unit[1]*s,unit[2]*s,Math.cos(half)]);
}
/** Choose a reference from the fixed local axis, never the changing target. */
function perpendicular(axis:Vec3):Vec3 {
  const index=[0,1,2].sort((a,b)=>Math.abs(axis[a])-Math.abs(axis[b]))[0];
  const ref:Vec3=[index===0?1:0,index===1?1:0,index===2?1:0];
  return direction(sub3(ref,mul3(axis,dot3(axis,ref))));
}
function shortest(from:Vec3,to:Vec3,antipodal:Vec3):Rotation {
  const cross=cross3(from,to),s=Math.hypot(...cross),c=Math.max(-1,Math.min(1,dot3(from,to)));
  if(s===0)return c<0?new Rotation([...direction(antipodal),0]):new Rotation([0,0,0,1]);
  // Choose the well-conditioned half-angle branch. Keep tiny transverse
  // components even when dot rounds to +/-1, without dividing by tiny s first.
  if(c>=0){const w=Math.sqrt((1+c)/2);return new Rotation([cross[0]/(2*w),cross[1]/(2*w),cross[2]/(2*w),w]);}
  const sine=Math.sqrt((1-c)/2);
  return new Rotation([cross[0]/s*sine,cross[1]/s*sine,cross[2]/s*sine,s/(2*sine)]);
}
export interface AlignAxisOptions {
  /** World reference; projected perpendicular to the aligned direction. */
  readonly up?:Vector3;
  /** Local direction corresponding to up; default is a fixed perpendicular. */
  readonly localUp?:Vector3;
  /** Additional right-handed turn around the resulting world direction. */
  readonly twist?:number;
  /** Transport an existing orientation by the shortest change of direction. */
  readonly previous?:RotationInput;
}
function projected(value:Vector3,axis:Vec3,label:string):Vec3 {
  const v=direction(value),t=cross3(axis,cross3(v,axis));
  if(Math.hypot(...cross3(v,axis))===0)throw new Error(`${label} must not be parallel to the aligned axis`);
  return direction(t);
}
export function alignAxis(axis:Axis3,target:Vector3,options:AlignAxisOptions={}):Rotation {
  if(!options||typeof options!=='object'||Array.isArray(options))throw new Error('alignment options must be an object');
  const local=direction(axis),world=direction(target),reference=options.localUp?projected(options.localUp,local,'localUp'):perpendicular(local);
  if(options.localUp&&!options.up)throw new Error('localUp requires a world up reference');
  if(options.up&&options.previous)throw new Error('alignment uses either an up reference or previous orientation');
  let result:Rotation;
  if(options.previous){const previous=rotation3(options.previous);result=previous.then(shortest(direction(previous.apply(local)),world,previous.apply(reference)));}
  else result=shortest(local,world,reference);
  if(options.up){
    const from=projected(result.apply(reference),world,'rotated reference'),to=projected(options.up,world,'up');
    result=result.then(axisAngle(world,Math.atan2(dot3(world,cross3(from,to)),dot3(from,to))*180/Math.PI));
  }
  if(options.twist!==undefined)result=result.then(axisAngle(world,options.twist));
  return result;
}
/** Preserve legacy Euler arithmetic, while applying rotation values directly. */
export function rotateVector3(value:Vec3,input:RotationInput):Vec3 {
  if(!Array.isArray(input))return rotation3(input).apply(value);
  finite3(input as Vec3);let v=value;
  for(let axis=0;axis<3;axis++){const angle=input[axis]*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle),a=(axis+1)%3,b=(axis+2)%3,next=[...v];next[a]=c*v[a]-s*v[b];next[b]=s*v[a]+c*v[b];v=next as unknown as Vec3;}
  return v;
}
