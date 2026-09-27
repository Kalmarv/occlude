import {beforeAll,describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {curve,parametricCurve,sweep,query,view,orthographic,perspective} from 'occlude/3d';
import type {} from 'occlude/3d';
import { sketch, pen, mm } from '../src/index.js';
import { initOcclude, compileSketchAsync, commitCamera3, exportSvg } from '../src/host.js';
import {circle3,manifold,volume} from './helpers/surfaces.js';
import {DOMAINS3,kernelColumn,mesh3} from '../src/three/geometry/mesh3.js';
import type {Material} from '../src/material.js';

/** Everything the kernels read of a value — names, positions, faces, fixed
 * triangles, edges and every kernel column — as plain data. */
function kernelRead(m:Material){
 const r=mesh3(m),counts={points:r.n,edges:r.edgeCount,faces:r.faceCount,corners:r.cornerCount};
 const cols=DOMAINS3.map(d=>Object.entries(r.cols[d]).filter(([,c])=>kernelColumn(c)).map(([k])=>[k,Array.from({length:counts[d]},(_,i)=>r.cell(d,k,i))]));
 return {names:r.names,x:r.x,y:r.y,z:r.z,loops:r.loops,triangles:r.triangles,edges:r.edges,cols};
}
/** The 3D profile circle, as the parametric curve it always was. */
beforeAll(async()=>initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm',import.meta.url))));
describe('transported profile sweeps',()=>{
 it('produces a shared-rim prism with analytic volume, normals and ray hits',()=>{
  const n=12,r=2,h=3,profile=circle3(r,{segments:n}),path=curve([[0,0,0],[0,0,h]]),solid=sweep(profile,path,{caps:true,normal:[1,0,0]});
  manifold(solid);expect(solid.points.length).toBe(2*n);expect(solid.faces.length).toBe(n+2);
  expect(volume(solid)).toBeCloseTo(n*r*r*Math.sin(2*Math.PI/n)*h/2,12);
  expect(solid.faces.at(-2)!.normal[2]).toBe(-1);expect(solid.faces.at(-1)!.normal[2]).toBe(1);
  const hit=query(solid).ray([0,0,5],[0,0,-2]);expect(hit!.distance).toBeCloseTo(2,12);expect(hit!.t).toBeCloseTo(1,12);
  expect(kernelRead(solid)).toEqual(kernelRead(sweep(profile,path,{caps:true,normal:[1,0,0]})));
 });
 it('captures typed path fields and merges attributes with explicit profile precedence',()=>{
  const profile=circle3(.5,{segments:8}).points.set('tag','profile').points.set('weight',2).edges.set('material','ink');
  const path=curve([[0,0,0],[0,0,1],[0,0,2]]).points.set('tag','path').points.set('height',p=>p.index+1).edges.set('section',e=>e.index);
  let calls=0;
  const solid=sweep(profile,path,{normal:[1,0,0],twist:90,scale:p=>{calls++;expect(p).toBe(path.points.at(p.index));return p.height;},caps:true});
  expect(calls).toBe(3);
  expect(solid.points.map(p=>p.tag)).toEqual(Array(24).fill('profile'));
  expect(solid.points.at(0)).toMatchObject({x:.5,y:0,z:0,height:1});
  expect(solid.points.at(8)!.x).toBeCloseTo(Math.SQRT1_2,12);expect(solid.points.at(8)!.y).toBeCloseTo(Math.SQRT1_2,12);
  expect(solid.points.at(16)!.x).toBeCloseTo(0,12);expect(solid.points.at(16)!.y).toBeCloseTo(1.5,12);
  const [across,alongPath]=solid.points.at(8)!.source as readonly unknown[];expect(across).toBe(profile.points.at(0));expect(alongPath).toBe(path.points.at(1));
  expect(solid.faces.at(0)).toMatchObject({material:'ink',section:0});expect(solid.faces.at(-1)!.material).toBe('');
  const before=volume(solid),changed=solid.subdivide().displace(p=>[0,0,p.weight]).displace([0,0,1]);manifold(changed);expect(volume(changed)).toBeCloseTo(before,10);
  expect(path.points.at(0)!.z).toBe(0);
 });
 it('shares both closed seams and has the independent polygonal torus volume',()=>{
  const n=24,m=12,R=2,r=.3,path=circle3(R,{segments:n}),profile=circle3(r,{segments:m});
  const solid=sweep(profile,path,{normal:[0,0,1]});manifold(solid);expect(solid.points.length).toBe(n*m);expect(solid.faces.length).toBe(n*m);
  const profileArea=m*r*r*Math.sin(2*Math.PI/m)/2;
  expect(volume(solid)).toBeCloseTo(n*Math.sin(2*Math.PI/n)*R*profileArea,11);
  for(let i=0;i<n;i++){const p=solid.points.at(i*m)!;expect(p.x).toBeCloseTo(path.points.at(i)!.x,12);expect(p.y).toBeCloseTo(path.points.at(i)!.y,12);expect(p.z).toBeCloseTo(r,12);}
  const knot=parametricCurve(t=>{const a=2*Math.PI*t;return [Math.cos(a)*(2+.4*Math.cos(3*a)),Math.sin(a)*(2+.4*Math.cos(3*a)),.4*Math.sin(3*a)];},{closed:true,segments:48});
  const knotted=sweep(circle3(.1,{segments:8}),knot,{twist:360});manifold(knotted);expect(knotted.points.length).toBe(384);expect(volume(knotted)).toBeGreaterThan(0);
 });
 it('supports open ribbon profiles and open tubes without implicit caps',()=>{
  const path=curve([[0,0,0],[0,0,1],[1,0,2]]),ribbon=sweep(curve([[-.5,0,0],[.5,0,0]]),path);
  expect(ribbon.points.length).toBe(6);expect(ribbon.faces.length).toBe(2);expect(ribbon.edges.filter(e=>e.faces.length===1).length).toBe(6);
  const tube=sweep(circle3(.2,{segments:8}),path);expect(tube.edges.filter(e=>e.faces.length===1).length).toBe(16);
 });
 it('rejects undefined frames, singular fields and oversized topology before field evaluation',()=>{
  const profile=circle3(),path=curve([[0,0,0],[0,0,1]]);
  // A normal along the tangent, and a path that doubles back, name no frame:
  // the sweep picks a consistent one rather than refusing to draw.
  expect(sweep(profile,path,{normal:[0,0,1]}).faces.length).toBe(sweep(profile,path).faces.length);
  expect(mesh3(sweep(profile,path,{scale:0})).triangleCount).toBe(0);expect(()=>sweep(profile,path,{twist:Infinity})).toThrow('finite');
  expect(()=>sweep(profile,circle3(),{twist:30})).toThrow('whole turns');
  expect(sweep(profile,curve([[0,0,0],[0,0,1],[0,0,2]])).faces.length).toBe(sweep(profile,curve([[0,0,0],[0,0,1],[0,0,0]])).faces.length);
  expect(()=>sweep(profile.translate([0,0,1]),path)).toThrow('XY');
  expect(()=>sweep(curve([[0,0,0],[1,0,0]]),path,{caps:true})).toThrow('closed profile');
  expect(()=>sweep(profile,path,{caps:true,maxCapPoints:3})).toThrow('cap point budget');
  expect(()=>sweep(profile,path,{maxPoints:10,scale:()=>{throw Error('field must not run');}})).toThrow('points budget');
 });
 it('retains the swept geometry and sampled scale fields across camera commits',async()=>{
  let models=0,scales=0;
  const definition=sketch({seed:42,pens:{ink:pen({width:mm(.3)})}},()=>{models++;return view(sweep(circle3(.3,{segments:8}),curve([[0,0,0],[0,0,1],[1,0,2]]),{caps:true,scale:()=>{scales++;return 1;}}),{camera:orthographic({eye:[5,7,6],span:4})});});
  const result=await compileSketchAsync(definition),before=exportSvg(result),id=[...result.scenes3.keys()][0];
  const changed=await commitCamera3(result,id,perspective({eye:[5,7,6]}));expect(models).toBe(1);expect(scales).toBe(3);expect(exportSvg(result)).toBe(before);expect(exportSvg(changed)).not.toBe(before);
 });
});
