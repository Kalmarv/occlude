import {readFileSync} from 'node:fs';
import {beforeAll,describe,it,expect} from 'vitest';
import {initOcclude,sketch,compileSketchAsync,render,exportSvg,pen,mm,decodePlanBuffer} from '../src/index.js';
import * as core from '../../../crates/occlude-core/pkg/occlude_core.js';
import {pensToJson} from '../src/render.js';
import {box,plane,sphere,cylinder,cone,torus,grid,curve,parametricCurve,circle,mesh,pointCloud,sweep,revolve,isolines,intersections,view,orthographic,instanceOnPoints} from '../src/three/api/index.js';
import {sampleSurfacePoints} from '../src/three/api/sampling.js';
import {emptyCount,emptySize,clampSetting,sampleValue} from '../src/three/degenerate.js';
import {grid3,transformSurface3} from '../src/three/geometry/model.js';
import {surface3,box3} from '../src/three/geometry/surface.js';
import {worldBounds3} from '../src/three/geometry/bounds.js';

beforeAll(async()=>initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm',import.meta.url))));
const config={seed:42,margin:0,pens:{ink:pen({width:mm(.25),color:'#112233'}),shade:pen({width:mm(.18),color:'#a84932'})}};
const camera=orthographic({eye:[5,7,6],span:5});
const empty=()=>box([0,1,1]);

describe('a degenerate input draws nothing, and the sketch keeps rendering',()=>{
 it('makes one empty construction out of every zero size, spacing and count',()=>{
  // The helpers are the policy: one "no extent" rule and one "too few" rule.
  expect([emptySize(0),emptySize(-1),emptySize(Number.NaN),emptySize(1,0)]).toEqual([true,true,true,true]);
  expect([emptySize(1),emptySize(1,2)]).toEqual([false,false]);
  expect(emptyCount(2,3,'segments')).toBe(true);expect(emptyCount(3,3,'segments')).toBe(false);
  expect(()=>emptyCount(2.5,3,'segments')).toThrow('integer');
  const faces=(m:{surface:{faces:readonly unknown[]}})=>m.surface.faces.length;
  for(const made of [box([0,1,1]),plane(0),sphere(0),cylinder(1,0),cone(0,1),torus(0,.2),sphere(1,{rings:1}),grid3(0,2) as never,mesh([],[])])
   expect(typeof made==='object'&&'surface'in made?faces(made as never):(made as {faces:readonly unknown[]}).faces.length).toBe(0);
  expect(grid({cols:3,rows:3,spacing:0}).points.length).toBe(0);
  for(const made of [circle(0),parametricCurve(t=>[t,0,0],{segments:0}),curve([[1,1,1]]),curve([])])expect(made.segments.length).toBe(0);
  // Constructions over an empty curve are empty meshes, not failures.
  expect(sweep(circle(0),curve([[0,0,0],[0,0,1]])).surface.faces.length).toBe(0);
  expect(revolve(curve([])).surface.faces.length).toBe(0);
 });

 it('drops the degenerate element and keeps the rest',()=>{
  // A repeated point is no segment; a polygon with no plane is no triangles;
  // a component with no vector is no extrusion. The neighbours survive.
  expect(curve([[0,0,0],[0,0,0],[1,0,0],[2,0,0]]).segments.length).toBe(2);
  const bowtie=surface3([[0,0,0],[1,1,0],[0,1,0],[1,0,0]],[[0,1,2,3]]);
  expect(bowtie.faces.length).toBe(1);expect(bowtie.triangles.length).toBe(0);
  const mixed=surface3([[0,0,0],[1,0,0],[1,1,0],[0,1,0],[2,0,0]],[[0,1,2,3],[1,4,2]]);
  expect(mixed.faces.length).toBe(2);expect(mixed.triangles.length).toBe(3);
  // A nonplanar quad becomes the triangles of its own average plane.
  expect(surface3([[0,0,0],[1,0,0],[1,1,.4],[0,1,0]],[[0,1,2,3]]).triangles.length).toBe(2);
  const sheet=plane(4).subdivide(2),left=sheet.faces.filter(f=>f.centroid[0]<-1),right=sheet.faces.filter(f=>f.centroid[0]>1);
  const one=sheet.extrude(left.union(right),r=>[0,0,r.index]);
  expect(one.surface.faces.filter(f=>f.provenance?.operation==='extrude').length).toBe(right.boundaryEdges().length);
 });

 it('answers one sample with a fallback rather than failing the whole field',()=>{
  expect(sampleValue(Number.NaN,0)).toBe(0);expect(sampleValue(Number.POSITIVE_INFINITY,0)).toBe(0);
  expect(sampleValue('two' as unknown,null)).toBeNull();expect(sampleValue(3,0)).toBe(3);
  // One point the displacement field cannot answer stays put; the rest move.
  const moved=plane(2).subdivide(1).displace(p=>p.x>0?Number.NaN:[0,0,1]);
  const heights=new Set(moved.surface.points.map(p=>p.position[2]));
  expect(heights).toEqual(new Set([0,1]));
  // One unusable level leaves the others drawing.
  const field=plane(2).subdivide(2).attributes({h:p=>p.x});
  expect(new Set(isolines(field,'h',[0,Number.NaN,.25]).edges.map(e=>e.level))).toEqual(new Set([0,.25]));
 });

 it('clamps an out-of-range setting instead of refusing it',()=>{
  expect(clampSetting(200,0,180,30,'crease')).toBe(180);
  expect(clampSetting(-5,0,180,30,'crease')).toBe(0);
  expect(clampSetting(Number.NaN,0,1,.15,'tone')).toBe(.15);
  expect(clampSetting(undefined,0,1,.15,'tone')).toBe(.15);
  expect(()=>clampSetting('x' as never,0,1,.15,'tone')).toThrow('tone');
  expect(box(1).style({creaseAngle:400}).creaseAngle).toBe(180);
 });

 it('carries an empty mesh through view, hatch, isolines, sampling, intersections and the plan',async()=>{
  const nothing=empty(),real=box(1);
  expect(nothing.surface.points.length).toBe(0);
  expect(worldBounds3([])[0]).toBe(Infinity);
  expect(isolines(nothing,()=>0,[0]).edges.length).toBe(0);
  expect(sampleSurfacePoints(nothing,{count:5},{rnd:()=>.5}).points.length).toBe(0);
  expect(intersections(nothing,real).edges.length).toBe(0);
  expect(intersections([nothing,empty()]).edges.length).toBe(0);
  expect(instanceOnPoints(nothing,pointCloud([[0,0,0],[2,0,0]]).points).length).toBe(2);
  // Alone in a view, an empty mesh plans nothing at all.
  const blank=await compileSketchAsync(sketch(config,()=>view([nothing],{camera,pen:'ink',hatch:{spacing:mm(3),pen:'shade'}})));
  expect(render(blank).raw.frags.length).toBe(0);
  // Beside a real one, the real one is drawn.
  const drawn=await compileSketchAsync(sketch(config,()=>view([nothing,real],{camera,pen:'ink',hatch:{spacing:mm(3),pen:'shade'}})));
  const result=render(drawn);
  expect(result.raw.frags.length).toBeGreaterThan(0);
  expect(exportSvg(drawn)).toContain('#112233');
  const plan=core.wasm_plan(result.raw.prims,result.raw.frags,pensToJson(result.pens),200000,.01);
  expect(decodePlanBuffer(plan).length).toBeGreaterThan(0);
 });

 it('keeps the mistakes that are mistakes',()=>{
  expect(()=>box3([Number.NaN,1,1])).toThrow('finite');
  expect(()=>sphere(1,{segments:1e9})).toThrow('budget');
  expect(()=>parametricCurve(()=>[0,0,0],{segments:100,maxPoints:10})).toThrow('budget');
  expect(()=>torus(1,1)).toThrow('centerline');
  expect(()=>mesh([[0,0,0],[1,0,0]],[[0,1,7]])).toThrow('point indices');
  expect(transformSurface3(box3(),{scale:[0,1,1]}).points.every(p=>p.position[0]===0)).toBe(true);
 });
});
