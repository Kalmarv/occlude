import {beforeAll,describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {curve,parametricCurve,box,view,orthographic,perspective} from 'occlude/3d';
import {featureSnapshot3} from '../src/three/features/snapshot.js';
import {cameraFrame3} from '../src/three/camera.js';
import {classifySceneCpu3} from '../src/three/visibility/scene.js';
import {snapshotSurface3,transformSurface3} from '../src/three/geometry/model.js';
import { sketch, pen, mm } from '../src/index.js';
import { initOcclude, compileSketchAsync, commitCamera3, exportSvg } from '../src/host.js';
import {toolkit} from './helpers/run.js';
import {surfaceOf} from '../src/three/geometry/value.js';

/** The 3D profile circle, as the parametric curve it always was. */
const circle=(r=1,options:{segments?:number}={})=>parametricCurve(u=>[r*Math.cos(2*Math.PI*u),r*Math.sin(2*Math.PI*u),0],{...options,closed:true});
beforeAll(async()=>initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm',import.meta.url))));
const camera=orthographic({eye:[0,0,5],up:[0,1,0],span:5});
describe('owned 3D curve geometry',()=>{
 it('owns raw points, shares closed seams and retains only point/edge capabilities',()=>{
  const points:[number,number,number][]=[[0,0,0],[1,0,0],[1,1,0]];
  const path=curve(points,{closed:true});points[0][0]=99;
  expect(path.points.length).toBe(3);expect(path.edges.length).toBe(3);
  expect([path.edges.at(-1)!.a.index,path.edges.at(-1)!.b.index].sort()).toEqual([0,2]);expect(path.points.at(0)!.x).toBe(0);
  expect(surfaceOf(path).faces).toEqual([]);expect(path.faces.length).toBe(0);
  expect(snapshotSurface3(surfaceOf(path))).toBe(surfaceOf(path));
  expect(surfaceOf(curve([[0,0,0],[1,0,0],[1,1,0]],{closed:true}))).toEqual(surfaceOf(path));
 });
 it('preserves typed attributes, IDs and topology through extraction and transformations',()=>{
  const source=box().points.set('height',p=>p.z).edges.set('tag',e=>e.index);
  const path=source.edges.filter(e=>e.a.z>0&&e.b.z>0).extract();
  expect(path.points.length).toBe(4);expect(surfaceOf(path).faces.length).toBe(0);
  expect(path.edges.map(e=>e.tag)).toEqual(source.edges.filter(e=>e.a.z>0&&e.b.z>0).map(e=>e.tag));
  
  const changed=path.points.set('gain',2).displace(p=>[0,0,p.gain]).rotate([0,0,90]).scale([-2,3,1]).translate([0,0,1]).edges.set('lengthCopy',e=>e.length);
  expect(surfaceOf(changed).edges.map(e=>e.id)).toEqual(surfaceOf(path).edges.map(e=>e.id));
  expect(changed.points.map(p=>p.z)).toEqual([3.5,3.5,3.5,3.5]);
  expect(changed.edges.map(e=>e.lengthCopy).sort()).toEqual([2,2,3,3]);
  expect(changed.points.source).not.toBe(path.points.source);
  expect(path.points.map(p=>p.z)).toEqual([.5,.5,.5,.5]);
  const selected=changed.edges.filter(e=>e.lengthCopy>2).extract();expect(selected.edges.length).toBe(2);expect(selected.points.length).toBe(4);
  expect(transformSurface3(surfaceOf(path),{translate:[0,0,1]}).edges.length).toBe(4);
 });
 it('runs passes over a curve, reads an earlier revision by id and retains history',()=>{
  const t=toolkit();
  const original=curve([[0,0,0],[1,0,0]]).points.set('gain',2);
  const result=t.steps(3,original,c=>c.displace(p=>[0,0,p.gain+2*p.z]),{every:2});
  expect(result.points.map(p=>p.z)).toEqual([26,26]);expect(original.points.map(p=>p.z)).toEqual([0,0]);
  expect(result.history.map(c=>c.points.at(0)!.z)).toEqual([0,8,26]);expect(result.edges.length).toBe(1);
  expect(result.history.every(c=>c.edges.length===1)).toBe(true);
  expect(original.points.set('z',p=>p.z+1,original.displace([0,0,0]).points).points.map(p=>p.z)).toEqual(original.points.map(p=>p.z+1));
  expect(()=>original.points.set('z',(async()=>1) as never)).toThrow("the value of 'z'");
 });
 it('samples functions once and rejects oversized work before invoking callbacks',()=>{
  const parameters:number[]=[];const path=parametricCurve(t=>{parameters.push(t);return [t,t*t,t*t*t];},{segments:4});
  expect(parameters).toEqual([0,.25,.5,.75,1]);expect(path.points.at(-1)).toMatchObject({x:1,y:1,z:1});
  expect(()=>parametricCurve(()=>{throw Error('should not run');},{segments:100,maxPoints:10})).toThrow('budget');
  expect(circle(1,{segments:2}).edges.length).toBe(0);
  expect(circle(0).edges.length).toBe(0);
  expect(curve([[0,0,0],[0,0,0],[1,0,0]]).edges.length).toBe(1);
  expect(curve([[0,0,0],[1,0,0],[0,0,0]],{closed:true}).edges.length).toBe(2);
  expect(()=>curve([[0,0,0],[Infinity,0,0]])).toThrow();
  expect(()=>path.points.set('index',1)).toThrow('reserved');
  const ring=circle(2,{segments:12});expect(ring.points.length).toBe(12);expect(ring.edges.length).toBe(12);
  for(const p of ring.points)expect(Math.hypot(p.x,p.y)).toBeCloseTo(2,14);
 });
 it('uses the existing visibility engine with analytic wire/box intervals and no curve occluders',()=>{
  const path=curve([[-2,0,-1],[2,0,-1]],{key:'path'}).edges.set('ink','wire');
  const drawing=view([box(),path],{camera});
  const snap=featureSnapshot3(drawing.scene.objects,[],cameraFrame3(camera,{x:0,y:0,width:100,height:100}));
  const classified=classifySceneCpu3(snap),wire=classified.features.find(r=>r.feature.objectId==='path')!;
  expect(wire.visible).toEqual([[0,.375],[.625,1]]);expect(wire.hidden).toEqual([[.375,.625]]);
  expect(wire.feature.sourceId).toBe(surfaceOf(path).edges[0].id);expect(wire.feature.attributes.ink).toBe('wire');
  expect(snap.triangles.length).toBe(12);expect(snap.occluders.every(o=>!o.id.includes('path'))).toBe(true);
  const ring=circle(1,{segments:8}),ringView=view(ring,{camera});
  const ringSnap=featureSnapshot3(ringView.scene.objects,[],cameraFrame3(camera,{x:0,y:0,width:100,height:100}));
  expect(ringSnap.features.length).toBe(8);expect(ringSnap.features.at(-1)!.endpoints[1]).toBe(ringSnap.features[0].endpoints[0]);
 });
 it('retains a curve interpretation across camera commits without resampling the model',async()=>{
  let models=0,samples=0;
  const definition=sketch({seed:42,pens:{ink:pen({width:mm(.3)})}},()=>{models++;return view(parametricCurve(t=>{samples++;return [Math.cos(t*6),Math.sin(t*6),t];},{segments:16}),{camera,pen:'ink'});});
  const result=await compileSketchAsync(definition),before=exportSvg(result),id=[...result.scenes3.keys()][0];
  const changed=await commitCamera3(result,id,perspective({eye:[4,6,5]}));
  expect(models).toBe(1);expect(samples).toBe(17);expect(exportSvg(result)).toBe(before);expect(exportSvg(changed)).not.toBe(before);
 });
});
