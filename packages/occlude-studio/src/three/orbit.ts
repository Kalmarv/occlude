import { cameraFrame3, type Camera3 } from 'occlude/src/three/camera.js';
import { add3, sub3, mul3, dot3, cross3, unit3, type Vec3 } from 'occlude/src/three/math.js';
const rotate = (v: Vec3, axis: Vec3, angle: number) => add3(add3(mul3(v,Math.cos(angle)),mul3(cross3(axis,v),Math.sin(angle))),mul3(axis,dot3(axis,v)*(1-Math.cos(angle))));
/** Orbit respects the captured up axis and never crosses its singular poles. */
export function orbitCamera3(camera: Camera3, yaw: number, pitch: number): Camera3 {
  if (![yaw,pitch].every(Number.isFinite)) throw new Error('invalid orbit');
  const frame = cameraFrame3(camera,{x:0,y:0,width:1,height:1}), up = unit3(camera.up ?? [0,0,1]);
  const delta = rotate(sub3(camera.eye,camera.target),up,yaw);
  const latitude = Math.asin(Math.max(-1,Math.min(1,dot3(unit3(delta),up))));
  const bounded = Math.max(-Math.PI/2+.001,Math.min(Math.PI/2-.001,latitude+pitch))-latitude;
  const right = rotate(frame.right,up,yaw);
  return {...camera,eye:add3(camera.target,rotate(delta,right,-bounded))};
}
export function zoomCamera3(camera: Camera3, factor: number): Camera3 {
  if (!Number.isFinite(factor) || factor <= 0) throw new Error('invalid zoom');
  const delta = sub3(camera.eye,camera.target), distance = Math.hypot(...delta);
  const ratio = Math.max(1e-9,Math.min(1e12,distance*factor))/distance;
  return camera.kind === 'orthographic' ? {...camera,span:Math.max(1e-9,Math.min(1e12,camera.span*factor))} : {...camera,eye:add3(camera.target,mul3(delta,ratio))};
}
