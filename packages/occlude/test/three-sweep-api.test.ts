import {beforeAll,describe,it,expect,expectTypeOf} from 'vitest';
import {readFileSync} from 'node:fs';
import {circle,polyline,curve,sweep,query,view,orthographic,perspective} from 'occlude/3d';
import type {Mesh} from 'occlude/3d';
import {initOcclude,sketch,compileSketchAsync,commitCamera3,exportSvg,pen,mm} from '../src/index.js';
import {cross3,dot3} from '../src/three/math.js';
beforeAll(async()=>initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm',import.meta.url))));
const volume=(mesh:Mesh<any,any,any>)=>mesh.surface.triangles.reduce((sum,t)=>{const [a,b,c]=t.vertices.map(i=>mesh.surface.points[i].position);return sum+dot3(a,cross3(b,c))/6;},0);
const manifold=(mesh:Mesh<any,any,any>)=>{expect(mesh.surface.edges.every(e=>e.faces.length===2)).toBe(true);for(const e of mesh.edges)expect(e.length).toBeGreaterThan(0);};
describe('transported profile sweeps',()=>{
 it('produces a shared-rim prism with analytic volume, normals and ray hits',()=>{
  const n=12,r=2,h=3,profile=circle(r,{segments:n}),path=polyline([[0,0,0],[0,0,h]]),solid=sweep(profile,path,{caps:true,normal:[1,0,0]});
  manifold(solid);expect(solid.points.length).toBe(2*n);expect(solid.faces.length).toBe(n+2);
  expect(volume(solid)).toBeCloseTo(n*r*r*Math.sin(2*Math.PI/n)*h/2,12);
  expect(solid.faces.at(-2)!.normal[2]).toBe(-1);expect(solid.faces.at(-1)!.normal[2]).toBe(1);
  const hit=query(solid).ray([0,0,5],[0,0,-2]);expect(hit!.distance).toBeCloseTo(2,12);expect(hit!.t).toBeCloseTo(1,12);
  expect(solid.surface).toEqual(sweep(profile,path,{caps:true,normal:[1,0,0]}).surface);
 });
 it('captures typed path fields and merges attributes with explicit profile precedence',()=>{
  const profile=circle(.5,{segments:8}).attribute('tag','profile').attribute('weight',2).edgeAttribute('material','ink');
  const path=polyline([[0,0,0],[0,0,1],[0,0,2]]).attribute('tag','path').attribute('height',p=>p.index+1).edgeAttribute('section',e=>e.index);
  let calls=0;
  const solid=sweep(profile,path,{normal:[1,0,0],twist:90,scale:p=>{calls++;expect(p).toBe(path.points.at(p.index));return p.height;},caps:true});
  expect(calls).toBe(3);expectTypeOf(solid.points.at(0)!.height).toEqualTypeOf<number>();expectTypeOf(solid.points.at(0)!.weight).toEqualTypeOf<2>();
  expect(solid.points.map(p=>p.tag)).toEqual(Array(24).fill('profile'));
  expect(solid.points.at(0)).toMatchObject({x:.5,y:0,z:0,height:1});
  expect(solid.points.at(8)!.x).toBeCloseTo(Math.SQRT1_2,12);expect(solid.points.at(8)!.y).toBeCloseTo(Math.SQRT1_2,12);
  expect(solid.points.at(16)!.x).toBeCloseTo(0,12);expect(solid.points.at(16)!.y).toBeCloseTo(1.5,12);
  expect(solid.points.at(8)!.provenance!.parents).toEqual([profile.points.at(0)!.id,path.points.at(1)!.id]);
  expect(solid.faces.at(0)).toMatchObject({material:'ink',section:0});expect(solid.faces.at(-1)!.material).toBeUndefined();
  const before=volume(solid),changed=solid.subdivide().displace(p=>[0,0,p.weight]).steps(1,(current,next)=>next.move(current.points,[0,0,1]));manifold(changed);expect(volume(changed)).toBeCloseTo(before,10);
  expect(path.points.at(0)!.z).toBe(0);
 });
 it('shares both closed seams and has the independent polygonal torus volume',()=>{
  const n=24,m=12,R=2,r=.3,path=circle(R,{segments:n}),profile=circle(r,{segments:m});
  const solid=sweep(profile,path,{normal:[0,0,1]});manifold(solid);expect(solid.points.length).toBe(n*m);expect(solid.faces.length).toBe(n*m);
  const profileArea=m*r*r*Math.sin(2*Math.PI/m)/2;
  expect(volume(solid)).toBeCloseTo(n*Math.sin(2*Math.PI/n)*R*profileArea,11);
  for(let i=0;i<n;i++){const p=solid.points.at(i*m)!;expect(p.x).toBeCloseTo(path.points.at(i)!.x,12);expect(p.y).toBeCloseTo(path.points.at(i)!.y,12);expect(p.z).toBeCloseTo(r,12);}
  const knot=curve(t=>{const a=2*Math.PI*t;return [Math.cos(a)*(2+.4*Math.cos(3*a)),Math.sin(a)*(2+.4*Math.cos(3*a)),.4*Math.sin(3*a)];},{closed:true,segments:48});
  const knotted=sweep(circle(.1,{segments:8}),knot,{twist:360});manifold(knotted);expect(knotted.points.length).toBe(384);expect(volume(knotted)).toBeGreaterThan(0);
 });
 it('supports open ribbon profiles and open tubes without implicit caps',()=>{
  const path=polyline([[0,0,0],[0,0,1],[1,0,2]]),ribbon=sweep(polyline([[-.5,0,0],[.5,0,0]]),path);
  expect(ribbon.points.length).toBe(6);expect(ribbon.faces.length).toBe(2);expect(ribbon.surface.edges.filter(e=>e.faces.length===1).length).toBe(6);
  const tube=sweep(circle(.2,{segments:8}),path);expect(tube.surface.edges.filter(e=>e.faces.length===1).length).toBe(16);
 });
 it('rejects undefined frames, singular fields and oversized topology before field evaluation',()=>{
  const profile=circle(),path=polyline([[0,0,0],[0,0,1]]);
  expect(()=>sweep(profile,path,{normal:[0,0,1]})).toThrow('parallel');
  expect(()=>sweep(profile,path,{scale:0})).toThrow('positive');expect(()=>sweep(profile,path,{twist:Infinity})).toThrow('finite');
  expect(()=>sweep(profile,circle(),{twist:30})).toThrow('whole turns');
  expect(()=>sweep(profile,polyline([[0,0,0],[0,0,1],[0,0,0]]))).toThrow('180-degree');
  expect(()=>sweep(profile.translate([0,0,1]),path)).toThrow('XY');
  expect(()=>sweep(polyline([[0,0,0],[1,0,0]]),path,{caps:true})).toThrow('closed profile');
  expect(()=>sweep(profile,path,{caps:true,maxCapPoints:3})).toThrow('cap point budget');
  expect(()=>sweep(profile,path,{maxPoints:10,scale:()=>{throw Error('field must not run');}})).toThrow('points budget');
 });
 it('retains the swept geometry and sampled scale fields across camera commits',async()=>{
  let models=0,scales=0;
  const definition=sketch({seed:42,pens:{ink:pen({width:mm(.3)})}},()=>{models++;return view(sweep(circle(.3,{segments:8}),polyline([[0,0,0],[0,0,1],[1,0,2]]),{caps:true,scale:()=>{scales++;return 1;}}),{camera:orthographic({eye:[5,7,6],span:4})});});
  const result=await compileSketchAsync(definition),before=exportSvg(result),id=[...result.scenes3.keys()][0];
  const changed=await commitCamera3(result,id,perspective({eye:[5,7,6]}));expect(models).toBe(1);expect(scales).toBe(3);expect(exportSvg(result)).toBe(before);expect(exportSvg(changed)).not.toBe(before);
 });
});
