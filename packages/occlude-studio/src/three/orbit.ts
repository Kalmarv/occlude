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
/** Half the visible height at the target plane, in world units. */
export function viewHalfHeight3(camera: Camera3): number {
  return camera.kind === 'orthographic' ? camera.span/2 : Math.hypot(...sub3(camera.eye,camera.target))*Math.tan(camera.fovDegrees*Math.PI/360);
}
/** Blender pan: eye and target slide together in the view plane. `dx`/`dy`
 * are fractions of the visible height (screen right and screen up). */
export function panCamera3(camera: Camera3, dx: number, dy: number): Camera3 {
  if (![dx,dy].every(Number.isFinite)) throw new Error('invalid pan');
  const frame = cameraFrame3(camera,{x:0,y:0,width:1,height:1}), h = viewHalfHeight3(camera)*2;
  const move = add3(mul3(frame.right,-dx*h),mul3(frame.up,-dy*h));
  return {...camera,eye:add3(camera.eye,move),target:add3(camera.target,move)};
}
export type ViewPreset3 = 'front'|'back'|'right'|'left'|'top'|'bottom';
/** Blender numpad views: front looks along +Y, right along -X, top along -Z.
 * Distance, target and the up axis are kept (turntable orbit stays about the
 * world up afterwards); top and bottom sit just inside the orbit's pole
 * margin toward the front, so screen up is +Y as in Blender. */
export function presetCamera3(camera: Camera3, view: ViewPreset3): Camera3 {
  const distance = Math.hypot(...sub3(camera.eye,camera.target)), up = unit3(camera.up ?? [0,0,1]);
  const front: Vec3 = Math.abs(up[1]) < .9 ? [0,-1,0] : [0,0,-1];
  const side = unit3(cross3(mul3(front,-1),up)); // screen right of the front view: forward × up
  const tilt = .001;
  const directions: Record<ViewPreset3, Vec3 | undefined> = {
    front, back: mul3(front,-1), right: side, left: mul3(side,-1),
    top: add3(mul3(up,Math.cos(tilt)),mul3(front,Math.sin(tilt))), bottom: add3(mul3(up,-Math.cos(tilt)),mul3(front,Math.sin(tilt))),
  };
  const from = directions[view];
  if (!from) throw new Error('unknown view preset');
  const result: Camera3 = {...camera,eye:add3(camera.target,mul3(unit3(from),distance))};
  cameraFrame3(result,{x:0,y:0,width:1,height:1});
  return result;
}
/** Frame world bounds: look at their center from the current direction, at a
 * distance/span that fits their bounding sphere with a small margin. Clipping
 * distances follow the eye so the whole sphere stays inside them. */
export function fitCamera3(camera: Camera3, bounds: { min: Vec3; max: Vec3 }, aspect = 1): Camera3 {
  const center = mul3(add3(bounds.min,bounds.max),.5), radius = Math.max(1e-9,Math.hypot(...sub3(bounds.max,bounds.min))/2);
  const direction = unit3(sub3(camera.eye,camera.target));
  if (!Number.isFinite(aspect) || aspect <= 0) throw new Error('invalid aspect');
  const margin = 1.1, fitRadius = radius*margin/Math.min(1,aspect);
  if (camera.kind === 'orthographic') {
    const distance = Math.max(radius*2,Math.hypot(...sub3(camera.eye,camera.target)));
    return {...camera,target:center,eye:add3(center,mul3(direction,distance)),span:2*fitRadius,near:Math.max(1e-6,distance-radius*2),far:distance+radius*2};
  }
  const distance = fitRadius/Math.sin(camera.fovDegrees*Math.PI/360);
  return {...camera,target:center,eye:add3(center,mul3(direction,distance)),near:Math.max(1e-6,distance-radius*2),far:distance+radius*2};
}

/** Switch projection at the target-plane scale. Start at 45° perspective FOV;
 * narrow it if necessary to preserve the existing near-distance precision.
 * Shift clipping distances with the eye so their world-space planes stay put. */
export function switchProjection3(camera: Camera3, kind: Camera3['kind']): Camera3 {
  cameraFrame3(camera,{x:0,y:0,width:1,height:1});
  if(camera.kind===kind)return camera;
  const delta=sub3(camera.eye,camera.target),oldDistance=Math.hypot(...delta);
  if(kind==='orthographic'){
    const {fovDegrees,...base}=camera as Extract<Camera3,{kind:'perspective'}>;
    return {...base,kind,span:2*oldDistance*Math.tan(fovDegrees*Math.PI/360)};
  }
  const {span,...base}=camera as Extract<Camera3,{kind:'orthographic'}>;
  const distance=Math.max(span/(2*Math.tan(Math.PI/8)),oldDistance);
  const shift=distance-oldDistance;
  const result:Camera3={...base,kind:'perspective',fovDegrees:Math.atan(span/(2*distance))*360/Math.PI,
    eye:add3(camera.target,mul3(delta,distance/oldDistance)),near:camera.near+shift,far:camera.far+shift};
  cameraFrame3(result,{x:0,y:0,width:1,height:1});
  return result;
}

/** The same camera, field for field: kind, eye, target, up and span or field of view. */
export function sameCamera3(a: Camera3 | undefined, b: Camera3 | undefined): boolean {
  if (!a || !b || a.kind !== b.kind) return false;
  const same3 = (p: Vec3 | undefined, q: Vec3 | undefined) => p === q || (!!p && !!q && p.every((v, i) => v === q[i]));
  if (!same3(a.eye, b.eye) || !same3(a.target, b.target) || !same3(a.up ?? [0,0,1], b.up ?? [0,0,1])) return false;
  return a.kind === 'orthographic' ? a.span === (b as typeof a).span : a.fovDegrees === (b as typeof a).fovDegrees;
}
/** The explored (orbited, uncommitted) camera of each scene survives a
 * rerender while the sketch's own camera for that scene is unchanged, so
 * parameters can be explored from one viewpoint. A scene whose sketch camera
 * changed (a commit, a hand edit) adopts the new one; a scene that vanished
 * is dropped. */
export function carryExploration3(explored: ReadonlyMap<number, Camera3>, before: readonly (Camera3 | undefined)[], after: readonly (Camera3 | undefined)[]): Map<number, Camera3> {
  const kept = new Map<number, Camera3>();
  for (const [scene, camera] of explored) if (sameCamera3(before[scene], after[scene])) kept.set(scene, camera);
  return kept;
}
