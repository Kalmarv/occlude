import {add3,sub3,mul3,dot3,cross3,lerp3,unit3,type Vec3} from '../math.js';
import type {Vector3} from '../rotation.js';
import {emptySize} from '../degenerate.js';
import {vector3} from '../rotation.js';
const v=(p:Vector3):Vec3=>vector3(p);
/** Small vector vocabulary for fields and placements: triples or `{x, y, z}` rows in, fresh triples out. */
export const v3={
  add:(a:Vector3,b:Vector3):Vec3=>add3(v(a),v(b)),
  sub:(a:Vector3,b:Vector3):Vec3=>sub3(v(a),v(b)),
  scale:(a:Vector3,k:number):Vec3=>mul3(v(a),k),
  dot:(a:Vector3,b:Vector3):number=>dot3(v(a),v(b)),
  cross:(a:Vector3,b:Vector3):Vec3=>cross3(v(a),v(b)),
  length:(a:Vector3):number=>Math.hypot(...v(a)),
  distance:(a:Vector3,b:Vector3):number=>Math.hypot(...sub3(v(a),v(b))),
  normalize:(a:Vector3):Vec3=>unit3(v(a)),
  lerp:(a:Vector3,b:Vector3,t:number):Vec3=>lerp3(v(a),v(b),t),
  mix:(a:Vector3,b:Vector3,t:number):Vec3=>lerp3(v(a),v(b),t),
};
/** 1 at `center`, 0 at `radius` and beyond, linear or eased in between. */
export function falloff(point:Vector3,options:{center?:Vector3;radius:number;ease?:(t:number)=>number}):number {
  // No radius is no reach: the falloff is zero everywhere rather than failing.
  const {radius}=options;
  const t=emptySize(radius)?0:Math.max(0,1-v3.distance(point,options.center??[0,0,0])/radius);
  return options.ease?options.ease(t):t;
}
