import {describe,it,expect} from 'vitest';
import {cone,perspective,orthographic} from 'occlude/3d';
import {cameraFrame3} from '../src/three/camera.js';
import {featureSnapshot3} from '../src/three/features/snapshot.js';
import {classifySceneCpu3} from '../src/three/visibility/scene.js';
import {hiddenInterval3,occlusionVolume3,unionIntervals3,visibleIntervals3} from '../src/three/visibility/interval.js';
import type {Vec3,Triangle3} from '../src/three/math.js';

describe('shared occlusion boundaries',()=>{
 // Independent convex-cone oracle: a rim edge is hidden when both its base
 // and side face point away from the eye. Use the analytic side normal in
 // world space, not the renderer's camera triangles or interval predicates.
 for(const kind of ['perspective','orthographic'] as const)for(const near of [.1,18.8])it(`respects convex occlusion and open near clipping with ${kind}, near ${near}`,()=>{
  const radius=.4,height=.8421867598313839,n=32,eye:Vec3=[8,10,8],target:Vec3=[0,0,.5],translate:Vec3=[-3,-3,0];
  const prototype=cone(radius,1,{segments:n}),camera=(kind==='perspective'?perspective:orthographic)({eye,target,near});
  const result=classifySceneCpu3(featureSnapshot3([{id:'cone',surface:prototype.surface,transform:{translate,scale:[1,1,height]}}],[],cameraFrame3(camera,{x:10,y:10,width:180,height:250})));
  const back=new Set<string>();
  for(let i=0;i<n;i++){
    const angle=2*Math.PI*i/n,mid=angle+Math.PI/n;
    const normal=[height*Math.cos(mid),height*Math.sin(mid),radius*Math.cos(Math.PI/n)];
    const point=[translate[0]+radius*Math.cos(angle),translate[1]+radius*Math.sin(angle),-height/2];
    const direction=eye.map((v,k)=>v-(kind==='perspective'?point[k]:target[k]));
    if(normal.reduce((sum,v,k)=>sum+v*direction[k],0)<0){const edge=prototype.surface.edges.find(e=>e.vertices.includes(i)&&e.vertices.includes((i+1)%n))!;back.add(edge.id);}
  }
  const hidden=result.features.filter(r=>back.has(r.feature.sourceId));expect(hidden.length).toBeGreaterThan(8);if(near<1)expect(hidden.every(r=>r.visible.length===0)).toBe(true);
  else {
    // Near clipping opens this cone; its removed front cannot hide the rear.
    expect(hidden.some(r=>r.visible.some(([a,b])=>b-a>.01))).toBe(true);
    expect(hidden.every(r=>r.visible.every(([a,b])=>b-a>1e-10))).toBe(true);
  }
 });
 it('preserves a real tiny open gap between distinct occluders',()=>{
  const delta=1e-9,left=.5-delta,right=.5+delta;
  const triangles:Triangle3[]=[[[-1,-1,-1],[left,-1,-1],[left,1,-1]],[[right,-1,-1],[2,-1,-1],[right,1,-1]]];
  const intervals=triangles.map(t=>hiddenInterval3([0,0,-2],[1,0,-2],occlusionVolume3(t,false)!)!);
  const visible=visibleIntervals3(unionIntervals3(intervals));expect(visible).toHaveLength(1);expect(visible[0][0]).toBeCloseTo(left,15);expect(visible[0][1]).toBeCloseTo(right,15);expect(visible[0][1]-visible[0][0]).toBeGreaterThan(delta);
 });
});
