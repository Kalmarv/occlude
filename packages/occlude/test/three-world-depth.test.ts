import {describe,it,expect} from 'vitest';
import {box3,surface3} from '../src/three/geometry/surface.js';
import {hatch3} from '../src/three/curves/hatch.js';
import {featureSnapshot3,FeatureKind3} from '../src/three/features/snapshot.js';
import {cameraFrame3,type Camera3} from '../src/three/camera.js';
import {classifySceneCpu3} from '../src/three/visibility/scene.js';
import {mm} from '../src/units.js';
const eye=[3.487353363430086,5.051254890342219,-7.8269794305909635] as const;
const paper={x:10.795,y:10.795,width:194.31,height:257.81};
const camera=(kind:'orthographic'|'perspective',clip=false):Camera3=>({eye,target:[0,0,.4],up:[0,0,1],near:clip?8:.1,far:clip?9:30,...(kind==='orthographic'?{kind,span:4.6}:{kind,fovDegrees:40})});
describe('source-space depth behind overlapping bottom faces',()=>{
 for(const kind of ['orthographic','perspective'] as const)for(const clipped of [false,true]){
  it(`leaves the exposed box bottom fully visible (${kind}, clipped=${clipped})`,()=>{
   const hatch=hatch3(box3([2.8,1.5,1.6]),[{id:'rows',spacing:mm(1.8),angle:35}]);
   const snapshot=featureSnapshot3([{id:'block',surface:hatch.surface,hatch},{id:'tower',surface:box3([1,1,2.8],[.6,.3,.6])}],[],cameraFrame3(camera(kind,clipped),paper));
   const bottom=classifySceneCpu3(snapshot).features.filter(r=>r.feature.attributes.hatchFace==='f0');
   // Independent world-space oracle: every point on the lower plane z=-0.8
   // is in front of the tower's minimum z=-0.7999999999999999 for this eye.
   // Neither the tower nor the convex block can hide its exposed bottom ink.
   expect(bottom.length).toBeGreaterThan(10);
   expect(bottom.every(r=>r.hidden.length===0&&r.visible.length===1&&r.visible[0][0]===0&&r.visible[0][1]===1)).toBe(true);
   if(clipped)expect(bottom.some(r=>r.feature.range[0]>0||r.feature.range[1]<1)).toBe(true);
  });
 }
 it('keeps exactly coplanar distinct faces visible after mirrored placement and camera clipping',()=>{
  const source=surface3([[-1.4,-.75,-.8],[1.4,-.75,-.8],[1.4,.75,-.8],[-1.4,.75,-.8]],[[0,1,2,3]]);
  const occluder=surface3([[.1,-.2,-.8],[1.1,-.2,-.8],[1.1,.8,-.8],[.1,.8,-.8]],[[0,1,2,3]]);
  const hatch=hatch3(source,[{id:'rows',spacing:mm(1.8),angle:35}]);
  for(const kind of ['orthographic','perspective'] as const){
   const transform={scale:[-1,1.3,1] as const,rotate:[0,0,37] as const};
   const snapshot=featureSnapshot3([{id:'source',surface:hatch.surface,hatch,transform},{id:'other',surface:occluder,lineSource:false,transform}],[],cameraFrame3(camera(kind,true),paper));
   const ink=classifySceneCpu3(snapshot).features.filter(r=>(r.feature.flags&FeatureKind3.hatch)!==0);
   expect(ink.length).toBeGreaterThan(10);expect(ink.every(r=>r.hidden.length===0)).toBe(true);
  }
 });
 it('retains a one-ULP front occluder and distinguishes an equal or behind plane',()=>{
  const camera:Camera3={kind:'orthographic',span:5,eye:[0,0,-5],target:[0,0,0],up:[0,1,0],near:.1,far:10};
  for(const z of [-.8000000000000002,-.8,-.7999999999999999]){
   const snapshot=featureSnapshot3([{id:'occluder',surface:surface3([[-1,-1,z],[1,-1,z],[0,1,z]],[[0,1,2]]),lineSource:false}], [{id:'wire',points:[[-2,0,-.8],[2,0,-.8]]}],cameraFrame3(camera,paper));
   const [wire]=classifySceneCpu3(snapshot).features;
   expect(wire.hidden).toEqual(z<-.8?[[.375,.625]]:[]);
  }
 });
 it('clips occluder hits at the near plane with independent projected intervals',()=>{
  const surface=surface3([[-1,-1,-1],[1,-1,-3],[0,1,-2]],[[0,1,2]]);
  for(const kind of ['orthographic','perspective'] as const)for(const near of [.1,2,2.9]){
   const camera:Camera3={eye:[0,0,0],target:[0,0,-1],up:[0,1,0],near,far:5,...(kind==='orthographic'?{kind,span:5}:{kind,fovDegrees:50})};
   const snapshot=featureSnapshot3([{id:'sloped',surface,lineSource:false}],[{id:'wire',points:[[-2,0,-4],[2,0,-4]]}],cameraFrame3(camera,paper));
   const [wire]=classifySceneCpu3(snapshot).features;
   // At y=0 the triangle has x in [-.5,.5], z=-2-x. Near=2 keeps
   // x>=0; near=2.9 leaves no intersection with this ray family.
   const expected=near===2.9?[]:[near===2?[.5,kind==='orthographic'?.625:.7]:kind==='orthographic'?[.375,.625]:[1/6,.7]];
   expect(wire.hidden).toHaveLength(expected.length);
   expected.forEach((span,i)=>span.forEach((v,k)=>expect(wire.hidden[i][k]).toBeCloseTo(v,14)));
  }
 });

});
