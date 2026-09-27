import {beforeAll,describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {box,pointCloud,instanceOnPoints,axisAngle,view,orthographic,perspective} from 'occlude/3d';
import {prototypeOf,placedOf} from '../src/three/api/instances.js';
import {featureSnapshot3} from '../src/three/features/snapshot.js';
import {cameraFrame3} from '../src/three/camera.js';
import {classifySceneCpu3} from '../src/three/visibility/scene.js';
import { sketch, pen, mm } from '../src/index.js';
import { initOcclude, compileSketchAsync, commitCamera3, exportSvg } from '../src/host.js';
import {surfaceOf} from '../src/three/geometry/value.js';
beforeAll(async()=>initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm',import.meta.url))));
const camera=orthographic({eye:[5,7,6],span:7});
describe('shared mesh instances',()=>{
 it('keeps a single prototype through fields, selections and retained scene capture',()=>{
  const prototype=box().points.set('weight',2),sites=pointCloud([[0,0,0],[2,0,0],[4,0,0]]).points.set('height',p=>p.index+1);
  const placed=instanceOnPoints(prototype,sites.points,{scale:p=>[1,1,p.height]}).points.set('ink',r=>r.height%2?'a':'b');
  // Instances are a value of points: a point a copy, where it stands.
  expect(prototypeOf(placed)).toBe(prototype);expect(placed.points.length).toBe(3);expect(placed.faces.length).toBe(0);
  expect(placed.points.at(1)!.source).toBe(sites.points.at(1));expect(placed.points.map(r=>r.scale[2])).toEqual([1,2,3]);
  const drawing=view(placed,{camera});
  const classified=classifySceneCpu3(featureSnapshot3(drawing.scene.objects,[],cameraFrame3(camera,{x:0,y:0,width:100,height:100})));
  const copies=placedOf(placed);
  for(const feature of classified.features){expect(feature.feature.instance).toEqual(drawing.scene.objects.find(o=>o.id===feature.feature.objectId)!.instance);expect(copies.some(c=>c.id===feature.feature.instance!.id&&surfaceOf(sites).points[(c.source as {index:number}).index].id===feature.feature.instance!.pointId)).toBe(true);}
  expect(new Set(drawing.scene.objects.map(o=>o.surface)).size).toBe(1);expect(drawing.scene.objects[0].surface).toBe(surfaceOf(prototype));
  // A write keeps the prototype and every copy's name.
  const group=placed.points.groupBy(r=>r.ink)[0];expect(group.key).toBe('a');const selected=group.extract();
  expect(prototypeOf(selected)).toBe(prototype);expect(placedOf(selected).map(c=>c.id)).toEqual([copies[0].id,copies[2].id]);
  expect(placedOf(placed.points.set('ink','c')).map(c=>c.id)).toEqual(copies.map(c=>c.id));
  expect(placedOf(instanceOnPoints(prototype,sites.points)).map(c=>c.id)).toEqual(copies.map(c=>c.id));
  const keyed=()=>instanceOnPoints(prototype,sites.points,{key:'same'});
  expect(()=>view([keyed(),keyed()],{camera})).toThrow('unique');
 });
 it('owns transform and attribute inputs without changing prototype or source points',()=>{
  const scale:[number,number,number]=[-2,3,4],offset:[number,number,number]=[2,0,0],attr=[1,2];
  const source=pointCloud([[1,2,3]]),prototype=box();
  const a=instanceOnPoints(prototype,source.points,{scale,offset}).points.set('value',attr);
  scale[0]=99;offset[0]=99;attr[0]=99;
  expect(a.points.at(0)!.scale).toEqual([-2,3,4]);expect(a.points.at(0)!.value).toEqual([1,2]);
  // Euler degrees in, Euler degrees kept: a write turns a copy the same way.
  expect(a.points.at(0)!.rotate).toEqual([0,0,0]);
  const b=a.points.set('rotate',[0,0,90]).translate([0,1,0]);
  expect(placedOf(a)[0].transform.translate).toEqual([3,2,3]);expect(placedOf(b)[0].transform.translate).toEqual([3,3,3]);expect(prototypeOf(b)).toBe(prototype);
  const realized=b.realize(),positions=realized.points.map(p=>[p.x,p.y,p.z]);
  for(const axis of [0,1,2]){expect(Math.min(...positions.map(p=>p[axis]))).toBeCloseTo([1.5,2,1][axis]);expect(Math.max(...positions.map(p=>p[axis]))).toBeCloseTo([4.5,4,5][axis]);}
  expect(source.points.at(0)).toMatchObject({x:1,y:2,z:3});expect(prototype.points.length).toBe(8);
  // A rotation value is kept as its unit quaternion, turned exactly as it was.
  const turned=instanceOnPoints(prototype,source.points,{rotate:()=>axisAngle('z',30)});
  expect(turned.points.at(0)!.rotate).toEqual([...axisAngle('z',30).quaternion]);
  expect((placedOf(turned)[0].transform.rotate as {quaternion:readonly number[]}).quaternion).toEqual(axisAngle('z',30).quaternion);
 });
 it('realizes disconnected shared topology with typed attributes and deterministic provenance',()=>{
  const prototype=box().points.set('tag','prototype').edges.set('edgeTag',7).faces.set('faceTag',9);
  const sites=pointCloud([[0,0,0],[2,0,0]]).points.set({tag:'instance',height:2});
  const placed=instanceOnPoints(prototype,sites.points),a=placed.realize(),b=placed.realize();
  expect(surfaceOf(a)).toEqual(surfaceOf(b));expect(a.points.length).toBe(16);expect(a.edges.length).toBe(24);expect(a.faces.length).toBe(12);expect(surfaceOf(a).edges.every(e=>e.faces.length===2)).toBe(true);
  expect(a.points.map(p=>p.tag)).toEqual(Array(16).fill('prototype'));expect(a.edges.at(0)!.edgeTag).toBe(7);expect(a.faces.at(0)!.faceTag).toBe(9);expect(a.faces.at(0)!.height).toBe(2);
  // A realized row comes from a prototype row and an instance: its source is the two, in that order.
  const [from,copy]=a.points.at(0)!.source as readonly any[];expect(from).toBe(prototype.points.at(0));expect(copy).toBe(placed.points.at(0));expect(copy.source).toBe(sites.points.at(0));
  const selected=placed.points.filter(r=>r.index===1).extract().realize();expect(surfaceOf(selected).points.map(p=>p.id)).toEqual(surfaceOf(a).points.map(p=>p.id).slice(8));
  expect(()=>placed.realize({maxPoints:15})).toThrow('points budget');expect(()=>placed.realize({maxFaces:11})).toThrow('faces budget');
  expect(instanceOnPoints(prototype,sites.points.filter(()=>false)).realize().points.length).toBe(0);
  expect(()=>sites.realize()).toThrow('realize: this value places nothing');
 });
 it('matches explicit realization in both projections, including mirrored hatch and clipping',()=>{
  const sites=pointCloud([[-.5,0,0],[.6,.2,.4]]),placed=instanceOnPoints(box(),sites.points,{scale:p=>p.index?[-1,1.5,.8]:[1,1,1],rotate:p=>[0,0,p.index*25]});
  for(const camera of [orthographic({eye:[5,7,6],span:6,near:9.5}),perspective({eye:[5,7,6],fovDegrees:40,near:9.5})]){
    const settings={camera,hatch:{spacing:mm(5)}};
    const a=view(placed,settings),b=view(placed.realize(),settings),frame=cameraFrame3(camera,{x:0,y:0,width:100,height:100});
    const snapshot=(v:typeof a)=>classifySceneCpu3(featureSnapshot3(v.scene.objects,[],frame));
    // Segment direction/order is not geometry. Canonicalize the actual visible
    // and hidden endpoints to 1e-10 world units, well below paper precision.
    const ink=(v:typeof a)=>snapshot(v).features.flatMap(r=>['visible','hidden'].flatMap(kind=>(kind==='visible'?r.visible:r.hidden).map(([lo,hi])=>{
      const ends=[lo,hi].map(t=>r.feature.a.map((x,k)=>Number((x+(r.feature.b[k]-x)*t).toFixed(10))));
      return JSON.stringify([kind,...ends.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))]);
    }))).sort();
    expect(ink(a)).toEqual(ink(b));
  }
 });
 it('hides the complete rear instance behind an independently known front box',()=>{
  const placed=instanceOnPoints(box(),pointCloud([[0,0,0],[0,0,1]]).points),camera=orthographic({eye:[0,0,10],up:[0,1,0],span:4});
  const drawing=view(placed,{camera}),frame=cameraFrame3(camera,{x:0,y:0,width:100,height:100});
  const classified=classifySceneCpu3(featureSnapshot3(drawing.scene.objects,[],frame));
  const rear=classified.features.filter(r=>r.feature.objectId===drawing.scene.objects[0].id);expect(rear.length).toBeGreaterThan(0);expect(rear.every(r=>r.visible.length===0)).toBe(true);
 });
 it('retains prototype/placement capture across a camera-only commit without model RNG',async()=>{
  let models=0,eligibility=0;
  const definition=sketch({seed:42,pens:{ink:pen({width:mm(.25)})}},t=>{models++;const sites=pointCloud([[0,0,0],[1,0,0]]).points.set('height',()=>t.rnd(.5,1.5));return view(instanceOnPoints(box(),sites.points,{scale:p=>[1,1,p.height]}),{camera,hatch:{spacing:mm(5),select:()=>{eligibility++;return true;}}});});
  const original=await compileSketchAsync(definition),before=exportSvg(original),scene=[...original.scenes3.keys()][0];
  const committed=await commitCamera3(original,scene,perspective({eye:[5,7,6],fovDegrees:40}));expect(models).toBe(1);expect(eligibility).toBe(6);expect(exportSvg(original)).toBe(before);expect(exportSvg(committed)).not.toBe(before);
 });
 it('refuses what is not a prototype or points, and a singular scale places a copy of nothing',()=>{
  const sites=pointCloud([[0,0,0]]),prototype=box();
  expect(placedOf(instanceOnPoints(prototype,sites.points,{scale:0}))[0].transform.scale).toEqual([0,0,0]);
  expect(()=>instanceOnPoints(prototype,prototype.faces as any)).toThrow('instanceOnPoints: expected points');
  expect(()=>instanceOnPoints(sites as any,sites.points)).toThrow('instanceOnPoints: the prototype is a value with faces');
  expect(()=>instanceOnPoints(prototype,sites.points,{scale:[1,NaN,1]})).toThrow('instanceOnPoints: scale is a number or three factors');
  expect(()=>instanceOnPoints(prototype,sites.points).points.set('id',1)).toThrow('reserved');
 });
});
