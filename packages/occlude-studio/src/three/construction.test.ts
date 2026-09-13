import { describe, it, expect } from 'vitest';
import { surface3, lineArt3 } from 'occlude';
import { cameraFrame3, toCamera3, toPaper3, type Camera3 } from 'occlude/src/three/camera.js';
import { ConstructionScene3 } from './construction.js';
import { orbitCamera3, zoomCamera3 } from './orbit.js';
const camera: Camera3 = {kind:'orthographic',span:4,eye:[0,0,10],target:[0,0,0],up:[0,1,0],near:.1,far:20};
const sheet = () => surface3([[-1,-1,0],[1,-1,0],[1,1,0],[-1,1,0]],[[0,1,2,3]]);
describe('retained construction scene',()=>{
  it('picks modeled faces with captured attributes, independent of source edits and preview camera',()=>{
    const surface=sheet();surface.faces[0].attributes.height=3;
    const scene=new ConstructionScene3(lineArt3({camera,objects:[{id:'sheet',surface}],lineSets:[]}));
    surface.points[0].position=[100,100,100];surface.faces[0].attributes.height=9;
    const hit=scene.pick(camera,400,400,.5,.5)!;
    expect(hit.objectId).toBe('sheet');expect(hit.attributes).toEqual({height:3});expect(hit.point).toEqual([0,0,0]);
    const moved=orbitCamera3(camera,.35,.4);
    const f=cameraFrame3(moved,{x:0,y:0,width:400,height:400});
    const p=toPaper3(f,toCamera3(f,[.2,.3,0]));
    const picked=scene.pick(moved,400,400,p[0]/400,p[1]/400)!;
    expect(picked.point[0]).toBeCloseTo(.2,10);expect(picked.point[1]).toBeCloseTo(.3,10);
    expect(scene.info.triangles).toBe(2);expect(scene.info.wires).toBe(4);
    expect(scene.pick(camera,400,400,0,0)).toBeNull();
    expect(scene.pick({...camera,far:5},400,400,.5,.5)).toBeNull();
  });
  it('picks the nearest transformed instance with perspective depth limits',()=>{
    const perspective:Camera3={kind:'perspective',eye:camera.eye,target:camera.target,up:camera.up,near:.1,far:20,fovDegrees:50};
    const surface=sheet(),scene=new ConstructionScene3(lineArt3({camera:perspective,objects:[{id:'back',surface},{id:'front',surface,transform:{translate:[0,0,2],scale:[-1,1,1]}}],lineSets:[]}));
    expect(scene.pick(perspective,800,400,.5,.5)?.objectId).toBe('front');
    expect(scene.pick({...perspective,near:9},800,400,.5,.5)?.objectId).toBe('back');
    const frame=cameraFrame3(perspective,{x:0,y:0,width:800,height:400});
    const p=toPaper3(frame,toCamera3(frame,[.5,.25,2]));
    const hit=scene.pick(perspective,800,400,p[0]/800,p[1]/400)!;
    expect(hit.point[0]).toBeCloseTo(.5,10);expect(hit.point[1]).toBeCloseTo(.25,10);expect(hit.point[2]).toBeCloseTo(2,10);
  });
  it('orbits around the target with either up axis and bounds pole singularities',()=>{
    for(const up of [[0,1,0],[0,0,1]] as const){
      const initial={...camera,eye:[3,4,5] as const,up};
      for(const pitch of [-100,-.2,.2,100]){
        const moved=orbitCamera3(initial,.5,pitch);
        expect(Math.hypot(...moved.eye)).toBeCloseTo(Math.hypot(...initial.eye),10);
        expect(()=>cameraFrame3(moved,{x:0,y:0,width:1,height:1})).not.toThrow();
        expect(moved.target).toEqual(initial.target);
      }
    }
    expect(zoomCamera3(camera,.5)).toMatchObject({span:2,eye:camera.eye});
    expect(()=>zoomCamera3(camera,Infinity)).toThrow('invalid zoom');
  });
});
