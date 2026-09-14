import {expect,it} from 'vitest';
import {switchProjection3,orbitCamera3,zoomCamera3} from './orbit.js';
import {cameraFrame3,toCamera3,toPaper3,type Camera3} from 'occlude/src/three/camera.js';
const camera:Camera3={kind:'orthographic',span:8,eye:[0,-10,0],target:[0,0,0],up:[0,0,1],near:.1,far:30};
it('preserves target-plane framing, direction/up, and clipping planes when switching',()=>{
 const perspective=switchProjection3(camera,'perspective');expect(perspective.kind).toBe('perspective');
 const frame=(c:Camera3)=>cameraFrame3(c,{x:0,y:0,width:200,height:160});
 for(const point of [[0,0,0],[1,0,2],[-2,0,-3]] as const){
  const a=toPaper3(frame(camera),toCamera3(frame(camera),point)),b=toPaper3(frame(perspective),toCamera3(frame(perspective),point));
  a.forEach((v,i)=>expect(v).toBeCloseTo(b[i],10));
 }
 const d=Math.hypot(...perspective.eye);
 expect(d-perspective.near).toBeCloseTo(10-camera.near,10);
 expect(d-perspective.far).toBeCloseTo(10-camera.far,10);
 expect(perspective.near).toBeGreaterThanOrEqual(camera.near);
 expect(perspective.up).toEqual(camera.up);expect(perspective.target).toEqual(camera.target);
 const back=switchProjection3(perspective,'orthographic');expect(back.kind==='orthographic'&&back.span).toBeCloseTo(8,10);
 expect(camera.eye).toEqual([0,-10,0]);
});
it('uses 45 degrees when it preserves the depth range and supports both camera operations',()=>{
 const p=switchProjection3({...camera,span:20},'perspective');expect(p.kind==='perspective'&&p.fovDegrees).toBeCloseTo(45);
 for(const c of [camera,p]){
  expect(switchProjection3(c,c.kind)).toBe(c);
  expect(orbitCamera3(c,.2,.1).kind).toBe(c.kind);
  expect(zoomCamera3(c,1.2).kind).toBe(c.kind);
 }
});
